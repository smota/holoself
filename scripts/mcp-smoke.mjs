#!/usr/bin/env node
// Live MCP smoke test for native hosts (Claude Code, Codex, AGY). Product tooling only: it needs the host
// CLIs, their real authentication and network access, so it never runs in `npm run verify` or CI.
//
// Usage: node scripts/mcp-smoke.mjs [--platform claude|codex|agy]... [--approval scoped|host-default]
//                                   [--timeout-ms 300000] [--write-matrix] [--keep]
//
// Each run builds a synthetic self root and linked project in a fresh temporary directory (HOLOSELF_HOME
// points there; HOME is untouched so the hosts keep their own auth), configures the host with
// `holoself mcp configure`, and drives the host headlessly. Results are judged from independent evidence:
//   - an audit log written by the server itself (HOLOSELF_MCP_AUDIT_LOG, tool name and outcome only),
//   - a SHA-256 of every file in the canonical self root before and after,
//   - the pending proposal file in the project.
// The agent's own final JSON is recorded as `self_report` but never used to mark a tool as passing.
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('..', import.meta.url))
const cli = join(repo, 'bin', 'holoself.mjs')
const matrixPath = join(repo, 'docs', 'reference', 'platform-verification.json')
const PLATFORMS = ['claude', 'codex', 'agy']
export const SMOKE_TOOLS = [
  'holoself_status',
  'holoself_context',
  'holoself_context_manifest',
  'holoself_context_get',
  'holoself_search',
  'holoself_proposal_create',
  'holoself_proposal_preview'
]
const CLAIM = 'Synthetic smoke claim: the smoke project prefers concise release notes.'

