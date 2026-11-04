// Catalog source records built from one Markdown file.
import { existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { VISIBILITIES } from '../annotations.mjs'
import { canonicalSort, readSourceWithStat, slugHeading, sourceRef } from '../catalog.mjs'
import { canonicalSpaceId } from '../link/registry.mjs'
import { claimBlockPattern, claimStatus, parseClaimAttrs } from '../markdown/claim-blocks.mjs'
import { claims, links, sections, tags } from '../markdown/text.mjs'
import { privacyMetadata, visibility } from '../policy/access.mjs'
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
  const ordinary = body.replace(claimBlockPattern(), (_, claimVisibility, rawAttrs, claimBody) => {
    const v = VISIBILITIES.includes(claimVisibility) ? claimVisibility : 'private',
      status = claimStatus(parseClaimAttrs(rawAttrs))
    for (const section of sections(claimBody))
      chunks.push({
        ...section,
        visibility: v,
        claim: true,
        disclosure: v === 'public-safe' ? 'publish-approved' : 'review-required',
        ...(status === 'current' ? {} : { claim_status: status })
      })
    return ''
  })
  for (const section of sections(ordinary)) {
    const heading = section.heading.toLowerCase(),
      fieldRule = Object.entries(policy.field_visibility || {}).find(([field]) => heading.includes(field.toLowerCase())),
      v = fieldRule?.[1] || policy.visibility
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
export function extractSectionAnnotations(rawSections) {
  const annotatedClaims = rawSections.flatMap(sec =>
    claims(sec.content).map(text => ({ text, visibility: sec.visibility, ...(sec.claim_status ? { claim_status: sec.claim_status } : {}) }))
  )
  const annotatedLinks = rawSections.flatMap(sec => links(sec.content).map(value => ({ value, visibility: sec.visibility })))
  const annotatedTags = rawSections.flatMap(sec => tags(sec.content).map(value => ({ value, visibility: sec.visibility })))
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
  if (secretFile(file, root) || SECRET_RE.test(text) || ['secret', 'credential', 'credentials'].includes(metadata.sensitivity)) {
    return { secret: true }
  }
  if (sourceKind === 'canonical') {
    const metadataErrors = canonicalPrivacyMetadataErrors(metadata, registry)
    if (metadataErrors.length) return { error: `${rel}: ${metadataErrors.join('; ')}` }
  }
  if (!VISIBILITIES.includes(visibility(metadata))) return null

  const policy = privacyMetadata(metadata, registry)
  const rawSections = privacySections(body, policy)
  const catalogSections = buildCatalogSections(rawSections)
  const { claims: annotatedClaims, links: annotatedLinks, tags: annotatedTags } = extractSectionAnnotations(rawSections)

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
      sections: catalogSections,
      claims: annotatedClaims,
      tags: annotatedTags,
      links: annotatedLinks,
      estimated_tokens: estimatedTokens
    },
    rawSections,
    warnings: (docWarnings || []).map(w => `${rel}: ${w}`)
  }
}
