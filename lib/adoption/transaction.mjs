import { createHash, randomUUID } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep, parse, basename } from 'node:path'
import { tmpdir } from 'node:os'
import {
  hashContent,
  lockfilePath,
  lockfileV2,
  readLockfile,
  serializeLockfile,
} from '../lockfile.mjs'
import { resolveCompositionProfile } from './profiles.mjs'
import { withAdoptionLock } from './operation-lock.mjs'
import { validateAdoptionLock } from './lock-validation.mjs'

function slash(value) {
  return value.replaceAll('\\', '/')
}

function contained(root, target) {
  const value = relative(root, target)
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value))
}

function checkNoSymlinksInAncestors(targetPath) {
  const resolved = resolve(targetPath)
  const volumeRoot = parse(resolved).root
  let cursor = resolved
  while (cursor && cursor !== volumeRoot) {
    try {
      const info = lstatSync(cursor)
      if (info.isSymbolicLink()) {
        throw new Error(
          `Adoption target root must be a regular directory, not a symlink or junction: ${cursor}`,
        )
      }
      if (!info.isDirectory() && cursor !== resolved) {
        throw new Error(`Adoption ancestor is not a regular directory: ${cursor}`)
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        // Uncreated path component; ancestor check continues up the tree
      } else {
        throw err
      }
    }
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
}

function safeRoot(targetDir) {
  const root = resolve(targetDir)
  checkNoSymlinksInAncestors(root)
  if (existsSync(root)) {
    const info = lstatSync(root)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('Adoption target root must be a regular directory, not a symlink or junction')
    }
  }
  return root
}