// POSIX single-quoted shell word: safe for any path, including ones that contain quotes or spaces.
export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}
// TOML basic string (also valid as a quoted key): JSON escapes are TOML escapes, plus DEL, which TOML forbids raw.
export function tomlString(value) {
  return JSON.stringify(String(value)).replaceAll('\x7f', '\\u007F')
}
// Host-reported text is recorded in the committed matrix; strip anything that looks like an absolute local path.
export function sanitizeReason(text) {
  return String(text ?? '')
    .replace(/\\\\[^\s;'"`]+/g, '<local-path>')
    .replace(/(^|[^A-Za-z])[A-Za-z]:[\\/][^\s;'"`]*/g, '$1<local-path>')
    .replace(/(^|[\s("'=`:,[{])(?:~)?\/(?:[^\s;'"`)\]},]+\/?)+/g, '$1<local-path>')
}

function parseArgs(argv) {
  const options = { platforms: [], approval: 'scoped', timeoutMs: 300000, writeMatrix: false, keep: false }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--platform') options.platforms.push(argv[++i])
    else if (flag === '--approval') options.approval = argv[++i]
    else if (flag === '--timeout-ms') options.timeoutMs = Number(argv[++i])
    else if (flag === '--write-matrix') options.writeMatrix = true
    else if (flag === '--keep') options.keep = true
    else throw new Error(`unknown option: ${flag}`)
  }
  if (!options.platforms.length) options.platforms = [...PLATFORMS]
  for (const platform of options.platforms) if (!PLATFORMS.includes(platform)) throw new Error(`unsupported platform: ${platform}`)
  if (!['scoped', 'host-default'].includes(options.approval)) throw new Error('--approval must be scoped or host-default')
  if (!(options.timeoutMs > 0)) throw new Error('--timeout-ms must be positive')
  return options
}

function holoself(args, env) {
  const result = spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', shell: false })
  if (result.status !== 0) throw new Error(`holoself ${args[0]} failed: ${result.stderr || result.stdout}`)
  return result.stdout
}

function hashTree(root) {
  const files = []
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) files.push([relative(root, path).split('\\').join('/'), createHash('sha256').update(readFileSync(path)).digest('hex')])
    }
  }
  walk(root)
  return { sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'), files: Object.fromEntries(files) }
}

function changedFiles(before, after) {
  const keys = new Set([...Object.keys(before.files), ...Object.keys(after.files)])
  return [...keys].filter(key => before.files[key] !== after.files[key]).sort()
}

// Synthetic self root and linked project. All content is invented for the smoke run.
function buildFixture(platform, { keep = false } = {}) {
  const base = mkdtempSync(join(tmpdir(), `holoself-smoke-${platform}-`))
  try {
    return populateFixture(base, platform)
  } catch (error) {
    if (!keep) rmSync(base, { recursive: true, force: true })
    throw error
  }
}
function populateFixture(base, platform) {
  const self = join(base, 'self'),
    project = join(base, 'smoke-project'),
    bin = join(base, 'bin'),
    auditLog = join(base, 'mcp-audit.ndjson')
  mkdirSync(project, { recursive: true })
  mkdirSync(bin, { recursive: true })
  // The synthetic self is registered in a self map inside the fixture; the host inherits it through its environment.
  const env = { ...process.env, HOLOSELF_HOME: base, HOLOSELF_CONFIG_DIR: join(base, 'holoself-config') }
  holoself(['init', '--root', self], env)
  writeFileSync(
    join(self, 'profile', 'identity.md'),
    '---\naccess_lenses: [general, professional, private]\ndisclosure: internal-only\nsensitivity: personal\ndocument_role: content\n---\n' +
      '# Identity\n\nSynthetic smoke persona. Prefers concise release notes and small focused pull requests.\n'
  )
  mkdirSync(join(project, 'Context'), { recursive: true })
  writeFileSync(join(project, 'Context', 'evidence.md'), '# Evidence\n\nThe smoke project keeps release notes concise.\n')
  writeFileSync(join(project, 'README.md'), '# Smoke project\n\nSynthetic project for Holoself MCP verification.\n')
  holoself(['link', 'add', '--project', project, '--self', self, '--lens', 'professional', '--no-activate', '--yes'], env)
  holoself(['mcp', 'configure', '--project', project, '--platform', platform, '--yes'], env)
  // The host resolves `holoself` from PATH exactly as configured; a wrapper placed first on the host's PATH
  // adds the audit log without changing the generated client configuration.
  const wrapper = join(bin, 'holoself')
  writeFileSync(wrapper, `#!/bin/sh\nHOLOSELF_MCP_AUDIT_LOG=${shellQuote(auditLog)} exec ${shellQuote(process.execPath)} ${shellQuote(cli)} "$@"\n`)
  chmodSync(wrapper, 0o755)
  const hostEnv = { ...env, PATH: `${bin}${delimiter}${process.env.PATH}` }
  return { base, self, project, auditLog, hostEnv }
}

function prompt() {
  return [
    'This is an automated verification of the "holoself" MCP server using synthetic data.',
    'Use only the holoself MCP tools; do not read or edit files and do not run shell commands.',
    'Call these tools in order, once each:',
    '1. holoself_status with no arguments.',
    '2. holoself_context with {"task": "write concise release notes", "budget": "small"}.',
    '3. holoself_context_manifest with {"task": "write concise release notes", "budget": "small"}.',
    '4. holoself_context_get with {"task": "write concise release notes", "budget": "small", "source_ids": [<the first source_id from step 3>]}.',
    '5. holoself_search with {"query": "release notes"}.',
    `6. holoself_proposal_create with {"claim": "${CLAIM}", "source_files": ["Context/evidence.md"], "proposal_type": "new_fact", "visibility": "private"}.`,
    '7. holoself_proposal_preview with {"proposal_id": <proposal_id returned by step 6>}.',
    'If a call is refused or fails, continue with the next call.',
    'Finally print exactly one line of JSON and nothing else: {"results":[{"tool":"<name>","ok":true|false,"note":"<short reason>"}]}.'
  ].join('\n')
}

function hostCommand(platform, project, approval) {
  const text = prompt()
  if (platform === 'claude') {
    const args = ['-p', text, '--output-format', 'json', '--mcp-config', '.mcp.json', '--strict-mcp-config', '--no-session-persistence', '--permission-mode', 'dontAsk']
    if (approval === 'scoped') args.push('--allowedTools', SMOKE_TOOLS.map(tool => `mcp__holoself__${tool}`).join(','))
    return { command: 'claude', args, approvalSetting: `--allowedTools ${SMOKE_TOOLS.map(tool => `mcp__holoself__${tool}`).join(',')}` }
  }
  if (platform === 'codex') {
    // Project config layers only load for trusted projects; trust is granted for this temporary project only.
    const args = ['exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '-C', project, '--json']
    args.push('-c', `projects={ ${tomlString(project)} = { trust_level = "trusted" } }`)
    if (approval === 'scoped') args.push('-c', 'mcp_servers.holoself.default_tools_approval_mode="approve"')
    args.push(text)
    return { command: 'codex', args, approvalSetting: 'mcp_servers.holoself.default_tools_approval_mode = "approve" (generated default is "writes")' }
  }
  const allow = SMOKE_TOOLS.map(tool => `mcp(holoself/${tool})`)
  const args = ['-p', text, '--output-format', 'json', '--new-project']
  if (approval === 'scoped') args.push('--settings', JSON.stringify({ permissions: { allow } }))
  return { command: 'agy', args, approvalSetting: `permissions.allow = ${JSON.stringify(allow)}` }
}

function hostVersion(command) {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8', shell: false })
  if (result.status !== 0) return null
  return (result.stdout.match(/\d+\.\d+\.\d+/) || [result.stdout.trim()])[0]
}

function runHost(command, args, { cwd, env, timeoutMs }) {
  return new Promise(resolvePromise => {
    const started = Date.now()
    const child = spawn(command, args, { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '',
      stderr = '',
      timedOut = false
    child.stdout.on('data', chunk => (stdout += chunk))
    child.stderr.on('data', chunk => (stderr += chunk))
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5000).unref()
    }, timeoutMs)
    child.on('error', error => {
      clearTimeout(timer)
      resolvePromise({ status: null, stdout, stderr: `${stderr}${error.message}`, timedOut, ms: Date.now() - started })
    })
    child.on('close', status => {
      clearTimeout(timer)
      resolvePromise({ status, stdout, stderr, timedOut, ms: Date.now() - started })
    })
  })
}

function readAudit(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
}

function selfReport(text) {
  const candidates = [...text.matchAll(/\{"results":\[[\s\S]*?\]\}/g)].map(match => match[0])
  for (const candidate of candidates.reverse())
    try {
      return JSON.parse(candidate)
    } catch {
      // try an earlier candidate
    }
  return null
}

const GATE = /permission|approv|denied|not allowed|requires? (user )?(approval|confirmation)|blocked/i
const DEPENDS = { holoself_context_get: 'holoself_context_manifest', holoself_proposal_preview: 'holoself_proposal_create' }
function gateExcerpt(text) {
  const denied = text.match(/"denied_actions":(\[[^\]]*\])/)
  if (denied)
    try {
      return `denied_actions ${JSON.parse(denied[1]).map(item => `${item.action}:${item.display_name}`).join(', ')}`
    } catch {
      // fall through to a plain excerpt
    }
  const match = GATE.exec(text)
  if (!match) return 'approval/permission refusal'
  return text.slice(Math.max(0, match.index - 40), match.index + 80).replace(/\s+/g, ' ').trim()
}

export function judgeTools(audit, report, hostText) {
  const tools = {}
  for (const tool of SMOKE_TOOLS) {
    const calls = audit.filter(entry => entry.event === 'tools/call' && entry.tool === tool)
    const claimed = report?.results?.find(item => item.tool === tool)
    if (calls.some(call => call.ok)) tools[tool] = { result: 'pass', reason: `server audit recorded ${calls.length} call(s), ok` }
    else if (calls.length) tools[tool] = { result: 'fail', reason: `server returned error ${calls.map(call => call.error_code).join(', ')}` }
    else if (GATE.test(claimed?.note || '') || (!report && GATE.test(hostText)))
      tools[tool] = { result: 'blocked', reason: `host did not invoke the server; host reported: ${sanitizeReason(claimed?.note || gateExcerpt(hostText)).slice(0, 200)}` }
    else tools[tool] = { result: 'not-run', reason: claimed?.note ? `host did not invoke the server; host reported: ${sanitizeReason(claimed.note).slice(0, 200)}` : 'no server call observed' }
  }
  // A tool whose required input comes from an earlier tool cannot pass on its own when that tool did not pass.
  for (const [tool, prerequisite] of Object.entries(DEPENDS))
    if (tools[tool].result !== 'pass' && tools[prerequisite].result !== 'pass' && tools[prerequisite].result !== tools[tool].result)
      tools[tool] = { result: tools[prerequisite].result, reason: `requires output of ${prerequisite} (${tools[prerequisite].result}); ${tools[tool].reason}` }
  return tools
}

function pendingProposals(project) {
  const dir = join(project, '.holoself', 'proposals')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(name => name.endsWith('.yaml'))
    .map(name => ({ name, text: readFileSync(join(dir, name), 'utf8') }))
    .filter(item => /status: "pending"/.test(item.text) && item.text.includes('Synthetic smoke claim'))
    .map(item => item.name)
}

async function smoke(platform, options) {
  const fixture = buildFixture(platform, { keep: options.keep })
  try {
    const before = hashTree(fixture.self)
    const { command, args, approvalSetting } = hostCommand(platform, fixture.project, options.approval)
    const version = hostVersion(command)
    process.stderr.write(`[smoke] ${platform} ${version || '(version unknown)'} approval=${options.approval} in ${fixture.base}\n`)
    const host = await runHost(command, args, { cwd: fixture.project, env: fixture.hostEnv, timeoutMs: options.timeoutMs })
    writeFileSync(join(fixture.base, 'host-stdout.txt'), host.stdout)
    writeFileSync(join(fixture.base, 'host-stderr.txt'), host.stderr)
    const after = hashTree(fixture.self)
    const audit = readAudit(fixture.auditLog)
    const report = selfReport(host.stdout.replaceAll('\\"', '"'))
    const tools = judgeTools(audit, report, `${host.stdout}\n${host.stderr}`)
    const proposals = pendingProposals(fixture.project)
    return {
      platform,
      host_version: version,
      verified_at: new Date().toISOString().slice(0, 10),
      approval: options.approval,
      approval_setting: approvalSetting,
      discovery: audit.some(entry => entry.event === 'tools/list') ? 'verified' : 'failed',
      tools,
      no_canonical_write: before.sha256 === after.sha256,
      canonical_hash_before: before.sha256,
      canonical_hash_after: after.sha256,
      canonical_changed_files: changedFiles(before, after),
      pending_proposal_files: proposals.length,
      audit,
      self_report: report,
      host_exit: host.status,
      host_timed_out: host.timedOut,
      host_ms: host.ms,
      workdir: options.keep ? fixture.base : null
    }
  } finally {
    if (!options.keep) rmSync(fixture.base, { recursive: true, force: true })
  }
}

// A scoped run (tool-scoped host allow rules) is the verification record. A host-default run records which
// tools the host refuses headlessly without that setting, and never replaces the verification record.
export function mergeMatrix(matrix, result) {
  const platforms = [...(matrix.platforms || [])],
    index = platforms.findIndex(item => item.platform === result.platform),
    existing = index >= 0 ? platforms[index] : null
  let entry
  if (result.approval === 'host-default') {
    const host_default = { host_version: result.host_version, verified_at: result.verified_at, discovery: result.discovery, tools: result.tools }
    entry = existing ? { ...existing, host_default } : { platform: result.platform, host_version: result.host_version, verified_at: result.verified_at, discovery: 'failed', no_canonical_write: false, pending_proposal_created: false, approval_setting: null, tools: Object.fromEntries(Object.keys(result.tools).map(tool => [tool, { result: 'not-run', reason: 'no scoped verification run recorded' }])), host_default }
  } else
    entry = {
      platform: result.platform,
      host_version: result.host_version,
      verified_at: result.verified_at,
      discovery: result.discovery,
      no_canonical_write: result.no_canonical_write,
      pending_proposal_created: result.pending_proposal_files > 0,
      approval_setting: result.approval_setting,
      tools: result.tools,
      ...(existing?.host_default ? { host_default: existing.host_default } : {})
    }
  if (index >= 0) platforms[index] = entry
  else platforms.push(entry)
  return { ...matrix, schema_version: 1, platforms: platforms.sort((a, b) => a.platform.localeCompare(b.platform)) }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (process.platform === 'win32') throw new Error('mcp-smoke currently drives hosts through a POSIX shell wrapper; run it on Linux or macOS')
  const results = []
  for (const platform of options.platforms) results.push(await smoke(platform, options))
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`)
  if (options.writeMatrix) {
    let matrix = existsSync(matrixPath) ? JSON.parse(readFileSync(matrixPath, 'utf8')) : { schema_version: 1, platforms: [] }
    for (const result of results) matrix = mergeMatrix(matrix, result)
    writeFileSync(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`)
    process.stderr.write(`[smoke] wrote ${relative(repo, matrixPath)}\n`)
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => {
    process.stderr.write(`[smoke] ${error.message}\n`)
    process.exit(1)
  })
}
