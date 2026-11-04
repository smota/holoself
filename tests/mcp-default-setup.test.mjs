// Issue #64: MCP by default where verified, one-command multi-client setup, opt-in read-tool pre-approval and the
// Workbench per-client view. Everything runs in temp directories; PATH is a fake bin directory where detection matters.
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readRuntime } from '../src/adapters.mjs'
import { mcpActivationEntries } from '../src/adapters/mcp-activation.mjs'
import { claudeReadToolRules, readApprovalMechanism } from '../src/adapters/mcp-approvals.mjs'
import { run } from '../src/cli.mjs'
import { applyMcpConfiguration, mcpClientState, mcpConfigurationPlan, mcpConfigurationStatus, READ_ONLY_TOOLS } from '../src/mcp-config.mjs'
import { detectMcpClients } from '../src/mcp-detect.mjs'
import { mcpPlatformSupport } from '../src/mcp-verification.mjs'
import { startWebServer } from '../src/web-server.mjs'

// Session-start hook support is pinned to the Linux record (test-only, honoured under node --test) so the hook and
// approvals share .claude/settings.local.json on every platform; Windows hook behaviour has its own test.
process.env.HOLOSELF_TEST_PLATFORM = 'linux'
const SETTINGS = '.claude/settings.local.json'
// Windows resolves executables through PATHEXT, so fake binaries need an extension there.
const EXE = process.platform === 'win32' ? '.exe' : ''
const json = text => JSON.parse(text)
const read = (project, rel) => readFileSync(join(project, rel), 'utf8')
const sha = text => createHash('sha256').update(text).digest('hex')
const pretty = value => JSON.stringify(value, null, 2) + '\n'

async function capture(fn) {
  const log = console.log
  let out = ''
  console.log = (...items) => {
    out += items.join(' ') + '\n'
  }
  try {
    await fn()
  } finally {
    console.log = log
  }
  return out
}
function fixture(dirs = []) {
  const base = mkdtempSync(join(tmpdir(), 'holoself-mcp-default-')),
    self = join(base, 'self'),
    project = join(base, 'project')
  mkdirSync(project, { recursive: true })
  for (const dir of dirs) mkdirSync(join(project, dir), { recursive: true })
  return { base, self, project, cleanup: () => rmSync(base, { recursive: true, force: true }) }
}
async function linked(dirs = []) {
  const fx = fixture(dirs)
  await capture(() => run(['init', '--root', fx.self]))
  await capture(() => run(['link', 'add', '--project', fx.project, '--self', fx.self, '--no-activate', '--yes']))
  return fx
}
function fakeBin(base, names) {
  const dir = join(base, 'bin')
  mkdirSync(dir, { recursive: true })
  for (const name of names) {
    writeFileSync(join(dir, name + EXE), '#!/bin/sh\nexit 0\n')
    chmodSync(join(dir, name + EXE), 0o755)
  }
  return { PATH: dir, ...(process.platform === 'win32' ? { PATHEXT: '.EXE' } : {}) }
}
async function withPath(env, fn) {
  const previous = { PATH: process.env.PATH, PATHEXT: process.env.PATHEXT }
  process.env.PATH = env.PATH
  if (env.PATHEXT) process.env.PATHEXT = env.PATHEXT
  try {
    return await fn()
  } finally {
    process.env.PATH = previous.PATH
    if (previous.PATHEXT === undefined) delete process.env.PATHEXT
    else process.env.PATHEXT = previous.PATHEXT
  }
}

test('MCP client detection uses PATH executables and project configuration only', async () => {
  const fx = fixture(['.claude'])
  try {
    const env = fakeBin(fx.base, ['codex']),
      found = Object.fromEntries(detectMcpClients(fx.project, { env }).map(item => [item.platform, item]))
    assert.deepEqual(found.codex.detected_by, ['path'])
    assert.equal(found.codex.executable, join(env.PATH, 'codex' + EXE))
    assert.deepEqual(found.claude.detected_by, ['project'])
    assert.deepEqual(found.claude.project_evidence, ['.claude'])
    assert.equal(found.agy.detected, false)
    writeFileSync(join(fx.project, 'AGY.md'), '# agy\n')
    assert.equal(detectMcpClients(fx.project, { env: { PATH: '' } }).find(item => item.platform === 'agy').detected, true)
  } finally {
    fx.cleanup()
  }
})

