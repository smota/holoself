import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { callerSeat } from './seat-claim.mjs'
import { normalizeSeatId } from './seat-lease.mjs'
import { DOMAIN_STATUS_ENUM, OUTCOME_ENUM, QUEUE_ACTION_ENUM } from './seat-prime.mjs'

export const LEGACY_DECISION_ENUM = Object.freeze(['pass', 'blocked', 'returned', 'skipped'])

const LEGACY_TO_OUTCOME = Object.freeze({
  pass: 'delivered',
  blocked: 'concrete_blocker',
  returned: 'feasible_work_remains_same_worker',
  skipped: 'no_change',
})

const SAFE_ENVELOPE_ID = /^[A-Za-z0-9._-]+$/

export function validateEnvelopeId(id) {
  if (typeof id !== 'string' || !id.trim() || !SAFE_ENVELOPE_ID.test(id) || id.includes('..')) {
    throw new Error(
      `Invalid envelope id "${id}". Must match /^[A-Za-z0-9._-]+$/ with no path traversal.`,
    )
  }
  return id
}

function isDeliverySeat(seat) {
  return seat.startsWith('orch.') || seat.startsWith('dev.') || seat.startsWith('rev.')
}

function isBusyHoldActive(targetDir, explicitBusyHold) {
  if (typeof explicitBusyHold === 'boolean') return explicitBusyHold
  const root = resolve(targetDir)
  for (const rel of ['.agentflow/handoff/busy.json', '.agentflow/busy.json']) {
    const p = join(root, rel)
    if (!existsSync(p)) continue
    try {
      const data = JSON.parse(readFileSync(p, 'utf8'))
      if (data && (data.busy === true || data.active === true)) return true
    } catch {
      return true
    }
  }
  return false
}

export function normalizeOutcome({ outcome, decision }) {
  if (outcome) {
    if (!OUTCOME_ENUM.includes(outcome)) {
      throw new Error(`Invalid outcome "${outcome}". Expected one of: ${OUTCOME_ENUM.join(', ')}`)
    }
    return {
      outcome,
      decision:
        decision && [...LEGACY_DECISION_ENUM, ...OUTCOME_ENUM].includes(decision)
          ? decision
          : outcome,
    }
  }
  if (decision) {
    if (OUTCOME_ENUM.includes(decision)) {
      return { outcome: decision, decision }
    }
    if (LEGACY_DECISION_ENUM.includes(decision)) {
      return { outcome: LEGACY_TO_OUTCOME[decision], decision }
    }
    throw new Error(
      `Invalid decision "${decision}". Expected one of: ${[...LEGACY_DECISION_ENUM, ...OUTCOME_ENUM].join(', ')}`,
    )
  }
  throw new Error('Either outcome or decision is required to dispatch a transition envelope')
}

export function resolveNextCoordinatorAction(envelope) {
  const { outcome } = normalizeOutcome({
    outcome: envelope.outcome,
    decision: envelope.decision,
  })
  switch (outcome) {
    case 'feasible_work_remains_same_worker':
      return {
        action: 'redispatch_same_worker',
        targetSeat: envelope.from ?? envelope.fromRole ?? null,
      }
    case 'delivered':
      return {
        action: 'fanout_qa_and_review',
        targetSeats: ['dev.qa', 'rev.review'],
        targetSeat: 'dev.qa',
      }
    case 'concrete_blocker':
      return {
        action: 'escalate_coordinator',
        targetSeat: 'orch.arch',
      }
    case 'unknown_outcome':
      return {
        action: 'reconcile_state',
        targetSeat: 'orch.arch',
      }
    case 'repeated_failure':
      return {
        action: 'trip_circuit_breaker',
        targetSeat: 'steer.lead',
      }
    case 'no_change':
      return {
        action: 'close_slice',
        targetSeat: 'orch.arch',
      }
    default:
      throw new Error(`Unhandled outcome: ${outcome}`)
  }
}

