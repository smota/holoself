import { createHash } from 'node:crypto'

export const REVIEW_ATTESTATION_VERSION = 1
export const REVIEW_DECISIONS = ['agree', 'changes-requested', 'blocked']

export function computeReviewDigest(entries) {
  const hash = createHash('sha256')
  for (const entry of [...entries].sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(entry.path.replaceAll('\\', '/'))
    hash.update('\0')
    hash.update(entry.content)
    hash.update('\0')
  }
  return hash.digest('hex')
}

export function createReviewAttestation({
  subject,
  reviewedDigest,
  reviewer,
  decision,
  timestamp,
  findings = [],
} = {}) {
  return {
    version: REVIEW_ATTESTATION_VERSION,
    subject,
    reviewedDigest,
    reviewer,
    decision,
    timestamp,
    findings,
  }
}

export function validateReviewAttestation(attestation, { expectedDigest } = {}) {
  const errors = []
  if (attestation?.version !== REVIEW_ATTESTATION_VERSION) errors.push('version must be 1')
  if (!attestation?.subject) errors.push('subject is required')
  if (!/^[a-f0-9]{64}$/.test(attestation?.reviewedDigest ?? '')) {
    errors.push('reviewedDigest must be a SHA-256 digest')
  }
  if (expectedDigest && attestation?.reviewedDigest !== expectedDigest) {
    errors.push('reviewedDigest is stale')
  }
  if (!REVIEW_DECISIONS.includes(attestation?.decision)) errors.push('decision is invalid')
  if (!attestation?.reviewer?.platform) errors.push('reviewer.platform is required')
  if (!attestation?.reviewer?.executor) errors.push('reviewer.executor is required')
  if (!['independent', 'self-review', 'human-gate'].includes(attestation?.reviewer?.independence)) {
    errors.push('reviewer.independence is invalid')
  }
  if (!Array.isArray(attestation?.findings)) errors.push('findings must be an array')
  // An attestation without a real instant cannot be reasoned about for freshness, and a
  // decorative timestamp field is worse than none: it reads as evidence and carries nothing.
  if (
    typeof attestation?.timestamp !== 'string' ||
    !Number.isFinite(Date.parse(attestation.timestamp))
  ) {
    errors.push('timestamp must be an ISO-8601 instant')
  }
  return { ok: errors.length === 0, errors }
}
