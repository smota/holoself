// Local append-only served-context ledger ("what each AI saw"): metadata and source handle IDs only, never content or paths.
import { createHmac, randomBytes } from 'node:crypto'
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync
} from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { ensureHoloselfGitignore, linkPath, readLink } from './link/config.mjs'
import { isPidAlive } from './link/registry.mjs'
import { assertNoLinkBelow } from './path-guard.mjs'
import { assertContainedPath, pathExists } from './shared/fs.mjs'
import { redactRootPaths } from './shared/redact.mjs'

export const LEDGER_SCHEMA_VERSION = 2
export const LEDGER_MAX_BYTES = 5 * 1024 * 1024
export const LEDGER_ROTATE_KEEP = 3
export const LEDGER_SURFACES = new Set(['cli', 'mcp', 'hook', 'workbench'])
export const LEDGER_MODES = new Set(['packet', 'manifest', 'get'])
export const LEDGER_LOCK_STALE_MS = 10000

const LOCK_CONTENTION_CODES = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY'])
const ledgerWaitBuffer = typeof SharedArrayBuffer === 'function' ? new Int32Array(new SharedArrayBuffer(4)) : null

export function sleepLedgerMs(ms) {
  const waitMs = Math.max(1, Math.min(100, Math.floor(Number(ms) || 1)))
  if (ledgerWaitBuffer) {
    try {
      Atomics.wait(ledgerWaitBuffer, 0, 0, waitMs)
      return
    } catch {}
  }
  const end = Date.now() + waitMs
  while (Date.now() < end) {}
}

function noLinkBelow(root, target, label) {
  assertNoLinkBelow(root, target, link =>
    Object.assign(new Error(`${label} traverses symlink: ${link}`), { code: 'LEDGER_SYMLINK_REFUSED' })
  )
}

function rmWithRetry(filePath) {
  const backoffs = [4, 10, 25, 50]
  for (let i = 0; i <= backoffs.length; i++) {
    try {
      rmSync(filePath, { force: true })
      return
    } catch (err) {
      if (err?.code === 'ENOENT') return
      if (LOCK_CONTENTION_CODES.has(err?.code) && i < backoffs.length) {
        sleepLedgerMs(backoffs[i])
        continue
      }
      if (!LOCK_CONTENTION_CODES.has(err?.code)) throw err
    }
  }
}

function renameWithRetry(src, dst) {
  const backoffs = [4, 10, 25, 50]
  let lastErr = null
  for (let i = 0; i <= backoffs.length; i++) {
    try {
      renameSync(src, dst)
      return
    } catch (err) {
      lastErr = err
      if (LOCK_CONTENTION_CODES.has(err?.code) && i < backoffs.length) {
        sleepLedgerMs(backoffs[i])
        continue
      }
      throw err
    }
  }
  if (lastErr) throw lastErr
}

export function ledgerFilePath(baseDir) {
  return join(resolve(baseDir), '.holoself', 'ledger.ndjson')
}

export function rotatedLedgerFilePath(baseDir, index) {
  return join(resolve(baseDir), '.holoself', `ledger.${index}.ndjson`)
}

export function ledgerLockPath(baseDir) {
  return join(resolve(baseDir), '.holoself', 'ledger.ndjson.rotate.lock')
}

export function ledgerKeyPath(selfRoot) {
  return join(resolve(selfRoot), '.holoself', 'runtime', 'ledger.key')
}

