// Context resolution: caller identity, lens authority, candidates, selection, delivery and envelope.
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { canonicalSort } from '../catalog.mjs'
import { ensureCatalog } from '../catalog/partitions.mjs'
import { cachedSelection } from '../context-selection.mjs'
import { canonicalSpaceId } from '../link/registry.mjs'
import { listProposalData } from '../proposals/store.mjs'
import { hash, safeRealpath, slash } from '../shared/fs.mjs'
import { PACKAGE_ROOT } from '../shared/package-root.mjs'
import { resolveCaller, resolveLensAuthority } from './caller.mjs'
import { getIdentityId, getOrCreateCursorSecret } from './cursor-identity.mjs'
import { createRecordDelivery } from './delivery.mjs'
import { fitEnvelope } from './envelope.mjs'
import { documentProjection, sourceIndexEntry } from './projection.mjs'
import { catalogCandidateRecords, deduplicateCandidates, resolvedContextAssertions } from './records.mjs'

export function contextData(o) {
  if (o.federated || o.spaces?.length) {
    console.error('[warn] --federated is deprecated and has no effect; Holoself indexes only the self.')
  }
  if (o.noCache) {
    console.error('[warn] --no-cache is deprecated and has no effect; the on-disk decision cache has been removed.')
  }
  const caller = resolveCaller(o)
  const authority = resolveLensAuthority(o, caller)
  const gathered = gatherCandidates(o, { ...caller, ...authority })
  const selection = selectRecords(o, { ...caller, ...authority, ...gathered })
  const assembled = assembleResult(o, { ...caller, ...authority, ...gathered, ...selection })
  return fitEnvelope(o, assembled.result, { ...caller, ...authority, ...gathered, ...selection, ...assembled })
}

// Catalog candidates from self, the linked project and selected contribs, de-duplicated.
function gatherCandidates(o, { project, link, self, identity, registry, lens, resolution, subject }) {
  const adapter = o.restrictedHost ? 'restricted-host' : o.adapter || 'generic'
  const projectForCatalog = identity.kind === 'client:linked' ? project : null
  const catResult = ensureCatalog(self, projectForCatalog, link, registry, { rebuild: false })
  const selfData = catalogCandidateRecords(catResult.self, self, 'self', lens, o.task, adapter, registry, resolution, o, identity.kind, subject)
  const local =
    identity.kind === 'client:linked' &&
    identity.project !== null &&
    !o.selfOnly &&
    existsSync(project) &&
    resolve(project) !== resolve(self) &&
    catResult.project
      ? catalogCandidateRecords(catResult.project, project, 'project', lens, o.task, adapter, registry, resolution, o, identity.kind, subject)
      : { records: [], restrictions: [], unauthorized_sources_omitted: 0 }

  let contribCandidates = []
  if (o.task && catResult.contrib) {
    let config = null
    try {
      config = JSON.parse(readFileSync(join(self, 'config.json'), 'utf8'))
    } catch {}
    const selectedContribs = new Set(Array.isArray(config?.selectedContribs) ? config.selectedContribs : [])
    if (selectedContribs.size > 0) {
      const filteredSources = catResult.contrib.sources.filter(s => selectedContribs.has(s.frontmatter?.contrib?.id))
      const contribPartition = { ...catResult.contrib, sources: filteredSources }
      const contribRes = catalogCandidateRecords(
        contribPartition,
        PACKAGE_ROOT,
        'contrib',
        lens,
        o.task,
        adapter,
        registry,
        resolution,
        o,
        identity.kind,
        subject
      )
      contribCandidates = contribRes.records
    }
  }

  const rawCandidates = [...selfData.records, ...local.records, ...contribCandidates]
  const candidates = deduplicateCandidates(rawCandidates, subject.space_id)

  return { adapter, catResult, selfData, local, candidates }
}

// Selection over the candidates, delivering each selected record through policy.
function selectRecords(o, { project, self, identity, registry, lens, resolution, subject, adapter, catResult, candidates }) {
  const cursorSecret = getOrCreateCursorSecret(self)
  const identityId = getIdentityId(identity, cursorSecret)
  const selfId = hash(slash(safeRealpath(self))).slice(0, 16)
  const allowedLensesList = identity.allowedLenses ? [...identity.allowedLenses].sort(canonicalSort) : [...registry.byId.keys()].sort(canonicalSort)
  const budgetName = o.budget || 'standard'
  const reqSources = o.sources || o.source_ids || []

  const delivery = createRecordDelivery(o, { project, identity, registry, lens, resolution, subject, adapter })
  const { deliveryRestrictions, deliverRecord } = delivery

  const selectionOptions = {
    task: o.task,
    lens,
    budget: budgetName,
    manifest: o.manifest,
    sources: reqSources,
    temporal: o.temporal || 'current',
    includeHistory: o.includeHistory,
    cursor: o.cursor || null,
    cursorSecret,
    identityId,
    selfId,
    registryHash: registry.registry_hash,
    allowedLenses: allowedLensesList,
    deliver: deliverRecord,
    sessionStart: Boolean(o.sessionStart),
    sessionStartSources: resolution.session_start_sources || null,
    now: o.now
  }

  const selected = cachedSelection(candidates, selectionOptions)
  selected.selection.reconcile_reads = delivery.reconcileReads
  selected.selection.catalog_reads = catResult.catalog_reads || 0

  return { cursorSecret, identityId, selfId, budgetName, selected, deliveryRestrictions }
}

