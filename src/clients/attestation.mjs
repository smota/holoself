// Per-call attestation of an unlinked MCP client: the registry entry and its lens are re-read on every tool call, so
// revocation or a lens edit takes effect on the next call without restarting the host.
import { lstatSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { loadLensRegistry, removeCustomLens } from '../lenses.mjs'
import { isCanonicalSelf } from '../link/config.mjs'
import { withRegistryLock } from '../link/registry.mjs'
import { CLIENT_ID_RE, clientError, clientsUsingLens, findClient, readClientRegistry } from './registry.mjs'

// Why a lens cannot back a client grant, or null: it must exist, must not be `private`, and must not grant `restricted`.
export function clientLensProblem(registry, lensId) {
  if (lensId === 'private') return 'the private lens is owner-exclusive'
  const lens = registry.byId.get(lensId)
  if (!lens) return `unknown lens: ${lensId}`
  if ((lens.sensitivity_access || []).includes('restricted')) return `lens ${lensId} grants restricted material`
  return null
}
export function assertClientLens(selfRoot, lensId) {
  let registry
  try {
    registry = loadLensRegistry(selfRoot)
  } catch {
    // A lens definition edited into an invalid state (for example one granting `restricted`) fails the grant closed.
    throw clientError('client lens is not allowed: the lens registry does not validate', 'CLIENT_LENS_INVALID')
  }
  const problem = clientLensProblem(registry, lensId)
  if (problem) throw clientError(`client lens is not allowed: ${problem}`, 'CLIENT_LENS_INVALID')
}
// The self root named in a client launch command: absolute, not a symlink, with the canonical layout.
export function resolveClientSelf(rootInput) {
  if (typeof rootInput !== 'string' || !rootInput)
    throw clientError('client mode requires an absolute self root (--root <absolute-self-root>)', 'CLIENT_ROOT_INVALID')
  if (!isAbsolute(rootInput))
    throw clientError('client mode requires an absolute self root (--root <absolute-self-root>)', 'CLIENT_ROOT_NOT_ABSOLUTE')
  const root = resolve(rootInput),
    info = lstatSync(root, { throwIfNoEntry: false })
  if (!info || info.isSymbolicLink() || !info.isDirectory() || !isCanonicalSelf(root))
    throw clientError('client self root is not a canonical, non-symlinked self layout', 'CLIENT_ROOT_INVALID')
  return root
}
// Re-reads clients.json and the lens registry. Throws CLIENT_UNKNOWN, CLIENT_REVOKED or CLIENT_LENS_INVALID.
export function attestClient(selfRoot, clientId) {
  if (typeof clientId !== 'string' || !CLIENT_ID_RE.test(clientId)) throw clientError('client id must be a client_id UUID from holoself client list', 'CLIENT_UNKNOWN')
  const entry = findClient(readClientRegistry(selfRoot).clients, clientId, { idOnly: true })
  if (!entry) throw clientError('client is not registered in this self root', 'CLIENT_UNKNOWN')
  if (entry.status !== 'active') throw clientError('client has been revoked by the owner', 'CLIENT_REVOKED')
  assertClientLens(selfRoot, entry.lens)
  return entry
}
// Lens removal (Workbench) under the registry lock: refused while any client entry, active or revoked, still uses it.
export async function removeLensUnlessUsed(selfRoot, lensId, expectedHash) {
  return withRegistryLock(selfRoot, () => {
    const users = clientsUsingLens(selfRoot, lensId)
    if (users.length)
      throw clientError(
        `lens is used by client ${users.map(entry => entry.name).join(', ')}; revoke and remove the client first`,
        'CLIENT_LENS_IN_USE'
      )
    return removeCustomLens(selfRoot, lensId, expectedHash)
  })
}
