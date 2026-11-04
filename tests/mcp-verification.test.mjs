import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { MCP_TOOLS } from '../src/mcp-server.mjs'
import { loadVerificationMatrix, mcpPlatformSupport, MCP_VERIFICATION_TOOLS } from '../src/mcp-verification.mjs'
import { judgeTools, mergeMatrix, sanitizeReason, shellQuote, SMOKE_TOOLS, tomlString } from '../scripts/mcp-smoke.mjs'

const pass = Object.fromEntries(MCP_VERIFICATION_TOOLS.map(tool => [tool, { result: 'pass', reason: 'server audit recorded 1 call(s), ok' }]))
const entry = (platform, overrides = {}) => ({
  platform,
  host_version: '1.2.3',
  verified_at: '2026-11-04',
  discovery: 'verified',
  no_canonical_write: true,
  pending_proposal_created: true,
  approval_setting: 'scoped allow rule',
  tools: { ...pass },
  ...overrides
})

test('verification tool lists match the served MCP tools', () => {
  assert.deepEqual(MCP_VERIFICATION_TOOLS, MCP_TOOLS.map(tool => tool.name))
  assert.deepEqual(SMOKE_TOOLS, MCP_VERIFICATION_TOOLS)
})

test('only a fully passing recorded run promotes a platform to verified', () => {
  const matrix = {
    platforms: [
      entry('claude'),
      entry('codex', { tools: { ...pass, holoself_proposal_create: { result: 'blocked', reason: 'approval required' } } }),
      entry('agy', { tools: { ...pass, holoself_context_get: { result: 'fail', reason: 'INVALID_ARGUMENT' } } })
    ]
  }
  const [claude, codex, agy] = mcpPlatformSupport(matrix)
  assert.deepEqual(
    { support: claude.support, tested_version: claude.tested_version, last_verified: claude.last_verified, approval_setting: claude.approval_setting },
    { support: 'verified', tested_version: '1.2.3', last_verified: '2026-11-04', approval_setting: 'scoped allow rule' }
  )
  for (const item of [codex, agy]) {
    assert.equal(item.support, 'configured')
    assert.equal(item.tested_version, null)
    assert.equal(item.last_verified, null)
  }
  assert.match(codex.evidence, /holoself_proposal_create=blocked/)
  assert.match(agy.evidence, /holoself_context_get=fail/)
})

test('missing tools, discovery, canonical-write proof, proposal evidence, version, or date block promotion', () => {
  const { holoself_search, ...withoutSearch } = pass
  const cases = [
    { tools: withoutSearch },
    { discovery: 'failed' },
    { no_canonical_write: false },
    { no_canonical_write: undefined },
    { pending_proposal_created: false },
    { host_version: null },
    { verified_at: 'yesterday' },
    { tools: { ...pass, holoself_status: { result: 'not-run' } } }
  ]
  for (const overrides of cases) assert.equal(mcpPlatformSupport({ platforms: [entry('claude', overrides)] })[0].support, 'configured', JSON.stringify(overrides))
  assert.deepEqual(mcpPlatformSupport({ platforms: [] }).map(item => item.support), ['configured', 'configured', 'configured'])
  assert.deepEqual(mcpPlatformSupport(null).map(item => item.platform), ['claude', 'codex', 'agy'])
  assert.deepEqual(loadVerificationMatrix(new URL('file:///nonexistent/holoself-matrix.json')), { platforms: [] })
})

