import { GATE_CLASSES, satisfyGate } from './gate.mjs'
import { recordDigest } from './record-digest.mjs'

// Work altitudes. A goal is the outcome a person accepts. A capability is the specification agents
// write under an accepted goal. A spec is the implementation unit, and phases 0-8 run inside it.
// These rules decide whether a record may open. A source stores records. It does not decide them.
// Person gates stay in posture.mjs and gate.mjs; this module adds none.

export const WORK_KINDS = Object.freeze(['goal', 'capability', 'spec'])

// A written record of a kind must carry that kind's sections. An empty body is an unwritten record.
export const KIND_SECTIONS = Object.freeze({
  goal: ['Job', 'Outcome', 'Release intent', 'Split judgment'],
  capability: ['Part', 'Depends on', 'Acceptance boundary', 'Excludes'],
  spec: ['Implementation unit', 'Acceptance'],
})

export function kindBodyErrors(kind, body = '') {
  // Prose with no kind marker is not a template. A template starts with **Kind:**.
  if (!kind || !String(body).includes('**Kind:**')) return []
  const errors = []
  for (const section of KIND_SECTIONS[kind] ?? []) {
    if (!String(body).includes(`## ${section}`)) errors.push(`missing ## ${section}`)
  }
  if (kind === 'goal' && /^## Implementation\b/m.test(body)) {
    errors.push('a goal states no implementation')
  }
  return errors
}

// A record with no kind predates the altitudes. It stays legal, and it is never read as a goal.
export const LEGACY_KIND = 'legacy'

const PARENT_KIND = Object.freeze({ goal: null, capability: 'goal', spec: 'capability' })

export function workKind(record) {
  const kind = record?.kind
  if (kind === undefined || kind === null) return LEGACY_KIND
  if (!WORK_KINDS.includes(kind)) {
    throw new Error(`Unknown work kind: ${kind}. Expected one of: ${WORK_KINDS.join(', ')}`)
  }
  return kind
}

// High-assurance is the only capability that needs a person. Every other change class does not.
export function requiresPersonReview(record) {
  return workKind(record) === 'capability' && record.changeClass === 'high-assurance'
}

// Consent is never a field on a record. It is a sealed adequacy-of-intent gate satisfied by a
// person's attestation, bound to the digest of exactly what the person agreed to.
//
// A capability's change class decides whether its specs need a review, so the class is part of
// what the person admits: the gate covers the goal subject and the class together. The goal half is
// the subject the person reads (`goalSubject`), not the medium revision: saving the answer, syncing
// the gate block, a comment, or a label moves the revision but not what the person agreed to. The
// field keeps the name `goalRevision`, the subject kind every goal gate uses. The admission
// is kept on the capability as evidence and checked again against the class stored when a spec
// opens. Editing the class afterwards breaks the binding, so a downgrade fails closed. A matching
// admission never opens a spec: only a separate review of a high-assurance capability does.
export function admissionDigest({ goalRevision, changeClass = null }) {
  return recordDigest({ goalRevision, changeClass })
}

function consentErrors(consent, subjectDigest) {
  const gate = consent?.gate
  if (!gate) return ['no sealed gate was given']
  if (gate.gateClass !== GATE_CLASSES.adequacyOfIntent) {
    return [`the gate is ${gate.gateClass}, not ${GATE_CLASSES.adequacyOfIntent}`]
  }
  if (gate.subjectDigest !== subjectDigest) return ['the gate is bound to a different subject']
  return satisfyGate(gate, consent.attestation).errors
}

function requireConsent(consent, subjectDigest, what) {
  const errors = consentErrors(consent, subjectDigest)
  if (errors.length) throw new Error(`${what}: ${errors.join('; ')}`)
}

// Returns the admission a medium must store on a new capability. Nothing else is stored as consent.
export function validateOpen({ record, parent = null, consent = null } = {}) {
  const kind = workKind(record)
  if (kind === LEGACY_KIND) return Object.freeze({ kind, parentKind: null })

  const parentKind = PARENT_KIND[kind]
  if (!parentKind && parent) throw new Error('A goal has no parent')
  if (!parentKind) return Object.freeze({ kind, parentKind })
  if (!parent) throw new Error(`A ${kind} requires a parent ${parentKind}`)
  const actual = workKind(parent)
  if (actual !== parentKind) {
    throw new Error(`A ${kind} requires a parent ${parentKind}, not a ${actual} record`)
  }

  if (kind === 'capability') {
    const goalRevision = parent.goalSubject
    if (!/^[a-f0-9]{64}$/.test(goalRevision ?? '')) {
      throw new Error(
        'A capability requires its parent goal subject; read the parent through a medium',
      )
    }
    requireConsent(
      consent,
      admissionDigest({ goalRevision, changeClass: record.changeClass }),
      'A capability requires a person to accept its parent goal at this change class',
    )
    const admission = { goalRevision, gate: consent.gate, attestation: consent.attestation }
    return Object.freeze({ kind, parentKind, admission })
  }

  const admission = parent.admission
  requireConsent(
    admission,
    admissionDigest({ goalRevision: admission?.goalRevision, changeClass: parent.changeClass }),
    'A spec requires a capability whose stored change class a person admitted',
  )
  // The stored admission lives in the record it vouches for. Whoever can edit the record can
  // replace the class and the admission together with a freshly sealed pair, and the seal still
  // matches. A matching seal only proves the record is self-consistent, so it never opens a spec.
  // No consent this module can check is a witness outside the record either, so it is not read.
  // A stored admission never opens a spec. A standard spec opens only when the person accepts
  // this capability's own revision, which changes if the class or the text is edited.
  if (!requiresPersonReview(parent)) {
    const storedGate = admission.gate?.digest
    if (!consent || consent.gate?.digest === storedGate) {
      throw new Error(
        'A standard spec does not open on a stored admission. The person accepts this capability',
      )
    }
    requireConsent(
      consent,
      parent.revision,
      'A standard spec requires the person to accept this capability',
    )
    return Object.freeze({ kind, parentKind })
  }
  // A person can only review a capability that exists, so the review gates the specs under it.
  if (consent?.gate?.digest && consent.gate.digest === admission.gate?.digest) {
    throw new Error(
      'A spec under a high-assurance capability requires its review, not its admission',
    )
  }
  requireConsent(
    consent,
    parent.goalSubject,
    'A spec under a high-assurance capability requires its review',
  )
  return Object.freeze({ kind, parentKind })
}
