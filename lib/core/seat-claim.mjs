// A transition may name a seat only when that seat wrote it. The caller is the OpenRig session
// `<logical>@<rig>`; the logical name maps to a phase seat by turning its first hyphen into a dot.
// When running outside OpenRig in an external terminal session, an advisory local seat lease in
// `.agentflow/seats/<seat>.json` can also verify the seat occupant when `options.targetDir` is given.

import { readSeatLease } from './seat-lease.mjs'

const SESSION = /^([^@\s]+)@([^@\s]+)$/

/** The caller seat from a session name, or null when it is missing, empty, or not one session. */
export function callerSeat(sessionName) {
  if (typeof sessionName !== 'string') return null
  const match = sessionName.trim().match(SESSION)
  if (!match) return null
  const [, logical, rig] = match
  return { session: match[0], seat: logical.replace('-', '.'), rig }
}

/**
 * Checks that the caller may write a transition naming `seat`, before anything is written.
 * Supports both `claimSeat({ seat, caller }, options)` and `claimSeat(session, seat, options)`.
 * Returns the fields the transition records. A different known seat is refused.
 */
export function claimSeat(first, second, third = {}) {
  let seat
  let caller
  let rawSession = null
  let options = {}

  if (first && typeof first === 'object' && ('seat' in first || 'caller' in first)) {
    seat = first.seat
    if (first.caller && typeof first.caller === 'object') {
      caller = first.caller
    } else if (typeof first.caller === 'string') {
      rawSession = first.caller.trim()
      caller = callerSeat(first.caller)
    } else if (typeof first.session === 'string') {
      rawSession = first.session.trim()
      caller = callerSeat(first.session)
    } else {
      caller = null
    }
    options = { ...first, ...(second || {}) }
  } else {
    seat = second
    if (first && typeof first === 'object') {
      caller = first
    } else if (typeof first === 'string') {
      rawSession = first.trim()
      caller = callerSeat(first)
    } else {
      caller = null
    }
    options = third || {}
  }

  if (caller) {
    if (caller.seat !== seat) {
      throw new Error(
        `Session ${caller.session} holds seat ${caller.seat} and cannot append a transition as seat ${seat}`,
      )
    }
    return { seatVerified: true, seatRig: caller.rig }
  }

  if (options.targetDir && rawSession) {
    const lease = readSeatLease(options.targetDir, seat, { now: options.now })
    if (lease && !lease.expired && lease.occupantSession === rawSession) {
      return {
        seatVerified: true,
        seatRig: lease.platform || 'local-lease',
        lease: true,
      }
    }
  }

  return { seatVerified: false, seatRig: null }
}

/**
 * Checks a repeated idempotency key. The same caller gets the existing transition back; a
 * different known seat, or the same seat from another rig, is refused. Nothing is written either way.
 */
export function claimExisting(first, second) {
  let existing
  let caller

  if (first && typeof first === 'object' && ('existing' in first || 'caller' in first)) {
    existing = first.existing
    caller =
      first.caller && typeof first.caller === 'object' ? first.caller : callerSeat(first.caller)
  } else {
    existing = first
    caller = second && typeof second === 'object' ? second : callerSeat(second)
  }

  if (!caller || !existing) return
  const otherRig = existing.seatRig && existing.seatRig !== caller.rig
  if (existing.seat !== caller.seat || otherRig) {
    throw new Error(
      `Session ${caller.session} cannot reuse key ${existing.idempotencyKey}, which seat ${existing.seat} recorded`,
    )
  }
}