test('capabilities --json reports MCP platform support from the recorded matrix', () => {
  const cli = fileURLToPath(new URL('../bin/holoself.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [cli, 'capabilities', '--json'], { encoding: 'utf8', shell: false })
  assert.equal(result.status, 0, result.stderr)
  const capabilities = JSON.parse(result.stdout)
  assert.deepEqual(capabilities.mcp.platforms, mcpPlatformSupport(loadVerificationMatrix()))
  const matrix = loadVerificationMatrix()
  for (const item of capabilities.mcp.platforms) {
    if (item.support !== 'verified') continue
    const recorded = matrix.platforms.find(row => row.platform === item.platform)
    assert.equal(item.tested_version, recorded.host_version)
    assert.equal(item.last_verified, recorded.verified_at)
    assert.ok(MCP_VERIFICATION_TOOLS.every(tool => recorded.tools[tool].result === 'pass'))
  }
})

test('smoke judging trusts the server audit, not the agent self-report', () => {
  const audit = [
    { event: 'tools/list', tools: 7 },
    { event: 'tools/call', tool: 'holoself_status', ok: true, error_code: null },
    { event: 'tools/call', tool: 'holoself_context', ok: false, error_code: 'INVALID_ARGUMENT' },
    { event: 'tools/call', tool: 'holoself_proposal_preview', ok: false, error_code: 'INVALID_ARGUMENT' }
  ]
  const report = {
    results: [
      ...SMOKE_TOOLS.map(tool => ({ tool, ok: true, note: 'claimed success' })).filter(item => item.tool !== 'holoself_proposal_create'),
      { tool: 'holoself_proposal_create', ok: false, note: 'Approval required; approval policy is never.' }
    ]
  }
  const tools = judgeTools(audit, report, '')
  assert.equal(tools.holoself_status.result, 'pass')
  assert.equal(tools.holoself_context.result, 'fail')
  assert.equal(tools.holoself_search.result, 'not-run')
  assert.equal(tools.holoself_proposal_create.result, 'blocked')
  assert.equal(tools.holoself_proposal_preview.result, 'blocked')
  assert.match(tools.holoself_proposal_preview.reason, /requires output of holoself_proposal_create/)
  const denied = judgeTools([{ event: 'tools/list', tools: 7 }], null, '{"denied_actions":[{"action":"mcp","display_name":"CallMcpTool"}]}')
  assert.ok(Object.values(denied).every(item => item.result === 'blocked'))
  assert.match(denied.holoself_status.reason, /denied_actions mcp:CallMcpTool/)
})

test('a host-default run never replaces the scoped verification record', () => {
  const scoped = { platform: 'codex', host_version: '1.0.0', verified_at: '2026-11-04', approval: 'scoped', approval_setting: 'approve', discovery: 'verified', tools: pass, no_canonical_write: true, pending_proposal_files: 1 }
  const fallback = { ...scoped, approval: 'host-default', tools: { ...pass, holoself_proposal_create: { result: 'blocked', reason: 'approval' } }, pending_proposal_files: 0 }
  let matrix = mergeMatrix({ schema_version: 1, platforms: [] }, scoped)
  matrix = mergeMatrix(matrix, fallback)
  assert.equal(mcpPlatformSupport(matrix)[1].support, 'verified')
  assert.equal(matrix.platforms[0].host_default.tools.holoself_proposal_create.result, 'blocked')
  const onlyDefault = mergeMatrix({ platforms: [] }, { ...fallback, platform: 'agy' })
  assert.equal(mcpPlatformSupport(onlyDefault)[2].support, 'configured')
  matrix = mergeMatrix(matrix, { ...scoped, tools: { ...pass, holoself_search: { result: 'fail', reason: 'x' } } })
  assert.equal(mcpPlatformSupport(matrix)[1].support, 'configured')
  assert.ok(matrix.platforms[0].host_default, 'host-default evidence survives a new scoped record')
})

test('smoke wrapper quoting survives quotes and spaces, and TOML keys are escaped', { skip: process.platform === 'win32' }, () => {
  for (const value of ["/tmp/it's here/audit.ndjson", 'plain', "a'b'' c\\d $HOME `x`"]) {
    const result = spawnSync('/bin/sh', ['-c', `printf '%s' ${shellQuote(value)}`], { encoding: 'utf8' })
    assert.equal(result.stdout, value)
  }
  assert.equal(tomlString('/tmp/a "b"\\c'), '"/tmp/a \\"b\\"\\\\c"')
  assert.equal(tomlString('x\x7fy\n'), '"x\\u007Fy\\n"')
})

test('host-reported smoke reasons are stripped of absolute local paths', () => {
  for (const path of ['/home/someone/project/.mcp.json', 'C:\\Users\\someone\\x', '\\\\server\\share\\x', '~/private/notes'])
    assert.doesNotMatch(sanitizeReason(`denied: approval needed for ${path} (see log)`), /someone|server|private/)
  assert.equal(sanitizeReason('approval required for mcp(holoself/holoself_status) and/or writes'), 'approval required for mcp(holoself/holoself_status) and/or writes')
  const report = { results: [{ tool: 'holoself_status', ok: false, note: 'permission denied reading /home/someone/.config/host.json' }] }
  const tools = judgeTools([], report, '')
  assert.equal(tools.holoself_status.result, 'blocked')
  assert.doesNotMatch(tools.holoself_status.reason, /someone/)
  assert.match(tools.holoself_status.reason, /<local-path>/)
})
