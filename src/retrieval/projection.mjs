// Packet projections: document entries, body-free source index, restriction grouping, path stripping.

// One entry per reason: the first source (kept as `source` for compatibility), up to five sources, and the total count.
export function groupRestrictions(list) {
  const groups = new Map()
  for (const item of list) {
    const group = groups.get(item.reason) || { reason: item.reason, count: 0, sources: [] }
    group.count += item.count || 1
    for (const source of item.sources || [item.source]) if (source && group.sources.length < 5 && !group.sources.includes(source)) group.sources.push(source)
    groups.set(item.reason, group)
  }
  return [...groups.values()].map(group => ({ source: group.sources[0] ?? null, reason: group.reason, count: group.count, sources: group.sources }))
}
export const documentProjection = r => ({
  path: r.path,
  content: r.content,
  metadata: r.metadata,
  source_id: r.source_id,
  truncated: r.truncated,
  manifest_only: r.manifest_only
})
// When the body is delivered in documents[], body-derived fields (search_text, sections, claims, links) are left out
// and headings stay as a short outline. Manifest entries carry no body, so they keep their snippets.
export function sourceIndexEntry(record) {
  const { content, metadata, absolute_path, ...entry } = record
  if (record.manifest_only) return entry
  // Metadata copies (access_lenses, disclosure, ...) and source_ref are dropped too: documents[].metadata and source_id/source_hash carry them.
  const {
    search_text,
    sections,
    claims,
    links,
    source_ref,
    access_lenses,
    disclosure,
    publication_allowed,
    visibility,
    public_safe,
    sensitivity,
    confidence,
    ...index
  } = entry
  return { ...index, headings: (sections || []).map(section => section.heading).filter(Boolean) }
}
export function withoutPrivatePaths(value) {
  if (Array.isArray(value)) return value.map(withoutPrivatePaths)
  if (!value || typeof value !== 'object') return value
  const clean = {}
  for (const [key, item] of Object.entries(value)) {
    if (['absolute_path', '_path', 'source_project_path'].includes(key)) continue
    if (key === 'path' && (value === value.self || value === value.project)) continue
    clean[key] = withoutPrivatePaths(item)
  }
  return clean
}
