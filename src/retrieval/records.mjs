// Candidate records for context retrieval: catalog candidates, assertions and de-duplication.
import { join } from 'node:path'
import { relevanceScore } from '../context-selection.mjs'
import { DEFAULT_PROJECT_EXCLUDES } from '../link/config.mjs'
import { canonicalSpaceId } from '../link/registry.mjs'
import { matchesAny } from '../markdown/files.mjs'
import { allowed, allowedDocument, claimStatusIncluded, filterClaimVisibility, filterFieldVisibility } from '../policy/access.mjs'
import { catalogElementVisible } from '../policy/sub-document-rules.mjs'
import { SECRET_RE } from '../policy/secrets.mjs'

export function catalogCandidateRecords(
  catalog,
  root,
  kind,
  lens,
  task,
  adapter,
  registry,
  resolution,
  options = {},
  identityKind = 'owner:direct',
  subject = null
) {
  const records = []
  const restrictions = []
  let unauthorizedSourcesOmitted = 0
  const unmigratedWarnings = []
  if (!catalog || !Array.isArray(catalog.sources)) return { records, restrictions, unauthorized_sources_omitted: 0, warnings: [] }
  const sources = catalog.sources
  const temporal = options?.temporal || 'current'
  const subj = subject || { kind: identityKind, accessible_spaces: identityKind === 'owner:direct' ? ['self', 'contrib'] : [] }
  const spaceId = catalog.space_id || (kind === 'self' ? 'self' : kind === 'contrib' ? 'contrib' : canonicalSpaceId(root))
  for (const s of sources) {
    const rel = s.file
    const absPath = join(root, rel)
    const metadata = s.frontmatter

    if (identityKind === 'owner:direct' && metadata) {
      const vis = metadata.visibility || 'private'
      const accLenses = Array.isArray(metadata.access_lenses) ? metadata.access_lenses : []
      if (vis === 'private' && accLenses.some(l => l !== 'private') && !metadata.read_scope) {
        unmigratedWarnings.push(
          `Document '${rel}' has 'visibility: private' with public access_lenses; under v2 policy, read_scope defaults to 'restricted'. ` +
            `Access under non-private lenses is denied. Run 'holoself migrate policy' to resolve.`
        )
      }
    }

    const decision = allowedDocument(metadata, lens, adapter, task, resolution, subj, spaceId)
    const isPeer = Boolean(subj?.space_id && spaceId !== subj.space_id && kind !== 'self')
    if (!decision.allowed) {
      if (isPeer && identityKind === 'client:linked') {
        unauthorizedSourcesOmitted++
      } else {
        restrictions.push({ source: rel, reason: decision.reason })
      }
      continue
    }

    const dummyRes = []
    const visibleSections = (s.sections || [])
      .filter(sec => catalogElementVisible(sec, lens, adapter) && claimStatusIncluded(sec.claim_status, temporal))
      .map(sec => {
        const filtered = filterFieldVisibility(
          filterClaimVisibility(sec.snippet || '', lens, rel, dummyRes, resolution, identityKind, adapter),
          metadata,
          lens,
          rel,
          dummyRes,
          resolution,
          identityKind,
          adapter
        )
        return {
          ...sec,
          snippet: filtered
        }
      })
    for (const r of dummyRes) {
      if (isPeer && identityKind === 'client:linked') continue
      if (!restrictions.some(x => x.source === r.source && x.reason === r.reason)) {
        restrictions.push(r)
      }
    }
    const visibleClaims = (s.claims || []).filter(c => catalogElementVisible(c, lens, adapter) && claimStatusIncluded(c.claim_status, temporal))
    const visibleTags = (s.tags || []).filter(t => catalogElementVisible(t, lens, adapter))
    const visibleLinks = (s.links || []).filter(l => catalogElementVisible(l, lens, adapter))
    const searchText = [
      rel,
      ...visibleSections.map(sec => `${sec.heading} ${sec.snippet}`),
      ...visibleClaims.map(c => c.text),
      ...visibleTags.map(t => t.value)
    ].join(' ')

    const record = {
      kind,
      path: rel,
      absolute_path: absPath,
      space_id: spaceId,
      access_lenses: metadata.access_lenses,
      disclosure: metadata.disclosure,
      document_role: metadata.document_role,
      publication_allowed: metadata.publication_allowed,
      visibility: metadata.visibility,
      public_safe: metadata.public_safe,
      sensitivity: metadata.sensitivity,
      confidence: metadata.confidence,
      freshness: new Date(s.modified_ms).toISOString(),
      source_hash: s.source_text_hash,
      source_ref: s.source_ref,
      source_id: s.source_ref.source_id,
      sections: visibleSections,
      claims: visibleClaims,
      tags: visibleTags,
      links: visibleLinks,
      search_text: searchText,
      content: '',
      metadata,
      ...(kind === 'self' && s.policy_sources ? { policy_sources: s.policy_sources } : {}),
      estimated_tokens: s.estimated_tokens,
      knowledge_status: metadata.knowledge_status || 'current',
      temporal_scope: metadata.temporal_scope || 'timeless'
    }

    record.task_relevance = relevanceScore(record, task)

    if (kind === 'contrib' && metadata.contrib) {
      record.contrib = metadata.contrib
    }

    records.push(record)
  }

  return { records, restrictions, unauthorized_sources_omitted: unauthorizedSourcesOmitted, warnings: unmigratedWarnings }
}
export function resolvedContextAssertions(records, lens, task, adapter, link, resolution = null, subject = null) {
  const errors = [],
    projectPaths = records.filter(record => record.kind === 'project').map(record => record.path)
  for (const record of records) {
    if (!allowed(record.metadata, lens, adapter, task, resolution, subject, record.space_id || record.kind))
      errors.push(`${record.kind}:${record.path}: policy rejected after resolution`)
    if (SECRET_RE.test(record.content)) errors.push(`${record.kind}:${record.path}: secret-like content survived filtering`)
  }
  for (const path of projectPaths) {
    if (!matchesAny(path, link?.project_context?.include || ['**/*.md'])) errors.push(`project:${path}: outside include policy`)
    if (matchesAny(path, link?.project_context?.exclude || DEFAULT_PROJECT_EXCLUDES)) errors.push(`project:${path}: matched exclude policy`)
  }
  if (errors.length) {
    const error = new Error(`context leakage validation failed: ${errors.length} source(s) rejected`)
    error.code = 'CONTEXT_LEAKAGE_DETECTED'
    error.details = errors
    throw error
  }
  return {
    status: 'passed',
    checks: ['privacy-policy-reapplied', 'secret-pattern-scan', 'project-include-exclude-reapplied'],
    selected_sources: records.length
  }
}
export function deduplicateCandidates(cands, localSpaceId) {
  const seen = new Map()
  const scorePrec = c => {
    if (c.space_id === localSpaceId) return 1
    if (c.space_id === 'self') return 2
    return 3
  }
  for (const c of cands) {
    const key = c.source_text_hash || c.source_hash || c.source_ref?.revision
    if (!key) continue
    const existing = seen.get(key)
    if (!existing) {
      seen.set(key, c)
    } else {
      const pExist = scorePrec(existing)
      const pCurr = scorePrec(c)
      if (pCurr < pExist || (pCurr === pExist && (c.space_id || '') < (existing.space_id || ''))) {
        seen.set(key, c)
      }
    }
  }
  const kept = new Set(seen.values())
  return cands.filter(c => {
    const key = c.source_text_hash || c.source_hash || c.source_ref?.revision
    if (!key) return true
    return kept.has(c)
  })
}
export function buildReceiptPolicySources(records) {
  const out = {}
  for (const r of records) {
    if (r.kind === 'self' && r.policy_sources && typeof r.policy_sources === 'object') {
      out[r.path] = { ...r.policy_sources }
    }
  }
  return out
}
