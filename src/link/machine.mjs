// Portable link identifiers and the per-machine self map (docs/decisions/portable-links.md).
//
// A self root carries a random `self_id` in its committed config.json; a linked project carries a random `project_key`
// in its link.yaml. The only machine-specific fact, where a self is checked out on this machine, lives in the per-user
// `selves.json` under the configuration directory. Reading never writes, and an unsafe or malformed map fails closed:
// it yields no entries and a diagnostic, never an exception.
import { randomBytes } from 'node:crypto'
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { defaultConfigDir } from '../cli/args.mjs'
import { lstat } from '../path-guard.mjs'
import { atomicWrite, fileModeOr, safeRealpath, slash, sleepSync } from '../shared/fs.mjs'

export const SELF_ID_PATTERN = /^hs-self-[0-9a-f]{32}$/
export const PROJECT_KEY_PATTERN = /^hs-proj-[0-9a-f]{32}$/
export const SELVES_FILE = 'selves.json'
export const isSelfId = value => typeof value === 'string' && SELF_ID_PATTERN.test(value)
export const isProjectKey = value => typeof value === 'string' && PROJECT_KEY_PATTERN.test(value)
export const newSelfId = () => `hs-self-${randomBytes(16).toString('hex')}`
export const newProjectKey = () => `hs-proj-${randomBytes(16).toString('hex')}`

const machineError = (message, code) => Object.assign(new Error(message), { code })

// A canonical self root: a real directory (not a link) holding config.json, profile/ and context/.
export function isCanonicalSelf(path) {
  if (!path || !lstat(path)) return false
  const real = safeRealpath(path)
  try {
    const st = lstatSync(real)
    if (!st.isDirectory() || st.isSymbolicLink()) return false
  } catch {
    return false
  }
  return existsSync(join(real, 'config.json')) && existsSync(join(real, 'profile')) && existsSync(join(real, 'context'))
}

function readConfigObject(root) {
  const path = join(root, 'config.json'),
    info = lstat(path)
  if (!info || info.isSymbolicLink() || !info.isFile()) return null
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

// The self_id recorded in a self root's config.json, or null when absent, invalid or unreadable.
export function selfIdOf(root) {
  if (!root) return null
  const config = readConfigObject(safeRealpath(resolve(root)))
  return config && isSelfId(config.self_id) ? config.self_id : null
}

// Short synchronous lock (exclusive create) shared by the self map and the config.json self_id writer.
export function withFileLockSync(lockPath, fn) {
  const deadline = Date.now() + 5000
  while (true) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600)
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, timestamp: Date.now() }) + '\n')
      } finally {
        closeSync(fd)
      }
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let stale = false
      try {
        const held = JSON.parse(readFileSync(lockPath, 'utf8'))
        let holderGone = false
        if (Number.isInteger(held.pid) && held.pid !== process.pid)
          try {
            process.kill(held.pid, 0)
          } catch (probe) {
            holderGone = probe.code === 'ESRCH'
          }
        stale = holderGone || Date.now() - (held.timestamp || 0) > 10000
      } catch {
        stale = Date.now() - (lstat(lockPath)?.mtimeMs || Date.now()) > 10000
      }
      if (stale) {
        rmSync(lockPath, { force: true })
        continue
      }
      if (Date.now() > deadline) throw machineError(`timed out waiting for lock ${lockPath}`, 'LOCK_TIMEOUT')
      sleepSync(25)
    }
  }
  try {
    return fn()
  } finally {
    rmSync(lockPath, { force: true })
  }
}

