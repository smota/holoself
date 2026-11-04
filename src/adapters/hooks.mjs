// Session-start host hooks: install, inspect and remove the one Holoself-owned SessionStart entry in a host's
// project settings file. Foreign keys and hooks are kept; the file is re-serialised (2-space JSON) only when the
// Holoself entry changes, so a canonically formatted file round-trips byte-for-byte through install and removal.
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { loadVerificationMatrix } from '../mcp-verification.mjs'
import { fileModeOr, invalidJsonDetail } from '../shared/fs.mjs'
import { safeProjectFile } from './registry.mjs'

export const HOOK_ID = 'holoself-session-start'
export const HOOK_MARKER = `--hook ${HOOK_ID}`
export const HOOK_POLICIES = ['auto', 'on', 'off']
export const CODEX_TRUST_STEP =
  'Run codex in this project and approve the startup "Hooks need review" prompt (or run /hooks in an interactive codex session) so Codex records trusted_hash in ~/.codex/config.toml.'

// Hosts where Holoself can install a SessionStart hook. Default `auto` installs only where `platform-verification.json`
// has a passing `session_start_hook` record; `--hooks` forces installation for unverified hosts.
export const HOOK_HOSTS = {
  claude: {
    file: '.claude/settings.local.json',
    event: 'SessionStart',
    schema: 'matcher-groups',
    matcher: 'startup|resume|clear|compact',
    // No shell syntax: hook mode reads CLAUDE_PROJECT_DIR from the environment, so the command runs the same under
    // a POSIX shell and on Windows.
    command: `holoself context --session-start --budget small --format packet ${HOOK_MARKER}`,
    timeout: 30
  },
  codex: {
    file: '.codex/hooks.json',
    event: 'SessionStart',
    schema: 'matcher-groups',
    matcher: 'startup|resume|clear|compact',
    // Codex runs hooks with cwd set to the project root and accepts plain-text SessionStart stdout as additionalContext.
    command: `holoself context --session-start --budget small --format packet ${HOOK_MARKER}`,
    timeout: 30,
    trustStep: CODEX_TRUST_STEP
  },
  agy: {
    file: '.agents/hooks.json',
    event: 'SessionStart',
    schema: 'agy-named',
    // AGY runs workspace hooks from <workspace>/.agents/hooks.json with cwd set to <workspace>/.agents and expects a
    // SessionStartHookResult JSON envelope on stdout.
    command: `holoself context --session-start --budget small --format packet ${HOOK_MARKER} --hook-format agy-json`,
    timeout: 30
  }
}
// Hosts whose own session-start hook exists but that Holoself does not install into.
export const HOOK_NOT_INSTALLED = {}

// Windows is reported `unverified` (and not installed by default) unless the record says Windows was verified.
// Test-only: HOLOSELF_TEST_PLATFORM overrides the platform, honoured only under node --test (NODE_TEST_CONTEXT), so
// golden fixtures are platform-independent. Product runs always use process.platform.
function hookPlatform() {
  return (process.env.NODE_TEST_CONTEXT && process.env.HOLOSELF_TEST_PLATFORM) || process.platform
}
export function hookSupport(id, matrix = loadVerificationMatrix(), platform = hookPlatform()) {
  if (!HOOK_HOSTS[id]) return { support: 'unsupported', tested_version: null, last_verified: null, reason: HOOK_NOT_INSTALLED[id] || null }
  const record = (matrix?.platforms || []).find(item => item?.platform === id)?.session_start_hook
  const verified = record?.result === 'pass' && record.marker_returned === true && record.hook_ran === true
  if (verified && platform === 'win32' && record.windows !== 'verified')
    return { support: 'unverified', tested_version: null, last_verified: null, reason: 'Session-start hook not verified on Windows.' }
  return verified
    ? { support: 'verified', tested_version: record.host_version, last_verified: record.verified_at, reason: null }
    : { support: 'unverified', tested_version: null, last_verified: null, reason: record?.evidence || 'No recorded native session-start verification.' }
}

export function desiredHookGroup(id) {
  const host = HOOK_HOSTS[id]
  if (host.schema === 'agy-named') return { type: 'command', command: host.command, timeout: host.timeout }
  return { matcher: host.matcher, hooks: [{ type: 'command', command: host.command, timeout: host.timeout }] }
}

