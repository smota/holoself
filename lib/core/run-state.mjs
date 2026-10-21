import {
  requireOraclePackageRequest,
  requireOraclePackageReceipt,
  oraclePackageProofIdentity,
} from './oracle-package.mjs'
import { requireOracleCustodyRequest, requireOracleCustodyReceipt } from './oracle-custody.mjs'
import {
  sealDeliveryRecord,
  requireDeliveryRecord,
  requireText,
  requireDigest,
} from './delivery-record.mjs'
import { validateDelegationPolicy, reduceDelegationEvent } from './delegation-grant.mjs'
import { verifyHostIntentConsent } from './intent-consent.mjs'
import { recordDigest } from './record-digest.mjs'

export const RUN_ROLES = [
  'product-manager',
  'analyst',
  'architect',
  'implementation-planner',
  'developer',
  'tester',
  'reviewer',
  'technical-writer',
  'pr-readiness',
]
export const RUN_EVENT_TYPES = Object.freeze([
  'started',
  'contract-frozen',
  'oracle-pinned',
  'oracle-custody-recorded',
  'candidate',
  'observation',
  'budget-admission',
  'advanced',
  'returned',
  'rework-resolved',
  'paused',
  'blocked',
  'resumed',
  'operation',
  'completed',
  'cancelled',
  'checkpoint',
  'grant-issued',
  'grant-revoked',
  'operation-admitted',
  'delegation-safety',
])
const boundaryOrder = ['observe', 'propose', 'mutate-worktree', 'open-pr', 'external-action']

export function createRunEvent({
  runId,
  id,
  previousDigest = null,
  generation = 0,
  kind,
  payload = {},
  timestamp = new Date().toISOString(),
}) {
  return sealDeliveryRecord('run-event', {
    runId,
    id,
    previousDigest,
    generation,
    kind,
    payload,
    timestamp,
  })
}

