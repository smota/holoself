import { resolveTwoLevelFallback } from './platform-fallback.mjs'
import { recordDigest } from '../../lib/core/record-digest.mjs'
import { reduceRun } from '../../lib/core/run-state.mjs'
import { requireOracleCustodyReceipt } from '../../lib/core/oracle-custody.mjs'

const finite = (value) => typeof value === 'number' && Number.isFinite(value)
const safeId = (value) =>
  typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(value)
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const tupleFields = ['runtime', 'providerRoute', 'model', 'effort', 'profile']
const tuple = (value) =>
  value && tupleFields.every((key) => typeof value[key] === 'string' && value[key].length > 0)
const sameTuple = (left, right) =>
  tuple(left) && tuple(right) && tupleFields.every((key) => left[key] === right[key])
const artifacts = (value) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length > 0 &&
  Object.entries(value).every(([key, value]) => safeId(key) && digest(value))

// Active custody is a native source fact. Neither a digest pin nor a host boolean
// substitutes for the original typed request and its source-recorded receipt.
function activeOracleCustody(snapshot) {
  const state = snapshot.state
  if (!state.oracleDigest) return true
  if (state.oraclePin?.oracleDigest !== state.oracleDigest) return false
  const receipts = Object.values(state.oracleCustody ?? {})
  if (!receipts.length) return false
  return receipts.every((receipt) => {
    try {
      const event = snapshot.events.find(
        (event) =>
          event.kind === 'oracle-custody-recorded' &&
          event.payload.receipt?.digest === receipt.digest,
      )
      if (!event || recordDigest(event.payload.receipt) !== recordDigest(receipt)) return false
      requireOracleCustodyReceipt(receipt, event.payload.request)
      return (
        receipt.runId === state.runId &&
        receipt.goalRef === state.goalRef &&
        receipt.generation === state.generation &&
        receipt.revocationEpoch === state.revocationEpoch &&
        receipt.oracleDigest === state.oracleDigest &&
        receipt.candidateDigest === state.candidateDigest &&
        event.previousDigest === event.payload.request.runRevision
      )
    } catch {
      return false
    }
  })
}

// Only structured error identity/status is classification evidence. Usage metadata and prose
// may repeat historical failures, so neither is searched for error-looking substrings.
export function classifyExecutionFailure({
  structuredError = {},
  responseHeaders = {},
  nowMs,
} = {}) {
  const error = structuredError?.error ?? structuredError ?? {}
  const code = typeof error.code === 'string' ? error.code.toLowerCase() : ''
  const status = error.status ?? error.statusCode ?? structuredError?.status
  let classification = 'unknown'
  if (
    [
      'insufficient_quota',
      'quota_exceeded',
      'quota_exhausted',
      'billing_hard_limit_reached',
    ].includes(code)
  )
    classification = 'quota-exhausted'
  else if (
    ['invalid_api_key', 'authentication_error', 'unauthorized', 'token_expired'].includes(code) ||
    status === 401
  )
    classification = 'authentication'
  else if (['model_not_found', 'model_unavailable', 'unsupported_model'].includes(code))
    classification = 'model-unavailable'
  else if (
    ['entry_not_found', 'session_not_found', 'restore_integrity', 'generation_mismatch'].includes(
      code,
    )
  )
    classification = 'restore-integrity'
  else if (['eacces', 'eperm'].includes(code)) classification = 'local-permission'
  else if (code === 'enoent') classification = 'local-path'
  else if (['rate_limit_exceeded', 'too_many_requests'].includes(code) || status === 429)
    classification = 'temporary-rate-limit'
  else if (
    ['overloaded', 'provider_unavailable'].includes(code) ||
    [500, 502, 503, 504].includes(status)
  )
    classification = 'provider-unavailable'
  const retryHeader = Object.entries(responseHeaders ?? {}).find(
    ([name]) => name.toLowerCase() === 'retry-after',
  )?.[1]
  let retryAt = null
  if (finite(nowMs) && typeof retryHeader === 'string') {
    if (/^\d+(?:\.\d+)?$/.test(retryHeader.trim())) retryAt = nowMs + Number(retryHeader) * 1000
    else if (/^[A-Za-z]{3},/.test(retryHeader)) retryAt = Date.parse(retryHeader)
    if (!finite(retryAt) || retryAt < nowMs) retryAt = null
  }
  return { classification, retryAt, providerResetUnknown: retryAt === null }
}

