// Portable links across machines (issue #131, docs/decisions/portable-links.md): self_id and project_key in synced
// files, the per-machine self map (selves.json), the resolution order, project_key-keyed bindings and migration.
// Every test uses its own temporary directories and its own HOLOSELF_CONFIG_DIR; synthetic data only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readBindings, writeBinding } from '../src/bindings.mjs'
import { linkProjectKey, readLink } from '../src/link/config.mjs'
import { forgetSelf, readSelfMap, registerSelf, selfIdOf } from '../src/link/machine.mjs'
import { readRegistry } from '../src/link/registry.mjs'
import { resolveLinkedSelf } from '../src/link/self-resolution.mjs'
import { parseYaml } from '../src/shared/yaml.mjs'
import { reconcileCatalog } from '../src/web/server-helpers.mjs'

const BIN = fileURLToPath(new URL('../bin/holoself.mjs', import.meta.url))
const SENTINEL = 'PORTABLE-SENTINEL-131'
const posix = process.platform !== 'win32'

function sandbox(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'holoself-portable-')))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  return base
}

// One simulated machine: its own home and per-user configuration directory.
function machine(base, name) {
  const root = join(base, name),
    home = join(root, 'home'),
    config = join(root, 'config')
  mkdirSync(home, { recursive: true })
  const env = {}
  for (const [key, value] of Object.entries(process.env)) if (!/^(HOLOSELF_|CLAUDE|CODEX|NODE_TEST)/i.test(key)) env[key] = value
  Object.assign(env, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), HOLOSELF_CONFIG_DIR: config, NO_COLOR: '1' })
  const cli = (args, extra = {}) => spawnSync(process.execPath, [BIN, ...args], { cwd: extra.cwd || root, env: { ...env, ...(extra.env || {}) }, encoding: 'utf8' })
  return { root, home, config, env, cli, self: join(root, 'code', 'self'), project: join(root, 'code', 'project') }
}

function ok(result, label) {
  assert.equal(result.status, 0, `${label}: ${result.stderr || result.stdout}`)
  return result
}

function seedSelf(m) {
  ok(m.cli(['init', '--root', m.self]), 'init')
  writeFileSync(
    join(m.self, 'context', 'portable.md'),
    `---\naccess_lenses: [general, professional]\ndisclosure: internal-only\nsensitivity: personal\ndocument_role: content\n---\n# Portable\n\n${SENTINEL} reusable context.\n`
  )
  mkdirSync(m.project, { recursive: true })
  writeFileSync(join(m.project, 'NOTES.md'), '# Notes\n')
}

const linkText = project => readFileSync(join(project, '.holoself', 'link.yaml'), 'utf8')
const bindingsOf = self => JSON.parse(readFileSync(join(self, 'lenses', 'bindings.json'), 'utf8')).bindings

// The synced self repository: everything except the git-ignored per-machine state under .holoself/.
function syncSelf(from, to) {
  cpSync(from, to, {
    recursive: true,
    filter: source => {
      const rel = source.slice(from.length).replaceAll('\\', '/')
      return !rel.startsWith('/.holoself/') || rel === '/.holoself/.gitignore'
    }
  })
}
// The synced client project: its files plus the trackable .holoself metadata (link.yaml, README.md, .gitignore).
function syncProject(from, to) {
  mkdirSync(join(to, '.holoself'), { recursive: true })
  cpSync(join(from, 'NOTES.md'), join(to, 'NOTES.md'))
  for (const name of ['link.yaml', 'README.md', '.gitignore']) cpSync(join(from, '.holoself', name), join(to, '.holoself', name))
}