export function reduceRun(events) {
  let state = null
  const seen = new Map()
  for (const event of events) {
    requireDeliveryRecord(event, 'run-event')
    requireText(event.id, 'event id')
    requireText(event.runId, 'runId')
    if (!Number.isFinite(Date.parse(event.timestamp))) throw new Error('Invalid event timestamp')
    if (seen.has(event.id)) {
      if (seen.get(event.id) !== event.digest) throw new Error('Conflicting duplicate event')
      continue
    }
    seen.set(event.id, event.digest)
    if ((state?.revision ?? null) !== event.previousDigest) throw new Error('Stale event parent')
    const p = event.payload
    if (!state) {
      if (event.kind !== 'started' || event.generation !== 0)
        throw new Error('Run must start at generation zero')
      if (!['bounded', 'standard', 'high-assurance', 'exploratory'].includes(p.profile))
        throw new Error('Invalid profile')
      if (!boundaryOrder.includes(p.boundary)) throw new Error('Invalid action boundary')
      requireText(p.goalRef, 'goalRef')
      requireText(p.owner, 'owner')
      if (p.delegationPolicy) validateDelegationPolicy(p.delegationPolicy)
      state = {
        version: 1,
        runId: event.runId,
        goalRef: p.goalRef,
        profile: p.profile,
        boundary: p.boundary,
        authorityProtocol: p.authorityProtocol ?? 'legacy',
        owner: p.owner,
        writer: p.writer ?? null,
        budget: p.budget ?? null,
        budgetAdmission: null,
        generation: 0,
        status: 'active',
        phase: 0,
        candidateDigest: null,
        observations: [],
        openRework: {},
        operations: {},
        history: [],
        revision: null,
        grants: Object.create(null),
        admissions: Object.create(null),
        delegationPolicy: p.delegationPolicy ? structuredClone(p.delegationPolicy) : null,
        safetyUsed: 0,
        safetyRecords: [],
        revocationEpoch: 0,
        seenOperations: {},
        oraclePin: null,
        oracleDigest: null,
      }
    } else {
      if (event.runId !== state.runId || event.generation !== state.generation)
        throw new Error('Run identity or writer generation changed')
      const terminal = ['completed', 'cancelled'].includes(state.status)
      if (terminal && !(event.kind === 'operation' && p.kind === 'issue-projection'))
        throw new Error('Terminal run cannot be changed')
      if (
        state.status !== 'active' &&
        ![
          'checkpoint',
          'resumed',
          'operation',
          'cancelled',
          'delegation-safety',
          'grant-revoked',
        ].includes(event.kind)
      )
        throw new Error('Paused or blocked run requires recovery')
      if (
        ['paused', 'blocked'].includes(state.status) &&
        event.kind === 'operation' &&
        !(state.status === 'paused' && p.kind === 'provider-safe-stop') &&
        !['confirmed', 'failed', 'unknown'].includes(p.state)
      )
        throw new Error('Inactive runs may only reconcile operations')
      if (
        p.oracleAssuranceRequired === true &&
        ['contract-frozen', 'oracle-pinned'].includes(event.kind)
      )
        state.oracleAssuranceRequired = true
      if (event.kind === 'contract-frozen') {
        if (!p.contract?.criteria?.length || !p.sourceRevision)
          throw new Error('Contract requires criteria and source revision')
        const ids = p.contract.criteria.map((c) => requireText(c.id, 'criterion id'))
        if (new Set(ids).size !== ids.length) throw new Error('Duplicate acceptance criterion')
        state.contract = p.contract
        state.contractSourceRevision = p.sourceRevision
        state.observations = []
        if (p.oracleDigest || p.contract?.oracleDigest || p.oraclePin || p.contract?.oraclePin) {
          const digest =
            p.oracleDigest ??
            p.contract?.oracleDigest ??
            p.oraclePin?.oracleDigest ??
            p.contract?.oraclePin?.oracleDigest
          if (digest) {
            requireDigest(digest, 'oracle digest')
            if (
              state.oracleCustody &&
              Object.values(state.oracleCustody).some((receipt) => receipt.oracleDigest !== digest)
            )
              delete state.oracleCustody
            state.oracleDigest = digest
            state.oraclePin = p.oraclePin ??
              p.contract?.oraclePin ?? {
                type: 'oracle-pin',
                phase: 3,
                oracleDigest: digest,
                pinnedBefore: 'dev.build',
              }
          }
        }
      } else if (event.kind === 'oracle-pinned') {
        const digest = p.digest ?? p.oracleDigest ?? p.pin?.oracleDigest
        requireDigest(digest, 'oracle digest')
        if (
          state.oracleCustody &&
          Object.values(state.oracleCustody).some((receipt) => receipt.oracleDigest !== digest)
        )
          delete state.oracleCustody
        state.oracleDigest = digest
        if (p.oraclePackage) {
          const request = requireOraclePackageRequest(p.oraclePackage.request)
          const receipt = requireOraclePackageReceipt(p.oraclePackage.receipt, request)
          if (
            request.runId !== state.runId ||
            request.goalRef !== state.goalRef ||
            request.candidateDigest !== (state.candidateDigest ?? null) ||
            request.runRevision !== event.previousDigest ||
            request.generation !== state.generation ||
            request.revocationEpoch !== state.revocationEpoch ||
            request.stage !== 'pin' ||
            receipt.oracleDigest !== digest
          )
            throw new Error('Oracle package proof is stale for native pin')
          state.oraclePackage = structuredClone(p.oraclePackage)
          state.oracleAssuranceRequired = true
        }
        state.oraclePin = p.pin ?? {
          type: 'oracle-pin',
          phase: 3,
          oracleDigest: digest,
          pinnedBefore: p.seat ?? 'dev.build',
        }
      } else if (event.kind === 'oracle-custody-recorded') {
        const request = requireOracleCustodyRequest(p.request)
        const receipt = requireOracleCustodyReceipt(p.receipt, request)
        if (
          request.runId !== state.runId ||
          request.goalRef !== state.goalRef ||
          request.runRevision !== event.previousDigest ||
          request.generation !== state.generation ||
          request.revocationEpoch !== state.revocationEpoch ||
          request.oracleDigest !== state.oracleDigest ||
          request.candidateDigest !== (state.candidateDigest ?? null)
        )
          throw new Error('Oracle custody request is stale for current source state')
        state.oracleCustody = {
          ...state.oracleCustody,
          [request.mode === 'historical-author' ? 'author' : 'assignment']:
            structuredClone(receipt),
        }
      } else if (event.kind === 'candidate') {
        requireDigest(p.digest, 'candidate digest')
        if (state.oracleCustody && state.candidateDigest !== p.digest) delete state.oracleCustody
        state.candidateDigest = p.digest
        state.observations = []
      } else if (event.kind === 'observation') {
        requireDeliveryRecord(p.observation, 'verification-observation')
        if (p.observation.candidateDigest !== state.candidateDigest)
          throw new Error('Observation belongs to stale candidate')
        state.observations.push(p.observation)
      } else if (event.kind === 'budget-admission') {
        if (
          !state.budget ||
          typeof p.result?.admitted !== 'boolean' ||
          typeof p.result?.known !== 'boolean'
        )
          throw new Error('Budget admission requires a configured budget and explicit result')
        state.budgetAdmission = { ...p, observedAt: event.timestamp }
      } else if (event.kind === 'advanced') {
        if (state.status !== 'active' || Object.keys(state.openRework).length)
          throw new Error('Run blocked by state or rework')
        if (
          Object.values(state.operations).some((op) => !['confirmed', 'failed'].includes(op.state))
        )
          throw new Error('Unresolved external operation')
        if (p.from !== state.phase || p.to !== state.phase + 1 || p.to > 8)
          throw new Error('Invalid phase advancement')
        requireDigest(p.acceptanceDigest, 'acceptanceDigest')
        if (p.candidateDigest !== state.candidateDigest)
          throw new Error('Acceptance candidate changed')
        if (state.phase === 0 && state.authorityProtocol === 'host-intent-v1') {
          verifyHostIntentConsent(p.intentRequest, p.intentConsent, event.timestamp)
          if (
            p.intentRequest.runId !== state.runId ||
            p.intentRequest.runRevision !== event.previousDigest ||
            p.intentRequest.generation !== state.generation ||
            p.intentRequest.goalRef !== state.goalRef ||
            p.intentRequest.goalRevision !== state.contract?.goalRevision ||
            p.intentRequest.contractSourceRevision !== state.contractSourceRevision ||
            p.intentRequest.contractDigest !== recordDigest(state.contract) ||
            p.intentRequest.profile !== state.profile ||
            p.intentRequest.scope.businessBoundary !== state.boundary ||
            recordDigest(p.intentRequest.scope.budget) !== recordDigest(state.budget) ||
            p.intentRequest.planDigest !== p.planDigest
          )
            throw new Error('Intent consent does not bind this phase advance')
        }
        if (p.oracleDigest || p.oraclePin) {
          const digest = p.oracleDigest ?? p.oraclePin?.oracleDigest
          if (digest) {
            requireDigest(digest, 'oracle digest')
            if (
              state.oracleCustody &&
              Object.values(state.oracleCustody).some((receipt) => receipt.oracleDigest !== digest)
            )
              delete state.oracleCustody
            state.oracleDigest = digest
            state.oraclePin = p.oraclePin ?? {
              type: 'oracle-pin',
              phase: 3,
              oracleDigest: digest,
              pinnedBefore: 'dev.build',
            }
          }
        }
        if (state.oracleAssuranceRequired && state.phase === 3 && !p.oraclePackageVerification)
          throw new Error('Assured oracle developer proof required')
        if (state.oracleAssuranceRequired && [4, 5].includes(state.phase)) {
          const proof = p.oracleRuntimeEvidence
          if (
            !proof ||
            proof.candidateDigest !== state.candidateDigest ||
            proof.oracleDigest !== state.oracleDigest ||
            proof.manifestDigest !== state.oraclePackage?.receipt.manifestDigest ||
            proof.generation !== state.generation ||
            proof.revocationEpoch !== state.revocationEpoch ||
            !state.observations.some(
              (observation) =>
                observation.digest === proof.observationDigest &&
                observation.criterionId === state.oraclePackage.receipt.runtimeCriterionId &&
                observation.outcome === 'pass' &&
                observation.candidateDigest === state.candidateDigest,
            )
          )
            throw new Error(
              'Actual candidate runtime evidence required; calibration cannot satisfy execution',
            )
          state.oracleRuntimeEvidence = structuredClone(proof)
        }
        if (p.oraclePackageVerification) {
          const verified = p.oraclePackageVerification
          requireOraclePackageReceipt(verified.receipt, verified.request)
          if (
            verified.request.stage !== 'developer' ||
            verified.request.runRevision !== event.previousDigest ||
            verified.request.runId !== state.runId ||
            verified.request.goalRef !== state.goalRef ||
            verified.request.candidateDigest !== (state.candidateDigest ?? null) ||
            verified.request.generation !== state.generation ||
            verified.request.revocationEpoch !== state.revocationEpoch ||
            !state.oraclePackage ||
            recordDigest(oraclePackageProofIdentity(verified.receipt)) !==
              recordDigest(oraclePackageProofIdentity(state.oraclePackage.receipt))
          )
            throw new Error('Oracle developer package proof is stale')
          state.oraclePackageDeveloper = structuredClone(verified)
        }
        state.phase = p.to
        state.contract = null
        state.contractSourceRevision = null
      } else if (event.kind === 'returned') {
        const target = state.phase === 4 ? 3 : [6, 7, 8].includes(state.phase) ? 4 : null
        if (target === null || p.to !== target || !p.findings?.length)
          throw new Error('Invalid rework return')
        for (const finding of p.findings) {
          requireText(finding.id, 'finding id')
          requireText(finding.requiredChange, 'required change')
          if (state.openRework[finding.id]) throw new Error('Duplicate open finding')
          state.openRework[finding.id] = finding
        }
        state.phase = target
        state.contract = null
        state.contractSourceRevision = null
      } else if (event.kind === 'rework-resolved') {
        if (!state.openRework[p.id] || !p.observationDigests?.length)
          throw new Error('Rework resolution requires current evidence')
        for (const digest of p.observationDigests)
          if (!state.observations.some((o) => o.digest === digest && o.outcome === 'pass'))
            throw new Error('Missing passing rework observation')
        delete state.openRework[p.id]
      } else if (event.kind === 'paused' || event.kind === 'blocked') {
        requireText(p.reason, 'reason')
        state.status = event.kind
        state.reason = p.reason
      } else if (event.kind === 'resumed') {
        if (
          !['paused', 'blocked', 'active'].includes(state.status) ||
          p.previousOwnerStopped !== true
        )
          throw new Error('Prior writer must be confirmed stopped')
        const nextBoundary = boundaryOrder.indexOf(p.boundary)
        if (nextBoundary < 0 || nextBoundary > boundaryOrder.indexOf(state.boundary))
          throw new Error('Resume cannot widen authority')
        if (
          Object.values(state.operations).some((op) => !['confirmed', 'failed'].includes(op.state))
        )
          throw new Error('Reconcile operations before resume')
        requireText(p.owner, 'new owner')
        state.owner = p.owner
        state.generation += 1
        state.boundary = p.boundary
        state.status = 'active'
        delete state.reason
        if (p.invalidateCandidate) {
          delete state.oracleCustody
          state.candidateDigest = null
          state.observations = []
        }
        state.writer = p.writer ?? null
      } else if (event.kind === 'operation') {
        requireText(p.id, 'operation id')
        requireDigest(p.payloadDigest, 'operation payload digest')
        const prior = state.operations[p.id]
        const transitions = {
          planned: [
            'submitted',
            'failed',
            ...(state.admissions?.[p.id] ? ['unknown'] : []),
            ...(p.reconciliation?.state === 'confirmed' ? ['confirmed'] : []),
          ],
          submitted: ['confirmed', 'unknown', 'failed'],
          unknown: ['confirmed', 'failed'],
          confirmed: [],
          failed: [],
        }
        if (!prior && p.state !== 'planned')
          throw new Error('Operation intent must be durable first')
        if (
          prior &&
          (p.payloadDigest !== prior.payloadDigest || !transitions[prior.state]?.includes(p.state))
        )
          throw new Error('Invalid operation transition or changed payload')
        state.operations[p.id] = { ...prior, ...p }
      } else if (event.kind === 'completed') {
        if (
          state.oracleAssuranceRequired &&
          (!state.oracleRuntimeEvidence ||
            state.oracleRuntimeEvidence.candidateDigest !== state.candidateDigest ||
            state.oracleRuntimeEvidence.oracleDigest !== state.oracleDigest ||
            state.oracleRuntimeEvidence.manifestDigest !==
              state.oraclePackage?.receipt.manifestDigest ||
            state.oracleRuntimeEvidence.generation !== state.generation ||
            state.oracleRuntimeEvidence.revocationEpoch !== state.revocationEpoch)
        )
          throw new Error('Current assured candidate runtime evidence required for completion')
        if (
          state.phase !== 8 ||
          state.status !== 'active' ||
          Object.keys(state.openRework).length ||
          Object.values(state.operations).some((op) => !['confirmed', 'failed'].includes(op.state))
        )
          throw new Error('Run is not complete')
        requireDigest(p.acceptanceDigest, 'final acceptance')
        state.status = 'completed'
        if (p.candidateDigest !== state.candidateDigest)
          throw new Error('Final acceptance candidate changed')
      } else if (event.kind === 'cancelled') {
        if (
          Object.values(state.operations).some((op) => !['confirmed', 'failed'].includes(op.state))
        )
          throw new Error('Reconcile before cancellation')
        state.status = 'cancelled'
      } else if (reduceDelegationEvent(state, event)) {
        // Delegation is reduced against the same authoritative run chain.
      } else if (event.kind !== 'checkpoint')
        throw new Error(`Unsupported run event: ${event.kind}`)
    }
    if (
      state.oracleRuntimeEvidence &&
      (state.oracleRuntimeEvidence.candidateDigest !== state.candidateDigest ||
        state.oracleRuntimeEvidence.oracleDigest !== state.oracleDigest ||
        state.oracleRuntimeEvidence.generation !== state.generation ||
        state.oracleRuntimeEvidence.revocationEpoch !== state.revocationEpoch)
    )
      delete state.oracleRuntimeEvidence
    if (state.oraclePackage && state.oraclePackage.receipt.oracleDigest !== state.oracleDigest)
      delete state.oraclePackage
    if (
      state.oracleCustody &&
      Object.values(state.oracleCustody).some(
        (receipt) =>
          receipt.generation !== state.generation ||
          receipt.revocationEpoch !== state.revocationEpoch,
      )
    )
      delete state.oracleCustody
    if (event.kind === 'started' && p.oracleAssuranceRequired === true)
      state.oracleAssuranceRequired = true
    state.revision = event.digest
    state.history.push({
      id: event.id,
      kind: event.kind,
      timestamp: event.timestamp,
      digest: event.digest,
    })
  }
  return state
}