// Adds a random self_id to an existing self's config.json, preserving every other field. Returns the id.
export function ensureSelfId(root) {
  const real = safeRealpath(resolve(root))
  if (!isCanonicalSelf(real)) throw machineError(`not a canonical self root: ${real}`, 'SELF_ROOT_NOT_CANONICAL')
  const runtime = join(real, '.holoself', 'runtime')
  for (const dir of [join(real, '.holoself'), runtime]) {
    const info = lstat(dir)
    if (info && (info.isSymbolicLink() || !info.isDirectory())) throw machineError(`unsafe self metadata directory: ${dir}`, 'SELF_ROOT_NOT_CANONICAL')
  }
  mkdirSync(runtime, { recursive: true })
  return withFileLockSync(join(runtime, 'self-id.lock'), () => {
    const path = join(real, 'config.json'),
      info = lstat(path)
    if (!info || info.isSymbolicLink() || !info.isFile()) throw machineError(`config.json is not a regular file: ${path}`, 'SELF_CONFIG_INVALID')
    let config
    try {
      config = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      throw machineError(`config.json is invalid JSON: ${path}`, 'SELF_CONFIG_INVALID')
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw machineError(`config.json must be an object: ${path}`, 'SELF_CONFIG_INVALID')
    if (config.self_id !== undefined) {
      if (!isSelfId(config.self_id)) throw machineError('config.json self_id is invalid; expected hs-self-<32 lowercase hex>', 'SELF_CONFIG_INVALID')
      return config.self_id
    }
    const self_id = newSelfId()
    atomicWrite(path, JSON.stringify({ ...config, self_id }, null, 2) + '\n', { mode: fileModeOr(path, 0o644), exactMode: true })
    return self_id
  })
}

export function selvesPath(env = process.env) {
  return join(defaultConfigDir(env), SELVES_FILE)
}

function mapSchemaErrors(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['selves.json must be an object']
  const errors = []
  for (const key of Object.keys(value)) if (!['schema_version', 'selves'].includes(key)) errors.push(`unknown selves.json field: ${key}`)
  if (value.schema_version !== 1) errors.push('selves.json schema_version must be 1')
  if (!value.selves || typeof value.selves !== 'object' || Array.isArray(value.selves)) return [...errors, 'selves.json selves must be an object']
  for (const [id, entry] of Object.entries(value.selves)) {
    if (!isSelfId(id)) errors.push(`invalid self id in selves.json: ${id}`)
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(key => !['path', 'updated_at'].includes(key)))
      errors.push(`invalid selves.json entry: ${id}`)
    else if (typeof entry.path !== 'string' || !isAbsolute(entry.path) || typeof entry.updated_at !== 'string')
      errors.push(`invalid selves.json entry: ${id}`)
  }
  return errors
}

// Reads the self map without writing. state: absent | ok | invalid. An invalid map yields no entries.
export function readSelfMap(env = process.env) {
  const dir = defaultConfigDir(env),
    path = join(dir, SELVES_FILE),
    empty = state => ({ dir, path, state, selves: {}, diagnostics: [] })
  const invalid = message => ({ ...empty('invalid'), diagnostics: [message] })
  let dirInfo, fileInfo
  try {
    dirInfo = lstat(dir)
    fileInfo = dirInfo ? lstat(path) : null
  } catch {
    return invalid('self map is unreadable')
  }
  if (dirInfo && (dirInfo.isSymbolicLink() || !dirInfo.isDirectory())) return invalid('self map directory is a symlink or not a directory; ignoring selves.json')
  if (!fileInfo) return empty('absent')
  if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) return invalid('selves.json is a symlink or not a regular file; ignoring it')
  let value
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return invalid('selves.json is malformed JSON; ignoring it')
  }
  const errors = mapSchemaErrors(value)
  if (errors.length) return invalid(`selves.json is invalid (${errors.join('; ')}); ignoring it`)
  const selves = Object.create(null)
  for (const [id, entry] of Object.entries(value.selves)) selves[id] = { path: entry.path, updated_at: entry.updated_at }
  return { dir, path, state: 'ok', selves, diagnostics: [] }
}