export function getOrCreateLedgerKey(selfRoot) {
  if (selfRoot && typeof selfRoot === 'string' && isAbsolute(selfRoot)) {
    const resolvedSelf = resolve(selfRoot)
    const rootStat = lstatSync(resolvedSelf, { throwIfNoEntry: false })
    if (rootStat && !rootStat.isSymbolicLink() && rootStat.isDirectory()) {
      const keyFile = ledgerKeyPath(resolvedSelf)
      assertContainedPath(resolvedSelf, keyFile, 'ledger HMAC key')
      const existingSt = lstatSync(keyFile, { throwIfNoEntry: false })
      if (existingSt) {
        if (existingSt.isSymbolicLink() || !existingSt.isFile() || existingSt.nlink !== 1) {
          throw Object.assign(new Error('ledger HMAC key refuses symlink or non-regular file'), { code: 'LEDGER_SYMLINK_REFUSED' })
        }
        noLinkBelow(resolvedSelf, keyFile, 'ledger HMAC key')
        const existingBuf = readFileSync(keyFile)
        if (existingBuf.length >= 32) return existingBuf
      }
      ensureHoloselfGitignore(resolvedSelf)
      const runtimeDir = join(resolvedSelf, '.holoself', 'runtime')
      mkdirSync(runtimeDir, { recursive: true })
      noLinkBelow(resolvedSelf, runtimeDir, 'ledger HMAC key directory')
      const generated = randomBytes(32)
      const noFollow = fsConstants.O_NOFOLLOW || 0
      for (let attempt = 0; attempt < 8; attempt++) {
        try {
          const fd = openSync(keyFile, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollow, 0o600)
          try {
            try {
              fchmodSync(fd, 0o600)
            } catch {}
            writeSync(fd, generated)
          } finally {
            closeSync(fd)
          }
          return generated
        } catch (err) {
          if (LOCK_CONTENTION_CODES.has(err?.code)) {
            sleepLedgerMs(5 + attempt * 5)
            try {
              const retrySt = lstatSync(keyFile, { throwIfNoEntry: false })
              if (retrySt) {
                if (retrySt.isSymbolicLink() || !retrySt.isFile() || retrySt.nlink !== 1) {
                  throw Object.assign(new Error('ledger HMAC key refuses symlink or non-regular file'), { code: 'LEDGER_SYMLINK_REFUSED' })
                }
                const retryBuf = readFileSync(keyFile)
                if (retryBuf.length >= 32) return retryBuf
              }
            } catch (readErr) {
              if (readErr?.code === 'LEDGER_SYMLINK_REFUSED') throw readErr
            }
            continue
          }
          throw err
        }
      }
    }
  }
  if (!globalThis.__HOLOSELF_LEDGER_KEY__) globalThis.__HOLOSELF_LEDGER_KEY__ = randomBytes(32)
  return globalThis.__HOLOSELF_LEDGER_KEY__
}

export function computeTaskHmac(task, ledgerKey) {
  if (typeof task !== 'string' || !task.length) return null
  const key = ledgerKey || getOrCreateLedgerKey(null)
  return createHmac('sha256', key).update(task, 'utf8').digest('hex')
}