test('two machines share a self and a project through synced files; each attests once', t => {
  const base = sandbox(t),
    a = machine(base, 'machine-a'),
    b = machine(base, 'machine-b-with-a-longer-path')
  seedSelf(a)
  ok(a.cli(['link', 'setup', '--project', a.project, '--self', a.self, '--lens', 'professional', '--no-activate', '--yes']), 'setup on A')
  const linkA = linkText(a.project),
    parsed = parseYaml(linkA)
  assert.match(parsed.project_key, /^hs-proj-[0-9a-f]{32}$/)
  assert.equal(parsed.self_context.self_id, selfIdOf(a.self))
  assert.equal(parsed.self_context.path, undefined, 'a portable link carries no machine path')
  assert.doesNotMatch(linkA, new RegExp(base.replaceAll('\\', '\\\\')))
  assert.deepEqual(Object.keys(bindingsOf(a.self)), [parsed.project_key])
  assert.match(ok(a.cli(['context', '--project', a.project, '--json']), 'context on A').stdout, new RegExp(SENTINEL))

  syncSelf(a.self, b.self)
  syncProject(a.project, b.project)
  // Before this machine knows the self, the link fails closed.
  const refused = b.cli(['context', '--project', b.project, '--json'])
  assert.notEqual(refused.status, 0)
  assert.match(refused.stderr, /has no checkout registered on this machine/)

  ok(b.cli(['link', 'setup', '--project', b.project, '--self', b.self, '--no-activate', '--yes']), 'setup on B')
  ok(b.cli(['link', 'repair', '--project', b.project, '--no-activate', '--yes']), 'repair on B')
  assert.equal(linkText(b.project), linkA, 'link.yaml is identical on both machines (no rewrite, same project_key and binding_salt)')
  const served = JSON.parse(ok(b.cli(['context', '--project', b.project, '--json']), 'context on B').stdout)
  assert.match(JSON.stringify(served), new RegExp(SENTINEL))
  assert.equal(served.lens, 'professional', 'the synced project_key binding keeps the lens chosen on A')
  assert.match(ok(a.cli(['context', '--project', a.project, '--json']), 'context on A again').stdout, new RegExp(SENTINEL))
  assert.deepEqual(Object.keys(bindingsOf(b.self)), [parsed.project_key], 'bindings.json ends with one project_key entry')
  // Attestation stays per machine and path-keyed, with the project_key recorded.
  for (const m of [a, b]) {
    const entries = readRegistry(m.self).links
    assert.equal(entries.length, 1)
    assert.equal(entries[0].project_path, realpathSync(m.project).replaceAll('\\', '/'))
    assert.equal(entries[0].project_key, parsed.project_key)
  }
  const map = JSON.parse(readFileSync(join(b.config, 'selves.json'), 'utf8'))
  assert.deepEqual(Object.keys(map.selves), [selfIdOf(b.self)])
  assert.equal(map.selves[selfIdOf(b.self)].path, realpathSync(b.self).replaceAll('\\', '/'))
})

test('an additional machine can join with machine register and link approve', t => {
  const base = sandbox(t),
    a = machine(base, 'a'),
    b = machine(base, 'b')
  seedSelf(a)
  ok(a.cli(['link', 'setup', '--project', a.project, '--self', a.self, '--no-activate', '--yes']), 'setup on A')
  syncSelf(a.self, b.self)
  syncProject(a.project, b.project)
  ok(b.cli(['machine', 'register', '--root', b.self]), 'register on B')
  // Registered but not attested on this machine: the clone cannot attest itself.
  const unattested = b.cli(['context', '--project', b.project, '--json'])
  assert.notEqual(unattested.status, 0)
  assert.match(unattested.stderr, /not attested/)
  ok(b.cli(['link', 'approve', '--project', b.project, '--self', b.self]), 'approve on B')
  assert.equal(linkText(b.project), linkText(a.project))
  assert.match(ok(b.cli(['context', '--project', b.project, '--json']), 'context on B').stdout, new RegExp(SENTINEL))
})