test('mcp configure --all-detected: dry-run output equals what apply writes', async () => {
  const fx = await linked(['.claude'])
  try {
    const env = fakeBin(fx.base, ['codex'])
    const dry = json(await withPath(env, () => capture(() => run(['mcp', 'configure', '--project', fx.project, '--all-detected', '--dry-run'])))).configuration_plan
    assert.deepEqual(dry.changes.map(change => change.platform), ['codex', 'claude'])
    assert.ok(dry.detection.find(item => item.platform === 'agy').detected === false)
    assert.equal(existsSync(join(fx.project, '.mcp.json')), false)
    const out = await withPath(env, () => capture(() => run(['mcp', 'configure', '--project', fx.project, '--all-detected', '--yes'])))
    const applied = json(out.slice(out.indexOf('\n}\n') + 3))
    assert.deepEqual(
      applied.changes.map(({ result, ...change }) => change),
      dry.changes
    )
    assert.equal(applied.plan_sha256, dry.plan_sha256)
    for (const change of dry.changes) assert.equal(sha(read(fx.project, change.relative)), change.sha256, change.relative)
    assert.equal(existsSync(join(fx.project, '.agents', 'mcp_config.json')), false)
    // Nothing detected: the plan is empty and nothing is written.
    const empty = fixture()
    try {
      await capture(() => run(['init', '--root', empty.self]))
      await capture(() => run(['link', 'add', '--project', empty.project, '--self', empty.self, '--no-activate', '--yes']))
      const plan = mcpConfigurationPlan(empty.project, { allDetected: true, env: { PATH: '' } })
      assert.deepEqual(plan.changes, [])
    } finally {
      empty.cleanup()
    }
  } finally {
    fx.cleanup()
  }
})

test('mcp configure --all-detected is all-or-nothing and refuses divergent entries without consent', async () => {
  const fx = await linked(['.claude', '.codex'])
  try {
    const env = fakeBin(fx.base, ['agy']),
      original = '# user config\nmodel = "example"\n'
    writeFileSync(join(fx.project, '.codex', 'config.toml'), original)
    let writes = 0
    assert.throws(
      () =>
        applyMcpConfiguration(
          fx.project,
          { allDetected: true, env },
          {
            write(path, content) {
              if (++writes === 3) throw new Error('injected third write failure')
              mkdirSync(join(path, '..'), { recursive: true })
              writeFileSync(path, content)
            }
          }
        ),
      /injected third write failure/
    )
    assert.equal(read(fx.project, '.codex/config.toml'), original)
    assert.equal(existsSync(join(fx.project, '.agents', 'mcp_config.json')), false)
    assert.equal(existsSync(join(fx.project, '.mcp.json')), false)

    const foreign = pretty({ mcpServers: { holoself: { command: 'someone-else' }, other: { command: 'other' } } })
    writeFileSync(join(fx.project, '.mcp.json'), foreign)
    assert.throws(() => mcpConfigurationPlan(fx.project, { allDetected: true, env }), /refusing to overwrite/)
    await assert.rejects(
      withPath(env, () => capture(() => run(['mcp', 'configure', '--project', fx.project, '--all-detected', '--yes']))),
      /refusing to overwrite/
    )
    assert.equal(read(fx.project, '.mcp.json'), foreign)
    assert.equal(read(fx.project, '.codex/config.toml'), original)
    // --force-replace still needs explicit confirmation outside a terminal.
    await assert.rejects(
      withPath(env, () => capture(() => run(['mcp', 'configure', '--project', fx.project, '--all-detected', '--force-replace']))),
      /re-run with --yes/i
    )
    assert.equal(read(fx.project, '.mcp.json'), foreign)
    const dry = json(
      await withPath(env, () => capture(() => run(['mcp', 'configure', '--project', fx.project, '--all-detected', '--force-replace', '--dry-run'])))
    ).configuration_plan
    assert.equal(dry.changes.find(change => change.platform === 'claude').action, 'replace')
    assert.doesNotMatch(JSON.stringify(dry), /someone-else/)
    await withPath(env, () => capture(() => run(['mcp', 'configure', '--project', fx.project, '--all-detected', '--force-replace', '--yes'])))
    const replaced = json(read(fx.project, '.mcp.json')).mcpServers
    assert.equal(replaced.holoself.command, 'holoself')
    assert.deepEqual(replaced.other, { command: 'other' })
    // A plain [mcp_servers.holoself] table is replaceable; a dotted inline form is refused even with --force-replace.
    writeFileSync(join(fx.project, '.codex', 'config.toml'), original + '\n[mcp_servers.holoself]\ncommand = "other"\n\n[profile]\nx = 1\n')
    applyMcpConfiguration(fx.project, { platforms: ['codex'], forceReplace: true })
    const toml = read(fx.project, '.codex/config.toml')
    assert.doesNotMatch(toml, /command = "other"/)
    assert.match(toml, /\[profile\]\nx = 1/)
    assert.match(toml, /holoself-mcp-managed-start/)
    writeFileSync(join(fx.project, '.codex', 'config.toml'), 'mcp_servers.holoself = { command = "other" }\n')
    assert.throws(() => mcpConfigurationPlan(fx.project, { platforms: ['codex'], forceReplace: true }), /cannot replace safely/)
  } finally {
    fx.cleanup()
  }
})

