import { validateArtifactRef } from './artifact-ref.mjs'
import { recordDigest, hasCurrentDigest } from './record-digest.mjs'

export const ROLE_COLLABORATION_VERSION = 1
export const COLLABORATION_CLASSES = ['linear', 'bilateral', 'council', 'human-gated']
export const ACCEPTANCE_STATES = [
  'accepted',
  'accepted-with-conditions',
  'rework-required',
  'rejected',
]

export const DEFAULT_ROLE_COLLABORATION_POLICY = Object.freeze({
  sensitiveSurfaces: ['security', 'auth', 'data', 'infra', 'billing'],
  councilDomainThreshold: 3,
  bilateralDomainThreshold: 2,
  councilOnPublicContract: true,
  councilOnMigration: true,
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
    semanticCriteria: semanticCriteria.map((item) => item.id),
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

export function verifyRoleAdvance({ decision, openReworkRequests, ...sources } = {}) {
  const validation = validateAcceptanceDecision(decision)
  const errors = [...validation.errors]
  const report = verifyRoleDelivery(sources)
  if (decision?.deterministicReport?.digest !== report.digest)
    errors.push('acceptance is stale for the current source evidence')
  if (decision?.state !== 'accepted') {
    errors.push('phase advancement requires unconditional owner acceptance')
  }
  if (!Array.isArray(openReworkRequests) || openReworkRequests.length) {
    errors.push('phase advancement is blocked by unresolved rework')
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
} = {}) {
  return seal('rework-request', {
    id,
    acceptanceDecisionDigest,
    ownerRole,
    deliveryRole,
    failedCriteria,
    requiredChanges,
    evidenceDigest,
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
    if (findings.some((item) => item.status !== 'pass'))
      errors.push('all semantic findings must pass')
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

export function validateReworkRequest(request) {
  const errors = validateSealed(request, 'rework-request')
  if (!request?.acceptanceDecisionDigest || !request?.ownerRole || !request?.deliveryRole) {
    errors.push('rework request identity is incomplete')
  }
  if (!Array.isArray(request?.requiredChanges) || !request.requiredChanges.length) {
    errors.push('requiredChanges must be non-empty')
  }
  return { ok: errors.length === 0, errors }
}
