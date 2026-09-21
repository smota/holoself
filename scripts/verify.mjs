import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const node = process.execPath
const checks = [
  ['tests', ['--test', ...readdirSync(join(root, 'tests')).filter(name => name.endsWith('.test.mjs')).map(name => join('tests', name))]],
  ['package audit', ['scripts/package-audit.mjs']],
  ['help', ['bin/holoself.mjs', '--help']],
  ['capabilities', ['bin/holoself.mjs', 'capabilities', '--json']]
]
for (const [name, args] of checks) {
  const result = spawnSync(node, args, { cwd: root, encoding: 'utf8', shell: false, windowsHide: true, stdio: 'pipe' })
  if (result.status !== 0) {
    if (result.stdout) process.stderr.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
    process.stderr.write(`[!!] ${name} failed (exit code ${result.status}, signal ${result.signal || 'none'})\n`)
    process.exit(result.status || 1)
  }
  process.stdout.write(`[ok] ${name}\n`)
}
