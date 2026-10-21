import { validateArtifactRef } from './artifact-ref.mjs'
import { recordDigest, hasCurrentDigest } from './record-digest.mjs'
import { computeOracleDigest } from '../verification/workspace.mjs'

export const ROLE_COLLABORATION_VERSION = 1
export const COLLABORATION_CLASSES = ['linear', 'bilateral', 'council', 'human-gated']
export const ACCEPTANCE_STATES = [
  'accepted',
  'accepted-with-conditions',
  'rework-required',
  'rejected',
]
export const CRITERION_SEVERITIES = ['blocking', 'advisory']
export const SEMANTIC_FINDING_STATUSES = ['pass', 'fail', 'observation', 'unverified']
export const DEFAULT_MAX_REWORK_ROUNDS = 2
const ORACLE_DIGEST = /^[a-f0-9]{64}$/
const BUILDER_SEATS = ['dev.build', 'dev.build-jr', 'dev.build-sr']

export function pinOracleDigest({ digest, phase = 3 } = {}) {
  if (phase !== 3) throw new Error('oracle digest is pinned in phase 3')
  if (!ORACLE_DIGEST.test(digest ?? ''))
    throw new Error('oracle digest must be a sha256 hex digest')
  return Object.freeze({
    type: 'oracle-pin',
    phase: 3,
    oracleDigest: digest,
    pinnedBefore: 'dev.build',
  })
}

export function verifyOraclePin({ pin, seat, expectedDigest } = {}) {
  if (!BUILDER_SEATS.includes(seat)) return { ok: true, errors: [] }
  if (pin?.phase === 3 && ORACLE_DIGEST.test(pin?.oracleDigest ?? '')) {
    if (expectedDigest === null) {
      return {
        ok: false,
        errors: ['oracle directory tests/oracles is missing or empty'],
      }
    }
    if (expectedDigest !== undefined && pin.oracleDigest !== expectedDigest) {
      return {
        ok: false,
        errors: [
          `oracle pin digest ${pin.oracleDigest} does not match expected digest ${expectedDigest}`,
        ],
      }
    }
    return { ok: true, errors: [] }
  }
  return {
    ok: false,
    errors: ['phase 3 must pin an oracle digest before dev.build starts'],
  }
}
export const ACCEPT_AND_REGISTER_SURFACES = ['auth', 'crypto', 'migration', 'billing']
const GITHUB_FOLLOW_UP_ISSUE =
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/\d+$/
export const UNFREEZE_RESOLUTIONS = ['re-scope', 'slice-split', 'person-waiver', 'abandonment']

export const DEFAULT_ROLE_COLLABORATION_POLICY = Object.freeze({
  sensitiveSurfaces: ['security', 'auth', 'data', 'infra', 'billing'],
  councilDomainThreshold: 3,
  bilateralDomainThreshold: 2,
  councilOnPublicContract: true,
  councilOnMigration: true,
  maxReworkRounds: DEFAULT_MAX_REWORK_ROUNDS,
  councilSeats: [
    { role: 'agentflow:architect', focus: 'architecture and system boundaries', required: true },
    { role: 'agentflow:developer', focus: 'implementation feasibility', required: true },
    { role: 'agentflow:tester', focus: 'testability and failure evidence', required: true },
    { role: 'agentflow:reviewer', focus: 'risk and maintainability', required: true },
  ],
})

function seal(type, value) {
  const record = {
    version: ROLE_COLLABORATION_VERSION,
    type,
    ...structuredClone(value),
    digest: '',
  }
  record.digest = recordDigest(record)
  return record
}

function list(value) {
  return Array.isArray(value) ? value : value ? [value] : []
}

export function validateRoleCollaborationPolicy(policy = {}) {
  const errors = []
  if (
    policy.sensitiveSurfaces !== undefined &&
    (!Array.isArray(policy.sensitiveSurfaces) ||
      policy.sensitiveSurfaces.some((item) => typeof item !== 'string' || !item))
  ) {
    errors.push('sensitiveSurfaces must be an array of non-empty strings')
  }
  for (const field of ['councilDomainThreshold', 'bilateralDomainThreshold']) {
    if (policy[field] !== undefined && (!Number.isInteger(policy[field]) || policy[field] < 1)) {
      errors.push(`${field} must be a positive integer`)
    }
  }
  if (
    policy.maxReworkRounds !== undefined &&
    (!Number.isInteger(policy.maxReworkRounds) || policy.maxReworkRounds < 1)
  ) {
    errors.push('maxReworkRounds must be a positive integer')
  }
  for (const field of ['councilOnPublicContract', 'councilOnMigration']) {
    if (policy[field] !== undefined && typeof policy[field] !== 'boolean') {
      errors.push(`${field} must be boolean`)
    }
  }
  if (policy.councilSeats !== undefined) {
    if (!Array.isArray(policy.councilSeats) || policy.councilSeats.length === 0) {
      errors.push('councilSeats must be a non-empty array')
    } else {
      for (const [index, seat] of policy.councilSeats.entries()) {
        if (!seat?.role || !seat?.focus || typeof seat?.required !== 'boolean') {
          errors.push(`councilSeats[${index}] must define role, focus, and required`)
        }
      }
    }
  }
  return { ok: errors.length === 0, errors }
}

