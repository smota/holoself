import { createHash, randomBytes } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { HASH_RE, SOURCE_ID_RE } from './catalog/schema.mjs'
export { CATALOG_SCHEMA_VERSION, SOURCE_ID_RE, validateCatalogSchema } from './catalog/schema.mjs'

export const CACHE_SCHEMA_VERSION = 4

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

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

export function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    const end = Date.now() + ms
    while (Date.now() < end) {}
  }
}

export function slash(p) {
  return String(p).replaceAll('\\', '/')
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

export function atomicWriteFile(targetPath, content, { mode = 0o600 } = {}) {
  const targetDir = dirname(targetPath)
  if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true })
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`
  const fd = openSync(tmpPath, 'w', mode)
  try {
    const buf = Buffer.from(content, 'utf8')
    let written = 0
    while (written < buf.length) {
      written += writeSync(fd, buf, written, buf.length - written)
    }
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

export function decisionCacheDir(projectDir) {
  return join(projectDir, '.holoself', 'runtime', 'context-cache')
}

const ALLOWED_CACHE_KEYS = new Set([
  'schema_version',
  'catalog_hash',
  'lens_registry_hash',
  'contrib_selection_hash',
  'links_register_hash',
  'identity_id',
  'lens',
  'allowed_lenses',
  'task_hash',
  'temporal',
  'include_history',
  'budget',
  'manifest',
  'requested_source_ids',
  'cursor',
  'source_refs',
  'receipt',
  'state_hash',
  'valid_until_epoch_ms',
  'estimated_tokens_total'
])
const ALLOWED_REF_KEYS = new Set(['space_id', 'source_id', 'revision', 'section_id'])
const ALLOWED_RECEIPT_KEYS = new Set(['schema_version', 'context_hash', 'task_hash', 'lens', 'budget', 'temporal', 'source_ids', 'source_hashes'])

export function validateDecisionCacheSchema(entry) {
  const errors = []
  if (!entry || typeof entry !== 'object') return { valid: false, errors: ['entry must be an object'] }
  for (const k of Object.keys(entry)) {
    if (!ALLOWED_CACHE_KEYS.has(k)) errors.push(`unknown property: ${k}`)
  }
  if (entry.schema_version !== CACHE_SCHEMA_VERSION) errors.push(`schema_version must be ${CACHE_SCHEMA_VERSION}`)
  if (typeof entry.catalog_hash !== 'string' || !HASH_RE.test(entry.catalog_hash)) errors.push('catalog_hash must be a 64-hex sha256')
  if (typeof entry.lens_registry_hash !== 'string' || !HASH_RE.test(entry.lens_registry_hash)) errors.push('lens_registry_hash must be a 64-hex sha256')
  if (typeof entry.contrib_selection_hash !== 'string' || !HASH_RE.test(entry.contrib_selection_hash))
    errors.push('contrib_selection_hash must be a 64-hex sha256')
  if (typeof entry.links_register_hash !== 'string' || !HASH_RE.test(entry.links_register_hash)) errors.push('links_register_hash must be a 64-hex sha256')
  if (typeof entry.identity_id !== 'string') errors.push('identity_id must be a string')
  if (entry.lens !== null && typeof entry.lens !== 'string') errors.push('lens must be string or null')
  if (!Array.isArray(entry.allowed_lenses)) errors.push('allowed_lenses must be an array')
  if (typeof entry.task_hash !== 'string' || !HASH_RE.test(entry.task_hash)) errors.push('task_hash must be a 64-hex sha256')
  if (!['current', 'historical', 'superseded', 'all'].includes(entry.temporal)) errors.push('temporal must be one of: current, historical, superseded, all')
  if (typeof entry.include_history !== 'boolean') errors.push('include_history must be boolean')
  if (!['small', 'standard', 'deep', 'unbounded'].includes(entry.budget)) errors.push('budget must be one of: small, standard, deep, unbounded')
  if (typeof entry.manifest !== 'boolean') errors.push('manifest must be boolean')
  if (!Object.hasOwn(entry, 'requested_source_ids') || (entry.requested_source_ids !== null && !Array.isArray(entry.requested_source_ids))) {
    errors.push('requested_source_ids must be array or null')
  } else if (Array.isArray(entry.requested_source_ids)) {
    for (let j = 0; j < entry.requested_source_ids.length; j++) {
      const id = entry.requested_source_ids[j]
      if (typeof id !== 'string' || !SOURCE_ID_RE.test(id)) errors.push(`requested_source_ids[${j}] must match ^hs-[0-9a-f]{20}$`)
    }
  }
  if (!Object.hasOwn(entry, 'cursor') || (entry.cursor !== null && typeof entry.cursor !== 'string')) errors.push('cursor must be string or null')
  if (!Array.isArray(entry.source_refs)) {
    errors.push('source_refs must be an array')
  } else {
    for (let j = 0; j < entry.source_refs.length; j++) {
      const ref = entry.source_refs[j]
      const rp = `source_refs[${j}]`
      if (!ref || typeof ref !== 'object') {
        errors.push(`${rp} must be an object`)
        continue
      }
      for (const k of Object.keys(ref)) {
        if (!ALLOWED_REF_KEYS.has(k)) errors.push(`${rp} unknown property: ${k}`)
      }
      if (typeof ref.space_id !== 'string') errors.push(`${rp}.space_id must be a string`)
      if (typeof ref.source_id !== 'string' || !SOURCE_ID_RE.test(ref.source_id)) errors.push(`${rp}.source_id must match hs-[0-9a-f]{20}`)
      if (typeof ref.revision !== 'string' || !HASH_RE.test(ref.revision)) errors.push(`${rp}.revision must be a 64-hex sha256`)
      if (ref.section_id !== null && typeof ref.section_id !== 'string') errors.push(`${rp}.section_id must be string or null`)
    }
  }
  if (!entry.receipt || typeof entry.receipt !== 'object') {
    errors.push('receipt must be an object')
  } else {
    for (const k of Object.keys(entry.receipt)) {
      if (!ALLOWED_RECEIPT_KEYS.has(k)) errors.push(`receipt unknown property: ${k}`)
    }
    if (entry.receipt.schema_version !== 1 && entry.receipt.schema_version !== 2) errors.push('receipt.schema_version must be 1 or 2')
    if (typeof entry.receipt.context_hash !== 'string' || !HASH_RE.test(entry.receipt.context_hash)) errors.push('receipt.context_hash must be 64-hex sha256')
    if (typeof entry.receipt.task_hash !== 'string' || !HASH_RE.test(entry.receipt.task_hash)) errors.push('receipt.task_hash must be 64-hex sha256')
    if (entry.receipt.lens !== null && typeof entry.receipt.lens !== 'string') errors.push('receipt.lens must be string or null')
    if (!['small', 'standard', 'deep', 'unbounded'].includes(entry.receipt.budget)) errors.push('receipt.budget must be valid budget')
    if (!['current', 'historical', 'superseded', 'all'].includes(entry.receipt.temporal)) errors.push('receipt.temporal must be valid temporal')
    if (!Array.isArray(entry.receipt.source_ids)) errors.push('receipt.source_ids must be array')
    if (!Array.isArray(entry.receipt.source_hashes)) errors.push('receipt.source_hashes must be array')
  }
  if (typeof entry.state_hash !== 'string' || !HASH_RE.test(entry.state_hash)) errors.push('state_hash must be 64-hex sha256')
  if (entry.valid_until_epoch_ms !== null && typeof entry.valid_until_epoch_ms !== 'number') errors.push('valid_until_epoch_ms must be integer or null')
  if (typeof entry.estimated_tokens_total !== 'number' || entry.estimated_tokens_total < 0) errors.push('estimated_tokens_total must be non-negative integer')

  return { valid: errors.length === 0, errors }
}

export function computeDecisionCacheKey({
  catalog_hash,
  lens_registry_hash,
  contrib_selection_hash,
  links_register_hash = sha256('[]'),
  identity_id,
  lens,
  allowed_lenses,
  task_hash,
  temporal,
  include_history,
  budget,
  manifest,
  requested_source_ids,
  cursor,
  session_start = false
}) {
  return sha256(
    canonicalJson({
      catalog_hash,
      lens_registry_hash,
      contrib_selection_hash,
      links_register_hash: links_register_hash || sha256('[]'),
      identity_id,
      lens,
      allowed_lenses: [...allowed_lenses].sort(canonicalSort),
      task_hash,
      temporal,
      include_history: Boolean(include_history),
      budget,
      manifest: Boolean(manifest),
      requested_source_ids: Array.isArray(requested_source_ids) && requested_source_ids.length ? [...requested_source_ids].sort(canonicalSort) : null,
      cursor: cursor || null,
      session_start: Boolean(session_start)
    })
  )
}

export function getDecisionCacheLimits(link = null) {
  const warnings = []
  const envEntries = parseInt(process.env.HOLOSELF_CACHE_MAX_ENTRIES, 10)
  const envBytes = parseInt(process.env.HOLOSELF_CACHE_MAX_BYTES, 10)
  let maxEntries = 256
  if (!Number.isNaN(envEntries)) {
    if (envEntries > 0) maxEntries = envEntries
    else warnings.push(`invalid HOLOSELF_CACHE_MAX_ENTRIES: ${envEntries}`)
  } else if (link?.cache_limit_entries !== undefined) {
    if (typeof link.cache_limit_entries === 'number' && link.cache_limit_entries > 0) maxEntries = link.cache_limit_entries
    else warnings.push(`invalid cache_limit_entries: ${link.cache_limit_entries}`)
  }

  let maxBytes = 20 * 1024 * 1024
  if (!Number.isNaN(envBytes)) {
    if (envBytes > 0) maxBytes = envBytes
    else warnings.push(`invalid HOLOSELF_CACHE_MAX_BYTES: ${envBytes}`)
  } else if (link?.cache_limit_bytes !== undefined) {
    if (typeof link.cache_limit_bytes === 'number' && link.cache_limit_bytes > 0) maxBytes = link.cache_limit_bytes
    else warnings.push(`invalid cache_limit_bytes: ${link.cache_limit_bytes}`)
  }
  return { maxEntries, maxBytes, warnings }
}

export function purgeInvalidDecisionCache(cacheDir) {
  if (!existsSync(cacheDir)) return
  try {
    const entries = readdirSync(cacheDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.includes('.tmp-') || !entry.name.endsWith('.json')) continue
      const filePath = join(cacheDir, entry.name)
      try {
        const text = readFileSync(filePath, 'utf8')
        const parsed = JSON.parse(text)
        const val = validateDecisionCacheSchema(parsed)
        if (!val.valid) {
          rmSync(filePath, { force: true })
        }
      } catch {
        rmSync(filePath, { force: true })
      }
    }
  } catch {}
}

export function evictDecisionCache(cacheDir, { maxEntries = 256, maxBytes = 20 * 1024 * 1024 } = {}) {
  if (!existsSync(cacheDir)) return
  try {
    const entries = readdirSync(cacheDir, { withFileTypes: true })
    const files = []
    let totalBytes = 0
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.includes('.tmp-') || !entry.name.endsWith('.json')) continue
      const filePath = join(cacheDir, entry.name)
      try {
        const st = statSync(filePath)
        files.push({ path: filePath, size: st.size, mtimeMs: st.mtimeMs })
        totalBytes += st.size
      } catch {}
    }
    if (files.length <= maxEntries && totalBytes <= maxBytes) return
    files.sort((a, b) => a.mtimeMs - b.mtimeMs)
    while ((files.length > maxEntries || totalBytes > maxBytes) && files.length > 0) {
      const oldest = files.shift()
      try {
        rmSync(oldest.path, { force: true })
      } catch {}
      totalBytes -= oldest.size
    }
  } catch {}
}

export function readDecisionCache(cacheDir, cacheKey, options = {}) {
  if (!cacheDir || !cacheKey) return null
  const filePath = join(cacheDir, `${cacheKey}.json`)
  if (!existsSync(filePath)) return null
  let entry
  try {
    entry = JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    try {
      rmSync(filePath, { force: true })
    } catch {}
    return null
  }
  const val = validateDecisionCacheSchema(entry)
  if (!val.valid) {
    try {
      rmSync(filePath, { force: true })
    } catch {}
    return null
  }
  const now = options.now ? (typeof options.now === 'number' ? options.now : Date.parse(options.now)) : Date.now()
  if (entry.valid_until_epoch_ms !== null && now >= entry.valid_until_epoch_ms) {
    return null
  }
  try {
    const nowDate = new Date(now)
    utimesSync(filePath, nowDate, nowDate)
  } catch {}
  return entry
}

export function writeDecisionCache(cacheDir, cacheKey, entry, limits = {}) {
  if (!cacheDir || !cacheKey) return
  const val = validateDecisionCacheSchema(entry)
  if (!val.valid) throw new Error(`invalid decision cache entry: ${val.errors.join('; ')}`)
  const targetPath = join(cacheDir, `${cacheKey}.json`)
  atomicWriteFile(targetPath, JSON.stringify(entry, null, 2) + '\n', { mode: 0o600 })
  evictDecisionCache(cacheDir, limits)
}
