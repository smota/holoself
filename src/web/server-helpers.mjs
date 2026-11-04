// Workbench server helpers: package paths, error mapping, request bodies, the CLI bridge and catalog state.
import { spawn } from 'node:child_process'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { normalizeProjectPath, readBindings } from '../bindings.mjs'
import { PACKAGE_ROOT as BASE } from '../shared/package-root.mjs'
import { escapeRegExp, redactRootPaths } from '../shared/redact.mjs'
import { VERSION } from '../version.mjs'
export { PACKAGE_ROOT as BASE } from '../shared/package-root.mjs'
export { escapeRegExp } from '../shared/redact.mjs'
export { VERSION } from '../version.mjs'

export const WEB = join(BASE, 'web'),
  BIN = join(BASE, 'bin', 'holoself.mjs')
export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message)
    this.status = status
    this.code = code
    Object.assign(this, extra)
  }
}
export const CONFLICT_CODES = new Set([
  'STALE_DOCUMENT',
  'STALE_REGISTRY',
  'STALE_PREVIEW',
  'STALE_BINDINGS',
  'PLAN_CHANGED',
  'REGISTRY_CONCURRENT_MODIFICATION'
])
export function scrubMessage(message, roots = []) {
  const known = [...roots, homedir(), tmpdir(), process.env.HOLOSELF_HOME, BASE].filter(Boolean)
  let text = String(message || '')
    .replace(/^\[!!\]\s*/gm, '')
    .trim()
  for (const root of known.map(r => resolve(String(r))).sort((a, b) => b.length - a.length)) {
    for (const variant of new Set([root, root.replaceAll('\\', '/'), root.replaceAll('/', '\\')])) {
      if (variant.length <= 1) continue
      const re = new RegExp(`${escapeRegExp(variant)}(?:[\\\\/](?:[^"');,\\r\\n:]|:(?![\\s$]))*)?`, process.platform === 'win32' ? 'gi' : 'g')
      text = text.replace(re, m => `<local-path>${m.match(/\s+$/)?.[0] || ''}`)
    }
  }
  text = redactRootPaths(text, known)
  text = text.replace(/\\\\[^\\\s]+[\\/](?:[^"');,\r\n:]|:(?![\s$]))*/g, m => `<local-path>${m.match(/\s+$/)?.[0] || ''}`)
  text = text.replace(/(?<![A-Za-z0-9])[A-Za-z]:[\\/](?!\/)(?:[^"');,\r\n:]|:(?![\s$]))*/g, m => `<local-path>${m.match(/\s+$/)?.[0] || ''}`)
  text = text.replace(
    /(^|[\s("'=])\/(?:home|Users|tmp|var|private|etc|opt|usr|root|mnt|srv|run|proc|sys|dev)(?:\/(?:[^"');,\r\n:]|:(?![\s$]))*)?/g,
    (m, lead) => `${lead}<local-path>${m.slice(lead.length).match(/\s+$/)?.[0] || ''}`
  )
  return text
}
export function isInternalError(error) {
  return Boolean(
    error instanceof TypeError ||
      error instanceof ReferenceError ||
      error instanceof RangeError ||
      error instanceof SyntaxError ||
      error instanceof EvalError ||
      error?.errno !== undefined ||
      error?.syscall !== undefined ||
      /^unsafe cleanup rollback\b/i.test(error?.message || '')
  )
}
export function clientCheck(fn, code = 'INVALID_INPUT') {
  try {
    return fn()
  } catch (error) {
    if (error instanceof HttpError || isInternalError(error)) throw error
    if (CONFLICT_CODES.has(error?.code)) throw new HttpError(409, error.code, error.message, { current_hash: error.current_hash })
    throw new HttpError(400, error?.code || code, error?.message || 'invalid input')
  }
}
export async function clientCheckAsync(fn, code = 'INVALID_INPUT') {
  try {
    return await fn()
  } catch (error) {
    if (error instanceof HttpError || isInternalError(error)) throw error
    if (CONFLICT_CODES.has(error?.code)) throw new HttpError(409, error.code, error.message, { current_hash: error.current_hash })
    throw new HttpError(400, error?.code || code, error?.message || 'invalid input')
  }
}
export function cliFailure(stderr, code) {
  for (const line of String(stderr || '')
    .split(/\r?\n/)
    .reverse()) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line),
        he = parsed?.holoself_error
      if (he && typeof he === 'object') {
        if (he.kind === 'refusal') {
          if (CONFLICT_CODES.has(he.code)) return new HttpError(409, he.code, he.message)
          return new HttpError(400, he.code || 'CLI_REFUSAL', he.message)
        }
        return new Error(he.message || `command failed (${code})`)
      }
    } catch {}
  }
  return new Error(stderr || `command failed (${code})`)
}
// The repair dry run prints pretty JSON objects (binding_migration, activation_plan) followed by result lines.
export function repairPlan(stdout) {
  const plan = {}
  for (const match of stdout.matchAll(/^\{[\s\S]*?^\}$/gm)) {
    try {
      Object.assign(plan, JSON.parse(match[0]))
    } catch {}
  }
  return plan
}
export const conversationDir = project => {
  if (typeof project !== 'string' || !project.trim()) throw new HttpError(400, 'INVALID_INPUT', 'project path required')
  return join(resolve(project), '.holoself', 'conversations')
}
export function conversationEvents(project, id) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(400, 'INVALID_INPUT', 'invalid conversation id')
  const file = join(conversationDir(project), `${id}.ndjson`)
  if (!existsSync(file)) throw new HttpError(400, 'NOT_FOUND', 'conversation not found')
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .slice(-40)
    .map(line => JSON.parse(line))
}
export const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml'
}
export const send = (res, status, data) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}
export function body(req, limit = 2 * 1024 * 1024) {
  return new Promise((ok, no) => {
    let value = '',
      bytes = 0,
      overflow = false
    req.on('data', x => {
      bytes += Buffer.byteLength(x)
      if (overflow) {
        if (bytes > limit * 8) req.destroy()
        return
      }
      if (bytes > limit) {
        overflow = true
        value = ''
        req.resume()
        return
      }
      value += x
    })
    req.on('end', () => {
      if (overflow) return no(new HttpError(413, 'PAYLOAD_TOO_LARGE', 'request too large'))
      try {
        const parsed = value ? JSON.parse(value) : {}
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return no(new HttpError(400, 'INVALID_JSON', 'invalid JSON'))
        ok(parsed)
      } catch {
        no(new HttpError(400, 'INVALID_JSON', 'invalid JSON'))
      }
    })
  })
}
export function cli(args, { stdin, allowFailure = false, timeoutMs = 60000, maxStdout = 2 * 1024 * 1024, maxStderr = 128 * 1024, env: extraEnv } = {}) {
  return new Promise((ok, no) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      shell: false,
      windowsHide: true,
      env: { ...process.env, HOLOSELF_ERROR_FORMAT: 'json', ...(extraEnv || {}) },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let out = '',
      err = '',
      done = false
    const finish = (error, value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      error ? no(error) : ok(value)
    }
    const overflow = kind => {
      child.kill()
      finish(new Error(`Holoself ${kind} limit exceeded`))
    }
    child.stdout.on('data', x => {
      if (Buffer.byteLength(out) + x.length > maxStdout) return overflow('output')
      out += x
    })
    child.stderr.on('data', x => {
      if (Buffer.byteLength(err) + x.length > maxStderr) return overflow('error output')
      err += x
    })
    child.on('error', finish)
    child.on('close', code =>
      code === 0 || allowFailure ? finish(null, { stdout: out.trim(), stderr: err.trim(), code }) : finish(cliFailure(err.trim(), code))
    )
    child.stdin.on('error', () => {})
    child.stdin.end(stdin || '')
    const timer = setTimeout(() => {
      child.kill()
      finish(new Error('Holoself command timed out'))
    }, timeoutMs)
  })
}
export function readCatalog(root) {
  try {
    return JSON.parse(readFileSync(join(root, 'ui', 'catalog.json'), 'utf8'))
  } catch {
    return { schemaVersion: 1, spaces: [] }
  }
}
export function writeCatalog(root, value) {
  mkdirSync(join(root, 'ui'), { recursive: true })
  writeFileSync(join(root, 'ui', 'catalog.json'), JSON.stringify(value, null, 2) + '\n')
}
export function reconcileCatalog(root) {
  const previous = readCatalog(root),
    known = new Map(previous.spaces.map(item => [normalizeProjectPath(item.path), item])),
    bindings = readBindings(root)
  const spaces = Object.entries(bindings.bindings).map(([project, binding]) => ({
    ...(known.get(project) || { id: randomUUID(), addedAt: new Date().toISOString() }),
    path: project,
    name: basename(project),
    lens: binding.default_lens,
    secondary_lenses: binding.secondary_lenses,
    discoveredFrom: 'lenses/bindings.json'
  }))
  const catalog = { schemaVersion: 1, spaces }
  if (JSON.stringify(previous) !== JSON.stringify(catalog)) writeCatalog(root, catalog)
  return { ...catalog, discovered: spaces.map(item => item.path) }
}
export function correctionsFor(statusValue) {
  const actions = []
  for (const error of statusValue.errors || []) {
    if (/self path missing/i.test(error)) actions.push({ id: 'relink', label: 'Relink canonical root', safe: false, detail: error })
    else if (/legacy filesystem junction mount detected/i.test(error))
      actions.push({ id: 'setup', label: 'Migrate to metadata link', safe: false, detail: error })
    else if (/bootstrap missing|no activated adapters|managed block drift|legacy-shim|no public skill installation|not installed/i.test(error))
      actions.push({ id: 'repair', label: 'Repair activation', safe: false, detail: error })
  }
  if (statusValue.state === 'configured') actions.push({ id: 'activate', label: 'Activate space', safe: false, detail: 'Install bounded startup pointers' })
  if (statusValue.state === 'legacy-mount' && !actions.some(a => a.id === 'setup'))
    actions.push({ id: 'setup', label: 'Migrate to metadata link', safe: false, detail: 'Migrate legacy filesystem mount to a safe metadata link' })
  if (statusValue.index_fresh === false || statusValue.index?.fresh === false)
    actions.push({ id: 'index', label: 'Rebuild index', safe: true, detail: 'Refresh disposable search index' })
  return [...new Map(actions.map(action => [action.id, action])).values()]
}
export function filesystemRoots(root) {
  if (process.platform === 'win32') {
    const drives = []
    for (let code = 65; code <= 90; code++) {
      const path = `${String.fromCharCode(code)}:/`
      if (existsSync(path)) drives.push({ name: path, path })
    }
    return drives
  }
  return [{ name: '/', path: '/' }]
}
export function folderListing(value) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new HttpError(400, 'INVALID_PATH', 'absolute folder path required')
  const path = resolve(value)
  if (!existsSync(path) || !lstatSync(path).isDirectory()) throw new HttpError(400, 'INVALID_PATH', 'folder not found')
  const all = readdirSync(path, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
      .map(entry => ({ name: entry.name, path: join(path, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    folders = all.slice(0, 250)
  return { path, name: basename(path) || path, parent: dirname(path) === path ? null : dirname(path), folders, truncated: all.length > folders.length }
}
// Constant-time comparison of the per-process session token; length mismatch is rejected before comparing.
export function tokenMatches(value, token) {
  if (typeof value !== 'string') return false
  const given = Buffer.from(value),
    expected = Buffer.from(token)
  return given.length === expected.length && timingSafeEqual(given, expected)
}
export async function status(space) {
  try {
    return JSON.parse((await cli(['link', 'status', '--project', space.path], { allowFailure: true })).stdout)
  } catch (e) {
    return { project: space.path, state: 'broken', errors: [e.message] }
  }
}