// The packet before envelope fitting: documents, provenance index, restrictions, warnings, receipt and proposals.
function assembleResult(
  o,
  { surface, project, link, self, identity, registry, lens, resolution, subject, adapter, catResult, selfData, local, selected, deliveryRestrictions }
) {
  const records = [...selected.records]
  const warnings = [...(catResult.warnings || []), ...(identity.kind === 'owner:direct' ? [...(selfData.warnings || []), ...(local.warnings || [])] : [])]
  if (!link && !o.self && resolve(self) !== resolve(project)) warnings.push('No project link found; resolved explicit/default self root.')
  if (selected.selection.session_start_unmatched?.length)
    warnings.push(`session_start_sources matched no source: ${selected.selection.session_start_unmatched.join(', ')}`)
  const generatedAt = new Date().toISOString(),
    restrictedHost = Boolean(o.snapshot || o.restrictedHost || adapter === 'restricted-host'),
    expiresAt = restrictedHost ? new Date(Date.parse(generatedAt) + (o.expiresHours || 24) * 60 * 60 * 1000).toISOString() : null
  const validation = resolvedContextAssertions(records, lens, o.task, adapter, link, resolution, subject)
  const localSpaceId = identity.kind === 'client:linked' ? canonicalSpaceId(project) : 'self'
  const isLinked = identity.kind === 'client:linked',
    isMcp = surface === 'mcp'
  // Document bodies live only in the owning documents array; sources[] is a body-free provenance index.
  const projections = list => {
    const selfDocs = list.filter(r => r.kind === 'self').map(documentProjection),
      localDocs = list.filter(r => r.kind === 'project' && (!r.space_id || r.space_id === localSpaceId)).map(documentProjection)
    return {
      self: isLinked ? { documents: selfDocs } : { path: slash(resolve(self)), documents: selfDocs },
      project: isLinked ? { name: basename(project), documents: localDocs } : { path: slash(project), name: basename(project), documents: localDocs },
      methods: { documents: list.filter(r => r.kind === 'contrib').map(r => ({ ...documentProjection(r), contrib: r.contrib })) },
      sources: list.map(sourceIndexEntry),
      source_hashes: list.map(r => ({ kind: r.kind, path: r.path, sha256: r.source_hash, freshness: r.freshness }))
    }
  }
  const view = projections(records)

  const queryStatus = selected.selection.context_need === 'not-needed' ? 'not-needed' : 'complete'

  const unauthorizedSourcesOmitted = (selfData.unauthorized_sources_omitted || 0) + (local.unauthorized_sources_omitted || 0)
  let result = {
    status: queryStatus,
    self: view.self,
    lens,
    lens_resolution: {
      schema_version: resolution.schema_version,
      id: resolution.id,
      title: resolution.title,
      sensitivity_access: [...resolution.sensitivity_access]
    },
    project: view.project,
    methods: view.methods,
    task: o.task || null,
    packet_metadata: {
      schema_version: 3,
      packet_id: randomUUID(),
      generated_at: generatedAt,
      expires_at: expiresAt,
      host_mode: restrictedHost ? 'restricted-host-snapshot' : 'live-local',
      lens_registry_hash: registry.registry_hash,
      source_hash_algorithm: 'sha256',
      source_hashes: view.source_hashes
    },
    sources: view.sources,
    restrictions: [...selfData.restrictions, ...local.restrictions, ...deliveryRestrictions, ...selected.omitted, ...selected.temporalExcluded],
    warnings,
    validation,
    selection: {
      ...selected.selection,
      ...(!isLinked && unauthorizedSourcesOmitted > 0 ? { unauthorized_sources_omitted: unauthorizedSourcesOmitted } : {})
    },
    context_receipt: {
      ...selected.receipt,
      status: queryStatus,
      cache: selected.cache
    },
    proposals: isLinked && project ? listProposalData(project).filter(p => p.status === 'pending') : [],
    cache: selected.cache,
    ...(!isLinked && unauthorizedSourcesOmitted > 0 ? { unauthorized_sources_omitted: unauthorizedSourcesOmitted } : {})
  }

  return { result, records, projections, isMcp }
}
