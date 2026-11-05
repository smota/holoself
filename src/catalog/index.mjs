// Local search index over the catalog and privacy-filtered search.
import { basename } from 'node:path'
import { VISIBILITIES } from '../annotations.mjs'
import { canonicalJson, canonicalSort } from '../catalog.mjs'
import { temporalDisposition } from '../context-selection.mjs'
import { loadLensRegistry } from '../lenses.mjs'
import { readLink } from '../link/config.mjs'
import { canonicalSpaceId } from '../link/registry.mjs'
import { tokenize } from '../markdown/text.mjs'
import { allowed, claimStatusIncluded, filterClaimVisibility, filterFieldVisibility } from '../policy/access.mjs'
import { catalogElementVisible } from '../policy/sub-document-rules.mjs'
import { hash, slash } from '../shared/fs.mjs'
import { ensureFtsIndex, indexEngine, lexicalScores } from './fts.mjs'
import { ensureCatalog } from './partitions.mjs'

export function buildIndex(project, changed = false, options = {}) {
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
  const engine = indexEngine()
  // The FTS5 file is a derived cache of the self catalog: the `index` command refreshes it (`index rebuild` deletes and
  // rebuilds it); search opens it lazily, so readIndex does not open it twice.
  if (engine === 'fts5' && options.ensureFts) ensureFtsIndex(link.path, result.self, { rebuild: !changed })
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
    engine,
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
// Self-only index for an unlinked client: the self partition alone, with no project entries and no project path.
export function readSelfIndex(selfRoot, registry = loadLensRegistry(selfRoot)) {
  const result = ensureCatalog(selfRoot, null, null, registry, { rebuild: false })
  const entries = (result.self?.sources || [])
    .map(s => ({ ...s, source_kind: 'canonical', source_project: 'self', space_id: 'self' }))
    .sort((a, b) => canonicalSort(a.file, b.file))
  return { schema_version: 1, privacy_policy_version: 4, lens_registry_hash: registry.registry_hash, project: null, entries, sources: entries }
}
export function readIndex(project) {
  return buildIndex(project, true)
}
// Search over sections that pass the caller's privacy gate. Every query term must match (all-terms):
// the JSON engine matches lowercase substrings of heading + filtered snippet; the FTS5 engine matches
// stemmed, diacritic-folded tokens (with prefix expansion for terms of 4+ characters), ignores stopwords
// when other terms remain, and ranks by BM25 computed over the visible sections only.
export function searchIndex(index, query, lens = 'general', registry = null, resolution = null, temporal = 'current', options = {}) {
  const terms = [...tokenize(query, { stopwords: false })],
    eligible = [],
    adapter = options.adapter || 'generic',
    engine = options.engine || indexEngine()
  const entries = index.entries || index.sources || []
  const consumerSpaceId = index.project ? canonicalSpaceId(index.project) : null
  for (const entry of entries) {
    const entrySpaceId = entry.space_id || (entry.source_kind === 'canonical' ? 'self' : consumerSpaceId || 'project')
    const subj = options.subject
      ? options.subject
      : consumerSpaceId
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
    for (const section of entry.sections || []) {
      const sectionVisibility = VISIBILITIES.includes(section.visibility) ? section.visibility : 'private'
      if (!catalogElementVisible(section, lens, adapter) || !claimStatusIncluded(section.claim_status, temporal)) continue
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
      eligible.push({ entry, section, filtered, sectionVisibility, entrySpaceId })
    }
  }

  let matches
  const scores =
    engine === 'fts5' && terms.length
      ? lexicalScores(
          eligible.map((item, i) => ({
            id: i,
            sections: [{ source_id: item.entry.source_ref?.source_id, section_id: item.section.section_id, heading: item.section.heading, text: item.filtered }]
          })),
          query,
          {
            keepStopwords: true,
            selfRoot: index.self || null,
            partition: { space_id: 'self', lens_registry_hash: index.lens_registry_hash, sources: entries.filter(e => e.source_kind === 'canonical') }
          }
        )
      : null
  if (scores) {
    matches = eligible
      .map((item, i) => ({ item, s: scores.get(i), order: i }))
      .filter(x => x.s && x.s.terms > 0 && x.s.matched === x.s.terms)
      .map(x => ({ ...x.item, score: x.s.matched, bm25: x.s.bm25, order: x.order }))
      .sort((a, b) => b.bm25 - a.bm25 || canonicalSort(a.entry.file, b.entry.file) || a.order - b.order)
  } else {
    matches = eligible
      .map(item => ({ ...item, score: terms.filter(x => `${item.section.heading} ${item.filtered}`.toLowerCase().includes(x)).length }))
      .filter(item => item.score && item.score >= terms.length)
      .sort((a, b) => b.score - a.score || canonicalSort(a.entry.file, b.entry.file))
  }
  const results = matches.map(({ entry, section, filtered, sectionVisibility, entrySpaceId, score, bm25 }) => {
    const policy = entry.frontmatter || {}
    const passage = filtered.length > 360 ? filtered.slice(0, 357) + '...' : filtered
    const provPrefix = entry.source_kind === 'canonical' ? 'self' : entry.source_project || entry.space_id || entry.source_ref?.space_id
    return {
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
      score,
      ...(bm25 !== undefined ? { bm25 } : {})
    }
  })
  // The engine that actually ranked these results (FTS5 falls back to JSON on any index failure).
  Object.defineProperty(results, 'engine', { value: scores || (engine === 'fts5' && !terms.length) ? engine : 'deterministic-json', enumerable: false })
  return results
}
