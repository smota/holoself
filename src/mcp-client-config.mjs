// Host configuration for unlinked MCP clients (`holoself mcp configure --client <id> --platform <p>`). Printing the
// snippet is the default and writes nothing. `--apply` edits only the documented user-level configuration file of a
// platform whose MCP support is `verified` in docs/reference/platform-verification.json, with a preview hash, explicit
// consent, collision refusal, a mode-safe backup, symlink and hard-link refusal, mode preservation, an atomic write and
// rollback. See docs/decisions/unlinked-client-identity.md, section 5.
import { closeSync, existsSync, fchmodSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmdirSync, rmSync, statSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { attestClient } from './clients/attestation.mjs'
import { CLIENT_ID_RE, clientError, findClient, readClientRegistry } from './clients/registry.mjs'
import { loadVerificationMatrix, mcpPlatformSupport } from './mcp-verification.mjs'
import { assertNoLinkBelow } from './path-guard.mjs'
import { atomicWrite, hash, invalidJsonDetail, slash } from './shared/fs.mjs'

export const CLIENT_CONFIG_PLATFORMS = ['claude-desktop', 'generic']
// Platforms whose host file Holoself knows how to edit; `generic` is print-only by design.
export const CLIENT_APPLY_PLATFORMS = ['claude-desktop']
const SERVER_KEY = 'holoself'
const BIN_PATH = fileURLToPath(new URL('../bin/holoself.mjs', import.meta.url))

// Absolute command for the host: the `holoself` executable found on PATH, else node plus this package's bin script.
// GUI apps on macOS and Windows do not inherit the shell PATH, so the command is never a bare name.
export function holoselfCommand({ env = process.env, os = process.platform } = {}) {
  const names = os === 'win32' ? ['holoself.cmd', 'holoself.exe'] : ['holoself']
  for (const dir of String(env.PATH || env.Path || '').split(os === 'win32' ? ';' : delimiter)) {
    if (!dir || !isAbsolute(dir)) continue
    for (const name of names) {
      const candidate = join(dir, name)
      try {
        if (statSync(candidate).isFile()) return { command: candidate, prefix: [], source: 'path' }
      } catch {}
    }
  }
  return { command: process.execPath, prefix: [BIN_PATH], source: 'package-bin' }
}
export function clientServerEntry(clientId, self, { command = holoselfCommand() } = {}) {
  return { command: command.command, args: [...command.prefix, 'mcp', '--client', clientId, '--root', self] }
}
// The documented user-level Claude Desktop configuration file and the boundary below which no link is accepted.
export function clientHostConfigPath(platform, { os = process.platform, env = process.env, home = homedir() } = {}) {
  if (platform !== 'claude-desktop') throw clientError(`platform ${platform} has no host configuration file Holoself edits`, 'MCP_PLATFORM_PRINT_ONLY')
  if (os === 'darwin') {
    if (!home || !isAbsolute(home)) throw clientError('home directory is unknown', 'MCP_HOST_PATH_UNKNOWN')
    return { path: join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'), boundary: home }
  }
  if (os === 'win32') {
    const appData = env.APPDATA
    if (!appData || !isAbsolute(appData)) throw clientError('%APPDATA% is not set to an absolute path', 'MCP_HOST_PATH_UNKNOWN')
    return { path: join(appData, 'Claude', 'claude_desktop_config.json'), boundary: appData }
  }
  throw clientError(`Claude Desktop has no documented configuration path on ${os}; use the printed snippet`, 'MCP_HOST_PATH_UNKNOWN')
}
function assertPlatform(platform) {
  if (!CLIENT_CONFIG_PLATFORMS.includes(platform))
    throw clientError(`unsupported client platform: ${platform}; expected ${CLIENT_CONFIG_PLATFORMS.join(' or ')}`, 'INVALID_ARGUMENT')
}
// The registry entry to configure. Installing requires an active client with a valid lens; removal accepts any entry,
// or a bare client_id whose entry was already removed.
function configuredClient(self, ref, { remove = false } = {}) {
  const entry = findClient(readClientRegistry(self).clients, ref)
  if (remove) {
    if (entry) return entry
    if (typeof ref === 'string' && CLIENT_ID_RE.test(ref)) return { client_id: ref, name: null, lens: null, status: 'removed', proposals: null }
    throw clientError(`unknown client: ${ref}`, 'CLIENT_UNKNOWN')
  }
  if (!entry) throw clientError(`unknown client: ${ref}`, 'CLIENT_UNKNOWN')
  return attestClient(self, entry.client_id)
}
function publicClient(entry) {
  return { client_id: entry.client_id, name: entry.name, lens: entry.lens, status: entry.status, proposals: entry.proposals }
}

// Print mode: the exact snippet for the host, nothing written.
export function clientConfigSnippet(self, ref, { platform, command = holoselfCommand() } = {}) {
  assertPlatform(platform)
  const entry = configuredClient(self, ref),
    server = clientServerEntry(entry.client_id, self, { command })
  return {
    schema_version: 1,
    client: publicClient(entry),
    platform,
    transport: 'stdio',
    server_key: SERVER_KEY,
    command_source: command.source,
    ...(platform === 'generic' ? { command: server.command, args: server.args } : { snippet: { mcpServers: { [SERVER_KEY]: server } } }),
    writes: 'none'
  }
}

function hostRefusal(message, code) {
  return clientError(message, code)
}
// Reads the host file under every safety rule. A missing file reads as absent; nothing here ever repeats file content.
function readHostFile(path, boundary) {
  assertNoLinkBelow(boundary, path, link => hostRefusal(`host configuration path traverses a symlink: ${link}`, 'MCP_HOST_UNSAFE_PATH'))
  const info = lstatSync(path, { throwIfNoEntry: false })
  if (!info) return { existed: false, before: '', mode: null, config: {} }
  if (info.isSymbolicLink() || !info.isFile()) throw hostRefusal(`${path} is not a regular file`, 'MCP_HOST_UNSAFE_PATH')
  if (info.nlink > 1) throw hostRefusal(`${path} has more than one hard link; refusing to edit it`, 'MCP_HOST_UNSAFE_PATH')
  const before = readFileSync(path, 'utf8')
  let config = {}
  if (before.trim()) {
    try {
      config = JSON.parse(before)
    } catch (error) {
      throw hostRefusal(`${path} is ${invalidJsonDetail(before, error)}; Holoself never rewrites unparseable configuration`, 'MCP_HOST_CONFIG_INVALID')
    }
  }
  if (!config || Array.isArray(config) || typeof config !== 'object') throw hostRefusal(`${path}: root must be a JSON object`, 'MCP_HOST_CONFIG_INVALID')
  const servers = config.mcpServers
  if (servers !== undefined && (!servers || Array.isArray(servers) || typeof servers !== 'object'))
    throw hostRefusal(`${path}: mcpServers must be an object`, 'MCP_HOST_CONFIG_INVALID')
  return { existed: true, before, mode: info.mode & 0o777, config }
}
const sameHostEntry = (a, b) => JSON.stringify(a) === JSON.stringify(b)
function entryState(config, desired) {
  const existing = config.mcpServers?.[SERVER_KEY]
  return existing === undefined ? 'missing' : sameHostEntry(existing, desired) ? 'present' : 'divergent'
}

// The one-file plan for --apply or --remove. The preview shows the path, the current SHA-256, the action and the
// Holoself entry only, never the rest of the file (it can hold other servers' secrets).
export function clientHostPlan(self, ref, options = {}) {
  const { platform, remove = false, forceReplace = false, command = holoselfCommand(), os, env, home } = options
  assertPlatform(platform)
  if (!CLIENT_APPLY_PLATFORMS.includes(platform))
    throw hostRefusal(`platform ${platform} is print-only; copy the printed command into the host`, 'MCP_PLATFORM_PRINT_ONLY')
  const entry = configuredClient(self, ref, { remove }),
    desired = clientServerEntry(entry.client_id, self, { command }),
    { path, boundary } = clientHostConfigPath(platform, { os, env, home }),
    file = readHostFile(path, boundary),
    state = entryState(file.config, desired)
  let action,
    after = file.before
  if (!remove) {
    if (state === 'present') action = 'unchanged'
    else {
      if (state === 'divergent' && !forceReplace)
        throw hostRefusal(`${path} already has a different holoself MCP server; refusing to overwrite (use --force-replace with confirmation)`, 'MCP_DIVERGENT')
      action = state === 'divergent' ? 'replace' : file.existed ? 'update' : 'create'
      after = JSON.stringify({ ...file.config, mcpServers: { ...(file.config.mcpServers || {}), [SERVER_KEY]: desired } }, null, 2) + '\n'
    }
  } else if (state === 'missing') action = 'unchanged'
  else if (state === 'divergent') throw hostRefusal(`${path}: the holoself MCP server does not match this client; remove it by hand`, 'MCP_DIVERGENT')
  else {
    const rest = { ...file.config.mcpServers }
    delete rest[SERVER_KEY]
    action = 'remove'
    after = JSON.stringify({ ...file.config, mcpServers: rest }, null, 2) + '\n'
  }
  const preview = {
    platform,
    path: slash(path),
    current_sha256: file.existed ? hash(file.before) : null,
    state,
    action,
    entry: { [SERVER_KEY]: desired }
  }
  return {
    schema_version: 1,
    client: publicClient(entry),
    preview,
    plan_sha256: hash(JSON.stringify({ ...preview, after_sha256: action === 'unchanged' ? null : hash(after) })),
    _write: { path, boundary, existed: file.existed, before: file.before, mode: file.mode, after }
  }
}
function backupPath(path, now = new Date()) {
  return `${path}.holoself-backup-${now.toISOString().replace(/[:.]/g, '-')}`
}
// Copies the original next to it before any write. A group- or world-readable original is backed up as 0600.
function writeBackup(path, before, mode) {
  let target = backupPath(path)
  for (let n = 1; existsSync(target); n++) target = `${backupPath(path)}-${n}`
  const backupMode = mode === null ? 0o600 : mode & 0o077 ? 0o600 : mode,
    fd = openSync(target, 'wx', backupMode)
  try {
    if (process.platform !== 'win32') fchmodSync(fd, backupMode)
    writeSync(fd, before)
  } finally {
    closeSync(fd)
  }
  return target
}
function missingHostDirs(path, boundary) {
  const out = []
  for (let dir = dirname(path); dir.length > boundary.length && !existsSync(dir); dir = dirname(dir)) out.push(dir)
  return out
}
// Applies a reviewed plan: refuses an unverified platform or a plan that changed since the preview, writes a backup,
// then writes atomically with the original mode. A failed write restores the original from memory.
// --apply and --remove are allowed only for an editable platform whose native MCP verification is recorded.
export function assertApplyPlatform(platform, matrix = loadVerificationMatrix()) {
  assertPlatform(platform)
  if (!CLIENT_APPLY_PLATFORMS.includes(platform))
    throw hostRefusal(`platform ${platform} is print-only; copy the printed command into the host`, 'MCP_PLATFORM_PRINT_ONLY')
  const support = mcpPlatformSupport(matrix, { platforms: [platform] })[0]
  if (support.support !== 'verified')
    throw hostRefusal(`${platform} MCP support is not natively verified; --apply stays disabled until it is (print the snippet instead)`, 'MCP_PLATFORM_NOT_VERIFIED')
}
export function applyClientHostConfig(self, ref, options = {}, io = {}) {
  const { platform, expectedPlanHash, matrix = loadVerificationMatrix() } = options
  assertApplyPlatform(platform, matrix)
  const plan = clientHostPlan(self, ref, options)
  if (!expectedPlanHash || expectedPlanHash !== plan.plan_sha256)
    throw hostRefusal('host configuration plan changed since the preview; review it again', 'MCP_PLAN_CHANGED')
  const { path, boundary, existed, before, mode, after } = plan._write,
    result = { ...plan, _write: undefined }
  if (plan.preview.action === 'unchanged') return { ...result, status: 'unchanged', backup: null }
  // Re-check the path immediately before writing (a link could have appeared since the plan was read).
  const recheck = readHostFile(path, boundary)
  if (recheck.existed !== existed || recheck.before !== before)
    throw hostRefusal('host configuration changed since the preview; review it again', 'MCP_PLAN_CHANGED')
  const write = io.write || ((target, content, writeOptions) => atomicWrite(target, content, writeOptions)),
    created = missingHostDirs(path, boundary)
  let backup = null
  try {
    if (existed) backup = writeBackup(path, before, mode)
    for (const dir of [...created].reverse()) mkdirSync(dir)
    write(path, after, existed ? { mode, exactMode: true } : { mode: 0o600, exactMode: true })
  } catch (error) {
    try {
      if (existed) atomicWrite(path, before, { mode, exactMode: true })
      else rmSync(path, { force: true })
      for (const dir of created)
        if (existsSync(dir) && !readdirSync(dir).length) rmdirSync(dir)
    } catch {}
    throw error
  }
  return { ...result, status: plan.preview.action === 'remove' ? 'removed' : 'configured', backup: backup ? slash(backup) : null }
}

// `mcp status --client`: the registry state plus whether each editable host file carries this client's entry.
export function clientHostStatus(self, ref, { platforms = CLIENT_APPLY_PLATFORMS, command = holoselfCommand(), os, env, home, matrix = loadVerificationMatrix() } = {}) {
  const entry = findClient(readClientRegistry(self).clients, ref)
  if (!entry) throw clientError(`unknown client: ${ref}`, 'CLIENT_UNKNOWN')
  let grant = entry.status === 'active' ? 'active' : 'revoked'
  if (grant === 'active')
    try {
      attestClient(self, entry.client_id)
    } catch (error) {
      grant = error.code === 'CLIENT_LENS_INVALID' ? 'lens-invalid' : 'invalid'
    }
  const support = Object.fromEntries(mcpPlatformSupport(matrix, { platforms }).map(item => [item.platform, item.support]))
  const rows = platforms.map(platform => {
    assertPlatform(platform)
    let file = null,
      hostEntry = 'error',
      detail = null
    try {
      const located = clientHostConfigPath(platform, { os, env, home })
      file = slash(located.path)
      hostEntry = entryState(readHostFile(located.path, located.boundary).config, clientServerEntry(entry.client_id, self, { command }))
    } catch (error) {
      if (error.code === 'MCP_HOST_PATH_UNKNOWN') hostEntry = 'unknown-path'
      detail = error.message
    }
    const clientState =
      hostEntry === 'present'
        ? grant === 'active'
          ? 'configured'
          : 'failing'
        : hostEntry === 'divergent' || hostEntry === 'error'
          ? 'failing'
          : hostEntry === 'unknown-path'
            ? 'print-only'
            : 'not-configured'
    return { platform, file, entry: hostEntry, client_state: clientState, support: support[platform] || 'configured', ...(detail ? { detail } : {}) }
  })
  return { schema_version: 1, client: publicClient(entry), grant, platforms: rows }
}
