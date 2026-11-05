// Context delivery: re-reads each selected source, reconciles it with its catalog revision and re-applies policy.
import { readSourceWithStat } from '../catalog.mjs'
import { buildCatalogSections, extractSectionAnnotations, privacySections } from '../catalog/source.mjs'
import { canonicalSpaceId } from '../link/registry.mjs'
import { withClaimIds, withoutClaimRuleDetails } from '../markdown/claim-blocks.mjs'
import {
  allowed,
  claimStatusIncluded,
  deliveredSection,
  filterClaimStatus,
  filterClaimVisibility,
  filterFieldVisibility,
  privacyMetadata
} from '../policy/access.mjs'
import { resolveDocumentPolicy } from '../policy/policy-defaults.mjs'
import { canonicalPrivacyMetadataErrors, frontmatter } from '../policy/privacy-fields.mjs'
import { catalogElementVisible, publicationAdapter } from '../policy/sub-document-rules.mjs'
import { hash } from '../shared/fs.mjs'

// Returns the deliver callback used by selection, the restrictions it records and its reconcile-read count.
export function createRecordDelivery(o, { project, self, identity, registry, lens, resolution, subject, adapter }) {
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
    const resolvedPolicy = cand.kind === 'self' && self ? resolveDocumentPolicy(cand.absolute_path, self, parsed.metadata, registry) : null
    if (resolvedPolicy && canonicalPrivacyMetadataErrors(resolvedPolicy.effectiveMetadata, registry).length) {
      cand.delivery_reason = 'invalid canonical privacy metadata; excluded fail-closed'
      return null
    }
    const metadata = resolvedPolicy
      ? resolvedPolicy.effectiveMetadata
      : cand.kind === 'contrib' && (!parsed.metadata || !Object.keys(parsed.metadata).length)
        ? cand.metadata
        : { ...(cand.kind === 'contrib' ? cand.metadata : {}), ...parsed.metadata }
    const { body } = parsed
    const candSpaceId = cand.space_id || (cand.kind === 'project' ? canonicalSpaceId(project) : cand.kind)
    if (!allowed(metadata, lens, adapter, o.task, resolution, subject, candSpaceId)) {
      cand.delivery_reason = 'restricted by policy'
      return null
    }
    const temporal = o.temporal || 'current'
    // Hidden and out-of-scope claim blocks are removed before ids are added, so only visible claims carry ids.
    const visibleClaims = filterClaimStatus(
      filterClaimVisibility(body, lens, cand.path, deliveryRestrictions, resolution, identity.kind, adapter, registry),
      temporal,
      cand.path,
      deliveryRestrictions,
      identity.kind,
      registry
    )
    const identified = cand.kind === 'self' ? withClaimIds(visibleClaims, cand.path, { registry }) : visibleClaims
    const filteredBody = filterFieldVisibility(
      identity.kind === 'owner:direct' && !publicationAdapter(adapter) ? identified : withoutClaimRuleDetails(identified, { registry }),
      metadata,
      lens,
      cand.path,
      deliveryRestrictions,
      resolution,
      identity.kind,
      adapter
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
      const rawSecs = privacySections(body, safeMeta, registry)
      const catSecs = buildCatalogSections(rawSecs)
      sectionsList = catSecs
        .filter(sec => catalogElementVisible(sec, lens, adapter) && claimStatusIncluded(sec.claim_status, temporal))
        .map(sec =>
          deliveredSection(sec, text =>
            filterFieldVisibility(
              filterClaimVisibility(text, lens, cand.path, deliveryRestrictions, resolution, identity.kind, adapter, registry),
              metadata,
              lens,
              cand.path,
              deliveryRestrictions,
              resolution,
              identity.kind,
              adapter
            )
          )
        )
      const { claims: annotatedClaims, links: annotatedLinks, tags: annotatedTags } = extractSectionAnnotations(rawSecs, safeMeta)
      claimsList = annotatedClaims.filter(c => catalogElementVisible(c, lens, adapter) && claimStatusIncluded(c.claim_status, temporal))
      tagsList = annotatedTags.filter(t => catalogElementVisible(t, lens, adapter))
      linksList = annotatedLinks.filter(l => catalogElementVisible(l, lens, adapter))
      searchText = [cand.path, ...sectionsList.map(sec => `${sec.heading} ${sec.snippet}`), ...claimsList.map(c => c.text), ...tagsList.map(t => t.value)].join(
        ' '
      )
    }

    return {
      content,
      metadata: privacyMetadata(metadata, registry),
      ...(resolvedPolicy ? { policy_sources: resolvedPolicy.policySources } : {}),
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
