// MCP-facing facade over context, search, status and proposals for a fixed linked project.
import { existsSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { readIndex, searchIndex } from '../catalog/index.mjs'
import { loadLensRegistry, resolveLens } from '../lenses.mjs'
import { linkedLensAuthority } from '../link/attestation.mjs'
import { readLink } from '../link/config.mjs'
import { healthStatus } from '../link/health.mjs'
import { createProposal, listProposalData, proposalPreviewData } from '../proposals/store.mjs'
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
    lens: requestedLens,
    budget: options.budget || 'standard',
    temporal: options.temporal || 'current',
    manifest: Boolean(options.manifest),
    sources: options.source_ids || options.sources || [],
    cursor: options.cursor || null,
    sessionStart: Boolean(options.session_start),
    noCache: true
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
    contextData({ project, manifest: true, budget: 'small', noCache: true, surface: 'internal-health' })
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
    index = readIndex(linked, true, false, { federated: Boolean(input.federated), spaces: input.spaces, lens })
  let results = searchIndex(index, input.query, lens, registry, resolution, input.temporal || 'current', {
    federated: Boolean(input.federated),
    spaces: input.spaces,
    effective_allowed_lenses: allowedLenses
  })
  return { query: input.query, lens, federated: Boolean(input.federated), results: results.slice(0, input.limit || 10) }
}
export function holoselfMcpCreateProposal(project, input) {
  const p = createProposal(resolve(project), input),
    clean = { ...p }
  delete clean.source_project_path
  return clean
}
export function holoselfMcpPreviewProposal(project, id) {
  const preview = proposalPreviewData(resolve(project), id)
  return {
    proposal_id: preview.proposal.proposal_id,
    status: preview.proposal.status,
    changes: preview.changes,
    preview_hash: preview.preview_hash,
    requires_human_approval: true,
    canonical_write_performed: false
  }
}
