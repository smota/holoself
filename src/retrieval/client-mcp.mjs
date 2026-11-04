// MCP facade for an unlinked client (`holoself mcp --client <id> --root <self>`): self-only retrieval through the
// shared context core under the client's single lens, plus the opt-in proposal inbox. Every function re-attests the
// client (registry entry and lens) before doing anything; see docs/decisions/unlinked-client-identity.md.
import { relative } from 'node:path'
import { readSelfIndex, searchIndex } from '../catalog/index.mjs'
import { attestClient } from '../clients/attestation.mjs'
import { loadLensRegistry, resolveLens } from '../lenses.mjs'
import { parseClaimBlocks } from '../markdown/claim-blocks.mjs'
import { visibleUnderBehavior } from '../policy/access.mjs'
import { createInboxProposal, inboxPreviewData, pendingInboxCount } from '../proposals/client-inbox.mjs'
import { findInboxProposal } from '../proposals/client-inbox.mjs'
import { safeTarget } from '../proposals/store.mjs'
import { slash } from '../shared/fs.mjs'
import { contextData } from './context.mjs'

function refuse(message, code) {
  return Object.assign(new Error(message), { code })
}
function assertNoCallerAuthority(options) {
  if (options.surface !== undefined) throw refuse('surface not accepted from request', 'SURFACE_NOT_ACCEPTED_FROM_REQUEST')
  if (options.identity !== undefined) throw refuse('identity not accepted from caller', 'IDENTITY_NOT_ACCEPTED_FROM_CALLER')
  for (const key of ['client', 'client_id', 'unlinkedClient', 'root', 'self', 'project'])
    if (options[key] !== undefined) throw refuse(`${key} is not accepted from request`, 'IDENTITY_NOT_ACCEPTED_FROM_CALLER')
}
// The binding is fixed by the server at launch; only these two fields cross into the core.
function binding(client) {
  return { self: client.self, client_id: client.client_id }
}

// Context through the same core as linked MCP. Only whitelisted request options are forwarded.
export function clientMcpContextData(client, options = {}) {
  assertNoCallerAuthority(options)
  const data = contextData({
    unlinkedClient: binding(client),
    task: options.task,
    need: options.need || null,
    lens: options.lens,
    budget: options.budget || 'standard',
    temporal: options.temporal || 'current',
    manifest: Boolean(options.manifest),
    sources: options.source_ids || options.sources || [],
    cursor: options.cursor || null,
    sessionStart: Boolean(options.session_start)
  })
  if (options.source_ids?.length) {
    const selected = new Set([...data.sources.map(source => source.source_id), ...(data.selection.envelope_dropped || [])]),
      missing = options.source_ids.filter(id => !selected.has(id))
    if (missing.length) throw new Error(`source handles are unavailable under this client's lens/lifecycle: ${missing.join(', ')}`)
  }
  return data
}
// Status names the identity, client name, lens and proposal mode, never the self path.
export function clientMcpStatus(client) {
  const entry = attestClient(client.self, client.client_id)
  let context = 'valid',
    contextError = null
  try {
    contextData({ unlinkedClient: binding(client), manifest: true, budget: 'small' })
  } catch {
    context = 'broken'
    contextError = 'Context validation failed closed; ask the owner to run holoself doctor locally.'
  }
  return {
    schema_version: 1,
    state: context === 'valid' ? 'ready' : 'degraded',
    identity: 'client:unlinked',
    client: { name: entry.name, lens: entry.lens, proposals: entry.proposals, status: entry.status },
    self: { available: true, access: 'read' },
    context: { state: context, ...(contextError ? { error: contextError } : {}) },
    pending_proposals: entry.proposals === 'inbox' ? pendingInboxCount(client.self, entry.client_id) : 0,
    protocol: { transport: 'stdio', authority: '.holoself/clients.json' }
  }
}
export function clientMcpSearch(client, input) {
  assertNoCallerAuthority(input)
  const entry = attestClient(client.self, client.client_id),
    lens = input.lens || entry.lens
  if (lens !== entry.lens) throw refuse(`lens is not granted to this client: ${lens}`, 'LENS_NOT_GRANTED')
  const registry = loadLensRegistry(client.self),
    resolution = resolveLens(registry, lens),
    index = readSelfIndex(client.self, registry),
    allowedLenses = new Set([lens])
  const results = searchIndex(index, input.query, lens, registry, resolution, input.temporal || 'current', {
    subject: { kind: 'client:unlinked', space_id: 'self', accessible_spaces: [], effective_allowed_lenses: allowedLenses }
  })
  return { query: input.query, lens, federated: false, results: results.slice(0, input.limit || 10) }
}

