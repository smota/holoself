// Local append-only served-context ledger ("what each AI saw"): metadata and source handle IDs only, never content or paths.
import { closeSync, constants as fsConstants, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { linkPath, readLink } from './link/config.mjs'
import { assertNoLinkBelow } from './path-guard.mjs'
import { assertContainedPath, hash, pathExists } from './shared/fs.mjs'
import { redactRootPaths } from './shared/redact.mjs'

export const LEDGER_SCHEMA_VERSION = 1
export const LEDGER_MAX_BYTES = 5 * 1024 * 1024
export const LEDGER_ROTATE_KEEP = 3
export const LEDGER_SURFACES = new Set(['cli', 'mcp', 'hook', 'workbench'])

export function ledgerFilePath(baseDir) {
  return join(resolve(baseDir), '.holoself', 'ledger.ndjson')
}

export function rotatedLedgerFilePath(baseDir, index) {
  return join(resolve(baseDir), '.holoself', `ledger.${index}.ndjson`)
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
  if (!linkCfg && project && pathExists(linkPath(project))) {
    try {
      const resolvedLink = readLink(project, { tolerant: true })
      if (resolvedLink?.ledger && typeof resolvedLink.ledger === 'object') linkCfg = resolvedLink.ledger
      if (!selfRoot && resolvedLink?.path) selfRoot = resolvedLink.path
    } catch {}
  }
  const selfCfg = readSelfLedgerConfig(selfRoot)
  const enabled = linkCfg?.enabled !== undefined ? linkCfg.enabled !== false : selfCfg?.enabled !== undefined ? selfCfg.enabled !== false : true
  const recordTaskText =
    linkCfg?.record_task_text !== undefined ? linkCfg.record_task_text === true : selfCfg?.record_task_text === true
  return { enabled, record_task_text: recordTaskText }
}

export function buildLedgerEntry(data, { surface = 'cli', host = null, recordTaskText = false, servedAt = null } = {}) {
  if (!LEDGER_SURFACES.has(surface)) {
    const err = new Error(`unsupported ledger surface: ${surface}`)
    err.code = 'LEDGER_SURFACE_INVALID'
    throw err
  }
  const rawSources = Array.isArray(data?.context_receipt?.source_ids)
    ? data.context_receipt.source_ids
    : Array.isArray(data?.sources)
      ? data.sources.map(item => item?.source_id)
      : []
  const sourceIds = rawSources.filter(id => typeof id === 'string' && /^hs-[A-Za-z0-9_-]+$/.test(id))
  const documentsDelivered =
    (Array.isArray(data?.self?.documents) ? data.self.documents.length : 0) +
    (Array.isArray(data?.project?.documents) ? data.project.documents.length : 0) +
    (Array.isArray(data?.methods?.documents) ? data.methods.documents.length : 0)
  const restrictedCount = Array.isArray(data?.restrictions)
    ? data.restrictions.reduce((sum, item) => sum + (Number.isInteger(item?.count) && item.count > 0 ? item.count : 1), 0)
    : 0
  const envelopeDroppedCount = Array.isArray(data?.selection?.envelope_dropped) ? data.selection.envelope_dropped.length : 0
  const taskText = typeof data?.task === 'string' && data.task.length > 0 ? data.task : null
  const taskSha256 = taskText !== null ? hash(taskText) : null

  return {
    schema_version: LEDGER_SCHEMA_VERSION,
    served_at: servedAt || new Date().toISOString(),
    surface,
    host: sanitizeLedgerHost(host),
    lens: typeof data?.lens === 'string' ? data.lens : null,
    budget: data?.selection?.budget || data?.context_receipt?.budget || 'standard',
    need: data?.selection?.context_need || data?.status || 'complete',
    task_sha256: taskSha256,
    ...(recordTaskText ? { task: taskText } : {}),
    context_hash: typeof data?.context_receipt?.context_hash === 'string' ? data.context_receipt.context_hash : null,
    packet_id: typeof data?.packet_metadata?.packet_id === 'string' ? data.packet_metadata.packet_id : null,
    source_ids: sourceIds,
    counts: {
      documents_delivered: documentsDelivered,
      restricted: restrictedCount,
      envelope_dropped: envelopeDroppedCount
    },
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
    assertNoLinkBelow(baseDir, filePath, 'served-context ledger file')
  } catch (error) {
    throw Object.assign(error, { code: error?.code || 'LEDGER_SYMLINK_REFUSED' })
  }
  return st
}

function rotateLedgerFiles(baseDir, maxKeep = LEDGER_ROTATE_KEEP) {
  const activePath = ledgerFilePath(baseDir)
  assertSafeLedgerSlot(baseDir, activePath)
  for (let i = 1; i <= maxKeep; i++) {
    assertSafeLedgerSlot(baseDir, rotatedLedgerFilePath(baseDir, i))
  }
  const oldestPath = rotatedLedgerFilePath(baseDir, maxKeep)
  if (lstatSync(oldestPath, { throwIfNoEntry: false })) {
    rmSync(oldestPath, { force: true })
  }
  for (let i = maxKeep - 1; i >= 1; i--) {
    const src = rotatedLedgerFilePath(baseDir, i)
    const dst = rotatedLedgerFilePath(baseDir, i + 1)
    if (lstatSync(src, { throwIfNoEntry: false })) {
      renameSync(src, dst)
    }
  }
  if (lstatSync(activePath, { throwIfNoEntry: false })) {
    renameSync(activePath, rotatedLedgerFilePath(baseDir, 1))
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

  const activePath = ledgerFilePath(baseDir)
  const activeStat = assertSafeLedgerSlot(baseDir, activePath)
  for (let i = 1; i <= keep; i++) {
    assertSafeLedgerSlot(baseDir, rotatedLedgerFilePath(baseDir, i))
  }

  const line = `${JSON.stringify(entry)}\n`
  const lineBytes = Buffer.byteLength(line)

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
    const resolvedHost = detectLedgerHost({ clientInfoName, explicitHost: host, env })
    const entry = buildLedgerEntry(data, {
      surface,
      host: resolvedHost,
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
