// holoself proposals command (moved verbatim from runEcosystem).
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ecosystemValidationErrors } from '../../catalog/validation.mjs'
import { findClient, readClientRegistry } from '../../clients/registry.mjs'
import { findInboxProposal, inboxPreviewData, listInboxProposals, scanInbox } from '../../proposals/client-inbox.mjs'
import {
  findProposal,
  listProposalData,
  proposalChanges,
  proposalPreviewData,
  proposalText,
  scanProposalStore,
  stateProposal,
  stateProposalInSelf
} from '../../proposals/store.mjs'
import { withRegistryLock } from '../../link/registry.mjs'
import { atomicWrite, hash } from '../../shared/fs.mjs'
import { askConfirm, projectPath } from '../link-helpers.mjs'
import { clientSelfRoot } from './client.mjs'

// One readable line per change for `proposals show`, emitted as YAML comments above the record.
function changeSummary(change) {
  const one = text => String(text).replace(/\s+/g, ' ').trim()
  if (change.operation === 'replace_claim') return `replace claim ${change.claim_id} in ${change.target} with "${one(change.claim)}"`
  if (change.operation === 'supersede_claim') return `supersede claim ${change.claim_id} in ${change.target} with new claim "${one(change.claim)}"`
  if (change.operation === 'retire_claim') return `retire claim ${change.claim_id} in ${change.target} as historical: ${one(change.reason)}`
  return `append claim to ${change.target}: "${one(change.claim)}"`
}
// The queue under review: a linked project's proposals (default) or, with --inbox, the self-root client inbox. Both
// use the same preview hash, transactional apply, archive states and receipts.
function proposalQueue(o) {
  if (o.inbox) {
    if (o.project || o.target) throw new Error('--inbox reviews the self-root client inbox; it cannot be combined with --project')
    const self = clientSelfRoot(o)
    const clients = () => {
      try {
        return readClientRegistry(self).clients
      } catch {
        return []
      }
    }
    return {
      self,
      project: null,
      list: () => listInboxProposals(self),
      scan: () => scanInbox(self),
      find: id => findInboxProposal(self, id),
      preview: id => inboxPreviewData(self, id),
      state: (p, state, details) => stateProposalInSelf(self, p, state, details),
      // Review shows the client's name and current status; a removed client is reported as removed.
      describe: p => {
        const entry = findClient(clients(), p.origin?.client_id, { idOnly: true })
        return { client: entry ? { name: entry.name, status: entry.status, lens: entry.lens } : { name: null, status: 'removed' } }
      }
    }
  }
  const project = projectPath(o)
  return {
    self: null,
    project,
    list: () => listProposalData(project),
    scan: () => scanProposalStore(project),
    find: id => findProposal(project, id),
    preview: id => proposalPreviewData(project, id),
    state: (p, state, details) => stateProposal(project, p, state, details),
    describe: () => ({})
  }
}
export async function runProposals(o, sub) {
  const queue = proposalQueue(o),
    project = queue.project,
    action = sub
  if (action === 'list') {
    console.log(
      JSON.stringify(
        queue.list().map(({ _path, ...p }) => ({ ...p, ...queue.describe(p) })),
        null,
        2
      )
    )
    return true
  }
  if (action === 'audit') {
    const scan = queue.scan()
    console.log(JSON.stringify({ managed: scan.managed.map(({ _path, ...p }) => p), diagnostics: scan.diagnostics }, null, 2))
    if (scan.diagnostics.some(x => x.severity === 'error')) process.exitCode = 1
    return true
  }
  const id = o.args[1]
  if (!id) throw new Error(`proposals ${action} requires <id>`)
  const p = queue.find(id)
  if (action === 'show') {
    const changes = proposalChanges(p),
      summary = changes.some(x => (x.operation || 'append_claim') !== 'append_claim')
        ? changes.map(x => `# ${x.change_id}: ${changeSummary(x)}`).join('\n') + '\n'
        : '',
      described = queue.describe(p).client,
      origin = described ? `# client: ${described.name || p.origin.client_id} (${described.status})\n` : ''
    console.log(origin + summary + proposalText(Object.fromEntries(Object.entries(p).filter(([k]) => k !== '_path'))))
    return true
  }
  if (!['approve', 'reject', 'defer', 'supersede'].includes(action))
    throw new Error('proposals requires list, audit, show, approve, reject, defer, or supersede')
  if (p.status !== 'pending') throw new Error(`proposal is ${p.status}, expected pending`)
  if (action === 'approve') {
    const prepared = queue.preview(p.proposal_id),
      { grouped } = prepared,
      link = { path: queue.self || prepared.link.path },
      changes = proposalChanges(p),
      archive = join(link.path, 'proposals', 'approved', `${p.proposal_id}.yaml`)
    if (existsSync(archive)) throw new Error(`proposal archive collision: ${archive}`)
    const preErrors = ecosystemValidationErrors(link.path, project)
    if (preErrors.length) throw new Error(`pre-approval validation failed: ${preErrors.join('; ')}`)
    const previews = prepared.changes,
      previewHash = prepared.preview_hash
    console.log(
      o.json
        ? JSON.stringify({ proposal_id: p.proposal_id, ...queue.describe(p), changes: previews, preview_hash: previewHash }, null, 2)
        : `Affected files: ${[...grouped.keys()].join(', ')}\nPreview hash: ${previewHash}\n--- proposed diff ---\n` +
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
      token = prepared.commit_time_token,
      stamp = text => text.replaceAll(token, commitTime),
      appliedChanges = previews.map((item, i) => ({
        ...item,
        before_sha256: hash(stamp(prepared.steps[i].before)),
        after_sha256: hash(stamp(prepared.steps[i].after))
      }))
    // The stale check, writes, archive and validation run under the self root's registry lock, so two approvals
    // (or an approval and a Workbench registry change) cannot interleave between the check and the write.
    await withRegistryLock(link.path, async () => {
      // A target edited after the preview was computed (for example while confirmation was pending) is stale.
      for (const item of grouped.values()) {
        const current = existsSync(item.target) ? readFileSync(item.target, 'utf8') : null
        if (item.existed ? current !== item.before : current !== null) {
          const error = new Error(`proposal preview is stale: ${item.target} changed after preview`)
          error.code = 'STALE_PREVIEW'
          throw error
        }
      }
      try {
        for (const item of grouped.values()) atomicWrite(item.target, stamp(item.after))
        queue.state(p, 'approved', {
          preview_sha256: previewHash,
          applied_changes: appliedChanges.map(({ change_id, operation, target, claim_id, before_sha256, after_sha256 }) => ({
            change_id,
            operation,
            target,
            claim_id,
            before_sha256,
            after_sha256
          }))
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
    })
    console.log(`[ok] approved ${p.proposal_id}; ${changes.length} change(s), validation passed`)
    return true
  }
  if (!(await askConfirm(o, `${action === 'reject' ? 'Reject' : action === 'supersede' ? 'Supersede' : 'Defer'} proposal ${p.proposal_id}?`))) {
    console.log('Cancelled.')
    return true
  }
  const state = action === 'reject' ? 'rejected' : action === 'supersede' ? 'superseded' : 'deferred'
  queue.state(p, state)
  console.log(`[ok] ${state} ${p.proposal_id}`)
  return true
}