test('link activation configures MCP by default only for verified, activated hosts', async () => {
  const unverified = mcpPlatformSupport().map(item => (item.platform === 'agy' ? { ...item, support: 'configured' } : item))
  const auto = mcpActivationEntries(['agents', 'claude', 'agy', 'pi'], 'auto', false, unverified)
  assert.deepEqual(
    auto.map(entry => [entry.adapter, entry.install]),
    [
      ['claude', true],
      ['agy', false]
    ]
  )
  assert.ok(mcpActivationEntries(['agy'], 'on', false, unverified)[0].install)
  assert.ok(mcpActivationEntries(['claude'], 'off', true).every(entry => !entry.install && !entry.approve_read_tools))

  const fx = await linked(['.claude'])
  try {
    const out = await capture(() => run(['link', 'activate', '--project', fx.project, '--platform', 'claude,pi', '--yes']))
    assert.match(out, /"mcp_policy": "auto"/)
    assert.match(out, /"mcp_fallback"/)
    assert.match(out, /claude: \.mcp\.json MCP server \(create\)/)
    assert.equal(json(read(fx.project, '.mcp.json')).mcpServers.holoself.command, 'holoself')
    assert.equal(existsSync(join(fx.project, '.agents', 'mcp_config.json')), false)
    const runtime = readRuntime(fx.project)
    assert.equal(runtime.mcpPolicy, 'auto')
    assert.equal(runtime.mcpApproveReadTools, false)
    assert.deepEqual(
      runtime.mcpInstallations.map(item => [item.id, item.createdFile, item.approval]),
      [['claude', true, null]]
    )
    assert.ok(!existsSync(join(fx.project, SETTINGS)) || !json(read(fx.project, SETTINGS)).permissions, 'read tools are never pre-approved by default')
    // --no-mcp removes the recorded entry and records the choice; repair keeps it.
    await capture(() => run(['link', 'activate', '--project', fx.project, '--platform', 'claude,pi', '--no-mcp', '--yes']))
    assert.equal(existsSync(join(fx.project, '.mcp.json')), false)
    assert.equal(readRuntime(fx.project).mcpPolicy, 'off')
    await capture(() => run(['link', 'repair', '--project', fx.project, '--yes']))
    assert.equal(existsSync(join(fx.project, '.mcp.json')), false)
    // --mcp turns it back on; repair restores a deleted entry from runtime.json.
    await capture(() => run(['link', 'activate', '--project', fx.project, '--platform', 'claude', '--mcp', '--yes']))
    rmSync(join(fx.project, '.mcp.json'))
    await capture(() => run(['link', 'repair', '--project', fx.project, '--yes']))
    assert.equal(json(read(fx.project, '.mcp.json')).mcpServers.holoself.command, 'holoself')
    assert.equal(readRuntime(fx.project).mcpPolicy, 'on')
  } finally {
    fx.cleanup()
  }
})

