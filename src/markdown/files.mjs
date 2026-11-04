// Markdown file discovery for self roots and linked projects.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { DEFAULT_PROJECT_EXCLUDES } from '../link/config.mjs'
import { slash } from '../shared/fs.mjs'

export const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.holoself',
  'proposals',
  'exports',
  '.agents',
  '.claude',
  '.codex',
  '.pi',
  '.agy',
  '.gemini',
  '.cursor',
  '.github',
  'skills',
  'Generated',
  'generated'
])
export function globRegex(pattern) {
  const p = slash(pattern)
  let s = ''
  for (let i = 0; i < p.length; i++) {
    const c = p[i]
    if (c === '*' && p[i + 1] === '*') {
      i++
      if (p[i + 1] === '/') {
        i++
        s += '(?:.*/)?'
      } else s += '.*'
    } else if (c === '*') s += '[^/]*'
    else if (c === '?') s += '[^/]'
    else s += /[.\\+^$(){}|[\]]/.test(c) ? `\\${c}` : c
  }
  return new RegExp(`^${s}$`, 'i')
}
export function matchesAny(path, patterns) {
  return patterns.some(pattern => globRegex(pattern).test(path))
}
export function markdownFiles(root, { includeHoloself = false, skipDirs = SKIP_DIRS } = {}) {
  const files = []
  if (!existsSync(root)) return files
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory() && (skipDirs.has(entry.name) || (!includeHoloself && entry.name === '.holoself'))) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(path)
    }
  }
  walk(root)
  return files.sort()
}
export function projectMarkdownFiles(root, link) {
  const config = link?.project_context || { include: ['**/*.md'], exclude: DEFAULT_PROJECT_EXCLUDES }
  return markdownFiles(root, { skipDirs: new Set(['.git', 'node_modules', '.holoself']) }).filter(path => {
    const rel = slash(relative(root, path))
    return matchesAny(rel, config.include) && !matchesAny(rel, config.exclude)
  })
}
export function canonicalFiles(root, { includeHistory = false } = {}) {
  let files = [...markdownFiles(join(root, 'profile')), ...markdownFiles(join(root, 'context'))]
  if (includeHistory) files.push(...markdownFiles(join(root, 'history')))
  const current = join(root, 'topics', '.current')
  if (existsSync(current)) {
    const topic = readFileSync(current, 'utf8').trim()
    if (topic) {
      const path = join(root, 'topics', topic.endsWith('.md') ? topic : `${topic}.md`)
      if (existsSync(path)) files.push(path)
    }
  }
  return [...new Set(files)].sort()
}
