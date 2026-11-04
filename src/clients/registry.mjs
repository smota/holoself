// Self-side registry of unlinked MCP client identities (`<self>/.holoself/clients.json`). Each entry grants one
// desktop MCP host exactly one owner-chosen lens. Writes run under the links registry lock, so link, lens and client
// changes are serialised; see docs/decisions/unlinked-client-identity.md.
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { canonicalSort } from '../catalog.mjs'
import { lensIdStructurallyValid } from '../lenses.mjs'
import { ensureHoloselfGitignore } from '../link/config.mjs'
import { withRegistryLock } from '../link/registry.mjs'
import { atomicWrite, ensureDir, hash } from '../shared/fs.mjs'

export const CLIENT_REGISTRY_SCHEMA_VERSION = 1
export const CLIENT_STATUSES = ['active', 'revoked']
export const CLIENT_PROPOSAL_MODES = ['disabled', 'inbox']
export const CLIENT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
export const CLIENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const ENTRY_KEYS = ['client_id', 'name', 'lens', 'status', 'proposals', 'created_at', 'revoked_at']
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/

export function clientError(message, code) {
  return Object.assign(new Error(message), { code })
}
export function clientsFilePath(selfRoot) {
  return join(resolve(selfRoot), '.holoself', 'clients.json')
}
function schemaError(detail) {
  return clientError(`invalid client registry (.holoself/clients.json): ${detail}`, 'CLIENT_REGISTRY_SCHEMA_INVALID')
}
// Every entry must carry exactly the documented fields; anything else fails closed.
export function validateClientEntry(entry, index = 0) {
  const at = `clients[${index}]`
  if (!entry || Array.isArray(entry) || typeof entry !== 'object') throw schemaError(`${at} must be an object`)
  for (const key of Object.keys(entry)) if (!ENTRY_KEYS.includes(key)) throw schemaError(`${at} has unknown field ${key}`)
  for (const key of ENTRY_KEYS) if (!Object.hasOwn(entry, key)) throw schemaError(`${at} is missing ${key}`)
  if (typeof entry.client_id !== 'string' || !CLIENT_ID_RE.test(entry.client_id)) throw schemaError(`${at}.client_id must be a lowercase UUID v4`)
  if (typeof entry.name !== 'string' || !CLIENT_NAME_RE.test(entry.name)) throw schemaError(`${at}.name must be lowercase letters, digits and hyphens (at most 64)`)
  if (!lensIdStructurallyValid(entry.lens)) throw schemaError(`${at}.lens must be a lens id`)
  if (!CLIENT_STATUSES.includes(entry.status)) throw schemaError(`${at}.status must be active or revoked`)
  if (!CLIENT_PROPOSAL_MODES.includes(entry.proposals)) throw schemaError(`${at}.proposals must be disabled or inbox`)
  if (typeof entry.created_at !== 'string' || !ISO_UTC_RE.test(entry.created_at)) throw schemaError(`${at}.created_at must be an ISO 8601 UTC timestamp`)
  if (entry.status === 'active' && entry.revoked_at !== null) throw schemaError(`${at}.revoked_at must be null for an active client`)
  if (entry.status === 'revoked' && (typeof entry.revoked_at !== 'string' || !ISO_UTC_RE.test(entry.revoked_at)))
    throw schemaError(`${at}.revoked_at must be an ISO 8601 UTC timestamp for a revoked client`)
  return entry
}
export function validateClientRegistry(parsed) {
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw schemaError('root must be an object')
  for (const key of Object.keys(parsed)) if (!['schema_version', 'clients'].includes(key)) throw schemaError(`unknown field ${key}`)
  if (parsed.schema_version !== CLIENT_REGISTRY_SCHEMA_VERSION) throw schemaError(`schema_version must be ${CLIENT_REGISTRY_SCHEMA_VERSION}`)
  if (!Array.isArray(parsed.clients)) throw schemaError('clients must be an array')
  const ids = new Set(),
    names = new Set()
  parsed.clients.forEach((entry, index) => {
    validateClientEntry(entry, index)
    if (ids.has(entry.client_id)) throw schemaError(`duplicate client_id ${entry.client_id}`)
    if (names.has(entry.name)) throw schemaError(`duplicate name ${entry.name}`)
    ids.add(entry.client_id)
    names.add(entry.name)
  })
  return parsed.clients
}
// A missing file reads as an empty registry (same rule as links.json). A symlink or non-file fails closed.
export function readClientRegistry(selfRoot) {
  const path = clientsFilePath(selfRoot),
    info = lstatSync(path, { throwIfNoEntry: false })
  if (!info) return { raw: null, baseHash: '__ABSENT__', clients: [] }
  if (info.isSymbolicLink() || !info.isFile()) throw schemaError('not a regular file')
  const raw = readFileSync(path, 'utf8')
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw schemaError('malformed JSON')
  }
  return { raw, baseHash: hash(raw), clients: validateClientRegistry(parsed) }
}
export function writeClientRegistry(selfRoot, clients, baseHash) {
  const path = clientsFilePath(selfRoot),
    info = lstatSync(path, { throwIfNoEntry: false })
  if (info && (info.isSymbolicLink() || !info.isFile())) throw schemaError('not a regular file')
  const current = info ? hash(readFileSync(path, 'utf8')) : '__ABSENT__'
  if (baseHash !== undefined && current !== baseHash)
    throw clientError('client registry changed on disk while it was being updated', 'CLIENT_REGISTRY_CONCURRENT_MODIFICATION')
  const sorted = [...clients].sort((a, b) => canonicalSort(a.created_at, b.created_at) || canonicalSort(a.client_id, b.client_id)),
    payload = { schema_version: CLIENT_REGISTRY_SCHEMA_VERSION, clients: sorted }
  validateClientRegistry(payload)
  ensureDir(join(resolve(selfRoot), '.holoself'))
  ensureHoloselfGitignore(resolve(selfRoot))
  const text = JSON.stringify(payload, null, 2) + '\n'
  atomicWrite(path, text, { mode: 0o600, exactMode: true })
  return hash(text)
}
// Resolves an owner-supplied reference: an exact client_id or a name. Runtime binding (`mcp --client`) uses ids only.
export function findClient(clients, ref, { idOnly = false } = {}) {
  if (typeof ref !== 'string' || !ref) return null
  return clients.find(entry => entry.client_id === ref) || (idOnly ? null : clients.find(entry => entry.name === ref)) || null
}
// Client entries (any status) that still reference a lens; `lens remove` refuses while any exist.
export function clientsUsingLens(selfRoot, lensId) {
  return readClientRegistry(selfRoot).clients.filter(entry => entry.lens === lensId)
}

