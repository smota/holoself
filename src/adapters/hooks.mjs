// Session-start host hooks: install, inspect and remove the one Holoself-owned SessionStart entry in a host's
// project settings file. Foreign keys and hooks are kept; the file is re-serialised (2-space JSON) only when the
// Holoself entry changes, so a canonically formatted file round-trips byte-for-byte through install and removal.
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { loadVerificationMatrix } from '../mcp-verification.mjs'
import { fileModeOr } from '../shared/fs.mjs'
import { safeProjectFile } from './registry.mjs'

export const HOOK_ID = 'holoself-session-start'
export const HOOK_MARKER = `--hook ${HOOK_ID}`
export const HOOK_POLICIES = ['auto', 'on', 'off']

// Hosts where Holoself installs the hook. `file` is per-machine settings (not committed): the command depends on a
// local holoself install that collaborators may not have.
export const HOOK_HOSTS = {
  claude: {
    file: '.claude/settings.local.json',
    event: 'SessionStart',
    matcher: 'startup|resume|clear|compact',
    // No shell syntax: hook mode reads CLAUDE_PROJECT_DIR from the environment, so the command runs the same under
    // a POSIX shell and on Windows.
    command: `holoself context --session-start --budget small --format packet ${HOOK_MARKER}`,
    timeout: 30
  }
}
// Hosts whose own session-start hook exists but that Holoself does not install into yet (see runtime-adapters guide).
export const HOOK_NOT_INSTALLED = {
  codex:
    'Codex 0.166.0 runs SessionStart hooks from .codex/hooks.json only after the user trusts each hook (a trusted_hash in the ' +
    "user's ~/.codex/config.toml), which Holoself must not write; not installed or verified.",
  agy:
    'AGY 1.5.0 runs SessionStart hooks from <workspace>/.agents/hooks.json with a JSON injectSteps output contract; ' +
    'not installed or verified.'
}

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
    : { support: 'configured', tested_version: null, last_verified: null, reason: 'No recorded native session-start verification.' }
}

export function desiredHookGroup(id) {
  const host = HOOK_HOSTS[id]
  return { matcher: host.matcher, hooks: [{ type: 'command', command: host.command, timeout: host.timeout }] }
}

const ownedHook = hook => typeof hook?.command === 'string' && hook.command.includes(HOOK_MARKER)
const groupHooks = group => (Array.isArray(group?.hooks) ? group.hooks : [])

function readHookSettings(path) {
  if (!existsSync(path)) return { exists: false, text: '', config: {} }
  const info = lstatSync(path)
  if (info.isSymbolicLink() || !info.isFile()) return { exists: true, unsafe: true }
  const text = readFileSync(path, 'utf8')
  if (!text.trim()) return { exists: true, text, config: {} }
  let config
  try {
    config = JSON.parse(text)
  } catch (error) {
    return { exists: true, text, invalid: `invalid JSON: ${error.message}` }
  }
  if (!config || Array.isArray(config) || typeof config !== 'object') return { exists: true, text, invalid: 'root must be an object' }
  return { exists: true, text, config }
}

// State of the host hook file: installed | missing | drifted | unsafe | invalid. `mixed` marks a group that holds
// the Holoself hook together with foreign hooks, which Holoself refuses to edit.
export function inspectHook(project, id) {
  const host = HOOK_HOSTS[id],
    path = safeProjectFile(project, host.file, 'hook settings'),
    read = readHookSettings(path)
  if (read.unsafe) return { state: 'unsafe', path, detail: 'not a regular file' }
  if (read.invalid) return { state: 'invalid', path, detail: read.invalid }
  const hooks = read.config.hooks
  if (hooks !== undefined && (!hooks || Array.isArray(hooks) || typeof hooks !== 'object'))
    return { state: 'invalid', path, detail: 'hooks must be an object' }
  const groups = hooks?.[host.event]
  if (groups !== undefined && !Array.isArray(groups)) return { state: 'invalid', path, detail: `hooks.${host.event} must be an array` }
  const owned = (groups || []).filter(group => groupHooks(group).some(ownedHook)),
    mixed = owned.some(group => !groupHooks(group).every(ownedHook))
  if (!owned.length) return { state: 'missing', path, exists: read.exists }
  const exact = owned.length === 1 && JSON.stringify(owned[0]) === JSON.stringify(desiredHookGroup(id))
  return { state: exact ? 'installed' : 'drifted', path, exists: read.exists, mixed, owned: owned.length }
}

// Next file content for `install` (true) or removal (false); null content means delete the file.
// `createdContainers` lists the containers ('hooks', the event array) that Holoself added on install; removal drops
// them only when Holoself created them and they are empty again, so pre-existing empty containers are kept.
// Existing files keep their permission bits; files Holoself creates are 0600 (per-machine settings can hold secrets).
export function hookChange(project, id, install, { createdFile = false, createdContainers = null } = {}) {
  const host = HOOK_HOSTS[id],
    inspected = inspectHook(project, id)
  if (['unsafe', 'invalid'].includes(inspected.state)) throw new Error(`${host.file}: ${inspected.state} hook settings (${inspected.detail})`)
  if (inspected.mixed) throw new Error(`${host.file}: the Holoself ${host.event} hook shares a group with other hooks; move it out by hand`)
  const read = readHookSettings(inspected.path),
    before = read.text,
    hooks = read.config.hooks,
    groups = hooks?.[host.event] || [],
    index = groups.findIndex(group => groupHooks(group).some(ownedHook)),
    kept = groups.filter(group => !groupHooks(group).some(ownedHook)),
    mode = fileModeOr(inspected.path, 0o600),
    base = { path: inspected.path, file: host.file, before, existed: read.exists, mode }
  const created =
    createdContainers ??
    // Without a runtime record, containers left empty by removing the Holoself-owned entry are treated as Holoself's.
    (install ? [...(hooks === undefined ? ['hooks'] : []), ...(hooks?.[host.event] === undefined ? [host.event] : [])] : ['hooks', host.event])
  if (install && inspected.state === 'installed') return { ...base, after: before, action: 'unchanged', createdContainers: created }
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
