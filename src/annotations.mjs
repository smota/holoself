export const VISIBILITIES = ['private', 'linked-projects', 'professional', 'public-voice', 'public-safe']
export const DISCLOSURES = ['internal-only', 'review-required', 'publish-approved']
export const SENSITIVITIES = [
  'public',
  'none',
  'personal',
  'application-private',
  'compensation-confidential',
  'third-party-personal',
  'recruiter-confidential',
  'employer-confidential',
  'restricted'
]
export const DOCUMENT_ROLES = ['policy', 'evidence', 'content']
export const CONFIDENCE_SUGGESTIONS = ['confirmed', 'mixed', 'unverified']
export const CONFIDENTIAL_SENSITIVITIES = [
  'application-private',
  'compensation-confidential',
  'third-party-personal',
  'recruiter-confidential',
  'employer-confidential',
  'restricted'
]
export const KNOWLEDGE_STATUSES = Object.freeze(['current', 'historical', 'superseded'])
export const TEMPORAL_SCOPES = Object.freeze(['current', 'time-bounded', 'historical', 'timeless'])

// The effective publication state the runtime uses. Legacy `public_safe: false` overrides `disclosure`; legacy
// `public_safe: true` and `visibility: public-safe` supply `publish-approved` only when `disclosure` is missing.
export function effectiveDisclosure(metadata = {}) {
  if (metadata.public_safe === false) return 'review-required'
  if (DISCLOSURES.includes(metadata.disclosure)) return metadata.disclosure
  if (metadata.public_safe === true || (metadata.visibility || 'linked-projects') === 'public-safe') return 'publish-approved'
  return 'internal-only'
}
// The only publication decision: an effective `publish-approved` disclosure and a non-confidential sensitivity.
export function publicationAllowed(metadata = {}) {
  return effectiveDisclosure(metadata) === 'publish-approved' && !CONFIDENTIAL_SENSITIVITIES.includes(metadata.sensitivity || '')
}
// Alias of publicationAllowed (docs/decisions/privacy-fields-and-legacy-mount.md): one answer to "may this be published?".
export function derivedPublicSafe(metadata = {}) {
  return publicationAllowed(metadata || {})
}

export function annotationSchema(lenses = []) {
  return {
    schema_version: 1,
    fields: {
      access_lenses: { type: 'multi-select', required: true, options: lenses.map(lens => ({ value: lens.id, label: lens.title || lens.id, source: 'self' })) },
      disclosure: { type: 'single-select', required: true, options: DISCLOSURES },
      sensitivity: { type: 'single-select', required: true, options: SENSITIVITIES },
      document_role: { type: 'single-select', required: true, options: DOCUMENT_ROLES },
      confidence: { type: 'editable-select', required: false, suggestions: CONFIDENCE_SUGGESTIONS },
      visibility: { type: 'single-select', required: false, legacy: true, options: VISIBILITIES },
      public_safe: { type: 'derived-override', required: false, legacy: true },
      field_access: { type: 'field-rules', required: false, rule_fields: ['access_lenses', 'disclosure'], disclosure_options: DISCLOSURES },
      knowledge_status: { type: 'single-select', required: false, options: KNOWLEDGE_STATUSES },
      temporal_scope: { type: 'single-select', required: false, options: TEMPORAL_SCOPES },
      valid_from: { type: 'date', required: false },
      valid_until: { type: 'date', required: false },
      review_after: { type: 'date', required: false },
      supersedes: { type: 'multi-text', required: false },
      superseded_by: { type: 'text', required: false }
    }
  }
}