export function dispatchEnvelope(
  targetDir,
  {
    id = null,
    to,
    from,
    outcome = null,
    decision = null,
    queueAction = 'handoff',
    domainStatus = 'in_progress',
    summary = '',
    issueRef = null,
    sliceId = null,
    closesEnvelopeId = null,
    result = {},
    callerVerified = undefined,
    callerSession = null,
    busyHoldActive = undefined,
    openrigActive = null,
    rigRunner = null,
    now,
  } = {},
) {
  if (!targetDir) throw new Error('targetDir is required for dispatchEnvelope')
  const normalizedTo = normalizeSeatId(to)
  const normalizedFrom = normalizeSeatId(from)

  if (id !== null && id !== undefined) {
    validateEnvelopeId(id)
  }

  const { outcome: resolvedOutcome, decision: resolvedDecision } = normalizeOutcome({
    outcome,
    decision,
  })

  if (!QUEUE_ACTION_ENUM.includes(queueAction)) {
    throw new Error(
      `Invalid queueAction "${queueAction}". Expected one of: ${QUEUE_ACTION_ENUM.join(', ')}`,
    )
  }
  if (!DOMAIN_STATUS_ENUM.includes(domainStatus)) {
    throw new Error(
      `Invalid domainStatus "${domainStatus}". Expected one of: ${DOMAIN_STATUS_ENUM.join(', ')}`,
    )
  }

  if (
    normalizedFrom.startsWith('pm.') &&
    isDeliverySeat(normalizedTo) &&
    isBusyHoldActive(targetDir, busyHoldActive)
  ) {
    throw new Error(
      `Product seat ${normalizedFrom} cannot dispatch directly to delivery seat ${normalizedTo} while delivery squad busy hold is active; use agentflow-sdlc handoff deliver`,
    )
  }

  if (domainStatus === 'goal_complete') {
    if (normalizedFrom !== 'steer.lead' && normalizedFrom !== 'human') {
      throw new Error(
        `Seat ${normalizedFrom} cannot declare domainStatus="goal_complete"; only steer.lead or human holds goal completion authority`,
      )
    }
    const parsedCaller = callerSession ? callerSeat(callerSession) : null
    const sessionMatchesSupervisory =
      parsedCaller?.seat === 'steer.lead' || process.env.AGENTFLOW_SUPERVISORY_VERIFIED === '1'
    if (
      callerVerified === false ||
      (callerSession !== null && !callerVerified && !sessionMatchesSupervisory)
    ) {
      throw new Error(
        `Unverified caller cannot declare domainStatus="goal_complete"; supervisory caller verification is required`,
      )
    }
  }

  const timestamp =
    now instanceof Date
      ? now.toISOString()
      : typeof now === 'string' && now.trim()
        ? new Date(Date.parse(now)).toISOString()
        : typeof now === 'number'
          ? new Date(now).toISOString()
          : new Date().toISOString()

  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        to: normalizedTo,
        from: normalizedFrom,
        outcome: resolvedOutcome,
        queueAction,
        domainStatus,
        summary,
        sliceId,
        issueRef,
        timestamp,
      }),
    )
    .digest('hex')
    .slice(0, 10)

  const envelopeId = id ? validateEnvelopeId(id) : `${timestamp.replace(/[:.]/g, '-')}-${digest}`

  const nextAction = resolveNextCoordinatorAction({
    from: normalizedFrom,
    to: normalizedTo,
    outcome: resolvedOutcome,
    decision: resolvedDecision,
  })

  const envelope = {
    version: 1,
    id: envelopeId,
    subject: summary || `${normalizedFrom} -> ${normalizedTo} (${resolvedOutcome})`,
    summary: summary || `${normalizedFrom} -> ${normalizedTo} (${resolvedOutcome})`,
    from: normalizedFrom,
    to: normalizedTo,
    fromRole: normalizedFrom,
    toRole: normalizedTo,
    outcome: resolvedOutcome,
    decision: resolvedDecision,
    queueAction,
    domainStatus,
    issueRef: issueRef ?? null,
    sliceId: sliceId ?? null,
    ...(closesEnvelopeId ? { closesEnvelopeId } : {}),
    result: result && typeof result === 'object' ? result : {},
    nextAction,
    timestamp,
  }

  const inboxDir = join(resolve(targetDir), '.agentflow', 'inbox', normalizedTo)
  mkdirSync(inboxDir, { recursive: true })
  const envelopePath = join(inboxDir, `${envelopeId}.json`)
  writeFileSync(envelopePath, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8')

  const isRigActive =
    typeof openrigActive === 'boolean'
      ? openrigActive
      : typeof rigRunner === 'function'
        ? true
        : Boolean(process.env.OPENRIG_SESSION_NAME || process.env.OPENRIG_NODE_ID)

  const resumeCommand = `agentflow-sdlc seat prime ${normalizedTo}`

  if (isRigActive) {
    const subverb = queueAction === 'handoff' ? 'handoff' : 'create'
    const rigArgs = [
      'queue',
      subverb,
      '--destination',
      normalizedTo,
      '--summary',
      envelope.summary,
      '--outcome',
      resolvedOutcome,
    ]
    const runner =
      typeof rigRunner === 'function'
        ? rigRunner
        : (args) =>
            spawnSync('rig', args, {
              cwd: resolve(targetDir),
              encoding: 'utf8',
            })
    const rigResult = runner(rigArgs, envelope)
    const rigFailed = Boolean(
      rigResult &&
      (rigResult.ok === false ||
        (typeof rigResult.status === 'number' && rigResult.status !== 0) ||
        rigResult.error),
    )

    if (rigFailed) {
      return {
        mode: 'inbox-fallback',
        rigFailed: true,
        id: envelopeId,
        envelope,
        envelopePath,
        rigArgs,
        rigResult,
        resumeCommand,
        nextAction,
      }
    }

    return {
      mode: 'openrig',
      id: envelopeId,
      envelope,
      envelopePath,
      rigArgs,
      rigResult,
      resumeCommand,
      nextAction,
    }
  }

  return {
    mode: 'inbox-fallback',
    id: envelopeId,
    envelope,
    envelopePath,
    resumeCommand,
    nextAction,
  }
}
