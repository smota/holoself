// Project-local MCP client configuration: plan, apply (all-or-nothing with rollback), remove and inspect the one
// Holoself-owned `holoself` server entry in each host's project file. A divergent existing `holoself` entry is
// refused unless the caller passes forceReplace (the CLI requires --force-replace plus explicit confirmation).
import { existsSync, lstatSync, readFileSync, rmSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { holoselfMcpStatus } from './retrieval/mcp.mjs'
import { mcpPlatformSupport } from './mcp-verification.mjs'
import { detectMcpClients } from './mcp-detect.mjs'
import { assertNoLinkBelow } from './path-guard.mjs'
import { atomicWrite, fileModeOr, hash, slash } from './shared/fs.mjs'

const PLATFORMS = ['codex', 'agy', 'claude']
const MCP_START = '# holoself-mcp-managed-start'
const MCP_END = '# holoself-mcp-managed-end'
const BLOCK = new RegExp(`${MCP_START}[\\s\\S]*?${MCP_END}\\r?\\n?`)
const TOOLS = [
  'holoself_status',
  'holoself_context',
  'holoself_context_manifest',
  'holoself_context_get',
  'holoself_search',
  'holoself_proposal_create',
  'holoself_proposal_preview'
]
// Tools a host may run without asking. holoself_proposal_create writes a pending proposal and is never pre-approved.
export const READ_ONLY_TOOLS = Object.freeze(TOOLS.filter(tool => tool !== 'holoself_proposal_create'))
export const MCP_CONFIG_FILES = Object.freeze({ codex: '.codex/config.toml', agy: '.agents/mcp_config.json', claude: '.mcp.json' })

function safeConfigPath(project, path) {
  const boundary = resolve(project),
    target = resolve(path),
    rel = relative(boundary, target)
  if (!existsSync(boundary) || lstatSync(boundary).isSymbolicLink() || !lstatSync(boundary).isDirectory())
    throw new Error('MCP project must be a safe local directory')
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('MCP configuration path escapes project')
  assertNoLinkBelow(boundary, target, link => new Error(`MCP configuration path traverses a symlink: ${link}`))
  return target
}
function safeFile(path) {
  if (!existsSync(path)) return ''
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) throw new Error(`${path} is not a safe regular file`)
  return readFileSync(path, 'utf8')
}
function parseJson(path, text) {
  if (!text.trim()) return {}
  try {
    const value = JSON.parse(text)
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('root must be an object')
    return value
  } catch (error) {
    throw new Error(`${path} is invalid JSON: ${error.message}`)
  }
}
function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}
function desiredJsonServer(project, platform) {
  return platform === 'claude'
    ? { type: 'stdio', command: 'holoself', args: ['mcp', '--claude-project-dir'] }
    : { command: 'holoself', args: ['mcp', '--project', slash(project)], cwd: slash(project) }
}
function divergentError(message) {
  return Object.assign(new Error(message), { code: 'MCP_DIVERGENT' })
}
function changeShape(base, after, action, extra = {}) {
  return { ...base, after, action, sha256: after === null ? null : hash(after), ...extra }
}

// Next content of .mcp.json / .agents/mcp_config.json. install=false removes the entry only when it is still exactly
// Holoself's; `createdContainers`/`createdFile` (from the runtime record) let removal drop what Holoself added.
function jsonChange(project, platform, { install = true, forceReplace = false, createdFile = false, createdContainers = null } = {}) {
  const rel = MCP_CONFIG_FILES[platform],
    path = safeConfigPath(project, join(project, rel)),
    existed = existsSync(path),
    before = safeFile(path),
    config = parseJson(path, before),
    servers = config.mcpServers
  if (servers !== undefined && (!servers || Array.isArray(servers) || typeof servers !== 'object')) throw new Error(`${path} mcpServers must be an object`)
  const desired = desiredJsonServer(project, platform),
    existing = servers?.holoself,
    state = existing === undefined ? 'missing' : sameJson(existing, desired) ? 'present' : 'divergent',
    base = { platform, path, relative: slash(rel), existed, before, state, mode: fileModeOr(path, null), server: desired }
  if (install) {
    const created = createdContainers ?? (servers === undefined ? ['mcpServers'] : [])
    if (state === 'present') return changeShape(base, before, 'unchanged', { createdContainers: created })
    if (state === 'divergent' && !forceReplace) throw divergentError(`${path} has an unmanaged or divergent holoself MCP server; refusing to overwrite`)
    const next = { ...config, mcpServers: { ...(servers || {}), holoself: desired } }
    return changeShape(base, JSON.stringify(next, null, 2) + '\n', state === 'divergent' ? 'replace' : before ? 'update' : 'create', {
      createdContainers: created,
      ...(state === 'divergent' ? { replaced_sha256: hash(JSON.stringify(existing)) } : {})
    })
  }
  const created = createdContainers ?? ['mcpServers']
  if (state === 'missing') return changeShape(base, before, 'unchanged', { createdContainers: created })
  if (state === 'divergent') throw new Error(`${path}: the holoself MCP server was changed outside Holoself; remove it by hand`)
  const rest = { ...servers }
  delete rest.holoself
  const next = { ...config, mcpServers: rest }
  if (!Object.keys(rest).length && created.includes('mcpServers')) delete next.mcpServers
  const remove = createdFile && !Object.keys(next).length
  return changeShape(base, remove ? null : JSON.stringify(next, null, 2) + '\n', remove ? 'delete' : 'remove', { createdContainers: created })
}