function assertRoleCollaborationPolicy(policy) {
  const result = validateRoleCollaborationPolicy(policy)
  if (!result.ok) throw new Error(`invalid role collaboration policy: ${result.errors.join('; ')}`)
}

function validateSealed(record, type) {
  const errors = []
  if (record?.version !== ROLE_COLLABORATION_VERSION) errors.push('version must be 1')
  if (record?.type !== type) errors.push(`type must be ${type}`)
  if (!hasCurrentDigest(record)) {
    errors.push('digest is missing or stale')
  }
  return errors
}

function validateRefs(refs, field, config, errors) {
  if (!Array.isArray(refs)) {
    errors.push(`${field} must be an array`)
    return
  }
  for (const [index, ref] of refs.entries()) {
    const result = validateArtifactRef(ref, config)
    if (!result.ok) errors.push(`${field}[${index}]: ${result.errors.join('; ')}`)
  }
}

export function classifyRoleCollaboration({
  profile = 'standard',
  risk = 'medium',
  uncertainty = 'medium',
  changeSurface = [],
  domains = [],
  publicContract = false,
  migration = false,
  reversible = true,
  evidenceComplete = true,
  policy = {},
} = {}) {
  assertRoleCollaborationPolicy(policy)
  const surfaces = list(changeSurface)
  const sensitiveSurfaces = new Set([
    ...DEFAULT_ROLE_COLLABORATION_POLICY.sensitiveSurfaces,
    ...(policy.sensitiveSurfaces ?? []),
  ])
  const triggers = []
  if (profile === 'high-assurance') triggers.push('high-assurance-profile')
  if (surfaces.some((item) => sensitiveSurfaces.has(item))) triggers.push('sensitive-surface')
  if (!reversible) triggers.push('irreversible-change')
  if (triggers.length) return { class: 'human-gated', triggers }

  if (publicContract && (policy.councilOnPublicContract ?? true)) triggers.push('public-contract')
  if (migration && (policy.councilOnMigration ?? true)) triggers.push('migration')
  if (
    list(domains).length >=
    (policy.councilDomainThreshold ?? DEFAULT_ROLE_COLLABORATION_POLICY.councilDomainThreshold)
  ) {
    triggers.push('cross-domain')
  }
  if (risk === 'high') triggers.push('high-risk')
  if (uncertainty === 'high') triggers.push('high-uncertainty')
  if (triggers.length) return { class: 'council', triggers }

  if (risk === 'medium') triggers.push('medium-risk')
  if (uncertainty === 'medium') triggers.push('medium-uncertainty')
  if (!evidenceComplete) triggers.push('incomplete-evidence')
  if (
    list(domains).length >=
    (policy.bilateralDomainThreshold ?? DEFAULT_ROLE_COLLABORATION_POLICY.bilateralDomainThreshold)
  ) {
    triggers.push('multi-domain')
  }
  if (triggers.length) return { class: 'bilateral', triggers }
  return { class: 'linear', triggers: ['bounded-change'] }
}

export function selectCouncilSeats({
  ownerRole,
  changeSurface = [],
  publicContract = false,
  policy = {},
} = {}) {
  assertRoleCollaborationPolicy(policy)
  const seats = new Map()
  const add = (role, focus, required = true) => {
    if (role !== ownerRole) seats.set(role, { role, focus, required })
  }
  for (const seat of policy.councilSeats ?? DEFAULT_ROLE_COLLABORATION_POLICY.councilSeats) {
    add(seat.role, seat.focus, seat.required ?? true)
  }
  if (publicContract) add('agentflow:analyst', 'requirements and contract semantics')
  if (list(changeSurface).includes('docs')) {
    add('agentflow:technical-writer', 'documentation and onboarding impact', false)
  }
  return [...seats.values()]
}

export function createAcceptanceContract({
  id,
  subject,
  ownerRole,
  deliveryRole,
  collaborationClass = 'bilateral',
  candidateDigest,
  criteria = [],
  councilPolicy = { required: false, seats: [], decisionOwner: ownerRole },
  controls = ['authority-may-only-narrow'],
} = {}) {
  return seal('acceptance-contract', {
    id,
    subject,
    ownerRole,
    deliveryRole,
    collaborationClass,
    candidateDigest,
    criteria,
    councilPolicy,
    controls,
  })
}

