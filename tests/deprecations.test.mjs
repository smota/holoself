// Issue #108 (0.11.0 stage of docs/decisions/privacy-fields-and-legacy-mount.md): deprecation warnings for the legacy
// privacy fields and the legacy live mount. Behaviour is otherwise unchanged. Synthetic fixtures only.
import './helpers/isolated-config.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from '../src/cli.mjs'
import { deprecatedFieldWarnings } from '../src/catalog/validation.mjs'
import { LEGACY_MOUNT_DEPRECATION, LEGACY_MOUNT_REMOVAL_VERSION } from '../src/link/config.mjs'

const temp = () => mkdtemp(join(tmpdir(), 'holoself-deprecations-'))
async function capture(fn) {
  const log = console.log,
    error = console.error
  let out = '',
    err = ''
  console.log = (...x) => {
    out += x.join(' ') + '\n'
  }
  console.error = (...x) => {
    err += x.join(' ') + '\n'
  }
  try {
    await fn()
  } finally {
    console.log = log
    console.error = error
  }
  return { out, err }
}

test('validate warns once per document and deprecated field, with root-relative paths, and stays valid', async () => {
  const root = await temp()
  await capture(() => run(['init', '--root', root]))
  await mkdir(join(root, 'topics', 'deep'), { recursive: true })
  await writeFile(
    join(root, 'context', 'legacy.md'),
    '---\nvisibility: professional\npublic_safe: true\nfield_visibility:\n  Salary: private\n---\n# Legacy\n\n' +
      '<!-- holoself-claim visibility=private -->\nOne claim.\n<!-- /holoself-claim -->\n\n<!-- holoself-claim visibility=public-safe -->\nTwo claim.\n<!-- /holoself-claim -->\n'
  )
  await writeFile(join(root, 'topics', 'deep', 'note.md'), '---\nvisibility: private\n---\n# Note\n')
  const { out, err } = await capture(() => run(['validate', '--root', root]))
  assert.doesNotMatch(out, /deprecated/, 'deprecation notices go to stderr')
  const lines = err.split('\n').filter(Boolean)
  assert.deepEqual(lines, [
    '[warn] deprecated field visibility in context/legacy.md: maps to access_lenses, read_scope and disclosure; rejected in 0.13.0; run holoself migrate policy --dry-run',
    '[warn] deprecated field public_safe in context/legacy.md: maps to disclosure; rejected in 0.13.0; run holoself migrate policy --dry-run',
    '[warn] deprecated field field_visibility in context/legacy.md: maps to field_access; rejected in 0.13.0; holoself migrate policy rewrites it; run holoself migrate policy --dry-run',
    '[warn] deprecated claim marker attribute visibility= in context/legacy.md (2 markers): maps to access_lenses and disclosure marker attributes; rejected in 0.13.0; holoself migrate policy rewrites them; run holoself migrate policy --dry-run',
    '[warn] deprecated field visibility in topics/deep/note.md: maps to access_lenses, read_scope and disclosure; rejected in 0.13.0; run holoself migrate policy --dry-run'
  ])
  assert.ok(!lines.join('\n').includes(root), 'no absolute paths')
  assert.match(out, /\[ok\] .* is valid/)
  assert.equal(process.exitCode ?? 0, 0)
})

test('a fresh data root and migrated documents produce no deprecation warnings', async () => {
  const root = await temp()
  await capture(() => run(['init', '--root', root]))
  assert.deepEqual(deprecatedFieldWarnings(root), [])
  await writeFile(join(root, 'context', 'legacy.md'), '---\nvisibility: public-voice\npublic_safe: false\n---\n# Legacy\n')
  assert.equal(deprecatedFieldWarnings(root).length, 2)
  const plan = JSON.parse((await capture(() => run(['migrate', 'policy', '--root', root]))).out)
  await capture(() => run(['migrate', 'policy', '--root', root, '--apply', plan.plan_id]))
  assert.deepEqual(deprecatedFieldWarnings(root), [])
})

test('link --target and unlink --target print the deprecation warning on every run, including --dry-run', async () => {
  assert.equal(LEGACY_MOUNT_REMOVAL_VERSION, '0.13.0')
  assert.match(LEGACY_MOUNT_DEPRECATION, /removed in 0\.13\.0/)
  assert.match(LEGACY_MOUNT_DEPRECATION, /holoself link setup --project <dir> --self <path>/)
  const root = await temp(),
    project = await temp()
  await capture(() => run(['init', '--root', root]))
  const warning = `[warn] ${LEGACY_MOUNT_DEPRECATION}\n`
  const dry = await capture(() => run(['link', '--root', root, '--target', project, '--dry-run', '--yes']))
  assert.equal(dry.err, warning)
  assert.match(dry.out, /\[dry-run\] linked/)
  await assert.rejects(lstat(join(project, '.holoself')), 'dry run creates nothing')
  const real = await capture(() => run(['link', '--root', root, '--target', project, '--yes']))
  assert.equal(real.err, warning)
  assert.ok((await lstat(join(project, '.holoself'))).isSymbolicLink(), 'behaviour unchanged')
  const unlinkDry = await capture(() => run(['unlink', '--root', root, '--target', project, '--dry-run', '--yes']))
  assert.equal(unlinkDry.err, warning)
  const unlink = await capture(() => run(['unlink', '--root', root, '--target', project, '--yes']))
  assert.equal(unlink.err, warning)
  await assert.rejects(lstat(join(project, '.holoself')))
})

test('LEGACY_MOUNT_DETECTED and legacy-mount status carry the deprecation warning', async () => {
  const root = await temp(),
    project = await temp()
  await capture(() => run(['init', '--root', root]))
  await symlink(root, join(project, '.holoself'), 'dir')
  await assert.rejects(
    run(['context', '--project', project, '--json']),
    error => error.code === 'LEGACY_MOUNT_DETECTED' && error.message.includes(LEGACY_MOUNT_DEPRECATION)
  )
  const status = JSON.parse((await capture(() => run(['link', 'status', '--project', project]))).out)
  assert.equal(status.mode, 'legacy-mount')
  assert.equal(status.deprecation, LEGACY_MOUNT_DEPRECATION)
  assert.ok(status.errors.every(e => e.includes(LEGACY_MOUNT_DEPRECATION)))
})
