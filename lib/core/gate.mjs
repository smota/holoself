import { sealDeliveryRecord, requireText, requireDigest } from './delivery-record.mjs'
import { hasCurrentDigest } from './record-digest.mjs'
import { validateReviewAttestation } from './review-attestation.mjs'
import { actionBoundaryAllows } from '../sdlc-vocabulary.mjs'
import { describeRuntimePlatform } from '../runtime-platforms.mjs'

// A gate is a demand for a human decision, bound to a subject digest. It is the single answer to
// "does a human have to act here?" — previously decided in four unrelated, contradicting places
// (a fixed phase number, a profile flag, regex over comment prose, and the one correct mechanism,
// validateActionBoundary in lib/lifecycle-contracts.mjs, which this module generalizes).
//
// The three classes are distinct because they range over DIFFERENT subjects. At intent-freeze time
// no candidateDigest exists yet, so approving an intent can never be read as consent to ship an
// artifact that has not been built — the subjectKind pinned to each class makes that structurally
// impossible rather than a convention someone can forget.
export const GATE_CLASSES = Object.freeze({
  adequacyOfIntent: 'adequacy-of-intent',
  releaseOfCandidate: 'release-of-candidate',
  agentEscalation: 'agent-escalation',
})

const GATE_CLASS_VALUES = Object.values(GATE_CLASSES)

// The only subjects a gate may ever be bound to. Notably absent: a phase number. Gates do not
// attach to pipeline position — that binding is what made long autonomous runs stop constantly
// (the human asked at phase 6 of every issue, whether or not anything happened that needed them).
const SUBJECT_KINDS = ['goalRevision', 'candidateDigest']

const ALLOWED_SUBJECT_KINDS = {
  [GATE_CLASSES.adequacyOfIntent]: ['goalRevision'],
  [GATE_CLASSES.releaseOfCandidate]: ['candidateDigest'],
  [GATE_CLASSES.agentEscalation]: ['goalRevision', 'candidateDigest'],
}

export function createGate(args = {}) {
  if ('phase' in args || 'phaseNumber' in args)
    throw new Error('Gates cannot be bound to a phase number')
  const { gateClass, subjectDigest, subjectKind, requiredRole, hints = [] } = args
  if (!GATE_CLASS_VALUES.includes(gateClass))
    throw new Error(`gateClass must be one of: ${GATE_CLASS_VALUES.join(', ')}`)
  requireDigest(subjectDigest, 'subjectDigest')
  if (!SUBJECT_KINDS.includes(subjectKind))
    throw new Error(`subjectKind must be one of: ${SUBJECT_KINDS.join(', ')}`)
  if (!ALLOWED_SUBJECT_KINDS[gateClass].includes(subjectKind))
    throw new Error(`${gateClass} cannot range over ${subjectKind}`)
  requireText(requiredRole, 'requiredRole')
  if (!Array.isArray(hints)) throw new Error('hints must be an array')
  // Hints are ADVISORY ONLY. They are validated and carried on the record purely for a human to
  // read; nothing here (or in satisfyGate) ever branches on hint.value. See satisfyGate.
  const sealedHints = hints.map((hint) => {
    requireText(hint?.id, 'hint id')
    requireText(hint?.interpretation, 'hint interpretation')
    if (!Object.hasOwn(hint ?? {}, 'value')) throw new Error('hint value is required')
    return { id: hint.id, value: hint.value, interpretation: hint.interpretation }
  })
  return sealDeliveryRecord('gate', {
    gateClass,
    subjectDigest,
    subjectKind,
    requiredRole,
    hints: sealedHints,
  })
}

// A gate opening states that a decision is owed and by whom. It carries no instruction about how
// anyone should be notified — that is an outside, pluggable concern (see lib/adapters). This event
// is sealed with the same sealDeliveryRecord used for the gate itself: no new record or digest
// format, just a distinct `type` so a subscriber can tell "a decision is owed" apart from every
// other sealed record shape.
export function createGatePendingEvent(gate, unitRef) {
  if (gate?.type !== 'gate' || gate?.version !== 1 || !SUBJECT_KINDS.includes(gate?.subjectKind))
    throw new Error('createGatePendingEvent requires a sealed gate record')
  requireText(unitRef, 'unitRef')
  return sealDeliveryRecord('gate-pending', {
    gateClass: gate.gateClass,
    subjectDigest: gate.subjectDigest,
    subjectKind: gate.subjectKind,
    requiredRole: gate.requiredRole,
    unitRef,
  })
}

// W8a — a gate is satisfied ONLY by a human's CONSENT, not by a well-formed record. Three things
// must independently hold, all decided HERE (validateReviewAttestation only ever checks that the
// record is well-shaped; it was never the place a decision got made, and it still isn't):
//   1. decision === 'agree'. `blocked` and `changes-requested` are well-formed REFUSALS — validating
//      that they are members of REVIEW_DECISIONS is not the same as validating that they mean yes.
//   2. the reviewer is human: independence === 'human-gate' AND the reviewer's platform is the
//      registered human platform (manifests/runtime-platforms.json, kind: 'human'). An agent
//      runtime can produce evidence; it can never itself satisfy a gate meant for a human.
//   3. the gate record's own seal is re-verified here, at satisfaction time — not just its shape.
//      A gate whose subjectDigest (or anything else in it) was altered after sealing, without the
//      digest being recomputed, no longer has a trustworthy subject and is refused outright, before
//      any attestation is even considered.
// reviewedDigest === subjectDigest keeps being enforced by validateReviewAttestation, exactly as
// before (D1's fourth requirement, "already enforced — keep it").
function isHumanReviewer(reviewer) {
  if (reviewer?.independence !== 'human-gate') return false
  return describeRuntimePlatform(reviewer?.platform)?.kind === 'human'
}

