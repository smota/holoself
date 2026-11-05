// Portable links across machines (issue #131, docs/decisions/portable-links.md): self_id and project_key in synced
// files, the per-machine self map (selves.json), the resolution order, project_key-keyed bindings and migration.
// Every test uses its own temporary directories and its own HOLOSELF_CONFIG_DIR; synthetic data only.
import './helpers/isolated-config.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bindingProjects, readBindings, resolveBinding, writeBinding } from '../src/bindings.mjs'
import { linkProjectKey, readLink } from '../src/link/config.mjs'
import { breakStaleFileLock, forgetSelf, readFileLockState, readSelfMap, registerSelf, selfIdOf, withFileLockSync } from '../src/link/machine.mjs'
import { canonicalSpaceId, nextAllowedLenses, readRegistry, writeRegistry } from '../src/link/registry.mjs'
import { configureSpaceLink, spaceLinkConfiguration } from '../src/link/workbench.mjs'
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
  // link remove revokes this machine's attestation and keeps the shared project_key binding for other machines.
  const removed = ok(m.cli(['link', 'remove', '--project', m.project, '--yes']), 'link remove')
  assert.match(removed.stdout, /lens binding kept for other machines; run 'holoself lens unbind' to remove it everywhere/)
  assert.deepEqual(Object.keys(readBindings(m.self).bindings), [migrated.project_key])
  assert.equal(readRegistry(m.self).links[0].status, 'revoked')
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

// ---- Review fixes (PR #132) ----

const keyOf = project => parseYaml(linkText(project)).project_key
const copyProject = (from, to) => cpSync(from, to, { recursive: true })

test('a copied project folder gets a new project_key on setup and never touches the original binding', t => {
  const base = sandbox(t),
    m = machine(base, 'm'),
    copy = join(m.root, 'code', 'project-copy')
  seedSelf(m)
  ok(m.cli(['link', 'setup', '--project', m.project, '--self', m.self, '--lens', 'general', '--no-activate', '--yes']), 'setup original')
  const originalKey = keyOf(m.project)
  copyProject(m.project, copy)
  const setup = ok(m.cli(['link', 'setup', '--project', copy, '--self', m.self, '--lens', 'professional', '--no-activate', '--yes']), 'setup copy')
  assert.match(setup.stdout + setup.stderr, /already used by another project on this machine/)
  assert.notEqual(keyOf(copy), originalKey)
  assert.equal(JSON.parse(ok(m.cli(['context', '--project', m.project, '--json']), 'original').stdout).lens, 'general')
  assert.equal(JSON.parse(ok(m.cli(['context', '--project', copy, '--json']), 'copy').stdout).lens, 'professional')
  ok(m.cli(['link', 'remove', '--project', copy, '--yes']), 'remove copy')
  assert.equal(JSON.parse(ok(m.cli(['context', '--project', m.project, '--json']), 'original after remove').stdout).lens, 'general')
})

test('setup --force on a copy, approve and backfill on a copy also mint a new project_key', t => {
  const base = sandbox(t),
    m = machine(base, 'm')
  seedSelf(m)
  ok(m.cli(['link', 'setup', '--project', m.project, '--self', m.self, '--lens', 'general', '--no-activate', '--yes']), 'setup original')
  const originalKey = keyOf(m.project),
    originalBinding = bindingsOf(m.self)[originalKey]
  const forced = join(m.root, 'code', 'forced-copy'),
    approved = join(m.root, 'code', 'approved-copy'),
    backfilled = join(m.root, 'code', 'backfilled-copy')
  for (const dir of [forced, approved, backfilled]) copyProject(m.project, dir)
  ok(m.cli(['link', 'setup', '--project', forced, '--self', m.self, '--lens', 'professional', '--force', '--no-activate', '--yes']), 'forced')
  assert.notEqual(keyOf(forced), originalKey)
  // A copy that was never set up cannot rebind the original's shared binding.
  const rebind = m.cli(['lens', 'bind', '--root', m.self, '--project', approved, '--lens', 'professional', '--yes'])
  assert.notEqual(rebind.status, 0)
  assert.match(rebind.stderr, /already used by another project on this machine/)
  const approval = ok(m.cli(['link', 'approve', '--project', approved, '--self', m.self]), 'approve copy')
  assert.match(approval.stdout + approval.stderr, /already used by another project on this machine/)
  assert.notEqual(keyOf(approved), originalKey)
  ok(m.cli(['link', 'backfill', '--project', backfilled, '--self', m.self]), 'backfill copy')
  assert.notEqual(keyOf(backfilled), originalKey)
  const keys = readRegistry(m.self).links.map(entry => entry.project_key)
  assert.equal(keys.length, 4)
  assert.equal(new Set(keys).size, keys.length, 'every registry entry has its own project_key')
  assert.deepEqual(bindingsOf(m.self)[originalKey], originalBinding)
  assert.equal(JSON.parse(ok(m.cli(['context', '--project', m.project, '--json']), 'original').stdout).lens, 'general')
})

