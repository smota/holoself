// Catalog schema validation: the allowed shape of catalog.json partitions and their source records.
import { DISCLOSURES, VISIBILITIES } from '../annotations.mjs'

export const CATALOG_SCHEMA_VERSION = 2
export const HASH_RE = /^[0-9a-f]{64}$/
export const SOURCE_ID_RE = /^hs-[0-9a-f]{20}$/
export const NUM_RE = /^[0-9]+$/
export const ALLOWED_CATALOG_KEYS = new Set([
  'schema_version',
  'space_id',
  'lens_registry_hash',
  'project_context_hash',
  'generated_at',
  'sources',
  'ignored_sources'
])
export const ALLOWED_SOURCE_KEYS = new Set([
  'source_kind',
  'source_ref',
  'file',
  'size',
  'modified_ms',
  'mtime_ns',
  'ino',
  'dev',
  'source_text_hash',
  'frontmatter',
  'sections',
  'claims',
  'tags',
  'links',
  'estimated_tokens'
])
export const ALLOWED_SOURCE_REF_KEYS = new Set(['space_id', 'source_id', 'revision', 'section_id'])
export const ALLOWED_SECTION_KEYS = new Set(['section_id', 'heading', 'visibility', 'disclosure', 'claim', 'claim_status', 'snippet'])
export const ALLOWED_CLAIM_KEYS = new Set(['text', 'visibility', 'claim_status'])
export const ALLOWED_TAG_KEYS = new Set(['value', 'visibility'])
export const ALLOWED_LINK_KEYS = new Set(['value', 'visibility'])
export const ALLOWED_FRONTMATTER_KEYS = new Set([
  'access_lenses',
  'disclosure',
  'sensitivity',
  'document_role',
  'publication_allowed',
  'task_include',
  'task_exclude',
  'visibility',
  'read_scope',
  'public_safe',
  'confidence',
  'exclude_lenses',
  'field_visibility',
  'knowledge_status',
  'temporal_scope',
  'valid_from',
  'valid_until',
  'valid_until_epoch_ms',
  'review_after',
  'supersedes',
  'superseded_by',
  'contrib'
])
export const ALLOWED_IGNORED_KEYS = new Set(['file', 'size', 'modified_ms', 'mtime_ns', 'ino', 'dev', 'reason'])
export function validateCatalogSchema(catalog) {
  const errors = []
  if (!catalog || typeof catalog !== 'object') return { valid: false, errors: ['catalog must be an object'] }
  for (const k of Object.keys(catalog)) {
    if (!ALLOWED_CATALOG_KEYS.has(k)) errors.push(`unknown property: ${k}`)
  }
  if (catalog.schema_version !== CATALOG_SCHEMA_VERSION) errors.push(`schema_version must be ${CATALOG_SCHEMA_VERSION}`)
  if (typeof catalog.space_id !== 'string' || !catalog.space_id) errors.push('space_id must be a non-empty string')
  if (typeof catalog.lens_registry_hash !== 'string' || !HASH_RE.test(catalog.lens_registry_hash))
    errors.push('lens_registry_hash must be a 64-character hex sha256 string')

  if (!Object.hasOwn(catalog, 'project_context_hash')) {
    errors.push('project_context_hash is required')
  } else if (catalog.space_id === 'self' || catalog.space_id === 'contrib') {
    if (catalog.project_context_hash !== null) errors.push(`project_context_hash must be null for ${catalog.space_id} space`)
  } else {
    if (typeof catalog.project_context_hash !== 'string' || !HASH_RE.test(catalog.project_context_hash)) {
      errors.push('project_context_hash must be a 64-character hex sha256 string for project space')
    }
  }

  if (typeof catalog.generated_at !== 'string' || Number.isNaN(Date.parse(catalog.generated_at))) errors.push('generated_at must be an ISO date-time string')
  if (!Array.isArray(catalog.sources)) {
    errors.push('sources must be an array')
  } else {
    for (let i = 0; i < catalog.sources.length; i++) {
      const s = catalog.sources[i]
      const prefix = `sources[${i}]`
      if (!s || typeof s !== 'object') {
        errors.push(`${prefix} must be an object`)
        continue
      }
      for (const k of Object.keys(s)) {
        if (!ALLOWED_SOURCE_KEYS.has(k)) errors.push(`${prefix} unknown property: ${k}`)
      }
      if (!['canonical', 'project', 'contrib'].includes(s.source_kind)) errors.push(`${prefix}.source_kind must be one of: canonical, project, contrib`)
      if (!s.source_ref || typeof s.source_ref !== 'object') {
        errors.push(`${prefix}.source_ref must be an object`)
      } else {
        for (const k of Object.keys(s.source_ref)) {
          if (!ALLOWED_SOURCE_REF_KEYS.has(k)) errors.push(`${prefix}.source_ref unknown property: ${k}`)
        }
        if (typeof s.source_ref.space_id !== 'string') errors.push(`${prefix}.source_ref.space_id must be a string`)
        if (typeof s.source_ref.source_id !== 'string' || !SOURCE_ID_RE.test(s.source_ref.source_id))
          errors.push(`${prefix}.source_ref.source_id must match hs-[0-9a-f]{20}`)
        if (typeof s.source_ref.revision !== 'string' || !HASH_RE.test(s.source_ref.revision))
          errors.push(`${prefix}.source_ref.revision must be a 64-hex sha256`)
        if (s.source_ref.section_id !== null && typeof s.source_ref.section_id !== 'string')
          errors.push(`${prefix}.source_ref.section_id must be string or null`)
      }
      if (typeof s.file !== 'string') errors.push(`${prefix}.file must be a string`)
      if (typeof s.size !== 'number' || s.size < 0) errors.push(`${prefix}.size must be a non-negative integer`)
      if (typeof s.modified_ms !== 'number') errors.push(`${prefix}.modified_ms must be a number`)
      if (typeof s.mtime_ns !== 'string' || !NUM_RE.test(s.mtime_ns)) errors.push(`${prefix}.mtime_ns must match ^[0-9]+$`)
      if (typeof s.ino !== 'string' || !NUM_RE.test(s.ino)) errors.push(`${prefix}.ino must match ^[0-9]+$`)
      if (typeof s.dev !== 'string' || !NUM_RE.test(s.dev)) errors.push(`${prefix}.dev must match ^[0-9]+$`)
      if (typeof s.source_text_hash !== 'string' || !HASH_RE.test(s.source_text_hash)) errors.push(`${prefix}.source_text_hash must be a 64-hex sha256`)
      if (!s.frontmatter || typeof s.frontmatter !== 'object') {
        errors.push(`${prefix}.frontmatter must be an object`)
      } else {
        for (const k of Object.keys(s.frontmatter)) {
          if (!ALLOWED_FRONTMATTER_KEYS.has(k)) errors.push(`${prefix}.frontmatter unknown property: ${k}`)
        }
        const reqFm = [
          'access_lenses',
          'disclosure',
          'sensitivity',
          'document_role',
          'publication_allowed',
          'task_include',
          'task_exclude',
          'visibility',
          'read_scope',
          'field_visibility',
          'knowledge_status',
          'temporal_scope'
        ]
        for (const k of reqFm) {
          if (!Object.hasOwn(s.frontmatter, k)) errors.push(`${prefix}.frontmatter.${k} is required`)
        }
        if (s.frontmatter.read_scope !== undefined && !['shared', 'local', 'restricted'].includes(s.frontmatter.read_scope)) {
          errors.push(`${prefix}.frontmatter.read_scope must be one of: shared, local, restricted`)
        }
      }
      if (!Array.isArray(s.sections)) {
        errors.push(`${prefix}.sections must be an array`)
      } else {
        for (let j = 0; j < s.sections.length; j++) {
          const sec = s.sections[j]
          const sp = `${prefix}.sections[${j}]`
          if (!sec || typeof sec !== 'object') {
            errors.push(`${sp} must be an object`)
            continue
          }
          for (const k of Object.keys(sec)) {
            if (!ALLOWED_SECTION_KEYS.has(k)) errors.push(`${sp} unknown property: ${k}`)
          }
          if (typeof sec.section_id !== 'string') errors.push(`${sp}.section_id must be a string`)
          if (typeof sec.heading !== 'string') errors.push(`${sp}.heading must be a string`)
          if (typeof sec.visibility !== 'string' || !VISIBILITIES.includes(sec.visibility))
            errors.push(`${sp}.visibility must be one of: ${VISIBILITIES.join(', ')}`)
          if (typeof sec.disclosure !== 'string' || !DISCLOSURES.includes(sec.disclosure))
            errors.push(`${sp}.disclosure must be one of: ${DISCLOSURES.join(', ')}`)
          if (typeof sec.claim !== 'boolean') errors.push(`${sp}.claim must be a boolean`)
          if (sec.claim_status !== undefined && !['superseded', 'historical'].includes(sec.claim_status))
            errors.push(`${sp}.claim_status must be one of: superseded, historical`)
          if (typeof sec.snippet !== 'string') errors.push(`${sp}.snippet must be a string`)
        }
      }
      if (!Array.isArray(s.claims)) {
        errors.push(`${prefix}.claims must be an array`)
      } else {
        for (let j = 0; j < s.claims.length; j++) {
          const cl = s.claims[j]
          const cp = `${prefix}.claims[${j}]`
          if (!cl || typeof cl !== 'object') {
            errors.push(`${cp} must be an object`)
            continue
          }
          for (const k of Object.keys(cl)) {
            if (!ALLOWED_CLAIM_KEYS.has(k)) errors.push(`${cp} unknown property: ${k}`)
          }
          if (typeof cl.text !== 'string') errors.push(`${cp}.text must be a string`)
          if (cl.claim_status !== undefined && !['superseded', 'historical'].includes(cl.claim_status))
            errors.push(`${cp}.claim_status must be one of: superseded, historical`)
          if (typeof cl.visibility !== 'string' || !VISIBILITIES.includes(cl.visibility))
            errors.push(`${cp}.visibility must be one of: ${VISIBILITIES.join(', ')}`)
        }
      }
      if (!Array.isArray(s.tags)) {
        errors.push(`${prefix}.tags must be an array`)
      } else {
        for (let j = 0; j < s.tags.length; j++) {
          const tg = s.tags[j]
          const tp = `${prefix}.tags[${j}]`
          if (!tg || typeof tg !== 'object') {
            errors.push(`${tp} must be an object`)
            continue
          }
          for (const k of Object.keys(tg)) {
            if (!ALLOWED_TAG_KEYS.has(k)) errors.push(`${tp} unknown property: ${k}`)
          }
          if (typeof tg.value !== 'string') errors.push(`${tp}.value must be a string`)
          if (typeof tg.visibility !== 'string' || !VISIBILITIES.includes(tg.visibility))
            errors.push(`${tp}.visibility must be one of: ${VISIBILITIES.join(', ')}`)
        }
      }
      if (!Array.isArray(s.links)) {
        errors.push(`${prefix}.links must be an array`)
      } else {
        for (let j = 0; j < s.links.length; j++) {
          const lk = s.links[j]
          const lp = `${prefix}.links[${j}]`
          if (!lk || typeof lk !== 'object') {
            errors.push(`${lp} must be an object`)
            continue
          }
          for (const k of Object.keys(lk)) {
            if (!ALLOWED_LINK_KEYS.has(k)) errors.push(`${lp} unknown property: ${k}`)
          }
          if (typeof lk.value !== 'string') errors.push(`${lp}.value must be a string`)
          if (typeof lk.visibility !== 'string' || !VISIBILITIES.includes(lk.visibility))
            errors.push(`${lp}.visibility must be one of: ${VISIBILITIES.join(', ')}`)
        }
      }
      if (typeof s.estimated_tokens !== 'number' || s.estimated_tokens < 0) errors.push(`${prefix}.estimated_tokens must be a non-negative integer`)
    }
  }

  if (catalog.ignored_sources !== undefined) {
    if (!Array.isArray(catalog.ignored_sources)) {
      errors.push('ignored_sources must be an array')
    } else {
      for (let i = 0; i < catalog.ignored_sources.length; i++) {
        const item = catalog.ignored_sources[i]
        const prefix = `ignored_sources[${i}]`
        if (!item || typeof item !== 'object') {
          errors.push(`${prefix} must be an object`)
          continue
        }
        for (const k of Object.keys(item)) {
          if (!ALLOWED_IGNORED_KEYS.has(k)) errors.push(`${prefix} unknown property: ${k}`)
        }
        if (typeof item.file !== 'string') errors.push(`${prefix}.file must be a string`)
        if (typeof item.size !== 'number' || item.size < 0) errors.push(`${prefix}.size must be non-negative integer`)
        if (typeof item.modified_ms !== 'number') errors.push(`${prefix}.modified_ms must be a number`)
        if (typeof item.mtime_ns !== 'string' || !NUM_RE.test(item.mtime_ns)) errors.push(`${prefix}.mtime_ns must match ^[0-9]+$`)
        if (typeof item.ino !== 'string' || !NUM_RE.test(item.ino)) errors.push(`${prefix}.ino must match ^[0-9]+$`)
        if (typeof item.dev !== 'string' || !NUM_RE.test(item.dev)) errors.push(`${prefix}.dev must match ^[0-9]+$`)
        if (typeof item.reason !== 'string') errors.push(`${prefix}.reason must be a string`)
      }
    }
  }

  return { valid: errors.length === 0, errors }
}