function fieldAccessAnnotationErrors(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['field_access must map field or heading names to rules.']
  const errors = []
  for (const [name, rule] of Object.entries(value)) {
    if (name !== name.trim()) errors.push(`field_access name ${JSON.stringify(name)} must not start or end with spaces.`)
    if (!rule || typeof rule !== 'object' || Array.isArray(rule) || Object.keys(rule).some(key => key !== 'access_lenses' && key !== 'disclosure'))
      errors.push(`field_access ${name} accepts only access_lenses and disclosure.`)
    else if (rule.access_lenses !== undefined && (!Array.isArray(rule.access_lenses) || !rule.access_lenses.length))
      errors.push(`field_access ${name} access_lenses must list at least one lens.`)
    else if (rule.disclosure !== undefined && !DISCLOSURES.includes(rule.disclosure)) errors.push(`field_access ${name} disclosure must be one of: ${DISCLOSURES.join(', ')}.`)
  }
  return errors
}
export function validateAnnotationMetadata(metadata = {}, knownLenses = [], { allowLegacy = false } = {}) {
  const errors = [],
    warnings = [],
    known = new Set(knownLenses),
    modern = Array.isArray(metadata.access_lenses)
  if (!modern || !metadata.access_lenses.length) {
    if (allowLegacy && !modern && metadata.visibility) warnings.push('Legacy visibility metadata preserved; add Access Lenses to use modern policy controls.')
    else errors.push('Select at least one Access Lens; unscoped knowledge fails closed.')
  } else if (metadata.access_lenses.some(value => typeof value !== 'string' || !value.trim())) errors.push('Access Lenses must contain non-empty identifiers.')
  const unknown = (metadata.access_lenses || []).filter(value => known.size && !known.has(value))
  if (unknown.length) warnings.push(`Unknown or legacy Access Lenses preserved: ${unknown.join(', ')}.`)
  for (const [field, values] of [
    ['disclosure', DISCLOSURES],
    ['sensitivity', SENSITIVITIES],
    ['document_role', DOCUMENT_ROLES]
  ])
    if (modern && !values.includes(metadata[field])) errors.push(`${field} must be one of: ${values.join(', ')}.`)
    else if (metadata[field] !== undefined && !values.includes(metadata[field])) errors.push(`${field} must be one of: ${values.join(', ')}.`)
  if (metadata.visibility !== undefined && !VISIBILITIES.includes(metadata.visibility)) errors.push(`visibility must be one of: ${VISIBILITIES.join(', ')}.`)
  if (metadata.field_access !== undefined) errors.push(...fieldAccessAnnotationErrors(metadata.field_access))
  if (metadata.confidence !== undefined && (typeof metadata.confidence !== 'string' || !metadata.confidence.trim()))
    errors.push('confidence must be non-empty when set.')
  if (metadata.public_safe !== undefined && metadata.public_safe !== null && typeof metadata.public_safe !== 'boolean')
    errors.push('public_safe must be true, false, or derived.')
  if (metadata.disclosure === 'publish-approved' && CONFIDENTIAL_SENSITIVITIES.includes(metadata.sensitivity))
    errors.push(`publish-approved cannot be combined with ${metadata.sensitivity}.`)
  if (metadata.public_safe === true && metadata.disclosure === 'internal-only') errors.push('public_safe: true cannot be combined with internal-only.')
  if (metadata.visibility === 'public-safe' && metadata.disclosure === 'internal-only')
    errors.push('public-safe visibility cannot be combined with internal-only.')
  if (metadata.visibility === 'public-safe' && (metadata.access_lenses || []).includes('private'))
    warnings.push('public-safe visibility includes private Access Lens; review intended audience.')
  if (metadata.public_safe !== undefined && metadata.public_safe !== null && metadata.public_safe !== derivedPublicSafe(metadata))
    warnings.push(`Legacy public_safe override differs from derived value (${derivedPublicSafe(metadata)}).`)
  if (metadata.document_role === 'evidence' && !metadata.confidence) warnings.push('Evidence should declare confidence.')
  for (const [field, values] of [
    ['knowledge_status', KNOWLEDGE_STATUSES],
    ['temporal_scope', TEMPORAL_SCOPES]
  ])
    if (metadata[field] !== undefined && !values.includes(metadata[field])) errors.push(`${field} must be one of: ${values.join(', ')}.`)
  for (const field of ['valid_from', 'valid_until', 'review_after'])
    if (
      metadata[field] !== undefined &&
      metadata[field] !== null &&
      (!/^(?:\d{4}-\d{2}-\d{2}|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))$/.test(metadata[field]) ||
        Number.isNaN(Date.parse(metadata[field].includes('T') ? metadata[field] : metadata[field] + 'T00:00:00.000Z')))
    )
      errors.push(`${field} must be an ISO date.`)
  if (metadata.valid_from && metadata.valid_until) {
    const from = Date.parse(metadata.valid_from.includes('T') ? metadata.valid_from : metadata.valid_from + 'T00:00:00.000Z')
    const until = Date.parse(metadata.valid_until.includes('T') ? metadata.valid_until : metadata.valid_until + 'T23:59:59.999Z')
    if (from > until) errors.push('valid_from must not be after valid_until.')
  }
  if (metadata.knowledge_status === 'superseded' && !metadata.superseded_by) errors.push('superseded knowledge must name superseded_by.')
  if (metadata.superseded_by !== undefined && metadata.superseded_by !== null && (typeof metadata.superseded_by !== 'string' || !metadata.superseded_by.trim()))
    errors.push('superseded_by must be a non-empty string.')
  if (metadata.supersedes !== undefined && (!Array.isArray(metadata.supersedes) || metadata.supersedes.some(x => typeof x !== 'string' || !x.trim())))
    errors.push('supersedes must be a string array.')
  return { valid: errors.length === 0, errors, warnings, derived_public_safe: derivedPublicSafe(metadata), unknown_lenses: unknown }
}