test('link setup defaults to MCP for detected verified hosts and --no-mcp opts out', async () => {
  for (const [flags, expected] of [
    [[], true],
    [['--no-mcp'], false]
  ]) {
    const fx = fixture(['.claude', '.codex'])
    try {
      await capture(() => run(['init', '--root', fx.self]))
      await capture(() => run(['link', 'setup', '--project', fx.project, '--self', fx.self, ...flags, '--yes']))
      assert.equal(existsSync(join(fx.project, '.mcp.json')), expected)
      assert.equal(existsSync(join(fx.project, '.codex', 'config.toml')), expected)
      assert.equal(existsSync(join(fx.project, '.agents', 'mcp_config.json')), false, 'AGY is not detected for this project')
    } finally {
      fx.cleanup()
    }
  }
})

test('a divergent holoself entry is skipped by the default and fatal with --mcp', async () => {
  const fx = await linked(['.claude'])
  try {
    const foreign = pretty({ mcpServers: { holoself: { command: 'mine' } } })
    writeFileSync(join(fx.project, '.mcp.json'), foreign)
    const out = await capture(() => run(['link', 'activate', '--project', fx.project, '--platform', 'claude', '--yes']))
    assert.match(out, /"action": "skipped"/)
    assert.match(out, /--force-replace/)
    assert.equal(read(fx.project, '.mcp.json'), foreign)
    assert.deepEqual(readRuntime(fx.project).mcpInstallations, [])
    await assert.rejects(capture(() => run(['link', 'activate', '--project', fx.project, '--platform', 'claude', '--mcp', '--yes'])), /refusing to overwrite/)
    assert.equal(read(fx.project, '.mcp.json'), foreign)
  } finally {
    fx.cleanup()
  }
})