export function projectRunStatus(
  state,
  { durable = false, observedAt = new Date().toISOString() } = {},
) {
  if (!state) return { version: 1, status: 'absent', durable, observedAt }
  const pending = Object.values(state.operations).filter(
    (op) => !['confirmed', 'failed'].includes(op.state),
  )
  return {
    version: 1,
    runId: state.runId,
    status: state.status,
    role: RUN_ROLES[state.phase],
    candidateDigest: state.candidateDigest,
    owner: state.owner,
    generation: state.generation,
    boundary: state.boundary,
    budget: {
      configuration: state.budget,
      lastAdmission: state.budgetAdmission,
      usageKnown: state.budgetAdmission?.usageKnown === true,
    },
    openRework: Object.values(state.openRework),
    pendingOperations: pending,
    evidence: (state.contract?.criteria ?? []).map((criterion) => {
      const observation = state.observations.findLast(
        (item) =>
          item.criterionId === criterion.id &&
          item.definitionDigest === criterion.definitionDigest &&
          item.candidateDigest === state.candidateDigest,
      )
      return {
        criterionId: criterion.id,
        observationDigest: observation?.digest ?? null,
        observedOutcome: observation?.outcome ?? 'missing',
        acceptance: 'requires-source-resolution',
      }
    }),
    durable,
    revision: state.revision,
    observedAt,
    projectionStatus: pending.some((op) => op.kind === 'issue-projection') ? 'pending' : 'settled',
    nextAction: pending.length
      ? 'reconcile-operations'
      : ['completed', 'cancelled'].includes(state.status)
        ? 'none'
        : state.status !== 'active'
          ? 'inspect-recovery'
          : Object.keys(state.openRework).length
            ? 'resolve-rework'
            : !state.contract
              ? 'freeze-contract'
              : !state.candidateDigest
                ? 'collect-evidence'
                : 'verify-and-advance',
  }
}

// Bounded phase context links to full authority rather than copying the transcript.
export function projectRunContext(state) {
  if (!state) throw new Error('Run does not exist')
  return {
    version: 1,
    runId: state.runId,
    goalRef: state.goalRef,
    revision: state.revision,
    role: RUN_ROLES[state.phase],
    owner: state.owner,
    generation: state.generation,
    boundary: state.boundary,
    candidateDigest: state.candidateDigest,
    contract: state.contract ?? null,
    openRework: Object.values(state.openRework),
    pendingOperationIds: Object.values(state.operations)
      .filter((op) => !['confirmed', 'failed'].includes(op.state))
      .map((op) => op.id),
    authorityReferences: ['AGENTS.md', 'docs/agent-workflow.md', 'docs/issue-standards.md'],
    roleReference: `roles/${RUN_ROLES[state.phase]}/ROLE.md`,
  }
}