// What the client's lens delivers of one self document (any lifecycle status): null when the document is not
// delivered, so missing, hidden and out-of-lens targets are indistinguishable.
function deliveredDocument(client, target) {
  try {
    const data = clientMcpContextData(client, { temporal: 'all', budget: 'deep', sources: [target] })
    return (data.self?.documents || []).find(doc => doc.path === target && !doc.manifest_only) || null
  } catch {
    return null
  }
}
const TARGET_INVALID = 'proposal target must be an existing document readable under this client lens'
function visibleTarget(client, rawTarget) {
  let rel
  try {
    rel = slash(relative(client.self, safeTarget(client.self, rawTarget || 'context/claims.md')))
  } catch {
    throw refuse(TARGET_INVALID, 'PROPOSAL_TARGET_INVALID')
  }
  const doc = deliveredDocument(client, rel)
  if (!doc) throw refuse(TARGET_INVALID, 'PROPOSAL_TARGET_INVALID')
  return { rel, doc }
}
// Duplicate checks see only delivered claims, so an error never confirms that a hidden claim exists.
function clientClaimView(client, lens, delivered) {
  return {
    visible: (rel, block) => {
      const docs = delivered.get(rel) || []
      return !block.malformed && docs.some(content => parseClaimBlocks(content, rel).some(b => b.claim_id === block.claim_id)) && visibleUnderBehavior(block.visibility, lens, 'generic')
    },
    delivered: rel => delivered.get(rel) || [],
    baseText: rel => delivered.get(rel)?.[0] ?? null
  }
}
function assertInboxMode(entry) {
  if (entry.proposals !== 'inbox') throw refuse('proposals are disabled for this client; the owner can create a client with --proposals inbox', 'CLIENT_PROPOSALS_DISABLED')
}
export function clientMcpCreateProposal(client, input) {
  assertNoCallerAuthority(input)
  const entry = attestClient(client.self, client.client_id)
  assertInboxMode(entry)
  const { rel, doc } = visibleTarget(client, input.target)
  const view = clientClaimView(client, entry.lens, new Map([[rel, [doc.content]]]))
  const p = createInboxProposal(client.self, entry, { ...input, target: rel }, { view })
  return {
    proposal_id: p.proposal_id,
    status: p.status,
    origin: p.origin,
    provenance: p.provenance,
    created_at: p.created_at,
    changes: p.changes,
    requires_human_approval: true,
    canonical_write_performed: false
  }
}
export function clientMcpPreviewProposal(client, id) {
  const entry = attestClient(client.self, client.client_id)
  assertInboxMode(entry)
  let p
  try {
    p = findInboxProposal(client.self, id)
  } catch {
    p = null
  }
  // Another client's proposal is reported exactly like a missing one.
  if (!p || p.origin?.client_id !== entry.client_id) throw refuse(`proposal not found: ${id}`, 'PROPOSAL_NOT_FOUND')
  const delivered = new Map()
  for (const change of p.changes) {
    const { rel, doc } = visibleTarget(client, change.target)
    delivered.set(rel, [doc.content])
  }
  const preview = inboxPreviewData(client.self, p.proposal_id, { view: clientClaimView(client, entry.lens, delivered) })
  return {
    proposal_id: preview.proposal.proposal_id,
    status: preview.proposal.status,
    changes: preview.changes,
    preview_hash: preview.preview_hash,
    requires_human_approval: true,
    canonical_write_performed: false
  }
}
