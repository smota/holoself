import './helpers/isolated-config.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { activateProject, readRuntime } from '../src/adapters.mjs'
import { HOOK_HOSTS, hookSupport, isCodexHookTrusted } from '../src/adapters/hooks.mjs'
import { run } from '../src/cli.mjs'
import { parseArguments } from '../src/cli/args.mjs'
import { readLink } from '../src/link/config.mjs'
import { applyMcpConfiguration } from '../src/mcp-config.mjs'
import { appendAuditLine } from '../src/shared/audit-log.mjs'

const BIN = fileURLToPath(new URL('../bin/holoself.mjs', import.meta.url))
const SETTINGS = '.claude/settings.local.json'
// Foreign settings in canonical 2-space JSON: a foreign SessionStart hook, another event, and unrelated keys.
const FOREIGN =
  JSON.stringify(
    {
      permissions: { allow: ['Bash(ls)'] },
      env: { EXAMPLE: '1' },
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'echo foreign-start' }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo foreign-pre' }] }]
      }
    },
    null,
    2
  ) + '\n'

async function capture(fn) {
  const old = console.log
  let out = ''
  console.log = (...x) => {
    out += x.join(' ') + '\n'
  }
  try {
    await fn()
  } finally {
    console.log = old
  }
  return out
}
async function fixture({ settings = FOREIGN, claudeDir = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'holoself-hooks-')),
    self = join(base, 'self'),
    project = join(base, 'project')
  mkdirSync(project)
  await capture(() => run(['init', '--root', self]))
  writeFileSync(join(self, 'profile', 'identity.md'), '---\nvisibility: linked-projects\n---\n# Identity\n\nSynthetic marker HOOK-SENTINEL-7.\n')
  if (claudeDir) mkdirSync(join(project, '.claude'))
  if (settings !== null) writeFileSync(join(project, SETTINGS), settings)
  await capture(() => run(['link', 'add', '--project', project, '--self', self, '--lens', 'general', '--no-activate', '--yes']))
  return { base, self, project, settings: join(project, SETTINGS) }
}
const json = text => JSON.parse(text)
const sessionStart = file => json(readFileSync(file, 'utf8')).hooks?.SessionStart || []
const owned = file => sessionStart(file).filter(group => group.hooks.some(hook => hook.command.includes('--hook holoself-session-start')))
const runBin = (args, env = {}) =>
  spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { ...process.env, HOLOSELF_ERROR_FORMAT: '', ...env } })

test('Claude Code SessionStart hook is verified in the matrix and uses no absolute path', () => {
  assert.equal(hookSupport('claude', undefined, 'linux').support, 'verified')
  assert.equal(hookSupport('claude', undefined, 'win32').support, 'unverified', 'Windows stays unverified without a Windows record')
  // Test-only platform override: honoured under node --test, ignored in a product process.
  const saved = process.env.HOLOSELF_TEST_PLATFORM
  try {
    process.env.HOLOSELF_TEST_PLATFORM = 'win32'
    assert.equal(hookSupport('claude').support, process.env.NODE_TEST_CONTEXT ? 'unverified' : hookSupport('claude', undefined, process.platform).support)
  } finally {
    if (saved === undefined) delete process.env.HOLOSELF_TEST_PLATFORM
    else process.env.HOLOSELF_TEST_PLATFORM = saved
  }
  const { NODE_TEST_CONTEXT, ...productEnv } = process.env
  const product = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `import { hookSupport } from ${JSON.stringify(new URL('../src/adapters/hooks.mjs', import.meta.url).href)}; console.log(hookSupport('claude').support)`],
    { encoding: 'utf8', env: { ...productEnv, HOLOSELF_TEST_PLATFORM: process.platform === 'win32' ? 'linux' : 'win32' } }
  )
  assert.equal(product.stdout.trim(), hookSupport('claude', undefined, process.platform).support, 'override ignored outside node --test')
  assert.equal(hookSupport('codex').support, 'unverified')
  assert.equal(hookSupport('agy').support, 'unverified')
  assert.equal(hookSupport('cursor').support, 'unsupported')
  for (const [id, expected] of [
    ['claude', 'holoself context --session-start --budget small --format packet --hook holoself-session-start'],
    ['codex', 'holoself context --session-start --budget small --format packet --hook holoself-session-start'],
    ['agy', 'holoself context --session-start --budget small --format packet --hook holoself-session-start --hook-format agy-json']
  ]) {
    assert.equal(HOOK_HOSTS[id].command, expected)
    assert.doesNotMatch(HOOK_HOSTS[id].command, /[$"'%]/, `${id}: no shell expansion or quoting`)
  }
})

