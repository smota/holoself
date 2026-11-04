// Filesystem and path helpers shared by the ecosystem modules (moved verbatim from ecosystem.mjs).
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { atomicWriteFile } from '../catalog.mjs'
import { assertNoLinkBelow, canonicalPath, isWithin, locateBelow } from '../path-guard.mjs'

export function pathExists(path) {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}
export function safeRealpath(p) {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}
export function ensureDir(path) {
  mkdirSync(path, { recursive: true })
}
export function atomicWrite(path, content) {
  atomicWriteFile(path, content)
}
export function slash(path) {
  return path.replaceAll('\\', '/')
}
export function hash(text) {
  return createHash('sha256').update(text).digest('hex')
}
export function assertContainedPath(root, target, label = 'path') {
  // Boundary is the canonical root; symlinks above it are the user's environment.
  const rootReal = canonicalPath(root)
  if (pathExists(target) && existsSync(target)) {
    const targetReal = realpathSync(target)
    if (!isWithin(rootReal, targetReal)) throw new Error(`${label} escapes root`)
    return targetReal
  }
  const located = locateBelow(root, target)
  if (!located) throw new Error(`${label} escapes root`)
  assertNoLinkBelow(located.base, resolve(target), link => new Error(`${label} traverses symlink: ${link}`))
  return located.parts.length ? join(rootReal, ...located.parts) : rootReal
}