function sanitizeLedgerHost(raw) {
  if (typeof raw !== 'string') return null
  const cleaned = raw
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\\\\[^\s;]+/g, '<local-path>')
    .replace(/[A-Za-z]:[\\/][^\s;]+/g, '<local-path>')
    .replace(/(^|[\s("'=])\/(?:[^\s;]+\/?)+/g, '$1<local-path>')
    .trim()
    .slice(0, 120)
  return cleaned || null
}

export function detectLedgerHost({ clientInfoName = null, explicitHost = null, env = process.env } = {}) {
  const fromClient = sanitizeLedgerHost(clientInfoName)
  if (fromClient) return fromClient
  const fromExplicit = sanitizeLedgerHost(explicitHost)
  if (fromExplicit) return fromExplicit
  const fromEnvOverride = sanitizeLedgerHost(env?.HOLOSELF_HOST)
  if (fromEnvOverride) return fromEnvOverride
  if (!env || typeof env !== 'object') return null
  if (env.CLAUDE_CODE || env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT || env.CLAUDE_PROJECT_DIR) return 'claude'
  if (env.CODEX || env.CODEX_SANDBOX || env.CODEX_THREAD_ID || env.CODEX_HOME || env.CODEX_CI) return 'codex'
  if (env.AGY || env.AGY_SESSION || env.ANTIGRAVITY || env.ANTIGRAVITY_AGENT || env.ANTIGRAVITY_CLI) return 'agy'
  return null
}

function readSelfLedgerConfig(selfRoot) {
  if (!selfRoot || typeof selfRoot !== 'string') return null
  const cfgFile = join(resolve(selfRoot), 'config.json')
  try {
    if (!existsSync(cfgFile) || lstatSync(cfgFile).isSymbolicLink()) return null
    const parsed = JSON.parse(readFileSync(cfgFile, 'utf8'))
    return parsed?.ledger && typeof parsed.ledger === 'object' && !Array.isArray(parsed.ledger) ? parsed.ledger : null
  } catch {
    return null
  }
}

export function resolveLedgerConfig({ project = null, self = null, link = null } = {}) {
  let linkCfg = link?.ledger && typeof link.ledger === 'object' ? link.ledger : null
  let selfRoot = self || link?.path || null
  if (project && pathExists(linkPath(project))) {
    try {
      const resolvedLink = readLink(project, { tolerant: true })
      if (!linkCfg && resolvedLink?.ledger && typeof resolvedLink.ledger === 'object') linkCfg = resolvedLink.ledger
      if (!selfRoot && resolvedLink?.path) selfRoot = resolvedLink.path
    } catch {}
  }
  const selfCfg = readSelfLedgerConfig(selfRoot)
  const enabled = linkCfg?.enabled !== undefined ? linkCfg.enabled !== false : selfCfg?.enabled !== undefined ? selfCfg.enabled !== false : true
  const recordTaskText =
    linkCfg?.record_task_text !== undefined ? linkCfg.record_task_text === true : selfCfg?.record_task_text === true
  return { enabled, record_task_text: recordTaskText, selfRoot: selfRoot ? resolve(selfRoot) : null }
}

function inferLedgerMode(data, requestedMode) {
  if (requestedMode) {
    if (!LEDGER_MODES.has(requestedMode)) {
      const err = new Error(`unsupported ledger mode: ${requestedMode}`)
      err.code = 'LEDGER_MODE_INVALID'
      throw err
    }
    return requestedMode
  }
  const allDocs = [
    ...(Array.isArray(data?.self?.documents) ? data.self.documents : []),
    ...(Array.isArray(data?.project?.documents) ? data.project.documents : []),
    ...(Array.isArray(data?.methods?.documents) ? data.methods.documents : [])
  ]
  if (allDocs.length > 0 && allDocs.every(doc => doc?.manifest_only === true)) return 'manifest'
  return 'packet'
}

export function buildLedgerEntry(
  data,
  { surface = 'cli', mode = null, host = null, ledgerKey = null, recordTaskText = false, servedAt = null } = {}
) {
  if (!LEDGER_SURFACES.has(surface)) {
    const err = new Error(`unsupported ledger surface: ${surface}`)
    err.code = 'LEDGER_SURFACE_INVALID'
    throw err
  }
  const resolvedMode = inferLedgerMode(data, mode)
  const rawSources = Array.isArray(data?.context_receipt?.source_ids)
    ? data.context_receipt.source_ids
    : Array.isArray(data?.sources)
      ? data.sources.map(item => item?.source_id)
      : []
  const sourceIds = rawSources.filter(id => typeof id === 'string' && /^hs-[A-Za-z0-9_-]+$/.test(id))
  const itemCount =
    (Array.isArray(data?.self?.documents) ? data.self.documents.length : 0) +
    (Array.isArray(data?.project?.documents) ? data.project.documents.length : 0) +
    (Array.isArray(data?.methods?.documents) ? data.methods.documents.length : 0)
  const restrictedCount = Array.isArray(data?.restrictions)
    ? data.restrictions.reduce((sum, item) => sum + (Number.isInteger(item?.count) && item.count > 0 ? item.count : 1), 0)
    : 0
  const envelopeDroppedCount = Array.isArray(data?.selection?.envelope_dropped) ? data.selection.envelope_dropped.length : 0
  const taskText = typeof data?.task === 'string' && data.task.length > 0 ? data.task : null
  const taskHmac = computeTaskHmac(taskText, ledgerKey)

  const counts =
    resolvedMode === 'manifest'
      ? {
          items_listed: itemCount,
          restricted: restrictedCount,
          envelope_dropped: envelopeDroppedCount
        }
      : {
          documents_delivered: itemCount,
          restricted: restrictedCount,
          envelope_dropped: envelopeDroppedCount
        }

  return {
    schema_version: LEDGER_SCHEMA_VERSION,
    served_at: servedAt || new Date().toISOString(),
    surface,
    mode: resolvedMode,
    host: sanitizeLedgerHost(host),
    lens: typeof data?.lens === 'string' ? data.lens : null,
    budget: data?.selection?.budget || data?.context_receipt?.budget || 'standard',
    need: data?.selection?.context_need || data?.status || 'complete',
    task_hmac: taskHmac,
    ...(recordTaskText ? { task: taskText } : {}),
    context_hash: typeof data?.context_receipt?.context_hash === 'string' ? data.context_receipt.context_hash : null,
    packet_id: typeof data?.packet_metadata?.packet_id === 'string' ? data.packet_metadata.packet_id : null,
    source_ids: sourceIds,
    counts,
    total_bytes: Number.isInteger(data?.selection?.total_bytes) ? data.selection.total_bytes : 0
  }
}

function assertSafeLedgerTarget(baseDir) {
  if (typeof baseDir !== 'string' || !baseDir.trim() || !isAbsolute(baseDir)) {
    throw Object.assign(new Error('served-context ledger requires an absolute base directory'), { code: 'LEDGER_PATH_INVALID' })
  }
  const rootStat = lstatSync(baseDir, { throwIfNoEntry: false })
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw Object.assign(new Error('served-context ledger base directory is not a safe directory'), { code: 'LEDGER_SYMLINK_REFUSED' })
  }
  const holoselfDir = join(baseDir, '.holoself')
  assertContainedPath(baseDir, holoselfDir, 'served-context ledger directory')
  const dirStat = lstatSync(holoselfDir, { throwIfNoEntry: false })
  if (dirStat) {
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
      throw Object.assign(new Error('served-context ledger refuses symlink or non-directory .holoself'), { code: 'LEDGER_SYMLINK_REFUSED' })
    }
  }
  return holoselfDir
}

function assertSafeLedgerSlot(baseDir, filePath) {
  const st = lstatSync(filePath, { throwIfNoEntry: false })
  if (st) {
    if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1) {
      throw Object.assign(new Error('served-context ledger refuses symlink or non-regular file'), { code: 'LEDGER_SYMLINK_REFUSED' })
    }
  }
  try {
    assertContainedPath(baseDir, filePath, 'served-context ledger file')
    noLinkBelow(baseDir, filePath, 'served-context ledger file')
  } catch (error) {
    throw Object.assign(error, { code: error?.code || 'LEDGER_SYMLINK_REFUSED' })
  }
  return st
}