test('the Workbench configuration of a copied project does not inherit the original key, salt or binding', t => {
  const base = sandbox(t),
    m = machine(base, 'm'),
    copy = join(m.root, 'code', 'workbench-copy'),
    saved = process.env.HOLOSELF_CONFIG_DIR
  seedSelf(m)
  ok(m.cli(['link', 'setup', '--project', m.project, '--self', m.self, '--lens', 'professional', '--no-activate', '--yes']), 'setup original')
  copyProject(m.project, copy)
  process.env.HOLOSELF_CONFIG_DIR = m.config
  t.after(() => {
    if (saved === undefined) delete process.env.HOLOSELF_CONFIG_DIR
    else process.env.HOLOSELF_CONFIG_DIR = saved
  })
  const configuration = spaceLinkConfiguration(copy, realpathSync(m.self), { lens: 'general' })
  assert.equal(configuration.link.default_lens, 'general')
  assert.equal(configuration.binding_salt, null)
  configureSpaceLink(copy, realpathSync(m.self), configuration)
  assert.notEqual(keyOf(copy), keyOf(m.project))
  assert.equal(bindingsOf(m.self)[keyOf(m.project)].default_lens, 'professional')
})

test('bindingProjects skips revoked entries and fails closed when two active entries share a project_key', t => {
  const base = sandbox(t),
    m = machine(base, 'm')
  seedSelf(m)
  ok(m.cli(['link', 'setup', '--project', m.project, '--self', m.self, '--no-activate', '--yes']), 'setup')
  const key = keyOf(m.project),
    [entry] = readRegistry(m.self).links,
    other = { ...entry, project_id: 'hs-space-0000000000000000', project_path: '/elsewhere/other' }
  const bindings = readBindings(m.self).bindings
  assert.deepEqual(bindingProjects(bindings, [{ ...other, status: 'revoked' }, entry]).map(item => item.project), [entry.project_path])
  assert.deepEqual(bindingProjects(bindings, [other, entry]).map(item => item.project), [null])
  writeRegistry(m.self, links => [...links, other])
  assert.throws(() => resolveBinding(m.self, m.project, { projectKey: key }), error => error.code === 'PROJECT_KEY_CONFLICT')
  assert.deepEqual(reconcileCatalog(m.self).discovered, [])
})

test('joining a synced link prints the inherited lenses, and explicit lenses win', t => {
  const base = sandbox(t),
    a = machine(base, 'a'),
    b = machine(base, 'b'),
    c = machine(base, 'c')
  seedSelf(a)
  ok(a.cli(['link', 'setup', '--project', a.project, '--self', a.self, '--lens', 'general', '--secondary-lenses', 'professional', '--no-activate', '--yes']), 'A')
  for (const m of [b, c]) {
    syncSelf(a.self, m.self)
    syncProject(a.project, m.project)
  }
  const joined = ok(b.cli(['link', 'setup', '--project', b.project, '--self', b.self, '--no-activate', '--yes']), 'B')
  assert.match(joined.stdout, new RegExp(`joining existing project ${keyOf(a.project)}: lenses general, professional`))
  assert.deepEqual(readRegistry(b.self).links[0].allowed_lenses, ['general', 'professional'])
  ok(c.cli(['link', 'setup', '--project', c.project, '--self', c.self, '--lens', 'leadership', '--no-activate', '--yes']), 'C')
  assert.deepEqual(readRegistry(c.self).links[0].allowed_lenses, ['leadership'])
})

