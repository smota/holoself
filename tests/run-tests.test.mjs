import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const runner = join(root, 'scripts', 'run-tests.mjs')

test('run-tests.mjs isolates TMPDIR/TMP/TEMP per run, removes the run root afterwards, and propagates exit codes', () => {
  const sandbox = mkdtempSync(join(os.tmpdir(), 'holoself-runner-sandbox-'))
  try {
    const tmpParent = join(sandbox, 'parent-tmp')
    const fixturesDir = join(sandbox, 'fixtures')
    const reportFile = join(sandbox, 'report.json')
    mkdirSync(tmpParent, { recursive: true })
    mkdirSync(fixturesDir, { recursive: true })

    const passFixture = join(fixturesDir, 'pass.fixture.mjs')
    writeFileSync(
      passFixture,
      [
        "import test from 'node:test'",
        "import assert from 'node:assert/strict'",
        "import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'",
        "import os from 'node:os'",
        "import { join } from 'node:path'",
        "test('passing fixture creates temp dir', () => {",
        "  const dir = mkdtempSync(join(os.tmpdir(), 'holoself-leaked-'))",
        "  writeFileSync(join(dir, 'marker.txt'), 'ok')",
        "  assert.equal(existsSync(dir), true)",
        "  writeFileSync(process.env.FIXTURE_REPORT_FILE, JSON.stringify({ runRoot: os.tmpdir(), leakedDir: dir }))",
        '})'
      ].join('\n') + '\n'
    )

    const failFixture = join(fixturesDir, 'fail.fixture.mjs')
    writeFileSync(
      failFixture,
      [
        "import test from 'node:test'",
        "import assert from 'node:assert/strict'",
        "import { mkdtempSync, writeFileSync } from 'node:fs'",
        "import os from 'node:os'",
        "import { join } from 'node:path'",
        "test('failing fixture creates temp dir and fails', () => {",
        "  const dir = mkdtempSync(join(os.tmpdir(), 'holoself-leaked-fail-'))",
        "  writeFileSync(process.env.FIXTURE_REPORT_FILE, JSON.stringify({ runRoot: os.tmpdir(), leakedDir: dir }))",
        "  assert.fail('intentional fixture failure')",
        '})'
      ].join('\n') + '\n'
    )

    const baseEnv = {
      ...process.env,
      TMPDIR: tmpParent,
      TMP: tmpParent,
      TEMP: tmpParent,
      FIXTURE_REPORT_FILE: reportFile
    }
    delete baseEnv.HOLOSELF_KEEP_TEST_TMP
    delete baseEnv.NODE_TEST_CONTEXT

    const passResult = spawnSync(process.execPath, [runner, passFixture], {
      cwd: root,
      env: baseEnv,
      encoding: 'utf8',
      windowsHide: true
    })
    assert.equal(passResult.status, 0, passResult.stderr || passResult.stdout)
    const passReport = JSON.parse(readFileSync(reportFile, 'utf8'))
    assert.equal(passReport.runRoot.startsWith(join(tmpParent, 'holoself-test-run-')), true)
    assert.equal(existsSync(passReport.runRoot), false, 'expected run root to be removed after passing run')
    assert.equal(existsSync(passReport.leakedDir), false, 'expected fixture temp dir to be removed after passing run')
    assert.deepEqual(readdirSync(tmpParent), [])

    const failResult = spawnSync(process.execPath, [runner, failFixture], {
      cwd: root,
      env: baseEnv,
      encoding: 'utf8',
      windowsHide: true
    })
    assert.notEqual(failResult.status, 0, 'expected non-zero exit code for failing fixture')
    const failReport = JSON.parse(readFileSync(reportFile, 'utf8'))
    assert.equal(failReport.runRoot.startsWith(join(tmpParent, 'holoself-test-run-')), true)
    assert.equal(existsSync(failReport.runRoot), false, 'expected run root to be removed after failing run')
    assert.equal(existsSync(failReport.leakedDir), false, 'expected fixture temp dir to be removed after failing run')
    assert.deepEqual(readdirSync(tmpParent), [])

    const keepResult = spawnSync(process.execPath, [runner, passFixture], {
      cwd: root,
      env: { ...baseEnv, HOLOSELF_KEEP_TEST_TMP: '1' },
      encoding: 'utf8',
      windowsHide: true
    })
    assert.equal(keepResult.status, 0, keepResult.stderr || keepResult.stdout)
    const keepReport = JSON.parse(readFileSync(reportFile, 'utf8'))
    const keptRoot = keepReport.runRoot
    try {
      assert.equal(existsSync(keptRoot), true, 'expected run root to be kept when HOLOSELF_KEEP_TEST_TMP=1')
      assert.equal(keepResult.stdout.includes(keptRoot), true, 'expected runner to print kept run root path')
    } finally {
      rmSync(keptRoot, { recursive: true, force: true })
    }

    const realTmp = join(sandbox, 'real-tmp')
    const linkTmp = join(sandbox, 'link-tmp')
    mkdirSync(realTmp, { recursive: true })
    let canSymlink = true
    try {
      symlinkSync(realTmp, linkTmp, 'junction')
    } catch (error) {
      if (error.code === 'EPERM') canSymlink = false
      else throw error
    }
    if (canSymlink) {
      const symlinkResult = spawnSync(
        process.execPath,
        [runner, join(root, 'tests', 'symlinked-ancestor.test.mjs')],
        {
          cwd: root,
          env: { ...baseEnv, TMPDIR: linkTmp, TMP: linkTmp, TEMP: linkTmp },
          encoding: 'utf8',
          windowsHide: true
        }
      )
      assert.equal(symlinkResult.status, 0, symlinkResult.stderr || symlinkResult.stdout)
      assert.deepEqual(readdirSync(realTmp), [])
    }

    const slowFixture = join(fixturesDir, 'slow.fixture.mjs')
    writeFileSync(
      slowFixture,
      [
        "import test from 'node:test'",
        "test('slow fixture exceeds overridden timeout', async () => {",
        '  await new Promise(resolve => setTimeout(resolve, 400))',
        '})'
      ].join('\n') + '\n'
    )
    const timeoutResult = spawnSync(process.execPath, [runner, slowFixture], {
      cwd: root,
      env: { ...baseEnv, HOLOSELF_TEST_TIMEOUT_MS: '50' },
      encoding: 'utf8',
      windowsHide: true
    })
    assert.notEqual(timeoutResult.status, 0, 'expected HOLOSELF_TEST_TIMEOUT_MS override to time out slow fixture')
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
})
