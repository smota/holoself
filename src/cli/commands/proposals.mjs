// holoself proposals command (moved verbatim from runEcosystem).
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { ecosystemValidationErrors } from '../../catalog/validation.mjs'
import { applyInboxBatch } from '../../proposals/inbox.mjs'
import {
  findProposal,
  listProposalData,
  proposalChanges,
  proposalPreviewData,
  proposalText,
  scanProposalStore,
  stateProposal
} from '../../proposals/store.mjs'
import { hash } from '../../shared/fs.mjs'
import { askConfirm, projectPath } from '../link-helpers.mjs'

// One readable line per change for `proposals show`, emitted as YAML comments above the record.
function changeSummary(change) {
  const one = text => String(text).replace(/\s+/g, ' ').trim()
  if (change.operation === 'replace_claim') return `replace claim ${change.claim_id} in ${change.target} with "${one(change.claim)}"`
  if (change.operation === 'supersede_claim') return `supersede claim ${change.claim_id} in ${change.target} with new claim "${one(change.claim)}"`
  if (change.operation === 'retire_claim') return `retire claim ${change.claim_id} in ${change.target} as historical: ${one(change.reason)}`
  return `append claim to ${change.target}: "${one(change.claim)}"`
}
function formatPreviewText(prepared) {
  const { grouped, changes: previews, preview_hash: previewHash } = prepared
  return (
    `Affected files: ${[...grouped.keys()].join(', ')}\nPreview hash: ${previewHash}\n--- proposed diff ---\n` +
    `${previews
      .map(x =>
        x.operation === 'append_claim'
          ? `--- ${x.change_id}: ${x.target} ---\n+${x.preview.replaceAll('\n', '\n+')}`
          : `--- ${x.change_id}: ${x.operation} ${x.claim_id} in ${x.target} ---\n` +
            (x.visibility_change ? `! visibility: ${x.visibility_change.from} → ${x.visibility_change.to}\n` : '') +
            x.preview
      )
      .join('\n')}`
  )
}
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
  const ids = o.args.slice(1)
  if (!ids.length) throw new Error(`proposals ${action} requires <id>`)
  if (action === 'show') {
    if (ids.length > 1) throw new Error('proposals show accepts a single <id>')
    const p = findProposal(project, ids[0]),
      changes = proposalChanges(p),
      summary = changes.some(x => (x.operation || 'append_claim') !== 'append_claim')
        ? changes.map(x => `# ${x.change_id}: ${changeSummary(x)}`).join('\n') + '\n'
        : ''
    console.log(summary + proposalText(Object.fromEntries(Object.entries(p).filter(([k]) => k !== '_path'))))
    return true
  }
  if (!['approve', 'reject', 'defer', 'supersede'].includes(action))
    throw new Error('proposals requires list, audit, show, approve, reject, defer, or supersede')
  const proposals = ids.map(id => findProposal(project, id))
  for (const p of proposals) if (p.status !== 'pending') throw new Error(`proposal is ${p.status}, expected pending`)
  if (action === 'approve') {
    const preparedList = proposals.map(p => proposalPreviewData(project, p.proposal_id)),
      { link } = preparedList[0]
    for (const prepared of preparedList) {
      const archive = join(link.path, 'proposals', 'approved', `${prepared.proposal.proposal_id}.yaml`)
      if (existsSync(archive)) throw new Error(`proposal archive collision: ${archive}`)
    }
    const preErrors = ecosystemValidationErrors(link.path, project)
    if (preErrors.length) throw new Error(`pre-approval validation failed: ${preErrors.join('; ')}`)
    if (preparedList.length === 1) {
      const prepared = preparedList[0]
      console.log(
        o.json
          ? JSON.stringify({ proposal_id: prepared.proposal.proposal_id, changes: prepared.changes, preview_hash: prepared.preview_hash }, null, 2)
          : formatPreviewText(prepared)
      )
      if (o.digest && o.digest !== prepared.preview_hash) {
        const error = new Error('proposal preview is stale')
        error.code = 'STALE_PREVIEW'
        throw error
      }
    } else {
      const batchHash = hash(preparedList.map(x => x.preview_hash).join('\n'))
      console.log(
        o.json
          ? JSON.stringify(
              {
                proposals: preparedList.map(x => ({
                  proposal_id: x.proposal.proposal_id,
                  changes: x.changes,
                  preview_hash: x.preview_hash
                })),
                preview_hash: batchHash
              },
              null,
              2
            )
          : preparedList.map(formatPreviewText).join('\n\n')
      )
      if (o.digest) {
        const parts = o.digest.split(',').map(x => x.trim()).filter(Boolean)
        if (o.digest !== batchHash && (parts.length !== preparedList.length || parts.some((h, idx) => h !== preparedList[idx].preview_hash))) {
          const error = new Error('proposal preview is stale')
          error.code = 'STALE_PREVIEW'
          throw error
        }
      }
    }
    if (!(await askConfirm(o, 'Approve proposal and apply grouped canonical self changes?'))) {
      console.log('Cancelled.')
      return true
    }
    await applyInboxBatch(link.path, {
      action: 'approve',
      items: preparedList.map(x => ({
        id: x.proposal.proposal_id,
        space: project,
        preview_hash: x.preview_hash
      })),
      spaces: [{ id: 'cli', name: basename(project), path: project }]
    })
    for (const p of proposals) {
      console.log(`[ok] approved ${p.proposal_id}; ${proposalChanges(p).length} change(s), validation passed`)
    }
    return true
  }
  if (action === 'supersede') {
    if (proposals.length > 1) throw new Error('proposals supersede accepts a single <id>')
    const p = proposals[0]
    if (!(await askConfirm(o, `Supersede proposal ${p.proposal_id}?`))) {
      console.log('Cancelled.')
      return true
    }
    stateProposal(project, p, 'superseded')
    console.log(`[ok] superseded ${p.proposal_id}`)
    return true
  }
  const label = proposals.map(p => p.proposal_id).join(', ')
  if (!(await askConfirm(o, `${action === 'reject' ? 'Reject' : 'Defer'} proposal ${label}?`))) {
    console.log('Cancelled.')
    return true
  }
  const state = action === 'reject' ? 'rejected' : 'deferred'
  await applyInboxBatch( null, {
    action,
    items: proposals.map(p => ({ id: p.proposal_id, space: project })),
    spaces: [{ id: 'cli', name: basename(project), path: project }]
  })
  for (const p of proposals) console.log(`[ok] ${state} ${p.proposal_id}`)
  return true
}
