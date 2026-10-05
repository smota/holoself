import { randomUUID } from 'node:crypto'
import { recordDigest } from './record-digest.mjs'

// Classification belongs to the core, never to a caller-supplied effect flag.
export const ACTIONS = new Map([
  ['edit', false],
  ['commit', false],
  ['push', true],
  ['pr:create', true],
  ['pr:update', true],
  ['merge', true],
])
export const ACTION_BOUNDARIES = new Map([
  ['edit', 'mutate-worktree'],
  ['commit', 'mutate-worktree'],
  ['push', 'open-pr'],
  ['pr:create', 'open-pr'],
  ['pr:update', 'open-pr'],
  ['merge', 'external-action'],
])
export const CONDITIONAL_ADMISSION = 'single-parent-run-chain-v1'
const fail = (message) => {
  throw new Error(message)
}
export function safeKey(value) {
  return (
    typeof value === 'string' &&
    /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,199}$/.test(value) &&
    !['__proto__', 'prototype', 'constructor'].includes(value)
  )
}
export const safePath = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  !/[\\:*?\x00-\x1f]/.test(value) &&
  value
    .split('/')
    .every((part) => part !== '' && part !== '.' && part !== '..' && !/[. ]$/.test(part))
const text = (v, name) => {
  if (typeof v !== 'string' || !v.trim()) fail(`Invalid ${name}`)
}
const digest = (v, name) => {
  if (!/^[a-f0-9]{64}$/.test(v ?? '')) fail(`Invalid ${name} digest`)
}
const integer = (v, name, min = 0) => {
  if (!Number.isSafeInteger(v) || v < min) fail(`Invalid ${name}`)
}
const strings = (v, name) => {
  if (
    !Array.isArray(v) ||
    v.some((x) => typeof x !== 'string' || !x) ||
    new Set(v).size !== v.length
  )
    fail(`Invalid ${name}`)
}
const timestamp = (v) => {
  if (typeof v !== 'string' || !Number.isFinite(Date.parse(v))) fail('Invalid timestamp')
  return Date.parse(v)
}
function json(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (!value || typeof value !== 'object' || seen.has(value))
    fail('Operation must contain finite JSON values')
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    fail('Invalid JSON object')
  seen.add(value)
  for (const [k, v] of Object.entries(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(k)) fail('Unsafe object key')
    json(v, seen)
  }
  seen.delete(value)
}
export function validateDelegationPolicy(policy) {
  json(policy)
  if (policy?.version !== 1 || !Array.isArray(policy.issuers) || !policy.issuers.length)
    fail('Configured issuer policy required')
  const ids = new Set()
  for (const issuer of policy.issuers) {
    if (!safeKey(issuer.id) || ids.has(issuer.id)) fail('Invalid or duplicate configured issuer')
    ids.add(issuer.id)
    text(issuer.origin, 'issuer origin')
    text(issuer.authorityRef, 'authority reference')
    if (issuer.mode !== 'local-cooperative') fail('UNSUPPORTED: no qualified trusted-host binding')
    strings(issuer.allowedActions, 'issuer actions')
    if (!issuer.allowedActions.length || issuer.allowedActions.some((a) => !ACTIONS.has(a)))
      fail('Invalid issuer actions')
    if (typeof issuer.allowThroughMerge !== 'boolean')
      fail('Explicit through-merge policy required')
  }
  strings(policy.requiredChecks, 'required checks')
  if (!['automated', 'human'].includes(policy.reviewPolicy)) fail('Invalid review policy')
  if (policy.materiality !== 'fixed-scope-v1') fail('Unsupported materiality predicate')
  if (typeof policy.allowSubdelegation !== 'boolean') fail('Explicit subdelegation policy required')
  integer(policy.safetyReserve, 'safety reserve', 1)
  if (policy.safetyReserve > 100) fail('Safety reserve must be bounded at 100')
  if ('hardCeiling' in policy) fail('UNSUPPORTED: no enforcing hard-ceiling provider')
  return policy
}
export function validateGrantRequest(request, atTime, policy) {
  json(request)
  validateDelegationPolicy(policy)
  if (request.issuerMode !== 'local-cooperative') fail('UNSUPPORTED: issuer assurance')
  if ('hardCeiling' in request) fail('UNSUPPORTED: no enforcing hard-ceiling provider')
  const fields = [
    'issuerMode',
    'issuerBinding',
    'planDigest',
    'policyDigest',
    'repository',
    'base',
    'delegate',
    'allowedPaths',
    'allowedActions',
    'capabilities',
    'requiredChecks',
    'reviewPolicy',
    'materiality',
    'allowSubdelegation',
    'maxAttempts',
    'maxExternalEffects',
    'expiry',
  ]
  if (Object.keys(request).some((k) => !fields.includes(k))) fail('Unknown grant request field')
  digest(request.planDigest, 'plan')
  digest(request.policyDigest, 'policy')
  if (request.policyDigest !== recordDigest(policy)) fail('Configured policy digest mismatch')
  for (const name of ['repository', 'base', 'delegate']) text(request[name], name)
  const binding = request.issuerBinding
  const issuer = policy.issuers.find((i) => i.id === binding?.issuerId)
  if (
    !issuer ||
    binding.type !== 'delegation-issuance' ||
    binding.mode !== issuer.mode ||
    binding.origin !== issuer.origin ||
    binding.authorityRef !== issuer.authorityRef ||
    binding.policyDigest !== request.policyDigest ||
    binding.requestDigest !== grantRequestDigest(request)
  )
    fail('Unconfigured or mismatched issuer binding')
  text(binding.decisionRef, 'explicit host approval reference')
  strings(request.allowedActions, 'allowed actions')
  strings(request.capabilities, 'capabilities')
  if (
    !request.allowedActions.length ||
    request.allowedActions.some(
      (a) =>
        !ACTIONS.has(a) || !issuer.allowedActions.includes(a) || !request.capabilities.includes(a),
    ) ||
    request.capabilities.some((c) => !issuer.allowedActions.includes(c))
  )
    fail('Unsupported action or capability')
  if (request.allowedActions.includes('merge') && !issuer.allowThroughMerge)
    fail('Through-merge cooperative policy denied')
  strings(request.allowedPaths, 'allowed paths')
  if (
    !request.allowedPaths.length ||
    request.allowedPaths.some((p) => !safePath(p.endsWith('/*') ? p.slice(0, -2) : p))
  )
    fail('Invalid allowed path pattern')
  strings(request.requiredChecks, 'required checks')
  if (
    policy.requiredChecks.some((c) => !request.requiredChecks.includes(c)) ||
    (policy.reviewPolicy === 'human' && request.reviewPolicy !== 'human') ||
    !['automated', 'human'].includes(request.reviewPolicy) ||
    request.materiality !== policy.materiality
  )
    fail('Grant weakens configured checks or review policy')
  if (
    typeof request.allowSubdelegation !== 'boolean' ||
    (request.allowSubdelegation && !policy.allowSubdelegation)
  )
    fail('Invalid subdelegation authority')
  integer(request.maxAttempts, 'maxAttempts', 1)
  integer(request.maxExternalEffects, 'maxExternalEffects')
  if (timestamp(request.expiry) <= timestamp(atTime)) fail('Grant expiry must be in the future')
  return true
}
// Binding commits every requested field, except the binding itself; no ignored digest field.
export function grantRequestDigest(request) {
  const { issuerBinding, ...intent } = request
  return recordDigest({ intent })
}
export function pathMatches(path, patterns) {
  return (
    safePath(path) &&
    patterns.some((p) => (p.endsWith('/*') ? path.startsWith(p.slice(0, -1)) : p === path))
  )
}
export function patternSubset(child, parent) {
  return child === parent || (parent.endsWith('/*') && child.startsWith(parent.slice(0, -1)))
}
export function grantAncestors(grant, state, atTime) {
  const ancestors = [],
    seen = new Set()
  let id = grant.id
  while (id !== null) {
    if (!safeKey(id) || seen.has(id)) fail('Invalid or cyclic grant ancestry')
    seen.add(id)
    const current = Object.hasOwn(state.grants, id) ? state.grants[id] : null
    if (!current) fail('Missing grant ancestor')
    if (current.status !== 'active') fail('REVOKED: grant or ancestor revoked')
    if (timestamp(current.envelope.binding.expiry) <= timestamp(atTime))
      fail('EXPIRED: grant or ancestor expired')
    ancestors.push(current)
    id = current.envelope.parentId
  }
  return ancestors
}
export function validateChild(request, parent) {
  const b = parent.binding
  if (!b.allowSubdelegation) fail('Parent prohibits subdelegation')
  for (const k of ['planDigest', 'policyDigest', 'repository', 'base', 'delegate', 'materiality'])
    if (request[k] !== b[k]) fail(`Child grant ${k} must match parent`)
  for (const k of ['allowedActions', 'capabilities'])
    if (request[k].some((x) => !b[k].includes(x))) fail(`Child widens ${k}`)
  if (request.allowedPaths.some((p) => !b.allowedPaths.some((q) => patternSubset(p, q))))
    fail('Child widens allowedPaths')
  if (
    b.requiredChecks.some((c) => !request.requiredChecks.includes(c)) ||
    (b.reviewPolicy === 'human' && request.reviewPolicy !== 'human')
  )
    fail('Child weakens checks/review')
  if (timestamp(request.expiry) > timestamp(b.expiry)) fail('Child outlives parent')
  if (request.maxAttempts > b.maxAttempts || request.maxExternalEffects > b.maxExternalEffects)
    fail('Child exceeds parent budget')
}
export function issueGrant(
  request,
  actor,
  parent = null,
  { atTime, policy, id = randomUUID() } = {},
) {
  validateGrantRequest(request, atTime, policy)
  if (!safeKey(id)) fail('Invalid grant id')
  if (parent) {
    if (!parent?.id || !safeKey(parent.id) || !parent?.binding)
      fail('Invalid parent grant envelope')
    validateChild(request, parent)
  }
  text(actor, 'issuer actor')
  return {
    id,
    issuedAt: atTime,
    issuerActor: actor,
    binding: structuredClone(request),
    parentId: parent?.id ?? null,
  }
}
export function normalizeOperation(operation) {
  json(operation)
  const allowed = [
    'id',
    'planDigest',
    'policyDigest',
    'repository',
    'base',
    'delegate',
    'action',
    'paths',
    'capabilities',
    'candidateDigest',
    'workspaceDigest',
    'checks',
    'review',
    'arguments',
  ]
  if (Object.keys(operation).some((k) => !allowed.includes(k))) fail('Unknown operation field')
  if (!safeKey(operation.id) || !ACTIONS.has(operation.action))
    fail('Invalid operation identity or action')
  for (const k of ['planDigest', 'policyDigest', 'candidateDigest', 'workspaceDigest'])
    digest(operation[k], k)
  for (const k of ['repository', 'base', 'delegate']) text(operation[k], k)
  strings(operation.paths, 'operation paths')
  strings(operation.capabilities, 'operation capabilities')
  if (!operation.paths.length || operation.paths.some((p) => !safePath(p)))
    fail('Invalid operation path')
  if (
    !Array.isArray(operation.checks) ||
    !operation.review ||
    !operation.arguments ||
    Array.isArray(operation.arguments)
  )
    fail('Operation requires checks, review and arguments')
  return structuredClone(operation)
}
export const operationDigest = (operation) =>
  recordDigest({ operation: normalizeOperation(operation) })
