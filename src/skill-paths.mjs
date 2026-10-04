import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

function stat(path) {
  try { return lstatSync(path) }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error }
}
function contained(root, path) {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}
function ancestors(path) {
  const chain = []
  for (let current = path;; current = dirname(current)) {
    chain.push(current)
    if (dirname(current) === current) break
  }
  return chain.reverse()
}
function plainPath(path) {
  for (const item of ancestors(path)) {
    const entry = stat(item)
    if (entry?.isSymbolicLink()) throw new Error(`symlink in deployment target: ${item}`)
  }
}

// Diagnostics stop at local links. A global terminal directory link has a
// separate, read-only path contract; managed project writes never use it.
export function inspectSkillFile(root, rel, { allowDirectoryLink = false } = {}) {
  let external = false, linkPath = null
  const base = resolve(root)
  let path = base
  try {
    if (typeof rel !== 'string' || !rel || isAbsolute(rel)) throw new Error('skill path must be relative to its root')
    path = resolve(base, rel)
    if (!contained(base, path)) throw new Error('skill path escapes its root')
    plainPath(base)
    const chain = []; for (let current = path; current !== base; current = dirname(current)) chain.push(current)
    for (const item of chain.reverse()) {
      const entry = stat(item)
      if (!entry) return { path, status: 'missing', external, linkPath }
      if (!entry.isSymbolicLink()) { if (item !== path && !entry.isDirectory()) throw new Error('skill ancestor is not a directory'); continue }
      linkPath = item
      if (!allowDirectoryLink || item !== dirname(path) || basename(item) !== 'holoself') {
        return { path, status: 'external-link', external: true, linkPath, reason: 'Skill discovery stopped at a symlink; target was not read' }
      }
      external = true
      plainPath(resolve(dirname(item), readlinkSync(item)))
      const targetDir = realpathSync(item)
      plainPath(targetDir)
      if (!stat(targetDir)?.isDirectory()) throw new Error('deployment target is not a directory')
      const target = resolve(targetDir, basename(path))
      plainPath(target)
      if (!stat(target)?.isFile()) throw new Error('deployment target has no regular SKILL.md')
      return { path, status: 'regular', resolvedPath: target, external, linkPath }
    }
    if (!stat(path)?.isFile()) throw new Error('skill path is not a regular file')
    return { path, status: 'regular', resolvedPath: path, external, linkPath }
  } catch (error) {
    return { path, status: ['EACCES', 'EPERM'].includes(error.code) ? 'unreadable' : 'unsafe', external, linkPath, reason: error.message }
  }
}