const ownedHook = hook => typeof hook?.command === 'string' && hook.command.includes(HOOK_MARKER)
const groupHooks = group => (Array.isArray(group?.hooks) ? group.hooks : [])
const validTrustHash = value => typeof value === 'string' && /^sha256:[0-9a-f]{16,}$/i.test(value.trim())

function unquoteTomlKey(raw) {
  const trimmed = raw.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1).replace(/\\(["\\])/g, '$1')
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1)
  return trimmed
}

function codexConfigPath(env = process.env) {
  if (process.env.NODE_TEST_CONTEXT && env.HOLOSELF_TEST_CODEX_CONFIG !== undefined) return env.HOLOSELF_TEST_CODEX_CONFIG || null
  const codexHome = typeof env.CODEX_HOME === 'string' ? env.CODEX_HOME.trim() : ''
  if (codexHome && isAbsolute(codexHome)) return join(codexHome, 'config.toml')
  const home = env.HOME || env.USERPROFILE || homedir()
  return home ? join(home, '.codex', 'config.toml') : null
}

// Read-only check of ~/.codex/config.toml for `hooks.state."<file>:session_start:<group>:<hook>".trusted_hash`.
// Holoself never writes user Codex configuration.
export function hasCodexTrustHash(tomlText, stateKeys) {
  let section = '',
    currentStateKey = null
  for (const rawLine of String(tomlText || '').split(/\r?\n/)) {
    const line = rawLine.replace(/^\s+|\s+$/g, '')
    if (!line || line.startsWith('#')) continue
    const tableMatch = line.match(/^\[([^\]]+)\]\s*(?:#.*)?$/)
    if (tableMatch) {
      section = tableMatch[1].trim()
      const stateTable = section.match(/^hooks\.state\.("([^"\\]|\\.)*"|'[^']*')$/)
      currentStateKey = stateTable ? unquoteTomlKey(stateTable[1]) : null
      continue
    }
    if (currentStateKey && stateKeys.has(currentStateKey)) {
      const kv = line.match(/^trusted_hash\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/)
      if (kv && validTrustHash(kv[1] ?? kv[2])) return true
    }
    const prefix = section === 'hooks.state' ? /^("([^"\\]|\\.)*"|'[^']*')/ : !section ? /^hooks\.state\.("([^"\\]|\\.)*"|'[^']*')/ : null
    if (prefix) {
      const m = line.match(prefix)
      if (m && stateKeys.has(unquoteTomlKey(m[1]))) {
        const rest = line.slice(m[0].length)
        const dotted = rest.match(/^\s*\.trusted_hash\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/),
          inline = rest.match(/^\s*=\s*\{[^}]*\btrusted_hash\s*=\s*(?:"([^"]*)"|'([^']*)')[^}]*\}\s*(?:#.*)?$/)
        const hash = dotted ? (dotted[1] ?? dotted[2]) : inline ? (inline[1] ?? inline[2]) : null
        if (validTrustHash(hash)) return true
      }
    }
  }
  return false
}

export function isCodexHookTrusted(hookFilePath, groupIndex = 0, hookIndex = 0, env = process.env) {
  const configPath = codexConfigPath(env)
  if (!configPath || !existsSync(configPath)) return false
  try {
    const info = lstatSync(configPath)
    if (info.isSymbolicLink() || !info.isFile()) return false
    const files = new Set([hookFilePath, hookFilePath.replaceAll('\\', '/'), hookFilePath.replaceAll('/', '\\')])
    try {
      const real = realpathSync(hookFilePath)
      files.add(real)
      files.add(real.replaceAll('\\', '/'))
      files.add(real.replaceAll('/', '\\'))
    } catch {}
    const stateKeys = new Set([...files].map(file => `${file}:session_start:${groupIndex}:${hookIndex}`))
    return hasCodexTrustHash(readFileSync(configPath, 'utf8'), stateKeys)
  } catch {
    return false
  }
}

// Reads a host settings file: { exists, text, config } or { unsafe } / { invalid } (never throws on content).
export function readHookSettings(path) {
  if (!existsSync(path)) return { exists: false, text: '', config: {} }
  const info = lstatSync(path)
  if (info.isSymbolicLink() || !info.isFile()) return { exists: true, unsafe: true }
  return parseHookSettings(readFileSync(path, 'utf8'))
}
export function parseHookSettings(text, exists = true) {
  if (!text.trim()) return { exists, text, config: {} }
  let config
  try {
    config = JSON.parse(text)
  } catch (error) {
    return { exists, text, invalid: invalidJsonDetail(text, error) }
  }
  if (!config || Array.isArray(config) || typeof config !== 'object') return { exists, text, invalid: 'root must be an object' }
  return { exists, text, config }
}

function inspectAgyHook(host, path, read) {
  const group = read.config[HOOK_ID]
  if (group !== undefined && (!group || Array.isArray(group) || typeof group !== 'object'))
    return { state: 'invalid', path, detail: `${HOOK_ID} must be an object` }
  const handlers = group?.[host.event]
  if (handlers !== undefined && !Array.isArray(handlers))
    return { state: 'invalid', path, detail: `${HOOK_ID}.${host.event} must be an array` }
  if ((handlers || []).some(h => !h || Array.isArray(h) || typeof h !== 'object'))
    return { state: 'invalid', path, detail: `${HOOK_ID}.${host.event} entries must be objects` }
  const foreignOwned = Object.entries(read.config).some(
    ([name, entry]) =>
      name !== HOOK_ID &&
      entry &&
      typeof entry === 'object' &&
      !Array.isArray(entry) &&
      Object.values(entry).some(list => Array.isArray(list) && list.some(ownedHook))
  )
  const owned = (handlers || []).filter(ownedHook),
    otherEvents = group ? Object.keys(group).some(key => key !== host.event) : false,
    mixed = (handlers || []).some(h => !ownedHook(h)) || otherEvents || foreignOwned
  if (!owned.length && !mixed) return { state: 'missing', path, exists: read.exists }
  const exact = !mixed && owned.length === 1 && JSON.stringify(owned[0]) === JSON.stringify(desiredHookGroup('agy'))
  return { state: exact ? 'installed' : 'drifted', path, exists: read.exists, mixed, owned: owned.length + (foreignOwned ? 1 : 0) }
}

// State of the host hook file: installed | installed-trust-unverified | installed-untrusted | missing | drifted | unsafe | invalid.
// `mixed` marks a group that holds the Holoself hook together with foreign hooks, which Holoself refuses to edit.
export function inspectHook(project, id, env = process.env) {
  const host = HOOK_HOSTS[id],
    path = safeProjectFile(project, host.file, 'hook settings'),
    read = readHookSettings(path)
  if (read.unsafe) return { state: 'unsafe', path, detail: 'not a regular file' }
  if (read.invalid) return { state: 'invalid', path, detail: read.invalid }
  if (host.schema === 'agy-named') return inspectAgyHook(host, path, read)
  const hooks = read.config.hooks
  if (hooks !== undefined && (!hooks || Array.isArray(hooks) || typeof hooks !== 'object'))
    return { state: 'invalid', path, detail: 'hooks must be an object' }
  const groups = hooks?.[host.event]
  if (groups !== undefined && !Array.isArray(groups)) return { state: 'invalid', path, detail: `hooks.${host.event} must be an array` }
  const owned = (groups || []).filter(group => groupHooks(group).some(ownedHook)),
    mixed = owned.some(group => !groupHooks(group).every(ownedHook))
  if (!owned.length) return { state: 'missing', path, exists: read.exists }
  const exact = owned.length === 1 && JSON.stringify(owned[0]) === JSON.stringify(desiredHookGroup(id))
  if (!exact) return { state: 'drifted', path, exists: read.exists, mixed, owned: owned.length }
  if (id === 'codex') {
    const groupIndex = (groups || []).findIndex(group => groupHooks(group).some(ownedHook)),
      trusted = isCodexHookTrusted(path, groupIndex, 0, env)
    return {
      // Codex does not publish its trusted_hash digest input; presence of a hash proves only that some version of this
      // hook slot was reviewed, not that it matches the current .codex/hooks.json bytes.
      state: trusted ? 'installed-trust-unverified' : 'installed-untrusted',
      path,
      exists: read.exists,
      mixed,
      owned: owned.length,
      ...(!trusted && host.trustStep ? { trust_step: host.trustStep } : {})
    }
  }
  return { state: 'installed', path, exists: read.exists, mixed, owned: owned.length }
}

function missingHookDirs(project, rel) {
  const parts = rel.split('/').slice(0, -1),
    out = []
  for (let index = 1; index <= parts.length; index++) {
    const dir = parts.slice(0, index).join('/')
    if (!existsSync(join(project, dir))) out.push(dir)
  }
  return out
}

// Next file content for `install` (true) or removal (false); null content means delete the file.
// `createdContainers` lists the containers ('hooks', the event array, or AGY's named hook container) that Holoself
// added on install; removal drops them only when Holoself created them and they are empty again, so pre-existing empty
// containers are kept. Existing files keep their permission bits; files Holoself creates are 0600.
export function hookChange(project, id, install, { createdFile = false, createdContainers = null, createdDirs = null } = {}) {
  const host = HOOK_HOSTS[id],
    inspected = inspectHook(project, id)
  if (['unsafe', 'invalid'].includes(inspected.state)) throw new Error(`${host.file}: ${inspected.state} hook settings (${inspected.detail})`)
  if (inspected.mixed) throw new Error(`${host.file}: the Holoself ${host.event} hook shares a group with other hooks; move it out by hand`)
  const read = readHookSettings(inspected.path),
    before = read.text,
    mode = fileModeOr(inspected.path, 0o600),
    dirs = createdDirs ?? (install ? missingHookDirs(project, host.file) : []),
    base = {
      project,
      path: inspected.path,
      file: host.file,
      before,
      existed: read.exists,
      mode,
      createdDirs: dirs,
      ...(host.trustStep ? { trust_step: host.trustStep } : {})
    }
  if (host.schema === 'agy-named') {
    const group = read.config[HOOK_ID],
      handlers = group?.[host.event] || [],
      created =
        createdContainers ??
        (install ? [...(group === undefined ? [HOOK_ID] : []), ...(group?.[host.event] === undefined ? [host.event] : [])] : [HOOK_ID, host.event])
    if (install && inspected.state === 'installed') return { ...base, after: before, action: 'unchanged', createdContainers: created }
    if (!install && inspected.state === 'missing') return { ...base, after: before, action: 'unchanged', createdContainers: created }
    const nextHandlers = install ? [desiredHookGroup(id)] : handlers.filter(h => !ownedHook(h)),
      next = { ...read.config, [HOOK_ID]: { ...(group || {}), [host.event]: nextHandlers } }
    if (!install && !nextHandlers.length && created.includes(host.event)) delete next[HOOK_ID][host.event]
    if (!install && !Object.keys(next[HOOK_ID]).length && created.includes(HOOK_ID)) delete next[HOOK_ID]
    const remove = !install && createdFile && !Object.keys(next).length,
      after = remove ? null : JSON.stringify(next, null, 2) + '\n'
    return {
      ...base,
      after,
      createdContainers: created,
      action: install ? (read.exists ? 'update' : 'create') : remove ? 'delete' : 'remove'
    }
  }
  const hooks = read.config.hooks,
    groups = hooks?.[host.event] || [],
    index = groups.findIndex(group => groupHooks(group).some(ownedHook)),
    kept = groups.filter(group => !groupHooks(group).some(ownedHook)),
    created =
      createdContainers ??
      // Without a runtime record, containers left empty by removing the Holoself-owned entry are treated as Holoself's.
      (install ? [...(hooks === undefined ? ['hooks'] : []), ...(hooks?.[host.event] === undefined ? [host.event] : [])] : ['hooks', host.event])
  if (install && ['installed', 'installed-trust-unverified', 'installed-untrusted'].includes(inspected.state))
    return { ...base, after: before, action: 'unchanged', createdContainers: created }
  if (!install && inspected.state === 'missing') return { ...base, after: before, action: 'unchanged', createdContainers: created }
  const at = index < 0 ? kept.length : index,
    nextGroups = install ? [...kept.slice(0, at), desiredHookGroup(id), ...kept.slice(at)] : kept
  const next = { ...read.config, hooks: { ...(hooks || {}), [host.event]: nextGroups } }
  if (!install && !nextGroups.length && created.includes(host.event)) delete next.hooks[host.event]
  if (!install && !Object.keys(next.hooks).length && created.includes('hooks')) delete next.hooks
  const remove = !install && createdFile && !Object.keys(next).length,
    after = remove ? null : JSON.stringify(next, null, 2) + '\n'
  return {
    ...base,
    after,
    createdContainers: created,
    action: install ? (read.exists ? 'update' : 'create') : remove ? 'delete' : 'remove'
  }
}