export function verifyDelegationDecision(decision, type, grant, state) {
  const binding = grant.envelope.binding.issuerBinding
  if (
    decision?.type !== type ||
    decision.grantId !== grant.envelope.id ||
    decision.grantRevision !== grant.revision ||
    decision.policyDigest !== recordDigest(state.delegationPolicy) ||
    ['issuerId', 'mode', 'origin', 'authorityRef'].some((k) => decision[k] !== binding[k]) ||
    typeof decision.decisionRef !== 'string' ||
    !decision.decisionRef.trim()
  )
    fail('Typed independently resolved delegation decision required')
}
export function resolveGrant(presented, state, operation, atTime) {
  try {
    const g = Object.hasOwn(state.grants, presented.id) ? state.grants[presented.id] : null
    if (!g || recordDigest({ envelope: presented }) !== recordDigest({ envelope: g.envelope }))
      fail('Unknown or tampered grant')
    const b = g.envelope.binding
    validateGrantRequest(b, g.envelope.issuedAt, state.delegationPolicy)
    grantAncestors(g.envelope, state, atTime)
    const op = normalizeOperation(operation)
    for (const k of ['planDigest', 'policyDigest', 'repository', 'base', 'delegate'])
      if (op[k] !== b[k]) fail(`SCOPE: ${k} mismatch`)
    if (state.candidateDigest !== op.candidateDigest) fail('Stale candidate')
    if (
      !b.allowedActions.includes(op.action) ||
      !op.capabilities.includes(op.action) ||
      op.capabilities.some((c) => !b.capabilities.includes(c))
    )
      fail('SCOPE: action/capability mismatch')
    if (op.paths.some((p) => !pathMatches(p, b.allowedPaths))) fail('SCOPE: path mismatch')
    if (
      b.requiredChecks.some(
        (name) =>
          !op.checks.some(
            (c) =>
              c.name === name && c.outcome === 'pass' && c.candidateDigest === op.candidateDigest,
          ),
      )
    )
      fail('Required exact-candidate check missing')
    if (
      op.review.outcome !== 'pass' ||
      op.review.policy !== b.reviewPolicy ||
      op.review.candidateDigest !== op.candidateDigest
    )
      fail('Required exact-candidate review missing')
    if (g.budgetUsed.attempts + g.budgetReserved.attempts >= b.maxAttempts)
      fail('BUDGET: attempts exhausted')
    if (
      ACTIONS.get(op.action) &&
      g.budgetUsed.externalEffects + g.budgetReserved.externalEffects >= b.maxExternalEffects
    )
      fail('BUDGET: external effects exhausted')
    return { admitted: true, operation: op, operationDigest: operationDigest(op) }
  } catch (error) {
    return { admitted: false, reason: error.message }
  }
}

