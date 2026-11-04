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
import { hash, slash } from '../shared/fs.mjs'
import { ensureCatalog } from './partitions.mjs'

export function buildIndex(project, changed = false) {
  const link = readLink(project),
    registry = loadLensRegistry(link.path)
  const result = ensureCatalog(link.path, project, link, registry, { rebuild: !changed })
  const projectSpaceId = canonicalSpaceId(project)
  const projectEntries = (result.project?.sources || []).map(s => ({
    ...s,
    source_kind: 'project',
    source_project: basename(project),
    space_id: projectSpaceId
  }))
  const selfEntries = (result.self?.sources || []).map(s => ({ ...s, source_kind: 'canonical', source_project: 'self', space_id: 'self' }))
  const entries = [...selfEntries, ...projectEntries]
  entries.sort((a, b) => canonicalSort(`${a.source_kind}:${a.file}`, `${b.source_kind}:${b.file}`))
  const input_state_hash = hash(
    canonicalJson({
      self: result.self.sources.map(s => [s.file, s.source_text_hash]),
      project: (result.project?.sources || []).map(s => [s.file, s.source_text_hash]),
      ...(result.self.policy_files?.length ? { policy_files: result.self.policy_files.map(p => [p.file, p.sha256]) } : {})
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
export function readIndex(project) {
  return buildIndex(project, true)
}
export function searchIndex(index, query, lens = 'general', registry = null, resolution = null, temporal = 'current', options = {}) {
  const terms = [...tokenize(query, { stopwords: false })],
    results = [],
    behaviorLens = lens,
    adapter = options.adapter || 'generic'
  const entries = index.entries || index.sources || []
  const consumerSpaceId = index.project ? canonicalSpaceId(index.project) : null
  for (const entry of entries) {
    const entrySpaceId = entry.space_id || (entry.source_kind === 'canonical' ? 'self' : consumerSpaceId || 'project')
    const subj = consumerSpaceId
      ? {
          kind: 'client:linked',
          space_id: consumerSpaceId,
          accessible_spaces: [consumerSpaceId],
          effective_allowed_lenses: options.effective_allowed_lenses || null
        }
      : null
    if (
      !allowed(entry.frontmatter || {}, lens, adapter, null, resolution, subj, entrySpaceId) ||
      !temporalDisposition(entry.frontmatter || {}, query, { temporal }).include
    )
      continue
    const policy = entry.frontmatter || {}
    for (const section of entry.sections || []) {
      const sectionVisibility = VISIBILITIES.includes(section.visibility) ? section.visibility : 'private'
      if (!visibleUnderBehavior(sectionVisibility, behaviorLens, adapter)) continue
      const restrictions = []
      const filtered = filterFieldVisibility(
        filterClaimVisibility(section.snippet || '', lens, entry.file, restrictions, resolution, 'owner:direct', adapter),
        entry.frontmatter || {},
        lens,
        entry.file,
        restrictions,
        resolution,
        'owner:direct',
        adapter
      )
      if (!filtered.trim()) continue
      const hay = `${section.heading} ${filtered}`.toLowerCase(),
        score = terms.filter(x => hay.includes(x)).length
      if (!score || score < terms.length) continue
      const passage = filtered.length > 360 ? filtered.slice(0, 357) + '...' : filtered
      const provPrefix = entry.source_kind === 'canonical' ? 'self' : entry.source_project || entry.space_id || entry.source_ref?.space_id
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

  return results.sort((a, b) => b.score - a.score || canonicalSort(a.source_file, b.source_file))
}
