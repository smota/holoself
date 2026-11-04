// Adapter registry and shared helpers: the public skill text, supported adapters, and safe project/user paths.
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { assertNoLinkBelow } from '../path-guard.mjs'

export const SKILL_START = '<!-- holoself-skill-start schema=1 -->'
export const SKILL_END = '<!-- holoself-skill-end -->'
export const LEGACY_SKILL_BLOCK =
  `${SKILL_START}
# Linked Holoself

Read \`.holoself/BOOTSTRAP.md\` before substantive work. Use installed public Holoself skill when available. ` +
  `Resolve context through configured lens, preserve provenance and project ownership, and create proposals ` +
  `instead of editing canonical self directly.
${SKILL_END}
`
export const LEGACY_SKILL = `---
name: holoself
description: Load linked whole-person context for this project.
---

${LEGACY_SKILL_BLOCK}`
export const HISTORICAL_PUBLIC_FRONTMATTER = `---
name: holoself
description: Load and apply a user's local, reviewable Holoself context across AI tools.
---`
export const HISTORICAL_LINKED_PREFIX =
  `---
name: holoself
description: Load linked whole-person context for this project.
---

# Linked Holoself

Read \`.holoself/BOOTSTRAP.md\` before substantive work. Use the installed public Holoself skill when ` +
  `available. Resolve context through the configured lens, preserve provenance and project ownership, and create ` +
  `proposals instead of editing canonical self directly.`