test('link repair grants lenses newly bound on another machine', t => {
  const base = sandbox(t),
    m = machine(base, 'm')
  seedSelf(m)
  ok(m.cli(['link', 'setup', '--project', m.project, '--self', m.self, '--lens', 'general', '--no-activate', '--yes']), 'setup')
  // Another machine ran lens bind; the synced binding now names a lens this machine never granted.
  writeBinding(m.self, m.project, { default_lens: 'professional', secondary_lenses: [] }, { projectKey: keyOf(m.project) })
  assert.notEqual(m.cli(['context', '--project', m.project, '--json']).status, 0)
  const dry = ok(m.cli(['link', 'repair', '--project', m.project, '--dry-run', '--no-activate']), 'repair dry-run')
  assert.match(dry.stdout, /grant_update/)
  assert.deepEqual(readRegistry(m.self).links[0].allowed_lenses, ['general'])
  ok(m.cli(['link', 'repair', '--project', m.project, '--yes', '--accept-shared-lenses', '--no-activate']), 'repair')
  assert.deepEqual(readRegistry(m.self).links[0].allowed_lenses, ['professional'])
  assert.equal(JSON.parse(ok(m.cli(['context', '--project', m.project, '--json']), 'context').stdout).lens, 'professional')
})

test('validate reports selectedContribs and self_id errors independently', t => {
  const base = sandbox(t),
    m = machine(base, 'm')
  seedSelf(m)
  const config = join(m.self, 'config.json'),
    original = JSON.parse(readFileSync(config, 'utf8'))
  writeFileSync(config, JSON.stringify({ ...original, selectedContribs: null }))
  const nullContribs = m.cli(['validate', '--root', m.self])
  assert.equal(nullContribs.status, 1)
  assert.match(nullContribs.stdout + nullContribs.stderr, /selectedContribs must be an array/)
  assert.doesNotMatch(nullContribs.stderr, /TypeError|not iterable/)
  writeFileSync(config, JSON.stringify({ ...original, selectedContribs: ['no-such-contrib'], self_id: 'bad' }))
  const both = m.cli(['validate', '--root', m.self])
  assert.match(both.stdout + both.stderr, /unknown selected contrib: no-such-contrib/)
  assert.match(both.stdout + both.stderr, /config self_id must be hs-self-/)
})

test('SELF_NOT_FOUND names an unusable self map in the CLI, never in hook output', t => {
  const base = sandbox(t),
    m = machine(base, 'm')
  seedSelf(m)
  ok(m.cli(['link', 'setup', '--project', m.project, '--self', m.self, '--no-activate', '--yes']), 'setup')
  writeFileSync(join(m.config, 'selves.json'), '{ not json')
  const refused = m.cli(['context', '--project', m.project, '--json'])
  assert.match(refused.stderr, /has no checkout registered on this machine.*selves\.json is malformed/)
  const hook = m.cli(['context', '--hook', 'holoself-session-start', '--project', m.project])
  assert.deepEqual([hook.status, hook.stdout, hook.stderr], [0, '', ''])
})

test('breaking a stale lock never deletes a fresh lock taken by another waiter', t => {
  const base = sandbox(t),
    lock = join(base, 'selves.json.lock')
  writeFileSync(lock, JSON.stringify({ pid: 999999999, hostname: 'another-host', created: Date.now() - 60000, nonce: 'old' }) + '\n')
  // Two waiters judge the same lock stale.
  const first = readFileLockState(lock),
    second = readFileLockState(lock)
  assert.equal(first.stale, true)
  assert.equal(breakStaleFileLock(lock, first), true)
  // The first waiter takes a fresh lock before the second waiter acts on its outdated judgement.
  const fresh = JSON.stringify({ pid: process.pid, hostname: 'another-host', created: Date.now(), nonce: 'fresh' }) + '\n'
  writeFileSync(lock, fresh, { flag: 'wx' })
  assert.equal(breakStaleFileLock(lock, second), false)
  assert.equal(readFileSync(lock, 'utf8'), fresh)
  // A recent lock from another host is never judged stale by its PID.
  writeFileSync(lock, JSON.stringify({ pid: 999999999, hostname: 'another-host', created: Date.now(), nonce: 'x' }) + '\n')
  assert.equal(readFileLockState(lock).stale, false)
})