// This is a host integration boundary, not a second recovery controller. The existing run
// service owns writer transfer, source revisions, grants, budgets, and operation reconciliation.
// No deployed OpenRig compact reader can supply these trusted host receipts at present.
export async function recoverExecution({
  service,
  failure,
  policy,
  nowMs,
  owner,
  currentContract,
  replacementContract,
  recovery,
  operation,
  operationOptions,
  inspectRecoveryContext,
  renewOracleCustody,
  dispatch,
  readback,
} = {}) {
  // Snapshot all caller data before the first asynchronous boundary. Host ports retain no
  // authority to rewrite the selected operation, grant, policy or route through caller aliases.
  const effects = []
  const started = performance.now()
  const currentTime = () => nowMs + performance.now() - started
  const deadline = finite(policy?.deadlineAt)
    ? policy.deadlineAt
    : finite(nowMs)
      ? nowMs + 60000
      : null
  const hold = (reason) => ({
    status: 'held',
    reason,
    obligation: {
      owner: safeId(owner) ? owner : 'operator',
      action: 'verify-recovery-context',
      deadlineAt: deadline,
    },
    effects: [...effects],
  })
  try {
    ;({
      failure,
      policy,
      currentContract,
      replacementContract,
      recovery,
      operation,
      operationOptions,
    } = structuredClone({
      failure,
      policy,
      currentContract,
      replacementContract,
      recovery,
      operation,
      operationOptions,
    }))
  } catch {
    return hold('recovery-input-unverified')
  }
  if (
    !finite(nowMs) ||
    nowMs < 0 ||
    !policy ||
    !Number.isSafeInteger(policy.maxAttempts) ||
    policy.maxAttempts < 1 ||
    policy.maxAttempts > 20 ||
    !finite(policy.deadlineAt) ||
    policy.deadlineAt <= nowMs ||
    !finite(policy.backoffMs) ||
    policy.backoffMs < 1 ||
    !finite(policy.portTimeoutMs) ||
    policy.portTimeoutMs < 1 ||
    policy.portTimeoutMs > 60000
  )
    return hold('recovery-budget-invalid-or-expired')
  const bounded = async (callback) => {
    const remaining = policy.deadlineAt - currentTime()
    if (remaining <= 0) throw new Error('deadline')
    let timer
    try {
      return await Promise.race([
        Promise.resolve().then(callback),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('port-timeout')),
            Math.min(remaining, policy.portTimeoutMs),
          )
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  const readSource = async () => {
    const snapshot = await bounded(() => service.read())
    const projected = reduceRun(snapshot.events)
    if (
      !projected ||
      projected.revision !== snapshot.revision ||
      recordDigest(projected) !== recordDigest(snapshot.state)
    )
      throw new Error('source projection changed')
    return snapshot
  }
  const classification = classifyExecutionFailure({ ...failure, nowMs })
  if (
    [
      'authentication',
      'model-unavailable',
      'restore-integrity',
      'local-permission',
      'local-path',
      'unknown',
    ].includes(classification.classification)
  )
    return hold(classification.classification)
  if (
    !service ||
    ![
      'read',
      'record',
      'recoveryPlan',
      'resume',
      'executeDelegatedOperation',
      'reconcileDelegatedOperation',
    ].every((method) => typeof service[method] === 'function')
  )
    return hold('source-service-unavailable')
  let snapshot
  try {
    snapshot = await readSource()
  } catch {
    return hold('source-read-unavailable')
  }
  let state = snapshot?.state
  if (!state) return hold('source-run-unavailable')
  const incident = operation?.arguments?.recoveryIncident
  const policyDigest = recordDigest(policy)
  if (
    !safeId(incident) ||
    !safeId(operation?.id) ||
    operation?.action !== 'rig:mutate' ||
    !operation?.capabilities?.includes('rig:mutate') ||
    operation?.arguments?.recoveryPolicyDigest !== policyDigest
  )
    return hold('incident-policy-unbound')
  const prior = Object.values(state.admissions ?? {}).filter(
    (item) => item.operation?.arguments?.recoveryIncident === incident,
  )
  const attempts = (snapshot.events ?? []).filter(
    (event) => event.kind === 'checkpoint' && event.payload?.recoveryIncident === incident,
  )
  if (
    attempts.some((event) => event.payload.recoveryPolicyDigest !== policyDigest) ||
    prior.some((item) => item.operation.arguments.recoveryPolicyDigest !== policyDigest)
  )
    return hold('incident-policy-changed')
  // A persisted admission is never evidence that dispatch did not occur. Reconcile that exact
  // operation first. In particular, a timeout cannot be followed by a second blind dispatch.
  if (state.admissions?.[operation.id]) {
    try {
      const result = await bounded(() =>
        service.reconcileDelegatedOperation({
          operationId: operation.id,
          authority: recovery?.reconciliationAuthority,
        }),
      )
      return hold(
        result.state === 'confirmed'
          ? 'operation-already-confirmed-verify-readback'
          : result.state === 'failed'
            ? 'operation-failed-governed-new-incident-required'
            : 'operation-outcome-unknown',
      )
    } catch {
      return hold('operation-reconciliation-unavailable')
    }
  }
  const anchors = (snapshot.events ?? []).filter(
    (event) =>
      event.kind === 'checkpoint' && event.payload?.recoveryContinuation?.incident === incident,
  )
  let anchor = anchors.at(-1)?.payload.recoveryContinuation ?? null
  if (
    anchor &&
    (anchor.version !== 1 ||
      anchor.classification !== classification.classification ||
      anchor.policyDigest !== policyDigest ||
      anchor.operationId !== operation.id ||
      anchor.grantId !== operationOptions?.grantId ||
      anchor.operationDigest !== recordDigest(operation) ||
      anchor.targetOwner !== recovery?.owner ||
      anchor.targetWriterDigest !== recordDigest(recovery?.writer) ||
      anchor.currentContractDigest !== recordDigest(currentContract) ||
      anchor.replacementContractDigest !== recordDigest(replacementContract) ||
      anchors.some(
        (event) => recordDigest(event.payload.recoveryContinuation) !== recordDigest(anchor),
      ))
  )
    return hold('recovery-continuation-unbound')
  if (!anchor && Math.max(attempts.length, prior.length) >= policy.maxAttempts)
    return hold('incident-attempt-budget-exhausted')
  const persistAttempt = async (continuation = null) => {
    await bounded(() =>
      service.record(
        'checkpoint',
        {
          reason: 'classified-execution-recovery',
          recoveryIncident: incident,
          recoveryPolicyDigest: policyDigest,
          classification: classification.classification,
          ...(continuation ? { recoveryContinuation: structuredClone(continuation) } : {}),
        },
        { expectedRevision: snapshot.revision, authority: recovery?.checkpointAuthority },
      ),
    )
    effects.push('source-attempt-checkpoint')
    snapshot = await readSource()
    state = snapshot.state
  }
  if (
    classification.classification === 'temporary-rate-limit' ||
    classification.classification === 'provider-unavailable'
  ) {
    const retryAt =
      classification.retryAt ?? nowMs + Math.min(policy.backoffMs * 2 ** attempts.length, 60000)
    if (retryAt >= policy.deadlineAt) return hold('retry-exceeds-deadline')
    try {
      await persistAttempt()
    } catch {
      return hold('attempt-checkpoint-unavailable')
    }
    return {
      status: 'retry-later',
      classification: classification.classification,
      retryAt,
      timingSource: classification.retryAt === null ? 'policy-backoff' : 'provider-retry-after',
      providerResetUnknown: classification.providerResetUnknown,
      obligation: {
        owner: safeId(owner) ? owner : 'operator',
        action: 'recheck-provider-before-retry',
        deadlineAt: policy.deadlineAt,
      },
      effects: [...effects],
    }
  }
  if (
    !tuple(currentContract) ||
    !tuple(replacementContract) ||
    currentContract.providerRoute === replacementContract.providerRoute
  )
    return hold('exhausted-provider-route-ineligible')
  if (
    typeof inspectRecoveryContext !== 'function' ||
    typeof readback !== 'function' ||
    typeof dispatch !== 'function'
  )
    return hold('trusted-host-ports-unavailable')
  if (recovery?.boundary !== state.boundary) return hold('recovery-source-boundary-changed')
  let continued = false
  if (anchor) {
    if (
      !Number.isSafeInteger(anchor.fromGeneration) ||
      anchor.targetGeneration !== anchor.fromGeneration + 1 ||
      anchor.revocationEpoch !== state.revocationEpoch ||
      anchor.candidateDigest !== state.candidateDigest ||
      anchor.oracleDigest !== state.oracleDigest ||
      anchor.boundary !== recovery.boundary
    )
      return hold('recovery-continuation-source-changed')
    if (state.generation === anchor.targetGeneration) {
      const anchorIndex = snapshot.events.indexOf(anchors.at(-1))
      const transfer = snapshot.events
        .slice(anchorIndex + 1)
        .find(
          (event) =>
            event.kind === 'resumed' &&
            event.generation === anchor.fromGeneration &&
            event.payload.owner === anchor.targetOwner &&
            recordDigest(event.payload.writer) === anchor.targetWriterDigest,
        )
      if (
        !transfer ||
        state.owner !== anchor.targetOwner ||
        recordDigest(state.writer) !== anchor.targetWriterDigest
      )
        return hold('recovery-continuation-owner-unbound')
      continued = true
    } else if (state.generation !== anchor.fromGeneration || state.owner !== anchor.fromOwner)
      return hold('recovery-continuation-owner-unbound')
  } else if (
    state.owner === recovery?.owner &&
    recordDigest(state.writer) === recordDigest(recovery?.writer)
  )
    return hold('recovery-continuation-unbound')
  // A current-generation continuation never asks source.resume to transfer again.
  if (
    operationOptions?.expectedRevision !== snapshot.revision ||
    operationOptions?.authority?.owner !== recovery?.owner ||
    operationOptions?.authority?.generation !==
      (continued ? state.generation : state.generation + 1)
  )
    return hold('recovery-operation-options-stale')
  const ensureCustody = async (authority) => {
    if (activeOracleCustody(snapshot)) return true
    if (typeof renewOracleCustody !== 'function') return false
    const scope = recordDigest({
      owner: state.owner,
      generation: state.generation,
      revocationEpoch: state.revocationEpoch,
      candidateDigest: state.candidateDigest,
      oracleDigest: state.oracleDigest,
      boundary: state.boundary,
      writer: state.writer,
      phase: state.phase,
      status: state.status,
    })
    await bounded(() =>
      renewOracleCustody({
        state: structuredClone(state),
        authority: structuredClone(authority),
        incident,
        operation: structuredClone(operation),
      }),
    )
    snapshot = await readSource()
    state = snapshot.state
    return (
      scope ===
        recordDigest({
          owner: state.owner,
          generation: state.generation,
          revocationEpoch: state.revocationEpoch,
          candidateDigest: state.candidateDigest,
          oracleDigest: state.oracleDigest,
          boundary: state.boundary,
          writer: state.writer,
          phase: state.phase,
          status: state.status,
        }) && activeOracleCustody(snapshot)
    )
  }
  try {
    if (!(await ensureCustody({ owner: state.owner, generation: state.generation })))
      return hold('source-oracle-custody-unresolved')
  } catch {
    return hold('attempt-checkpoint-or-custody-unavailable')
  }
  let evidence
  try {
    evidence = await bounded(() =>
      inspectRecoveryContext({
        state: structuredClone(state),
        currentContract: structuredClone(currentContract),
        replacementContract: structuredClone(replacementContract),
        incident,
        policyDigest,
        operation: structuredClone(operation),
      }),
    )
  } catch {
    return hold('recovery-context-unavailable')
  }
  const validEvidence = (value) =>
    !(
      value?.verified !== true ||
      value.runId !== state.runId ||
      value.revision !== state.revision ||
      value.generation !== state.generation ||
      value.incident !== incident ||
      value.policyDigest !== policyDigest ||
      value.operationDigest !== recordDigest(operation) ||
      !finite(value.observedAt) ||
      value.observedAt > currentTime() ||
      currentTime() - value.observedAt > 60000 ||
      value.currentContractDigest !== recordDigest(currentContract) ||
      value.replacementContractDigest !== recordDigest(replacementContract) ||
      ![
        'authorized',
        'healthy',
        'checkpointVerified',
        'custodyVerified',
        'reviewerIndependenceVerified',
        'capabilityFloorsVerified',
        'costPolicyVerified',
        'quotaIndependent',
      ].every((key) => value[key] === true) ||
      !artifacts(value.artifactDigests)
    )
  if (!validEvidence(evidence)) return hold('recovery-context-unverified')
  const selectFallback = () => {
    // Native safe-boundary verification (first transfer) or the exact source-backed
    // continuation (already transferred) precedes the selector.
    // Unknown health is never passed as the selector's legacy permissive null default.
    if (
      !Array.isArray(evidence.healthyPlatforms) ||
      !policy.fallback ||
      !safeId(policy.fallback.seat)
    )
      return 'fallback-policy-or-health-unverified'
    const selected = resolveTwoLevelFallback({
      ...policy.fallback,
      healthyPlatforms: evidence.healthyPlatforms,
      atPhaseBoundary: true,
    })
    if (
      !selected.ok ||
      selected.platform !== `${replacementContract.runtime}:${replacementContract.providerRoute}` ||
      ['runtime', 'model', 'effort'].some((key) => selected[key] !== replacementContract[key])
    )
      return 'fallback-selection-mismatch'
    return null
  }
  try {
    if (anchor && recordDigest(anchor.artifactDigests) !== recordDigest(evidence.artifactDigests))
      return hold('recovery-artifacts-changed')
    if (!anchor) {
      anchor = {
        version: 1,
        classification: classification.classification,
        incident,
        policyDigest,
        operationId: operation.id,
        grantId: operationOptions.grantId,
        operationDigest: recordDigest(operation),
        targetOwner: recovery.owner,
        targetWriterDigest: recordDigest(recovery.writer),
        fromOwner: state.owner,
        fromGeneration: state.generation,
        targetGeneration: state.generation + 1,
        revocationEpoch: state.revocationEpoch,
        candidateDigest: state.candidateDigest,
        oracleDigest: state.oracleDigest,
        boundary: recovery.boundary,
        currentContractDigest: recordDigest(currentContract),
        replacementContractDigest: recordDigest(replacementContract),
        artifactDigests: structuredClone(evidence.artifactDigests),
      }
      await persistAttempt(anchor)
      effects.push('source-continuation-checkpoint')
    }
    if (!continued) {
      const plan = await bounded(() =>
        service.recoveryPlan({
          owner: recovery.owner,
          boundary: recovery.boundary,
          writer: recovery.writer,
        }),
      )
      if (plan.blocked) return hold('source-recovery-blocked')
      const selectionHold = selectFallback()
      if (selectionHold) return hold(selectionHold)
      await bounded(() => service.resume({ plan, authority: recovery.authority }))
      effects.push('source-writer-transfer')
      snapshot = await readSource()
      state = snapshot.state
    } else {
      const selectionHold = selectFallback()
      if (selectionHold) return hold(selectionHold)
    }
    if (
      state.owner !== operationOptions.authority.owner ||
      state.generation !== operationOptions.authority.generation ||
      recordDigest(state.writer) !== anchor.targetWriterDigest ||
      state.revocationEpoch !== anchor.revocationEpoch ||
      state.candidateDigest !== anchor.candidateDigest ||
      state.oracleDigest !== anchor.oracleDigest
    )
      return hold('replacement-writer-unverified')
    if (!(await ensureCustody(operationOptions.authority)))
      return hold('source-oracle-custody-unresolved')
    const fresh = await bounded(() =>
      inspectRecoveryContext({
        state: structuredClone(state),
        currentContract: structuredClone(currentContract),
        replacementContract: structuredClone(replacementContract),
        incident,
        policyDigest,
        operation: structuredClone(operation),
      }),
    )
    if (
      !validEvidence(fresh) ||
      recordDigest(fresh.artifactDigests) !== recordDigest(anchor.artifactDigests)
    )
      return hold('replacement-context-unverified')
    evidence = fresh
    const resumed = snapshot
    try {
      await bounded(() =>
        service.executeDelegatedOperation(
          operation,
          { ...operationOptions, expectedRevision: resumed.revision },
          dispatch,
        ),
      )
      effects.push('delegated-operation-submitted')
    } catch {
      effects.push('delegated-operation-uncertain')
      /* Source reconciliation owns ambiguous dispatch outcomes, including timeouts. */
    }
    const reconciled = await bounded(() =>
      service.reconcileDelegatedOperation({
        operationId: operation.id,
        authority: operationOptions.authority,
      }),
    )
    if (reconciled.state !== 'confirmed')
      return hold(
        reconciled.state === 'failed'
          ? 'operation-failed-governed-new-incident-required'
          : 'operation-outcome-unknown',
      )
    const final = await readSource()
    const actual = await bounded(() =>
      readback({ state: structuredClone(final.state), incident, operationId: operation.id }),
    )
    if (
      actual?.verified !== true ||
      actual.runId !== final.state.runId ||
      actual.revision !== final.state.revision ||
      actual.generation !== final.state.generation ||
      actual.operationId !== operation.id ||
      actual.incident !== incident ||
      !finite(actual.observedAt) ||
      actual.observedAt > currentTime() ||
      currentTime() - actual.observedAt > 60000 ||
      !sameTuple(actual.contract, replacementContract) ||
      !artifacts(actual.artifactDigests) ||
      recordDigest(actual.artifactDigests) !== recordDigest(evidence.artifactDigests)
    )
      return hold('replacement-readback-unverified')
    const current = await readSource()
    if (current.revision !== final.revision || !activeOracleCustody(current))
      return hold('replacement-readback-source-changed')
    return {
      status: 'recovered',
      classification: classification.classification,
      runId: state.runId,
      generation: final.state.generation,
      operationId: operation.id,
      assurance: 'injected-host-source-verified',
      effects: [...effects],
    }
  } catch {
    return hold('source-recovery-or-reconciliation-held')
  }
}
