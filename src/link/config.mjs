// Project link configuration: .holoself/link.yaml discovery, schema validation, read and write.
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { resolveBinding, writeBinding } from '../bindings.mjs'
import { atomicWriteFile, purgeLegacyIndex } from '../catalog.mjs'
import { lensIdStructurallyValid, loadLensRegistry } from '../lenses.mjs'
import { assertContainedPath, atomicWrite, ensureDir, pathExists, safeRealpath, slash } from '../shared/fs.mjs'
import { parseYaml, quote, yamlObject } from '../shared/yaml.mjs'

export const DEFAULT_PROJECT_EXCLUDES = [
  '.git/**',
  'node_modules/**',
  '.holoself/**',
  '.agents/**',
  '.claude/**',
  '.codex/**',
  '.pi/**',
  '.agy/**',
  '.gemini/**',
  '.cursor/**',
  '.github/**',
  'skills/**',
  '**/Generated/**',
  '**/generated/**'
]
export function isCanonicalSelf(path) {
  if (!pathExists(path)) return false
  const real = safeRealpath(path)
  try {
    const st = lstatSync(real)
    if (!st.isDirectory() || st.isSymbolicLink()) return false
  } catch {
    return false
  }
  return existsSync(join(real, 'config.json')) && existsSync(join(real, 'profile')) && existsSync(join(real, 'context'))
}
export function findLinkUpwards(startDir) {
  let current = resolve(startDir)
  while (true) {
    const holoselfDir = join(current, '.holoself')
    if (existsSync(holoselfDir)) {
      try {
        if (lstatSync(holoselfDir).isSymbolicLink()) {
          const parent = dirname(current)
          if (parent === current) break
          current = parent
          continue
        }
      } catch {}
    }
    const candidate = linkPath(current)
    if (pathExists(candidate)) return { projectDir: current, linkFilePath: candidate }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}
export function linkPath(project) {
  return join(project, '.holoself', 'link.yaml')
}
export function updateLinkBindingSaltInPlace(projectDir, salt) {
  const filePath = assertContainedPath(projectDir, linkPath(projectDir), 'link configuration')
  if (!pathExists(filePath) || lstatSync(filePath).isSymbolicLink() || !lstatSync(filePath).isFile())
    throw new Error(`cannot update link configuration in-place: invalid file ${filePath}`)
  const raw = readFileSync(filePath, 'utf8')
  const lines = raw.split(/\r?\n/)
  let selfContextLine = -1,
    selfContextIndent = 0,
    bindingSaltLine = -1,
    insertLine = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^self_context:\s*$/.test(line.trimEnd())) {
      selfContextLine = i
      selfContextIndent = line.length - line.trimStart().length
      continue
    }
    if (selfContextLine >= 0 && i > selfContextLine) {
      const indent = line.length - line.trimStart().length
      if (line.trim() && !line.trimStart().startsWith('#')) {
        if (indent <= selfContextIndent) {
          if (insertLine < 0) insertLine = i
          break
        }
        if (/^binding_salt:\s*/.test(line.trimStart())) {
          bindingSaltLine = i
          break
        }
      }
    }
  }
  if (selfContextLine < 0) throw new Error('Cannot update binding_salt: self_context section missing')
  if (bindingSaltLine >= 0) {
    const currentLine = lines[bindingSaltLine]
    const indent = currentLine.slice(0, currentLine.length - currentLine.trimStart().length)
    lines[bindingSaltLine] = `${indent}binding_salt: ${quote(salt)}`
  } else {
    const indent = '  '
    if (insertLine >= 0) lines.splice(insertLine, 0, `${indent}binding_salt: ${quote(salt)}`)
    else lines.splice(selfContextLine + 1, 0, `${indent}binding_salt: ${quote(salt)}`)
  }
  atomicWriteFile(filePath, lines.join('\n') + (raw.endsWith('\n') ? '' : '\n'))
}
export function ledgerConfigErrors(value, prefix = 'ledger') {
  const errors = []
  if (value === undefined) return errors
  if (!value || Array.isArray(value) || typeof value !== 'object') return [`${prefix} must be a mapping`]
  for (const key of Object.keys(value))
    if (!['enabled', 'record_task_text'].includes(key)) errors.push(`unknown ${prefix} field: ${key}`)
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') errors.push(`${prefix}.enabled must be a boolean`)
  if (value.record_task_text !== undefined && typeof value.record_task_text !== 'boolean')
    errors.push(`${prefix}.record_task_text must be a boolean`)
  return errors
}
export function linkSchemaErrors(link, registry = null) {
  const errors = [],
    allowedKeys = new Set([
      'path',
      'access',
      'proposals',
      'index',
      'default_lens',
      'secondary_lenses',
      'binding_salt',
      'cache_limit_entries',
      'cache_limit_bytes',
      'ledger'
    ]),
    known = id => (registry ? registry.byId.has(id) : lensIdStructurallyValid(id))
  if (!link || Array.isArray(link) || typeof link !== 'object') return ['self_context must be a mapping']
  for (const key of Object.keys(link)) if (!allowedKeys.has(key)) errors.push(`unknown self_context field: ${key}`)
  if (typeof link.path !== 'string' || !link.path.trim()) errors.push('self_context.path must be a non-empty string')
  if (link.access !== 'read') errors.push('self_context.access must be read')
  if (!['enabled', 'disabled'].includes(link.proposals)) errors.push('self_context.proposals must be enabled or disabled')
  if (link.index !== 'local') errors.push('self_context.index must be local')
  if (link.default_lens === 'private') errors.push('default_lens cannot be private: private is owner-exclusive')
  else if (link.default_lens !== undefined && !known(link.default_lens) && !['career', 'publishing'].includes(link.default_lens))
    errors.push(`invalid default lens: ${link.default_lens}`)
  if (link.secondary_lenses !== undefined) {
    if (!Array.isArray(link.secondary_lenses) || link.secondary_lenses.some(x => typeof x !== 'string' || (!known(x) && !['career', 'publishing'].includes(x))))
      errors.push('secondary_lenses must contain only known lenses')
    else if (link.secondary_lenses.includes('private')) errors.push('secondary_lenses cannot include private: private is owner-exclusive')
    else if (new Set(link.secondary_lenses).size !== link.secondary_lenses.length) errors.push('secondary_lenses must contain unique lenses')
  }
  if (link.binding_salt !== undefined) {
    if (typeof link.binding_salt !== 'string' || !/^[0-9a-f]{32}$/.test(link.binding_salt)) errors.push('binding_salt must be a 32-character hex string')
  }
  if (link.ledger !== undefined) errors.push(...ledgerConfigErrors(link.ledger, 'self_context.ledger'))
  return errors
}
export function projectContextErrors(value) {
  const errors = []
  if (value === undefined) return errors
  if (!value || Array.isArray(value) || typeof value !== 'object') return ['project_context must be a mapping']
  for (const key of Object.keys(value))
    if (!['include', 'exclude', 'assert_include', 'assert_exclude'].includes(key)) errors.push(`unknown project_context field: ${key}`)
  for (const key of ['include', 'exclude', 'assert_include', 'assert_exclude'])
    if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].some(x => typeof x !== 'string' || !x.trim())))
      errors.push(`project_context.${key} must be a string array`)
  return errors
}
// The legacy live mount (`link --target` / `unlink --target`) is deprecated (docs/decisions/privacy-fields-and-legacy-mount.md).
export const LEGACY_MOUNT_REMOVAL_VERSION = '0.13.0'
export const LEGACY_MOUNT_DEPRECATION =
  `the legacy live mount (link --target, unlink --target) is deprecated and will be removed in ${LEGACY_MOUNT_REMOVAL_VERSION}; ` +
  'use holoself link setup --project <dir> --self <path>'