export function validateAcceptanceContract(contract) {
  const errors = validateSealed(contract, 'acceptance-contract')
  for (const field of ['id', 'subject', 'ownerRole', 'deliveryRole', 'candidateDigest']) {
    if (typeof contract?.[field] !== 'string' || !contract[field])
      errors.push(`${field} is required`)
  }
  if (!COLLABORATION_CLASSES.includes(contract?.collaborationClass)) {
    errors.push('collaborationClass is invalid')
  }
  if (!Array.isArray(contract?.criteria) || !contract.criteria.length) {
    errors.push('criteria must be a non-empty array')
  }
  const ids = new Set()
  for (const [index, criterion] of (contract?.criteria ?? []).entries()) {
    if (!criterion?.id || ids.has(criterion.id)) errors.push(`criteria[${index}].id must be unique`)
    ids.add(criterion?.id)
    if (!['deterministic', 'semantic'].includes(criterion?.verification)) {
      errors.push(`criteria[${index}].verification is invalid`)
    }
    if (typeof criterion?.required !== 'boolean')
      errors.push(`criteria[${index}].required must be boolean`)
    if (criterion?.severity !== undefined && !CRITERION_SEVERITIES.includes(criterion.severity)) {
      errors.push(`criteria[${index}].severity is invalid`)
    }
    if (!criterion?.description) errors.push(`criteria[${index}].description is required`)
  }
  const councilRequired = ['council', 'human-gated'].includes(contract?.collaborationClass)
  if (councilRequired && !contract?.councilPolicy?.required) {
    errors.push('councilPolicy.required must be true for council and human-gated work')
  }
  if (contract?.councilPolicy?.required) {
    errors.push(
      ...validateRoleCollaborationPolicy({ councilSeats: contract.councilPolicy.seats }).errors,
    )
    if ((contract.councilPolicy.seats ?? []).some((seat) => seat.role === contract.ownerRole)) {
      errors.push('the accountable owner cannot occupy an advisory council seat')
    }
  }
  if (contract?.councilPolicy?.decisionOwner !== contract?.ownerRole) {
    errors.push('council decisionOwner must be the handover owner')
  }
  return { ok: errors.length === 0, errors }
}

export function createDeliveryReceipt({
  id,
  handoffDigest,
  contractDigest,
  producerRole,
  status = 'submitted',
  candidateDigest,
  criteriaResults = [],
  evidenceRefs = [],
  deviations = [],
  executionReceiptDigest = null,
  provenance,
} = {}) {
  return seal('delivery-receipt', {
    id,
    handoffDigest,
    contractDigest,
    producerRole,
    status,
    candidateDigest,
    criteriaResults,
    evidenceRefs,
    deviations,
    executionReceiptDigest,
    provenance,
  })
}

export function validateDeliveryReceipt(receipt, config) {
  const errors = validateSealed(receipt, 'delivery-receipt')
  for (const field of [
    'id',
    'handoffDigest',
    'contractDigest',
    'producerRole',
    'candidateDigest',
  ]) {
    if (typeof receipt?.[field] !== 'string' || !receipt[field]) errors.push(`${field} is required`)
  }
  if (!['submitted', 'blocked'].includes(receipt?.status)) errors.push('status is invalid')
  if (!Array.isArray(receipt?.criteriaResults)) errors.push('criteriaResults must be an array')
  const criterionIds = new Set()
  for (const [index, result] of (receipt?.criteriaResults ?? []).entries()) {
    if (!result?.criterionId) errors.push(`criteriaResults[${index}].criterionId is required`)
    if (criterionIds.has(result?.criterionId))
      errors.push('criteriaResults must have unique criterionIds')
    criterionIds.add(result?.criterionId)
    if (!['pass', 'fail', 'not-applicable'].includes(result?.status)) {
      errors.push(`criteriaResults[${index}].status is invalid`)
    }
    validateRefs(
      result?.evidenceRefs ?? [],
      `criteriaResults[${index}].evidenceRefs`,
      config,
      errors,
    )
  }
  validateRefs(receipt?.evidenceRefs, 'evidenceRefs', config, errors)
  if (!receipt?.provenance || typeof receipt.provenance !== 'object')
    errors.push('provenance is required')
  return { ok: errors.length === 0, errors }
}

export function createCouncilRequest({
  id,
  subject,
  ownerRole,
  question,
  evidenceDigest,
  seats = [],
  decisionPolicy = 'owner-decides-objections-resolved',
} = {}) {
  return seal('council-request', {
    id,
    subject,
    ownerRole,
    question,
    evidenceDigest,
    seats,
    decisionPolicy,
  })
}

export function createCouncilAdvice({
  id,
  requestDigest,
  role,
  position,
  evidenceRefs = [],
  objections = [],
  confidence = 'medium',
  outsideScope = [],
} = {}) {
  return seal('council-advice', {
    id,
    requestDigest,
    role,
    position,
    evidenceRefs,
    objections,
    confidence,
    outsideScope,
  })
}

export function createCouncilSynthesis({
  id,
  requestDigest,
  ownerRole,
  adviceDigests = [],
  decision,
  objectionDispositions = [],
} = {}) {
  const unresolvedBlocking = objectionDispositions.filter(
    (item) =>
      item.blocking &&
      !['accepted', 'rejected-with-reason', 'deferred-with-owner'].includes(item.disposition),
  )
  return seal('council-synthesis', {
    id,
    requestDigest,
    ownerRole,
    adviceDigests,
    decision,
    objectionDispositions,
    status: unresolvedBlocking.length ? 'blocked' : 'complete',
  })
}