function inspectLockFile(filePath, staleMs) {
  let st
  try {
    st = lstatSync(filePath, { throwIfNoEntry: false })
  } catch (err) {
    if (err?.code === 'ENOENT' || LOCK_CONTENTION_CODES.has(err?.code)) return { exists: false, stale: false }
    throw err
  }
  if (!st) return { exists: false, stale: false }
  if (st.isSymbolicLink()) {
    throw Object.assign(new Error('served-context ledger refuses symlink lock file'), { code: 'LEDGER_SYMLINK_REFUSED' })
  }
  let raw = ''
  try {
    raw = readFileSync(filePath, 'utf8').trim()
  } catch (err) {
    if (err?.code === 'ENOENT' || LOCK_CONTENTION_CODES.has(err?.code)) return { exists: false, stale: false }
    return { exists: true, stale: Date.now() - st.mtimeMs > Math.min(staleMs, 2000), raw: '', mtimeMs: st.mtimeMs }
  }
  if (!raw) {
    return { exists: true, stale: Date.now() - st.mtimeMs > Math.min(staleMs, 2000), raw: '', mtimeMs: st.mtimeMs }
  }
  try {
    const parsed = JSON.parse(raw)
    const age = Date.now() - Number(parsed?.timestamp || 0)
    const deadPid = Number.isInteger(parsed?.pid) && parsed.pid > 0 && !isPidAlive(parsed.pid)
    return { exists: true, stale: age > staleMs || deadPid, raw, mtimeMs: st.mtimeMs }
  } catch {
    return { exists: true, stale: Date.now() - st.mtimeMs > Math.min(staleMs, 2000), raw, mtimeMs: st.mtimeMs }
  }
}

