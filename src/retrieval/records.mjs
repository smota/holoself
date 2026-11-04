// Candidate records for context retrieval: catalog candidates, assertions and de-duplication.
import { readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { VISIBILITIES } from '../annotations.mjs'
import { canonicalSort } from '../catalog.mjs'
import { relevanceScore } from '../context-selection.mjs'
import { DEFAULT_PROJECT_EXCLUDES } from '../link/config.mjs'
import { canonicalSpaceId } from '../link/registry.mjs'
import { canonicalFiles, matchesAny, projectMarkdownFiles } from '../markdown/files.mjs'
import { relevance } from '../markdown/text.mjs'
import { allowed, allowedDocument, filterClaimVisibility, filterFieldVisibility, privacyMetadata, visibility, visibleUnderBehavior } from '../policy/access.mjs'
import { canonicalPrivacyMetadataErrors, frontmatter } from '../policy/privacy-fields.mjs'
import { SECRET_RE, secretFile } from '../policy/secrets.mjs'
import { hash, slash } from '../shared/fs.mjs'

export function sourceRecords(
  root,
  kind,
  lens,
  task,
  adapter,
  link = null,
  registry = null,
  resolution = null,
  selectionOptions = {},
  identityKind = 'owner:direct',
  subject = null
) {
  const records = []
  const restrictions = [],
    warnings = []
  let files
  if (kind === 'self')
    files = canonicalFiles(root, { includeHistory: selectionOptions.includeHistory || (selectionOptions.temporal && selectionOptions.temporal !== 'current') })
  else files = projectMarkdownFiles(root, link)
  const subj = subject || { kind: identityKind, accessible_spaces: identityKind === 'owner:direct' ? ['self', 'contrib'] : [] }
  for (const path of files) {
    const text = readFileSync(path, 'utf8'),
      rel = slash(relative(root, path))
    let parsed
    try {
      parsed = frontmatter(text, { tolerant: kind === 'project', registry })
    } catch (error) {
      restrictions.push({ source: rel, reason: 'invalid canonical privacy metadata; excluded fail-closed' })
      warnings.push(`${rel}: ${error.message}`)
      continue
    }
    const { metadata, body, warnings: documentWarnings } = parsed
    for (const warning of documentWarnings) warnings.push(`${rel}: ${warning}`)
    if (secretFile(path, root) || SECRET_RE.test(text) || ['secret', 'credential', 'credentials'].includes(metadata.sensitivity)) {
      if (kind === 'project') restrictions.push({ source: rel, reason: 'secret-like content excluded' })
      continue
    }
    if (kind === 'self') {
      const metadataErrors = canonicalPrivacyMetadataErrors(metadata, registry)
      if (metadataErrors.length) {
        restrictions.push({ source: rel, reason: 'invalid canonical privacy metadata; excluded fail-closed' })
        warnings.push(`${rel}: ${metadataErrors.join('; ')}`)
        continue
      }
    }
    if (!VISIBILITIES.includes(visibility(metadata))) {
      restrictions.push({ source: rel, reason: `unsupported visibility: ${visibility(metadata)}` })
      continue
    }
    const docDecision = allowedDocument(
      metadata,
      lens,
      adapter,
      task,
      resolution,
      subj,
      kind === 'self' ? 'self' : kind === 'contrib' ? 'contrib' : canonicalSpaceId(root)
    )
    if (!docDecision.allowed) {
      if (
        kind === 'self' &&
        (metadata.sensitivity === 'restricted' || secretFile(path, root) || (docDecision.phase === 1 && identityKind === 'client:linked'))
      ) {
        if (identityKind === 'owner:direct') restrictions.push({ source: rel, reason: docDecision.reason })
      } else {
        restrictions.push({ source: rel, reason: docDecision.reason })
      }
      continue
    }
    const safeMetadata = privacyMetadata(metadata, registry),
      behaviorLens = lens
    const filteredBody = filterFieldVisibility(
      filterClaimVisibility(body, lens, rel, restrictions, resolution, identityKind),
      metadata,
      lens,
      rel,
      restrictions,
      resolution,
      identityKind
    )
    const score = relevance(`${rel}\n${filteredBody}`, task)
    const content = filteredBody.trim()
    records.push({
      kind,
      path: rel,
      absolute_path: path,
      access_lenses: safeMetadata.access_lenses,
      disclosure: safeMetadata.disclosure,
      document_role: safeMetadata.document_role,
      publication_allowed: safeMetadata.publication_allowed,
      visibility: safeMetadata.visibility,
      public_safe: safeMetadata.public_safe,
      sensitivity: safeMetadata.sensitivity,
      confidence: safeMetadata.confidence,
      freshness: new Date(statSync(path).mtimeMs).toISOString(),
      source_hash: hash(text),
      task_relevance: score,
      content,
      metadata: safeMetadata
    })
  }
  if (task) {
    records.sort((a, b) => b.task_relevance - a.task_relevance || canonicalSort(a.path, b.path))
    if (kind === 'project')
      for (let i = records.length - 1; i >= 0; i--)
        if (records[i].task_relevance === 0 && records[i].document_role !== 'policy') {
          restrictions.push({ source: records[i].path, reason: `no relevance match for task ${task}` })
          records.splice(i, 1)
        }
  }
  return { records, restrictions, warnings }
}
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
  const behaviorLens = lens
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
      .filter(sec => {
        const secVis = VISIBILITIES.includes(sec.visibility) ? sec.visibility : 'private'
        return visibleUnderBehavior(secVis, behaviorLens, adapter)
      })
      .map(sec => {
        const filtered = filterFieldVisibility(
          filterClaimVisibility(sec.snippet || '', lens, rel, dummyRes, resolution, identityKind),
          metadata,
          lens,
          rel,
          dummyRes,
          resolution,
          identityKind
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
    const visibleClaims = (s.claims || []).filter(c => visibleUnderBehavior(c.visibility, behaviorLens, adapter))
    const visibleTags = (s.tags || []).filter(t => visibleUnderBehavior(t.visibility, behaviorLens, adapter))
    const visibleLinks = (s.links || []).filter(l => visibleUnderBehavior(l.visibility, behaviorLens, adapter))
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
export function getEligibleFederatedSpaces() {
  return []
}
