import { normalizeLockfile } from '../lockfile.mjs'

// Ownership claims must satisfy the same contract in inventory and mutation planning.
export function validateAdoptionLock(parsed) {
  const normalized = normalizeLockfile(parsed)
  const targets = new Set()
  for (const entry of parsed.entries) {
    const path = entry.target
    if (
      !['managed', 'seed-once'].includes(entry.ownership) ||
      !['managed', 'merged', 'removed'].includes(entry.state) ||
      typeof entry.source !== 'string' ||
      !entry.source ||
      !path ||
      /^(?:[a-z]:|[\\/])/i.test(path) ||
      path.split(/[\\/]/).some((p) => !p || p === '.' || p === '..') ||
      targets.has(path) ||
      (entry.state === 'managed' ? !/^[a-f0-9]{64}$/.test(entry.hash) : entry.hash !== null)
    ) {
      throw new Error('Invalid adoption lock ownership, state, path, hash or duplicate')
    }
    targets.add(path)
  }
  return normalized
}