test('resolution order: explicit self, HOLOSELF_HOME, self map, legacy path, else SELF_NOT_FOUND', t => {
  const base = sandbox(t),
    m = machine(base, 'm'),
    other = join(m.root, 'code', 'other-self'),
    env = { ...m.env }
  seedSelf(m)
  ok(m.cli(['init', '--root', other]), 'init other')
  ok(m.cli(['link', 'setup', '--project', m.project, '--self', m.self, '--no-activate', '--yes']), 'setup')
  const reference = { project: m.project, selfId: selfIdOf(m.self), legacyPath: null },
    self = realpathSync(m.self)
  assert.equal(resolveLinkedSelf({ ...reference, env }).source, 'map')
  assert.equal(resolveLinkedSelf({ ...reference, explicitSelf: m.self, env }).source, 'explicit')
  assert.throws(() => resolveLinkedSelf({ ...reference, explicitSelf: other, env }), error => error.code === 'SELF_ROOT_NOT_CANONICAL')
  // A HOLOSELF_HOME naming another self is skipped, not an error; one naming this self wins over the map.
  assert.deepEqual(
    (({ path, source }) => ({ path, source }))(resolveLinkedSelf({ ...reference, env: { ...env, HOLOSELF_HOME: other } })),
    { path: self, source: 'map' }
  )
  assert.equal(resolveLinkedSelf({ ...reference, env: { ...env, HOLOSELF_HOME: m.self } }).source, 'env')
  // CLI: an explicit --self naming another self is refused; HOLOSELF_HOME naming another self is skipped.
  const mismatch = m.cli(['context', '--project', m.project, '--self', other, '--json'])
  assert.notEqual(mismatch.status, 0)
  assert.match(mismatch.stderr, /does not match canonical link root/)
  ok(m.cli(['context', '--project', m.project, '--json'], { env: { HOLOSELF_HOME: other } }), 'mismatched HOLOSELF_HOME skipped')

  // A stale map entry (path missing) and a self whose config.json id changed both fail closed.
  const moved = `${m.self}-moved`
  renameSync(m.self, moved)
  assert.throws(() => resolveLinkedSelf({ ...reference, env }), error => error.code === 'SELF_NOT_FOUND')
  // The legacy path fallback still verifies the id.
  assert.equal(resolveLinkedSelf({ ...reference, legacyPath: moved, env }).source, 'legacy-path')
  renameSync(moved, m.self)
  const config = join(m.self, 'config.json'),
    original = readFileSync(config, 'utf8')
  writeFileSync(config, JSON.stringify({ ...JSON.parse(original), self_id: `hs-self-${'0'.repeat(32)}` }, null, 2) + '\n')
  assert.throws(() => resolveLinkedSelf({ ...reference, env }), error => error.code === 'SELF_NOT_FOUND')
  assert.throws(() => resolveLinkedSelf({ ...reference, legacyPath: m.self, env }), error => error.code === 'SELF_NOT_FOUND')
  assert.throws(() => readLink(m.project, { env }), error => error.code === 'SELF_NOT_FOUND')
  writeFileSync(config, original)
  // A legacy path-only link resolves exactly as before, relative to the project and unverified.
  assert.deepEqual(resolveLinkedSelf({ project: m.project, legacyPath: '../other-self', env }), {
    path: join(m.project, '..', 'other-self'),
    source: 'legacy-path',
    diagnostics: []
  })
})