// The owner-facing operations. Each takes the registry lock, re-reads, validates and writes with a base-hash check.
export async function addClient(selfRoot, { name, lens, proposals = 'disabled' }, { checkLens } = {}) {
  if (typeof name !== 'string' || !CLIENT_NAME_RE.test(name))
    throw clientError('client name must be lowercase letters, digits and hyphens, at most 64 characters', 'INVALID_ARGUMENT')
  if (!CLIENT_PROPOSAL_MODES.includes(proposals)) throw clientError('--proposals must be disabled or inbox', 'INVALID_ARGUMENT')
  return withRegistryLock(selfRoot, () => {
    if (typeof checkLens === 'function') checkLens(lens)
    const current = readClientRegistry(selfRoot)
    if (current.clients.some(entry => entry.name === name)) throw clientError(`client name already exists: ${name}`, 'CLIENT_NAME_TAKEN')
    let clientId = randomUUID()
    while (current.clients.some(entry => entry.client_id === clientId)) clientId = randomUUID()
    const entry = { client_id: clientId, name, lens, status: 'active', proposals, created_at: new Date().toISOString(), revoked_at: null }
    writeClientRegistry(selfRoot, [...current.clients, entry], current.baseHash)
    return entry
  })
}
export async function revokeClient(selfRoot, ref) {
  return withRegistryLock(selfRoot, () => {
    const current = readClientRegistry(selfRoot),
      entry = findClient(current.clients, ref)
    if (!entry) throw clientError(`unknown client: ${ref}`, 'CLIENT_UNKNOWN')
    if (entry.status === 'revoked') return { ...entry, changed: false }
    const next = { ...entry, status: 'revoked', revoked_at: new Date().toISOString() }
    writeClientRegistry(
      selfRoot,
      current.clients.map(item => (item.client_id === entry.client_id ? next : item)),
      current.baseHash
    )
    return { ...next, changed: true }
  })
}
export async function removeClient(selfRoot, ref) {
  return withRegistryLock(selfRoot, () => {
    const current = readClientRegistry(selfRoot),
      entry = findClient(current.clients, ref)
    if (!entry) throw clientError(`unknown client: ${ref}`, 'CLIENT_UNKNOWN')
    if (entry.status === 'active') throw clientError(`client ${entry.name} is active; run holoself client revoke first`, 'CLIENT_ACTIVE')
    writeClientRegistry(
      selfRoot,
      current.clients.filter(item => item.client_id !== entry.client_id),
      current.baseHash
    )
    return entry
  })
}
export function clientRegistryExists(selfRoot) {
  return existsSync(clientsFilePath(selfRoot))
}