export function reduceDelegationEvent(state, event) {
  const p = event.payload
  if (event.kind === 'grant-issued') {
    const grant = p.grant
    if (!grant || !safeKey(grant.id) || Object.hasOwn(state.grants, grant.id))
      fail('Invalid or duplicate grant ID')
    if (
      Object.keys(grant).some(
        (k) => !['id', 'issuedAt', 'issuerActor', 'binding', 'parentId'].includes(k),
      )
    )
      fail('Unknown grant envelope field')
    if (grant.issuedAt !== event.timestamp) fail('Grant issuance timestamp mismatch')
    text(grant.issuerActor, 'issuer actor')
    validateGrantRequest(grant.binding, event.timestamp, state.delegationPolicy)
    if (grant.parentId !== null) {
      if (!safeKey(grant.parentId)) fail('Invalid parent grant ID')
      const parent = Object.hasOwn(state.grants, grant.parentId)
        ? state.grants[grant.parentId]
        : null
      if (!parent) fail('Unknown parent grant')
      grantAncestors(parent.envelope, state, event.timestamp)
      validateChild(grant.binding, parent.envelope)
      for (const [counter, limit] of [
        ['attempts', 'maxAttempts'],
        ['externalEffects', 'maxExternalEffects'],
      ]) {
        if (
          parent.budgetUsed[counter] + parent.budgetReserved[counter] + grant.binding[limit] >
          parent.envelope.binding[limit]
        )
          fail('Child exceeds remaining parent budget')
        parent.budgetReserved[counter] += grant.binding[limit]
      }
    }
    state.grants[grant.id] = {
      envelope: structuredClone(grant),
      revision: event.digest,
      status: 'active',
      revocationEpoch: 0,
      budgetUsed: { attempts: 0, externalEffects: 0 },
      budgetReserved: { attempts: 0, externalEffects: 0 },
    }
  } else if (event.kind === 'grant-revoked') {
    if (!safeKey(p.id) || !Object.hasOwn(state.grants, p.id)) fail('Grant not found')
    text(p.reason, 'revocation reason')
    const g = state.grants[p.id]
    if (g.status !== 'active') fail('Grant already revoked')
    g.status = 'revoked'
    g.revocationEpoch = ++state.revocationEpoch
  } else if (event.kind === 'operation-admitted') {
    const g = Object.hasOwn(state.grants, p.grantId) ? state.grants[p.grantId] : null
    if (!g) fail('Grant not found')
    if (
      p.runRevision !== state.revision ||
      p.generation !== state.generation ||
      p.writer !== state.owner
    )
      fail('Admission writer/run mismatch')
    if (p.grantRevision !== g.revision || p.grantEpoch !== g.revocationEpoch)
      fail('Admission grant revision/epoch mismatch')
    const op = normalizeOperation(p.operation)
    const computed = operationDigest(op)
    if (p.operationDigest !== computed) fail('Operation digest mismatch')
    verifyDelegationDecision(p.authorization, 'delegation-resolution', g, state)
    if (p.authorization.operationDigest !== computed || p.authorization.delegate !== op.delegate)
      fail('Resolution operation binding mismatch')
    if (Object.hasOwn(state.admissions, op.id))
      fail('Operation ID already admitted; reconcile existing admission')
    const resolution = resolveGrant(g.envelope, state, op, event.timestamp)
    if (!resolution.admitted) fail(`Admission rejected: ${resolution.reason}`)
    g.budgetUsed.attempts++
    if (ACTIONS.get(op.action)) g.budgetUsed.externalEffects++
    state.admissions[op.id] = {
      grantId: p.grantId,
      operation: op,
      operationDigest: computed,
      eventId: event.id,
      eventDigest: event.digest,
      state: 'admitted',
    }
  } else if (event.kind === 'delegation-safety') {
    const isTerminalReconciliation = p.kind === 'reconcile' && p.outcome !== undefined
    if (!state.delegationPolicy) fail('Delegation policy required')
    if (!isTerminalReconciliation && state.safetyUsed >= state.delegationPolicy.safetyReserve)
      fail('Safety reserve exhausted')
    if (
      Object.keys(p).some((k) => !['id', 'kind', 'reason', 'operationId', 'outcome'].includes(k)) ||
      !safeKey(p.id) ||
      !['checkpoint', 'reconcile'].includes(p.kind)
    )
      fail('Invalid safety operation')
    text(p.reason, 'safety reason')
    if (Buffer.byteLength(JSON.stringify(p)) > 2048)
      fail('Safety checkpoint exceeds bounded capacity')
    if (p.kind === 'reconcile' && !Object.hasOwn(state.admissions, p.operationId))
      fail('Safety reconciliation requires prior admission')
    if (p.outcome !== undefined) {
      const admitted = state.admissions[p.operationId]
      const prior = state.operations[p.operationId]
      const outcome = p.outcome
      if (p.kind !== 'reconcile' || !prior || ['confirmed', 'failed'].includes(prior.state))
        fail('Reconciliation requires a pending operation')
      if (
        outcome?.verified !== true ||
        !['confirmed', 'failed'].includes(outcome.state) ||
        outcome.operationId !== p.operationId ||
        outcome.payloadDigest !== admitted.operationDigest ||
        outcome.candidateDigest !== admitted.operation.candidateDigest ||
        typeof outcome.sourceRevision !== 'string' ||
        !outcome.sourceRevision.trim()
      )
        fail('Reconciliation requires exact authoritative operation evidence')
      state.operations[p.operationId] = {
        ...prior,
        state: outcome.state,
        reconciliation: structuredClone(outcome),
      }
    }
    if (state.safetyRecords.some((r) => r.id === p.id)) fail('Duplicate safety record')
    state.safetyUsed++
    state.safetyRecords.push(structuredClone(p))
  } else return false
  return true
}