test('hook mode with an unresolvable self prints nothing and exits 0', t => {
  const base = sandbox(t),
    m = machine(base, 'm')
  seedSelf(m)
  ok(m.cli(['link', 'setup', '--project', m.project, '--self', m.self, '--no-activate', '--yes']), 'setup')
  const hook = ['context', '--hook', 'holoself-session-start', '--project', m.project]
  assert.match(ok(m.cli(hook), 'hook serves').stdout, /^# Holoself context packet/)
  ok(m.cli(['machine', 'forget', selfIdOf(m.self), '--yes']), 'forget')
  for (const extra of [{}, { HOLOSELF_HOME: join(base, 'nowhere') }]) {
    const silent = m.cli(hook, { env: extra })
    assert.equal(silent.status, 0)
    assert.equal(silent.stdout, '')
    assert.equal(silent.stderr, '')
  }
  const agy = m.cli([...hook, '--hook-format', 'agy-json'])
  assert.deepEqual([agy.status, agy.stdout, agy.stderr], [0, '{"injectSteps":[]}\n', ''])
  writeFileSync(join(m.config, 'selves.json'), '{ not json')
  const malformed = m.cli(hook)
  assert.deepEqual([malformed.status, malformed.stdout, malformed.stderr], [0, '', ''])
})

test('selves.json is 0600 in a 0700 directory, and a malformed or symlinked map fails closed', t => {
  const base = sandbox(t),
    m = machine(base, 'm'),
    env = { ...m.env }
  seedSelf(m)
  const registered = registerSelf(m.self, { env })
  assert.equal(registered.changed, true)
  assert.equal(registered.adds_self_id, false, 'init already wrote a self_id')
  const file = join(m.config, 'selves.json')
  if (posix) {
    assert.equal(lstatSync(file).mode & 0o777, 0o600)
    assert.equal(lstatSync(m.config).mode & 0o777, 0o700)
  }
  assert.equal(readSelfMap(env).state, 'ok')
  const reference = { project: m.project, selfId: selfIdOf(m.self), env }
  assert.equal(resolveLinkedSelf(reference).source, 'map')

  writeFileSync(file, '{ "schema_version": 1, "selves": [] }')
  const malformed = readSelfMap(env)
  assert.equal(malformed.state, 'invalid')
  assert.deepEqual(malformed.selves, {})
  assert.match(malformed.diagnostics[0], /invalid/)
  assert.throws(() => resolveLinkedSelf(reference), error => error.code === 'SELF_NOT_FOUND')
  assert.throws(() => registerSelf(m.self, { env }), error => error.code === 'SELF_MAP_INVALID')
  writeFileSync(file, '{ not json')
  assert.equal(readSelfMap(env).state, 'invalid')

  if (posix) {
    const outside = join(base, 'outside.json')
    writeFileSync(outside, JSON.stringify({ schema_version: 1, selves: { [selfIdOf(m.self)]: { path: m.self, updated_at: 'x' } } }))
    rmSync(file)
    symlinkSync(outside, file)
    assert.equal(readSelfMap(env).state, 'invalid')
    assert.throws(() => resolveLinkedSelf(reference), error => error.code === 'SELF_NOT_FOUND')
    rmSync(file)
    const realDir = join(base, 'real-config')
    mkdirSync(realDir)
    const linkedEnv = { ...env, HOLOSELF_CONFIG_DIR: join(base, 'linked-config') }
    symlinkSync(realDir, linkedEnv.HOLOSELF_CONFIG_DIR)
    assert.equal(readSelfMap(linkedEnv).state, 'invalid')
    assert.throws(() => registerSelf(m.self, { env: linkedEnv }), error => error.code === 'SELF_MAP_UNSAFE')
    assert.equal(existsSync(join(realDir, 'selves.json')), false)
    chmodSync(m.config, 0o700)
  }
})

test('machine status, register and forget, with --dry-run and --json', t => {
  const base = sandbox(t),
    m = machine(base, 'm')
  seedSelf(m)
  // A self from an older version: no self_id yet.
  const config = join(m.self, 'config.json'),
    { self_id: _drop, ...legacyConfig } = JSON.parse(readFileSync(config, 'utf8'))
  writeFileSync(config, JSON.stringify(legacyConfig, null, 2) + '\n')
  const before = readFileSync(config, 'utf8')
  const dry = JSON.parse(ok(m.cli(['machine', 'register', '--root', m.self, '--dry-run', '--json']), 'register dry-run').stdout)
  assert.deepEqual([dry.dry_run, dry.self_id, dry.adds_self_id, dry.changed], [true, null, true, true])
  assert.equal(readFileSync(config, 'utf8'), before, 'dry-run writes nothing')
  assert.equal(existsSync(join(m.config, 'selves.json')), false)
  assert.match(ok(m.cli(['machine', 'status']), 'empty status').stdout, /No selves registered/)

  const registered = JSON.parse(ok(m.cli(['machine', 'register', '--root', m.self, '--json']), 'register').stdout)
  assert.match(registered.self_id, /^hs-self-[0-9a-f]{32}$/)
  assert.equal(registered.adds_self_id, true)
  const updated = JSON.parse(readFileSync(config, 'utf8'))
  assert.deepEqual({ ...updated, self_id: undefined }, { ...legacyConfig, self_id: undefined }, 'every other config.json field is preserved')
  assert.equal(updated.self_id, registered.self_id)
  assert.match(ok(m.cli(['machine', 'register', '--root', m.self]), 'register again').stdout, /\(unchanged\)/)
  const status = JSON.parse(ok(m.cli(['machine', 'status', '--json']), 'status').stdout)
  assert.equal(status.state, 'ok')
  assert.deepEqual(
    status.selves.map(({ self_id, exists, id_matches }) => ({ self_id, exists, id_matches })),
    [{ self_id: registered.self_id, exists: true, id_matches: true }]
  )

  const forgetDry = JSON.parse(ok(m.cli(['machine', 'forget', registered.self_id, '--dry-run', '--json']), 'forget dry-run').stdout)
  assert.deepEqual([forgetDry.dry_run, forgetDry.changed], [true, true])
  assert.equal(Object.keys(JSON.parse(readFileSync(join(m.config, 'selves.json'), 'utf8')).selves).length, 1)
  assert.notEqual(m.cli(['machine', 'forget', registered.self_id]).status, 0, 'forget requires --yes')
  assert.notEqual(m.cli(['machine', 'forget', 'not-an-id', '--yes']).status, 0)
  assert.notEqual(m.cli(['machine', 'register', '--root', join(base, 'missing')]).status, 0)
  ok(m.cli(['machine', 'forget', registered.self_id, '--yes']), 'forget')
  assert.deepEqual(JSON.parse(readFileSync(join(m.config, 'selves.json'), 'utf8')).selves, {})
  assert.equal(forgetSelf(registered.self_id, { env: m.env }).changed, false)

  // A registered path whose config.json no longer carries the id is reported, not served.
  ok(m.cli(['machine', 'register', '--root', m.self]), 'register for stale check')
  writeFileSync(config, JSON.stringify({ ...updated, self_id: `hs-self-${'1'.repeat(32)}` }, null, 2) + '\n')
  const stale = m.cli(['machine', 'status', '--json'])
  assert.equal(stale.status, 1)
  assert.equal(JSON.parse(stale.stdout).selves.find(item => item.self_id === registered.self_id).id_matches, false)
})

test('a legacy link and path-keyed binding behave as before until link repair migrates them', t => {
  const base = sandbox(t),
    m = machine(base, 'm')
  seedSelf(m)
  // The state an older Holoself left: link.yaml with an absolute self path and a path-keyed binding.
  const salt = 'a'.repeat(32),
    legacyLink =
      `self_context:\n  path: "${m.self.replaceAll('\\', '/')}"\n  access: "read"\n  proposals: "enabled"\n  index: "local"\n  binding_salt: "${salt}"\n` +
      'project_context:\n  include: []\n  exclude: []\n  assert_include: []\n  assert_exclude: []\n'
  mkdirSync(join(m.project, '.holoself'), { recursive: true })
  writeFileSync(join(m.project, '.holoself', 'link.yaml'), legacyLink)
  writeBinding(m.self, m.project, { default_lens: 'professional', secondary_lenses: [] })
  ok(m.cli(['link', 'approve', '--project', m.project, '--self', m.self]), 'approve')
  const legacyBindings = readFileSync(join(m.self, 'lenses', 'bindings.json'), 'utf8')
  const served = JSON.parse(ok(m.cli(['context', '--project', m.project, '--json']), 'legacy context').stdout)
  assert.equal(served.lens, 'professional')
  assert.match(JSON.stringify(served), new RegExp(SENTINEL))
  assert.equal(linkText(m.project), legacyLink, 'reading never rewrites a legacy link')
  assert.equal(readFileSync(join(m.self, 'lenses', 'bindings.json'), 'utf8'), legacyBindings)
  const doctorBefore = JSON.parse(m.cli(['link', 'doctor', '--project', m.project]).stdout)
  assert.equal(doctorBefore.path_keyed_bindings, 1)
  assert.match(m.cli(['doctor', '--root', m.self]).stdout, /1 lens binding\(s\) still keyed by absolute project path/)

  const dry = ok(m.cli(['link', 'repair', '--project', m.project, '--dry-run', '--no-activate']), 'repair dry-run')
  assert.match(dry.stdout, /portable_migration/)
  assert.equal(linkText(m.project), legacyLink, 'repair --dry-run writes nothing')
  ok(m.cli(['link', 'repair', '--project', m.project, '--yes', '--no-activate']), 'repair')
  const migrated = parseYaml(linkText(m.project))
  assert.equal(migrated.self_context.path, undefined, 'repair drops the machine path')
  assert.equal(migrated.self_context.self_id, selfIdOf(m.self))
  assert.equal(migrated.self_context.binding_salt, salt, 'the attested binding_salt is kept')
  assert.match(migrated.project_key, /^hs-proj-[0-9a-f]{32}$/)
  assert.deepEqual(bindingsOf(m.self), { [migrated.project_key]: { default_lens: 'professional', secondary_lenses: [] } })
  assert.equal(readRegistry(m.self).links[0].project_key, migrated.project_key)
  assert.equal(JSON.parse(ok(m.cli(['context', '--project', m.project, '--json']), 'migrated context').stdout).lens, 'professional')
  assert.equal(JSON.parse(m.cli(['link', 'doctor', '--project', m.project]).stdout).path_keyed_bindings, 0)
  assert.doesNotMatch(m.cli(['doctor', '--root', m.self]).stdout, /still keyed by absolute project path/)

  // Space discovery (Workbench catalog, lens bindings) still lists the project through the registry join.
  const bindings = JSON.parse(ok(m.cli(['lens', 'bindings', '--root', m.self]), 'lens bindings').stdout)
  assert.equal(bindings.projects[migrated.project_key], realpathSync(m.project).replaceAll('\\', '/'))
  const catalog = reconcileCatalog(m.self)
  assert.deepEqual(catalog.discovered, [realpathSync(m.project).replaceAll('\\', '/')])
  assert.equal(catalog.spaces[0].lens, 'professional')

  // lens bind/unbind and link remove act on the project_key entry.
  ok(m.cli(['lens', 'bind', '--root', m.self, '--project', m.project, '--lens', 'general', '--yes']), 'lens bind')
  assert.deepEqual(Object.keys(readBindings(m.self).bindings), [linkProjectKey(m.project)])
  ok(m.cli(['link', 'remove', '--project', m.project, '--yes']), 'link remove')
  assert.deepEqual(Object.keys(readBindings(m.self).bindings), [])
})

test('a portable link refuses approval by another self and a repair with a mismatched --self', t => {
  const base = sandbox(t),
    m = machine(base, 'm'),
    other = join(m.root, 'code', 'other-self')
  seedSelf(m)
  ok(m.cli(['init', '--root', other]), 'init other')
  ok(m.cli(['link', 'setup', '--project', m.project, '--self', m.self, '--no-activate', '--yes']), 'setup')
  const before = linkText(m.project)
  const approve = m.cli(['link', 'approve', '--project', m.project, '--self', other])
  assert.notEqual(approve.status, 0)
  assert.match(approve.stderr, /names a different self/)
  assert.deepEqual(readRegistry(other).links, [])
  const repair = m.cli(['link', 'repair', '--project', m.project, '--self', other, '--yes', '--no-activate'])
  assert.notEqual(repair.status, 0)
  assert.match(repair.stderr, /does not match canonical link root/)
  assert.equal(linkText(m.project), before)
})
