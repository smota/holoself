import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { activateProject, readRuntime } from '../src/adapters.mjs'
import { HOOK_HOSTS, hookSupport } from '../src/adapters/hooks.mjs'
import { run } from '../src/cli.mjs'
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
  assert.equal(hookSupport('claude').support, 'verified')
  assert.equal(hookSupport('codex').support, 'unsupported')
  assert.equal(hookSupport('agy').support, 'unsupported')
  const command = HOOK_HOSTS.claude.command
  assert.equal(command, 'holoself context --session-start --budget small --format packet --hook holoself-session-start')
  assert.doesNotMatch(command, /[$"'%]/, 'no shell expansion or quoting')
})

test('activate installs one owned hook, deactivate restores foreign settings byte-for-byte, repair restores it', async () => {
  const { base, project, settings } = await fixture()
  try {
    await capture(() => run(['link', 'activate', '--project', project, '--yes']))
    const installed = readFileSync(settings, 'utf8')
    assert.equal(owned(settings).length, 1)
    assert.equal(sessionStart(settings)[0].hooks[0].command, 'echo foreign-start')
    assert.deepEqual(json(installed).permissions, { allow: ['Bash(ls)'] })
    assert.deepEqual(json(installed).hooks.PreToolUse, json(FOREIGN).hooks.PreToolUse)
    const runtime = readRuntime(project)
    assert.equal(runtime.hookPolicy, 'auto')
    assert.deepEqual(
      runtime.hookInstallations.map(x => [x.id, x.file, x.event, x.createdFile]),
      [['claude', SETTINGS, 'SessionStart', false]]
    )
    // Idempotent: a second activation leaves the file untouched.
    await capture(() => run(['link', 'activate', '--project', project, '--yes']))
    assert.equal(readFileSync(settings, 'utf8'), installed)
    const status = json(await capture(() => run(['link', 'status', '--project', project])))
    assert.deepEqual(
      status.session_start_hooks.map(x => [x.id, x.state, x.support]),
      [['claude', 'installed', 'verified']]
    )
    // Dry-run deactivation previews the removal without writing.
    const preview = await capture(() => run(['link', 'deactivate', '--project', project, '--dry-run']))
    assert.match(preview, /\.claude\/settings\.local\.json: hook-remove/)
    assert.equal(readFileSync(settings, 'utf8'), installed)
    await capture(() => run(['link', 'deactivate', '--project', project, '--yes']))
    assert.equal(readFileSync(settings, 'utf8'), FOREIGN)
    // Repair after a scoped removal restores the recorded hook.
    await capture(() => run(['link', 'activate', '--project', project, '--yes']))
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
    const out = await capture(() => run(['link', 'activate', '--project', project, '--dry-run', '--yes']))
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
    await capture(() => run(['link', 'activate', '--project', project, '--yes']))
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
    await assert.rejects(run(['link', 'activate', '--project', project, '--yes']), /activation preflight failed: .*symlink/)
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
    await assert.rejects(run(['link', 'activate', '--project', project, '--yes']), /invalid hook settings/)
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
    await assert.rejects(run(['link', 'activate', '--project', project, '--yes']), /shares a group with other hooks/)
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

    // Missing self root.
    renameSync(self, `${self}-moved`)
    silent(runBin(args, { ...env, HOLOSELF_HOME: `${self}-moved` }), 'missing self root')
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
    await capture(() => run(['link', 'activate', '--project', project, '--yes']))
    assert.equal(owned(settings).length, 1)
    assert.equal(mode(settings), 0o640)
    await capture(() => run(['link', 'deactivate', '--project', project, '--adapters', 'claude', '--yes']))
    assert.equal(mode(settings), 0o640)
    rmSync(settings)
    await capture(() => run(['link', 'activate', '--project', project, '--yes']))
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
      await capture(() => run(['link', 'activate', '--project', project, '--yes']))
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
    await capture(() => run(['link', 'activate', '--project', project, '--yes']))
    writeFileSync(settings, '{ broken')
    const out = await capture(() => run(['link', 'deactivate', '--project', project, '--yes']))
    assert.match(out, /\.claude\/settings\.local\.json: unremovable \(session-start hook left in place: .*invalid hook settings/)
    assert.doesNotMatch(readFileSync(join(project, 'CLAUDE.md'), 'utf8'), /holoself/i)
    assert.equal(existsSync(join(project, '.holoself', 'runtime.json')), false)
    assert.equal(readFileSync(settings, 'utf8'), '{ broken')
    // link remove: local deactivation runs first and an unremovable hook does not block revocation.
    writeFileSync(settings, FOREIGN)
    await capture(() => run(['link', 'activate', '--project', project, '--yes']))
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