// ---- Second review round (PR #132) ----

const allowedOf = self => readRegistry(self).links[0].allowed_lenses

test('link repair never widens an owner-narrowed grant without --accept-shared-lenses', t => {
  const base = sandbox(t),
    m = machine(base, 'm')
  seedSelf(m)
  ok(m.cli(['link', 'setup', '--project', m.project, '--self', m.self, '--lens', 'general', '--secondary-lenses', 'professional', '--no-activate', '--yes']), 'setup')
  ok(m.cli(['link', 'approve', '--project', m.project, '--self', m.self, '--lenses', 'general']), 'narrow')
  assert.deepEqual(allowedOf(m.self), ['general'])
  const repaired = ok(m.cli(['link', 'repair', '--project', m.project, '--no-activate', '--yes']), 'repair --yes')
  assert.deepEqual(allowedOf(m.self), ['general'], '--yes alone never widens')
  assert.match(
    repaired.stdout,
    /\[note\] shared binding adds lenses not granted on this machine: professional; run 'holoself link repair --project <dir> --accept-shared-lenses' to grant them/
  )
  const grant = JSON.parse(repaired.stdout.match(/^\{\n  "grant_update"[\s\S]*?^\}$/m)[0]).grant_update
  assert.deepEqual([grant.adds, grant.removes, grant.applied], [['professional'], [], false])
  assert.notEqual(m.cli(['context', '--project', m.project, '--lens', 'professional', '--json']).status, 0)
  // Interactive confirmation is not possible here; without --yes the dedicated widening question refuses.
  assert.notEqual(m.cli(['link', 'repair', '--project', m.project, '--no-activate', '--accept-shared-lenses']).status, 0)
  assert.deepEqual(allowedOf(m.self), ['general'])
  const accepted = ok(m.cli(['link', 'repair', '--project', m.project, '--no-activate', '--accept-shared-lenses', '--yes']), 'accept')
  assert.match(accepted.stdout, /adds: \[professional\] \/ removes: \[\]/)
  assert.deepEqual(allowedOf(m.self), ['general', 'professional'])
  ok(m.cli(['context', '--project', m.project, '--lens', 'professional', '--json']), 'professional served after acceptance')
})

test('link repair applies a narrowed shared binding automatically', t => {
  const base = sandbox(t),
    m = machine(base, 'm')
  seedSelf(m)
  ok(m.cli(['link', 'setup', '--project', m.project, '--self', m.self, '--lens', 'general', '--secondary-lenses', 'professional', '--no-activate', '--yes']), 'setup')
  writeBinding(m.self, m.project, { default_lens: 'general', secondary_lenses: [] }, { projectKey: keyOf(m.project) })
  const repaired = ok(m.cli(['link', 'repair', '--project', m.project, '--no-activate']), 'repair without --yes')
  assert.match(repaired.stdout, /"removes": \[\n\s+"professional"\n\s+\]/)
  assert.deepEqual(allowedOf(m.self), ['general'])
})

test('a copy of a project attested before project_key was recorded gets its own key', t => {
  const base = sandbox(t),
    m = machine(base, 'm'),
    copy = join(m.root, 'code', 'legacy-copy')
  seedSelf(m)
  ok(m.cli(['link', 'setup', '--project', m.project, '--self', m.self, '--lens', 'general', '--no-activate', '--yes']), 'setup')
  // A registry entry written before #131 (or before this machine repaired the synced link) has no project_key.
  writeRegistry(m.self, links => links.map(({ project_key: _key, ...entry }) => entry))
  copyProject(m.project, copy)
  const setup = ok(m.cli(['link', 'setup', '--project', copy, '--self', m.self, '--lens', 'professional', '--no-activate', '--yes']), 'setup copy')
  assert.match(setup.stderr, /already used by another project on this machine/)
  assert.notEqual(keyOf(copy), keyOf(m.project))
  assert.equal(JSON.parse(ok(m.cli(['context', '--project', m.project, '--json']), 'original').stdout).lens, 'general')
})