test('read-tool pre-approval is opt-in, excludes proposal_create, and deactivation removes only owned entries', async () => {
  assert.ok(!READ_ONLY_TOOLS.includes('holoself_proposal_create'))
  assert.equal(READ_ONLY_TOOLS.length, 6)
  assert.ok(claudeReadToolRules().every(rule => !rule.includes('proposal_create')))
  assert.equal(readApprovalMechanism('agy').mechanism, 'documented-only')
  assert.doesNotMatch(readApprovalMechanism('agy').example, /proposal_create/)

  const fx = await linked(['.claude', '.codex'])
  try {
    const mcpOriginal = pretty({ mcpServers: { other: { command: 'other-server' } } }),
      settingsOriginal = pretty({ permissions: { allow: ['Bash(ls)', 'mcp__holoself__holoself_status'] }, env: { EXAMPLE: '1' } }),
      codexOriginal = '# user-owned\nmodel = "example"\n'
    writeFileSync(join(fx.project, '.mcp.json'), mcpOriginal)
    writeFileSync(join(fx.project, SETTINGS), settingsOriginal)
    writeFileSync(join(fx.project, '.codex', 'config.toml'), codexOriginal)
    await capture(() => run(['link', 'activate', '--project', fx.project, '--platform', 'claude,codex', '--approve-read-tools', '--yes']))
    const settings = json(read(fx.project, SETTINGS))
    assert.deepEqual(settings.permissions.allow, ['Bash(ls)', 'mcp__holoself__holoself_status', ...claudeReadToolRules().slice(1)])
    assert.ok(settings.hooks?.SessionStart?.length, 'the session-start hook shares the file')
    assert.doesNotMatch(read(fx.project, SETTINGS), /proposal_create/)
    const toml = read(fx.project, '.codex/config.toml')
    for (const tool of READ_ONLY_TOOLS) assert.match(toml, new RegExp(`\\[mcp_servers\\.holoself\\.tools\\.${tool}\\]\\napproval_mode = "approve"`))
    assert.doesNotMatch(toml, /tools\.holoself_proposal_create/)
    const runtime = readRuntime(fx.project)
    assert.equal(runtime.mcpApproveReadTools, true)
    const claude = runtime.mcpInstallations.find(item => item.id === 'claude')
    assert.deepEqual(claude.approval.added, claudeReadToolRules().slice(1), 'a pre-existing rule is not claimed')
    assert.equal(claude.createdFile, false)
    // mcp status agrees with the recorded Codex approvals (no drift).
    assert.equal(mcpConfigurationStatus(fx.project, { env: { PATH: '' } }).platforms.find(item => item.platform === 'codex').entry, 'present')
    // Repair keeps the recorded opt-in.
    await capture(() => run(['link', 'repair', '--project', fx.project, '--yes']))
    assert.equal(readRuntime(fx.project).mcpApproveReadTools, true)
    // Opting out removes only the added rules and the Codex approval tables; opting in again restores them.
    await capture(() => run(['link', 'repair', '--project', fx.project, '--no-approve-read-tools', '--yes']))
    assert.deepEqual(json(read(fx.project, SETTINGS)).permissions.allow, ['Bash(ls)', 'mcp__holoself__holoself_status'])
    assert.doesNotMatch(read(fx.project, '.codex/config.toml'), /approval_mode = "approve"/)
    assert.equal(readRuntime(fx.project).mcpApproveReadTools, false)
    await capture(() => run(['link', 'repair', '--project', fx.project, '--approve-read-tools', '--yes']))
    const dry = await capture(() => run(['link', 'deactivate', '--project', fx.project, '--dry-run']))
    assert.match(dry, /\.mcp\.json: mcp-remove/)
    assert.match(dry, /settings\.local\.json: approval-remove/)
    await capture(() => run(['link', 'deactivate', '--project', fx.project, '--yes']))
    assert.equal(read(fx.project, '.mcp.json'), mcpOriginal)
    assert.equal(read(fx.project, SETTINGS), settingsOriginal)
    assert.equal(read(fx.project, '.codex/config.toml'), codexOriginal)
  } finally {
    fx.cleanup()
  }
})

test('files created for MCP and approvals are removed again, and scoped deactivation leaves other hosts', async () => {
  const fx = await linked(['.claude', '.codex'])
  try {
    await capture(() => run(['link', 'activate', '--project', fx.project, '--platform', 'claude,codex', '--approve-read-tools', '--yes']))
    assert.ok(existsSync(join(fx.project, SETTINGS)))
    await capture(() => run(['link', 'repair', '--project', fx.project, '--yes']))
    assert.deepEqual(readRuntime(fx.project).mcpInstallations.find(item => item.id === 'claude').createdContainers, ['mcpServers'])
    await capture(() => run(['link', 'deactivate', '--project', fx.project, '--adapters', 'codex', '--yes']))
    assert.equal(existsSync(join(fx.project, '.codex', 'config.toml')), false)
    assert.ok(existsSync(join(fx.project, '.codex')), 'a directory that existed before is kept')
    assert.ok(existsSync(join(fx.project, '.mcp.json')))
    assert.deepEqual(
      readRuntime(fx.project).mcpInstallations.map(item => item.id),
      ['claude']
    )
    await capture(() => run(['link', 'deactivate', '--project', fx.project, '--yes']))
    assert.equal(existsSync(join(fx.project, '.mcp.json')), false)
    assert.equal(existsSync(join(fx.project, SETTINGS)), false, 'hook and approvals both gone, file Holoself created removed')
  } finally {
    fx.cleanup()
  }
})

