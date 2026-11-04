// Session-start host hooks: install, inspect and remove the one Holoself-owned SessionStart entry in a host's
// project settings file. Foreign keys and hooks are kept; the file is re-serialised (2-space JSON) only when the
// Holoself entry changes, so a canonically formatted file round-trips byte-for-byte through install and removal.
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { loadVerificationMatrix } from '../mcp-verification.mjs'
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
    command: `holoself context --project "$CLAUDE_PROJECT_DIR" --session-start --budget small --format packet ${HOOK_MARKER}`,
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

export function hookSupport(id, matrix = loadVerificationMatrix()) {
  if (!HOOK_HOSTS[id]) return { support: 'unsupported', tested_version: null, last_verified: null, reason: HOOK_NOT_INSTALLED[id] || null }
  const record = (matrix?.platforms || []).find(item => item?.platform === id)?.session_start_hook
  const verified = record?.result === 'pass' && record.marker_returned === true && record.hook_ran === true
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
export function hookChange(project, id, install, { createdFile = false } = {}) {
  const host = HOOK_HOSTS[id],
    inspected = inspectHook(project, id)
  if (['unsafe', 'invalid'].includes(inspected.state)) throw new Error(`${host.file}: ${inspected.state} hook settings (${inspected.detail})`)
  if (inspected.mixed) throw new Error(`${host.file}: the Holoself ${host.event} hook shares a group with other hooks; move it out by hand`)
  const read = readHookSettings(inspected.path),
    before = read.text,
    groups = read.config.hooks?.[host.event] || [],
    index = groups.findIndex(group => groupHooks(group).some(ownedHook)),
    kept = groups.filter(group => !groupHooks(group).some(ownedHook))
  if (install && inspected.state === 'installed') return { path: inspected.path, file: host.file, before, after: before, action: 'unchanged', existed: read.exists }
  if (!install && inspected.state === 'missing') return { path: inspected.path, file: host.file, before, after: before, action: 'unchanged', existed: read.exists }
  const nextGroups = install ? [...kept.slice(0, index < 0 ? kept.length : index), desiredHookGroup(id), ...kept.slice(index < 0 ? kept.length : index)] : kept
  const next = { ...read.config, hooks: { ...(read.config.hooks || {}), [host.event]: nextGroups } }
  if (!nextGroups.length) delete next.hooks[host.event]
  if (!Object.keys(next.hooks).length) delete next.hooks
  const remove = !install && createdFile && !Object.keys(next).length,
    after = remove ? null : JSON.stringify(next, null, 2) + '\n'
  return {
    path: inspected.path,
    file: host.file,
    before,
    after,
    existed: read.exists,
    action: install ? (read.exists ? 'update' : 'create') : remove ? 'delete' : 'remove'
  }
}
