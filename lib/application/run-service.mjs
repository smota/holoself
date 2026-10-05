import { randomUUID } from 'node:crypto'
import { emitObservation as emitOptionalObservation } from '../observability/observer.mjs'
import { createRunEvent, reduceRun, projectRunStatus, RUN_ROLES } from '../core/run-state.mjs'

// W8e / D3 — a governed block (a gate owing a human decision, unresolved evidence, a missing
// acceptance) is not a genuine error, and the caller that reports exit codes
// (scripts/run-delivery.mjs) needs to tell the two apart reliably. Before this type existed, that
// classification read the error MESSAGE with a regex, so "Human acceptance is unresolved" —
// obviously a governed block — matched none of the patterns and exited as a generic error, and any
// future rewording of a message that DID match could silently change its exit code. Throwing this
// type at the specific governed-block sites below makes the classification a fact about the error,
// not a guess about its wording.
export class GovernedBlockError extends Error {
  constructor(message) {
    super(message)
    this.name = 'GovernedBlockError'
    this.governed = true
  }
}
import { sealDeliveryRecord, requireDeliveryRecord } from '../core/delivery-record.mjs'
import { verifyObservation } from '../core/verification-observation.mjs'
import { verifyRoleAdvance } from '../core/role-collaboration.mjs'
import { recordDigest } from '../core/record-digest.mjs'
import { createIntentConsentRequest, verifyHostIntentConsent } from '../core/intent-consent.mjs'
import {
  createGate,
  satisfyGate,
  resolveRefreeze,
  deriveCrossings,
  GATE_CLASSES,
} from '../core/gate.mjs'
import { resolvePosture, requiredHumanGateClasses, DEFAULT_POSTURE } from '../core/posture.mjs'
import { loadSdlcConfig } from '../sdlc-state.mjs'
import {
  validateDeliveryContract,
  journeyCoverage,
  budgetAdmission,
  resolveDeliveryPolicy,
} from '../core/delivery-policy.mjs'
import {
  issueGrant as createGrant,
  resolveGrant as checkGrant,
  operationDigest,
  normalizeOperation,
  CONDITIONAL_ADMISSION,
  verifyDelegationDecision,
  safeKey,
  ACTION_BOUNDARIES,
} from '../core/delegation-grant.mjs'
import { actionBoundaryAllows } from '../sdlc-vocabulary.mjs'

// W8b2 D1 — "is a human required here?" has exactly one answer, derived from the posture the
// target configured (agent-workflow.config.json; default DEFAULT_POSTURE = 'assisted') combined
// with the change class's own configured floor, via the single pure function
// `requiredHumanGateClasses` (lib/core/posture.mjs), plus whatever the run's actual boundary
// crosses (deriveCrossings). A phase number never appears in this computation — see the deleted
// role-pass-count threshold this replaces (the old condition required six completed role passes
// before a high-assurance run's advance() ever asked a human).
//
// This used to combine `!effective.allowsSelfReview` with the crossings check via OR —
// `allowsSelfReview` answers a different question (may a reviewer review their own work) and,
// standing in for "is a human required", disagreed with `resolvePosture(...).humanGateClasses` in 9
// of 16 posture x change-class combinations, including the factory default (`assisted` +
// `bounded`/`standard`), where it silently required no human at all. `requiredHumanGateClasses` is
// now the only place that answers "which gate classes"; this function just asks whether that set is
// non-empty.
export function requiresHumanAcceptance({
  profile,
  boundary,
  posture = DEFAULT_POSTURE,
  config = {},
} = {}) {
  const effective = resolvePosture({ posture, changeClass: profile, config })
  const crossings = deriveCrossings({
    effectiveBoundary: boundary,
    requestedBoundary: effective.maxBoundary,
  })
  return requiredHumanGateClasses({ posture, changeClass: profile, config, crossings }).length > 0
}

// W8b2 D3 — advance() no longer asks one generic "is a human required" question at every role-pass
// transition. It maps the transition to the ONE gate class this product actually recognizes at that
// point in the pipeline: `adequacy-of-intent` when advancing off phase 0 (the product-manager's
// intent handoff — the run's own "intent freeze"), and `release-of-candidate` when advancing off
// the LAST phase (`pr-readiness`'s handoff into `completed` — the run's release). Every role-pass
// transition in between (phases 1-7) crosses neither declared gate class and asks nothing here; the
// agent-escalation class is raised separately, by verifyCriteria's drift path (see GATE_CLASSES
// import above), never by this generic check.
function gateClassForTransition(phase) {
  if (phase === 0) return GATE_CLASSES.adequacyOfIntent
  if (phase === RUN_ROLES.length - 1) return GATE_CLASSES.releaseOfCandidate
  return null
}

