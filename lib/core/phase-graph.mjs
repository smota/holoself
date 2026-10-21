// The SDLC phase machine. A medium stores transitions. It does not decide them.

export const PHASES = Object.freeze([
  { phase: 0, role: 'product-manager', seat: 'pm.manager' },
  { phase: 1, role: 'analyst', seat: 'pm.analyst' },
  { phase: 2, role: 'architect', seat: 'orch.arch' },
  { phase: 3, role: 'implementation-planner', seat: 'orch.arch' },
  { phase: 4, role: 'developer', seats: ['dev.build-jr', 'dev.build', 'dev.build-sr'] },
  { phase: 5, role: 'tester', seat: 'dev.qa' },
  { phase: 6, role: 'reviewer', seat: 'rev.review' },
  { phase: 7, role: 'technical-writer', seat: 'orch.arch' },
  { phase: 8, role: 'pr-readiness', seat: 'orch.arch' },
])

const FORWARD = Object.freeze({
  0: [1],
  1: [2],
  2: [3],
  3: [4],
  4: [5],
  5: [6],
  6: [7],
  7: [8],
  8: [],
})

// Review, docs, and PR readiness return to the developer. A planning defect returns to the planner.
// Architecture, planning, and builder defects return to the analyst. An analyst defect returns to the product manager.
export const RETURNS = Object.freeze({
  1: [0],
  2: [1],
  3: [1],
  4: [3, 1],
  6: [4],
  7: [4],
  8: [4],
})

export const MAX_RETURN_CYCLES = 2

export const DEFAULT_HOT_FILE_DENYLIST = Object.freeze([
  'Cargo.lock',
  'Cargo.toml',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'migrations/',
  'schema/',
])

export function resolveRoleAndSeat(phase, { seat = null, role = null } = {}) {
  const spec = phaseSpec(phase)
  const allowedSeats = seatsFor(phase)
  if (seat && allowedSeats.includes(seat)) {
    const qualifier =
      seat === 'dev.build-jr'
        ? 'junior'
        : seat === 'dev.build-sr'
          ? 'senior'
          : seat === 'dev.build'
            ? 'standard'
            : null
    return { role: spec.role, seat, qualifier }
  }
  if (role === spec.role || seat === spec.role) {
    const resolvedSeat = seat && allowedSeats.includes(seat) ? seat : allowedSeats[0]
    return { role: spec.role, seat: resolvedSeat, qualifier: null }
  }
  throw new Error(`Seat ${seat ?? role} does not own phase ${phase} (${spec.role})`)
}

export function countReturnCycles(transitions = [], fromPhase, toPhase) {
  return transitions.filter((t) => {
    if (t.phase !== fromPhase || t.status !== 'skipped') return false
    const match = String(t.reason ?? '').match(/return to phase (\d+)/i)
    let named = match ? Number(match[1]) : null
    if (named === null && t.phase === 4 && /oracle:correction/i.test(String(t.reason ?? ''))) {
      named = 3
    }
    return named === toPhase
  }).length
}

export function phaseSpec(phase) {
  const spec = PHASES.find((item) => item.phase === phase)
  if (!spec) throw new Error(`Unknown phase: ${phase}`)
  return spec
}

export function seatsFor(phase) {
  const spec = phaseSpec(phase)
  return spec.seats ?? [spec.seat]
}

function latestApplied(transitions) {
  const applied = transitions.filter((item) => item.status === 'pass' || item.status === 'skipped')
  return applied.length ? applied[applied.length - 1] : null
}

export function currentPhase(transitions = []) {
  return latestApplied(transitions)?.phase ?? null
}

// A skip that names a legal return is a defect, not a delivery. It offers only that return.
function namedReturn(transition) {
  if (transition.status !== 'skipped') return null
  const match = String(transition.reason ?? '').match(/return to phase (\d+)/i)
  let named = match ? Number(match[1]) : null
  if (
    named === null &&
    transition.phase === 4 &&
    /oracle:correction/i.test(String(transition.reason ?? ''))
  ) {
    named = 3
  }
  return (RETURNS[transition.phase] ?? []).includes(named) ? named : null
}