test('link repair on the copy resolves a project_key conflict and keeps the original', t => {
  const base = sandbox(t),
    m = machine(base, 'm'),
    copy = join(m.root, 'code', 'conflicting-copy')
  seedSelf(m)
  ok(m.cli(['link', 'setup', '--project', m.project, '--self', m.self, '--lens', 'general', '--no-activate', '--yes']), 'setup')
  const originalKey = keyOf(m.project)
  copyProject(m.project, copy)
  // The state an earlier build could leave: the copy attested under the original's key, later than the original.
  const [entry] = readRegistry(m.self).links
  writeRegistry(m.self, links => [
    ...links,
    { ...entry, project_id: canonicalSpaceId(copy), project_path: realpathSync(copy).replaceAll('\\', '/'), created_at: new Date(Date.now() + 1000).toISOString() }
  ])
  assert.notEqual(m.cli(['context', '--project', m.project, '--json']).status, 0, 'both fail closed while the key is shared')
  const repaired = ok(m.cli(['link', 'repair', '--project', copy, '--no-activate', '--yes']), 'repair copy')
  assert.match(repaired.stderr, /already used by another project on this machine/)
  assert.notEqual(keyOf(copy), originalKey)
  assert.equal(keyOf(m.project), originalKey)
  const keys = readRegistry(m.self).links.map(item => item.project_key)
  assert.deepEqual(keys.sort(), [originalKey, keyOf(copy)].sort())
  assert.equal(JSON.parse(ok(m.cli(['context', '--project', m.project, '--json']), 'original restored').stdout).lens, 'general')
})

test('approve and backfill never rewrite a link that names another self', t => {
  const base = sandbox(t),
    m = machine(base, 'm'),
    other = join(m.root, 'code', 'other-self')
  seedSelf(m)
  ok(m.cli(['init', '--root', other]), 'init other')
  ok(m.cli(['link', 'setup', '--project', m.project, '--self', m.self, '--no-activate', '--yes']), 'setup')
  const [entry] = readRegistry(m.self).links
  // The other self's registry already holds this key for another path, so a renewal would be due if the self matched.
  writeRegistry(other, [{ ...entry, project_id: 'hs-space-0000000000000000', project_path: '/elsewhere/project' }])
  const before = linkText(m.project)
  assert.notEqual(m.cli(['link', 'approve', '--project', m.project, '--self', other]).status, 0)
  assert.equal(linkText(m.project), before)
  ok(m.cli(['link', 'backfill', '--project', m.project, '--self', other]), 'backfill skips')
  assert.equal(linkText(m.project), before)
})

test('the self map lock retries transient filesystem errors instead of failing', t => {
  const base = sandbox(t),
    lock = join(base, 'selves.json.lock')
  writeFileSync(lock, JSON.stringify({ created: Date.now() - 60000, nonce: 'old' }) + '\n')
  let renames = 0
  const ops = {
    renameSync: (from, to) => {
      renames++
      if (renames <= 2) throw Object.assign(new Error('busy'), { code: 'EPERM' })
      return renameSync(from, to)
    }
  }
  assert.equal(withFileLockSync(lock, () => 'held', ops), 'held')
  assert.ok(renames >= 3)
  assert.equal(existsSync(lock), false)
  // Without hard links the lock is not restored; acquisition is simply retried.
  writeFileSync(lock, JSON.stringify({ created: Date.now() - 60000, nonce: 'old' }) + '\n')
  const judged = readFileLockState(lock)
  writeFileSync(lock, JSON.stringify({ created: Date.now(), nonce: 'fresh' }) + '\n')
  const noLinks = { linkSync: () => { throw Object.assign(new Error('no links'), { code: 'ENOTSUP' }) } }
  assert.equal(breakStaleFileLock(lock, judged, noLinks), false)
})

// ---- Third review round (PR #132): one grant rule for every attestation path ----

