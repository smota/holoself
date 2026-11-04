// Local search index over the catalog and privacy-filtered search.
import { basename } from 'node:path'
import { VISIBILITIES } from '../annotations.mjs'
import { canonicalJson, canonicalSort } from '../catalog.mjs'
import { temporalDisposition } from '../context-selection.mjs'
import { loadLensRegistry } from '../lenses.mjs'
import { readLink } from '../link/config.mjs'
import { canonicalSpaceId } from '../link/registry.mjs'
import { tokenize } from '../markdown/text.mjs'
import { allowed, filterClaimVisibility, filterFieldVisibility, visibleUnderBehavior } from '../policy/access.mjs'
import { getEligibleFederatedSpaces } from '../retrieval/records.mjs'
import { hash, slash } from '../shared/fs.mjs'
import { ensureCatalog } from './partitions.mjs'

export function buildIndex(project, changed = false, persist = true, options = {}) {
  const link = readLink(project),
    registry = loadLensRegistry(link.path)
  const federatedSpaces =
    options.federated || options.spaces?.length ? getEligibleFederatedSpaces(link.path, project, options.lens || link.default_lens || 'general', options) : []
  const result = ensureCatalog(link.path, project, link, registry, { rebuild: !changed, federatedSpaces })
  const projectSpaceId = canonicalSpaceId(project)
  const projectEntries = (result.project?.sources || []).map(s => ({
    ...s,
    source_kind: 'project',
    source_project: basename(project),
    space_id: projectSpaceId
  }))
  const selfEntries = (result.self?.sources || []).map(s => ({ ...s, source_kind: 'canonical', source_project: 'self', space_id: 'self' }))
  const fedEntries = []
  for (const peer of result.federated || []) {
    for (const s of peer.catalog?.sources || []) {
      fedEntries.push({ ...s, source_kind: 'federated', source_project: peer.space_id, space_id: peer.space_id, peer_name: peer.name })
    }
  }
  const entries = [...selfEntries, ...projectEntries, ...fedEntries]
  entries.sort((a, b) => canonicalSort(`${a.source_kind}:${a.file}`, `${b.source_kind}:${b.file}`))
  const input_state_hash = hash(
    canonicalJson({
      self: result.self.sources.map(s => [s.file, s.source_text_hash]),
      project: (result.project?.sources || []).map(s => [s.file, s.source_text_hash]),
      federated: (result.federated || []).map(p => [p.space_id, (p.catalog?.sources || []).map(s => [s.file, s.source_text_hash])])
    })
  )
  return {
    schema_version: 1,
    privacy_policy_version: 4,
    lens_registry_hash: registry.registry_hash,
    engine: 'deterministic-json',
    source_of_truth: 'Markdown',
    generated_at: result.project?.generated_at || result.self.generated_at,
    input_state_hash,
    project_context_hash: result.project?.project_context_hash || null,
    project: slash(project),
    self: slash(link.path),
    skipped_secret_files: result.skippedSecrets,
    warnings: result.warnings,
    build_assertions: {
      status: 'passed',
      checks: ['include-policy', 'exclude-policy', 'required-includes', 'forbidden-excludes', 'secret-pattern-scan'],
      included_project_files: projectEntries.length
    },
    entries,
    sources: entries
  }
}
export function readIndex(project, auto = true, persist = true, options = {}) {
  return buildIndex(project, true, persist, options)
}
export function searchIndex(index, query, lens = 'general', registry = null, resolution = null, temporal = 'current', options = {}) {
  const terms = [...tokenize(query, { stopwords: false })],
    results = [],
    behaviorLens = lens
  const entries = index.entries || index.sources || []
  const consumerSpaceId = index.project ? canonicalSpaceId(index.project) : null
  for (const entry of entries) {
    const entrySpaceId = entry.space_id || (entry.source_kind === 'canonical' ? 'self' : consumerSpaceId || 'project')
    const isPeer = entry.source_kind === 'federated' || Boolean(consumerSpaceId && entrySpaceId !== consumerSpaceId && entrySpaceId !== 'self')
    const subj = consumerSpaceId
      ? {
          kind: 'client:linked',
          space_id: consumerSpaceId,
          accessible_spaces: [consumerSpaceId],
          effective_allowed_lenses: options.effective_allowed_lenses || null
        }
      : null
    if (
      !allowed(entry.frontmatter || {}, lens, 'generic', null, resolution, subj, entrySpaceId) ||
      !temporalDisposition(entry.frontmatter || {}, query, { temporal }).include
    )
      continue
    const policy = entry.frontmatter || {}
    for (const section of entry.sections || []) {
      const sectionVisibility = VISIBILITIES.includes(section.visibility) ? section.visibility : 'private'
      if (!visibleUnderBehavior(sectionVisibility, behaviorLens, 'generic')) continue
      const restrictions = []
      const filtered = filterFieldVisibility(
        filterClaimVisibility(section.snippet || '', lens, entry.file, restrictions, resolution),
        entry.frontmatter || {},
        lens,
        entry.file,
        restrictions,
        resolution
      )
      if (!filtered.trim()) continue
      const hay = `${section.heading} ${filtered}`.toLowerCase(),
        score = terms.filter(x => hay.includes(x)).length
      if (!score || score < terms.length) continue
      const passage = filtered.length > 360 ? filtered.slice(0, 357) + '...' : filtered
      const provPrefix =
        entry.source_kind === 'canonical'
          ? 'self'
          : entry.source_kind === 'federated'
            ? entry.space_id
            : entry.source_project || entry.space_id || entry.source_ref?.space_id
      results.push({
        source_file: entry.file,
        source_kind: entry.source_kind === 'canonical' ? 'self' : entry.source_kind,
        source_project: entry.source_project || (entry.source_kind === 'canonical' ? 'self' : entry.space_id || entry.source_ref?.space_id),
        space_id: entrySpaceId,
        section: section.heading,
        matching_passage: passage,
        provenance: `${provPrefix}:${entry.file}#${section.heading}`,
        access_lenses: policy.access_lenses || [],
        disclosure: section.disclosure || policy.disclosure || 'internal-only',
        sensitivity: policy.sensitivity || 'personal',
        document_role: policy.document_role || 'content',
        publication_allowed: Boolean(policy.publication_allowed),
        visibility: sectionVisibility,
        freshness: entry.modified_ms ? new Date(entry.modified_ms).toISOString() : entry.modified_at || new Date().toISOString(),
        score
      })
    }
  }

  if (options.federated || options.deduplicate) {
    const localSpaceId = consumerSpaceId || 'project'
    const scorePrec = r => {
      if (r.space_id === localSpaceId || r.source_kind === 'project') return 1
      if (r.space_id === 'self' || r.source_kind === 'canonical') return 2
      return 3
    }
    const passageMap = new Map()
    for (const r of results) {
      const key = hash(r.matching_passage)
      const existing = passageMap.get(key)
      if (!existing) {
        passageMap.set(key, r)
      } else {
        const pExist = scorePrec(existing)
        const pCurr = scorePrec(r)
        if (pCurr < pExist || (pCurr === pExist && (r.space_id || '') < (existing.space_id || ''))) {
          passageMap.set(key, r)
        }
      }
    }
    return [...passageMap.values()].sort(
      (a, b) => b.score - a.score || canonicalSort(a.source_file, b.source_file) || canonicalSort(a.provenance, b.provenance)
    )
  }

  return results.sort((a, b) => b.score - a.score || canonicalSort(a.source_file, b.source_file))
}