export function validateCouncilRecord(record, config) {
  const errors = validateSealed(record, record?.type)
  if (!record?.id) errors.push('id is required')
  if (!['council-request', 'council-advice', 'council-synthesis'].includes(record?.type)) {
    errors.push('type is not a council record')
  }
  if (record?.type === 'council-request') {
    if (!record.ownerRole || !record.question || !record.evidenceDigest)
      errors.push('request is incomplete')
    if (!Array.isArray(record.seats) || !record.seats.length) errors.push('seats must be non-empty')
    const seats = validateRoleCollaborationPolicy({ councilSeats: record.seats })
    errors.push(...seats.errors)
    if (new Set((record.seats ?? []).map((seat) => seat.role)).size !== record.seats?.length) {
      errors.push('council seats must have unique roles')
    }
  }
  if (record?.type === 'council-advice') {
    if (!record.requestDigest || !record.role || !record.position)
      errors.push('advice is incomplete')
    if (!['low', 'medium', 'high'].includes(record.confidence)) errors.push('confidence is invalid')
    validateRefs(record.evidenceRefs, 'evidenceRefs', config, errors)
    if (!Array.isArray(record.objections)) errors.push('objections must be an array')
    for (const objection of record.objections ?? []) {
      if (!objection.id || !objection.description || typeof objection.blocking !== 'boolean') {
        errors.push('each objection requires id, description, and blocking')
      }
    }
  }
  if (record?.type === 'council-synthesis') {
    if (!record.requestDigest || !record.ownerRole || !record.decision)
      errors.push('synthesis is incomplete')
    if (!['complete', 'blocked'].includes(record.status)) errors.push('synthesis status is invalid')
  }
  return { ok: errors.length === 0, errors }
}

export function verifyCouncil({
  request,
  advice = [],
  synthesis,
  contract,
  delivery,
  config,
} = {}) {
  const errors = []
  if (!validateCouncilRecord(request, config).ok) errors.push('council request is invalid')
  if (!validateCouncilRecord(synthesis, config).ok) errors.push('council synthesis is invalid')
  if (request?.ownerRole !== contract?.ownerRole || synthesis?.ownerRole !== contract?.ownerRole) {
    errors.push('council owner must be the handover owner')
  }
  if (request?.subject !== contract?.subject || request?.evidenceDigest !== delivery?.digest) {
    errors.push('council request must bind the current subject and delivery')
  }
  if (synthesis?.requestDigest !== request?.digest)
    errors.push('synthesis request binding is stale')
  if (synthesis?.status !== 'complete') errors.push('council synthesis is not complete')
  const requestedSeats = new Map((request?.seats ?? []).map((seat) => [seat.role, seat]))
  for (const seat of contract?.councilPolicy?.seats ?? []) {
    if (seat.required && requestedSeats.get(seat.role)?.required !== true) {
      errors.push(`required contract seat is missing: ${seat.role}`)
    }
  }
  const adviceByRole = new Map()
  const dispositions = synthesis?.objectionDispositions ?? []
  for (const item of advice) {
    if (!validateCouncilRecord(item, config).ok) errors.push('council advice is invalid')
    if (item.requestDigest !== request?.digest) errors.push('advice request binding is stale')
    if (!requestedSeats.has(item.role) || item.role === contract?.ownerRole) {
      errors.push(`unrequested council role: ${item.role}`)
    }
    if (adviceByRole.has(item.role)) errors.push(`duplicate council advice: ${item.role}`)
    adviceByRole.set(item.role, item)
    for (const objection of item.objections ?? []) {
      if (!objection.blocking) continue
      const matches = dispositions.filter(
        (entry) => entry.adviceDigest === item.digest && entry.objectionId === objection.id,
      )
      const disposition = matches[0]
      if (
        matches.length !== 1 ||
        !['accepted', 'rejected-with-reason'].includes(disposition?.disposition) ||
        !disposition?.reason
      ) {
        errors.push(`unresolved blocking objection: ${item.role}/${objection.id}`)
      }
    }
  }
  for (const seat of request?.seats ?? []) {
    if (seat.required && !adviceByRole.has(seat.role))
      errors.push(`missing council advice: ${seat.role}`)
  }
  const providedDigests = advice.map((item) => item.digest).sort()
  const recordedDigests = [...(synthesis?.adviceDigests ?? [])].sort()
  if (JSON.stringify(providedDigests) !== JSON.stringify(recordedDigests)) {
    errors.push('synthesis must bind exactly the supplied advice records')
  }
  return { ok: errors.length === 0, errors }
}