const grantBlock = stdout => JSON.parse(stdout.match(/^\{\n  "grant_update"[\s\S]*?^\}$/m)[0]).grant_update
// A project whose shared binding is general + professional while this machine's grant was narrowed to general.
function narrowed(m) {
  seedSelf(m)
  ok(m.cli(['link', 'setup', '--project', m.project, '--self', m.self, '--lens', 'general', '--secondary-lenses', 'professional', '--no-activate', '--yes']), 'setup')
  ok(m.cli(['link', 'approve', '--project', m.project, '--self', m.self, '--lenses', 'general']), 'narrow')
  assert.deepEqual(allowedOf(m.self), ['general'])
}
const noteRe = command => new RegExp(`\\[note\\] shared binding adds lenses not granted on this machine: professional; run 'holoself link ${command} --project <dir> --accept-shared-lenses' to grant them`)

test('link approve keeps a narrowed grant unless --accept-shared-lenses or --lenses says otherwise', t => {
  const m = machine(sandbox(t), 'm')
  narrowed(m)
  const again = ok(m.cli(['link', 'approve', '--project', m.project, '--self', m.self]), 'approve')
  assert.deepEqual(allowedOf(m.self), ['general'])
  assert.match(again.stdout, noteRe('approve'))
  assert.deepEqual(grantBlock(again.stdout).adds, ['professional'])
  ok(m.cli(['link', 'approve', '--project', m.project, '--self', m.self, '--accept-shared-lenses']), 'accept')
  assert.deepEqual(allowedOf(m.self), ['general', 'professional'])
  ok(m.cli(['link', 'approve', '--project', m.project, '--self', m.self, '--lenses', 'professional']), 'explicit')
  assert.deepEqual(allowedOf(m.self), ['professional'])
})

test('link setup keeps a narrowed grant unless --accept-shared-lenses or --lens says otherwise', t => {
  const m = machine(sandbox(t), 'm'),
    setup = (...extra) => m.cli(['link', 'setup', '--project', m.project, '--self', m.self, '--no-activate', '--yes', ...extra])
  narrowed(m)
  assert.match(ok(setup(), 'setup again').stdout, noteRe('setup'))
  assert.deepEqual(allowedOf(m.self), ['general'])
  ok(setup('--accept-shared-lenses'), 'accept')
  assert.deepEqual(allowedOf(m.self), ['general', 'professional'])
  ok(setup('--lens', 'leadership'), 'explicit')
  assert.deepEqual(allowedOf(m.self), ['leadership'])
})

test('link backfill never widens without the flag; with it, --all prints the adds per project', t => {
  const m = machine(sandbox(t), 'm')
  narrowed(m)
  const single = ok(m.cli(['link', 'backfill', '--project', m.project, '--self', m.self]), 'backfill')
  assert.match(single.stdout, noteRe('backfill'))
  assert.deepEqual(allowedOf(m.self), ['general'])
  ok(m.cli(['link', 'backfill', '--all', '--self', m.self]), 'backfill --all')
  assert.deepEqual(allowedOf(m.self), ['general'])
  const accepted = ok(m.cli(['link', 'backfill', '--all', '--self', m.self, '--accept-shared-lenses']), 'accept')
  assert.equal(grantBlock(accepted.stdout).project, realpathSync(m.project).replaceAll('\\', '/'))
  assert.match(accepted.stdout, /adds: \[professional\] \/ removes: \[\]/)
  assert.deepEqual(allowedOf(m.self), ['general', 'professional'])
  ok(m.cli(['link', 'backfill', '--project', m.project, '--self', m.self, '--lenses', 'general']), 'explicit')
  assert.deepEqual(allowedOf(m.self), ['general'])
})

test('the Workbench configuration keeps a narrowed grant', t => {
  const m = machine(sandbox(t), 'm'),
    saved = process.env.HOLOSELF_CONFIG_DIR
  narrowed(m)
  process.env.HOLOSELF_CONFIG_DIR = m.config
  t.after(() => {
    if (saved === undefined) delete process.env.HOLOSELF_CONFIG_DIR
    else process.env.HOLOSELF_CONFIG_DIR = saved
  })
  const self = realpathSync(m.self)
  const configuration = spaceLinkConfiguration(m.project, self, {})
  assert.deepEqual(configuration.grant_update.adds, ['professional'])
  configureSpaceLink(m.project, self, configuration)
  assert.deepEqual(allowedOf(m.self), ['general'])
  configureSpaceLink(m.project, self, spaceLinkConfiguration(m.project, self, { explicitLens: 'general', secondaryLenses: ['professional'] }))
  assert.deepEqual(allowedOf(m.self), ['general', 'professional'])
})

