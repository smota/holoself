// Canonical space identity and the self-owned links registry with its lock file.
import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { atomicWriteFile, canonicalSort } from '../catalog.mjs'
import { ensureDir, hash, pathExists, safeRealpath, slash } from '../shared/fs.mjs'

export function canonicalSpaceId(projectDir) {
  const real = safeRealpath(projectDir)
  const norm = slash(real).normalize('NFC')
  const canonical = process.platform === 'win32' ? norm.toLowerCase() : norm
  return 'hs-space-' + hash('project\0' + canonical).slice(0, 16)
}
export function canonicalProjectPath(projectDir) {
  const real = safeRealpath(projectDir)
  const norm = slash(real).normalize('NFC')
  return process.platform === 'win32' ? norm.toLowerCase() : norm
}
// Active (non-revoked) entries in `links` that hold projectKey for a project other than `project` (docs/decisions/
// portable-links.md: on one machine a project_key belongs to at most one project path, e.g. never to a copied folder).
export function projectKeyHolders(links, projectKey, project = null) {
  if (!projectKey) return []
  const id = project ? canonicalSpaceId(project) : null,
    path = project ? canonicalProjectPath(project) : null
  return links.filter(
    entry => entry?.project_key === projectKey && entry.status !== 'revoked' && (!project || (entry.project_id !== id && entry.project_path !== path))
  )
}
export const projectKeyReusedNotice = (projectKey, project) =>
  `[note] project_key ${projectKey} is already used by another project on this machine (a copied folder?); created a new project_key for ${project}`
export function registryLockPath(selfRoot) {
  return join(selfRoot, '.holoself', 'links.json.lock')
}
export function registryFilePath(selfRoot) {
  return join(selfRoot, '.holoself', 'links.json')
}
export function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}
export async function withRegistryLock(selfRoot, fn) {
  const lockPath = registryLockPath(selfRoot)
  ensureDir(dirname(lockPath))
  const backoffs = [50, 150, 450]
  let acquired = false
  for (let attempt = 0; attempt <= backoffs.length; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx')
      const payload = JSON.stringify({ pid: process.pid, timestamp: Date.now() }) + '\n'
      writeFileSync(fd, payload, 'utf8')
      closeSync(fd)
      acquired = true
      break
    } catch (err) {
      if (err.code === 'EEXIST') {
        let isStale = false
        try {
          const raw = readFileSync(lockPath, 'utf8')
          const parsed = JSON.parse(raw)
          const age = Date.now() - (parsed.timestamp || 0)
          if (age > 5000 || (parsed.pid && !isPidAlive(parsed.pid))) isStale = true
        } catch {
          isStale = true
        }
        if (isStale) {
          try {
            rmSync(lockPath, { force: true })
          } catch {}
          continue
        }
        if (attempt < backoffs.length) {
          await new Promise(r => setTimeout(r, backoffs[attempt]))
          continue
        }
      } else {
        throw err
      }
    }
  }
  if (!acquired) {
    const err = new Error('Timeout acquiring links registry lock')
    err.code = 'REGISTRY_LOCK_TIMEOUT'
    throw err
  }
  try {
    return await fn()
  } finally {
    try {
      rmSync(lockPath, { force: true })
    } catch {}
  }
}
export function readRegistry(selfRoot) {
  const path = registryFilePath(selfRoot)
  if (!pathExists(path)) return { raw: null, baseHash: '__ABSENT__', registry_hash: '__ABSENT__', links: [] }
  const raw = readFileSync(path, 'utf8'),
    baseHash = hash(raw)
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    const error = new Error(`corrupted links registry: ${path}`)
    error.code = 'REGISTRY_CORRUPT'
    throw error
  }
  if (!parsed || parsed.schema_version !== 1 || !Array.isArray(parsed.links)) {
    const error = new Error(`invalid links registry schema: ${path}`)
    error.code = 'REGISTRY_SCHEMA_INVALID'
    throw error
  }
  return { raw, baseHash, registry_hash: baseHash, links: parsed.links }
}
export function writeRegistry(selfRoot, linksOrFn, baseHash) {
  const path = registryFilePath(selfRoot)
  const currentBaseHash = pathExists(path) ? hash(readFileSync(path, 'utf8')) : '__ABSENT__'
  if (baseHash !== undefined && currentBaseHash !== baseHash) {
    const err = new Error('Concurrent modification detected in links registry')
    err.code = 'REGISTRY_CONCURRENT_MODIFICATION'
    throw err
  }
  let currentLinks = []
  if (pathExists(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      if (parsed && Array.isArray(parsed.links)) currentLinks = parsed.links
    } catch {}
  }
  const links = typeof linksOrFn === 'function' ? linksOrFn([...currentLinks]) : linksOrFn
  const sortedLinks = [...links].sort((a, b) => canonicalSort(a.project_id, b.project_id))
  const payload = { schema_version: 1, links: sortedLinks }
  ensureDir(dirname(path))
  atomicWriteFile(path, JSON.stringify(payload, null, 2) + '\n')
  return hash(JSON.stringify(payload, null, 2) + '\n')
}