export const PUBLIC_SKILL_RAW = readFileSync(new URL('../../skills/holoself/SKILL.md', import.meta.url), 'utf8')
export const PUBLIC_SKILL = PUBLIC_SKILL_RAW.replace(/\r\n/g, '\n')
export const frontmatterEnd = PUBLIC_SKILL.indexOf('---', 4) + 3
export const SKILL_FRONTMATTER = PUBLIC_SKILL.slice(0, frontmatterEnd)
export const SKILL_BODY = PUBLIC_SKILL.slice(frontmatterEnd).trim()
export const SKILL_BLOCK = `${SKILL_START}
${SKILL_BODY}
${SKILL_END}
`
export const NEW_SKILL = `${SKILL_FRONTMATTER}

${SKILL_BLOCK}`
export const capability = (delivery, discovery, testedProduct, evidence) => ({
  delivery,
  discovery,
  tested_product: testedProduct,
  tested_version: null,
  evidence,
  last_verified: null
})
export const REGISTRY = [
  {
    id: 'agents',
    name: 'Generic AGENTS',
    files: ['AGENTS.md'],
    dirs: [],
    support: 'configured',
    skillDirs: ['.agents/skills/holoself'],
    userSkillDirs: ['.agents/skills/holoself'],
    ...capability(
      'file',
      'configured',
      'AGENTS.md-compatible hosts',
      'Holoself generates a bounded AGENTS.md pointer; each host still needs an application-level discovery test.'
    )
  },
  {
    id: 'claude',
    name: 'Claude Code',
    files: ['CLAUDE.md'],
    dirs: ['.claude'],
    support: 'configured',
    skillDirs: ['.claude/skills/holoself'],
    userSkillDirs: ['.claude/skills/holoself'],
    ...capability(
      'file',
      'configured',
      'Claude Code',
      'CLAUDE.md activation is generated and covered by filesystem tests; product discovery is not asserted without a recorded smoke test.'
    )
  },
  {
    id: 'codex',
    name: 'Codex',
    files: ['CODEX.md', 'codex.md'],
    dirs: ['.codex'],
    support: 'configured',
    skillDirs: ['.codex/skills/holoself'],
    userSkillDirs: ['.codex/skills/holoself'],
    ...capability('file', 'configured', 'Codex', 'Codex instruction pointer is generated; product discovery requires versioned smoke-test evidence.')
  },
  {
    id: 'pi',
    name: 'Pi',
    files: ['PI.md'],
    dirs: ['.pi'],
    support: 'configured',
    skillDirs: ['.pi/skills/holoself'],
    userSkillDirs: ['.pi/agent/skills/holoself'],
    ...capability('file', 'configured', 'Pi', 'PI.md and optional skill pointer are generated; product discovery requires versioned smoke-test evidence.')
  },
  {
    id: 'agy',
    name: 'AGY',
    files: ['AGY.md'],
    dirs: ['.agy'],
    support: 'generated-only',
    skillDirs: [],
    ...capability('file', 'generated-only', 'AGY', 'Adapter file can be generated, but no product-level discovery evidence is bundled.')
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    files: ['ANTIGRAVITY.md'],
    dirs: ['.antigravity'],
    support: 'generated-only',
    skillDirs: [],
    ...capability(
      'file',
      'generated-only',
      'Antigravity IDE',
      'Adapter file can be generated, but IDE rule discovery must be configured and verified in product.'
    )
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    files: ['GEMINI.md'],
    dirs: ['.gemini'],
    support: 'configured',
    skillDirs: [],
    ...capability('file', 'configured', 'Gemini CLI', 'GEMINI.md pointer is generated; product discovery requires versioned smoke-test evidence.')
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    files: ['.github/copilot-instructions.md'],
    dirs: ['.github'],
    support: 'configured',
    skillDirs: [],
    ...capability(
      'file',
      'configured',
      'GitHub Copilot',
      'Known repository instruction path is generated; repository settings and product version remain external.'
    )
  },
  {
    id: 'cursor',
    name: 'Cursor',
    files: ['.cursor/rules/holoself.mdc'],
    dirs: ['.cursor'],
    support: 'configured',
    skillDirs: [],
    ...capability('file', 'configured', 'Cursor', 'Known project rule path is generated; product-level loading must be smoke tested.')
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    files: ['.windsurfrules'],
    dirs: ['.windsurf'],
    support: 'configured',
    skillDirs: [],
    ...capability('file', 'configured', 'Windsurf', 'Known project rule path is generated; product-level loading must be smoke tested.')
  }
]
export function slash(p) {
  return p.replaceAll('\\', '/')
}
export function ensureDir(p) {
  mkdirSync(p, { recursive: true })
}
export function atomicWrite(p, content) {
  ensureDir(dirname(p))
  const t = `${p}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  try {
    writeFileSync(t, content, 'utf8')
    renameSync(t, p)
  } finally {
    if (existsSync(t)) rmSync(t, { force: true })
  }
}
export function pathExists(path) {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false
    throw error
  }
}
export function contained(root, path) {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}
export function safeProjectFile(project, rel, label = 'managed path') {
  if (typeof rel !== 'string' || !rel.trim() || isAbsolute(rel)) throw new Error(`${label} must be a project-relative path: ${rel}`)
  const lexicalRoot = resolve(project),
    target = resolve(lexicalRoot, rel)
  if (!contained(lexicalRoot, target)) throw new Error(`${label} escapes project: ${rel}`)
  const rootReal = realpathSync(lexicalRoot)
  let current = target
  const chain = []
  while (current !== lexicalRoot) {
    chain.push(current)
    current = dirname(current)
  }
  assertNoLinkBelow(lexicalRoot, target, link => new Error(`${label} traverses symlink: ${link}`))
  for (const item of chain.reverse()) {
    if (!pathExists(item)) continue
    const actual = realpathSync(item)
    if (!contained(rootReal, actual)) throw new Error(`${label} escapes real project root: ${item}`)
  }
  return target
}
export function evidence(project, adapter) {
  return (
    adapter.files.some(f => existsSync(safeProjectFile(project, f, 'adapter evidence'))) ||
    adapter.dirs.some(d => existsSync(safeProjectFile(project, d, 'adapter evidence')))
  )
}
export function detectAdapters(project) {
  return REGISTRY.map(a => ({ ...a, detected: a.id === 'agents' || evidence(project, a) }))
}
export function parseSelection(value) {
  if (!value || value === 'auto') return { mode: 'auto', ids: [] }
  if (value === 'all') return { mode: 'all', ids: [] }
  return {
    mode: 'list',
    ids: value
      .split(',')
      .map(x => x.trim())
      .filter(Boolean)
  }
}
export function unique(items) {
  return [...new Set(items)]
}
export function skillHome(options = {}) {
  return resolve(options.skillHome || process.env.HOLOSELF_SKILL_HOME || homedir())
}
export function safeUserSkillFile(home, rel, label = 'user skill path') {
  if (typeof rel !== 'string' || !rel.trim() || isAbsolute(rel)) throw new Error(`${label} must be relative to the user skill home: ${rel}`)
  const root = resolve(home),
    target = resolve(root, rel)
  if (!contained(root, target)) throw new Error(`${label} escapes user skill home: ${rel}`)
  assertNoLinkBelow(root, target, link => new Error(`${label} traverses symlink: ${link}`))
  return target
}
export function userSkillTargets(ids, options = {}) {
  const selected = ids?.length ? ids : ['agents', 'claude', 'pi'],
    unknown = selected.filter(id => !REGISTRY.some(a => a.id === id))
  if (unknown.length) throw new Error(`unknown platform adapter: ${unique(unknown).join(', ')}`)
  const wanted = new Set(selected),
    home = skillHome(options),
    targets = []
  for (const adapter of REGISTRY.filter(a => wanted.has(a.id)))
    for (const dir of adapter.userSkillDirs || []) targets.push({ id: adapter.id, file: slash(join(dir, 'SKILL.md')), path: resolve(home, dir, 'SKILL.md') })
  return targets
}
// Existing files are identified by device and inode, so case aliases on a
// case-insensitive filesystem (macOS APFS) or hard links collapse to one file.
export function instructionIdentity(project, rel) {
  let path
  try {
    path = safeProjectFile(project, rel, 'instruction identity')
  } catch {
    const unsafe = resolve(project, rel)
    return `unsafe:${process.platform === 'win32' ? unsafe.toLowerCase() : unsafe}`
  }
  if (process.platform !== 'win32' && existsSync(path)) {
    const info = statSync(path, { bigint: true })
    return `inode:${info.dev}:${info.ino}`
  }
  const identity = existsSync(path) ? realpathSync(path) : resolve(path)
  return process.platform === 'win32' ? identity.toLowerCase() : identity
}
export function uniqueInstructionFiles(project, items) {
  const seen = new Set(),
    result = []
  for (const item of items) {
    const identity = instructionIdentity(project, item)
    if (seen.has(identity)) continue
    seen.add(identity)
    result.push(item)
  }
  return result
}