export function satisfyGate(gate, attestation) {
  if (gate?.type !== 'gate' || gate?.version !== 1 || !SUBJECT_KINDS.includes(gate?.subjectKind))
    throw new Error('satisfyGate requires a sealed gate record')
  if (!hasCurrentDigest(gate)) {
    return { ok: false, errors: ['gate seal is invalid: the record was altered after sealing'] }
  }
  const check = validateReviewAttestation(attestation, { expectedDigest: gate.subjectDigest })
  if (!check.ok) return { ok: false, errors: check.errors }
  const errors = []
  if (attestation.decision !== 'agree') {
    errors.push('decision does not satisfy the gate: only agree opens it')
  }
  if (!isHumanReviewer(attestation.reviewer)) {
    errors.push(
      'only a human reviewer (independence: human-gate, the registered human platform) satisfies a gate',
    )
  }
  return { ok: errors.length === 0, errors }
}

// The four derivable crossings: conditions under which the effective action boundary, budget,
// evidence, or reviewer independence require escalation to a human, independent of profile. None of
// these parameters include a profile — a caller may feed in a profile's configured maximum as
// `requestedBoundary`, but the crossing fires or not on its own terms, never suppressed merely
// because a path is not high-assurance.
export function deriveCrossings({
  effectiveBoundary = null,
  requestedBoundary = null,
  budget = null,
  observation = null,
  independence = null,
} = {}) {
  const crossings = []
  if (
    effectiveBoundary === 'external-action' ||
    (effectiveBoundary &&
      requestedBoundary &&
      !actionBoundaryAllows(requestedBoundary, effectiveBoundary))
  ) {
    crossings.push({
      kind: 'authority-escalation',
      reason: `Effective action boundary ${effectiveBoundary} widens beyond ${
        requestedBoundary ?? 'the requested boundary'
      }.`,
    })
  }
  if (budget && budget.admitted === false) {
    crossings.push({
      kind: 'budget-exhaustion',
      reason: budget.reason ?? 'Operational budget does not admit the next attempt.',
    })
  }
  if (
    observation &&
    Number.isFinite(observation.ageMs) &&
    Number.isFinite(observation.maxAgeMs) &&
    observation.ageMs > observation.maxAgeMs
  ) {
    crossings.push({
      kind: 'evidence-expiry',
      reason: 'Observation is older than its declared maximum age.',
    })
  }
  if (independence && independence.selfReview === true && independence.allowsSelfReview === false) {
    crossings.push({
      kind: 'independence',
      reason: 'Self-review occurred on a path that forbids it.',
    })
  }
  return crossings
}

// Today drift detection is directionless: it only knows "changed". This gives it a direction.
// Removing scope is cheap (`narrowing`); weakening acceptance criteria must face the full adequacy
// gate again, because otherwise an agent that cannot satisfy a contract could simply propose an
// easier one. When the comparison cannot be made confidently, fail safe to `weakening`.
export function resolveRefreeze({ previousCriteria, nextCriteria } = {}) {
  if (!Array.isArray(previousCriteria) || !Array.isArray(nextCriteria)) return 'weakening'
  const nextById = new Map()
  for (const criterion of nextCriteria) {
    if (!criterion || typeof criterion.id !== 'string' || !criterion.id) return 'weakening'
    nextById.set(criterion.id, criterion)
  }
  for (const previous of previousCriteria) {
    if (!previous || typeof previous.id !== 'string' || !previous.id) return 'weakening'
    const next = nextById.get(previous.id)
    // A previously-required criterion dropped outright is weakening — never treated as scope
    // reduction, however cheap that would be.
    if (!next) return 'weakening'
    if (previous.definitionDigest !== next.definitionDigest) return 'weakening'
    const previousAssertions = Array.isArray(previous.assertions) ? previous.assertions : []
    const nextAssertions = Array.isArray(next.assertions) ? next.assertions : []
    if (previousAssertions.some((assertion) => !nextAssertions.includes(assertion)))
      return 'weakening'
    if (previous.requireImmutable === true && next.requireImmutable !== true) return 'weakening'
    if (Number.isFinite(previous.maxAgeMs)) {
      if (!Number.isFinite(next.maxAgeMs) || next.maxAgeMs > previous.maxAgeMs) return 'weakening'
    }
    const previousOrigins = Array.isArray(previous.allowedOrigins) ? previous.allowedOrigins : null
    const nextOrigins = Array.isArray(next.allowedOrigins) ? next.allowedOrigins : null
    if (previousOrigins === null && nextOrigins === null) {
      // Both implicit (policy default applies on both sides) — nothing to compare.
    } else if (previousOrigins === null || nextOrigins === null) {
      // An explicit/implicit boundary was crossed; we cannot confirm the implicit side is not
      // broader than the explicit one. Cannot tell -> fail safe.
      return 'weakening'
    } else if (nextOrigins.some((origin) => !previousOrigins.includes(origin))) {
      return 'weakening'
    }
  }
  return 'narrowing'
}
