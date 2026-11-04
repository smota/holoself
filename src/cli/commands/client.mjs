// holoself client add|list|revoke|remove: owner management of unlinked MCP client identities in the self root.
import { assertClientLens } from '../../clients/attestation.mjs'
import { addClient, clientError, readClientRegistry, removeClient, revokeClient } from '../../clients/registry.mjs'
import { isCanonicalSelf } from '../../link/config.mjs'
import { resolve } from 'node:path'
import { lstatSync } from 'node:fs'

export function clientSelfRoot(o) {
  const root = resolve(o.root),
    info = lstatSync(root, { throwIfNoEntry: false })
  if (!info || info.isSymbolicLink() || !info.isDirectory() || !isCanonicalSelf(root))
    throw clientError(`self path lacks canonical profile/context layout: ${root}`, 'SELF_ROOT_NOT_CANONICAL')
  return root
}
function rows(clients) {
  if (!clients.length) return 'No clients registered.'
  const header = 'CLIENT_ID                             NAME                 LENS          STATUS   PROPOSALS  CREATED_AT                REVOKED_AT'
  return [
    header,
    ...clients.map(
      entry =>
        `${entry.client_id}  ${entry.name.padEnd(20).slice(0, 20)} ${entry.lens.padEnd(13).slice(0, 13)} ${entry.status.padEnd(8)} ` +
        `${entry.proposals.padEnd(10)} ${entry.created_at.padEnd(25)} ${entry.revoked_at || '-'}`
    )
  ].join('\n')
}
export async function runClient(o, sub) {
  const self = clientSelfRoot(o)
  if (sub === 'add') {
    if (!o.name) throw clientError('client add requires --name <name>', 'INVALID_ARGUMENT')
    if (!o.lens) throw clientError('client add requires --lens <id>', 'INVALID_ARGUMENT')
    const entry = await addClient(self, { name: o.name, lens: o.lens, proposals: o.proposals || 'disabled' }, { checkLens: lens => assertClientLens(self, lens) })
    if (o.json) console.log(JSON.stringify({ client: entry }, null, 2))
    else
      console.log(
        `[ok] added client ${entry.name}\nclient_id: ${entry.client_id}\nlens: ${entry.lens}\nproposals: ${entry.proposals}\n` +
          `Next: holoself mcp configure --client ${entry.client_id} --platform claude-desktop --root ${JSON.stringify(self)}`
      )
    return true
  }
  if (sub === 'list') {
    const { clients } = readClientRegistry(self)
    console.log(o.json ? JSON.stringify({ schema_version: 1, clients }, null, 2) : rows(clients))
    return true
  }
  if (sub === 'revoke' || sub === 'remove') {
    const ref = o.args[1]
    if (!ref) throw clientError(`client ${sub} requires <client_id|name>`, 'INVALID_ARGUMENT')
    if (sub === 'revoke') {
      const { changed, ...entry } = await revokeClient(self, ref)
      console.log(o.json ? JSON.stringify({ client: entry, changed }, null, 2) : `[ok] ${changed ? 'revoked' : 'already revoked'} client ${entry.name} (${entry.client_id})`)
    } else {
      const entry = await removeClient(self, ref)
      console.log(o.json ? JSON.stringify({ removed: entry }, null, 2) : `[ok] removed client ${entry.name} (${entry.client_id})`)
    }
    return true
  }
  throw clientError('client requires add, list, revoke, or remove', 'INVALID_ARGUMENT')
}