const UNMANAGED_HOLOSELF = new RegExp(
  [
    String.raw`(?:^|\n)\s*\[\s*["']?mcp_servers["']?\s*\.\s*["']?holoself["']?\s*\]|(?:^|\n)\s*["']?mcp_servers["']?\s*\.\s*["']?holoself["']?\s*=|`,
    String.raw`(?:^|\n)\s*\[\s*["']?mcp_servers["']?\s*\][\s\S]*?(?:^|\n)\s*["']?holoself["']?\s*=|`,
    String.raw`(?:^|\n)\s*["']?mcp_servers["']?\s*=\s*\{[\s\S]*?\bholoself\b`
  ].join(''),
  'm'
)
const HOLOSELF_TABLE = /^\s*\[\s*["']?mcp_servers["']?\s*\.\s*["']?holoself["']?(?:\s*\.[^\]]*)?\]\s*(?:#.*)?$/
// Removes plain `[mcp_servers.holoself]` tables (and their sub-tables) for --force-replace; other spellings stay refused.
function withoutHoloselfTables(text) {
  let skipping = false
  const kept = []
  for (const line of text.split('\n')) {
    if (/^\s*\[/.test(line)) skipping = HOLOSELF_TABLE.test(line)
    if (!skipping) kept.push(line)
  }
  return kept.join('\n')
}
function codexBlock(project, approveReadTools) {
  const projectArg = slash(project).replaceAll('\\', '\\\\').replaceAll('"', '\\"'),
    toolList = TOOLS.map(tool => `"${tool}"`).join(', '),
    approvals = approveReadTools ? READ_ONLY_TOOLS.map(tool => `\n[mcp_servers.holoself.tools.${tool}]\napproval_mode = "approve"\n`).join('') : ''
  return (
    `${MCP_START}\n[mcp_servers.holoself]\ncommand = "holoself"\nargs = ["mcp", "--project", "${projectArg}"]\n` +
    `required = false\nenabled_tools = [${toolList}]\ndefault_tools_approval_mode = "writes"\n${approvals}${MCP_END}\n`
  )
}
function codexChange(project, { install = true, forceReplace = false, approveReadTools = false, createdFile = false } = {}) {
  const rel = MCP_CONFIG_FILES.codex,
    path = safeConfigPath(project, join(project, rel)),
    existed = existsSync(path),
    before = safeFile(path),
    starts = (before.match(new RegExp(MCP_START, 'g')) || []).length,
    ends = (before.match(new RegExp(MCP_END, 'g')) || []).length
  if (starts !== ends || starts > 1) throw new Error(`${path} has malformed Holoself MCP markers`)
  const outside = before.replace(BLOCK, ''),
    collision = UNMANAGED_HOLOSELF.test(outside),
    block = codexBlock(project, approveReadTools),
    current = starts ? before.match(BLOCK)[0].replace(/\r?\n?$/, '\n') : null,
    state = collision ? 'divergent' : !starts ? 'missing' : current === block ? 'present' : 'drifted',
    base = {
      platform: 'codex',
      path,
      relative: slash(rel),
      existed,
      before,
      state,
      mode: fileModeOr(path, null),
      server: { command: 'holoself', args: ['mcp', '--project', slash(project)], required: false, enabled_tools: TOOLS, default_tools_approval_mode: 'writes' },
      ...(approveReadTools ? { tool_approvals: Object.fromEntries(READ_ONLY_TOOLS.map(tool => [tool, 'approve'])) } : {}),
      managed_block: block
    }
  if (install) {
    let source = before
    if (collision) {
      if (!forceReplace) throw divergentError(`${path} has an unmanaged holoself MCP server; refusing to overwrite`)
      source = withoutHoloselfTables(before)
      if (UNMANAGED_HOLOSELF.test(source.replace(BLOCK, '')))
        throw new Error(`${path} defines the holoself MCP server in a form Holoself cannot replace safely; remove it by hand`)
    }
    const after = BLOCK.test(source) ? source.replace(BLOCK, block) : (source.trimEnd() ? `${source.trimEnd()}\n\n` : '') + block
    return changeShape(base, after, after === before ? 'unchanged' : collision ? 'replace' : before ? 'update' : 'create')
  }
  if (!starts) return changeShape(base, before, 'unchanged')
  const rest = before.replace(BLOCK, ''),
    trimmed = rest.trimEnd() ? rest.trimEnd() + '\n' : ''
  const remove = createdFile && !trimmed
  return changeShape(base, remove ? null : trimmed, remove ? 'delete' : 'remove')
}

// One platform's next file content. Options: install (default true), forceReplace, approveReadTools (Codex only:
// per-tool approval tables inside the managed block), createdFile/createdContainers (removal bookkeeping).
export function mcpServerChange(project, platform, options = {}) {
  if (!PLATFORMS.includes(platform)) throw new Error(`unsupported MCP platform: ${platform}`)
  return platform === 'codex' ? codexChange(resolve(project), options) : jsonChange(resolve(project), platform, options)
}
export function writeMcpChange(change) {
  if (change.action === 'unchanged') return
  if (change.after === null) return rmSync(change.path, { force: true })
  // Existing configuration keeps its permission bits (it can hold env secrets); new files follow the umask.
  atomicWrite(change.path, change.after, change.mode === null ? { mode: 0o666 } : { mode: change.mode, exactMode: true })
}

// Codex approvals live inside the managed block, so planning a block must know whether link activation recorded
// read-tool pre-approval for this project (.holoself/runtime.json); otherwise a re-plan would report drift.
export function recordedCodexReadApproval(project) {
  try {
    const path = join(resolve(project), '.holoself', 'runtime.json')
    if (!existsSync(path) || !lstatSync(path).isFile()) return false
    const runtime = JSON.parse(readFileSync(path, 'utf8'))
    return runtime?.mcpApproveReadTools === true && (runtime.mcpInstallations || []).some(item => item?.id === 'codex')
  } catch {
    return false
  }
}
function publicChange({ before, after, mode, ...change }) {
  return change
}
export function mcpPlanHash(changes) {
  return hash(JSON.stringify(changes.map(({ platform, relative, action, sha256 }) => ({ platform, relative, action, sha256 }))))
}

// options.platforms: explicit list; options.allDetected: every client detected for this project (binary on PATH or
// project configuration, see mcp-detect.mjs); options.env: environment for detection (tests pass a fake PATH).
export function mcpConfigurationPlan(projectInput, { platforms = PLATFORMS, allDetected = false, forceReplace = false, env = process.env } = {}) {
  const project = resolve(projectInput)
  holoselfMcpStatus(project)
  if (allDetected && platforms?.length && platforms !== PLATFORMS) throw new Error('--all-detected cannot be combined with --platform')
  const detection = allDetected ? detectMcpClients(project, { env }) : null
  const selected = allDetected ? detection.filter(item => item.detected).map(item => item.platform) : [...new Set(platforms?.length ? platforms : PLATFORMS)]
  for (const platform of selected) if (!PLATFORMS.includes(platform)) throw new Error(`unsupported MCP platform: ${platform}`)
  const approveCodex = recordedCodexReadApproval(project),
    refusals = [],
    changes = []
  for (const platform of selected) {
    try {
      changes.push(mcpServerChange(project, platform, { forceReplace, approveReadTools: platform === 'codex' && approveCodex }))
    } catch (error) {
      refusals.push(error.message)
    }
  }
  if (refusals.length) throw new Error(refusals.join('; '))
  const visible = changes.map(publicChange)
  return {
    schema_version: 1,
    project: slash(project),
    authority: '.holoself/link.yaml',
    transport: 'stdio',
    command_requirement: 'holoself on client PATH',
    local_only: true,
    commit_warning: 'Codex and AGY configuration embeds this host project path; keep it uncommitted unless explicitly reviewed.',
    ...(detection ? { detection } : {}),
    ...(forceReplace ? { force_replace: true } : {}),
    changes: visible,
    plan_sha256: mcpPlanHash(visible),
    _changes: changes
  }
}
// Applies every change or none: a failure restores each file already written (or removes it if it was created).
// expectedPlanHash makes apply refuse when the files changed after the preview was shown.
export function applyMcpConfiguration(projectInput, options = {}, io = {}) {
  const plan = mcpConfigurationPlan(projectInput, options),
    written = []
  if (options.expectedPlanHash && options.expectedPlanHash !== plan.plan_sha256)
    throw new Error('MCP configuration plan changed since the preview; review it again')
  const write = io.write || ((path, content) => writeMcpChange({ path, after: content, action: 'write', mode: fileModeOr(path, null) })),
    remove = io.remove || (path => rmSync(path, { force: true }))
  try {
    for (const change of plan._changes)
      if (change.action !== 'unchanged') {
        written.push(change)
        write(change.path, change.after)
      }
  } catch (error) {
    for (const change of written.reverse()) {
      try {
        if (change.existed) atomicWrite(change.path, change.before, change.mode === null ? { mode: 0o666 } : { mode: change.mode, exactMode: true })
        else remove(change.path)
      } catch {}
    }
    throw error
  }
  return {
    ...plan,
    changes: plan.changes.map(change => ({ ...change, result: change.action === 'unchanged' ? 'unchanged' : 'configured' })),
    _changes: undefined,
    status: 'configured'
  }
}

// Per-client state for `mcp status` and the Workbench: not-detected | detected | configured | verified | failing.
export function mcpClientState({ detected, entry, linkHealthy, support }) {
  if (['divergent', 'drifted', 'error'].includes(entry)) return 'failing'
  if (entry === 'present') return !linkHealthy ? 'failing' : support === 'verified' ? 'verified' : 'configured'
  return detected ? 'detected' : 'not-detected'
}
export function mcpConfigurationStatus(projectInput, { platforms = PLATFORMS, env = process.env } = {}) {
  const project = resolve(projectInput),
    link = holoselfMcpStatus(project),
    linkHealthy = link.context?.state === 'valid',
    selected = [...new Set(platforms?.length ? platforms : PLATFORMS)]
  for (const platform of selected) if (!PLATFORMS.includes(platform)) throw new Error(`unsupported MCP platform: ${platform}`)
  const support = Object.fromEntries(mcpPlatformSupport().map(item => [item.platform, item])),
    detection = Object.fromEntries(detectMcpClients(project, { env }).map(item => [item.platform, item])),
    approveCodex = recordedCodexReadApproval(project)
  const rows = selected.map(platform => {
    let change = null,
      entry = 'error',
      detail = null
    try {
      change = mcpServerChange(project, platform, { approveReadTools: platform === 'codex' && approveCodex, forceReplace: true })
      entry = change.state
    } catch (error) {
      detail = error.message
    }
    const current = entry === 'present'
    return {
      platform,
      file: MCP_CONFIG_FILES[platform],
      state: current ? 'configured' : 'missing-or-drifted',
      client_state: mcpClientState({ detected: detection[platform]?.detected, entry, linkHealthy, support: support[platform]?.support }),
      entry,
      ...(detail ? { detail } : {}),
      detected: detection[platform]?.detected === true,
      detected_by: detection[platform]?.detected_by || [],
      expected_sha256: change?.state === 'divergent' ? null : (change?.sha256 ?? null),
      support: support[platform]?.support || 'configured',
      tested_version: support[platform]?.tested_version ?? null,
      last_verified: support[platform]?.last_verified ?? null
    }
  })
  return {
    schema_version: 1,
    project: slash(project),
    authority: '.holoself/link.yaml',
    transport: 'stdio',
    link_state: linkHealthy ? 'valid' : 'broken',
    state: rows.every(row => row.state === 'configured') ? 'configured' : 'degraded',
    platforms: rows
  }
}

export { PLATFORMS as MCP_PLATFORMS }

// Workbench view of one space: client states only (no file contents, hashes or error text, which can carry paths).
export function mcpClientOverview(projectInput, { env = process.env } = {}) {
  const project = resolve(projectInput)
  if (!existsSync(join(project, '.holoself', 'link.yaml'))) return { linked: false, state: 'not-linked', clients: [] }
  let status
  try {
    status = mcpConfigurationStatus(project, { env })
  } catch {
    return { linked: true, state: 'unavailable', clients: [] }
  }
  return {
    linked: true,
    state: status.link_state === 'valid' ? 'ok' : 'failing',
    clients: status.platforms.map(item => ({
      platform: item.platform,
      name: MCP_CLIENT_NAMES[item.platform],
      state: item.client_state,
      file: item.file,
      detected: item.detected,
      support: item.support,
      tested_version: item.tested_version,
      last_verified: item.last_verified
    }))
  }
}
const MCP_CLIENT_NAMES = { codex: 'Codex', agy: 'AGY', claude: 'Claude Code' }