test('activate installs one owned hook, deactivate restores foreign settings byte-for-byte, repair restores it', async () => {
  const { base, project, settings } = await fixture()
  try {
    await capture(() => run(['link', 'activate', '--project', project, '--hooks', '--yes']))
    const installed = readFileSync(settings, 'utf8')
    assert.equal(owned(settings).length, 1)
    assert.equal(sessionStart(settings)[0].hooks[0].command, 'echo foreign-start')
    assert.deepEqual(json(installed).permissions, { allow: ['Bash(ls)'] })
    assert.deepEqual(json(installed).hooks.PreToolUse, json(FOREIGN).hooks.PreToolUse)
    const runtime = readRuntime(project)
    assert.equal(runtime.hookPolicy, 'on')
    assert.deepEqual(
      runtime.hookInstallations.map(x => [x.id, x.file, x.event, x.createdFile]),
      [['claude', SETTINGS, 'SessionStart', false]]
    )
    // Idempotent: a second activation leaves the file untouched.
    await capture(() => run(['link', 'activate', '--project', project, '--hooks', '--yes']))
    assert.equal(readFileSync(settings, 'utf8'), installed)
    const status = json(await capture(() => run(['link', 'status', '--project', project])))
    assert.deepEqual(
      status.session_start_hooks.map(x => [x.id, x.state, x.support]),
      [['claude', 'installed', process.platform === 'win32' ? 'unverified' : 'verified']]
    )
    // Dry-run deactivation previews the removal without writing.
    const preview = await capture(() => run(['link', 'deactivate', '--project', project, '--dry-run']))
    assert.match(preview, /\.claude\/settings\.local\.json: hook-remove/)
    assert.equal(readFileSync(settings, 'utf8'), installed)
    await capture(() => run(['link', 'deactivate', '--project', project, '--yes']))
    assert.equal(readFileSync(settings, 'utf8'), FOREIGN)
    // Repair after a scoped removal restores the recorded hook.
    await capture(() => run(['link', 'activate', '--project', project, '--hooks', '--yes']))
    writeFileSync(settings, FOREIGN)
    assert.match(json(await capture(() => run(['link', 'doctor', '--project', project]).catch(() => {}))).checks.session_start_hook, /missing/)
    process.exitCode = 0
    await capture(() => run(['link', 'repair', '--project', project, '--yes']))
    assert.equal(readFileSync(settings, 'utf8'), installed)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('activation dry-run previews the hook and writes nothing', async () => {
  const { base, project, settings } = await fixture()
  try {
    const out = await capture(() => run(['link', 'activate', '--project', project, '--hooks', '--dry-run', '--yes']))
    assert.match(out, /"session_start_hooks"/)
    assert.match(out, /"action": "update"/)
    assert.equal(readFileSync(settings, 'utf8'), FOREIGN)
    assert.equal(existsSync(join(project, 'CLAUDE.md')), false)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('a settings file Holoself created is removed again; scoped deactivation drops only the claude hook', async () => {
  const { base, project, settings } = await fixture({ settings: null })
  try {
    await capture(() => run(['link', 'activate', '--project', project, '--hooks', '--yes']))
    assert.equal(owned(settings).length, 1)
    assert.equal(readRuntime(project).hookInstallations[0].createdFile, true)
    const out = await capture(() => run(['link', 'deactivate', '--project', project, '--adapters', 'claude', '--yes']))
    assert.match(out, /claude: \.claude\/settings\.local\.json: hook-delete/)
    assert.equal(existsSync(settings), false)
    const runtime = readRuntime(project)
    assert.deepEqual(runtime.hookInstallations, [])
    assert.deepEqual(
      runtime.activatedAdapters.map(x => x.id),
      ['agents']
    )
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('--no-hooks skips or removes the hook and records the choice; status reports drift', async () => {
  const { base, project, settings } = await fixture()
  try {
    await capture(() => run(['link', 'activate', '--project', project, '--no-hooks', '--yes']))
    assert.equal(readFileSync(settings, 'utf8'), FOREIGN)
    assert.equal(readRuntime(project).hookPolicy, 'off')
    let status = json(await capture(() => run(['link', 'status', '--project', project])))
    assert.equal(status.session_start_hooks[0].state, 'disabled')
    // Repair keeps the recorded choice.
    await capture(() => run(['link', 'repair', '--project', project, '--yes']))
    assert.equal(readFileSync(settings, 'utf8'), FOREIGN)
    await capture(() => run(['link', 'activate', '--project', project, '--hooks', '--yes']))
    assert.equal(owned(settings).length, 1)
    const drifted = readFileSync(settings, 'utf8').replace('--budget small', '--budget deep')
    writeFileSync(settings, drifted)
    status = json(await capture(() => run(['link', 'status', '--project', project])))
    process.exitCode = 0
    assert.equal(status.session_start_hooks[0].state, 'drifted')
    assert.ok(status.errors.some(x => x.includes('session-start hook drifted')))
    await capture(() => run(['link', 'activate', '--project', project, '--no-hooks', '--yes']))
    assert.equal(readFileSync(settings, 'utf8'), FOREIGN)
    await assert.rejects(run(['link', 'activate', '--project', project, '--hooks', '--no-hooks', '--yes']), /cannot be combined/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('symlinked, invalid, and mixed hook settings are refused before any write', async () => {
  const { base, project, settings } = await fixture({ settings: null })
  try {
    const outside = join(base, 'outside.json')
    writeFileSync(outside, FOREIGN)
    symlinkSync(outside, settings)
    await assert.rejects(run(['link', 'activate', '--project', project, '--hooks', '--yes']), /activation preflight failed: .*symlink/)
    assert.equal(existsSync(join(project, 'CLAUDE.md')), false)
    assert.equal(readFileSync(outside, 'utf8'), FOREIGN)
    rmSync(settings)
    rmSync(join(project, '.claude'), { recursive: true })
    mkdirSync(join(base, 'claude-elsewhere'))
    symlinkSync(join(base, 'claude-elsewhere'), join(project, '.claude'))
    await assert.rejects(run(['link', 'activate', '--project', project, '--activate', 'claude', '--yes']), /symlink/)
    assert.equal(existsSync(join(base, 'claude-elsewhere', 'settings.local.json')), false)
    rmSync(join(project, '.claude'))
    mkdirSync(join(project, '.claude'))
    writeFileSync(settings, '{ "hooks": ')
    await assert.rejects(run(['link', 'activate', '--project', project, '--hooks', '--yes']), /invalid hook settings/)
    assert.equal(readFileSync(settings, 'utf8'), '{ "hooks": ')
    const mixed = JSON.stringify(
      {
        hooks: {
          SessionStart: [
            {
              hooks: [
                { type: 'command', command: 'echo foreign' },
                { type: 'command', command: 'holoself context --hook holoself-session-start' }
              ]
            }
          ]
        }
      },
      null,
      2
    )
    writeFileSync(settings, mixed)
    await assert.rejects(run(['link', 'activate', '--project', project, '--hooks', '--yes']), /shares a group with other hooks/)
    assert.equal(readFileSync(settings, 'utf8'), mixed)
    assert.equal(existsSync(join(project, 'CLAUDE.md')), false)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('a failure after the hook write rolls the settings file back', async () => {
  const { base, project, settings } = await fixture()
  try {
    assert.throws(
      () =>
        activateProject(project, readLink(project), {
          activate: 'auto',
          hooks: 'on',
          afterHooks: () => {
            assert.equal(owned(settings).length, 1)
            throw new Error('injected failure')
          }
        }),
      /injected failure/
    )
    assert.equal(readFileSync(settings, 'utf8'), FOREIGN)
    assert.equal(existsSync(join(project, 'CLAUDE.md')), false)
    assert.equal(readRuntime(project), null)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('hook mode prints only the packet and exits 0; it fails open and closed on authority errors', async () => {
  const { base, self, project } = await fixture()
  const audit = join(base, 'audit.log'),
    env = { HOLOSELF_HOME: self, HOLOSELF_HOOK_AUDIT_LOG: audit },
    args = ['context', '--project', project, '--session-start', '--budget', 'small', '--format', 'packet', '--hook', 'holoself-session-start']
  const silent = (result, label) => {
    assert.equal(result.status, 0, label)
    assert.equal(result.stdout, '', label)
    assert.equal(result.stderr, '', label)
  }
  try {
    const ok = runBin(args, env)
    assert.equal(ok.status, 0)
    assert.equal(ok.stderr, '')
    assert.match(ok.stdout, /^# Holoself context packet\n\nPacket ID: [0-9a-f-]{36}\nContext receipt: [0-9a-f]{64}/)
    assert.match(ok.stdout, /HOOK-SENTINEL-7/)
    const line = json(readFileSync(audit, 'utf8').trim().split('\n').at(-1))
    assert.equal(line.ok, true)
    assert.ok(ok.stdout.includes(line.receipt) && ok.stdout.includes(line.packet_id))
    assert.ok(!readFileSync(audit, 'utf8').includes(base), 'audit log carries no paths')

    silent(runBin([...args.slice(0, -1), 'other-hook'], env), 'unknown hook id')
    silent(
      runBin(
        args.filter((x, i) => i !== 1 && i !== 2),
        env
      ),
      'no --project'
    )
    silent(runBin([...args, '--bogus-flag'], env), 'bad flag')
    silent(runBin([...args, '--restricted-host'], env), 'restricted-host refused in hook mode')
    // The installed command has no --project: the project comes from CLAUDE_PROJECT_DIR, and fails closed without it.
    const installed = ['context', '--session-start', '--budget', 'small', '--format', 'packet', '--hook', 'holoself-session-start']
    assert.match(runBin(installed, { ...env, CLAUDE_PROJECT_DIR: project }).stdout, /HOOK-SENTINEL-7/)
    silent(runBin(installed, { ...env, CLAUDE_PROJECT_DIR: '' }), 'empty CLAUDE_PROJECT_DIR')
    silent(runBin(installed, { ...env, CLAUDE_PROJECT_DIR: 'project' }), 'relative CLAUDE_PROJECT_DIR')
    silent(runBin(installed, { ...env, CLAUDE_PROJECT_DIR: join(base, 'unlinked') }), 'unlinked CLAUDE_PROJECT_DIR')

    // Revoked link: registry entry no longer active.
    const registry = join(self, '.holoself', 'links.json'),
      original = readFileSync(registry, 'utf8'),
      revoked = json(original)
    revoked.links.forEach(entry => (entry.status = 'revoked'))
    writeFileSync(registry, JSON.stringify(revoked))
    silent(runBin(args, env), 'revoked link')
    assert.equal(runBin(args.slice(0, -2), env).status, 1, 'the same refusal fails without hook mode')
    writeFileSync(registry, original)

    // Missing self-side binding.
    await capture(() => run(['lens', 'unbind', '--root', self, '--project', project, '--yes']))
    silent(runBin(args, env), 'missing binding')
    await capture(() => run(['lens', 'bind', '--root', self, '--project', project, '--lens', 'general', '--yes']))
    assert.match(runBin(args, env).stdout, /HOOK-SENTINEL-7/)

    // Missing self root: the portable link names its self by self_id, and the registered checkout is gone.
    renameSync(self, `${self}-moved`)
    silent(runBin(args, { ...env, HOLOSELF_HOME: `${self}-elsewhere` }), 'missing self root')
    // HOLOSELF_HOME naming the same self (same self_id in config.json) still serves the moved checkout.
    assert.match(runBin(args, { ...env, HOLOSELF_HOME: `${self}-moved` }).stdout, /HOOK-SENTINEL-7/)
    renameSync(`${self}-moved`, self)

    const codes = readFileSync(audit, 'utf8')
      .trim()
      .split('\n')
      .map(x => json(x))
      .filter(x => !x.ok)
      .map(x => x.code)
    for (const code of ['HOOK_ID_UNKNOWN', 'HOOK_PROJECT_REQUIRED', 'HOOK_OPTION_REFUSED', 'LINK_REQUIRED', 'LENS_NOT_GRANTED', 'LENS_BINDING_REQUIRED'])
      assert.ok(codes.includes(code), codes.join(','))
    assert.equal(codes.length, 10)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

const posix = process.platform !== 'win32'
const mode = file => statSync(file).mode & 0o777

test('settings keep their file mode; files Holoself creates are 0600; MCP configuration keeps its mode', { skip: !posix }, async () => {
  const { base, project, settings } = await fixture()
  try {
    chmodSync(settings, 0o640)
    await capture(() => run(['link', 'activate', '--project', project, '--hooks', '--yes']))
    assert.equal(owned(settings).length, 1)
    assert.equal(mode(settings), 0o640)
    await capture(() => run(['link', 'deactivate', '--project', project, '--adapters', 'claude', '--yes']))
    assert.equal(mode(settings), 0o640)
    rmSync(settings)
    await capture(() => run(['link', 'activate', '--project', project, '--hooks', '--yes']))
    assert.equal(mode(settings), 0o600)
    const mcp = join(project, '.mcp.json')
    writeFileSync(mcp, '{\n  "mcpServers": {}\n}\n')
    chmodSync(mcp, 0o600)
    applyMcpConfiguration(project, { platforms: ['claude'] })
    assert.ok(json(readFileSync(mcp, 'utf8')).mcpServers.holoself)
    assert.equal(mode(mcp), 0o600)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('pre-existing empty hook containers survive install and removal byte-for-byte', async () => {
  for (const original of [
    JSON.stringify({ hooks: { SessionStart: [] } }, null, 2) + '\n',
    JSON.stringify({ model: 'x', hooks: {} }, null, 2) + '\n'
  ]) {
    const { base, project, settings } = await fixture({ settings: original })
    try {
      await capture(() => run(['link', 'activate', '--project', project, '--hooks', '--yes']))
      assert.equal(owned(settings).length, 1)
      await capture(() => run(['link', 'deactivate', '--project', project, '--yes']))
      assert.equal(readFileSync(settings, 'utf8'), original)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  }
})

test('invalid settings make the hook unremovable without stopping deactivation or link remove', async () => {
  const { base, self, project, settings } = await fixture()
  try {
    await capture(() => run(['link', 'activate', '--project', project, '--hooks', '--yes']))
    writeFileSync(settings, '{ broken')
    const out = await capture(() => run(['link', 'deactivate', '--project', project, '--yes']))
    assert.match(out, /\.claude\/settings\.local\.json: unremovable \(session-start hook left in place: .*invalid hook settings/)
    assert.doesNotMatch(readFileSync(join(project, 'CLAUDE.md'), 'utf8'), /holoself/i)
    assert.equal(existsSync(join(project, '.holoself', 'runtime.json')), false)
    assert.equal(readFileSync(settings, 'utf8'), '{ broken')
    // link remove: local deactivation runs first and an unremovable hook does not block revocation.
    writeFileSync(settings, FOREIGN)
    await capture(() => run(['link', 'activate', '--project', project, '--hooks', '--yes']))
    writeFileSync(settings, '{ broken')
    const warn = console.warn
    let warned = ''
    console.warn = (...x) => {
      warned += x.join(' ')
    }
    try {
      await capture(() => run(['link', 'remove', '--project', project, '--yes']))
    } finally {
      console.warn = warn
    }
    assert.match(warned, /session-start hook left in place/)
    assert.equal(existsSync(join(project, '.holoself', 'link.yaml')), false)
    assert.ok(json(readFileSync(join(self, '.holoself', 'links.json'), 'utf8')).links.every(entry => entry.status === 'revoked'))
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('hook packets stay under the host output cap with a large profile and keep the receipt', async () => {
  const { base, self, project } = await fixture()
  try {
    const filler = Array.from({ length: 400 }, (_, i) => `- Synthetic preference line ${i} with enough words to take space.`).join('\n')
    for (const file of ['identity.md', 'preferences.md', 'work-context.md'])
      writeFileSync(join(self, 'profile', file), `---\nvisibility: linked-projects\n---\n# ${file}\n\n${filler}\n`)
    const args = ['context', '--project', project, '--session-start', '--budget', 'small', '--format', 'packet'],
      env = { HOLOSELF_HOME: self },
      plain = runBin(args, env),
      hooked = runBin([...args, '--hook', 'holoself-session-start'], env)
    assert.ok(Buffer.byteLength(plain.stdout) > 9000, `plain packet ${Buffer.byteLength(plain.stdout)} bytes`)
    assert.equal(hooked.status, 0)
    assert.ok(hooked.stdout.length > 0)
    assert.ok(Buffer.byteLength(hooked.stdout) <= 9000, `hook packet ${Buffer.byteLength(hooked.stdout)} bytes`)
    assert.match(hooked.stdout, /Context receipt: [0-9a-f]{64}/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('shared audit writer: absolute path only, no symlink or hard link, mode 0600, capped', { skip: !posix }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'holoself-audit-'))
  try {
    const log = join(dir, 'audit.log'),
      target = join(dir, 'target.log'),
      link = join(dir, 'link.log'),
      hard = join(dir, 'hard.log')
    appendAuditLine('relative.log', { event: 'x' })
    assert.equal(existsSync('relative.log'), false)
    writeFileSync(log, '')
    chmodSync(log, 0o644)
    appendAuditLine(log, { event: 'a' })
    assert.equal(mode(log), 0o600)
    assert.equal(readFileSync(log, 'utf8'), '{"event":"a"}\n')
    writeFileSync(target, '')
    symlinkSync(target, link)
    appendAuditLine(link, { event: 'b' })
    assert.equal(readFileSync(target, 'utf8'), '')
    linkSync(target, hard)
    appendAuditLine(hard, { event: 'c' })
    assert.equal(readFileSync(target, 'utf8'), '')
    for (let i = 0; i < 5; i++) appendAuditLine(log, { event: 'fill', i }, 60)
    assert.match(readFileSync(log, 'utf8'), /\{"event":"audit_log_capped"\}\n$/)
    assert.equal(readFileSync(log, 'utf8').match(/audit_log_capped/g).length, 1)
    // Hook mode uses the same writer: a symlinked HOOK audit log is never written through.
    const hookLink = join(dir, 'hook.log')
    symlinkSync(target, hookLink)
    runBin(['context', '--hook', 'holoself-session-start'], { HOLOSELF_HOOK_AUDIT_LOG: hookLink })
    assert.equal(readFileSync(target, 'utf8'), '')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('link remove always revokes even when local deactivation is refused', async () => {
  const { base, self, project } = await fixture()
  try {
    await capture(() => run(['link', 'activate', '--project', project, '--hooks', '--yes']))
    const skill = join(project, '.agents', 'skills', 'holoself', 'SKILL.md'),
      start = '<!-- holoself-skill-start schema=1 -->'
    writeFileSync(skill, `${start}\n${start}\nbroken\n`)
    const warn = console.warn
    let warned = ''
    console.warn = (...x) => {
      warned += x.join(' ') + '\n'
    }
    try {
      await capture(() => run(['link', 'remove', '--project', project, '--yes']))
    } finally {
      console.warn = warn
    }
    assert.match(warned, /local activation was not fully removed/)
    assert.ok(!warned.includes(base), 'warning carries no absolute paths')
    assert.ok(json(readFileSync(join(self, '.holoself', 'links.json'), 'utf8')).links.every(entry => entry.status === 'revoked'))
    // The shared project_key binding is kept for the project's other machines; no path-keyed entry remains.
    assert.ok(Object.keys(json(readFileSync(join(self, 'lenses', 'bindings.json'), 'utf8')).bindings).every(key => key.startsWith('hs-proj-')))
    assert.equal(existsSync(join(project, '.holoself', 'link.yaml')), false)
    const hook = runBin(['context', '--session-start', '--budget', 'small', '--format', 'packet', '--hook', 'holoself-session-start'], {
      HOLOSELF_HOME: self,
      CLAUDE_PROJECT_DIR: project
    })
    assert.equal(hook.status, 0)
    assert.equal(hook.stdout, '')
    assert.equal(hook.stderr, '')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('without a runtime record, removal drops containers left empty by the Holoself entry', async () => {
  const original = JSON.stringify({ model: 'x' }, null, 2) + '\n'
  const { base, project, settings } = await fixture({ settings: original })
  try {
    await capture(() => run(['link', 'activate', '--project', project, '--hooks', '--yes']))
    assert.equal(owned(settings).length, 1)
    rmSync(join(project, '.holoself', 'runtime.json'))
    const out = await capture(() => run(['link', 'deactivate', '--project', project, '--yes']))
    assert.match(out, /settings\.local\.json: hook-remove/)
    assert.equal(readFileSync(settings, 'utf8'), original)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

const CODEX_HOOKS = '.codex/hooks.json'
const AGY_HOOKS = '.agents/hooks.json'
const FOREIGN_AGY =
  JSON.stringify(
    {
      'foreign-workspace-hook': {
        SessionStart: [{ type: 'command', command: 'echo foreign-agy-start' }],
        PreToolUse: [{ matcher: 'run_command', type: 'command', command: 'echo foreign-agy-pre' }]
      }
    },
    null,
    2
  ) + '\n'
const agyOwned = file => (json(readFileSync(file, 'utf8'))['holoself-session-start']?.SessionStart || []).filter(h => h.command.includes('--hook holoself-session-start'))

test('default auto policy skips unverified Codex and AGY hooks; --hooks forces installation', async () => {
  const { base, project } = await fixture({ settings: null, claudeDir: false })
  try {
    mkdirSync(join(project, '.codex'))
    writeFileSync(join(project, 'AGY.md'), '# AGY\n')
    const autoOut = await capture(() => run(['link', 'activate', '--project', project, '--activate', 'codex,agy', '--no-mcp', '--yes']))
    assert.match(autoOut, /"hook_policy": "auto"/)
    assert.equal(existsSync(join(project, CODEX_HOOKS)), false)
    assert.equal(existsSync(join(project, AGY_HOOKS)), false)
    assert.deepEqual(readRuntime(project).hookInstallations, [])
    let status = json(await capture(() => run(['link', 'status', '--project', project])))
    assert.deepEqual(
      status.session_start_hooks.map(x => [x.id, x.state, x.support]),
      [
        ['codex', 'not-installed', 'unverified'],
        ['agy', 'not-installed', 'unverified']
      ]
    )

    const forcedOut = await capture(() => run(['link', 'activate', '--project', project, '--activate', 'codex,agy', '--hooks', '--no-mcp', '--yes']))
    assert.match(forcedOut, /codex: \.codex\/hooks\.json SessionStart hook \(create\)/)
    assert.match(forcedOut, /trust step: Run codex in this project and approve the startup "Hooks need review" prompt/)
    assert.match(forcedOut, /agy: \.agents\/hooks\.json SessionStart hook \(create\)/)
    assert.equal(owned(join(project, CODEX_HOOKS)).length, 1)
    assert.equal(agyOwned(join(project, AGY_HOOKS)).length, 1)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('Codex and AGY hooks preserve foreign hooks, modes, and empty containers, and roll back or deactivate cleanly', async () => {
  const { base, project } = await fixture({ settings: null, claudeDir: false })
  const codexFile = join(project, CODEX_HOOKS),
    agyFile = join(project, AGY_HOOKS)
  try {
    mkdirSync(join(project, '.codex'), { recursive: true })
    mkdirSync(join(project, '.agents'), { recursive: true })
    writeFileSync(codexFile, FOREIGN)
    writeFileSync(agyFile, FOREIGN_AGY)
    if (posix) {
      chmodSync(codexFile, 0o640)
      chmodSync(agyFile, 0o644)
    }
    await capture(() => run(['link', 'activate', '--project', project, '--activate', 'codex,agy', '--hooks', '--no-mcp', '--install-skill', 'none', '--yes']))
    const codexInstalled = readFileSync(codexFile, 'utf8'),
      agyInstalled = readFileSync(agyFile, 'utf8')
    assert.equal(owned(codexFile).length, 1)
    assert.equal(sessionStart(codexFile)[0].hooks[0].command, 'echo foreign-start')
    assert.deepEqual(json(codexInstalled).hooks.PreToolUse, json(FOREIGN).hooks.PreToolUse)
    assert.equal(agyOwned(agyFile).length, 1)
    assert.deepEqual(json(agyInstalled)['foreign-workspace-hook'], json(FOREIGN_AGY)['foreign-workspace-hook'])
    if (posix) {
      assert.equal(mode(codexFile), 0o640)
      assert.equal(mode(agyFile), 0o644)
    }
    // Idempotent second activation.
    await capture(() => run(['link', 'activate', '--project', project, '--activate', 'codex,agy', '--hooks', '--no-mcp', '--install-skill', 'none', '--yes']))
    assert.equal(readFileSync(codexFile, 'utf8'), codexInstalled)
    assert.equal(readFileSync(agyFile, 'utf8'), agyInstalled)

    // Deactivation restores foreign files byte-for-byte.
    await capture(() => run(['link', 'deactivate', '--project', project, '--yes']))
    assert.equal(readFileSync(codexFile, 'utf8'), FOREIGN)
    assert.equal(readFileSync(agyFile, 'utf8'), FOREIGN_AGY)

    // Pre-existing empty AGY containers survive install and removal byte-for-byte.
    for (const emptyAgy of [
      JSON.stringify({ 'holoself-session-start': { SessionStart: [] } }, null, 2) + '\n',
      JSON.stringify({ 'holoself-session-start': {} }, null, 2) + '\n'
    ]) {
      writeFileSync(agyFile, emptyAgy)
      await capture(() => run(['link', 'activate', '--project', project, '--activate', 'agy', '--hooks', '--no-mcp', '--install-skill', 'none', '--yes']))
      assert.equal(agyOwned(agyFile).length, 1)
      await capture(() => run(['link', 'deactivate', '--project', project, '--yes']))
      assert.equal(readFileSync(agyFile, 'utf8'), emptyAgy)
    }

    // Files and directories created by Holoself are mode 0600 and deleted on deactivation or rollback.
    rmSync(join(project, '.codex'), { recursive: true, force: true })
    rmSync(join(project, '.agents'), { recursive: true, force: true })
    assert.throws(
      () =>
        activateProject(project, readLink(project), {
          activate: 'codex,agy',
          hooks: 'on',
          mcp: 'off',
          installSkill: 'none',
          afterHooks: () => {
            assert.equal(owned(codexFile).length, 1)
            assert.equal(agyOwned(agyFile).length, 1)
            throw new Error('injected codex/agy rollback')
          }
        }),
      /injected codex\/agy rollback/
    )
    assert.equal(existsSync(join(project, '.codex')), false)
    assert.equal(existsSync(join(project, '.agents')), false)

    await capture(() => run(['link', 'activate', '--project', project, '--activate', 'codex,agy', '--hooks', '--no-mcp', '--install-skill', 'none', '--yes']))
    if (posix) {
      assert.equal(mode(codexFile), 0o600)
      assert.equal(mode(agyFile), 0o600)
    }
    // Repair restores deleted hook files.
    rmSync(codexFile)
    rmSync(agyFile)
    await capture(() => run(['link', 'repair', '--project', project, '--yes']))
    assert.equal(owned(codexFile).length, 1)
    assert.equal(agyOwned(agyFile).length, 1)

    await capture(() => run(['link', 'deactivate', '--project', project, '--yes']))
    assert.equal(existsSync(codexFile), false)
    assert.equal(existsSync(agyFile), false)
    assert.equal(existsSync(join(project, '.codex')), false)
    assert.equal(existsSync(join(project, '.agents')), false)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('Codex and AGY refuse symlinks, invalid JSON, and mixed groups; broken files report unremovable on deactivate', async () => {
  const { base, project } = await fixture({ settings: null, claudeDir: false })
  const codexFile = join(project, CODEX_HOOKS),
    agyFile = join(project, AGY_HOOKS),
    outside = join(base, 'outside-hooks.json')
  try {
    mkdirSync(join(project, '.codex'), { recursive: true })
    mkdirSync(join(project, '.agents'), { recursive: true })
    writeFileSync(outside, '{}\n')
    symlinkSync(outside, codexFile)
    await assert.rejects(
      run(['link', 'activate', '--project', project, '--activate', 'codex', '--hooks', '--no-mcp', '--install-skill', 'none', '--yes']),
      /symlink/
    )
    rmSync(codexFile)
    symlinkSync(outside, agyFile)
    await assert.rejects(
      run(['link', 'activate', '--project', project, '--activate', 'agy', '--hooks', '--no-mcp', '--install-skill', 'none', '--yes']),
      /symlink/
    )
    rmSync(agyFile)

    // Foreign handler alone under our 'holoself-session-start' named entry is refused; file stays byte-identical.
    for (const foreignUnderOurName of [
      JSON.stringify({ 'holoself-session-start': { SessionStart: [{ type: 'command', command: 'echo foreign' }] } }, null, 2) + '\n',
      JSON.stringify(
        {
          'holoself-session-start': { SessionStart: [{ type: 'command', command: 'echo foreign' }] },
          'other-named-hook': { SessionStart: [{ type: 'command', command: 'echo keep-me' }] }
        },
        null,
        2
      ) + '\n'
    ]) {
      writeFileSync(agyFile, foreignUnderOurName)
      await assert.rejects(
        run(['link', 'activate', '--project', project, '--activate', 'agy', '--hooks', '--no-mcp', '--install-skill', 'none', '--yes']),
        /shares a group with other hooks/
      )
      assert.equal(readFileSync(agyFile, 'utf8'), foreignUnderOurName)
    }

    // Mixed AGY group (foreign handler + owned handler inside holoself-session-start.SessionStart) is refused.
    const mixedAgy = JSON.stringify(
      {
        'holoself-session-start': {
          SessionStart: [
            { type: 'command', command: 'echo foreign' },
            { type: 'command', command: HOOK_HOSTS.agy.command, timeout: 30 }
          ]
        }
      },
      null,
      2
    )
    writeFileSync(agyFile, mixedAgy)
    await assert.rejects(
      run(['link', 'activate', '--project', project, '--activate', 'agy', '--hooks', '--no-mcp', '--install-skill', 'none', '--yes']),
      /shares a group with other hooks/
    )
    assert.equal(readFileSync(agyFile, 'utf8'), mixedAgy)
    rmSync(agyFile)

    // Foreign named entries under other names are preserved when our named entry is installed.
    writeFileSync(agyFile, FOREIGN_AGY)
    await capture(() => run(['link', 'activate', '--project', project, '--activate', 'agy', '--hooks', '--no-mcp', '--install-skill', 'none', '--yes']))
    assert.deepEqual(json(readFileSync(agyFile, 'utf8'))['foreign-workspace-hook'], json(FOREIGN_AGY)['foreign-workspace-hook'])
    await capture(() => run(['link', 'deactivate', '--project', project, '--yes']))
    assert.equal(readFileSync(agyFile, 'utf8'), FOREIGN_AGY)
    rmSync(agyFile)

    // Broken hook files report unremovable on deactivate without blocking deactivation.
    await capture(() => run(['link', 'activate', '--project', project, '--activate', 'codex,agy', '--hooks', '--no-mcp', '--install-skill', 'none', '--yes']))
    writeFileSync(codexFile, '{ broken')
    writeFileSync(agyFile, '{ broken')
    const out = await capture(() => run(['link', 'deactivate', '--project', project, '--yes']))
    assert.match(out, /\.codex\/hooks\.json: unremovable/)
    assert.match(out, /\.agents\/hooks\.json: unremovable/)
    assert.equal(existsSync(join(project, '.holoself', 'runtime.json')), false)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('Codex trust state: installed-untrusted without trusted_hash, installed-trust-unverified when present (read-only); relative CODEX_HOME ignored', async () => {
  const { base, project } = await fixture({ settings: null, claudeDir: false })
  const codexFile = join(project, CODEX_HOOKS),
    codexConfig = join(base, 'codex-config.toml'),
    savedConfig = process.env.HOLOSELF_TEST_CODEX_CONFIG
  try {
    mkdirSync(join(project, '.codex'), { recursive: true })
    writeFileSync(codexFile, FOREIGN)
    process.env.HOLOSELF_TEST_CODEX_CONFIG = codexConfig
    const out = await capture(() =>
      run(['link', 'activate', '--project', project, '--activate', 'codex', '--hooks', '--no-mcp', '--install-skill', 'none', '--yes'])
    )
    assert.match(out, /trust step: Run codex in this project and approve the startup "Hooks need review" prompt/)
    assert.equal(existsSync(codexConfig), false, 'Holoself never creates or writes user Codex config.toml')

    // Missing config.toml -> installed-untrusted in both link status and link doctor.
    let status = json(await capture(() => run(['link', 'status', '--project', project])))
    assert.equal(status.state, 'activated')
    assert.equal(status.session_start_hooks[0].state, 'installed-untrusted')
    assert.match(status.session_start_hooks[0].trust_step, /Hooks need review/)
    let doctor = json(await capture(() => run(['link', 'doctor', '--project', project])))
    assert.equal(doctor.state, 'activated')
    assert.equal(doctor.checks.session_start_hook, 'installed-untrusted')
    assert.equal(doctor.session_start_hooks[0].state, 'installed-untrusted')

    // Wrong group index (0:0 when FOREIGN is group 0 and Holoself is group 1) stays installed-untrusted.
    const escapedPath = codexFile.replaceAll('\\', '\\\\')
    writeFileSync(
      codexConfig,
      `[hooks.state."${escapedPath}:session_start:0:0"]\ntrusted_hash = "sha256:${'a'.repeat(64)}"\n`
    )
    status = json(await capture(() => run(['link', 'status', '--project', project])))
    assert.equal(status.session_start_hooks[0].state, 'installed-untrusted')

    // Matching group index (1:0) in table form marks the hook installed-trust-unverified (hash input is not reproduced).
    const configContent = `[hooks.state."${escapedPath}:session_start:1:0"]\ntrusted_hash = "sha256:${'b'.repeat(64)}"\n`
    writeFileSync(codexConfig, configContent)
    status = json(await capture(() => run(['link', 'status', '--project', project])))
    assert.equal(status.session_start_hooks[0].state, 'installed-trust-unverified')
    assert.equal(status.session_start_hooks[0].trust_step, undefined)
    doctor = json(await capture(() => run(['link', 'doctor', '--project', project])))
    assert.equal(doctor.state, 'activated')
    assert.equal(doctor.checks.session_start_hook, 'installed-trust-unverified')
    assert.equal(doctor.session_start_hooks[0].state, 'installed-trust-unverified')
    assert.equal(readFileSync(codexConfig, 'utf8'), configContent, 'config.toml is strictly read-only')

    // Second activate while installed-trust-unverified is idempotent.
    const installedBytes = readFileSync(codexFile, 'utf8')
    await capture(() => run(['link', 'activate', '--project', project, '--activate', 'codex', '--hooks', '--no-mcp', '--install-skill', 'none', '--yes']))
    assert.equal(readFileSync(codexFile, 'utf8'), installedBytes)

    // Dotted key form in config.toml is also recognised.
    writeFileSync(
      codexConfig,
      `hooks.state."${escapedPath}:session_start:1:0".trusted_hash = "sha256:${'c'.repeat(64)}"\n`
    )
    status = json(await capture(() => run(['link', 'status', '--project', project])))
    assert.equal(status.session_start_hooks[0].state, 'installed-trust-unverified')

    // Relative CODEX_HOME is ignored and falls back to HOME; absolute CODEX_HOME is honoured.
    delete process.env.HOLOSELF_TEST_CODEX_CONFIG
    const fakeHome = join(base, 'fake-home'),
      absCodexHome = join(base, 'abs-codex-home'),
      relCodexDir = join(process.cwd(), 'relative-codex-home-should-not-be-read')
    mkdirSync(join(fakeHome, '.codex'), { recursive: true })
    mkdirSync(absCodexHome, { recursive: true })
    writeFileSync(join(fakeHome, '.codex', 'config.toml'), configContent)
    assert.equal(isCodexHookTrusted(codexFile, 1, 0, { CODEX_HOME: 'relative-codex-home-should-not-be-read', HOME: fakeHome }), true)
    assert.equal(existsSync(relCodexDir), false)
    writeFileSync(join(fakeHome, '.codex', 'config.toml'), '')
    assert.equal(isCodexHookTrusted(codexFile, 1, 0, { CODEX_HOME: 'relative-codex-home-should-not-be-read', HOME: fakeHome }), false)
    writeFileSync(join(absCodexHome, 'config.toml'), configContent)
    assert.equal(isCodexHookTrusted(codexFile, 1, 0, { CODEX_HOME: absCodexHome, HOME: fakeHome }), true)
  } finally {
    if (savedConfig === undefined) delete process.env.HOLOSELF_TEST_CODEX_CONFIG
    else process.env.HOLOSELF_TEST_CODEX_CONFIG = savedConfig
    rmSync(base, { recursive: true, force: true })
  }
})

test('AGY hook-format agy-json wraps packet in injectSteps, respects the 9,000-byte cap, resolves cwd, and fails closed with empty envelope', async () => {
  const { base, self, project } = await fixture({ settings: null, claudeDir: false })
  const audit = join(base, 'audit-agy.log'),
    env = { HOLOSELF_HOME: self, HOLOSELF_HOOK_AUDIT_LOG: audit, CLAUDE_PROJECT_DIR: undefined },
    installedCmd = ['context', '--session-start', '--budget', 'small', '--format', 'packet', '--hook', 'holoself-session-start', '--hook-format', 'agy-json']
  const runIn = (args, cwd, extraEnv = {}) => {
    const merged = { ...process.env, HOLOSELF_ERROR_FORMAT: '', ...env, ...extraEnv }
    if (merged.CLAUDE_PROJECT_DIR === undefined) delete merged.CLAUDE_PROJECT_DIR
    return spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: merged })
  }
  const emptyEnvelope = (result, label) => {
    assert.equal(result.status, 0, label)
    assert.equal(result.stderr, '', label)
    assert.equal(result.stdout, '{"injectSteps":[]}\n', label)
  }
  try {
    mkdirSync(join(project, '.agents'), { recursive: true })
    // AGY executes workspace hooks with cwd set to <workspace>/.agents (the directory containing hooks.json).
    for (const cwd of [project, join(project, '.agents')]) {
      const ok = runIn(installedCmd, cwd)
      assert.equal(ok.status, 0)
      assert.equal(ok.stderr, '')
      const parsed = json(ok.stdout)
      assert.equal(parsed.injectSteps.length, 1)
      const msg = parsed.injectSteps[0].systemMessage.systemMessage
      assert.match(msg, /^# Holoself context packet\n\nPacket ID: [0-9a-f-]{36}\nContext receipt: [0-9a-f]{64}/)
      assert.match(msg, /HOOK-SENTINEL-7/)
    }

    // Codex executes hooks with cwd set to the project root and --hook-format text (default).
    const codexOk = runIn(installedCmd.slice(0, -2), project)
    assert.equal(codexOk.status, 0)
    assert.equal(codexOk.stderr, '')
    assert.match(codexOk.stdout, /HOOK-SENTINEL-7/)

    // Refusal paths with --hook-format agy-json emit a valid empty envelope and no stderr.
    emptyEnvelope(runIn(installedCmd, project, { CLAUDE_PROJECT_DIR: '' }), 'empty CLAUDE_PROJECT_DIR')
    emptyEnvelope(runIn(installedCmd, project, { CLAUDE_PROJECT_DIR: 'relative/path' }), 'relative CLAUDE_PROJECT_DIR')
    emptyEnvelope(runIn(installedCmd, base), 'unlinked working directory')
    emptyEnvelope(runIn(['context', '--project', 'relative', ...installedCmd.slice(1)], project), 'relative --project')
    emptyEnvelope(runIn([...installedCmd, '--bogus-flag'], project), 'bad flag')
    emptyEnvelope(runIn([...installedCmd, '--restricted-host'], project), 'restricted-host')

    // Unsupported --hook-format value: in hook mode prints nothing and exits 0; outside hook mode parser rejects with INVALID_ARGUMENT.
    const badFormat = runIn([...installedCmd.slice(0, -1), 'bogus-format'], project)
    assert.equal(badFormat.status, 0)
    assert.equal(badFormat.stdout, '')
    assert.equal(badFormat.stderr, '')
    assert.throws(
      () => parseArguments(['context', '--project', project, '--hook-format', 'bogus-format']),
      err => err.code === 'INVALID_ARGUMENT' && /invalid hook format: bogus-format/.test(err.message)
    )
    const badFormatOutsideHook = runIn(['context', '--project', project, '--hook-format', 'bogus-format'], project)
    assert.notEqual(badFormatOutsideHook.status, 0)
    assert.match(badFormatOutsideHook.stderr, /invalid hook format: bogus-format/)

    // Large profile: total serialized agy-json envelope stays <= 9,000 bytes and keeps the receipt.
    const filler = Array.from({ length: 400 }, (_, i) => `- Synthetic preference line ${i} with enough words to take space.`).join('\n')
    for (const file of ['identity.md', 'preferences.md', 'work-context.md'])
      writeFileSync(join(self, 'profile', file), `---\nvisibility: linked-projects\n---\n# ${file}\n\n${filler}\n`)
    const capped = runIn(installedCmd, join(project, '.agents'))
    assert.equal(capped.status, 0)
    assert.ok(Buffer.byteLength(capped.stdout) <= 9000, `agy-json bytes: ${Buffer.byteLength(capped.stdout)}`)
    const cappedMsg = json(capped.stdout).injectSteps[0].systemMessage.systemMessage
    assert.match(cappedMsg, /Context receipt: [0-9a-f]{64}/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
