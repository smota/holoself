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
try {
  const catalog = JSON.parse(readFileSync(join(root, 'contribs/catalog.json'), 'utf8'))
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.contribs)) failures.push('invalid contribs/catalog.json schema')
  else for (const entry of catalog.contribs) {
    if (!entry.id || !entry.path || entry.default !== true) failures.push(`invalid contrib catalog entry: ${entry.id || '(missing id)'}`)
    if (entry.path && !statSafe(join(root, 'contribs', entry.path))) failures.push(`missing contrib file: ${entry.path}`)
  }
} catch { failures.push('missing or invalid contribs/catalog.json') }
function statSafe(path) { try { statSync(path); return true } catch { return false } }
if (failures.length) { console.error(failures.map(x => `[!!] ${x}`).join('\n')); process.exitCode = 1 }
else console.log('[ok] package paths and public defaults are clean')
