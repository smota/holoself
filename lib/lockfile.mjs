import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const LOCKFILE_NAME = 'agent-framework-lock.json'

export function hashContent(content) {
  return createHash('sha256').update(content).digest('hex')
}

export function lockfilePath(targetDir) {
  return join(targetDir, LOCKFILE_NAME)
}

export function normalizeLockfile(parsed) {
  if (parsed?.version !== 2) {
    throw new Error('AgentFlow lockfile version must be 2; legacy lockfiles are not supported')
  }
  if (!Array.isArray(parsed.entries)) throw new Error('AgentFlow lockfile entries must be an array')
  const files = {}
  const merged = []
  const removed = []
  for (const [index, entry] of parsed.entries.entries()) {
    if (!entry || typeof entry !== 'object')
      throw new Error(`AgentFlow lockfile entries[${index}] must be an object`)
    if (typeof entry.target !== 'string' || !entry.target)
      throw new Error(`AgentFlow lockfile entries[${index}].target is required`)
    if (entry.state === 'merged') merged.push(entry.target)
    else if (entry.state === 'removed' && entry.hash === null) removed.push(entry.target)
    else if (typeof entry.hash === 'string' && entry.hash) files[entry.target] = entry.hash
    else throw new Error(`AgentFlow lockfile entries[${index}].hash is required`)
  }
  return {
    version: 2,
    profile: parsed.profile,
    package: parsed.package ?? null,
    planToken: parsed.planToken ?? null,
    files,
    merged: [...new Set(merged)].sort(),
    removed: [...new Set(removed)].sort(),
    entries: parsed.entries,
  }
}

export function readLockfile(targetDir, { strict = false } = {}) {
  const path = lockfilePath(targetDir)
  if (!existsSync(path)) {
    return { version: 2, files: {}, merged: [], removed: [], entries: [] }
  }
  try {
    return normalizeLockfile(JSON.parse(readFileSync(path, 'utf8')))
  } catch (error) {
    if (strict) throw new Error(`Invalid AgentFlow lockfile: ${error.message}`)
    return { version: 2, files: {}, merged: [], removed: [], entries: [] }
  }
}

export function lockfileV2({ profile, packageIdentity, planToken, entries }) {
  return {
    version: 2,
    profile,
    package: packageIdentity,
    planToken,
    entries: [...entries].sort((left, right) => left.target.localeCompare(right.target)),
  }
}

export function serializeLockfile(lockfile) {
  if (lockfile.version !== 2) throw new Error('Only AgentFlow lockfile version 2 is supported')
  return `${JSON.stringify(lockfile, null, 2)}\n`
}

export function writeLockfileV2(targetDir, lockfile) {
  if (lockfile?.version !== 2) throw new Error('writeLockfileV2 requires version 2')
  writeFileSync(lockfilePath(targetDir), serializeLockfile(lockfile))
}
