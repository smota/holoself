// Context delivery: re-reads each selected source, reconciles it with its catalog revision and re-applies policy.
import { VISIBILITIES } from '../annotations.mjs'
import { canonicalSort, readSourceWithStat, slugHeading } from '../catalog.mjs'
import { privacySections } from '../catalog/source.mjs'
import { canonicalSpaceId } from '../link/registry.mjs'
import { claims, links, tags } from '../markdown/text.mjs'
import { allowed, filterClaimVisibility, filterFieldVisibility, privacyMetadata, visibleUnderBehavior } from '../policy/access.mjs'
import { frontmatter } from '../policy/privacy-fields.mjs'
import { hash } from '../shared/fs.mjs'

// Returns the deliver callback used by selection, the restrictions it records and its reconcile-read count.
export function createRecordDelivery(o, { project, identity, registry, lens, resolution, subject, adapter }) {
  const deliveryRestrictions = []
  let reconcileReads = 0
  function deliverRecord(cand) {
    let read = readSourceWithStat(cand.absolute_path)
    if (!read) {
      cand.delivery_reason = 'source unavailable at delivery'
      return null
    }
    let rawHash = hash(read.text)
    let reconciled = false
    if (rawHash !== cand.source_ref.revision) {
      reconcileReads++
      reconciled = true
      const nextRead = readSourceWithStat(cand.absolute_path)
      if (!nextRead) {
        cand.delivery_reason = 'source unavailable at delivery'
        return null
      }
      const nextHash = hash(nextRead.text)
      if (nextHash !== rawHash) {
        cand.delivery_reason = 'source concurrently modified; omitted fail-closed'
        return null
      }
      read = nextRead
      rawHash = nextHash
    }
    let parsed
    try {
      parsed = frontmatter(read.text, { tolerant: cand.kind === 'project' || cand.kind === 'contrib', registry })
    } catch {
      cand.delivery_reason = 'invalid canonical privacy metadata; excluded fail-closed'
      return null
    }
    const metadata =
      cand.kind === 'contrib' && (!parsed.metadata || !Object.keys(parsed.metadata).length)
        ? cand.metadata
        : { ...(cand.kind === 'contrib' ? cand.metadata : {}), ...parsed.metadata }
    const { body } = parsed
    const candSpaceId = cand.space_id || (cand.kind === 'project' ? canonicalSpaceId(project) : cand.kind)
    if (!allowed(metadata, lens, adapter, o.task, resolution, subject, candSpaceId)) {
      cand.delivery_reason = 'restricted by policy'
      return null
    }
    const behaviorLens = lens

    const filteredBody = filterFieldVisibility(
      filterClaimVisibility(body, lens, cand.path, deliveryRestrictions, resolution, identity.kind),
      metadata,
      lens,
      cand.path,
      deliveryRestrictions,
      resolution,
      identity.kind
    )
    const content = filteredBody.trim()

    let freshness = cand.freshness
    let estimatedTokens = cand.estimated_tokens
    let sectionsList = cand.sections
    let claimsList = cand.claims
    let tagsList = cand.tags
    let linksList = cand.links
    let searchText = cand.search_text
    if (reconciled && read.stat) {
      freshness = new Date(read.stat.modified_ms).toISOString()
      estimatedTokens = Math.ceil(read.text.length / 4)
      const safeMeta = privacyMetadata(metadata, registry)
      const rawSecs = privacySections(body, safeMeta)
      const seenSlugs = new Map()
      const catSecs = rawSecs.map(sec => {
        const baseSlug = slugHeading(sec.heading)
        const count = (seenSlugs.get(baseSlug) || 0) + 1
        seenSlugs.set(baseSlug, count)
        const section_id = count === 1 ? baseSlug : `${baseSlug}-${count}`
        const snippet = (sec.content.length > 360 ? sec.content.slice(0, 357) + '...' : sec.content).trim()
        return { section_id, heading: sec.heading, visibility: sec.visibility, disclosure: sec.disclosure, claim: Boolean(sec.claim), snippet }
      })
      sectionsList = catSecs
        .filter(sec => {
          const secVis = VISIBILITIES.includes(sec.visibility) ? sec.visibility : 'private'
          return visibleUnderBehavior(secVis, behaviorLens, adapter)
        })
        .map(sec => {
          const filtered = filterFieldVisibility(
            filterClaimVisibility(sec.snippet || '', lens, cand.path, deliveryRestrictions, resolution, identity.kind),
            metadata,
            lens,
            cand.path,
            deliveryRestrictions,
            resolution,
            identity.kind
          )
          return { ...sec, snippet: filtered }
        })
      const annotatedClaims = rawSecs.flatMap(sec => claims(sec.content).map(text => ({ text, visibility: sec.visibility })))
      const annotatedLinks = rawSecs.flatMap(sec => links(sec.content).map(value => ({ value, visibility: sec.visibility })))
      const annotatedTags = rawSecs.flatMap(sec => tags(sec.content).map(value => ({ value, visibility: sec.visibility })))
      annotatedClaims.sort((a, b) => canonicalSort(a.text, b.text))
      annotatedLinks.sort((a, b) => canonicalSort(a.value, b.value))
      annotatedTags.sort((a, b) => canonicalSort(a.value, b.value))
      claimsList = annotatedClaims.filter(c => visibleUnderBehavior(c.visibility, behaviorLens, adapter))
      tagsList = annotatedTags.filter(t => visibleUnderBehavior(t.visibility, behaviorLens, adapter))
      linksList = annotatedLinks.filter(l => visibleUnderBehavior(l.visibility, behaviorLens, adapter))
      searchText = [cand.path, ...sectionsList.map(sec => `${sec.heading} ${sec.snippet}`), ...claimsList.map(c => c.text), ...tagsList.map(t => t.value)].join(
        ' '
      )
    }

    return {
      content,
      metadata: privacyMetadata(metadata, registry),
      source_hash: rawHash,
      freshness,
      estimated_tokens: estimatedTokens,
      sections: sectionsList,
      claims: claimsList,
      tags: tagsList,
      links: linksList,
      search_text: searchText
    }
  }

  return {
    deliveryRestrictions,
    deliverRecord,
    get reconcileReads() {
      return reconcileReads
    }
  }
}