test('MCP activation fails closed on symlinked configuration and rolls back', async () => {
  const fx = await linked(['.claude'])
  try {
    const outside = join(fx.base, 'outside.json')
    writeFileSync(outside, '{}\n')
    symlinkSync(outside, join(fx.project, '.mcp.json'))
    await assert.rejects(capture(() => run(['link', 'activate', '--project', fx.project, '--platform', 'claude', '--yes'])), /traverses a symlink|not a safe regular file/)
    assert.equal(readFileSync(outside, 'utf8'), '{}\n')
    rmSync(join(fx.project, '.mcp.json'))
    // A failure after the MCP writes restores every file and leaves no runtime record.
    const { activateProject } = await import('../src/adapters.mjs'),
      { readLink } = await import('../src/link/config.mjs')
    assert.throws(
      () =>
        activateProject(fx.project, readLink(fx.project), {
          platforms: ['claude'],
          afterMcp() {
            throw new Error('injected after MCP')
          }
        }),
      /injected after MCP/
    )
    assert.equal(existsSync(join(fx.project, '.mcp.json')), false)
    assert.equal(existsSync(join(fx.project, '.holoself', 'runtime.json')), false)
  } finally {
    fx.cleanup()
  }
})

test('client states: not detected, detected, configured, verified, failing', () => {
  assert.equal(mcpClientState({ detected: false, entry: 'missing', linkHealthy: true, support: 'verified' }), 'not-detected')
  assert.equal(mcpClientState({ detected: true, entry: 'missing', linkHealthy: true, support: 'verified' }), 'detected')
  assert.equal(mcpClientState({ detected: true, entry: 'present', linkHealthy: true, support: 'configured' }), 'configured')
  assert.equal(mcpClientState({ detected: false, entry: 'present', linkHealthy: true, support: 'verified' }), 'verified')
  assert.equal(mcpClientState({ detected: true, entry: 'present', linkHealthy: false, support: 'verified' }), 'failing')
  for (const entry of ['divergent', 'drifted', 'error']) assert.equal(mcpClientState({ detected: true, entry, linkHealthy: true, support: 'verified' }), 'failing')
})

test('Workbench reports per-client MCP state behind the session token', async () => {
  const fx = await linked(['.claude', '.codex'])
  const previous = process.env.PATH
  process.env.PATH = ''
  let app
  try {
    applyMcpConfiguration(fx.project, { platforms: ['claude'] })
    writeFileSync(join(fx.project, '.codex', 'config.toml'), '[mcp_servers.holoself]\ncommand = "secret-other"\n')
    app = await startWebServer({ project: fx.project, port: 0 })
    const origin = new URL(app.url).origin
    assert.equal((await fetch(`${app.url}/api/mcp/clients`)).status, 403)
    const response = await fetch(`${app.url}/api/mcp/clients`, { headers: { 'x-holoself-token': app.token, origin } }),
      text = await response.text()
    assert.equal(response.status, 200)
    const [space] = json(text).data,
      states = Object.fromEntries(space.clients.map(item => [item.platform, item.state]))
    assert.equal(space.linked, true)
    assert.deepEqual(states, { codex: 'failing', agy: 'not-detected', claude: 'verified' })
    assert.doesNotMatch(text, /secret-other|refusing|config\.toml has/)
    assert.equal((await fetch(`${app.url}/api/mcp/clients`, { method: 'POST', headers: { 'x-holoself-token': app.token, origin } })).status, 404)
  } finally {
    process.env.PATH = previous
    if (app) await new Promise(resolve => app.server.close(resolve))
    fx.cleanup()
  }
})

