// Filesystem and path helpers shared by the ecosystem modules (moved verbatim from ecosystem.mjs).
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, existsSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync, rmSync, writeSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { assertNoLinkBelow, canonicalPath, isWithin, locateBelow, lstat } from '../path-guard.mjs'

export function pathExists(path) {
  return lstat(path) !== null
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
export function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    const end = Date.now() + ms
    while (Date.now() < end) {}
  }
}
// Permission bits of an existing regular file, else the fallback (for new files).
export function fileModeOr(path, fallback) {
  try {
    const info = lstatSync(path)
    return info.isFile() ? info.mode & 0o777 : fallback
  } catch {
    return fallback
  }
}
export function atomicWrite(targetPath, content, options = {}) {
  const mode = typeof options === 'number' ? options : (options?.mode ?? 0o600)
  const targetDir = dirname(targetPath)
  if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true })
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`
  const fd = openSync(tmpPath, 'w', mode)
  try {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8')
    let written = 0
    while (written < buf.length) {
      written += writeSync(fd, buf, written, buf.length - written)
    }
    // exactMode applies the mode despite the process umask (used to keep an existing file's permissions).
    if (options?.exactMode && process.platform !== 'win32') fchmodSync(fd, mode)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  const backoffs = [20, 50, 100]
  let lastErr = null
  for (let attempt = 0; attempt <= backoffs.length; attempt++) {
    try {
      renameSync(tmpPath, targetPath)
      lastErr = null
      break
    } catch (err) {
      lastErr = err
      if ((err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES') && attempt < backoffs.length) {
        sleepSync(backoffs[attempt])
      } else {
        break
      }
    }
  }
  if (lastErr) {
    try {
      rmSync(tmpPath, { force: true })
    } catch {}
    throw lastErr
  }
}
export function slash(path) {
  return String(path).replaceAll('\\', '/')
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
