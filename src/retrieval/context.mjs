// Context resolution: caller identity, lens authority, candidates, selection, delivery and envelope.
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import {
  CACHE_SCHEMA_VERSION,
  SOURCE_ID_RE,
  canonicalJson,
  canonicalSort,
  computeDecisionCacheKey,
  decisionCacheDir,
  getDecisionCacheLimits,
  purgeInvalidDecisionCache,
  readDecisionCache,
  writeDecisionCache
} from '../catalog.mjs'
import { ensureCatalog } from '../catalog/partitions.mjs'
import { cachedSelection, selectContextRecords, sourceId } from '../context-selection.mjs'
import { canonicalSpaceId } from '../link/registry.mjs'
import { listProposalData } from '../proposals/store.mjs'
import { hash, safeRealpath, slash } from '../shared/fs.mjs'
import { PACKAGE_ROOT } from '../shared/package-root.mjs'
import { resolveCaller, resolveLensAuthority } from './caller.mjs'
import { getIdentityId, getOrCreateCursorSecret } from './cursor-identity.mjs'
import { createRecordDelivery } from './delivery.mjs'
import { fitEnvelope } from './envelope.mjs'
import { documentProjection, sourceIndexEntry } from './projection.mjs'
import { catalogCandidateRecords, deduplicateCandidates, getEligibleFederatedSpaces, resolvedContextAssertions } from './records.mjs'

export function contextData(o) {
  const caller = resolveCaller(o)
  const authority = resolveLensAuthority(o, caller)
  const gathered = gatherCandidates(o, { ...caller, ...authority })
  const selection = selectRecords(o, { ...caller, ...authority, ...gathered })
  const assembled = assembleResult(o, { ...caller, ...authority, ...gathered, ...selection })
  return fitEnvelope(o, assembled.result, { ...caller, ...authority, ...gathered, ...selection, ...assembled })
}

// Catalog candidates from self, the linked project, selected contribs and federated peers, de-duplicated.
function gatherCandidates(o, { project, link, self, identity, registry, lens, resolution, subject }) {
  const eligibleFederatedSpaces = getEligibleFederatedSpaces(self, identity.kind === 'client:linked' ? project : null, lens, o)

  const adapter = o.restrictedHost ? 'restricted-host' : o.adapter || 'generic'
  const projectForCatalog = identity.kind === 'client:linked' ? project : null
  const catResult = ensureCatalog(self, projectForCatalog, link, registry, { rebuild: false, federatedSpaces: eligibleFederatedSpaces })
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

  let federatedCandidates = []
  let federatedUnauthorizedOmitted = 0
  for (const peer of catResult.federated || []) {
    const peerData = catalogCandidateRecords(peer.catalog, peer.path, 'project', lens, o.task, adapter, registry, resolution, o, identity.kind, subject)
    for (const rec of peerData.records) {
      rec.space_id = peer.space_id
      rec.peer_name = peer.name
      federatedCandidates.push(rec)
    }
    if (identity.kind === 'owner:direct' && peerData.unauthorized_sources_omitted) {
      federatedUnauthorizedOmitted += peerData.unauthorized_sources_omitted
    }
  }

  const rawCandidates = [...selfData.records, ...local.records, ...contribCandidates, ...federatedCandidates]
  const candidates = deduplicateCandidates(rawCandidates, subject.space_id)

  return { adapter, catResult, selfData, local, federatedUnauthorizedOmitted, candidates }
}