export function withLedgerLock(baseDir, fn, { staleMs = LEDGER_LOCK_STALE_MS } = {}) {
  const lockFile = ledgerLockPath(baseDir)
  assertContainedPath(baseDir, lockFile, 'served-context ledger lock')
  noLinkBelow(baseDir, lockFile, 'served-context ledger lock')
  const noFollow = fsConstants.O_NOFOLLOW || 0
  let acquired = false
  for (let attempt = 0; attempt < 600; attempt++) {
    try {
      const preSt = lstatSync(lockFile, { throwIfNoEntry: false })
      if (preSt && preSt.isSymbolicLink()) {
        throw Object.assign(new Error('served-context ledger refuses symlink lock file'), { code: 'LEDGER_SYMLINK_REFUSED' })
      }
      const fd = openSync(lockFile, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollow, 0o600)
      try {
        const payload = `${JSON.stringify({ pid: process.pid, timestamp: Date.now() })}\n`
        writeSync(fd, payload)
      } finally {
        closeSync(fd)
      }
      acquired = true
      break
    } catch (err) {
      if (err?.code === 'ELOOP' || err?.code === 'LEDGER_SYMLINK_REFUSED') {
        throw Object.assign(new Error('served-context ledger refuses symlink lock file'), { code: 'LEDGER_SYMLINK_REFUSED' })
      }
      if (!LOCK_CONTENTION_CODES.has(err?.code) && err?.code !== 'ENOENT') throw err

      const first = inspectLockFile(lockFile, staleMs)
      if (first.stale) {
        sleepLedgerMs(3)
        const second = inspectLockFile(lockFile, staleMs)
        if (second.stale && second.raw === first.raw && second.mtimeMs === first.mtimeMs) {
          const stalePath = `${lockFile}.stale-${process.pid}-${randomBytes(4).toString('hex')}`
          let renamed = false
          try {
            renameSync(lockFile, stalePath)
            renamed = true
          } catch (renameErr) {
            if (!LOCK_CONTENTION_CODES.has(renameErr?.code) && renameErr?.code !== 'ENOENT') {
              throw renameErr
            }
          }
          if (renamed) {
            const verify = inspectLockFile(stalePath, staleMs)
            if (!verify.stale && verify.exists) {
              try {
                renameSync(stalePath, lockFile)
              } catch {
                rmWithRetry(stalePath)
              }
            } else {
              rmWithRetry(stalePath)
              continue
            }
          }
        }
      }
      sleepLedgerMs(Math.min(20, 3 + (attempt % 12)))
    }
  }
  if (!acquired) {
    throw Object.assign(new Error('timed out acquiring served-context ledger lock'), { code: 'LEDGER_LOCK_TIMEOUT' })
  }
  try {
    return fn()
  } finally {
    const releasePath = `${lockFile}.stale-${process.pid}-${randomBytes(4).toString('hex')}`
    try {
      renameWithRetry(lockFile, releasePath)
      rmWithRetry(releasePath)
    } catch {
      rmWithRetry(lockFile)
    }
  }
}

function rotateLedgerFiles(baseDir, maxKeep = LEDGER_ROTATE_KEEP) {
  const activePath = ledgerFilePath(baseDir)
  assertSafeLedgerSlot(baseDir, activePath)
  for (let i = 1; i <= maxKeep; i++) {
    assertSafeLedgerSlot(baseDir, rotatedLedgerFilePath(baseDir, i))
  }
  const oldestPath = rotatedLedgerFilePath(baseDir, maxKeep)
  if (lstatSync(oldestPath, { throwIfNoEntry: false })) {
    rmWithRetry(oldestPath)
  }
  for (let i = maxKeep - 1; i >= 1; i--) {
    const src = rotatedLedgerFilePath(baseDir, i)
    const dst = rotatedLedgerFilePath(baseDir, i + 1)
    if (lstatSync(src, { throwIfNoEntry: false })) {
      renameWithRetry(src, dst)
    }
  }
  if (lstatSync(activePath, { throwIfNoEntry: false })) {
    renameWithRetry(activePath, rotatedLedgerFilePath(baseDir, 1))
  }
}

export function appendLedgerLine(baseDir, entry, { maxBytes = LEDGER_MAX_BYTES, keep = LEDGER_ROTATE_KEEP } = {}) {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw Object.assign(new Error('ledger maxBytes must be a positive integer'), { code: 'LEDGER_CONFIG_INVALID' })
  }
  const holoselfDir = assertSafeLedgerTarget(baseDir)
  if (!existsSync(holoselfDir)) {
    mkdirSync(holoselfDir, { recursive: true })
  }
  assertSafeLedgerTarget(baseDir)

  const line = `${JSON.stringify(entry)}\n`
  const lineBytes = Buffer.byteLength(line)

  return withLedgerLock(baseDir, () => {
    ensureHoloselfGitignore(baseDir)
    const activePath = ledgerFilePath(baseDir)
    const activeStat = assertSafeLedgerSlot(baseDir, activePath)
    for (let i = 1; i <= keep; i++) {
      assertSafeLedgerSlot(baseDir, rotatedLedgerFilePath(baseDir, i))
    }

    if (activeStat && (activeStat.size >= maxBytes || (activeStat.size > 0 && activeStat.size + lineBytes > maxBytes))) {
      rotateLedgerFiles(baseDir, keep)
    }

    const noFollow = fsConstants.O_NOFOLLOW || 0
    const fd = openSync(activePath, fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY | noFollow, 0o600)
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.nlink !== 1) {
        throw Object.assign(new Error('served-context ledger target is not a single-linked regular file'), { code: 'LEDGER_SYMLINK_REFUSED' })
      }
      try {
        fchmodSync(fd, 0o600)
      } catch {}
      writeSync(fd, line)
    } finally {
      closeSync(fd)
    }
    return true
  })
}

