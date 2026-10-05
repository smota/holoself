import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { resolveCompositionProfile } from '../adoption/profiles.mjs'
import { validateAdoptionLock } from '../adoption/lock-validation.mjs'

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MiB limit
const JOURNAL_NAME = '.agentflow-adoption-journal.json'
const ROLLBACK_JOURNAL_NAME = '.agentflow-rollback-journal.json'
const LOCKFILE_NAME = 'agent-framework-lock.json'
const CONFIG_FILE_NAME = 'agent-workflow.config.json'

function slash(value) {
  return value.replaceAll('\\', '/')
}

function hashContent(content) {
  return createHash('sha256').update(content).digest('hex')
}

function contained(root, target) {
  const value = relative(root, target)
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value))
}

function resolveAndVerifyRoot(targetDir) {
  const resolved = resolve(targetDir)
  const { root } = parse(resolved)
  const rel = relative(root, resolved)
  const segments = rel.split(/[\/\\]/).filter(Boolean)
  let current = root

  for (const segment of segments) {
    current = join(current, segment)
    let stat = null
    try {
      stat = lstatSync(current)
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new Error(`Target path does not exist: ${current}`)
      }
      throw err
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Target root or ancestor must not be a symlink or junction: ${current}`)
    }
  }

  const rootStat = lstatSync(resolved)
  if (rootStat.isSymbolicLink()) {
    throw new Error(`Target root must not be a symlink or junction: ${resolved}`)
  }
  if (!rootStat.isDirectory()) {
    throw new Error(`Target root must be a directory: ${resolved}`)
  }

  const physical = realpathSync(resolved)
  const physicalStat = statSync(physical)
  return {
    resolved,
    physical: slash(physical),
    rootIdentity: {
      dev: physicalStat.dev,
      ino: physicalStat.ino,
      birthtimeMs: physicalStat.birthtimeMs,
    },
  }
}

function inspectTargetEntry(root, relPath) {
  if (!relPath || isAbsolute(relPath)) {
    return { kind: 'unsafe', hash: null, diagnostic: `Unsafe target path: ${relPath}` }
  }
  const target = resolve(root, relPath)
  if (!contained(root, target) || target === root) {
    return { kind: 'unsafe', hash: null, diagnostic: `Target path escapes root: ${relPath}` }
  }

  let cursor = dirname(target)
  const ancestors = []
  while (cursor !== root) {
    if (!contained(root, cursor)) {
      return { kind: 'unsafe', hash: null, diagnostic: `Ancestor escapes root: ${relPath}` }
    }
    ancestors.push(cursor)
    cursor = dirname(cursor)
  }
  ancestors.reverse()

  for (const ancestor of ancestors) {
    let stat = null
    try {
      stat = lstatSync(ancestor)
    } catch (err) {
      if (err.code === 'ENOENT') {
        return { kind: 'missing', hash: null }
      }
      return {
        kind: 'unsafe',
        hash: null,
        diagnostic: `Failed to lstat ancestor ${relative(root, ancestor)}: ${err.message}`,
      }
    }
    if (stat.isSymbolicLink()) {
      return {
        kind: 'unsafe',
        hash: null,
        diagnostic: `Ancestor directory is a link: ${relative(root, ancestor)}`,
      }
    }
    if (!stat.isDirectory()) {
      return {
        kind: 'unsafe',
        hash: null,
        diagnostic: `Ancestor is not a directory: ${relative(root, ancestor)}`,
      }
    }
  }

  let targetStat = null
  try {
    targetStat = lstatSync(target)
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { kind: 'missing', hash: null }
    }
    return {
      kind: 'unsafe',
      hash: null,
      diagnostic: `Failed to lstat target ${relPath}: ${err.message}`,
    }
  }

  if (targetStat.isSymbolicLink()) {
    return { kind: 'link', hash: null, diagnostic: `Target is a symbolic link: ${relPath}` }
  }
  if (targetStat.isDirectory()) {
    return { kind: 'directory', hash: null, diagnostic: `Target is a directory: ${relPath}` }
  }
  if (!targetStat.isFile()) {
    return { kind: 'unsafe', hash: null, diagnostic: `Target is not a regular file: ${relPath}` }
  }
  if (targetStat.size > MAX_FILE_SIZE) {
    return { kind: 'unsafe', hash: null, diagnostic: `Target exceeds 10MiB limit: ${relPath}` }
  }

  try {
    const content = readFileSync(target)
    return { kind: 'file', hash: hashContent(content) }
  } catch (error) {
    return { kind: 'unsafe', hash: null, diagnostic: `Cannot read ${relPath}: ${error.code}` }
  }
}

function inspectLockfile(root, diagnostics) {
  const target = resolve(root, LOCKFILE_NAME)
  let stat = null
  try {
    stat = lstatSync(target)
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { format: 'missing', hash: null }
    }
    diagnostics.push(`Failed to lstat lockfile: ${err.message}`)
    return { format: 'unknown', hash: null, error: err.message }
  }

  if (stat.isSymbolicLink()) {
    diagnostics.push('Lockfile is a symbolic link')
    return { format: 'unknown', hash: null, error: 'Lockfile is a symbolic link' }
  }
  if (!stat.isFile()) {
    diagnostics.push('Lockfile is not a regular file')
    return { format: 'unknown', hash: null, error: 'Lockfile is not a regular file' }
  }
  if (stat.size > MAX_FILE_SIZE) {
    diagnostics.push('Lockfile exceeds 10MiB limit')
    return { format: 'unknown', hash: null, error: 'Lockfile exceeds 10MiB limit' }
  }

  let raw
  try {
    raw = readFileSync(target, 'utf8')
  } catch (error) {
    diagnostics.push(`Cannot read lockfile: ${error.code}`)
    return { format: 'unknown', hash: null, error: error.code }
  }
  const hash = hashContent(raw)
  let parsed = null
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    diagnostics.push(`Malformed lockfile JSON: ${err.message}`)
    return { format: 'unknown', hash, error: err.message }
  }

  if (parsed?.version === 2 && Array.isArray(parsed.entries)) {
    try {
      validateAdoptionLock(parsed)
      const targets = new Set()
      for (const entry of parsed.entries) {
        if (
          !['managed', 'seed-once'].includes(entry.ownership) ||
          !['managed', 'merged', 'removed'].includes(entry.state) ||
          targets.has(entry.target) ||
          inspectTargetEntry(root, entry.target).kind === 'unsafe'
        ) {
          throw new Error('Invalid lock entry ownership, state, target or duplicate')
        }
        targets.add(entry.target)
      }
    } catch (error) {
      diagnostics.push(`Malformed lockfile entries: ${error.message}`)
      return { format: 'unknown', hash, error: error.message }
    }
    return { format: 'v2', hash, data: parsed }
  }
  if (
    parsed &&
    typeof parsed === 'object' &&
    parsed.files &&
    typeof parsed.files === 'object' &&
    Array.isArray(parsed.merged)
  ) {
    return { format: 'legacy', hash, data: parsed }
  }

  diagnostics.push('Unrecognized lockfile format')
  return { format: 'unknown', hash, data: parsed, error: 'Unrecognized lockfile format' }
}

function inspectConfigFile(root, diagnostics) {
  const target = resolve(root, CONFIG_FILE_NAME)
  let stat = null
  try {
    stat = lstatSync(target)
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { status: 'missing' }
    }
    diagnostics.push(`Failed to lstat config file: ${err.message}`)
    return { status: 'invalid' }
  }

  if (stat.isSymbolicLink()) {
    diagnostics.push('Config file is a symbolic link')
    return { status: 'invalid' }
  }
  if (!stat.isFile()) {
    diagnostics.push('Config file is not a regular file')
    return { status: 'invalid' }
  }
  if (stat.size > MAX_FILE_SIZE) {
    diagnostics.push('Config file exceeds 10MiB limit')
    return { status: 'invalid' }
  }

  let raw
  try {
    raw = readFileSync(target, 'utf8')
  } catch (error) {
    diagnostics.push(`Cannot read config: ${error.code}`)
    return { status: 'invalid' }
  }
  let parsed = null
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    diagnostics.push(`Malformed config file: ${err.message}`)
    return { status: 'invalid' }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    diagnostics.push('Malformed config file: expected a JSON object')
    return { status: 'invalid' }
  }
  return { status: 'valid', value: parsed }
}

function checkPendingJournal(root) {
  for (const name of [JOURNAL_NAME, ROLLBACK_JOURNAL_NAME]) {
    const target = resolve(root, name)
    try {
      if (lstatSync(target)) return true
    } catch (error) {
      if (error.code !== 'ENOENT') return true
    }
  }
  return false
}

export function inspectProject(packageRoot, targetDir, { profile = 'standard' } = {}) {
  const diagnostics = []
  const { resolved: root, physical, rootIdentity } = resolveAndVerifyRoot(targetDir)
  const profilePayload = resolveCompositionProfile(profile)

  const lock = inspectLockfile(root, diagnostics)
  const config = inspectConfigFile(root, diagnostics)
  const pendingJournal = checkPendingJournal(root)

  const entriesMap = new Map()
  for (const relPath of profilePayload.managedFiles) {
    entriesMap.set(relPath, {
      source: relPath,
      target: relPath,
      ownership: 'managed',
    })
  }

  for (const entry of profilePayload.seedOnceFiles) {
    entriesMap.set(entry.to, {
      source: entry.from,
      target: entry.to,
      ownership: 'seed-once',
    })
  }

  const entries = []
  for (const item of entriesMap.values()) {
    let expectedHash = null
    const sourcePath = resolve(packageRoot, item.source)
    try {
      const sourceStat = statSync(sourcePath)
      if (sourceStat.isFile()) {
        expectedHash = hashContent(readFileSync(sourcePath))
      }
    } catch {}

    const observation = inspectTargetEntry(root, item.target)
    if (observation.diagnostic) {
      diagnostics.push(observation.diagnostic)
    }

    let state = 'unknown'
    if (observation.kind === 'missing') {
      state = 'missing'
    } else if (
      observation.kind === 'link' ||
      observation.kind === 'directory' ||
      observation.kind === 'unsafe'
    ) {
      state = 'conflict'
    } else if (observation.kind === 'file') {
      if (item.ownership === 'seed-once') {
        state = 'authored'
      } else if (item.ownership === 'managed') {
        if (lock.format === 'v2' && Array.isArray(lock.data?.entries)) {
          const lockEntry = lock.data.entries.find((e) => e.target === item.target)
          if (lockEntry?.ownership === 'managed' && lockEntry.state === 'merged') {
            state = 'authored'
          } else if (
            lockEntry?.ownership === 'managed' &&
            lockEntry.state === 'managed' &&
            typeof lockEntry.hash === 'string' &&
            lockEntry.hash === observation.hash
          ) {
            state = 'managed'
          } else {
            state = 'conflict'
          }
        } else {
          // Unknown existing bytes conflict even when expected same (ownership not proved)
          state = 'conflict'
        }
      }
    }

    entries.push({
      source: item.source,
      target: item.target,
      ownership: item.ownership,
      kind: observation.kind,
      hash: observation.hash,
      expectedHash,
      state,
    })
  }

  entries.sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0))

  let classification = 'unknown'
  const hasConflict = entries.some((e) => e.state === 'conflict' || e.kind === 'unsafe')
  const allMissing =
    entries.every((e) => e.state === 'missing') &&
    lock.format === 'missing' &&
    config.status === 'missing'

  if (lock.format === 'legacy') {
    classification = 'legacy'
  } else if (
    lock.format === 'unknown' ||
    config.status === 'invalid' ||
    entries.some((e) => e.state === 'unknown')
  ) {
    classification = 'unknown'
  } else if (hasConflict) {
    classification = 'conflicting'
  } else if (allMissing && !pendingJournal) {
    classification = 'empty'
  } else if (
    lock.format === 'v2' &&
    config.status === 'valid' &&
    !pendingJournal &&
    !entries.some((e) => e.state === 'missing') &&
    entries.every((e) =>
      e.ownership === 'managed'
        ? e.state === 'managed' && e.hash === e.expectedHash
        : e.state === 'authored',
    )
  ) {
    classification = 'complete'
  } else {
    classification = 'partial'
  }

  return {
    version: 1,
    target: physical,
    rootIdentity,
    profile: profilePayload.id,
    entries,
    lock,
    config,
    pendingJournal,
    classification,
    diagnostics,
  }
}