function safeTarget(root, relPath) {
  if (!relPath || isAbsolute(relPath)) throw new Error(`Unsafe adoption path: ${relPath}`)
  const target = resolve(root, relPath)
  if (!contained(root, target) || target === root)
    throw new Error(`Unsafe adoption path: ${relPath}`)
  let cursor = dirname(target)
  while (cursor !== root) {
    if (!contained(root, cursor)) throw new Error(`Unsafe adoption parent: ${relPath}`)
    const parentInfo = lstatSync(cursor, { throwIfNoEntry: false })
    if (parentInfo) {
      const info = parentInfo
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error(`Adoption parent is not a regular directory: ${relPath}`)
      }
    }
    cursor = dirname(cursor)
  }
  const targetInfo = lstatSync(target, { throwIfNoEntry: false })
  if (targetInfo) {
    const info = targetInfo
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Adoption target is not a regular file: ${relPath}`)
    }
  }
  return target
}

function packageIdentity(packageRoot) {
  const value = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  return { name: value.name, version: value.version }
}

function planBase(plan) {
  const { token, ...base } = plan
  return base
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

const JOURNAL_NAME = '.agentflow-adoption-journal.json'
const ROLLBACK_JOURNAL_NAME = '.agentflow-rollback-journal.json'

function adoptionJournalPath(root) {
  return join(root, JOURNAL_NAME)
}

function defaultReceiptDestination(root) {
  const safeName = basename(root).replace(/[^a-zA-Z0-9._-]/g, '_') || 'project'
  const rawTmp = tmpdir()
  const resolvedTmp = existsSync(rawTmp) ? realpathSync(rawTmp) : rawTmp
  return join(
    resolvedTmp,
    `agentflow-receipt-${safeName}-${Date.now()}-${randomUUID().slice(0, 8)}.json`,
  )
}

function receiptLocation(root, destination) {
  const target = destination || defaultReceiptDestination(root)
  if (!isAbsolute(target)) throw new Error('An absolute external receipt destination is required')
  const path = resolve(target)
  const volume = parse(path).root
  safeTarget(volume, relative(volume, path))
  return path
}

function writeJournal(root, entry, { reset = false } = {}) {
  const data = `${JSON.stringify(entry)}\n`
  if (reset) writeFileSync(adoptionJournalPath(root), data, { flag: 'wx', flush: true })
  else appendFileSync(adoptionJournalPath(root), data, { flush: true })
}

function journalMutation(mutation) {
  return {
    path: mutation.path,
    beforeContentBase64: mutation.beforeContentBase64,
    beforeHash: mutation.beforeHash,
    afterHash: mutation.afterHash,
    stagedPath: mutation.stagedPath,
    backupPath: mutation.backupPath,
    createdDirectories: mutation.createdDirectories,
  }
}

export function readAdoptionJournal(targetDir) {
  const root = safeRoot(targetDir)
  const path = adoptionJournalPath(root)
  if (!existsSync(path)) {
    const rollback = safeTarget(root, ROLLBACK_JOURNAL_NAME)
    return existsSync(rollback) ? JSON.parse(readFileSync(rollback, 'utf8')) : null
  }
  const raw = readFileSync(path, 'utf8')
  try {
    const historical = JSON.parse(raw)
    if (historical.status && historical.type !== 'header') return historical
  } catch {
    /* Current journals use framed records. */
  }
  // Each flushed record ends in a newline. An incomplete tail was never acknowledged.
  const complete = raw.endsWith('\n') ? raw : raw.slice(0, raw.lastIndexOf('\n') + 1)
  const entries = complete
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  if (entries.length === 1 && entries[0].status && entries[0].type !== 'header') return entries[0]
  const header = entries.find((entry) => entry.type === 'header')
  if (!header) throw new Error('Adoption journal header is missing')
  const { type, ...base } = header
  return {
    ...base,
    mutations: entries.filter((entry) => entry.type === 'prepared').map((entry) => entry.mutation),
    ...(entries.find((entry) => entry.type === 'receipt-ready')
      ? { receiptPath: entries.find((entry) => entry.type === 'receipt-ready').path }
      : {}),
  }
}

function targetState(target) {
  return existsSync(target)
    ? { exists: true, content: readFileSync(target) }
    : { exists: false, content: null }
}

function actionForManaged({ packageRoot, targetDir, relPath, lock, merged, removed }) {
  const source = readFileSync(join(packageRoot, relPath))
  const afterHash = hashContent(source)
  const target = safeTarget(targetDir, relPath)
  const current = targetState(target)
  const beforeHash = current.exists ? hashContent(current.content) : null
  const claimed = lock.entries.find(
    (entry) => entry.target === relPath && entry.ownership === 'managed',
  )
  const lockedHash = claimed ? lock.files[relPath] : undefined
  let action
  if (removed.has(relPath) && !current.exists) action = 'preserve-removed'
  else if (merged.has(relPath)) action = current.exists ? 'preserve-merged' : 'preserve-removed'
  else if (!current.exists) action = lockedHash ? 'preserve-removed' : 'create'
  else if (!lockedHash) action = 'conflict'
  else if (beforeHash !== lockedHash) action = 'conflict'
  else action = beforeHash === afterHash ? 'unchanged' : 'update'
  return {
    action,
    source: relPath,
    target: relPath,
    ownership: 'managed',
    beforeHash,
    afterHash,
  }
}

function mergeSelectedConfig(base, selected) {
  const merged = { ...base }
  for (const [key, value] of Object.entries(selected)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key))
      throw new Error('Unsafe prototype key in config')
    merged[key] =
      value && typeof value === 'object' && !Array.isArray(value)
        ? mergeSelectedConfig(
            base?.[key] && typeof base[key] === 'object' && !Array.isArray(base[key])
              ? base[key]
              : {},
            value,
          )
        : value
  }
  return merged
}

function actionForSeed({ packageRoot, targetDir, entry, seedValues }) {
  const defaultSource = readFileSync(join(packageRoot, entry.from), 'utf8')
  const target = safeTarget(targetDir, entry.to)
  const current = targetState(target)

  if (entry.to === 'agent-workflow.config.json' && seedValues?.[entry.to]) {
    const chosen = seedValues[entry.to]
    let baseObject
    if (current.exists) {
      let existingParsed
      try {
        existingParsed = JSON.parse(current.content.toString('utf8'))
      } catch {
        throw new Error('Invalid existing agent-workflow.config.json cannot be parsed')
      }
      if (!existingParsed || typeof existingParsed !== 'object' || Array.isArray(existingParsed)) {
        throw new Error('Invalid existing agent-workflow.config.json must be a JSON object')
      }
      for (const k of Object.keys(existingParsed)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') {
          throw new Error(`Unsafe prototype key in existing config: ${k}`)
        }
      }
      baseObject = existingParsed
    } else {
      baseObject = JSON.parse(defaultSource)
    }

    const merged = mergeSelectedConfig(baseObject, chosen)

    const mergedContent = Buffer.from(`${JSON.stringify(merged, null, 2)}\n`, 'utf8')
    const afterHash = hashContent(mergedContent)
    const beforeHash = current.exists ? hashContent(current.content) : null

    let action
    if (!current.exists) {
      action = 'seed'
    } else if (beforeHash === afterHash) {
      action = 'unchanged'
    } else {
      action = 'update'
    }

    return {
      action,
      source: entry.from,
      target: entry.to,
      ownership: 'seed-once',
      beforeHash,
      afterHash,
      contentBase64: mergedContent.toString('base64'),
    }
  }

  const source = Buffer.from(defaultSource, 'utf8')
  const afterHash = hashContent(source)
  return {
    action: current.exists ? 'seed-skip' : 'seed',
    source: entry.from,
    target: entry.to,
    ownership: 'seed-once',
    beforeHash: current.exists ? hashContent(current.content) : null,
    afterHash,
  }
}

function readLockForPlan(root, { migrateLegacy = false, recoverUnknown = false } = {}) {
  if (typeof migrateLegacy !== 'boolean') throw new Error('migrateLegacy must be a boolean')
  if (typeof recoverUnknown !== 'boolean') throw new Error('recoverUnknown must be a boolean')

  const path = safeTarget(root, 'agent-framework-lock.json')
  if (!existsSync(path)) {
    return {
      version: 2,
      priorLockVersion: null,
      lockHash: null,
      files: {},
      merged: [],
      removed: [],
      entries: [],
      unknownLock: false,
    }
  }

  const rawBytes = readFileSync(path)
  const lockHash = hashContent(rawBytes)

  let parsed = null
  let parseError = null
  try {
    parsed = JSON.parse(rawBytes.toString('utf8'))
  } catch (error) {
    parseError = error
  }

  if (!parseError && parsed?.version === 2) {
    try {
      const v2 = validateAdoptionLock(parsed)
      return {
        ...v2,
        lockHash,
        unknownLock: false,
      }
    } catch (v2Error) {
      if (!recoverUnknown) {
        throw new Error(`Invalid AgentFlow lockfile: ${v2Error.message}`)
      }
      return {
        version: 2,
        priorLockVersion: 'unknown',
        profile: null,
        package: null,
        planToken: null,
        files: {},
        merged: [],
        removed: [],
        entries: [],
        lockHash,
        unknownLock: true,
      }
    }
  }

  const isCandidateLegacy =
    !parseError &&
    parsed &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    (parsed.version === undefined || parsed.version === 1) &&
    parsed.files &&
    typeof parsed.files === 'object' &&
    !Array.isArray(parsed.files) &&
    Array.isArray(parsed.merged)

  if (isCandidateLegacy) {
    if (!migrateLegacy) {
      throw new Error(
        'Invalid AgentFlow lockfile: AgentFlow lockfile version must be 2; legacy lockfiles are not supported',
      )
    }

    const allowedKeys = new Set(['version', 'files', 'merged'])
    for (const key of Object.keys(parsed)) {
      if (!allowedKeys.has(key)) {
        throw new Error(`Invalid AgentFlow lockfile: unexpected legacy key ${key}`)
      }
    }

    const sha256Pattern = /^[a-f0-9]{64}$/
    for (const [target, hash] of Object.entries(parsed.files)) {
      if (typeof target !== 'string' || !target || isAbsolute(target)) {
        throw new Error(`Invalid AgentFlow lockfile: unsafe legacy file path ${target}`)
      }
      safeTarget(root, target)
      if (typeof hash !== 'string' || !sha256Pattern.test(hash)) {
        throw new Error(`Invalid AgentFlow lockfile: invalid sha256 hash for legacy file ${target}`)
      }
    }

    for (const target of parsed.merged) {
      if (typeof target !== 'string' || !target || isAbsolute(target)) {
        throw new Error(`Invalid AgentFlow lockfile: unsafe legacy merged path ${target}`)
      }
      safeTarget(root, target)
    }

    const files = { ...parsed.files }
    const merged = [...new Set(parsed.merged)].sort()
    const removed = []
    const entries = [
      ...Object.entries(files).map(([target, hash]) => ({
        source: target,
        target,
        ownership: 'managed',
        state: 'managed',
        hash,
      })),
      ...merged.map((target) => ({
        source: target,
        target,
        ownership: 'managed',
        state: 'merged',
        hash: null,
      })),
    ].sort((left, right) => left.target.localeCompare(right.target))

    return {
      version: 2,
      priorLockVersion: parsed.version ?? 1,
      profile: null,
      package: null,
      planToken: null,
      files,
      merged,
      removed,
      entries,
      lockHash,
      unknownLock: false,
    }
  }

  if (!recoverUnknown) {
    if (parseError) {
      throw new Error(`Invalid AgentFlow lockfile: ${parseError.message}`)
    }
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.version !== undefined &&
      parsed.version !== 2
    ) {
      throw new Error(`Invalid AgentFlow lockfile: unknown lockfile version ${parsed.version}`)
    }
    throw new Error('Invalid AgentFlow lockfile: unrecognized lockfile format')
  }

  return {
    version: 2,
    priorLockVersion: 'unknown',
    profile: null,
    package: null,
    planToken: null,
    files: {},
    merged: [],
    removed: [],
    entries: [],
    lockHash,
    unknownLock: true,
  }
}

export function planAdoption(
  packageRoot,
  targetDir,
  {
    profile,
    storage = 'external',
    resolutions = {},
    seedValues = {},
    migrateLegacy = false,
    recoverUnknown = false,
  } = {},
) {
  if (!['external', 'project'].includes(storage))
    throw new Error('Storage must be external or project')
  const root = safeRoot(targetDir)
  if (
    existsSync(adoptionJournalPath(root)) ||
    existsSync(safeTarget(root, ROLLBACK_JOURNAL_NAME))
  ) {
    throw new Error('An unfinished adoption journal requires explicit recovery')
  }

  if (!seedValues || typeof seedValues !== 'object' || Array.isArray(seedValues))
    throw new Error('seedValues must be an object')
  if (!resolutions || typeof resolutions !== 'object' || Array.isArray(resolutions))
    throw new Error('resolutions must be an object')
  if (typeof migrateLegacy !== 'boolean') throw new Error('migrateLegacy must be a boolean')
  if (typeof recoverUnknown !== 'boolean') throw new Error('recoverUnknown must be a boolean')
  if (seedValues && typeof seedValues === 'object' && !Array.isArray(seedValues)) {
    for (const key of Object.keys(seedValues)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        throw new Error(`Unsafe prototype key in seedValues: ${key}`)
      }
      if (key !== 'agent-workflow.config.json') {
        throw new Error(
          `Invalid seedValues target: ${key}; only agent-workflow.config.json is allowed`,
        )
      }
    }
    if (seedValues['agent-workflow.config.json']) {
      const cfg = seedValues['agent-workflow.config.json']
      if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
        throw new Error('seedValues for agent-workflow.config.json must be a JSON object')
      }
      for (const key of Object.keys(cfg)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
          throw new Error(`Unsafe prototype key in seedValues config: ${key}`)
        }
      }
    }
  }

  const selected = resolveCompositionProfile(profile)
  const lock = readLockForPlan(root, { migrateLegacy, recoverUnknown })
  const managedClaims = new Set(
    lock.entries.filter((e) => e.ownership === 'managed').map((e) => e.target),
  )
  const merged = new Set(lock.merged.filter((path) => managedClaims.has(path)))
  const removed = new Set(lock.removed.filter((path) => managedClaims.has(path)))
  const actions = [
    ...selected.managedFiles.map((relPath) =>
      actionForManaged({ packageRoot, targetDir: root, relPath, lock, merged, removed }),
    ),
    ...selected.seedOnceFiles.map((entry) =>
      actionForSeed({ packageRoot, targetDir: root, entry, seedValues }),
    ),
  ]

  const conflictingManaged = new Set(
    actions
      .filter(
        (item) =>
          ['conflict', 'preserve-merged'].includes(item.action) && item.ownership === 'managed',
      )
      .map((item) => item.target),
  )

  if (resolutions && typeof resolutions === 'object' && !Array.isArray(resolutions)) {
    for (const [key, res] of Object.entries(resolutions)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        throw new Error(`Unsafe prototype key in resolutions: ${key}`)
      }
      if (!conflictingManaged.has(key)) {
        throw new Error(
          `Invalid resolution target: ${key}; must be an exact conflicting managed path`,
        )
      }
      if (res !== 'preserve' && res !== 'replace') {
        throw new Error(`Invalid resolution value for ${key}: ${res}; must be preserve or replace`)
      }
    }
    for (const item of actions) {
      if (resolutions[item.target]) {
        const res = resolutions[item.target]
        if (res === 'preserve') {
          item.action = 'preserve-merged'
        } else if (res === 'replace') {
          item.action = 'update'
        }
      }
    }
  }

  if (
    actions.some(
      (item) =>
        item.target.startsWith('.agentflow/transactions/') ||
        item.target === '.agentflow/transactions',
    )
  )
    throw new Error('Transaction storage is reserved outside managed payload')
  let storagePlan = null
  if (storage === 'project') {
    safeTarget(root, '.agentflow/transactions/.sentinel')
    const storageIgnore = safeTarget(root, '.agentflow/transactions/.gitignore')
    if (existsSync(storageIgnore) && readFileSync(storageIgnore, 'utf8').trim() !== '*')
      throw new Error('Reserved transaction storage ignore policy conflicts')
    const ignorePath = safeTarget(root, '.gitignore')
    const prior = existsSync(ignorePath) ? readFileSync(ignorePath) : null
    const rule = '/.agentflow/transactions/'
    const present = prior?.toString('utf8').split(/\r?\n/).includes(rule)
    storagePlan = {
      mode: storage,
      ignoreBeforeHash: prior === null ? null : hashContent(prior),
      ignoreContentBase64: present
        ? null
        : Buffer.concat([
            prior ?? Buffer.alloc(0),
            Buffer.from(
              `${prior?.length && !prior.toString('utf8').endsWith('\n') ? '\n' : ''}${rule}\n`,
            ),
          ]).toString('base64'),
    }
  }
  const conflicts = actions.filter((item) => item.action === 'conflict').map((item) => item.target)

  const hasExplicitOptions = Boolean(
    (resolutions && Object.keys(resolutions).length > 0) ||
    (seedValues && Object.keys(seedValues).length > 0) ||
    migrateLegacy ||
    recoverUnknown,
  )

  const optionsObj = hasExplicitOptions
    ? {
        resolutions: { ...resolutions },
        seedValues: { ...seedValues },
        migrateLegacy: Boolean(migrateLegacy),
        recoverUnknown: Boolean(recoverUnknown),
      }
    : null

  const rootIdentity = existsSync(root)
    ? {
        realpath: slash(realpathSync(root)),
        dev: statSync(root).dev,
        ino: statSync(root).ino,
        birthtimeMs: statSync(root).birthtimeMs,
      }
    : null

  const base = {
    version: 1,
    operation: 'adopt',
    target: slash(root),
    profile: selected.id,
    package: packageIdentity(packageRoot),
    priorLockVersion: lock.priorLockVersion ?? lock.version,
    priorLockHash: lock.lockHash ?? null,
    actions,
    conflicts,
    blocked: conflicts.length > 0,
    storage: storagePlan ?? { mode: 'external' },
    rootIdentity,
    ...(optionsObj ? { options: optionsObj } : {}),
  }
  return { ...base, token: digest(base) }
}

function missingParents(root, target) {
  const missing = []
  let cursor = dirname(target)
  while (cursor !== root) {
    if (!existsSync(cursor)) missing.push(cursor)
    cursor = dirname(cursor)
  }
  return missing.reverse()
}

function createParents(missing, createdDirectories) {
  for (const directory of missing) {
    mkdirSync(directory)
    createdDirectories.add(directory)
  }
}

function removeCreatedDirectories(root, mutations) {
  const directories = new Set(
    mutations
      .flatMap((mutation) => mutation.createdDirectories ?? [])
      .map((path) => safeTarget(root, `${path}/.sentinel`))
      .map(dirname),
  )
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
    try {
      rmdirSync(directory)
    } catch {
      // Preserve directories that contain project-owned files.
    }
  }
}

function replaceFile({
  root,
  relPath,
  content,
  mutations,
  createdDirectories,
  fault,
  onPrepared = () => {},
}) {
  const target = safeTarget(root, relPath)
  const parents = missingParents(root, target)
  const id = randomUUID()
  const staged = `${target}.agentflow-${id}.tmp`
  const backup = `${target}.agentflow-${id}.bak`
  const before = existsSync(target) ? readFileSync(target) : null
  const mutation = {
    path: relPath,
    target,
    backup: before === null ? null : backup,
    stagedPath: slash(relative(root, staged)),
    backupPath: before === null ? null : slash(relative(root, backup)),
    createdDirectories: parents.map((directory) => slash(relative(root, directory))),
    beforeContentBase64: before === null ? null : before.toString('base64'),
    beforeHash: before === null ? null : hashContent(before),
    afterHash: hashContent(content),
  }
  try {
    onPrepared(mutation)
    createParents(parents, createdDirectories)
    fault('stage.before-file', { path: relPath })
    writeFileSync(staged, content, { flag: 'wx', flush: true })
    fault('stage.after-file', { path: relPath })
    if (before !== null) renameSync(target, backup)
    fault('apply.before-replace', { path: relPath })
    renameSync(staged, target)
    mutations.push(mutation)
    fault('apply.after-replace', { path: relPath })
  } catch (error) {
    if (existsSync(staged)) unlinkSync(staged)
    if (!existsSync(target) && existsSync(backup)) renameSync(backup, target)
    throw error
  }
}

function rollbackApplied(mutations, createdDirectories) {
  for (const mutation of [...mutations].reverse()) {
    if (existsSync(mutation.target)) unlinkSync(mutation.target)
    if (mutation.backup && existsSync(mutation.backup)) renameSync(mutation.backup, mutation.target)
  }
  for (const directory of [...createdDirectories].sort((a, b) => b.length - a.length)) {
    try {
      rmdirSync(directory)
    } catch {
      // Preserve directories that contain project-owned files.
    }
  }
}

function restoreMutationSet(root, mutations, fault = () => {}) {
  const restoration = []
  const createdDirectories = new Set()
  try {
    for (const mutation of [...mutations].reverse()) {
      const target = safeTarget(root, mutation.path)
      if (mutation.beforeContentBase64 === null) {
        const backup = `${target}.agentflow-${randomUUID()}.rollback`
        fault('rollback.before-remove', { path: mutation.path })
        renameSync(target, backup)
        restoration.push({ path: mutation.path, target, backup })
        fault('rollback.after-remove', { path: mutation.path })
      } else {
        replaceFile({
          root,
          relPath: mutation.path,
          content: Buffer.from(mutation.beforeContentBase64, 'base64'),
          mutations: restoration,
          createdDirectories,
          fault: (checkpoint, context) => fault(`rollback.${checkpoint}`, context),
        })
      }
    }
    for (const mutation of restoration) {
      if (mutation.backup && existsSync(mutation.backup)) unlinkSync(mutation.backup)
    }
  } catch (error) {
    rollbackApplied(restoration, createdDirectories)
    throw error
  }
}

function lockEntries(plan, priorLock) {
  const entries = plan.actions.map((item) => {
    const preserved = item.action === 'preserve-merged' || item.action === 'preserve-removed'
    return {
      source: item.source,
      target: item.target,
      ownership: item.ownership,
      state:
        item.action === 'preserve-merged'
          ? 'merged'
          : item.action === 'preserve-removed'
            ? 'removed'
            : 'managed',
      hash: preserved ? null : item.action === 'seed-skip' ? item.beforeHash : item.afterHash,
    }
  })

  if (priorLock) {
    const seen = new Set(entries.map((e) => e.target))
    for (const target of priorLock.merged ?? []) {
      if (!seen.has(target)) {
        seen.add(target)
        entries.push({
          source: target,
          target,
          ownership: 'managed',
          state: 'merged',
          hash: null,
        })
      }
    }
    for (const target of priorLock.removed ?? []) {
      if (!seen.has(target)) {
        seen.add(target)
        entries.push({
          source: target,
          target,
          ownership: 'managed',
          state: 'removed',
          hash: null,
        })
      }
    }
  }

  return entries.sort((left, right) => left.target.localeCompare(right.target))
}

function checkRootIdentity(root, plan) {
  if (plan.rootIdentity) {
    if (!existsSync(root)) {
      throw new Error('Adoption target root no longer exists')
    }
    const currentStat = statSync(root)
    if (
      currentStat.dev !== plan.rootIdentity.dev ||
      currentStat.ino !== plan.rootIdentity.ino ||
      currentStat.birthtimeMs !== plan.rootIdentity.birthtimeMs ||
      slash(realpathSync(root)) !== plan.rootIdentity.realpath
    ) {
      throw new Error('Adoption target root identity changed; recreated or moved root rejected')
    }
  }
}

function preflightPlanOptions(plan) {
  return {
    profile: plan.profile,
    storage: plan.storage?.mode,
    ...(plan.options
      ? {
          resolutions: plan.options.resolutions,
          seedValues: plan.options.seedValues,
          migrateLegacy: plan.options.migrateLegacy,
          recoverUnknown: plan.options.recoverUnknown,
        }
      : {}),
  }
}

function semanticEntriesEqual(aEntries, bEntries) {
  if (aEntries.length !== bEntries.length) return false
  const sortedA = [...aEntries].sort((x, y) => x.target.localeCompare(y.target))
  const sortedB = [...bEntries].sort((x, y) => x.target.localeCompare(y.target))
  for (let i = 0; i < sortedA.length; i++) {
    const a = sortedA[i]
    const b = sortedB[i]
    if (
      a.target !== b.target ||
      a.source !== b.source ||
      a.ownership !== b.ownership ||
      a.state !== b.state ||
      a.hash !== b.hash
    ) {
      return false
    }
  }
  return true
}

export function applyAdoption(
  packageRoot,
  targetDir,
  plan,
  { confirm, fault = () => {}, receiptDestination, persistReceipt } = {},
) {
  const root = safeRoot(targetDir)
  if (!plan || digest(planBase(plan)) !== plan.token)
    throw new Error('Invalid adoption plan digest')
  checkRootIdentity(root, plan)
  if (confirm !== plan?.token)
    throw new Error('Adoption confirmation does not match the plan token')
  if (plan.blocked) throw new Error('Adoption plan is blocked')
  const preflightOpts = preflightPlanOptions(plan)
  if (planAdoption(packageRoot, root, preflightOpts).token !== plan.token)
    throw new Error('Adoption plan is stale; generate a new preview')
  if (!existsSync(root)) mkdirSync(root, { recursive: true })
  return withAdoptionLock(root, () =>
    applyAdoptionUnlocked(packageRoot, root, plan, {
      confirm,
      fault,
      receiptDestination,
      persistReceipt,
    }),
  )
}

function applyAdoptionUnlocked(
  packageRoot,
  targetDir,
  plan,
  { confirm, fault = () => {}, receiptDestination, persistReceipt } = {},
) {
  const root = safeRoot(targetDir)
  checkRootIdentity(root, plan)
  if (confirm !== plan?.token)
    throw new Error('Adoption confirmation does not match the plan token')
  if (plan.blocked) throw new Error(`Adoption plan is blocked: ${plan.conflicts.join(', ')}`)
  const preflightOpts = preflightPlanOptions(plan)
  const current = planAdoption(packageRoot, targetDir, preflightOpts)
  if (plan.rootIdentity === null) {
    current.rootIdentity = null
    current.token = digest(planBase(current))
  }
  if (current.token !== plan.token)
    throw new Error('Adoption plan is stale; generate a new preview')

  const nonMutating = plan.actions.every((item) =>
    ['unchanged', 'seed-skip', 'preserve-merged', 'preserve-removed'].includes(item.action),
  )
  if (nonMutating && !plan.storage?.ignoreContentBase64 && existsSync(root)) {
    const currentLock = readLockfile(root, { strict: false })
    if (
      currentLock.version === 2 &&
      currentLock.profile === plan.profile &&
      (currentLock.package?.name ?? null) === (plan.package?.name ?? null) &&
      (currentLock.package?.version ?? null) === (plan.package?.version ?? null)
    ) {
      const intendedEntries = lockEntries(plan, currentLock)
      if (semanticEntriesEqual(currentLock.entries ?? [], intendedEntries)) {
        return {
          version: 1,
          status: 'unchanged',
          target: slash(root),
          profile: plan.profile,
          planToken: plan.token,
          changed: [],
          mutations: [],
        }
      }
    }
  }
  const transactionId = randomUUID()
  const receiptPath =
    plan.storage?.mode === 'project'
      ? `.agentflow/transactions/${transactionId}/receipt.json`
      : null
  const destination = receiptPath
    ? safeTarget(root, receiptPath)
    : receiptLocation(root, receiptDestination)
  if (!receiptPath && contained(root, destination))
    throw new Error('External receipt must remain outside the project')
  if (existsSync(destination)) throw new Error('Receipt destination already exists')
  const createdRoot = !existsSync(root)
  if (createdRoot) mkdirSync(root, { recursive: true })
  const mutations = []
  const createdDirectories = new Set()
  const journalBase = {
    version: 1,
    operation: 'adopt',
    target: slash(root),
    planToken: plan.token,
    profile: plan.profile,
    receiptDestination: destination,
    transactionId,
    receiptStage: `${destination}.${transactionId}.tmp`,
  }
  const journal = {
    ...journalBase,
    status: 'applying',
    mutations: [],
    recoveryToken: digest(journalBase),
  }
  const { mutations: _mutations, ...journalHeader } = journal
  writeJournal(root, { type: 'header', ...journalHeader }, { reset: true })
  const recordPrepared = (mutation) =>
    writeJournal(root, { type: 'prepared', mutation: journalMutation(mutation) })
  let receiptDurable = false
  try {
    if (plan.storage?.mode === 'project') {
      const manifestPath = safeTarget(
        root,
        `.agentflow/transactions/${transactionId}/manifest.json`,
      )
      mkdirSync(dirname(manifestPath), { recursive: true })
      const storageIgnore = safeTarget(root, '.agentflow/transactions/.gitignore')
      if (!existsSync(storageIgnore))
        writeFileSync(storageIgnore, '*\n', { flag: 'wx', flush: true })
      writeFileSync(
        manifestPath,
        `${JSON.stringify({ version: 1, plan, recoveryToken: journal.recoveryToken })}\n`,
        { flag: 'wx', flush: true, mode: 0o600 },
      )
      fault('manifest.after-write', { path: manifestPath })
      if (plan.storage.ignoreContentBase64 !== null)
        replaceFile({
          root,
          relPath: '.gitignore',
          content: Buffer.from(plan.storage.ignoreContentBase64, 'base64'),
          mutations,
          createdDirectories,
          fault,
          onPrepared: recordPrepared,
        })
    }
    for (const item of plan.actions.filter((entry) =>
      ['create', 'update', 'seed'].includes(entry.action),
    )) {
      const isConfig =
        item.target === 'agent-workflow.config.json' && item.ownership === 'seed-once'
      const content =
        isConfig && item.contentBase64
          ? Buffer.from(item.contentBase64, 'base64')
          : readFileSync(join(packageRoot, item.source))
      replaceFile({
        root,
        relPath: item.target,
        content,
        mutations,
        createdDirectories,
        fault,
        onPrepared: recordPrepared,
      })
    }
    const priorLock = readLockForPlan(root, {
      migrateLegacy: Boolean(plan.options?.migrateLegacy),
      recoverUnknown: Boolean(plan.options?.recoverUnknown),
    })
    const lock = lockfileV2({
      profile: plan.profile,
      packageIdentity: plan.package,
      planToken: plan.token,
      transactionId,
      entries: lockEntries(plan, priorLock),
    })
    fault('lock.before-atomic-replace', { path: 'agent-framework-lock.json' })
    replaceFile({
      root,
      relPath: 'agent-framework-lock.json',
      content: Buffer.from(serializeLockfile(lock)),
      mutations,
      createdDirectories,
      fault,
      onPrepared: recordPrepared,
    })
    fault('lock.after-atomic-replace', { path: 'agent-framework-lock.json' })
    const base = {
      version: 1,
      target: slash(root),
      profile: plan.profile,
      planToken: plan.token,
      changed: mutations.map((item) => item.path),
      mutations: mutations.map(({ target, backup, ...item }) => item),
      ...(receiptPath ? { receiptPath } : { externalReceiptDestination: destination }),
    }
    const receipt = { ...base, receiptToken: digest(base) }
    fault('receipt.before-write', {})
    if (persistReceipt) persistReceipt(receipt)
    const receiptStage = `${destination}.${transactionId}.tmp`
    writeFileSync(receiptLocation(root, receiptStage), `${JSON.stringify(receipt)}\n`, {
      flag: 'wx',
      flush: true,
      mode: 0o600,
    })
    renameSync(receiptStage, receiptLocation(root, destination))
    receiptDurable = true
    fault('receipt.after-write', {})
    for (const mutation of mutations)
      if (mutation.backup && existsSync(mutation.backup)) unlinkSync(mutation.backup)
    unlinkSync(adoptionJournalPath(root))
    return receipt
  } catch (error) {
    if (receiptDurable || existsSync(destination))
      throw new Error(
        `Adoption receipt may be durable; cleanup requires explicit recovery: ${error.message}`,
      )
    if (existsSync(journalBase.receiptStage))
      unlinkSync(receiptLocation(root, journalBase.receiptStage))
    rollbackApplied(mutations, createdDirectories)
    if (existsSync(adoptionJournalPath(root))) unlinkSync(adoptionJournalPath(root))
    if (createdRoot) {
      try {
        rmdirSync(root)
      } catch {
        // Preserve an unexpectedly non-empty target for diagnosis.
      }
    }
    throw error
  }
}

export function recoverAdoption(targetDir, { confirm } = {}) {
  const root = safeRoot(targetDir)
  return withAdoptionLock(root, () => recoverAdoptionUnlocked(root, { confirm }), {
    recovery: true,
  })
}

function recoverAdoptionUnlocked(targetDir, { confirm } = {}) {
  const root = safeRoot(targetDir)
  const journal = readAdoptionJournal(root)
  if (!journal) return { version: 1, status: 'clean' }
  if (journal.operation === 'rollback')
    return rollbackAdoptionUnlocked(root, journal.receipt, { confirm })
  const { status, mutations, recoveryToken, receiptPath, ...base } = journal
  if (
    status !== 'applying' ||
    confirm !== recoveryToken ||
    digest(base) !== recoveryToken ||
    slash(root) !== journal.target
  ) {
    throw new Error('Adoption recovery confirmation or journal digest is invalid')
  }
  const persisted =
    journal.receiptDestination ?? (receiptPath ? safeTarget(root, receiptPath) : null)
  if (persisted && existsSync(receiptLocation(root, persisted))) {
    const receipt = JSON.parse(readFileSync(receiptLocation(root, persisted), 'utf8'))
    const { receiptToken, ...receiptBase } = receipt
    if (receiptToken !== digest(receiptBase) || receipt.planToken !== journal.planToken)
      throw new Error('Durable receipt is invalid')
    for (const mutation of mutations)
      if (
        !existsSync(safeTarget(root, mutation.path)) ||
        hashContent(readFileSync(safeTarget(root, mutation.path))) !== mutation.afterHash
      )
        throw new Error(`Adoption finalization refused because ${mutation.path} drifted`)
    for (const mutation of mutations)
      for (const artifact of [mutation.stagedPath, mutation.backupPath].filter(Boolean)) {
        const path = safeTarget(root, artifact)
        if (existsSync(path)) unlinkSync(path)
      }
    if (journal.receiptStage && existsSync(journal.receiptStage))
      unlinkSync(receiptLocation(root, journal.receiptStage))
    unlinkSync(adoptionJournalPath(root))
    return { version: 1, status: 'finalized', planToken: journal.planToken, receiptPath: persisted }
  }
  const restore = []
  for (const mutation of [...mutations].reverse()) {
    const target = safeTarget(root, mutation.path)
    const current = existsSync(target) ? readFileSync(target) : null
    const currentHash = current === null ? null : hashContent(current)
    if (currentHash === mutation.afterHash) restore.push(mutation)
    else if (currentHash === mutation.beforeHash) {
      // The write-ahead entry was durable but the target mutation had not started.
    } else if (current === null && mutation.beforeContentBase64 !== null) {
      restore.push(mutation)
    } else {
      throw new Error(`Adoption recovery refused because ${mutation.path} drifted`)
    }
  }
  restoreMutationSet(root, restore)
  for (const mutation of mutations) {
    for (const artifact of [mutation.stagedPath, mutation.backupPath].filter(Boolean)) {
      const path = safeTarget(root, artifact)
      if (existsSync(path)) unlinkSync(path)
    }
  }
  removeCreatedDirectories(root, mutations)
  if (journal.receiptStage && existsSync(journal.receiptStage))
    unlinkSync(receiptLocation(root, journal.receiptStage))
  unlinkSync(adoptionJournalPath(root))
  return { version: 1, status: 'recovered', planToken: journal.planToken }
}

export function rollbackAdoption(targetDir, receipt, { confirm, fault = () => {} } = {}) {
  const root = safeRoot(targetDir)
  return withAdoptionLock(root, () => rollbackAdoptionUnlocked(root, receipt, { confirm, fault }), {
    recovery: true,
  })
}

function rollbackAdoptionUnlocked(targetDir, receipt, { confirm, fault = () => {} } = {}) {
  const { receiptToken, ...base } = receipt ?? {}
  if (confirm !== receiptToken || digest(base) !== receiptToken) {
    throw new Error('Adoption rollback confirmation or receipt digest is invalid')
  }
  const root = safeRoot(targetDir)
  if (slash(root) !== receipt.target) {
    throw new Error('Adoption rollback receipt does not match the target root')
  }
  if (existsSync(adoptionJournalPath(root)))
    throw new Error('Recover unfinished adoption before rollback')
  const journalPath = safeTarget(root, ROLLBACK_JOURNAL_NAME)
  let journal
  if (existsSync(journalPath)) {
    journal = JSON.parse(readFileSync(journalPath, 'utf8'))
    const { digest: expected, ...value } = journal
    if (digest(value) !== expected || journal.receipt?.receiptToken !== receiptToken)
      throw new Error('Rollback journal identity mismatch')
  } else {
    const after = {}
    for (const mutation of receipt.mutations) {
      const target = safeTarget(root, mutation.path)
      const content = existsSync(target) ? readFileSync(target) : null
      if (content === null || hashContent(content) !== mutation.afterHash)
        throw new Error(`Adoption rollback refused because ${mutation.path} drifted`)
      after[mutation.path] = content.toString('base64')
    }
    const value = { version: 1, operation: 'rollback', receipt, after, recoveryToken: receiptToken }
    journal = { ...value, digest: digest(value) }
    writeFileSync(journalPath, JSON.stringify(journal) + '\n', {
      flag: 'wx',
      flush: true,
      mode: 0o600,
    })
  }
  const stageFor = (mutation) =>
    safeTarget(root, `${mutation.path}.agentflow-rollback-${receiptToken}.tmp`)
  try {
    for (const mutation of [...receipt.mutations].reverse()) {
      const target = safeTarget(root, mutation.path)
      const currentHash = existsSync(target) ? hashContent(readFileSync(target)) : null
      if (currentHash === mutation.beforeHash) continue
      if (currentHash !== mutation.afterHash)
        throw new Error(`Adoption rollback refused because ${mutation.path} drifted`)
      fault('rollback.before-remove', { path: mutation.path })
      if (mutation.beforeContentBase64 === null) unlinkSync(target)
      else {
        const stage = stageFor(mutation)
        if (existsSync(stage)) unlinkSync(stage)
        writeFileSync(stage, Buffer.from(mutation.beforeContentBase64, 'base64'), {
          flag: 'wx',
          flush: true,
        })
        renameSync(stage, target)
      }
      fault('rollback.after-remove', { path: mutation.path })
    }
  } catch (error) {
    // Ordinary failures restore the installed state; hard interruption leaves the durable journal.
    if (!error.message.includes('drifted')) {
      for (const mutation of receipt.mutations) {
        const target = safeTarget(root, mutation.path),
          stage = stageFor(mutation)
        if (existsSync(stage)) unlinkSync(stage)
        writeFileSync(stage, Buffer.from(journal.after[mutation.path], 'base64'), {
          flag: 'wx',
          flush: true,
        })
        renameSync(stage, target)
      }
      unlinkSync(journalPath)
    }
    throw error
  }
  for (const mutation of receipt.mutations) {
    const stage = stageFor(mutation)
    if (existsSync(stage)) unlinkSync(stage)
  }
  removeCreatedDirectories(root, receipt.mutations)
  unlinkSync(journalPath)
  return { version: 1, status: 'rolled-back', planToken: receipt.planToken }
}