test('Codex --force-replace with an existing managed block leaves exactly one well-formed block', async () => {
  const fx = await linked(['.codex'])
  try {
    const path = join(fx.project, '.codex', 'config.toml')
    applyMcpConfiguration(fx.project, { platforms: ['codex'] })
    const managed = read(fx.project, '.codex/config.toml')
    for (const [label, text] of [
      ['after', `model = "m"\n\n${managed}\n[mcp_servers.holoself]\ncommand = "other"\n\n[profile]\nx = 1\n`],
      ['before', `model = "m"\n\n[mcp_servers.holoself]\ncommand = "other"\n\n${managed}\n[profile]\nx = 1\n`]
    ]) {
      writeFileSync(path, text)
      applyMcpConfiguration(fx.project, { platforms: ['codex'], forceReplace: true })
      const result = read(fx.project, '.codex/config.toml')
      assert.equal(result.split('# holoself-mcp-managed-start').length, 2, label)
      assert.equal(result.split('# holoself-mcp-managed-end').length, 2, label)
      assert.doesNotMatch(result, /command = "other"/, label)
      assert.match(result, /\[profile\]\nx = 1/, label)
      assert.match(result, /^model = "m"/, label)
      // Later operations still work.
      assert.equal(mcpConfigurationPlan(fx.project, { platforms: ['codex'] }).changes[0].action, 'unchanged', label)
    }
  } finally {
    fx.cleanup()
  }
})

test('Codex --force-replace refuses multi-line values instead of writing invalid TOML', async () => {
  const fx = await linked(['.codex'])
  try {
    const path = join(fx.project, '.codex', 'config.toml')
    for (const text of [
      '[mcp_servers.holoself]\ncommand = "other"\nargs = [\n  "a",\n  ["nested"],\n]\n\n[profile]\nx = 1\n',
      '[mcp_servers.holoself]\ncommand = """\nother\n"""\n'
    ]) {
      writeFileSync(path, text)
      assert.throws(() => mcpConfigurationPlan(fx.project, { platforms: ['codex'], forceReplace: true }), /--force-replace refused/)
      assert.equal(read(fx.project, '.codex/config.toml'), text)
    }
    // A multi-line array in another table is fine, and a `[`-line inside it is not mistaken for a header.
    writeFileSync(path, '[profile]\nlist = [\n  [1],\n]\n\n[mcp_servers.holoself]\ncommand = "other"\n')
    applyMcpConfiguration(fx.project, { platforms: ['codex'], forceReplace: true })
    const result = read(fx.project, '.codex/config.toml')
    assert.match(result, /list = \[\n {2}\[1\],\n\]/)
    assert.doesNotMatch(result, /command = "other"/)
  } finally {
    fx.cleanup()
  }
})

test('JSON parse errors report the line, never file content', async () => {
  const fx = await linked(['.claude'])
  try {
    const secret = 'sk-SECRET-1234567890'
    writeFileSync(join(fx.project, '.mcp.json'), `{\n  "mcpServers": {\n    "x": { "env": { "KEY": ${secret} } }\n  }\n}\n`)
    let message = ''
    try {
      mcpConfigurationPlan(fx.project, { platforms: ['claude'] })
    } catch (error) {
      message = error.message
    }
    assert.match(message, /invalid JSON( at line 3)?$/)
    assert.doesNotMatch(message, /SECRET|sk-/)
    const status = mcpConfigurationStatus(fx.project, { env: { PATH: '' } }).platforms.find(item => item.platform === 'claude')
    assert.equal(status.client_state, 'failing')
    assert.doesNotMatch(JSON.stringify(status), /SECRET/)
    await assert.rejects(capture(() => run(['link', 'activate', '--project', fx.project, '--platform', 'claude', '--yes'])), error => {
      assert.doesNotMatch(error.message, /SECRET/)
      return /invalid JSON/.test(error.message)
    })
    rmSync(join(fx.project, '.mcp.json'))
    mkdirSync(join(fx.project, '.claude'), { recursive: true })
    writeFileSync(join(fx.project, SETTINGS), `{ "permissions": ${secret} }\n`)
    await assert.rejects(capture(() => run(['link', 'activate', '--project', fx.project, '--platform', 'claude', '--approve-read-tools', '--yes'])), error => {
      assert.doesNotMatch(error.message, /SECRET/)
      return /invalid JSON/.test(error.message)
    })
  } finally {
    fx.cleanup()
  }
})