// The registered checkout for a self id on this machine, or null. Never verifies or writes.
export function selfMapEntry(selfId, env = process.env) {
  const map = readSelfMap(env)
  return { entry: Object.hasOwn(map.selves, selfId) ? map.selves[selfId] : null, diagnostics: map.diagnostics }
}

function updateSelfMap(mutate, env) {
  const dir = defaultConfigDir(env),
    dirInfo = lstat(dir)
  if (dirInfo && (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()))
    throw machineError('self map directory is a symlink or not a directory; refusing to write selves.json', 'SELF_MAP_UNSAFE')
  if (!dirInfo) mkdirSync(dir, { recursive: true, mode: 0o700 })
  return withFileLockSync(join(dir, `${SELVES_FILE}.lock`), () => {
    const current = readSelfMap(env)
    if (current.state === 'invalid') throw machineError(`${current.diagnostics.join('; ')}; fix or remove it before registering`, 'SELF_MAP_INVALID')
    const selves = { ...current.selves },
      result = mutate(selves)
    if (result.changed) {
      const ordered = Object.fromEntries(Object.keys(selves).sort().map(id => [id, selves[id]]))
      atomicWrite(current.path, JSON.stringify({ schema_version: 1, selves: ordered }, null, 2) + '\n', { mode: 0o600, exactMode: true })
    }
    return result
  })
}

// Records this machine's checkout of a self (adding a self_id to it first). dryRun reports without writing anything.
export function registerSelf(root, { env = process.env, dryRun = false } = {}) {
  const real = safeRealpath(resolve(root))
  if (!isCanonicalSelf(real)) throw machineError(`not a canonical self root: ${real}`, 'SELF_ROOT_NOT_CANONICAL')
  const path = slash(real),
    existingId = selfIdOf(real)
  if (dryRun) {
    const map = readSelfMap(env),
      previous = existingId && Object.hasOwn(map.selves, existingId) ? map.selves[existingId] : null
    return { self_id: existingId, path, adds_self_id: !existingId, changed: !previous || previous.path !== path, previous, diagnostics: map.diagnostics }
  }
  const self_id = ensureSelfId(real)
  return {
    self_id,
    path,
    adds_self_id: !existingId,
    ...updateSelfMap(selves => {
      const previous = selves[self_id] || null
      if (previous && previous.path === path) return { changed: false, previous }
      selves[self_id] = { path, updated_at: new Date().toISOString() }
      return { changed: true, previous }
    }, env),
    diagnostics: []
  }
}

export function forgetSelf(selfId, { env = process.env, dryRun = false } = {}) {
  if (!isSelfId(selfId)) throw machineError('machine forget requires a self id (hs-self-<32 lowercase hex>)', 'INVALID_ARGUMENT')
  if (dryRun) {
    const map = readSelfMap(env)
    return { self_id: selfId, changed: Object.hasOwn(map.selves, selfId), previous: map.selves[selfId] || null, diagnostics: map.diagnostics }
  }
  return {
    self_id: selfId,
    ...updateSelfMap(selves => {
      const previous = selves[selfId] || null
      if (!previous) return { changed: false, previous }
      delete selves[selfId]
      return { changed: true, previous }
    }, env),
    diagnostics: []
  }
}

// Every registered self with whether its path exists and still carries the registered id.
export function machineStatus(env = process.env) {
  const map = readSelfMap(env),
    diagnostics = [...map.diagnostics],
    selves = Object.entries(map.selves)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([self_id, entry]) => {
        const exists = isCanonicalSelf(entry.path),
          id_matches = exists && selfIdOf(entry.path) === self_id
        if (!exists) diagnostics.push(`${self_id}: registered path is missing or not a canonical self`)
        else if (!id_matches) diagnostics.push(`${self_id}: config.json at the registered path no longer carries this id; ignoring the entry`)
        return { self_id, path: entry.path, exists, id_matches, updated_at: entry.updated_at }
      })
  return { config_dir: slash(map.dir), selves_file: slash(map.path), state: map.state, selves, diagnostics }
}
