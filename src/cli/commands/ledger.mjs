// holoself ledger command: list local served-context ledger entries with optional filters.
import { resolve } from 'node:path'
import { readLedgerEntries } from '../../ledger.mjs'
import { findLinkUpwards, isCanonicalSelf, linkPath, readLink } from '../../link/config.mjs'
import { pathExists } from '../../shared/fs.mjs'

function resolveLedgerScope(o) {
  if (o.project || o.target) {
    const project = resolve(o.project || o.target)
    if (!pathExists(linkPath(project))) {
      const err = new Error(`project is not linked to any Holoself canonical root: ${project}`)
      err.code = 'LINK_REQUIRED'
      throw err
    }
    readLink(project, { tolerant: true })
    return { baseDir: project, scope: 'linked-project' }
  }
  if (o.self || o.rootExplicit) {
    const selfRoot = resolve(o.self || o.root)
    if (!isCanonicalSelf(selfRoot)) {
      const err = new Error(`self path lacks canonical profile/context layout: ${selfRoot}`)
      err.code = 'SELF_ROOT_NOT_CANONICAL'
      throw err
    }
    return { baseDir: selfRoot, scope: 'owner-direct' }
  }
  const found = findLinkUpwards(process.cwd())
  if (found) {
    return { baseDir: found.projectDir, scope: 'linked-project' }
  }
  const root = resolve(o.root)
  if (isCanonicalSelf(root)) {
    return { baseDir: root, scope: 'owner-direct' }
  }
  const err = new Error('no linked project or canonical self root found; pass --project <dir> or --root <self-root>')
  err.code = 'LINK_REQUIRED'
  throw err
}

function formatLedgerRows(entries) {
  if (!entries.length) return 'No served context entries recorded.'
  const header = 'SERVED_AT                 SURFACE    HOST         LENS         DOCS  BYTES   TASK_SHA256       RECEIPT'
  const lines = entries.map(entry => {
    const at = String(entry.served_at || '').padEnd(25, ' ').slice(0, 25)
    const surface = String(entry.surface || '-').padEnd(10, ' ').slice(0, 10)
    const host = String(entry.host || '-').padEnd(12, ' ').slice(0, 12)
    const lens = String(entry.lens || '-').padEnd(12, ' ').slice(0, 12)
    const docs = String(entry.counts?.documents_delivered ?? 0).padStart(4, ' ')
    const bytes = String(entry.total_bytes ?? 0).padStart(6, ' ')
    const taskHash = String(entry.task_sha256 ? entry.task_sha256.slice(0, 12) : '(none)').padEnd(16, ' ').slice(0, 16)
    const receipt = String(entry.context_hash ? entry.context_hash.slice(0, 12) : '-')
    return `${at} ${surface} ${host} ${lens} ${docs}  ${bytes}  ${taskHash}  ${receipt}`
  })
  return [header, ...lines].join('\n')
}

export async function runLedger(o) {
  const { baseDir, scope } = resolveLedgerScope(o)
  const entries = readLedgerEntries(baseDir, {
    since: o.since,
    lens: o.lens,
    surface: o.surface,
    limit: o.limit
  })
  if (o.json) {
    console.log(
      JSON.stringify(
        {
          schema_version: 1,
          scope,
          count: entries.length,
          entries
        },
        null,
        2
      )
    )
  } else {
    console.log(formatLedgerRows(entries))
  }
  return true
}