export function allowedNext(transitions = []) {
  const latest = latestApplied(transitions)
  if (!latest) return [0]
  const back = namedReturn(latest)
  if (back !== null) {
    if (countReturnCycles(transitions, latest.phase, back) > MAX_RETURN_CYCLES) {
      return []
    }
    return [back]
  }
  return [...(FORWARD[latest.phase] ?? []), ...(RETURNS[latest.phase] ?? [])]
}

export function validateTransition({
  transitions = [],
  phase,
  status,
  seat,
  role,
  reason,
  touchedFiles,
  expectedPreviousTransitionId,
  baseSha,
  candidateSha,
  oracleDigest,
  hotFileDenylist,
  activeHotFiles,
}) {
  if (!['pass', 'skipped'].includes(status)) {
    throw new Error('A transition status must be pass or skipped')
  }
  if (!Number.isInteger(phase) || phase < 0 || phase > 8) {
    throw new Error('A transition phase must be an integer from 0 to 8')
  }
  if (status === 'skipped' && (!reason || !String(reason).trim())) {
    throw new Error('A skipped phase requires a reason')
  }
  let targetReturn =
    status === 'skipped' ? Number(String(reason ?? '').match(/return to phase (\d+)/i)?.[1]) : null
  if (!Number.isInteger(targetReturn)) {
    if (status === 'skipped' && phase === 4 && /oracle:correction/i.test(String(reason ?? ''))) {
      targetReturn = 3
    } else {
      targetReturn = null
    }
  }
  if (targetReturn !== null && Number.isInteger(targetReturn)) {
    const cycles = countReturnCycles(transitions, phase, targetReturn)
    if (cycles >= MAX_RETURN_CYCLES) {
      throw new Error(
        `Return cycle limit reached: phase ${phase} has already returned to phase ${targetReturn} ${cycles} times (maximum: ${MAX_RETURN_CYCLES}). Human escalation required.`,
      )
    }
  }
  const next = allowedNext(transitions)
  if (!next.includes(phase)) {
    const current = currentPhase(transitions)
    throw new Error(
      `Phase ${phase} is not allowed after ${current === null ? 'no transitions' : `phase ${current}`}. Allowed: ${next.join(', ') || 'none'}`,
    )
  }
  const spec = phaseSpec(phase)
  const resolved = resolveRoleAndSeat(phase, { seat, role })

  if (expectedPreviousTransitionId !== undefined && expectedPreviousTransitionId !== null) {
    const latest = latestApplied(transitions)
    const actualPrev = latest ? (latest.idempotencyKey ?? latest.uri ?? null) : 'none'
    if (actualPrev !== expectedPreviousTransitionId) {
      throw new Error(
        `Transition monotonicity violation: expected previousTransitionId ${expectedPreviousTransitionId}, got ${actualPrev}`,
      )
    }
  }

  if (spec.role === 'developer' && status === 'pass' && Array.isArray(touchedFiles)) {
    if (touchedFiles.some((f) => /(^|\/)tests\/(?:.*\/)?oracles\//.test(String(f)))) {
      throw new Error('Developer role cannot modify oracle files under tests/oracles/**')
    }
  }

  const result = {
    phase,
    role: resolved.role,
    seat: resolved.seat,
    status,
    reason: reason ?? null,
  }

  if (resolved.qualifier && role !== undefined) {
    result.qualifier = resolved.qualifier
  }
  if (phase === 4 && status === 'skipped' && /oracle:correction/i.test(String(reason ?? ''))) {
    result.oracleCorrection = true
  }
  if (baseSha !== undefined) {
    result.baseSha = baseSha
  }
  if (candidateSha !== undefined) {
    result.candidateSha = candidateSha
  }
  if (oracleDigest !== undefined) {
    result.oracleDigest = oracleDigest
  }
  if (Array.isArray(touchedFiles)) {
    const denylist = hotFileDenylist ?? DEFAULT_HOT_FILE_DENYLIST
    const touchesHot = touchedFiles.some((f) =>
      denylist.some((d) => String(f).endsWith(d) || String(f).includes(d)),
    )
    const activeOverlap = Array.isArray(activeHotFiles) && activeHotFiles.length > 0
    result.serializationStatus = touchesHot && activeOverlap ? 'SERIALIZED' : 'PARALLEL_OK'
  }

  return result
}
