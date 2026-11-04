// Redaction of self and project root paths from user-facing messages.
import { resolve } from 'node:path'
import { safeRealpath, slash } from './fs.mjs'

export function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
export function redactRootPaths(message, roots = [], { platform = process.platform } = {}) {
  let out = slash(String(message || ''))
  const candidates = new Set()
  for (const root of roots) {
    if (!root) continue
    const raw = String(root),
      res = resolve(raw),
      real = safeRealpath(raw)
    for (const p of [raw, res, real]) {
      const norm = slash(p).replace(/\/+$/, '')
      if (norm && norm.length > 1) candidates.add(norm)
    }
  }
  const sorted = [...candidates].sort((a, b) => b.length - a.length)
  const flags = platform === 'win32' ? 'gi' : 'g'
  for (const norm of sorted) {
    const re = new RegExp(`${escapeRegExp(norm)}(?:/+|$)`, flags)
    out = out.replace(re, '')
  }
  out = out.replace(
    /((?:invalid visibility|invalid [a-z_]+ value|invalid YAML scalar:) )([^\n;]+)/g,
    (_, prefix, val) => prefix + (val.length > 80 ? val.slice(0, 80) + '...' : val)
  )
  return out
}
