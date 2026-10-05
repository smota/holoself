import { sdlcVocabulary } from '../sdlc-vocabulary.mjs'
import { validateArtifactRef } from './artifact-ref.mjs'

export const EXECUTION_RECEIPT_VERSION = 1

export function createExecutionReceipt({
  subject,
  intent,
  binding,
  status,
  startedAt,
  completedAt,
  inputRefs = [],
  outputRefs = [],
  validationRefs = [],
  requestDigest,
  planDigest,
  actual = {},
  boundaries = {},
  revision = {},
  writerLease = {},
  timing = {},
  digests = {},
  executionIntentSource = {},
  cleanup = {},
  disclosure = {},
  redaction = {},
  metadata = {},
} = {}) {
  return {
    version: EXECUTION_RECEIPT_VERSION,
    subject,
    status,
    startedAt,
    completedAt,
    provider: binding?.provider ?? null,
    executionTarget: binding?.executionTarget ?? null,
    transport: binding?.transport ?? null,
    delegationBoundary: binding?.delegationBoundary ?? null,
    collaborationMode: intent?.mode ?? null,
    degraded: binding?.degraded ?? false,
    requestDigest,
    planDigest,
    actual: {
      platform: actual.platform ?? binding?.provider ?? null,
      target: actual.target ?? binding?.executionTarget ?? null,
      transport: actual.transport ?? binding?.transport ?? null,
      model: actual.model ?? null,
    },
    boundaries,
    revision,
    writerLease,
    timing: { startedAt, completedAt, ...timing },
    digests,
    executionIntentSource,
    cleanup,
    disclosure,
    redaction,
    inputRefs,
    outputRefs,
    validationRefs,
    metadata,
  }
}

export function validateExecutionReceipt(receipt, config) {
  const errors = []
  const nonEmptyString = (value) => typeof value === 'string' && value.length > 0
  const stringArray = (value) =>
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  if (receipt?.version !== EXECUTION_RECEIPT_VERSION) errors.push('version must be 1')
  if (!nonEmptyString(receipt?.subject)) errors.push('subject is required')
  if (!['pass', 'failed', 'blocked', 'cancelled'].includes(receipt?.status)) {
    errors.push('status is invalid')
  }
  const sha256 = /^[a-f0-9]{64}$/i
  for (const field of ['requestDigest', 'planDigest']) {
    if (!sha256.test(receipt?.[field] ?? '')) errors.push(`${field} must be a sha256 digest`)
  }
  for (const field of ['platform', 'target', 'transport']) {
    if (!nonEmptyString(receipt?.actual?.[field])) errors.push(`actual.${field} is required`)
  }
  if (!Object.hasOwn(receipt?.actual ?? {}, 'model')) errors.push('actual.model is required')
  else if (receipt.actual.model !== null && typeof receipt.actual.model !== 'string')
    errors.push('actual.model must be a string or null')
  for (const field of ['requested', 'effective', 'enforced', 'observed', 'declared']) {
    const value = receipt?.boundaries?.[field]
    const nullable = ['effective', 'enforced', 'observed'].includes(field)
    if (!Object.hasOwn(receipt?.boundaries ?? {}, field))
      errors.push(`boundaries.${field} is required`)
    else if (
      (value === null && !nullable) ||
      (value !== null && !sdlcVocabulary(config).actionBoundaries.includes(value))
    ) {
      errors.push(`boundaries.${field} is not a canonical action boundary`)
    }
  }
  for (const field of ['source', 'workspaceFingerprint']) {
    const value = receipt?.revision?.[field]
    if (!Object.hasOwn(receipt?.revision ?? {}, field)) errors.push(`revision.${field} is required`)
    else if (value !== null && !nonEmptyString(value))
      errors.push(`revision.${field} must be a non-empty string or null`)
  }
  for (const field of ['id', 'owner']) {
    if (!nonEmptyString(receipt?.writerLease?.[field]))
      errors.push(`writerLease.${field} is required`)
  }
  if (!['held', 'released', 'reconciled'].includes(receipt?.writerLease?.status))
    errors.push('writerLease.status is invalid')
  for (const field of ['startedAt', 'completedAt']) {
    const value = receipt?.timing?.[field]
    if (!value || Number.isNaN(Date.parse(value)))
      errors.push(`timing.${field} must be a date-time`)
  }
  if (!Number.isInteger(receipt?.timing?.timeoutMs) || receipt.timing.timeoutMs < 0)
    errors.push('timing.timeoutMs must be a non-negative integer')
  if (typeof receipt?.timing?.cancelled !== 'boolean')
    errors.push('timing.cancelled must be boolean')
  for (const field of ['artifacts', 'changes', 'output']) {
    if (!sha256.test(receipt?.digests?.[field] ?? ''))
      errors.push(`digests.${field} must be a sha256 digest`)
  }
  if (!nonEmptyString(receipt?.executionIntentSource?.provider))
    errors.push('executionIntentSource.provider is required')
  if (!stringArray(receipt?.executionIntentSource?.declared))
    errors.push('executionIntentSource.declared must be an array of strings')
  if (!Array.isArray(receipt?.executionIntentSource?.resolutions))
    errors.push('executionIntentSource.resolutions must be an array')
  if (!['clean', 'partial', 'failed', 'not-required'].includes(receipt?.cleanup?.status))
    errors.push('cleanup.status is invalid')
  if (!stringArray(receipt?.cleanup?.actions))
    errors.push('cleanup.actions must be an array of strings')
  if (typeof receipt?.disclosure?.authorized !== 'boolean')
    errors.push('disclosure.authorized must be boolean')
  if (typeof receipt?.disclosure?.scope !== 'string') errors.push('disclosure.scope is required')
  if (typeof receipt?.redaction?.applied !== 'boolean')
    errors.push('redaction.applied must be boolean')
  if (!nonEmptyString(receipt?.redaction?.policy)) errors.push('redaction.policy is required')
  for (const field of ['inputRefs', 'outputRefs', 'validationRefs']) {
    if (!Array.isArray(receipt?.[field])) {
      errors.push(`${field} must be an array`)
      continue
    }
    for (const [index, ref] of receipt[field].entries()) {
      const result = validateArtifactRef(ref, config)
      if (!result.ok) errors.push(`${field}[${index}]: ${result.errors.join('; ')}`)
    }
  }
  return { ok: errors.length === 0, errors }
}
