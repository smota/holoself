import { sdlcVocabulary } from '../sdlc-vocabulary.mjs'

function report(errors = [], warnings = []) {
  return { ok: errors.length === 0, errors, warnings }
}

function requiredString(errors, value, field) {
  if (typeof value !== 'string' || !value.trim()) errors.push(`${field} is required`)
}

export function validateArtifactRef(reference = {}, config = {}) {
  const errors = []
  const warnings = []
  const vocabulary = sdlcVocabulary(config)
  requiredString(errors, reference.kind, 'kind')
  requiredString(errors, reference.system, 'system')
  requiredString(errors, reference.uri, 'uri')
  requiredString(errors, reference.authority, 'authority')
  requiredString(errors, reference.relationship, 'relationship')
  if (reference.kind && !vocabulary.artifactKinds.includes(reference.kind)) {
    errors.push(`kind must be one of: ${vocabulary.artifactKinds.join(', ')}`)
  }
  if (reference.authority && !vocabulary.sourceAuthorities.includes(reference.authority)) {
    errors.push(`authority must be one of: ${vocabulary.sourceAuthorities.join(', ')}`)
  }
  if (
    reference.relationship &&
    !vocabulary.artifactRelationships.includes(reference.relationship)
  ) {
    errors.push(`relationship must be one of: ${vocabulary.artifactRelationships.join(', ')}`)
  }
  if (!reference.revision && !reference.digest) {
    warnings.push('revision or digest should be recorded when the source supports immutable refs')
  }
  if (/^(?:data:|javascript:)/i.test(reference.uri ?? '')) {
    errors.push('uri must identify an external or repository artifact, not embedded content')
  }
  if (
    /(?:[?&](?:token|api[_-]?key|secret|password)=)|:\/\/[^/\s]+:[^/@\s]+@/i.test(
      reference.uri ?? '',
    )
  ) {
    errors.push('uri must not contain credentials or secret query parameters')
  }
  return report(errors, warnings)
}

export function validateArtifactRefs(references = [], config = {}) {
  const errors = []
  const warnings = []
  if (!Array.isArray(references)) return report(['artifact references must be an array'])
  for (const [index, reference] of references.entries()) {
    const result = validateArtifactRef(reference, config)
    errors.push(...result.errors.map((error) => `artifactRefs[${index}].${error}`))
    warnings.push(...result.warnings.map((warning) => `artifactRefs[${index}].${warning}`))
  }
  const authoritativeByKind = new Map()
  for (const reference of references.filter((item) => item.authority === 'authoritative')) {
    const key = `${reference.kind}:${reference.scope ?? 'default'}`
    authoritativeByKind.set(key, (authoritativeByKind.get(key) ?? 0) + 1)
  }
  for (const [key, count] of authoritativeByKind) {
    if (count > 1) errors.push(`multiple authoritative artifact references for ${key}`)
  }
  return report(errors, warnings)
}
