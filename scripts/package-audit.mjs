import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const forbidden = /(?:personal|profile|context|topic|secret|token|password|\.env)/i
const failures = []
for (const entry of pkg.files || []) {
  const path = join(root, entry)
  try { statSync(path) } catch { failures.push(`missing package path: ${entry}`) }
}
for (const dir of ['contribs/default', 'skills']) {
  const path = join(root, dir)
  for (const name of readdirSync(path, { recursive: true })) {
    const rel = join(dir, name)
    if (forbidden.test(name) && !name.endsWith('.md')) failures.push(`private-looking package path: ${rel}`)
  }
}
if (failures.length) { console.error(failures.map(x => `[!!] ${x}`).join('\n')); process.exitCode = 1 }
else console.log('[ok] package paths and public defaults are clean')