test('legacy lens fields in link.yaml never choose a grant on an existing entry', t => {
  const m = machine(sandbox(t), 'm')
  narrowed(m)
  const file = join(m.project, '.holoself', 'link.yaml'),
    original = readFileSync(file, 'utf8'),
    legacy = fields => original.replace('  access:', `${fields}  access:`)
  // Repro 1: legacy fields equal to the binding, narrowed grant.
  writeFileSync(file, legacy('  default_lens: general\n  secondary_lenses: [professional]\n'))
  const first = ok(m.cli(['link', 'repair', '--project', m.project, '--no-activate', '--yes']), 'repair legacy fields')
  assert.match(first.stdout, noteRe('repair'))
  assert.deepEqual(allowedOf(m.self), ['general'])
  // Repro 2: a committed client file names a lens the owner never granted, and no binding exists.
  writeBinding(m.self, m.project, null, { projectKey: keyOf(m.project) })
  writeFileSync(file, legacy('  default_lens: public-voice\n'))
  const second = ok(m.cli(['link', 'repair', '--project', m.project, '--no-activate', '--yes']), 'repair public-voice')
  assert.deepEqual(allowedOf(m.self), [], 'the grant follows the rule: nothing beyond it, and general left the binding')
  assert.match(second.stdout, /no lenses are granted to this project on this machine/)
  assert.notEqual(m.cli(['context', '--project', m.project, '--lens', 'public-voice', '--json']).status, 0)
  // An explicit choice on the command sets the grant to exactly that choice.
  ok(m.cli(['link', 'repair', '--project', m.project, '--no-activate', '--yes', '--lens', 'general']), 'explicit repair')
  assert.deepEqual(allowedOf(m.self), ['general'])
})

test('new and revoked entries: lenses are listed, and re-attestation caps at the old grant', t => {
  const m = machine(sandbox(t), 'm')
  seedSelf(m)
  const first = ok(m.cli(['link', 'setup', '--project', m.project, '--self', m.self, '--lens', 'general', '--secondary-lenses', 'professional', '--no-activate', '--yes']), 'setup')
  assert.match(first.stdout, /granting lenses on this machine: general, professional/)
  ok(m.cli(['link', 'approve', '--project', m.project, '--self', m.self, '--lenses', 'general']), 'narrow')
  ok(m.cli(['link', 'approve', '--project', m.project, '--self', m.self, '--revoke']), 'revoke')
  const back = ok(m.cli(['link', 'approve', '--project', m.project, '--self', m.self]), 're-attest')
  assert.equal(readRegistry(m.self).links[0].status, 'active')
  assert.deepEqual(allowedOf(m.self), ['general'], 're-attestation does not overwrite the old grant')
  assert.match(back.stdout, noteRe('approve'))
  // Nothing of the old grant is still bound: the owner is attesting anew, with the lenses listed.
  ok(m.cli(['link', 'approve', '--project', m.project, '--self', m.self, '--revoke']), 'revoke again')
  writeBinding(m.self, m.project, { default_lens: 'leadership', secondary_lenses: [] }, { projectKey: keyOf(m.project) })
  const fresh = ok(m.cli(['link', 'approve', '--project', m.project, '--self', m.self]), 're-attest anew')
  assert.match(fresh.stdout, /granting lenses on this machine: leadership/)
  assert.deepEqual(allowedOf(m.self), ['leadership'])
})

test('every registry allowed_lenses writer goes through nextAllowedLenses', () => {
  const root = fileURLToPath(new URL('../src/', import.meta.url))
  for (const rel of ['cli/commands/link/add.mjs', 'cli/commands/link/approve.mjs', 'cli/commands/link/backfill.mjs', 'cli/commands/link/repair.mjs', 'cli/commands/link/setup.mjs', 'cli/commands/lens.mjs', 'link/workbench.mjs']) {
    const text = readFileSync(join(root, rel), 'utf8')
    assert.match(text, /nextAllowedLenses/, rel)
    for (const [line] of text.matchAll(/^.*\ballowed_lenses:.*$/gm)) assert.match(line, /allowed_lenses: (grant\.allowed|\[\],)/, `${rel}: ${line.trim()}`)
  }
})