test('the project path is escaped as a TOML basic string', async () => {
  if (process.platform === 'win32') return // control characters are not valid in Windows file names
  const fx = fixture()
  try {
    const odd = join(fx.base, 'pro"ject\tname\nwith\u0001ctl')
    mkdirSync(odd, { recursive: true })
    await capture(() => run(['init', '--root', fx.self]))
    await capture(() => run(['link', 'add', '--project', odd, '--self', fx.self, '--no-activate', '--yes']))
    const block = mcpConfigurationPlan(odd, { platforms: ['codex'] }).changes[0].managed_block,
      line = block.split('\n').find(item => item.startsWith('args = '))
    assert.ok(line.includes('pro\\"ject\\tname\\nwith\\u0001ctl"]'), line)
    assert.doesNotMatch(line, /[\u0000-\u001f]/)
  } finally {
    fx.cleanup()
  }
})

test('directories Holoself created are removed when rollback or removal leaves them empty', async () => {
  const fx = await linked()
  try {
    let writes = 0
    assert.throws(
      () =>
        applyMcpConfiguration(
          fx.project,
          { platforms: ['codex', 'agy'] },
          {
            write(path, content) {
              mkdirSync(join(path, '..'), { recursive: true })
              if (++writes === 2) throw new Error('injected second write failure')
              writeFileSync(path, content)
            }
          }
        ),
      /injected second write failure/
    )
    assert.equal(existsSync(join(fx.project, '.codex')), false)
    assert.equal(existsSync(join(fx.project, '.agents')), false)
    // Activation rollback.
    const { activateProject } = await import('../src/adapters.mjs'),
      { readLink } = await import('../src/link/config.mjs')
    assert.throws(
      () =>
        activateProject(fx.project, readLink(fx.project), {
          platforms: ['codex'],
          mcp: 'on',
          installSkill: 'none',
          afterMcp() {
            throw new Error('injected after MCP')
          }
        }),
      /injected after MCP/
    )
    assert.equal(existsSync(join(fx.project, '.codex')), false)
    // Deactivation removes the recorded directory once it is empty, and keeps it otherwise.
    await capture(() => run(['link', 'activate', '--project', fx.project, '--platform', 'codex', '--install-skill', 'none', '--yes']))
    assert.deepEqual(readRuntime(fx.project).mcpInstallations[0].createdDirs, ['.codex'])
    await capture(() => run(['link', 'deactivate', '--project', fx.project, '--yes']))
    assert.equal(existsSync(join(fx.project, '.codex')), false)
    await capture(() => run(['link', 'activate', '--project', fx.project, '--platform', 'codex', '--install-skill', 'none', '--yes']))
    writeFileSync(join(fx.project, '.codex', 'notes.txt'), 'mine\n')
    await capture(() => run(['link', 'deactivate', '--project', fx.project, '--yes']))
    assert.equal(read(fx.project, '.codex/notes.txt'), 'mine\n')
  } finally {
    fx.cleanup()
  }
})

test('Windows detection resolves executables through PATHEXT', () => {
  const fx = fixture()
  try {
    const dir = join(fx.base, 'winbin')
    mkdirSync(dir)
    writeFileSync(join(dir, 'codex.exe'), '')
    writeFileSync(join(dir, 'agy'), '')
    const found = Object.fromEntries(detectMcpClients(fx.project, { env: { PATH: dir, PATHEXT: '.EXE;.CMD' }, platform: 'win32' }).map(item => [item.platform, item]))
    assert.equal(found.codex.executable, join(dir, 'codex.exe'))
    assert.equal(found.agy.detected, false, 'an extensionless file is not a Windows executable')
  } finally {
    fx.cleanup()
  }
})
