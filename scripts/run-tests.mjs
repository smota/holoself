import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

function supportsNodeTestTimeout() {
  try {
    const res = spawnSync(process.execPath, ['--help'], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
    return Boolean(res.stdout && res.stdout.includes('--test-timeout'))
  } catch {
    return false
  }
}

if (process.env.TMPDIR) {
  process.env.TMP = process.env.TMPDIR
  process.env.TEMP = process.env.TMPDIR
}

const runRoot = mkdtempSync(join(os.tmpdir(), 'holoself-test-run-'))
const args = process.argv.slice(2)
const testArgs =
  args.length > 0
    ? args
    : readdirSync(join(root, 'tests'))
        .filter(name => name.endsWith('.test.mjs'))
        .map(name => join('tests', name))

let cleaned = false
function cleanup() {
  if (cleaned) return
  cleaned = true
  if (process.env.HOLOSELF_KEEP_TEST_TMP === '1') {
    process.stdout.write(`${runRoot}\n`)
    return
  }
  rmSync(runRoot, { recursive: true, force: true })
}

process.on('exit', cleanup)

let child = null
let terminatingSignal = null

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    terminatingSignal = sig
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill(sig)
      } catch {}
    } else {
      cleanup()
      process.exit(sig === 'SIGINT' ? 130 : 143)
    }
  })
}

let code = 1
let signal = null

try {
  const childEnv = {
    ...process.env,
    TMPDIR: runRoot,
    TMP: runRoot,
    TEMP: runRoot
  }
  delete childEnv.NODE_TEST_CONTEXT
  const runnerFlags = ['--test']
  const parsedTimeout = Number.parseInt(process.env.HOLOSELF_TEST_TIMEOUT_MS ?? '', 10)
  const testTimeoutMs = Number.isInteger(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 600000
  if (supportsNodeTestTimeout() && !testArgs.some(arg => arg.startsWith('--test-timeout'))) {
    runnerFlags.push(`--test-timeout=${testTimeoutMs}`)
  }
  ;({ code, signal } = await new Promise((resolve, reject) => {
    child = spawn(process.execPath, [...runnerFlags, ...testArgs], {
      cwd: args.length > 0 ? process.cwd() : root,
      env: childEnv,
      shell: false,
      windowsHide: true,
      stdio: 'inherit'
    })
    child.on('error', reject)
    child.on('close', (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }))
  }))
} finally {
  cleanup()
}

const finalSignal = signal || terminatingSignal
if (finalSignal) {
  process.removeAllListeners(finalSignal)
  try {
    process.kill(process.pid, finalSignal)
  } catch {
    process.exit(finalSignal === 'SIGINT' ? 130 : 143)
  }
} else {
  process.exit(code ?? 1)
}
