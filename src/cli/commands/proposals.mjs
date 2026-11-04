// holoself proposals command (moved verbatim from runEcosystem).
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ecosystemValidationErrors } from '../../catalog/validation.mjs'
import {
  findProposal,
  listProposalData,
  proposalChanges,
  proposalPreviewData,
  proposalText,
  safeTarget,
  scanProposalStore,
  stateProposal
} from '../../proposals/store.mjs'
import { atomicWrite, hash } from '../../shared/fs.mjs'
import { askConfirm, projectPath } from '../link-helpers.mjs'

export async function runProposals(o, sub) {
  const project = projectPath(o),
    action = sub
  if (action === 'list') {
    console.log(
      JSON.stringify(
        listProposalData(project).map(({ _path, ...p }) => p),
        null,
        2
      )
    )
    return true
  }
  if (action === 'audit') {
    const scan = scanProposalStore(project)
    console.log(JSON.stringify({ managed: scan.managed.map(({ _path, ...p }) => p), diagnostics: scan.diagnostics }, null, 2))
    if (scan.diagnostics.some(x => x.severity === 'error')) process.exitCode = 1
    return true
  }
  const id = o.args[1]
  if (!id) throw new Error(`proposals ${action} requires <id>`)
  const p = findProposal(project, id)
  if (action === 'show') {
    console.log(proposalText(Object.fromEntries(Object.entries(p).filter(([k]) => k !== '_path'))))
    return true
  }
  if (!['approve', 'reject', 'defer', 'supersede'].includes(action))
    throw new Error('proposals requires list, audit, show, approve, reject, defer, or supersede')
  if (p.status !== 'pending') throw new Error(`proposal is ${p.status}, expected pending`)
  if (action === 'approve') {
    const prepared = proposalPreviewData(project, p.proposal_id),
      { link, grouped } = prepared,
      changes = proposalChanges(p),
      archive = join(link.path, 'proposals', 'approved', `${p.proposal_id}.yaml`)
    if (existsSync(archive)) throw new Error(`proposal archive collision: ${archive}`)
    const preErrors = ecosystemValidationErrors(link.path, project)
    if (preErrors.length) throw new Error(`pre-approval validation failed: ${preErrors.join('; ')}`)
    const previews = prepared.changes,
      previewHash = prepared.preview_hash
    console.log(
      o.json
        ? JSON.stringify({ proposal_id: p.proposal_id, changes: previews, preview_hash: previewHash }, null, 2)
        : `Affected files: ${[...grouped.keys()].join(', ')}\nPreview hash: ${previewHash}\n--- proposed diff ---\n` +
            `${previews.map(x => `--- ${x.change_id}: ${x.target} ---\n+${x.preview.replaceAll('\n', '\n+')}`).join('\n')}`
    )
    if (o.digest && o.digest !== previewHash) {
      const error = new Error('proposal preview is stale')
      error.code = 'STALE_PREVIEW'
      throw error
    }
    if (!(await askConfirm(o, 'Approve proposal and apply grouped canonical self changes?'))) {
      console.log('Cancelled.')
      return true
    }
    const proposalBefore = readFileSync(p._path),
      receipt = join(link.path, 'proposals', 'receipts', `${p.proposal_id}-approved.json`),
      commitTime = new Date().toISOString(),
      appliedChanges = previews.map(item => ({
        ...item,
        after_sha256: hash(grouped.get(safeTarget(link.path, item.target)).after.replaceAll('<commit-time>', commitTime))
      }))
    try {
      for (const item of grouped.values()) atomicWrite(item.target, item.after.replaceAll('<commit-time>', commitTime))
      stateProposal(project, p, 'approved', {
        preview_sha256: previewHash,
        applied_changes: appliedChanges.map(({ change_id, target, before_sha256, after_sha256 }) => ({ change_id, target, before_sha256, after_sha256 }))
      })
      const errors = ecosystemValidationErrors(link.path, project)
      if (errors.length) throw new Error(`post-approval validation failed: ${errors.join('; ')}`)
    } catch (error) {
      for (const item of grouped.values()) {
        if (item.existed) atomicWrite(item.target, item.before)
        else if (existsSync(item.target)) rmSync(item.target)
      }
      atomicWrite(p._path, proposalBefore)
      if (existsSync(archive)) rmSync(archive, { force: true })
      if (existsSync(receipt)) rmSync(receipt, { force: true })
      throw error
    }
    console.log(`[ok] approved ${p.proposal_id}; ${changes.length} change(s), validation passed`)
    return true
  }
  if (!(await askConfirm(o, `${action === 'reject' ? 'Reject' : action === 'supersede' ? 'Supersede' : 'Defer'} proposal ${p.proposal_id}?`))) {
    console.log('Cancelled.')
    return true
  }
  const state = action === 'reject' ? 'rejected' : action === 'supersede' ? 'superseded' : 'deferred'
  stateProposal(project, p, state)
  console.log(`[ok] ${state} ${p.proposal_id}`)
  return true
}