export function verifyRoleDelivery({
  handoff,
  contract,
  delivery,
  councilRequest = null,
  councilAdvice = [],
  councilSynthesis = null,
  config,
} = {}) {
  const checks = []
  const add = (id, pass, reason) => checks.push({ id, status: pass ? 'pass' : 'fail', reason })
  add(
    'handoff-valid',
    hasCurrentDigest(handoff) && handoff?.state === 'issued',
    'handoff must be current, immutable, and issued',
  )
  add(
    'handoff-contract',
    handoff?.acceptanceContract?.digest === contract?.digest &&
      handoff?.subject === contract?.subject &&
      handoff?.fromRole === contract?.ownerRole &&
      handoff?.toRole === contract?.deliveryRole,
    'handoff must bind the acceptance contract and role ownership',
  )
  add(
    'contract-valid',
    validateAcceptanceContract(contract).ok,
    'acceptance contract must be valid',
  )
  add(
    'delivery-valid',
    validateDeliveryReceipt(delivery, config).ok && delivery?.status === 'submitted',
    'delivery receipt must be valid',
  )
  add(
    'handoff-binding',
    delivery?.handoffDigest === handoff?.digest,
    'delivery must bind the handoff',
  )
  add(
    'contract-binding',
    delivery?.contractDigest === contract?.digest,
    'delivery must bind the contract',
  )
  add(
    'role-binding',
    delivery?.producerRole === contract?.deliveryRole,
    'producer must match deliveryRole',
  )
  add(
    'candidate-binding',
    delivery?.candidateDigest === contract?.candidateDigest,
    'candidate digest must match',
  )

  const results = new Map((delivery?.criteriaResults ?? []).map((item) => [item.criterionId, item]))
  for (const criterion of contract?.criteria ?? []) {
    if (!criterion.required || criterion.verification !== 'deterministic') continue
    if (criterion.severity === 'advisory') continue
    const result = results.get(criterion.id)
    add(
      `criterion:${criterion.id}`,
      result?.status === 'pass' && (result.evidenceRefs?.length ?? 0) > 0,
      'required deterministic criterion must pass with evidence',
    )
  }
  const councilRequired = contract?.councilPolicy?.required
  const council = councilRequired
    ? verifyCouncil({
        request: councilRequest,
        advice: councilAdvice,
        synthesis: councilSynthesis,
        contract,
        delivery,
        config,
      })
    : { ok: true, errors: [] }
  add(
    'council',
    council.ok,
    council.errors.join('; ') || 'required council evidence is complete and current',
  )
  const deterministicPass = checks.every((item) => item.status === 'pass')
  const semanticCriteria = (contract?.criteria ?? []).filter(
    (item) => item.required && item.verification === 'semantic',
  )
  const blockingSemanticCriteria = semanticCriteria.filter((item) => item.severity !== 'advisory')
  const advisorySemanticCriteria = semanticCriteria.filter((item) => item.severity === 'advisory')
  return seal('delivery-verification', {
    handoffDigest: handoff?.digest ?? null,
    contractDigest: contract?.digest ?? null,
    deliveryDigest: delivery?.digest ?? null,
    ownerRole: contract?.ownerRole ?? null,
    candidateDigest: delivery?.candidateDigest ?? null,
    humanApprovalRequired: contract?.collaborationClass === 'human-gated',
    councilSynthesisDigest: councilRequired ? (councilSynthesis?.digest ?? null) : null,
    status: deterministicPass
      ? semanticCriteria.length
        ? 'semantic-review-required'
        : 'pass'
      : 'fail',
    checks,
    semanticCriteria: blockingSemanticCriteria.map((item) => item.id),
    advisorySemanticCriteria: advisorySemanticCriteria.map((item) => item.id),
  })
}

export function createAcceptanceDecision({
  id,
  handoff,
  contract = handoff?.acceptanceContract,
  delivery,
  councilRequest = null,
  councilAdvice = [],
  councilSynthesis = null,
  handoffDigest,
  contractDigest,
  deliveryDigest,
  decidedByRole,
  state,
  deterministicReport,
  semanticFindings = [],
  councilSynthesisDigest = null,
  conditions = [],
  humanApproval = null,
  provenance,
} = {}) {
  if (!handoff || !contract || !delivery) {
    throw new Error('acceptance decisions require the source handoff, contract, and delivery')
  }
  const verifiedReport = verifyRoleDelivery({
    handoff,
    contract,
    delivery,
    councilRequest,
    councilAdvice,
    councilSynthesis,
  })
  if (
    deterministicReport &&
    (!hasCurrentDigest(deterministicReport) || deterministicReport.digest !== verifiedReport.digest)
  ) {
    throw new Error('deterministic report does not match recomputed source evidence')
  }
  const decision = seal('acceptance-decision', {
    id,
    handoffDigest: handoffDigest ?? handoff.digest,
    contractDigest: contractDigest ?? contract.digest,
    deliveryDigest: deliveryDigest ?? delivery.digest,
    decidedByRole,
    state,
    deterministicReport: verifiedReport,
    semanticFindings,
    councilSynthesisDigest: councilSynthesisDigest ?? verifiedReport.councilSynthesisDigest,
    conditions,
    humanApproval,
    provenance,
  })
  const validation = validateAcceptanceDecision(decision)
  if (!validation.ok) throw new Error(validation.errors.join('; '))
  return decision
}

export function deriveReworkRound(ledger = {}) {
  const recorded = Number.isInteger(ledger?.currentRound) ? ledger.currentRound : 0
  const history = Array.isArray(ledger?.rounds) ? ledger.rounds.length : 0
  return Math.max(recorded, history) + 1
}

