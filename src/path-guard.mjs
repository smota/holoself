import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

// Trust-boundary path guard.
//
// The boundary is a user-chosen root (self root, project, skill home, config
// directory). Symlinks ABOVE the boundary belong to the user's environment
// (macOS /var -> /private/var, symlinked home directories) and are accepted.
// Symlinks or junctions AT (when requested) or BELOW the boundary fail closed.

const fold = value => process.platform === 'win32' ? value.toLowerCase() : value

function lstat(path) {
  try { return lstatSync(path) }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null; throw error }
}

// Realpath of the nearest existing ancestor with the missing tail re-appended.
export function canonicalPath(path) {
  const absolute = resolve(path), tail = []
  let current = absolute
  while (true) {
    try { return tail.length ? join(realpathSync(current), ...tail.reverse()) : realpathSync(current) }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error
      const parent = dirname(current)
      if (parent === current) return absolute
      tail.push(basename(current)); current = parent
    }
  }
}

export function samePath(a, b) { return fold(a) === fold(b) }

export function isWithin(root, path) {
  const rel = relative(fold(root), fold(path))
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

// Locate `target` below the boundary `root` without following any link below
// the boundary. Returns the lexical ancestor of `target` that is the boundary
// (`base`) and the components below it, or null when `target` is outside.
export function locateBelow(root, target) {
  const lexicalRoot = resolve(root), lexicalTarget = resolve(target)
  if (isWithin(lexicalRoot, lexicalTarget)) return { base: lexicalRoot, parts: split(relative(lexicalRoot, lexicalTarget)) }
  const canonicalRoot = canonicalPath(lexicalRoot)
  for (let current = lexicalTarget;; current = dirname(current)) {
    if (samePath(canonicalPath(current), canonicalRoot)) return { base: current, parts: split(relative(current, lexicalTarget)) }
    if (dirname(current) === current) return null
  }
}
const split = rel => rel ? rel.split(sep) : []

// First symlink/junction at or below the boundary on the way to `target`, as a
// lexical path, or null. `includeRoot` also rejects a boundary that is itself a
// link. Components above the boundary are never inspected.
export function linkBelow(root, target, { includeRoot = false } = {}) {
  if (includeRoot && lstat(resolve(root))?.isSymbolicLink()) return resolve(root)
  const located = locateBelow(root, target)
  if (!located) return null
  let current = located.base
  if (includeRoot && lstat(current)?.isSymbolicLink()) return current
  for (const part of located.parts) {
    current = join(current, part)
    const entry = lstat(current)
    if (!entry) return null
    if (entry.isSymbolicLink()) return current
  }
  return null
}

// Throws `error(linkPath)` when a link exists at/below the boundary.
export function assertNoLinkBelow(root, target, error, options = {}) {
  const link = linkBelow(root, target, options)
  if (link !== null) throw error(link)
}