export function scrubLedgerError(error, roots = []) {
  const raw = String(error?.message || error || 'served-context ledger write failed')
  const redacted = redactRootPaths(raw, roots.filter(Boolean))
  return redacted
    .replace(/\\\\[^\s;]+/g, '<local-path>')
    .replace(/[A-Za-z]:[\\/][^\s;]+/g, '<local-path>')
    .replace(/(^|[\s("'=])\/(?:[^\s;]+\/?)+/g, '$1<local-path>')
    .slice(0, 400)
}

export function recordServedPacket({
  data,
  project = null,
  self = null,
  link = null,
  surface = 'cli',
  mode = null,
  host = null,
  clientInfoName = null,
  env = process.env,
  maxBytes = LEDGER_MAX_BYTES,
  keep = LEDGER_ROTATE_KEEP,
  onFailure = null
} = {}) {
  try {
    const targetDir = project ? resolve(project) : self ? resolve(self) : null
    if (!targetDir) return null
    const cfg = resolveLedgerConfig({ project: project ? resolve(project) : null, self: self ? resolve(self) : null, link })
    if (!cfg.enabled) return null
    const selfRoot = cfg.selfRoot || (self ? resolve(self) : null)
    const ledgerKey = getOrCreateLedgerKey(selfRoot)
    const resolvedHost = detectLedgerHost({ clientInfoName, explicitHost: host, env })
    const entry = buildLedgerEntry(data, {
      surface,
      mode,
      host: resolvedHost,
      ledgerKey,
      recordTaskText: cfg.record_task_text
    })
    appendLedgerLine(targetDir, entry, { maxBytes, keep })
    return entry
  } catch (error) {
    if (typeof onFailure === 'function') {
      try {
        const safeMessage = scrubLedgerError(error, [project, self, link?.path])
        onFailure({ code: error?.code || 'LEDGER_WRITE_ERROR', message: safeMessage })
      } catch {}
    }
    return null
  }
}

export function readLedgerEntries(baseDir, { since = null, lens = null, surface = null, limit = null, keep = LEDGER_ROTATE_KEEP } = {}) {
  let sinceMs = null
  if (since !== null && since !== undefined && since !== '') {
    const str = String(since).trim()
    const iso = /^\d{4}-\d{2}-\d{2}$/.test(str) ? `${str}T00:00:00.000Z` : str
    sinceMs = Date.parse(iso)
    if (Number.isNaN(sinceMs)) {
      const err = new Error(`invalid --since timestamp: ${since}`)
      err.code = 'INVALID_LEDGER_FILTER'
      throw err
    }
  }
  if (surface !== null && surface !== undefined && surface !== '') {
    if (!LEDGER_SURFACES.has(surface)) {
      const err = new Error(`invalid --surface value: ${surface}; expected cli, mcp, hook, or workbench`)
      err.code = 'INVALID_LEDGER_FILTER'
      throw err
    }
  }
  let limitNum = null
  if (limit !== null && limit !== undefined && limit !== '') {
    limitNum = Number(limit)
    if (!Number.isInteger(limitNum) || limitNum < 1) {
      const err = new Error(`invalid --limit value: ${limit}; expected a positive integer`)
      err.code = 'INVALID_LEDGER_FILTER'
      throw err
    }
  }

  const targetDir = resolve(baseDir)
  assertSafeLedgerTarget(targetDir)
  const files = []
  for (let i = keep; i >= 1; i--) {
    const rotated = rotatedLedgerFilePath(targetDir, i)
    const st = assertSafeLedgerSlot(targetDir, rotated)
    if (st) files.push(rotated)
  }
  const active = ledgerFilePath(targetDir)
  const activeSt = assertSafeLedgerSlot(targetDir, active)
  if (activeSt) files.push(active)

  const entries = []
  for (const file of files) {
    const raw = readFileSync(file, 'utf8')
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue
      let parsed
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      if (sinceMs !== null) {
        const atMs = Date.parse(parsed.served_at || '')
        if (Number.isNaN(atMs) || atMs < sinceMs) continue
      }
      if (lens && parsed.lens !== lens) continue
      if (surface && parsed.surface !== surface) continue
      entries.push(parsed)
    }
  }
  if (limitNum !== null && entries.length > limitNum) {
    return entries.slice(-limitNum)
  }
  return entries
}