test('a recorded project_key always beats one known only through a link.yaml', t => {
  const m = machine(sandbox(t), 'm'),
    older = join(m.root, 'code', 'older-keyless')
  seedSelf(m)
  ok(m.cli(['link', 'setup', '--project', m.project, '--self', m.self, '--lens', 'general', '--no-activate', '--yes']), 'setup victim')
  mkdirSync(older, { recursive: true })
  ok(m.cli(['link', 'setup', '--project', older, '--self', m.self, '--lens', 'general', '--no-activate', '--yes']), 'setup older')
  const victimKey = keyOf(m.project),
    file = join(older, '.holoself', 'link.yaml')
  // An older entry with no recorded key whose link.yaml was crafted to carry the victim's key.
  writeRegistry(m.self, links =>
    links.map(entry => {
      if (entry.project_path !== realpathSync(older).replaceAll('\\', '/')) return entry
      const { project_key: _key, ...keyless } = entry
      return { ...keyless, created_at: '2000-01-01T00:00:00.000Z' }
    })
  )
  writeFileSync(file, linkText(older).replace(/^project_key:.*$/m, `project_key: "${victimKey}"`))
  ok(m.cli(['context', '--project', m.project, '--json']), 'the victim keeps working')
  ok(m.cli(['link', 'repair', '--project', m.project, '--no-activate', '--yes']), 'repair victim')
  assert.equal(keyOf(m.project), victimKey, 'repair on the recorded holder keeps its key')
  ok(m.cli(['link', 'repair', '--project', older, '--no-activate', '--yes']), 'repair older')
  assert.notEqual(keyOf(older), victimKey, 'repair on the keyless entry renews its key')
  assert.equal(keyOf(m.project), victimKey)
})

test('only lenses named on the command count as explicit', t => {
  const m = machine(sandbox(t), 'm'),
    setup = (...extra) => m.cli(['link', 'setup', '--project', m.project, '--self', m.self, '--no-activate', '--yes', ...extra])
  narrowed(m)
  ok(m.cli(['link', 'approve', '--project', m.project, '--self', m.self, '--lenses', 'professional']), 'narrow away from the default')
  // --secondary-lenses alone: the named lenses are granted, the inherited default stays an add.
  const named = ok(setup('--secondary-lenses', 'professional,leadership'), 'secondary only')
  assert.deepEqual(allowedOf(m.self), ['professional', 'leadership'])
  assert.match(named.stdout, /shared binding adds lenses not granted on this machine: general;/)
  assert.deepEqual(grantBlock(named.stdout).adds, ['general', 'leadership'])
  assert.equal(grantBlock(named.stdout).applied, false)
  ok(setup('--secondary-lenses', 'professional,leadership', '--accept-shared-lenses'), 'accepted')
  assert.deepEqual(allowedOf(m.self), ['general', 'professional', 'leadership'])
  // The full set named replaces the grant.
  ok(setup('--lens', 'general', '--secondary-lenses', 'leadership'), 'full set')
  assert.deepEqual(allowedOf(m.self), ['general', 'leadership'])
  // --lens alone with inherited secondaries (the Workbench keeps them): the secondaries stay adds.
  const entry = { status: 'active', allowed_lenses: ['general'] }
  assert.deepEqual(nextAllowedLenses({ entry, lenses: ['leadership', 'professional'], named: ['leadership'] }).allowed, ['leadership'])
  assert.deepEqual(nextAllowedLenses({ entry, lenses: ['general', 'professional'], named: ['general'] }).pending, ['professional'])
  // A named lens outside the binding is not granted, and a partly named revoked entry stays capped.
  assert.deepEqual(nextAllowedLenses({ entry, lenses: ['general'], named: ['leadership'] }).allowed, ['general'])
  assert.deepEqual(
    nextAllowedLenses({ entry: { status: 'revoked', allowed_lenses: ['general'] }, lenses: ['leadership', 'professional'], named: ['leadership'] }).allowed,
    ['leadership']
  )
})