// Decision-cache keyed selection over the candidates, delivering each selected record through policy.
function selectRecords(o, { project, link, self, identity, registry, links_register_hash, lens, resolution, subject, adapter, catResult, candidates }) {
  const cursorSecret = getOrCreateCursorSecret(self)
  const identityId = getIdentityId(identity, cursorSecret)
  const selfId = hash(slash(safeRealpath(self))).slice(0, 16)
  const allowedLensesList = identity.allowedLenses ? [...identity.allowedLenses].sort(canonicalSort) : [...registry.byId.keys()].sort(canonicalSort)
  const budgetName = o.budget || 'standard'

  const spaceSourcesMap = {
    self: (catResult.self?.sources || []).map(s => [s.source_ref.source_id, s.source_ref.revision])
  }
  if (catResult.project) {
    spaceSourcesMap[catResult.project.space_id || 'project'] = (catResult.project?.sources || []).map(s => [s.source_ref.source_id, s.source_ref.revision])
  }
  for (const peer of catResult.federated || []) {
    spaceSourcesMap[peer.space_id] = (peer.catalog?.sources || []).map(s => [s.source_ref.source_id, s.source_ref.revision])
  }
  const catalog_hash = hash(canonicalJson(spaceSourcesMap))

  let configObj = null
  try {
    configObj = JSON.parse(readFileSync(join(self, 'config.json'), 'utf8'))
  } catch {}
  const contrib_selection_hash = hash(canonicalJson(Array.isArray(configObj?.selectedContribs) ? [...configObj.selectedContribs].sort(canonicalSort) : []))

  const reqSources = o.sources || o.source_ids || []
  const requested_source_ids =
    Array.isArray(reqSources) && reqSources.length
      ? [
          ...new Set(
            reqSources
              .map(s => {
                if (typeof s === 'string' && SOURCE_ID_RE.test(s)) return s
                const found = candidates.find(c => c.path === s || c.source_id === s)
                return found ? found.source_id : typeof s === 'string' ? sourceId({ kind: 'self', path: s }) : null
              })
              .filter(id => typeof id === 'string' && SOURCE_ID_RE.test(id))
          )
        ].sort(canonicalSort)
      : null

  const decisionKey = computeDecisionCacheKey({
    catalog_hash,
    lens_registry_hash: registry.registry_hash,
    contrib_selection_hash,
    links_register_hash,
    identity_id: identityId,
    lens,
    allowed_lenses: allowedLensesList,
    task_hash: hash(String(o.task || '')),
    // A session-start request selects differently from a task-less one, so it gets its own decision key.
    session_start: Boolean(o.sessionStart),
    temporal: o.temporal || 'current',
    include_history: Boolean(o.includeHistory),
    budget: budgetName,
    manifest: Boolean(o.manifest),
    requested_source_ids,
    cursor: o.cursor || null
  })

  const cacheDir = link && !o.noCache ? decisionCacheDir(project) : null
  if (cacheDir) {
    purgeInvalidDecisionCache(cacheDir)
  }

  const delivery = createRecordDelivery(o, { project, identity, registry, lens, resolution, subject, adapter })
  const { deliveryRestrictions, deliverRecord } = delivery

  const nowMs = o.now ? (typeof o.now === 'number' ? o.now : Date.parse(o.now) || Date.now()) : Date.now()
  const candidateEpochs = candidates.map(c => c.metadata?.valid_until_epoch_ms).filter(v => typeof v === 'number' && v > nowMs)
  const validUntilEpochMs = candidateEpochs.length ? Math.min(...candidateEpochs) : null

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

  // Cold, in-memory and persistent hits all run the same selection; a hit only marks that the decision was seen.
  const cachedEntry = cacheDir ? readDecisionCache(cacheDir, decisionKey, { now: o.now }) : null
  let selected
  if (cachedEntry) {
    selected = { ...selectContextRecords(candidates, selectionOptions), cache: { key: decisionKey, hit: true, persistent: true } }
  } else {
    selected = cachedSelection(candidates, selectionOptions)
    if (cacheDir) {
      const decisionEntry = {
        schema_version: CACHE_SCHEMA_VERSION,
        catalog_hash,
        lens_registry_hash: registry.registry_hash,
        contrib_selection_hash,
        links_register_hash,
        identity_id: identityId,
        lens,
        allowed_lenses: allowedLensesList,
        task_hash: hash(String(o.task || '')),
        temporal: o.temporal || 'current',
        include_history: Boolean(o.includeHistory),
        budget: budgetName,
        manifest: Boolean(o.manifest),
        requested_source_ids,
        cursor: o.cursor || null,
        source_refs: selected.records.map(r => r.source_ref),
        receipt: selected.receipt,
        state_hash: selected.stateHash,
        valid_until_epoch_ms: validUntilEpochMs,
        estimated_tokens_total: selected.selection.estimated_tokens
      }
      writeDecisionCache(cacheDir, decisionKey, decisionEntry, getDecisionCacheLimits(link))
      selected.cache = { key: decisionKey, hit: false, persistent: true }
    }
  }
  selected.selection.reconcile_reads = delivery.reconcileReads
  selected.selection.catalog_reads = catResult.catalog_reads || 0

  return { cursorSecret, identityId, selfId, budgetName, selected, deliveryRestrictions }
}

// The packet before envelope fitting: documents, provenance index, restrictions, warnings, receipt and proposals.
function assembleResult(
  o,
  {
    surface,
    project,
    link,
    self,
    identity,
    registry,
    lens,
    resolution,
    subject,
    adapter,
    catResult,
    selfData,
    local,
    federatedUnauthorizedOmitted,
    selected,
    deliveryRestrictions
  }
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
      federated: (catResult.federated || [])
        .map(peer => ({
          space_id: peer.space_id,
          name: peer.name,
          documents: list.filter(r => r.kind === 'project' && r.space_id === peer.space_id && r.space_id !== localSpaceId).map(documentProjection)
        }))
        .filter(p => p.documents.length > 0),
      methods: { documents: list.filter(r => r.kind === 'contrib').map(r => ({ ...documentProjection(r), contrib: r.contrib })) },
      sources: list.map(sourceIndexEntry),
      source_hashes: list.map(r => ({ kind: r.kind, path: r.path, sha256: r.source_hash, freshness: r.freshness }))
    }
  }
  const view = projections(records)

  const hasUnreachable = Boolean(catResult.unreachable_spaces && catResult.unreachable_spaces.length > 0)
  const queryStatus = hasUnreachable ? 'partial' : selected.selection.context_need === 'not-needed' ? 'not-needed' : 'complete'

  const unauthorizedSourcesOmitted = (selfData.unauthorized_sources_omitted || 0) + (local.unauthorized_sources_omitted || 0) + federatedUnauthorizedOmitted
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
    federated: view.federated,
    methods: view.methods,
    ...(hasUnreachable ? { unreachable_spaces: catResult.unreachable_spaces } : {}),
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
      ...(hasUnreachable ? { unreachable_spaces: catResult.unreachable_spaces } : {}),
      cache: selected.cache
    },
    proposals: isLinked && project ? listProposalData(project).filter(p => p.status === 'pending') : [],
    cache: selected.cache,
    ...(!isLinked && unauthorizedSourcesOmitted > 0 ? { unauthorized_sources_omitted: unauthorizedSourcesOmitted } : {})
  }

  return { result, records, projections, isMcp }
}
