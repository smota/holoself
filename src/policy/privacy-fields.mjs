// Privacy frontmatter fields: validation, conservative salvage and restriction.
import { DISCLOSURES, DOCUMENT_ROLES, KNOWLEDGE_STATUSES, SENSITIVITIES, TEMPORAL_SCOPES, VISIBILITIES } from '../annotations.mjs'
import { lensIdStructurallyValid } from '../lenses.mjs'
import { parseScalar, parseYaml } from '../shared/yaml.mjs'
import { fieldAccessValid } from './sub-document-rules.mjs'

export const PRIVACY_FIELDS = new Set([
  'access_lenses',
  'disclosure',
  'sensitivity',
  'document_role',
  'task_include',
  'task_exclude',
  'visibility',
  'read_scope',
  'public_safe',
  'confidence',
  'exclude_lenses',
  'field_visibility',
  'field_access',
  'knowledge_status',
  'temporal_scope',
  'valid_from',
  'valid_until',
  'review_after',
  'supersedes',
  'superseded_by'
])
export function privacyValueValid(key, value, registry = null) {
  const known = item => typeof item === 'string' && (registry ? registry.byId.has(item) : lensIdStructurallyValid(item))
  if (key === 'access_lenses') return Array.isArray(value) && value.length > 0 && value.every(known) && new Set(value).size === value.length
  if (key === 'disclosure') return typeof value === 'string' && DISCLOSURES.includes(value)
  if (key === 'sensitivity') return typeof value === 'string' && SENSITIVITIES.includes(value)
  if (key === 'document_role') return typeof value === 'string' && DOCUMENT_ROLES.includes(value)
  if (key === 'task_include' || key === 'task_exclude')
    return (
      Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string' && Boolean(item.trim())) && new Set(value).size === value.length
    )
  if (key === 'visibility') return typeof value === 'string' && VISIBILITIES.includes(value)
  if (key === 'read_scope') return typeof value === 'string' && ['shared', 'local', 'restricted'].includes(value)
  if (key === 'public_safe') return typeof value === 'boolean'
  if (key === 'confidence') return typeof value === 'string' && Boolean(value.trim())
  if (key === 'exclude_lenses') return Array.isArray(value) && value.every(known)
  if (key === 'field_visibility')
    return (
      value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(item => typeof item === 'string' && VISIBILITIES.includes(item))
    )
  if (key === 'field_access') return fieldAccessValid(value, registry)
  if (key === 'knowledge_status') return typeof value === 'string' && KNOWLEDGE_STATUSES.includes(value)
  if (key === 'temporal_scope') return typeof value === 'string' && TEMPORAL_SCOPES.includes(value)
  if (['valid_from', 'valid_until', 'review_after'].includes(key))
    return (
      typeof value === 'string' &&
      /^(?:\d{4}-\d{2}-\d{2}|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))$/.test(value) &&
      !Number.isNaN(Date.parse(value.includes('T') ? value : value + 'T00:00:00.000Z'))
    )
  if (key === 'supersedes') return Array.isArray(value) && value.every(item => typeof item === 'string' && Boolean(item.trim()))
  if (key === 'superseded_by') return typeof value === 'string' && Boolean(value.trim())
  return true
}
export function privacyMetadataErrors(metadata, registry = null) {
  const errors = []
  for (const key of PRIVACY_FIELDS)
    if (Object.hasOwn(metadata, key) && !privacyValueValid(key, metadata[key], registry)) {
      const value = typeof metadata[key] === 'string' ? metadata[key] : JSON.stringify(metadata[key])
      errors.push(key === 'visibility' ? `invalid visibility ${value}` : `invalid ${key} value ${value}`)
    }
  return errors
}
export function canonicalPrivacyMetadataErrors(metadata, registry = null) {
  const errors = privacyMetadataErrors(metadata, registry)
  if (!Object.hasOwn(metadata, 'access_lenses') && !Object.hasOwn(metadata, 'visibility'))
    errors.push('canonical privacy metadata missing access_lenses or legacy visibility')
  if (Object.hasOwn(metadata, 'access_lenses'))
    for (const key of ['disclosure', 'sensitivity', 'document_role']) {
      if (!Object.hasOwn(metadata, key)) errors.push(`canonical metadata missing ${key}`)
      else if (!privacyValueValid(key, metadata[key], registry) && !errors.some(error => error.startsWith(`invalid ${key} `)))
        errors.push(`invalid ${key} value`)
    }
  if (metadata.visibility === 'public-safe' && metadata.public_safe === false)
    errors.push('conflicting legacy privacy metadata: visibility public-safe with public_safe false')
  if (metadata.valid_from && metadata.valid_until) {
    const from = Date.parse(metadata.valid_from.includes('T') ? metadata.valid_from : metadata.valid_from + 'T00:00:00.000Z')
    const until = Date.parse(metadata.valid_until.includes('T') ? metadata.valid_until : metadata.valid_until + 'T23:59:59.999Z')
    if (from > until) errors.push('valid_from must not be after valid_until')
  }
  if (metadata.knowledge_status === 'superseded' && !metadata.superseded_by) errors.push('superseded knowledge must name superseded_by')
  if (
    (metadata.sensitivity === 'restricted' || metadata.read_scope === 'restricted') &&
    Array.isArray(metadata.access_lenses) &&
    metadata.access_lenses.some(lens => lens !== 'private')
  )
    errors.push('restricted sensitivity or read_scope cannot grant access_lenses beyond private')
  return [...new Set(errors)]
}
export function restrictPrivacyMetadata(metadata) {
  metadata.access_lenses = ['private']
  metadata.disclosure = 'internal-only'
  metadata.document_role = 'content'
  metadata.visibility = 'private'
  metadata.read_scope = 'restricted'
  metadata.public_safe = false
  metadata.sensitivity = 'restricted'
  return metadata
}
export function salvagePrivacyFrontmatter(raw, { forcePrivate = false, registry = null } = {}) {
  const metadata = {},
    recognized = PRIVACY_FIELDS,
    seen = new Set(),
    lines = raw.split(/\r?\n/)
  let malformed = false,
    block = null
  const finishBlock = () => {
    if (block && !block.items) malformed = true
    block = null
  }
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    if (indent === 0) {
      finishBlock()
      const match = trimmed.match(/^([^:#][^:]*):\s*(.*)$/)
      if (!match) continue
      const key = match[1].trim(),
        scalar = match[2].trim()
      if (!recognized.has(key)) continue
      if (seen.has(key)) malformed = true
      seen.add(key)
      // Nested rules cannot be salvaged line by line, so a document that needs salvage and carries them fails closed.
      if (key === 'field_access') {
        malformed = true
        continue
      }
      if ((key === 'access_lenses' || key === 'exclude_lenses' || key === 'task_include' || key === 'task_exclude' || key === 'field_visibility') && !scalar) {
        metadata[key] = key === 'field_visibility' ? {} : []
        block = { key, items: 0 }
        continue
      }
      if (!scalar) {
        malformed = true
        continue
      }
      try {
        const value = parseScalar(scalar)
        if (privacyValueValid(key, value, registry)) metadata[key] = value
        else malformed = true
      } catch {
        malformed = true
      }
      continue
    }
    if (!block) continue
    if (['exclude_lenses', 'access_lenses', 'task_include', 'task_exclude'].includes(block.key)) {
      const item = trimmed.match(/^-\s+(.+)$/)
      if (!item) {
        malformed = true
        continue
      }
      try {
        const value = parseScalar(item[1]),
          valid =
            typeof value === 'string' &&
            (block.key.startsWith('task_') ? Boolean(value.trim()) : registry ? registry.byId.has(value) : lensIdStructurallyValid(value))
        if (valid) {
          metadata[block.key].push(value)
          block.items++
        } else malformed = true
      } catch {
        malformed = true
      }
    } else {
      const item = trimmed.match(/^([^:#][^:]*):\s*(.+)$/)
      if (!item) {
        malformed = true
        continue
      }
      try {
        const value = parseScalar(item[2])
        if (typeof value === 'string' && VISIBILITIES.includes(value)) {
          metadata.field_visibility[item[1].trim()] = value
          block.items++
        } else malformed = true
      } catch {
        malformed = true
      }
    }
  }
  finishBlock()
  if (forcePrivate || malformed || privacyMetadataErrors(metadata, registry).length) restrictPrivacyMetadata(metadata)
  return metadata
}
export function frontmatter(text, { tolerant = false, registry = null, validatePrivacy = true } = {}) {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return { metadata: {}, body: text, raw: '', hasFrontmatter: false, warnings: [] }
  const openLen = text.startsWith('---\r\n') ? 5 : 4
  const end = text.indexOf('\n---', 4)
  if (end < 0) {
    if (!tolerant) throw new Error('unclosed frontmatter')
    if (!validatePrivacy) return { metadata: {}, body: text, raw: '', hasFrontmatter: false, warnings: [] }
    return {
      metadata: salvagePrivacyFrontmatter(text.slice(4), { forcePrivate: true, registry }),
      body: text.slice(4),
      raw: text.slice(4),
      hasFrontmatter: true,
      warnings: ['unclosed project frontmatter restricted to private']
    }
  }
  const raw = text.slice(openLen, Math.max(openLen, end)).replace(/\r$/, ''),
    body = text.slice(end + 4).replace(/^\r?\n/, '')
  let metadata
  try {
    metadata = parseYaml(raw)
  } catch (error) {
    if (!tolerant) throw error
    if (!validatePrivacy) {
      metadata = {}
      for (const line of raw.split(/\r?\n/)) {
        const match = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/)
        if (!match) continue
        try {
          metadata[match[1]] = parseScalar(match[2])
        } catch {
          metadata[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '')
        }
      }
      return { metadata, body, raw, hasFrontmatter: true, warnings: [`unsupported frontmatter parsed conservatively: ${error.message}`] }
    }
    metadata = salvagePrivacyFrontmatter(raw, { registry })
    if (!Object.keys(metadata).length) restrictPrivacyMetadata(metadata)
    return { metadata, body, raw, hasFrontmatter: true, warnings: [`unsupported project frontmatter parsed conservatively: ${error.message}`] }
  }
  if (!validatePrivacy) {
    return { metadata: { ...metadata }, body, raw, hasFrontmatter: true, warnings: [] }
  }
  const privacyErrors = privacyMetadataErrors(metadata, registry)
  if (privacyErrors.length) {
    if (!tolerant) throw new Error(privacyErrors.join('; '))
    restrictPrivacyMetadata(metadata)
    return { metadata, body, raw, hasFrontmatter: true, warnings: [`invalid project privacy metadata restricted: ${privacyErrors.join(', ')}`] }
  }
  return { metadata, body, raw, hasFrontmatter: true, warnings: [] }
}
