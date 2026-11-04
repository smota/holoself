// Catalog source records built from one Markdown file.
import { existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { VISIBILITIES } from '../annotations.mjs'
import { canonicalSort, readSourceWithStat, slugHeading, sourceRef } from '../catalog.mjs'
import { canonicalSpaceId } from '../link/registry.mjs'
import { replaceClaimBlocks } from '../markdown/claim-blocks.mjs'
import { claims, links, sections, tags } from '../markdown/text.mjs'
import { fieldHeadingRule, fieldLineRule, intersectVisibility, privacyMetadata, visibility } from '../policy/access.mjs'
import { resolveDocumentPolicy } from '../policy/policy-defaults.mjs'
import { canonicalPrivacyMetadataErrors, frontmatter } from '../policy/privacy-fields.mjs'
import { SECRET_RE, secretFile } from '../policy/secrets.mjs'
import { assertContainedPath, hash, slash } from '../shared/fs.mjs'

export function catalogRoot(project) {
  return assertContainedPath(project, join(project, '.holoself', 'catalog'), 'catalog directory')
}
export function catalogFilePath(project) {
  return join(catalogRoot(project), 'catalog.json')
}
export function privacySections(body, policy) {
  const chunks = []
  const ordinary = replaceClaimBlocks(body, block => {
    const status = block.status
    for (const section of sections(block.body)) {
      // A field heading rule inside a claim block narrows that section too, as filterFieldVisibility does for content.
      const headingRule = fieldHeadingRule(section.heading, policy.field_visibility || {}),
        v = headingRule ? intersectVisibility(block.visibility, headingRule) : block.visibility
      chunks.push({
        ...section,
        visibility: v,
        claim: true,
        disclosure: v === 'public-safe' ? 'publish-approved' : 'review-required',
        ...(status === 'current' ? {} : { claim_status: status })
      })
    }
    return ''
  })
  // Ordinary sections without a field rule inherit the document's own access and disclosure (the document gate already
  // decides who sees them), so they are delivered wherever the document is, including publication adapters when the
  // document is approved for publication. They no longer depend on the deprecated document `visibility`.
  const inherited = policy.publication_allowed ? 'public-safe' : 'linked-projects'
  for (const section of sections(ordinary)) {
    const heading = section.heading.toLowerCase(),
      fieldRule = Object.entries(policy.field_visibility || {}).find(([field]) => heading.includes(field.toLowerCase())),
      v = fieldRule?.[1] || inherited
    chunks.push({ ...section, visibility: v, claim: false, disclosure: policy.disclosure })
  }
  return chunks
}
export function buildCatalogSections(rawSections, defaults = {}) {
  const seenSlugs = new Map()
  return rawSections.map(sec => {
    const baseSlug = slugHeading(sec.heading)
    const count = (seenSlugs.get(baseSlug) || 0) + 1
    seenSlugs.set(baseSlug, count)
    const section_id = count === 1 ? baseSlug : `${baseSlug}-${count}`
    const snippet = (sec.content.length > 360 ? sec.content.slice(0, 357) + '...' : sec.content).trim()
    return {
      section_id,
      heading: sec.heading,
      visibility: sec.visibility ?? defaults.visibility,
      disclosure: sec.disclosure ?? defaults.disclosure,
      claim: Boolean(sec.claim ?? defaults.claim),
      ...(sec.claim_status ? { claim_status: sec.claim_status } : {}),
      snippet
    }
  })
}
// Claims, links and tags of each section carry the visibility of the text they come from: the section's (claim or
// ordinary) visibility, narrowed by any field_visibility heading or `Field: value` line rule, exactly as
// filterFieldVisibility narrows delivered content and snippets. A field line hidden from a lens or adapter therefore
// never surfaces through claims, tags, links or search text either.
export function extractSectionAnnotations(rawSections, policy = {}) {
  const fieldVisibility = policy?.field_visibility || {}
  const annotatedClaims = [],
    annotatedLinks = [],
    annotatedTags = []
  for (const sec of rawSections) {
    const headingRule = fieldHeadingRule(sec.heading || '', fieldVisibility)
    const base = headingRule ? intersectVisibility(sec.visibility, headingRule) : sec.visibility
    const byVisibility = new Map()
    for (const line of String(sec.content).split(/\r?\n/)) {
      const lineRule = fieldLineRule(line, fieldVisibility),
        v = lineRule ? intersectVisibility(base, lineRule) : base
      if (!byVisibility.has(v)) byVisibility.set(v, [])
      byVisibility.get(v).push(line)
    }
    const status = sec.claim_status ? { claim_status: sec.claim_status } : {}
    const sectionClaims = []
    for (const [visibility, lines] of byVisibility) {
      const text = lines.join('\n')
      sectionClaims.push(...claims(text).map(value => ({ text: value, visibility, ...status })))
      annotatedLinks.push(...links(text).map(value => ({ value, visibility })))
      annotatedTags.push(...tags(text).map(value => ({ value, visibility })))
    }
    annotatedClaims.push(...sectionClaims.slice(0, 50))
  }
  annotatedClaims.sort((a, b) => canonicalSort(a.text, b.text))
  annotatedLinks.sort((a, b) => canonicalSort(a.value, b.value))
  annotatedTags.sort((a, b) => canonicalSort(a.value, b.value))
  return { claims: annotatedClaims, links: annotatedLinks, tags: annotatedTags }
}
export function buildCatalogSource(file, sourceKind, root, registry, tolerant = false) {
  const rel = slash(relative(root, file))
  if (!existsSync(file)) return null
  const read = readSourceWithStat(file)
  if (!read) return { unreadable: true, error: `${rel}: unreadable: file locked or sharing violation` }
  const { text, stat } = read
  let parsed
  try {
    parsed = frontmatter(text, { tolerant, registry })
  } catch (err) {
    return { error: `${rel}: ${err.message}` }
  }
  const { metadata, body, warnings: docWarnings } = parsed
  const resolvedPolicy = sourceKind === 'canonical' ? resolveDocumentPolicy(file, root, metadata, registry) : null
  const effectiveMetadata = resolvedPolicy ? resolvedPolicy.effectiveMetadata : metadata
  if (secretFile(file, root) || SECRET_RE.test(text) || ['secret', 'credential', 'credentials'].includes(effectiveMetadata.sensitivity)) {
    return { secret: true }
  }
  if (sourceKind === 'canonical') {
    const metadataErrors = canonicalPrivacyMetadataErrors(effectiveMetadata, registry)
    if (metadataErrors.length) return { error: `${rel}: ${metadataErrors.join('; ')}` }
  }
  if (!VISIBILITIES.includes(visibility(effectiveMetadata))) return null

  const policy = privacyMetadata(effectiveMetadata, registry)
  const rawSections = privacySections(body, policy)
  const catalogSections = buildCatalogSections(rawSections)
  const { claims: annotatedClaims, links: annotatedLinks, tags: annotatedTags } = extractSectionAnnotations(rawSections, policy)

  const sourceTextHash = hash(text)
  const spaceId = sourceKind === 'canonical' ? 'self' : sourceKind === 'project' ? canonicalSpaceId(root) : 'contrib'
  const sRef = sourceRef(spaceId, rel, sourceTextHash, null)
  const estimatedTokens = Math.ceil(text.length / 4)

  return {
    record: {
      source_kind: sourceKind,
      source_ref: sRef,
      file: rel,
      size: stat.size,
      modified_ms: stat.modified_ms,
      mtime_ns: stat.mtime_ns,
      ino: stat.ino,
      dev: stat.dev,
      source_text_hash: sourceTextHash,
      frontmatter: policy,
      ...(resolvedPolicy ? { policy_sources: resolvedPolicy.policySources } : {}),
      sections: catalogSections,
      claims: annotatedClaims,
      tags: annotatedTags,
      links: annotatedLinks,
      estimated_tokens: estimatedTokens
    },
    rawSections,
    warnings: [...(resolvedPolicy?.policyErrors || []), ...(docWarnings || []).map(w => `${rel}: ${w}`)]
  }
}
