// holoself ledger command: list local served-context ledger entries with optional filters.
import { resolve } from 'node:path'
import { LEDGER_SCHEMA_VERSION, readLedgerEntries } from '../../ledger.mjs'
import { findLinkUpwards, isCanonicalSelf, linkPath, readLink } from '../../link/config.mjs'
import { pathExists } from '../../shared/fs.mjs'
import { findClient, readClientRegistry } from '../../clients/registry.mjs'

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
  const header = 'SERVED_AT                 SURFACE    MODE      HOST         LENS         ITEMS  BYTES   TASK_HMAC         RECEIPT'
  const lines = entries.map(entry => {
    const at = String(entry.served_at || '').padEnd(25, ' ').slice(0, 25)
    const surface = String(entry.surface || '-').padEnd(10, ' ').slice(0, 10)
    const mode = String(entry.mode || 'packet').padEnd(8, ' ').slice(0, 8)
    const host = String(entry.host || '-').padEnd(12, ' ').slice(0, 12)
    const lens = String(entry.lens || '-').padEnd(12, ' ').slice(0, 12)
    const items = String(entry.mode === 'manifest' ? (entry.counts?.items_listed ?? 0) : (entry.counts?.documents_delivered ?? 0)).padStart(5, ' ')
    const bytes = String(entry.total_bytes ?? 0).padStart(6, ' ')
    const taskHmac = String(entry.task_hmac ? entry.task_hmac.slice(0, 12) : '(none)').padEnd(16, ' ').slice(0, 16)
    const receipt = String(entry.context_hash ? entry.context_hash.slice(0, 12) : '-')
    return `${at} ${surface} ${mode}  ${host} ${lens} ${items}  ${bytes}  ${taskHmac}  ${receipt}`
  })
  return [header, ...lines].join('\n')
}

// `--client <id|name>` filters entries served to one unlinked MCP client; its entries live in the self-root ledger.
function resolveLedgerClient(o, scope, baseDir) {
  if (!o.client) return null
  if (scope !== 'owner-direct') {
    const err = new Error('ledger --client reads the self-root ledger; pass --root <self-root>')
    err.code = 'INVALID_LEDGER_FILTER'
    throw err
  }
  const entry = findClient(readClientRegistry(baseDir).clients, o.client)
  if (entry) return entry.client_id
  // A removed client's entries stay attributable by id.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(o.client)) return o.client
  const err = new Error(`unknown client: ${o.client}`)
  err.code = 'INVALID_LEDGER_FILTER'
  throw err
}

export async function runLedger(o) {
  const { baseDir, scope } = resolveLedgerScope(o)
  const entries = readLedgerEntries(baseDir, {
    since: o.since,
    lens: o.lens,
    surface: o.surface,
    clientId: resolveLedgerClient(o, scope, baseDir),
    limit: o.limit
  })
  if (o.json) {
    console.log(
      JSON.stringify(
        {
          schema_version: LEDGER_SCHEMA_VERSION,
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