export function readLink(project, { tolerant = false } = {}) {
  const holoselfDir = join(project, '.holoself')
  if (existsSync(holoselfDir) && lstatSync(holoselfDir).isSymbolicLink()) {
    const error = new Error(`legacy filesystem junction mount detected at ${holoselfDir}; run holoself link setup to migrate to a bounded link; ${LEGACY_MOUNT_DEPRECATION}`)
    error.code = 'LEGACY_MOUNT_DETECTED'
    throw error
  }
  const path = assertContainedPath(project, linkPath(project), 'link configuration')
  if (!pathExists(path)) throw new Error(`link configuration missing: ${path}`)
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) throw new Error(`link configuration is not a regular file: ${path}`)
  let parsed
  try {
    parsed = parseYaml(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`malformed link configuration ${path}: ${error.message}`)
  }
  if (!Object.hasOwn(parsed, 'self_context')) throw new Error(`malformed link configuration ${path}: self_context mapping missing`)
  for (const key of Object.keys(parsed))
    if (!['self_context', 'project_context', 'ledger', 'cache_limit_entries', 'cache_limit_bytes'].includes(key))
      throw new Error(`malformed link configuration ${path}: unknown root field ${key}`)
  const structuralErrors = [
    ...linkSchemaErrors(parsed.self_context),
    ...projectContextErrors(parsed.project_context),
    ...ledgerConfigErrors(parsed.ledger, 'ledger')
  ]
  if (structuralErrors.length && !tolerant) throw new Error(`invalid link configuration ${path}: ${structuralErrors.join('; ')}`)
  const selfPath = resolve(project, parsed.self_context.path)
  let registry = null
  try {
    registry = loadLensRegistry(selfPath)
  } catch (err) {
    if (!tolerant) throw err
  }
  const errors = linkSchemaErrors(parsed.self_context)
  if (errors.length && !tolerant) throw new Error(`invalid link configuration ${path}: ${errors.join('; ')}`)
  let binding = null,
    bindingError = null
  try {
    binding = resolveBinding(selfPath, project, { registry })
  } catch (error) {
    if (!tolerant) throw error
    bindingError = error.message
  }
  const { cache_limit_entries: _cle, cache_limit_bytes: _clb, ledger: selfLedger, ...selfContextFields } = parsed.self_context
  const rawLedger = parsed.ledger && typeof parsed.ledger === 'object' ? parsed.ledger : selfLedger && typeof selfLedger === 'object' ? selfLedger : null
  const ledger = rawLedger
    ? {
        enabled: rawLedger.enabled !== false,
        record_task_text: rawLedger.record_task_text === true
      }
    : undefined
  return {
    ...selfContextFields,
    ...(binding || {}),
    path: selfPath,
    secondary_lenses: [...(binding?.secondary_lenses || [])],
    binding_salt: parsed.self_context.binding_salt || null,
    ...(ledger ? { ledger } : {}),
    project_context: {
      include: parsed.project_context?.include || [],
      exclude: [...DEFAULT_PROJECT_EXCLUDES, ...(parsed.project_context?.exclude || [])],
      assert_include: parsed.project_context?.assert_include || [],
      assert_exclude: parsed.project_context?.assert_exclude || []
    },
    _schemaErrors: [...structuralErrors, ...errors],
    _bindingError: bindingError,
    _legacyBinding: parsed.self_context.default_lens
      ? { default_lens: parsed.self_context.default_lens, secondary_lenses: parsed.self_context.secondary_lenses || [] }
      : null
  }
}
export function writeLink(project, self, lens = 'general', secondary = [], projectContext = {}, bindingSalt = null) {
  const registry = loadLensRegistry(resolve(self))
  let salt = bindingSalt
  if (!salt) {
    try {
      if (pathExists(linkPath(project))) {
        const existing = readLink(project, { tolerant: true })
        if (existing.binding_salt && /^[0-9a-f]{32}$/.test(existing.binding_salt)) salt = existing.binding_salt
      }
    } catch {}
  }
  const selfContext = { path: slash(resolve(self)), access: 'read', proposals: 'enabled', index: 'local' }
  if (salt) selfContext.binding_salt = salt
  const data = {
      self_context: selfContext,
      project_context: {
        include: projectContext.include || [],
        exclude: projectContext.exclude || DEFAULT_PROJECT_EXCLUDES,
        assert_include: projectContext.assert_include || [],
        assert_exclude: projectContext.assert_exclude || []
      }
    },
    errors = [...linkSchemaErrors(data.self_context, registry), ...projectContextErrors(data.project_context)]
  if (errors.length) throw new Error(errors.join('; '))
  writeBinding(self, project, { default_lens: lens, secondary_lenses: secondary })
  atomicWrite(linkPath(project), yamlObject(data))
  return { ...data.self_context, default_lens: lens, secondary_lenses: secondary, project_context: data.project_context }
}
export const HOLOSELF_GITIGNORE_PATTERNS = [
  'ledger*.ndjson',
  'ledger*.lock*',
  'catalog/',
  'index/',
  'runtime/',
  'runtime*',
  'conversations/',
  'reports/',
  'links.json*'
]
export function managedGitignore() {
  return (
    `# Local-only Holoself runtime, cache, and ledger artifacts (never commit).\n` +
    `# link.yaml, BOOTSTRAP.md, README.md, and proposals/ remain trackable.\n` +
    `${HOLOSELF_GITIGNORE_PATTERNS.join('\n')}\n`
  )
}
export function ensureHoloselfGitignore(baseDir) {
  const resolvedBase = resolve(baseDir),
    root = join(resolvedBase, '.holoself')
  ensureDir(root)
  const gitignorePath = assertContainedPath(resolvedBase, join(root, '.gitignore'), 'holoself .gitignore'),
    st = lstatSync(gitignorePath, { throwIfNoEntry: false })
  if (st && (st.isSymbolicLink() || !st.isFile())) throw new Error(`${gitignorePath} is not a regular file; refusing to modify`)
  if (!st) {
    atomicWrite(gitignorePath, managedGitignore())
    return gitignorePath
  }
  const existing = readFileSync(gitignorePath, 'utf8'),
    present = new Set(existing.split(/\r?\n/).map(line => line.trim())),
    missing = HOLOSELF_GITIGNORE_PATTERNS.filter(pattern => !present.has(pattern))
  if (missing.length) {
    const prefix = existing.endsWith('\n') || !existing.length ? existing : `${existing}\n`
    atomicWrite(gitignorePath, `${prefix}${missing.join('\n')}\n`)
  }
  return gitignorePath
}
export function managedReadme() {
  return (
    `# Linked Holoself context\n\nProject owns artifacts. Linked self owns approved reusable knowledge.\n\n` +
    `- \`link.yaml\` grants read access and proposal delivery; it never copies self files.\n` +
    `- \`index/\` and \`catalog/\` are local, rebuildable acceleration data. Markdown remains source of truth.\n` +
    `- \`proposals/\` contains review artifacts that may be tracked in git.\n` +
    `- \`.gitignore\` keeps local-only artifacts (\`ledger*.ndjson\`, \`catalog/\`, \`index/\`, \`runtime*\`, \`conversations/\`, \`reports/\`) out of git.\n`
  )
}
export function inspectLinkCollisions(project) {
  const root = join(project, '.holoself'),
    collisions = []
  if (pathExists(root)) {
    const stat = lstatSync(root)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${root} is not a regular metadata directory; refusing to replace`)
    const readme = join(root, 'README.md')
    if (pathExists(readme)) {
      const rs = lstatSync(readme)
      if (rs.isSymbolicLink() || !rs.isFile()) throw new Error(`${readme} is not a regular file; refusing to replace`)
      if (readFileSync(readme, 'utf8') !== managedReadme()) collisions.push(readme)
    }
    const gitignore = join(root, '.gitignore'),
      gs = lstatSync(gitignore, { throwIfNoEntry: false })
    if (gs && (gs.isSymbolicLink() || !gs.isFile())) throw new Error(`${gitignore} is not a regular file; refusing to replace`)
    const link = linkPath(project)
    if (pathExists(link)) collisions.push(link)
    for (const dir of ['catalog', 'proposals', 'reports']) {
      const path = join(root, dir)
      if (pathExists(path) && (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()))
        throw new Error(`${path} is not a regular directory; refusing to replace`)
    }
  }
  return collisions
}
export function createLinkDirs(project, { preserveReadme = false, purgeLegacy = true } = {}) {
  const root = join(project, '.holoself')
  ensureDir(root)
  for (const dir of ['catalog', 'proposals', 'reports']) ensureDir(join(root, dir))
  if (purgeLegacy)
    try {
      purgeLegacyIndex(project)
    } catch {}
  ensureHoloselfGitignore(project)
  const readme = join(root, 'README.md')
  if (!pathExists(readme)) atomicWrite(readme, managedReadme())
  else if (!preserveReadme && readFileSync(readme, 'utf8') !== managedReadme()) throw new Error(`${readme} exists with user content; refusing to replace`)
}