// W8c2 D2 — the escalation gate's subject is a digest over the specific drift a human is asked to
// judge, never the bare candidateDigest. Binding by candidate alone was the trap: a single human
// approval would become a permanent hole, silently passing every later, DIFFERENT drift on that same
// candidate. The subject covers the drifted criteria AND contract TOGETHER WITH the frozen revision
// they diverged from (recordDigest), so a resolution only ever covers the one change a human actually
// reviewed — a different drift (different criteria, different contract, or a re-freeze that changes
// the frozen revision) produces a different subject and escalates again (D3, test 3).
function resolveDrift({ state, current, sourceDrifted, submittedCriteria }) {
  const driftedCriteria = sourceDrifted ? (current?.value?.criteria ?? null) : submittedCriteria
  const driftedContract = sourceDrifted
    ? (current?.value ?? null)
    : { ...(state.contract ?? {}), criteria: submittedCriteria }
  return {
    driftedCriteria,
    driftedContract,
    subject: recordDigest({
      criteria: driftedCriteria,
      contract: driftedContract,
      frozenRevision: state.contractSourceRevision ?? null,
    }),
  }
}

// The host supplies authorization, resolvers and writer status. User-authored records do not grant authority.
export function createRunService({
  store,
  authorize,
  resolveContract,
  resolveCollaboration,
  resolveObservation,
  observeWriter,
  observeWorkspace,
  reconcileOperation,
  budget = null,
  policy = {},
  delegationPolicy = null,
  posture = DEFAULT_POSTURE,
  sdlcConfig = null,
  observeUsage,
  requestSafeStop,
  resolveHostIntentConsent,
  intentScope = null,
  platformConfig = {},
  clock = () => new Date().toISOString(),
  observer = null,
}) {
  if (typeof authorize !== 'function') throw new Error('Host authorization callback required')
  const deliveryPolicy = resolveDeliveryPolicy(policy, budget)
  const effectiveSdlcConfig = sdlcConfig ?? loadSdlcConfig()
  const scopeFor = (state) => (typeof intentScope === 'function' ? intentScope(state) : intentScope)
  const effectivePostureFor = (state) =>
    resolvePosture({ posture, changeClass: state.profile, config: effectiveSdlcConfig })
  const effectiveBoundaryFor = (state) => effectivePostureFor(state).maxBoundary
  const permitsBusinessAction = (state, action) =>
    !(
      action === 'merge' &&
      effectivePostureFor(state).humanGateClasses.includes(GATE_CLASSES.releaseOfCandidate)
    ) &&
    actionBoundaryAllows(state.boundary, ACTION_BOUNDARIES.get(action), effectiveSdlcConfig) &&
    actionBoundaryAllows(
      effectiveBoundaryFor(state),
      ACTION_BOUNDARIES.get(action),
      effectiveSdlcConfig,
    )
  const emitObservation = (event) => {
    emitOptionalObservation(observer, event)
  }
  let pendingAdmission = null
  const read = async () => {
    const snapshot = await store.read()
    return { ...snapshot, state: reduceRun(snapshot.events) }
  }
  const append = async (kind, payload, expected, authority, identity = {}) => {
    // Snapshot before the first asynchronous boundary. Callers and host callbacks
    // must not be able to change an already selected transition while IO waits.
    payload = structuredClone(payload)
    authority = structuredClone(authority)
    identity = structuredClone(identity)
    const snapshot = await read()
    if (snapshot.revision !== expected) throw new Error('Run changed; replan')
    const expectedOwner =
      identity.recoveryOwner ?? (kind === 'resumed' ? payload.owner : snapshot.state?.owner)
    if (
      snapshot.state &&
      (authority?.generation !== snapshot.state.generation || authority?.owner !== expectedOwner)
    )
      throw new Error('Obsolete writer identity or generation')
    if (
      !identity.preAuthorized &&
      (await authorize({
        kind: identity.authorizationKind ?? kind,
        payload,
        state: snapshot.state,
        authority,
      })) !== true
    )
      throw new Error('Action is not authorized')
    const event = createRunEvent({
      runId: snapshot.state?.runId ?? identity.runId,
      id: randomUUID(),
      previousDigest: expected,
      generation: snapshot.state?.generation ?? 0,
      kind,
      payload,
      timestamp: identity.timestamp ?? clock(),
    })
    const nextState = reduceRun([...snapshot.events, event])
    // Target metadata describes the validated proposal until append is acknowledged.
    // Only finite phase/role values cross the observation boundary, never payloads.
    const transition = {
      fromPhase: snapshot.state?.phase ?? null,
      fromRole: snapshot.state ? RUN_ROLES[snapshot.state.phase] : null,
      toPhase: nextState.phase,
      toRole: RUN_ROLES[nextState.phase],
    }
    emitObservation({
      kind: 'run_event_attempted',
      ...transition,
      eventKind: kind,
      runId: event.runId,
      eventId: event.id,
    })

    try {
      await store.append(event, expected)
    } catch (e) {
      e.pendingEvent = event
      if (kind === 'operation-admitted' && e.admissionOutcome !== 'not-committed')
        pendingAdmission = event
      emitObservation({
        kind: 'run_event_failed',
        ...transition,
        eventKind: kind,
        runId: event.runId,
        eventId: event.id,
        errorType: 'StoreError',
      })
      throw e
    }

    emitObservation({
      kind: 'run_event_appended',
      ...transition,
      eventKind: kind,
      runId: event.runId,
      eventId: event.id,
    })

    return projectRunStatus(reduceRun([...snapshot.events, event]), { durable: store.durable })
  }
  const service = {
    read,
    async assertPublicationAuthority(authority) {
      const { state } = await read()
      if (
        !state ||
        authority?.execute !== true ||
        authority?.boundary !== 'external-action' ||
        authority?.owner !== state.owner ||
        authority?.generation !== state.generation ||
        !actionBoundaryAllows(state.boundary, 'external-action', effectiveSdlcConfig) ||
        !actionBoundaryAllows(effectiveBoundaryFor(state), 'external-action', effectiveSdlcConfig)
      )
        throw new GovernedBlockError(
          'Publication requires current external-action business authority',
        )
      return state
    },
    async status() {
      return projectRunStatus((await read()).state, { durable: store.durable, observedAt: clock() })
    },
    async admitAttempt({ estimatedNext, authority }) {
      const { state } = await read()
      if (!state || authority?.owner !== state.owner || authority?.generation !== state.generation)
        throw new Error('Current writer identity and generation required for admission')
      if (state.status !== 'active') throw new Error('Active run required for admission')
      if ((await authorize({ kind: 'attempt', state, authority })) !== true)
        throw new Error('Attempt is not authorized')
      if (recordDigest(state.budget ?? null) !== recordDigest(budget))
        throw new Error('Run budget configuration changed; start a new reviewed run')
      if (!budget) return { admitted: true, level: 'unconfigured', known: false }
      const usage = typeof observeUsage === 'function' ? await observeUsage(state) : null
      const result = budgetAdmission({
        budget,
        used:
          usage?.verified === true && (!budget.unit || usage.unit === budget.unit)
            ? usage.used
            : null,
        estimatedNext,
        providerCanStop: typeof requestSafeStop === 'function',
      })
      const usageValue =
        usage?.verified === true &&
        (!budget.unit || usage.unit === budget.unit) &&
        Number.isFinite(usage.used) &&
        usage.used >= 0
          ? usage.used
          : null
      const admission = await append(
        'budget-admission',
        {
          result,
          used: usageValue,
          usageKnown: usageValue !== null,
          estimateKnown: Number.isFinite(estimatedNext) && estimatedNext >= 0,
          estimatedNext: Number.isFinite(estimatedNext) ? estimatedNext : null,
          unit: budget.unit ?? null,
        },
        state.revision,
        authority,
      )
      if (!result.admitted) {
        const checkpoint = await append(
          'paused',
          { reason: result.reason },
          admission.revision,
          authority,
        )
        result.safeStop = 'unavailable'
        let revision = checkpoint.revision,
          intent = null
        if (typeof requestSafeStop === 'function') {
          const pausedState = (await read()).state
          if (pausedState.revision !== revision)
            throw new Error('Run changed before stop authorization')
          if ((await authorize({ kind: 'safe-stop', state: pausedState, authority })) !== true) {
            result.safeStop = 'not-authorized'
            return result
          }
          const request = {
            runId: state.runId,
            generation: state.generation,
            owner: state.owner,
            reason: result.reason,
            runRevision: revision,
          }
          intent = {
            id: randomUUID(),
            kind: 'provider-safe-stop',
            payloadDigest: recordDigest(request),
            request,
            state: 'planned',
          }
          revision = (await append('operation', intent, revision, authority)).revision
          revision = (
            await append('operation', { ...intent, state: 'submitted' }, revision, authority)
          ).revision
        }
        // Persist the resumable boundary before asking an external provider to stop.
        // The provider must fence its own action against this writer generation.
        const stopState = (await read()).state
        if (stopState.revision !== revision) throw new Error('Run changed before safe stop')
        if (intent) {
          let stopped
          try {
            stopped = await requestSafeStop(stopState, {
              authority,
              revision,
              operationId: intent.id,
            })
            result.safeStop =
              stopped?.verified === true && stopped.stopped === true ? 'confirmed' : 'unknown'
          } catch {
            result.safeStop = 'unknown'
          }
          const reconciliation = {
            verified: result.safeStop === 'confirmed',
            state: result.safeStop,
            stopped: result.safeStop === 'confirmed',
          }
          await append(
            'operation',
            { ...intent, state: result.safeStop, reconciliation, result: reconciliation },
            revision,
            authority,
          )
        }
      }
      return result
    },
    async start({
      runId,
      goalRef,
      owner,
      profile = 'standard',
      boundary = 'observe',
      writer = null,
      authority,
    }) {
      return append(
        'started',
        {
          goalRef,
          owner,
          profile,
          boundary,
          writer,
          budget,
          authorityProtocol: 'host-intent-v1',
          ...(delegationPolicy ? { delegationPolicy } : {}),
        },
        null,
        authority,
        {
          runId,
        },
      )
    },
    async issueGrant(request, { expectedRevision, authority, parentId = null }) {
      request = structuredClone(request)
      authority = structuredClone(authority)
      const { state } = await read()
      if (!state || state.revision !== expectedRevision) throw new Error('Run changed; replan')
      if (!request.allowedActions?.every((action) => permitsBusinessAction(state, action)))
        throw new Error('Grant actions exceed run business authority')
      if (
        !state.delegationPolicy ||
        recordDigest(state.delegationPolicy) !== recordDigest(delegationPolicy)
      )
        throw new Error('Configured delegation policy changed')
      if (store.conditionalAdmission !== CONDITIONAL_ADMISSION)
        throw new Error('Source lacks conditional-admission capability')
      if (parentId !== null && (!safeKey(parentId) || !Object.hasOwn(state.grants, parentId)))
        throw new Error('Unknown parent grant ID')
      const parent = parentId === null ? null : state.grants[parentId]
      const authorization = await authorize(
        structuredClone({ kind: 'issue-grant', state, authority, request, parentId }),
      )
      if (authorization?.type !== 'delegation-issuance')
        throw new Error('Typed grant issuance required')
      const atTime = clock()
      const grant = createGrant(
        { ...request, issuerBinding: authorization },
        authorization.issuerId,
        parent?.envelope ?? null,
        { atTime, policy: state.delegationPolicy },
      )
      const result = await append('grant-issued', { grant }, expectedRevision, authority, {
        preAuthorized: true,
        timestamp: atTime,
      })
      return { ...result, grantId: grant.id }
    },
    async revokeGrant(id, reason, { expectedRevision, authority }) {
      authority = structuredClone(authority)
      const { state } = await read()
      const grant = state?.grants[id]
      if (!grant) throw new Error('Grant not found')
      const decision = await authorize(
        structuredClone({ kind: 'revoke-grant', state, authority, grant }),
      )
      verifyDelegationDecision(decision, 'delegation-revocation', grant, state)
      return append('grant-revoked', { id, reason }, expectedRevision, authority, {
        preAuthorized: true,
      })
    },
    async resolveGrant(id) {
      const { state } = await read()
      return state && Object.hasOwn(state.grants, id) ? structuredClone(state.grants[id]) : null
    },
    async reconcileAdmission(pendingEvent) {
      pendingEvent = structuredClone(pendingEvent)
      const snapshot = await read()
      const event = snapshot.events.find((e) => e.id === pendingEvent.id)
      if (!event) return { state: 'unknown', pendingEvent }
      if (event.digest !== pendingEvent.digest) throw new Error('Conflicting admission identity')
      if (pendingAdmission?.digest === event.digest) pendingAdmission = null
      return { state: 'acknowledged', event, requiresOperationReconciliation: true }
    },
    async admitOperation(supplied, { expectedRevision, authority, grantId }) {
      const operation = normalizeOperation(supplied)
      authority = structuredClone(authority)
      if (pendingAdmission) {
        const error = new Error('Pending admission requires exact-event reconciliation')
        error.pendingEvent = pendingAdmission
        throw error
      }
      const { state } = await read()
      if (!state) throw new Error('Run not found')
      if (!permitsBusinessAction(state, operation.action))
        throw new Error('Operation exceeds run business authority')
      if (authority?.owner !== state.owner || authority?.generation !== state.generation)
        throw new Error('Obsolete writer identity or generation')
      if (store.conditionalAdmission !== CONDITIONAL_ADMISSION)
        throw new Error('Source lacks conditional-admission capability')
      if (
        !delegationPolicy ||
        recordDigest(state.delegationPolicy) !== recordDigest(delegationPolicy)
      )
        throw new Error('Configured delegation policy changed')
      const digest = operationDigest(operation)
      const existing = state.admissions[operation.id]
      if (existing) {
        if (existing.operationDigest !== digest || existing.grantId !== grantId)
          throw new Error('Conflicting operation ID')
        return {
          admitted: true,
          replayed: true,
          receipt: existing,
          requiresOperationReconciliation: true,
        }
      }
      if (
        Object.keys(state.admissions).some(
          (id) => !['confirmed', 'failed'].includes(state.operations[id]?.state),
        )
      )
        throw new Error(
          'Unresolved admitted operation requires reconciliation before new admission',
        )
      if (state.revision !== expectedRevision) throw new Error('Run changed; replan')
      const grant = state.grants[grantId]
      if (!grant) throw new Error('Grant not found')
      const decision = await authorize(
        structuredClone({
          kind: 'resolve-grant',
          state,
          authority,
          grant,
          operation,
          operationDigest: digest,
        }),
      )
      verifyDelegationDecision(decision, 'delegation-resolution', grant, state)
      if (decision.operationDigest !== digest || decision.delegate !== operation.delegate)
        throw new Error('Typed resolution operation mismatch')
      const resolution = checkGrant(grant.envelope, state, operation, clock())
      if (!resolution.admitted) throw new Error(`Admission rejected: ${resolution.reason}`)
      const result = await append(
        'operation-admitted',
        {
          grantId,
          grantRevision: grant.revision,
          grantEpoch: grant.revocationEpoch,
          operation,
          operationDigest: digest,
          authorization: decision,
          writer: state.owner,
          runRevision: state.revision,
          generation: state.generation,
        },
        expectedRevision,
        authority,
        { preAuthorized: true },
      )
      return {
        ...result,
        admitted: true,
        replayed: false,
        receipt: (await read()).state.admissions[operation.id],
      }
    },
    async executeDelegatedOperation(operation, options, dispatch) {
      if (typeof dispatch !== 'function') throw new Error('Dispatch adapter required')
      operation = normalizeOperation(operation)
      options = structuredClone(options)
      const admission = await service.admitOperation(operation, options)
      // Replaying an acknowledged admission never infers that dispatch did not happen.
      if (admission.replayed) return admission
      // Continue exclusively from the acknowledged persisted identity, never the
      // caller's object, even when approval or source IO yielded for a long time.
      operation = structuredClone(admission.receipt.operation)
      const intent = {
        id: operation.id,
        kind: operation.action,
        payloadDigest: admission.receipt.operationDigest,
        state: 'planned',
      }
      const planned = await append('operation', intent, admission.revision, options.authority, {
        preAuthorized: true,
      })
      const submitted = await append(
        'operation',
        { ...intent, state: 'submitted' },
        planned.revision,
        options.authority,
        { preAuthorized: true },
      )
      try {
        const result = await dispatch(structuredClone(operation), admission.receipt)
        // Dispatch return alone is not authoritative provider confirmation; S3 reconciles it.
        return {
          ...admission,
          revision: submitted.revision,
          dispatchResult: result,
          requiresOperationReconciliation: true,
        }
      } catch (error) {
        await append(
          'operation',
          { ...intent, state: 'unknown', reason: 'Dispatch outcome unknown' },
          submitted.revision,
          options.authority,
          { preAuthorized: true },
        )
        throw error
      }
    },
    async safetyCheckpoint(payload, { expectedRevision, authority }) {
      if (payload?.outcome !== undefined)
        throw new Error('Operation outcomes require source reconciliation')
      return append('delegation-safety', payload, expectedRevision, authority)
    },
    async reconcileDelegatedOperation({ operationId, authority }) {
      authority = structuredClone(authority)
      const { state } = await read()
      if (!state || authority?.owner !== state.owner || authority?.generation !== state.generation)
        throw new Error('Current writer identity and generation required for reconciliation')
      const admitted = state.admissions[operationId]
      let operation = state.operations[operationId]
      if (!admitted) throw new Error('Admitted durable operation required')
      if (!operation) {
        // A crash after admission is not proof that dispatch never happened.
        operation = {
          id: operationId,
          kind: admitted.operation.action,
          payloadDigest: admitted.operationDigest,
          state: 'unknown',
          reason: 'Interrupted admitted operation',
        }
        const planned = await append(
          'operation',
          { ...operation, state: 'planned' },
          state.revision,
          authority,
        )
        await append('operation', operation, planned.revision, authority)
      }
      if (['confirmed', 'failed'].includes(operation.state))
        return { state: operation.state, replayed: true, reconciliation: operation.reconciliation }
      if (typeof reconcileOperation !== 'function') return { state: 'unknown' }
      const outcome = await reconcileOperation(
        structuredClone(operation),
        structuredClone(admitted),
      )
      if (outcome?.verified !== true || !['confirmed', 'failed'].includes(outcome.state))
        return { state: 'unknown' }
      const latestSnapshot = await read()
      if (
        !latestSnapshot.state ||
        authority?.owner !== latestSnapshot.state.owner ||
        authority?.generation !== latestSnapshot.state.generation
      )
        throw new Error('Current writer identity and generation required for reconciliation')
      const currentOperation = latestSnapshot.state.operations[operationId]
      if (currentOperation && ['confirmed', 'failed'].includes(currentOperation.state))
        return {
          state: currentOperation.state,
          replayed: true,
          reconciliation: currentOperation.reconciliation,
        }
      const result = await append(
        'delegation-safety',
        {
          id: randomUUID(),
          kind: 'reconcile',
          reason: 'Authoritative provider outcome',
          operationId,
          outcome: structuredClone(outcome),
        },
        latestSnapshot.revision,
        authority,
      )
      return { ...result, state: outcome.state, reconciliation: outcome }
    },
    async record(kind, payload, { expectedRevision, authority }) {
      if (
        ![
          'candidate',
          'observation',
          'returned',
          'checkpoint',
          'operation',
          'blocked',
          'paused',
        ].includes(kind)
      )
        throw new Error('Use governed service for this transition')
      if (kind === 'operation' && !['planned', 'submitted', 'unknown'].includes(payload.state))
        throw new Error('Operation outcomes require source reconciliation')
      return append(kind, payload, expectedRevision, authority)
    },
    async freezeContract({ expectedRevision, authority }) {
      const { state } = await read()
      if (state?.revision !== expectedRevision || typeof resolveContract !== 'function')
        throw new Error('Current authoritative contract resolver required')
      const contract = await resolveContract(state)
      if (
        contract?.verified !== true ||
        !validateDeliveryContract(contract.value).ok ||
        !contract.sourceRevision
      )
        throw new Error('Authoritative acceptance criteria unavailable')
      if (deliveryPolicy.requiredJourneyCoverage && !contract.value.journeys?.length)
        throw new Error('Journey coverage required by domain policy')
      return append(
        'contract-frozen',
        { contract: contract.value, sourceRevision: contract.sourceRevision },
        expectedRevision,
        authority,
      )
    },
    async verifyCriteria(contract) {
      const { state, events } = await read()
      if (
        !state ||
        contract.candidateDigest !== state.candidateDigest ||
        contract.runRevision !== state.revision
      )
        throw new Error('Acceptance contract is stale')
      const current = typeof resolveContract === 'function' ? await resolveContract(state) : null
      const sourceDrifted =
        !state.contract ||
        current?.verified !== true ||
        current.sourceRevision !== state.contractSourceRevision ||
        recordDigest(current.value) !== recordDigest(state.contract)
      const submittedCriteria = Array.isArray(contract.criteria)
        ? contract.criteria.map(({ observationDigest, ...criterion }) => criterion)
        : null
      const criteriaDrifted =
        !sourceDrifted &&
        (submittedCriteria === null ||
          recordDigest(submittedCriteria) !== recordDigest(state.contract.criteria))
      // Detecting drift and then crashing wastes the detection: the run has no durable record of
      // what happened, and the human who could resolve it never sees anything. An agent cannot
      // proceed honestly past drifted intent, so it escalates to a human via a gate instead of
      // aborting the run.
      if (sourceDrifted || criteriaDrifted) {
        const drift = resolveDrift({ state, current, sourceDrifted, submittedCriteria })
        // W8c2 D3 — DEFECT FIXED. `resolveEscalation` durably records a human's resolution as a
        // `checkpoint` event, but this function used to never consult it: every subsequent call on
        // a drifted plan escalated again forever, even after a human had already agreed. Read the
        // run's own events (never lib/core/run-state.mjs — no new typed state field, no reducer
        // change) for a resolution whose gate subject equals THIS drift's subject (D2). Only a
        // resolution over the exact same drift counts; a different drift has a different subject and
        // still escalates below.
        const resolved = events.some(
          (event) =>
            event.kind === 'checkpoint' &&
            event.payload?.kind === 'escalation-resolved' &&
            event.payload.gate?.gateClass === GATE_CLASSES.agentEscalation &&
            event.payload.gate?.subjectDigest === drift.subject,
        )
        if (!resolved) {
          const direction = resolveRefreeze({
            previousCriteria: state.contract?.criteria ?? null,
            nextCriteria: drift.driftedCriteria,
          })
          return sealDeliveryRecord('run-acceptance', {
            candidateDigest: state.candidateDigest,
            runRevision: state.revision,
            results: [],
            coverage: null,
            status: 'escalated',
            gate: createGate({
              gateClass: GATE_CLASSES.agentEscalation,
              subjectDigest: drift.subject,
              subjectKind: 'candidateDigest',
              requiredRole: 'reviewer',
              hints: [
                {
                  id: 'drift-source',
                  value: sourceDrifted ? 'frozen-contract' : 'submitted-criteria',
                  interpretation: sourceDrifted
                    ? 'The authoritative acceptance contract changed since this run froze it.'
                    : 'The criteria submitted for verification differ from what was frozen.',
                },
                {
                  id: 'refreeze-direction',
                  value: direction,
                  interpretation:
                    direction === 'weakening'
                      ? 'Acceptance became less strict, or the change could not be confirmed safe; the full adequacy gate must run again.'
                      : 'Scope narrowed without relaxing what remains.',
                },
              ],
            }),
          })
        }
        // A human already resolved exactly this drift: honour it and fall through to evaluate the
        // submitted criteria below, exactly as if no drift had been detected.
      }
      if (!Array.isArray(contract.criteria) || !contract.criteria.length)
        throw new Error('Explicit acceptance criteria required')
      const results = []
      for (const criterion of contract.criteria) {
        const observation = state.observations.find(
          (item) =>
            item.digest === criterion.observationDigest && item.criterionId === criterion.id,
        )
        const resolved =
          typeof resolveObservation === 'function' && observation
            ? await resolveObservation(observation)
            : null
        results.push(
          verifyObservation({
            observation: resolved?.observation ?? observation,
            candidateDigest: state.candidateDigest,
            definitionDigest: criterion.definitionDigest,
            requiredAssertions: criterion.assertions,
            allowedOrigins: (
              criterion.allowedOrigins ?? deliveryPolicy.deterministicOrigins
            ).filter((origin) => deliveryPolicy.deterministicOrigins.includes(origin)),
            requireImmutable: criterion.requireImmutable,
            maxAgeMs: criterion.maxAgeMs ?? null,
            now: clock(),
            sourceVerified:
              resolved?.verified === true && resolved.observation?.digest === observation?.digest,
          }),
        )
      }
      const coverage = journeyCoverage({
        journeys: state.contract.journeys ?? [],
        criteria: state.contract.criteria,
        candidateDigest: state.candidateDigest,
        observations: contract.criteria.map((c, i) => ({
          criterionId: c.id,
          candidateDigest: state.candidateDigest,
          resolution: results[i],
        })),
      })
      return sealDeliveryRecord('run-acceptance', {
        candidateDigest: state.candidateDigest,
        runRevision: state.revision,
        results,
        coverage,
        status:
          results.every((r) => r.status === 'pass') && coverage.status === 'pass'
            ? 'pass'
            : 'blocked',
      })
    },
    async advance({ contract, authority }) {
      const { state } = await read()
      // W8b2 D3 — no phase number gates this any more (a phase number only ever selects WHICH gate
      // class this specific transition crosses, via gateClassForTransition, never whether a human
      // is required in general). Whether a human is required for THAT class is resolved once, the
      // same way everywhere (requiredHumanGateClasses), from posture + the change class's floor +
      // whatever the run's actual boundary crosses — never from how many role passes have completed.
      const transitionGateClass = state ? gateClassForTransition(state.phase) : null
      const gateRequired =
        state &&
        transitionGateClass &&
        requiredHumanGateClasses({
          posture,
          changeClass: state.profile,
          config: effectiveSdlcConfig,
          crossings: deriveCrossings({
            effectiveBoundary: state.boundary,
            requestedBoundary: resolvePosture({
              posture,
              changeClass: state.profile,
              config: effectiveSdlcConfig,
            }).maxBoundary,
          }),
        }).includes(transitionGateClass)
      if (
        gateRequired &&
        transitionGateClass !== GATE_CLASSES.adequacyOfIntent &&
        (await authorize({ kind: 'human-acceptance', state, authority, contract })) !== true
      )
        throw new GovernedBlockError('Human acceptance is unresolved')
      const collaboration =
        typeof resolveCollaboration === 'function' ? await resolveCollaboration(state) : null
      if (
        collaboration?.verified !== true ||
        !verifyRoleAdvance({
          ...collaboration.sources,
          openReworkRequests: Object.values(state.openRework),
        }).ok
      )
        throw new Error('Current bilateral role acceptance is required')
      const sources = collaboration.sources,
        frozen = state.contract
      if (
        !frozen ||
        sources.handoff?.subject !== state.goalRef ||
        sources.contract?.candidateDigest !== state.candidateDigest ||
        sources.contract?.digest !== frozen.collaborationContractDigest ||
        sources.contract?.ownerRole !== frozen.ownerRole ||
        sources.contract?.deliveryRole !== `agentflow:${RUN_ROLES[state.phase]}`
      )
        throw new Error('Bilateral acceptance belongs to another run, candidate or phase')
      const acceptance = await this.verifyCriteria(contract)
      // W8f D5 — an unresolved escalation and failed evidence are different things an orchestrator
      // must act on differently: one needs a human decision, the other needs new evidence. Name the
      // gate class so the caller (scripts/run-delivery.mjs, and whoever reads its error) can tell
      // them apart instead of seeing the same generic message either way.
      if (acceptance.status === 'escalated')
        throw new GovernedBlockError(
          `Acceptance blocked by unresolved ${acceptance.gate.gateClass} gate; a human decision is owed, not more evidence`,
        )
      if (acceptance.status !== 'pass')
        throw new GovernedBlockError('Acceptance blocked by unresolved verification')
      let intentRequest = null,
        intentConsent = null
      if (gateRequired && transitionGateClass === GATE_CLASSES.adequacyOfIntent) {
        if (typeof resolveHostIntentConsent !== 'function')
          throw new GovernedBlockError('Host-observed intent consent is unavailable')
        intentRequest = createIntentConsentRequest({
          state,
          planDigest: recordDigest(contract),
          scope: scopeFor(state),
          platformConfig,
        })
        try {
          intentConsent = verifyHostIntentConsent(
            intentRequest,
            await resolveHostIntentConsent(structuredClone(intentRequest)),
            clock(),
          )
        } catch (error) {
          if (error instanceof GovernedBlockError) throw error
          throw new GovernedBlockError('Host-observed intent consent is unresolved or mismatched')
        }
        const latest = await read()
        const current =
          typeof resolveContract === 'function' ? await resolveContract(latest.state) : null
        if (
          latest.revision !== state.revision ||
          current?.verified !== true ||
          current.sourceRevision !== state.contractSourceRevision ||
          recordDigest(current.value) !== recordDigest(state.contract) ||
          recordDigest(scopeFor(latest.state)) !== recordDigest(intentRequest.scope)
        )
          throw new GovernedBlockError('Frozen intent changed after host consent')
      }
      return append(
        state.phase === 8 ? 'completed' : 'advanced',
        {
          from: state.phase,
          to: state.phase + 1,
          candidateDigest: state.candidateDigest,
          acceptanceDigest: acceptance.digest,
          ...(intentConsent ? { planDigest: recordDigest(contract) } : {}),
          ...(intentConsent ? { intentRequest, intentConsent } : {}),
        },
        acceptance.runRevision,
        authority,
      )
    },
    async resolveRework({ id, contract, authority }) {
      const acceptance = await this.verifyCriteria(contract)
      const { state } = await read()
      const finding = state.openRework[id]
      if (
        !finding ||
        acceptance.status !== 'pass' ||
        !finding.criteria?.length ||
        finding.criteria.some((id) => !contract.criteria.some((criterion) => criterion.id === id))
      )
        throw new Error('Rework requires verified evidence for every finding criterion')
      return append(
        'rework-resolved',
        {
          id,
          observationDigests: contract.criteria
            .filter((c) => finding.criteria.includes(c.id))
            .map((c) => c.observationDigest),
        },
        acceptance.runRevision,
        authority,
      )
    },
    // D5 (W8c) — the path to satisfaction the `agent-escalation` gate class was missing entirely:
    // verifyCriteria's drift path (above) raises the gate but nothing let a human resolve it. This
    // requires the same `satisfyGate` every other gate in this product is resolved by: only a real
    // human attestation (decision 'agree', reviewer independence 'human-gate', the registered human
    // platform — see lib/core/gate.mjs) over the gate's OWN subject resolves it. The resolution is
    // appended as a `checkpoint` — the same opaque, always-accepted event kind the actuator's
    // gate-pending record uses — so no change to the run state machine or its reducer is needed to
    // record it durably. Reachable via `agentflow-sdlc run resolve-escalation`
    // (scripts/run-delivery.mjs), itself reachable via `bin/cli.mjs run`.
    //
    // W8c2 D2/D3 — the gate is no longer built from `state.candidateDigest` alone (that was the trap:
    // binding by candidate would let one approval silently cover every later, different drift on the
    // same candidate). It is reconstructed by calling THIS SERVICE's own `verifyCriteria` with the
    // SAME `contract` the caller is asking a human to judge — the exact plan verifyCriteria would
    // otherwise escalate on. That keeps subject computation in exactly one place (resolveDrift, used
    // by verifyCriteria's drift path) so resolution can never diverge from escalation, and it is
    // still never trusted from the caller: `contract` only re-derives the digest, it is not accepted
    // as one.
    async resolveEscalation({ expectedRevision, authority, attestation, contract }) {
      const { state } = await read()
      if (!state || state.revision !== expectedRevision) throw new Error('Run changed; replan')
      if (!state.candidateDigest) throw new Error('No escalated candidate to resolve')
      const acceptance = await this.verifyCriteria(contract)
      if (acceptance.status !== 'escalated')
        throw new Error('No unresolved escalation for the submitted contract')
      const verdict = satisfyGate(acceptance.gate, attestation)
      if (!verdict.ok) throw new Error(`Escalation not resolved: ${verdict.errors.join('; ')}`)
      return append(
        'checkpoint',
        { kind: 'escalation-resolved', gate: acceptance.gate, attestation },
        expectedRevision,
        authority,
      )
    },
    async reconcile(id, { expectedRevision, authority }) {
      const { state } = await read()
      if (
        state.revision !== expectedRevision ||
        !state.operations[id] ||
        typeof reconcileOperation !== 'function'
      )
        throw new Error('Current operation resolver required')
      const result = await reconcileOperation(state.operations[id])
      if (result?.verified !== true || !['confirmed', 'failed'].includes(result.state))
        throw new Error('External operation outcome remains unknown')
      return append(
        'operation',
        { ...state.operations[id], state: result.state, reconciliation: result, result },
        expectedRevision,
        authority,
      )
    },
    async recoveryPlan({ owner, boundary, writer }) {
      const { state, sourceRevision } = await read()
      if (!state) throw new Error('Run does not exist')
      const priorWriter =
        typeof observeWriter === 'function' ? await observeWriter(state) : { stopped: null }
      const workspace =
        typeof observeWorkspace === 'function' ? await observeWorkspace(state) : null
      const pending = Object.values(state.operations).filter(
        (op) => !['confirmed', 'failed'].includes(op.state),
      )
      const operations = []
      for (const operation of pending)
        operations.push({
          id: operation.id,
          result:
            typeof reconcileOperation === 'function'
              ? await reconcileOperation(operation, state.admissions[operation.id])
              : { state: 'unknown' },
        })
      return sealDeliveryRecord('recovery-plan', {
        runId: state.runId,
        runRevision: state.revision,
        sourceRevision: sourceRevision ?? null,
        owner,
        boundary,
        writer: writer ?? null,
        priorWriter,
        workspace,
        operations,
        candidateChanged: workspace?.candidateDigest !== state.candidateDigest,
        blocked:
          priorWriter?.stopped !== true ||
          !writer?.instance ||
          !writer?.host ||
          !Number.isInteger(writer?.pid) ||
          writer.pid < 1 ||
          !workspace ||
          workspace.verified !== true ||
          operations.some(
            (op) =>
              op.result?.verified !== true || !['confirmed', 'failed'].includes(op.result?.state),
          ),
      })
    },
    async resume({ plan, authority }) {
      requireDeliveryRecord(plan, 'recovery-plan')
      const current = await this.recoveryPlan({
        owner: plan.owner,
        boundary: plan.boundary,
        writer: plan.writer,
      })
      if (current.digest !== plan.digest || current.blocked)
        throw new Error('Recovery changed or remains blocked')
      let { state, sourceRevision } = await read()
      if (
        state.revision !== plan.runRevision ||
        (sourceRevision ?? null) !== current.sourceRevision
      )
        throw new Error('Run changed during recovery inspection')
      let expectedRevision = plan.runRevision
      for (const op of current.operations) {
        const old = state.operations[op.id]
        const own = await append(
          'operation',
          { ...old, state: op.result.state, reconciliation: op.result },
          expectedRevision,
          authority,
          { recoveryOwner: plan.owner, authorizationKind: 'takeover-reconciliation' },
        )
        expectedRevision = own.revision
      }
      const finalWriter = typeof observeWriter === 'function' ? await observeWriter(state) : null
      const finalWorkspace =
        typeof observeWorkspace === 'function' ? await observeWorkspace(state) : null
      const finalSource = await read()
      if (
        finalWriter?.stopped !== true ||
        finalWorkspace?.verified !== true ||
        finalSource.revision !== expectedRevision ||
        recordDigest(finalWorkspace) !== recordDigest(current.workspace)
      )
        throw new Error('Recovery context changed before writer transfer')
      return append(
        'resumed',
        {
          owner: plan.owner,
          writer: plan.writer,
          boundary: plan.boundary,
          previousOwnerStopped: true,
          invalidateCandidate: current.candidateChanged,
        },
        expectedRevision,
        authority,
      )
    },
  }
  return service
}