export function tripLedgerBreaker(ledger = {}) {
  const fencingToken = (Number.isInteger(ledger?.fencingToken) ? ledger.fencingToken : 0) + 1
  const nextLedger = {
    ...structuredClone(ledger ?? {}),
    frozen: true,
    fencingToken,
  }
  const packet = seal('reverse-seam-packet', {
    triggerCondition: 'rework-exhausted',
    fencingToken,
    round: deriveReworkRound(ledger),
    targetIdentityDigest: ledger?.targetIdentityDigest ?? null,
  })
  return { ledger: nextLedger, packet }
}

export const AUTHORIZED_UNFREEZE_ACTORS = Object.freeze(['steer.lead', 'steer.po'])

export function isAuthorizedUnfreezeActor(actor) {
  if (typeof actor !== 'string' || !actor.trim()) return false
  const trimmed = actor.trim()
  if (AUTHORIZED_UNFREEZE_ACTORS.includes(trimmed)) return true
  if (/^steer-lead@[a-zA-Z0-9_.-]+$/i.test(trimmed)) return true
  if (/^steer-po@[a-zA-Z0-9_.-]+$/i.test(trimmed)) return true
  if (/^human:[a-zA-Z0-9_.-]+$/i.test(trimmed)) return true
  return false
}

export function isInRigSeat(actor) {
  if (typeof actor !== 'string' || !actor.trim()) return false
  const trimmed = actor.trim().toLowerCase()
  if (/^(dev|pm|rev)\./i.test(trimmed)) return true
  if (/^orch\.arch/i.test(trimmed)) return true
  if (/^(dev|pm|rev)-[a-zA-Z0-9_.-]+@/i.test(trimmed)) return true
  if (/^orch-arch@/i.test(trimmed)) return true
  return false
}

export function validateUnfreezeResolution(record) {
  const errors = validateSealed(record, 'unfreeze-resolution')
  if (!UNFREEZE_RESOLUTIONS.includes(record?.resolution)) {
    errors.push('resolution must be re-scope, slice-split, person-waiver, or abandonment')
  }
  if (typeof record?.actor !== 'string' || !record.actor.trim()) {
    errors.push('actor is required')
  } else if (isInRigSeat(record.actor)) {
    errors.push(
      `in-rig execution seat "${record.actor}" cannot author an unfreeze resolution; steering plane only`,
    )
  } else if (!isAuthorizedUnfreezeActor(record.actor)) {
    errors.push(
      `actor "${record.actor}" is not an authorized steering identity (steer.lead, steer-lead@<rig>, or human:<login>)`,
    )
  }
  if (record?.resolution === 'person-waiver' || record?.resolution === 'abandonment') {
    const hasApprovalRef =
      (typeof record?.humanApproval === 'string' && record.humanApproval.trim().length > 0) ||
      (typeof record?.approvalRef === 'string' && record.approvalRef.trim().length > 0)
    const isHumanActor =
      typeof record?.actor === 'string' && /^human:[a-zA-Z0-9_.-]+$/i.test(record.actor.trim())
    if (!hasApprovalRef && !isHumanActor) {
      errors.push(
        `${record.resolution} requires an explicit human authorization reference (humanApproval)`,
      )
    }
  }
  if (typeof record?.rationale !== 'string' || !record.rationale.trim()) {
    errors.push('rationale is required')
  }
  if (!Number.isInteger(record?.fencingToken) || record.fencingToken < 1) {
    errors.push('fencingToken must be the next positive epoch token')
  }
  return { ok: errors.length === 0, errors }
}

export function createUnfreezeResolution({
  resolution,
  actor,
  rationale,
  fencingToken,
  humanApproval,
  approvalRef,
} = {}) {
  const payload = { resolution, actor, rationale, fencingToken }
  if (humanApproval !== undefined) payload.humanApproval = humanApproval
  if (approvalRef !== undefined) payload.approvalRef = approvalRef
  const record = seal('unfreeze-resolution', payload)
  const validation = validateUnfreezeResolution(record)
  if (!validation.ok) throw new Error(validation.errors.join('; '))
  return record
}

export function unfreezeLedger(ledger, resolutionRecord) {
  if (ledger?.frozen !== true) throw new Error('ledger is not frozen')
  const validation = validateUnfreezeResolution(resolutionRecord)
  if (!validation.ok) {
    throw new Error(`signed unfreeze resolution is required; ${validation.errors.join('; ')}`)
  }
  const nextToken = (Number.isInteger(ledger.fencingToken) ? ledger.fencingToken : 0) + 1
  if (resolutionRecord.fencingToken !== nextToken) {
    throw new Error(
      'signed resolution fencingToken must be the next epoch token before the fence is cleared',
    )
  }
  return {
    ...structuredClone(ledger),
    frozen: false,
    fencingToken: nextToken,
    unfreezeResolutionDigest: resolutionRecord.digest,
  }
}

function rejectClientRound(round, iteration) {
  if (round !== undefined || iteration !== undefined) {
    throw new Error('client-provided rework round is rejected')
  }
}

function initiallyBlocker(finding) {
  const initial = finding?.initialSeverity ?? finding?.severity
  return initial === 'blocker' || initial === '[B] Blocker'
}

