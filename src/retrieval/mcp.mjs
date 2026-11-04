// MCP-facing facade over context, search, status and proposals for a fixed linked project.
import { existsSync } from 'node:fs'
import { basename, relative, resolve } from 'node:path'
import { readIndex, searchIndex } from '../catalog/index.mjs'
import { loadLensRegistry, resolveLens } from '../lenses.mjs'
import { linkedLensAuthority } from '../link/attestation.mjs'
import { readLink } from '../link/config.mjs'
import { healthStatus } from '../link/health.mjs'
import { parseClaimBlocks } from '../markdown/claim-blocks.mjs'
import { visibleUnderBehavior } from '../policy/access.mjs'
import { createProposal, findProposal, listProposalData, proposalChanges, proposalPreviewData, safeTarget } from '../proposals/store.mjs'
import { slash } from '../shared/fs.mjs'
import { contextData } from './context.mjs'

export function mcpContextData(project, options = {}) {
  if (options.surface !== undefined) {
    const err = new Error('surface not accepted from request')
    err.code = 'SURFACE_NOT_ACCEPTED_FROM_REQUEST'
    throw err
  }
  if (options.identity !== undefined) {
    const err = new Error('identity not accepted from caller')
    err.code = 'IDENTITY_NOT_ACCEPTED_FROM_CALLER'
    throw err
  }
  const link = readLink(project),
    requestedLens = options.lens || link.default_lens,
    allowedLenses = new Set([link.default_lens, ...(link.secondary_lenses || [])])
  if (!allowedLenses.has(requestedLens)) {
    const error = new Error(`unknown lens or lens is not granted by this project link: ${requestedLens}`)
    error.code = 'LENS_NOT_GRANTED'
    throw error
  }
  const data = contextData({
    ...options,
    project,
    surface: 'mcp',
    task: options.task,
    need: options.need || null,
    lens: requestedLens,
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
    if (missing.length) throw new Error(`source handles are unavailable under the requested link/lens/lifecycle: ${missing.join(', ')}`)
  }
  return data
}
export function holoselfMcpStatus(projectInput) {
  const project = resolve(projectInput),
    link = readLink(project, { tolerant: true }),
    health = healthStatus(project, link, {})
  let context = 'valid',
    contextError = null
  try {
    contextData({ project, manifest: true, budget: 'small', surface: 'internal-health' })
  } catch {
    context = 'broken'
    contextError = 'Context validation failed closed; run holoself link doctor locally.'
  }
  return {
    schema_version: 1,
    state: health.state,
    project: { name: basename(project), linked: true },
    self: { available: existsSync(link.path), access: link.access },
    link: { default_lens: link.default_lens, secondary_lenses: link.secondary_lenses, proposals: link.proposals, index: link.index },
    context: { state: context, ...(contextError ? { error: contextError } : {}) },
    pending_proposals: listProposalData(project).filter(p => p.status === 'pending').length,
    protocol: { transport: 'stdio', authority: '.holoself/link.yaml' }
  }
}
export function holoselfMcpContext(project, options = {}) {
  return mcpContextData(resolve(project), options)
}
export function holoselfMcpSearch(project, input) {
  const linked = resolve(project),
    link = readLink(linked),
    registry = loadLensRegistry(link.path),
    lens = input.lens || link.default_lens,
    allowedLenses = new Set([link.default_lens, ...(link.secondary_lenses || [])])
  linkedLensAuthority(linked, link, lens)
  const resolution = resolveLens(registry, lens),
    index = readIndex(linked)
  const results = searchIndex(index, input.query, lens, registry, resolution, input.temporal || 'current', {
    effective_allowed_lenses: allowedLenses
  })
  return { query: input.query, lens, federated: false, results: results.slice(0, input.limit || 10) }
}
// What this link's own lenses deliver of a self document at any lifecycle status: the delivered texts, and the claim
// ids in them. Hidden claims never reach delivery, so their ids and wording are never part of this view.
function mcpDeliveredClaims(project, target) {
  const link = readLink(project),
    lenses = [...new Set([link.default_lens, ...(link.secondary_lenses || [])])],
    ids = new Set(),
    contents = []
  for (const lens of lenses) {
    let data
    try {
      data = mcpContextData(project, { lens, temporal: 'all', budget: 'deep', sources: [target] })
    } catch {
      continue
    }
    for (const doc of data.self?.documents || [])
      if (doc.path === target) {
        contents.push(doc.content)
        for (const block of parseClaimBlocks(doc.content, target)) ids.add(block.claim_id)
      }
  }
  return { lenses, ids, contents }
}
// The MCP view used for create and preview: claim lookups and duplicate checks see only delivered claims, so an error
// can never confirm that a hidden claim exists. A hidden twin of a visible legacy claim (same wording) is ignored too.
function mcpClaimView(project) {
  const cache = new Map(),
    get = rel => {
      if (!cache.has(rel)) cache.set(rel, mcpDeliveredClaims(project, rel))
      return cache.get(rel)
    }
  return {
    visible: (rel, block) => {
      const seen = get(rel)
      return !block.malformed && seen.ids.has(block.claim_id) && seen.lenses.some(lens => visibleUnderBehavior(block.visibility, lens, 'generic'))
    },
    delivered: rel => get(rel).contents
  }
}
function assertMcpClaimTargets(project, changes, view) {
  const self = readLink(project).path
  for (const change of changes) {
    if ((change.operation || 'append_claim') === 'append_claim') continue
    const target = slash(relative(self, safeTarget(self, change.target || 'context/claims.md')))
    if (!view.delivered(target).some(content => parseClaimBlocks(content, target).some(block => block.claim_id === change.claim_id))) {
      const error = new Error(`claim not found in ${target}: ${change.claim_id}`)
      error.code = 'CLAIM_NOT_FOUND'
      throw error
    }
  }
}
export function holoselfMcpCreateProposal(project, input) {
  const linked = resolve(project),
    view = mcpClaimView(linked)
  assertMcpClaimTargets(linked, [input], view)
  const p = createProposal(linked, input, { view }),
    clean = { ...p }
  delete clean.source_project_path
  return clean
}
export function holoselfMcpPreviewProposal(project, id) {
  const linked = resolve(project),
    view = mcpClaimView(linked)
  // Hidden targets must fail as CLAIM_NOT_FOUND before planning could report anything about them.
  assertMcpClaimTargets(linked, proposalChanges(findProposal(linked, id)), view)
  const preview = proposalPreviewData(linked, id, { view })
  return {
    proposal_id: preview.proposal.proposal_id,
    status: preview.proposal.status,
    changes: preview.changes,
    preview_hash: preview.preview_hash,
    requires_human_approval: true,
    canonical_write_performed: false
  }
}
