import {
  sealDeliveryRecord,
  requireDeliveryRecord,
  requireText,
  requireDigest,
  requireUnique,
} from './delivery-record.mjs'

export const OBSERVATION_ORIGINS = [
  'collector-observed',
  'external-resolved',
  'agent-reported',
  'human-attested',
]
export const OBSERVATION_OUTCOMES = ['pass', 'fail', 'blocked', 'not-run', 'unknown']

export function createCandidateIdentity({ inputs, context = {} }) {
  if (
    !inputs ||
    Array.isArray(inputs) ||
    typeof inputs !== 'object' ||
    !Object.keys(inputs).length
  ) {
    throw new Error('Candidate requires explicit inputs')
  }
  for (const [path, hash] of Object.entries(inputs)) {
    requireText(path, 'input path')
    requireDigest(hash, `input ${path}`)
  }
  return sealDeliveryRecord('candidate-identity', { inputs, context })
}

export function validateObservation(observation) {
  const errors = []
  try {
    requireDeliveryRecord(observation, 'verification-observation')
    for (const field of ['id', 'invocationId', 'criterionId', 'producer'])
      requireText(observation[field], field)
    requireDigest(observation.candidateDigest, 'candidateDigest')
    requireDigest(observation.definitionDigest, 'definitionDigest')
    if (observation.executionContextDigest !== undefined)
      requireDigest(observation.executionContextDigest, 'executionContextDigest')
    if (!OBSERVATION_ORIGINS.includes(observation.origin))
      throw new Error('Invalid observation origin')
    if (!OBSERVATION_OUTCOMES.includes(observation.outcome))
      throw new Error('Invalid observation outcome')
    if (!['immutable', 'cooperative', 'unknown'].includes(observation.isolation))
      throw new Error('Invalid isolation')
    const start = Date.parse(observation.startedAt)
    const end = Date.parse(observation.completedAt)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
      throw new Error('Invalid observation interval')
    if (!Array.isArray(observation.assertions)) throw new Error('assertions must be an array')
    requireUnique(
      observation.assertions.map((item) => requireText(item.id, 'assertion id')),
      'assertion IDs',
    )
    for (const assertion of observation.assertions) {
      if (!OBSERVATION_OUTCOMES.includes(assertion.outcome))
        throw new Error('Invalid assertion outcome')
    }
  } catch (error) {
    errors.push(error.message)
  }
  return { ok: !errors.length, errors }
}

// Structural and policy verification only. Resolving the source and producer is an adapter responsibility.
export function verifyObservation({
  observation,
  candidateDigest,
  definitionDigest,
  requiredAssertions,
  allowedOrigins = ['collector-observed', 'external-resolved'],
  requireImmutable = false,
  now = new Date().toISOString(),
  maxAgeMs = null,
  sourceVerified = false,
}) {
  const errors = [...validateObservation(observation).errors]
  if (errors.length)
    return sealDeliveryRecord('verification-resolution', {
      observationDigest: observation?.digest ?? null,
      candidateDigest,
      definitionDigest,
      status: 'blocked',
      errors,
      resolvedAt: now,
    })
  requireUnique(requiredAssertions, 'requiredAssertions')
  if (!requiredAssertions.length) errors.push('At least one required assertion is necessary')
  if (!sourceVerified) errors.push('Observation source was not resolved')
  if (observation?.candidateDigest !== candidateDigest) errors.push('Candidate changed')
  if (observation?.definitionDigest !== definitionDigest) errors.push('Check definition changed')
  if (!allowedOrigins.includes(observation?.origin))
    errors.push('Observation origin does not satisfy policy')
  if (requireImmutable && observation?.isolation !== 'immutable')
    errors.push('Immutable execution required')
  if (observation?.outcome !== 'pass') errors.push('Observation did not pass')
  const results = new Map((observation?.assertions ?? []).map((item) => [item.id, item.outcome]))
  for (const id of requiredAssertions)
    if (results.get(id) !== 'pass') errors.push(`Assertion ${id} did not pass`)
  const age = Date.parse(now) - Date.parse(observation?.completedAt)
  if (!Number.isFinite(age) || age < 0 || (maxAgeMs !== null && age > maxAgeMs))
    errors.push('Observation freshness unavailable or expired')
  return sealDeliveryRecord('verification-resolution', {
    observationDigest: observation?.digest ?? null,
    candidateDigest,
    definitionDigest,
    status: errors.length ? 'blocked' : 'pass',
    errors,
    resolvedAt: now,
  })
}