function acceptAndRegisterErrors({ decision, ledger, changeSurface = [] } = {}) {
  const errors = []
  if (ledger?.frozen === true) {
    errors.push('accept_and_register is rejected while the circuit breaker is tripped')
  }
  if (!ledger?.findingsLedger || typeof ledger.findingsLedger !== 'object') {
    errors.push('accept_and_register requires the findings ledger to prove no initial blocker')
  } else if (Object.values(ledger.findingsLedger).some(initiallyBlocker)) {
    errors.push(
      'accept_and_register is rejected because a finding was initially logged as [B] Blocker',
    )
  }
  if (list(changeSurface).some((item) => ACCEPT_AND_REGISTER_SURFACES.includes(item))) {
    errors.push('accept_and_register is rejected on a sensitive surface')
  }
  const conditions = Array.isArray(decision?.conditions) ? decision.conditions : []
  if (
    !conditions.length ||
    conditions.some((condition) => {
      const issueUrl = typeof condition === 'string' ? condition : condition?.issueUrl
      return !GITHUB_FOLLOW_UP_ISSUE.test(issueUrl ?? '')
    })
  ) {
    errors.push(
      'accept_and_register requires an idempotent GitHub follow-up issue URL on every condition',
    )
  }
  return errors
}

export function verifyRoleAdvance({
  decision,
  openReworkRequests,
  ledger,
  commit,
  transition,
  changeSurface = [],
  options = {},
  ...sources
} = {}) {
  const validation = validateAcceptanceDecision(decision)
  const errors = [...validation.errors]
  const report = verifyRoleDelivery(sources)
  if (decision?.deterministicReport?.digest !== report.digest)
    errors.push('acceptance is stale for the current source evidence')
  const registered = decision?.state === 'accepted-with-conditions'
  if (decision?.state !== 'accepted' && !registered) {
    errors.push('phase advancement requires unconditional owner acceptance')
  }
  if (registered) {
    errors.push(
      ...acceptAndRegisterErrors({
        decision,
        ledger,
        changeSurface: changeSurface.length ? changeSurface : options.changeSurface,
      }),
    )
  }
  if (!Array.isArray(openReworkRequests) || openReworkRequests.length) {
    errors.push('phase advancement is blocked by unresolved rework')
  }
  if (ledger?.frozen === true) {
    errors.push('phase advancement is rejected on a frozen ledger')
  }
  const authored = commit ?? transition ?? null
  if (
    ledger &&
    authored &&
    Number.isInteger(ledger.fencingToken) &&
    Number.isInteger(authored.fencingToken) &&
    authored.fencingToken < ledger.fencingToken
  ) {
    errors.push('commit or transition authored after the fencing token is rejected')
  }
  const isDeveloperDelivery =
    sources.delivery?.producerRole === 'agentflow:developer' ||
    sources.delivery?.role === 'agentflow:developer'
  const isEnteringDeveloper =
    options.isEnteringDeveloper !== undefined
      ? Boolean(options.isEnteringDeveloper)
      : !isDeveloperDelivery &&
        (sources.contract?.deliveryRole === 'agentflow:developer' ||
          sources.handoff?.toRole === 'agentflow:developer' ||
          sources.contract?.phase === 3 ||
          sources.handoff?.phase === 3)
  if (isEnteringDeveloper && options.seat && !BUILDER_SEATS.includes(options.seat)) {
    errors.push(`entering developer role requires a builder seat (got ${options.seat})`)
  }
  const targetSeat = options.seat ?? (isEnteringDeveloper ? 'dev.build' : null)
  let pin = options.pin ?? options.oraclePin ?? null
  const contractOracleDigest =
    sources.contract?.oracleDigest ??
    sources.handoff?.oracleDigest ??
    (sources.contract?.controls ?? [])
      .find((c) => typeof c === 'string' && c.startsWith('oracle-digest:'))
      ?.slice('oracle-digest:'.length) ??
    (sources.contract?.controls ?? [])
      .find((c) => typeof c === 'string' && c.startsWith('oracle-pin:'))
      ?.slice('oracle-pin:'.length) ??
    null
  if (
    options.oracleDigest &&
    contractOracleDigest &&
    options.oracleDigest !== contractOracleDigest
  ) {
    errors.push('caller oracleDigest contradicts contract oracle digest')
  }
  if (pin && contractOracleDigest && pin.oracleDigest !== contractOracleDigest) {
    errors.push('caller-supplied oracle pin digest contradicts contract oracle digest')
  }
  const oracleDigest = contractOracleDigest ?? options.oracleDigest ?? null
  if (!pin && oracleDigest) {
    try {
      pin = pinOracleDigest({ digest: oracleDigest, phase: 3 })
    } catch (err) {
      errors.push(err.message)
    }
  }
  if (isEnteringDeveloper && targetSeat && BUILDER_SEATS.includes(targetSeat)) {
    const expectedDigest =
      options.expectedDigest !== undefined
        ? options.expectedDigest
        : computeOracleDigest({ packageRoot: options.packageRoot ?? process.cwd() })
    const pinCheck = verifyOraclePin({
      pin,
      seat: targetSeat,
      expectedDigest,
    })
    if (!pinCheck.ok) errors.push(...pinCheck.errors)
  }
  return { ok: errors.length === 0, errors, report }
}

