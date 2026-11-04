import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWrite as atomicWriteFile, hash as sha256, slash, sleepSync } from './shared/fs.mjs'
export { CATALOG_SCHEMA_VERSION, SOURCE_ID_RE, validateCatalogSchema } from './catalog/schema.mjs'
export { atomicWriteFile, sha256, slash, sleepSync }

export function canonicalSort(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

export function canonicalJson(val) {
  if (val === undefined || typeof val === 'function') return undefined
  if (val === null) return 'null'
  if (typeof val === 'number') return Number.isFinite(val) ? String(val) : 'null'
  if (typeof val === 'boolean') return String(val)
  if (typeof val === 'string') return JSON.stringify(val)
  if (val instanceof Date) return JSON.stringify(val.toISOString())
  if (Array.isArray(val)) {
    const out = []
    for (let i = 0; i < val.length; i++) {
      const item = val[i]
      const s = canonicalJson(item)
      out.push(s === undefined ? 'null' : s)
    }
    return '[' + out.join(',') + ']'
  }
  if (typeof val === 'object') {
    const keys = Object.keys(val)
      .filter(k => val[k] !== undefined && typeof val[k] !== 'function')
      .sort(canonicalSort)
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(val[k])).join(',') + '}'
  }
  return JSON.stringify(val)
}

export function sourceRef(spaceId, relPath, contentHash, sectionId = null) {
  const normalized = slash(relPath).normalize('NFC')
  const canonicalPath = process.platform === 'win32' ? normalized.toLowerCase() : normalized
  const sourceId = `hs-${sha256(spaceId + '\0' + canonicalPath).slice(0, 20)}`
  return {
    space_id: spaceId,
    source_id: sourceId,
    revision: contentHash,
    section_id: sectionId
  }
}

export function purgeLegacyIndex(projectDir) {
  const legacyDir = join(projectDir, '.holoself', 'index')
  if (!existsSync(legacyDir)) return { purged: false }
  const backoffs = [20, 50, 100]
  let lastErr = null
  for (let attempt = 0; attempt <= backoffs.length; attempt++) {
    try {
      rmSync(legacyDir, { recursive: true, force: true })
      lastErr = null
      break
    } catch (err) {
      lastErr = err
      if (attempt < backoffs.length) {
        sleepSync(backoffs[attempt])
      }
    }
  }
  if (lastErr || existsSync(legacyDir)) {
    const err = new Error(`LEGACY_INDEX_PURGE_FAILED: could not remove legacy index directory ${legacyDir}: ${lastErr?.message || 'directory still exists'}`)
    err.code = 'LEGACY_INDEX_PURGE_FAILED'
    throw err
  }
  return { purged: true }
}

export function cleanupStaleTempFiles(dir, maxAgeMs = 300000) {
  if (!existsSync(dir)) return 0
  let cleaned = 0
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
    const now = Date.now()
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.includes('.tmp-')) continue
      const match = entry.name.match(/\.tmp-(\d+)-(\d+)-/)
      if (!match) continue
      const pid = parseInt(match[1], 10),
        timestamp = parseInt(match[2], 10)
      if (now - timestamp < maxAgeMs) continue
      let alive = true
      try {
        process.kill(pid, 0)
      } catch {
        alive = false
      }
      if (!alive) {
        try {
          rmSync(join(dir, entry.name), { force: true })
          cleaned++
        } catch {}
      }
    }
  } catch {}
  return cleaned
}

export function getStatTuple(filePath) {
  const st = statSync(filePath, { bigint: true })
  return {
    size: Number(st.size),
    modified_ms: Number(st.mtimeMs),
    mtime_ns: st.mtimeNs.toString(10),
    ino: st.ino.toString(10),
    dev: st.dev.toString(10)
  }
}

export function readSourceWithStat(filePath, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const s0 = getStatTuple(filePath)
      const text = readFileSync(filePath, 'utf8')
      const s1 = getStatTuple(filePath)
      if (s0.size === s1.size && s0.mtime_ns === s1.mtime_ns && s0.ino === s1.ino && s0.dev === s1.dev) {
        return { text, stat: s0 }
      }
      if (attempt < maxRetries) sleepSync(20 * (attempt + 1))
    } catch (err) {
      if (err.code === 'ENOENT') return null
      if (attempt === maxRetries) return null
      sleepSync(20 * (attempt + 1))
    }
  }
  return null
}

export function slugHeading(heading) {
  return (
    heading
      .toLowerCase()
      .normalize('NFC')
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-|-$/g, '') || 'section'
  )
}
