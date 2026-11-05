import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'

function resolveNowMs(now) {
  if (now instanceof Date) return now.getTime()
  if (typeof now === 'number' && Number.isFinite(now)) return now
  if (typeof now === 'string' && now.trim()) {
    const parsed = Date.parse(now)
    if (!Number.isNaN(parsed)) return parsed
  }
  return Date.now()
}

export function normalizeSeatId(seat) {
  if (typeof seat !== 'string' || !seat.trim()) {
    throw new Error('A non-empty seat identifier is required')
  }
  const trimmed = seat.trim()
  if (
    /\s/.test(trimmed) ||
    trimmed.includes('..') ||
    trimmed.includes('/') ||
    trimmed.includes('\\')
  ) {
    throw new Error(`Invalid seat identifier: ${seat}`)
  }
  return trimmed
}

export function seatLeasePath(targetDir, seat) {
  if (!targetDir) throw new Error('targetDir is required for seat lease operations')
  const normalized = normalizeSeatId(seat)
  return join(resolve(targetDir), '.agentflow', 'seats', `${normalized}.json`)
}

export function claimSeatLease(
  targetDir,
  {
    seat,
    occupantSession,
    platform = 'local-cli',
    desired = null,
    observed = null,
    worktree = null,
    ttlSeconds = 3600,
    force = false,
    allowSupervisory = false,
    now,
  } = {},
) {
  if (!targetDir) throw new Error('targetDir is required')
  const normalizedSeat = normalizeSeatId(seat)
  if (typeof occupantSession !== 'string' || !occupantSession.trim()) {
    throw new Error('occupantSession is required to claim a seat lease')
  }

  if (normalizedSeat.startsWith('steer.') && allowSupervisory !== true) {
    throw new Error(
      `Supervisory seat ${normalizedSeat} cannot be self-leased without explicit supervisory authorization (allowSupervisory: true)`,
    )
  }

  const trimmedSession = occupantSession.trim()
  const existing = readSeatLease(targetDir, normalizedSeat, { now, inspect: true })
  if (existing && !existing.expired && existing.occupantSession !== trimmedSession && !force) {
    throw new Error(`Seat ${normalizedSeat} is already leased by ${existing.occupantSession}`)
  }

  const effectiveTtl =
    typeof ttlSeconds === 'number' && Number.isFinite(ttlSeconds) && ttlSeconds > 0
      ? ttlSeconds
      : 3600
  const nowMs = resolveNowMs(now)
  const claimedAt = new Date(nowMs).toISOString()
  const expiresAt = new Date(nowMs + effectiveTtl * 1000).toISOString()

  const filePath = seatLeasePath(targetDir, normalizedSeat)
  mkdirSync(join(resolve(targetDir), '.agentflow', 'seats'), { recursive: true })

  const record = {
    version: 1,
    seat: normalizedSeat,
    occupantSession: trimmedSession,
    platform: platform || 'local-cli',
    desired: desired ?? null,
    observed: observed ?? null,
    worktree: worktree ?? null,
    ttlSeconds: effectiveTtl,
    claimedAt,
    expiresAt,
  }

  writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  return {
    ...record,
    expired: false,
    leasePath: filePath,
  }
}

export function readSeatLease(targetDir, seat, { now, inspect = false } = {}) {
  if (!targetDir || !seat) return null
  let filePath
  try {
    filePath = seatLeasePath(targetDir, seat)
  } catch {
    return null
  }
  if (!existsSync(filePath)) return null

  let record
  try {
    record = JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }

  const nowMs = resolveNowMs(now)
  const expiresMs = Date.parse(record.expiresAt)
  const expired = Number.isNaN(expiresMs) ? true : expiresMs <= nowMs

  if (expired && !inspect) {
    return null
  }

  return {
    ...record,
    expired,
  }
}

export function listSeatLeases(targetDir, { now, includeExpired = false } = {}) {
  if (!targetDir) return []
  const seatsDir = join(resolve(targetDir), '.agentflow', 'seats')
  if (!existsSync(seatsDir)) return []

  const files = readdirSync(seatsDir)
    .filter((name) => name.endsWith('.json'))
    .sort()

  const leases = []
  for (const file of files) {
    const seatName = file.slice(0, -'.json'.length)
    const lease = readSeatLease(targetDir, seatName, { now, inspect: true })
    if (!lease) continue
    if (lease.expired && !includeExpired) continue
    leases.push(lease)
  }
  return leases
}

export function releaseSeatLease(targetDir, seat, { occupantSession, now } = {}) {
  if (!targetDir) throw new Error('targetDir is required')
  const normalizedSeat = normalizeSeatId(seat)
  const filePath = seatLeasePath(targetDir, normalizedSeat)
  if (!existsSync(filePath)) {
    return { released: false, seat: normalizedSeat, reason: 'not_found' }
  }

  const existing = readSeatLease(targetDir, normalizedSeat, { now, inspect: true })
  if (
    occupantSession &&
    existing &&
    !existing.expired &&
    existing.occupantSession !== occupantSession.trim()
  ) {
    throw new Error(
      `Session ${occupantSession} cannot release seat ${normalizedSeat} leased by ${existing.occupantSession}`,
    )
  }

  unlinkSync(filePath)
  return {
    released: true,
    seat: normalizedSeat,
    previousOccupant: existing?.occupantSession ?? null,
  }
}