export function createReworkRequest({
  id,
  acceptanceDecisionDigest,
  ownerRole,
  deliveryRole,
  failedCriteria = [],
  requiredChanges = [],
  evidenceDigest,
  round,
  iteration,
  ledger,
} = {}) {
  rejectClientRound(round, iteration)
  if (ledger?.frozen === true) {
    throw new Error('rework is rejected on a frozen ledger')
  }
  const reworkRound = deriveReworkRound(ledger)
  if (reworkRound > DEFAULT_MAX_REWORK_ROUNDS) {
    const tripped = tripLedgerBreaker(ledger)
    const error = new Error('rework circuit breaker tripped')
    error.ledger = tripped.ledger
    error.packet = tripped.packet
    throw error
  }
  return seal('rework-request', {
    id,
    acceptanceDecisionDigest,
    ownerRole,
    deliveryRole,
    failedCriteria,
    requiredChanges,
    evidenceDigest,
    round: reworkRound,
  })
}

export function validateAcceptanceDecision(decision) {
  const errors = validateSealed(decision, 'acceptance-decision')
  if (!ACCEPTANCE_STATES.includes(decision?.state)) errors.push('state is invalid')
  if (!decision?.decidedByRole) errors.push('decidedByRole is required')
  const report = decision?.deterministicReport
  if (!hasCurrentDigest(report) || report?.type !== 'delivery-verification') {
    errors.push('deterministic report must be current and sealed')
  }
  for (const field of [
    'handoffDigest',
    'contractDigest',
    'deliveryDigest',
    'councilSynthesisDigest',
  ]) {
    if (decision?.[field] !== report?.[field])
      errors.push(`${field} must match the deterministic report`)
  }
  if (decision?.decidedByRole !== report?.ownerRole)
    errors.push('only the handover owner may decide')
  if (['accepted', 'accepted-with-conditions'].includes(decision?.state)) {
    if (
      !['pass', 'semantic-review-required'].includes(report?.status) ||
      !Array.isArray(report?.checks) ||
      report.checks.some((check) => check.status !== 'pass')
    ) {
      errors.push('acceptance requires a passing deterministic report')
    }
    const findings = decision?.semanticFindings ?? []
    for (const criterionId of report?.semanticCriteria ?? []) {
      const matches = findings.filter((item) => item.criterionId === criterionId)
      if (matches.length !== 1 || matches[0].status !== 'pass' || !matches[0].reason) {
        errors.push(`semantic criterion requires one passing finding with reason: ${criterionId}`)
      }
    }
    const advisoryIds = new Set(report?.advisorySemanticCriteria ?? [])
    const advisoryAllowed = ['pass', 'observation', 'unverified']
    let blockingFailed = false
    for (const finding of findings) {
      if (!SEMANTIC_FINDING_STATUSES.includes(finding?.status)) {
        errors.push(`semantic finding status is invalid: ${finding?.status}`)
      }
      if (!finding?.reason) {
        errors.push(`semantic finding requires a reason: ${finding?.criterionId}`)
      }
      if (advisoryIds.has(finding?.criterionId)) {
        if (!advisoryAllowed.includes(finding?.status)) {
          errors.push(
            `advisory finding for ${finding?.criterionId} must be pass, observation, or unverified`,
          )
        }
      } else if (finding?.status !== 'pass') {
        blockingFailed = true
      }
    }
    if (blockingFailed) {
      errors.push('all semantic findings must pass')
    }
    if (report?.humanApprovalRequired) {
      const approval = decision?.humanApproval
      if (
        approval?.approved !== true ||
        !approval?.actor ||
        approval?.actorType !== 'human' ||
        approval?.deliveryDigest !== decision.deliveryDigest ||
        !validateArtifactRef(approval?.evidenceRef).ok
      ) {
        errors.push('human-gated acceptance requires delivery-bound human approval evidence')
      }
    }
  }
  if (decision?.state === 'accepted-with-conditions' && !(decision?.conditions ?? []).length) {
    errors.push('accepted-with-conditions requires conditions')
  }
  return { ok: errors.length === 0, errors }
}

export function validateReworkRequest(request, options = {}) {
  const errors = validateSealed(request, 'rework-request')
  if (!request?.acceptanceDecisionDigest || !request?.ownerRole || !request?.deliveryRole) {
    errors.push('rework request identity is incomplete')
  }
  if (!Array.isArray(request?.requiredChanges) || !request.requiredChanges.length) {
    errors.push('requiredChanges must be non-empty')
  }
  const round = request?.round ?? request?.iteration
  if (round !== undefined) {
    if (!Number.isInteger(round) || round < 1) {
      errors.push('round must be a positive integer')
    } else if (round > DEFAULT_MAX_REWORK_ROUNDS) {
      errors.push(`rework round ${round} is past the circuit breaker`)
    }
  }
  void options
  return { ok: errors.length === 0, errors }
}
