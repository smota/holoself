// Optional SQLite FTS5 lexical index (issue #69).
//
// The index is a derived, disposable cache of the self catalog's section snippets, stored at
// <self>/.holoself/catalog/fts5.sqlite (mode 0600, git-ignored with catalog/). It is never authority:
// it is rebuilt whenever the catalog freshness inputs change, it is safe to delete, and a missing,
// stale, corrupt or symlinked file only means the same text is tokenized in memory instead.
//
// Privacy: the caller passes only documents that already passed its privacy gate, with section text
// that already went through claim and field filtering. BM25 statistics (document count, document
// frequency, average length) are computed over exactly those documents, so hidden documents never
// contribute to a score, a count or an order. The persistent file only supplies tokens for sections
// whose filtered text is byte-identical to the catalog snippet; any other text is tokenized in a
// connection-local in-memory database that is discarded after the call.
import { chmodSync, closeSync, openSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { CATALOG_SCHEMA_VERSION, canonicalJson } from '../catalog.mjs'
import { tokenize } from '../markdown/text.mjs'
import { linkBelow, lstat } from '../path-guard.mjs'
import { ensureDir, hash, sleepSync } from '../shared/fs.mjs'
import { catalogRoot } from './source.mjs'

export const ENGINE_FTS5 = 'fts5'
export const ENGINE_JSON = 'deterministic-json'
export const FTS_FILE = 'fts5.sqlite'
export const FTS_SCHEMA_VERSION = 1
// Preferred tokenizer first; older SQLite builds without remove_diacritics 2 or porter fall back.
const TOKENIZERS = ['porter unicode61 remove_diacritics 2', 'porter unicode61 remove_diacritics 1', 'unicode61 remove_diacritics 1']
const K1 = 1.2,
  B = 0.75,
  HEADING_WEIGHT = 2,
  PREFIX_WEIGHT = 0.5,
  MIN_PREFIX_LENGTH = 4
// Maximum lexical bonus added to the token-overlap relevance score of the best BM25 match.
export const LEXICAL_WEIGHT = 4
const MAX_CHAR = String.fromCodePoint(0x10ffff)
// Temporary build files left by an interrupted rebuild are removed after this age.
export const STALE_TMP_MS = 10 * 60 * 1000
const TMP_RE = /^fts5\.sqlite\.tmp-/

const require = createRequire(import.meta.url)
let support

// node:sqlite prints an ExperimentalWarning on first load; that one warning is filtered so CLI stderr stays clean.
function loadSqlite() {
  const original = process.emitWarning
  process.emitWarning = function (warning, ...args) {
    const type = typeof args[0] === 'string' ? args[0] : args[0]?.type || warning?.name
    if (type === 'ExperimentalWarning' && /sqlite/i.test(String(warning?.message ?? warning))) return
    return original.call(this, warning, ...args)
  }
  try {
    return require('node:sqlite')
  } catch {
    return null
  } finally {
    process.emitWarning = original
  }
}

// Test-only: HOLOSELF_TEST_DISABLE_SQLITE simulates a Node build without node:sqlite, honoured only under node --test.
function sqliteDisabledForTests() {
  return Boolean(process.env.NODE_TEST_CONTEXT && process.env.HOLOSELF_TEST_DISABLE_SQLITE === '1')
}

// Feature detection: node:sqlite loads unflagged (Node 22.13+) and an FTS5 table with fts5vocab can be created.
export function ftsSupport() {
  if (sqliteDisabledForTests()) return null
  if (support !== undefined) return support
  support = null
  const sqlite = loadSqlite()
  if (!sqlite?.DatabaseSync) return support
  for (const tokenizer of TOKENIZERS) {
    let db
    try {
      db = new sqlite.DatabaseSync(':memory:')
      db.exec(schemaSql(tokenizer))
      support = { DatabaseSync: sqlite.DatabaseSync, tokenizer }
      break
    } catch {
      // try the next tokenizer
    } finally {
      try {
        db?.close()
      } catch {}
    }
  }
  return support
}

export function requestedEngine(env = process.env) {
  const value = String(env.HOLOSELF_INDEX_ENGINE || 'auto')
    .trim()
    .toLowerCase()
  if (value === 'json' || value === ENGINE_JSON) return 'json'
  if (value === 'fts5' || value === 'sqlite') return 'fts5'
  return 'auto'
}

// The engine that ranks this process's retrieval: FTS5 when available and not forced off, otherwise the JSON engine.
export function indexEngine(env = process.env) {
  return requestedEngine(env) !== 'json' && ftsSupport() ? ENGINE_FTS5 : ENGINE_JSON
}

function schemaSql(tokenizer) {
  return (
    `CREATE VIRTUAL TABLE sections USING fts5(heading, body, tokenize = '${tokenizer}');` +
    `CREATE VIRTUAL TABLE sections_vocab USING fts5vocab(sections, 'instance');`
  )
}

// Lowercase, Unicode NFKD and diacritic stripping before FTS5 tokenization (unicode61 also folds diacritics).
export function normalizeText(text) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
}

const sectionKey = (sourceId, sectionId) => `${sourceId}\0${sectionId}`
const textHash = (heading, body) => hash(`${normalizeText(heading)}\0${normalizeText(body)}`)

export function ftsIndexPath(selfRoot) {
  return join(catalogRoot(selfRoot), FTS_FILE)
}

// Same freshness inputs as the catalog: schema, lens registry, and each source's content hash and stat tuple.
export function ftsFingerprint(partition, tokenizer) {
  return hash(
    canonicalJson({
      fts_schema_version: FTS_SCHEMA_VERSION,
      catalog_schema_version: CATALOG_SCHEMA_VERSION,
      tokenizer,
      space_id: partition?.space_id || 'self',
      lens_registry_hash: partition?.lens_registry_hash || null,
      sources: (partition?.sources || []).map(s => [s.file, s.source_text_hash, s.size, s.mtime_ns, s.ino, s.dev])
    })
  )
}

function partitionRows(partition) {
  const rows = []
  for (const source of partition?.sources || []) {
    const sourceId = source.source_ref?.source_id
    if (!sourceId) continue
    for (const section of source.sections || []) {
      rows.push({ source_id: sourceId, section_id: section.section_id, heading: section.heading || '', body: section.snippet || '' })
    }
  }
  return rows
}

function insertRows(db, rows, firstRowid = 1) {
  const insert = db.prepare('INSERT INTO sections(rowid, heading, body) VALUES (?, ?, ?)')
  let rowid = firstRowid
  for (const row of rows) insert.run(rowid++, normalizeText(row.heading), normalizeText(row.body))
}

function rowLengths(db) {
  const lengths = new Map()
  for (const row of db.prepare('SELECT doc, count(*) AS n FROM sections_vocab GROUP BY doc').all()) lengths.set(Number(row.doc), Number(row.n))
  return lengths
}

function buildDatabase(path, rows, fingerprint, sup) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
  closeSync(openSync(tmp, 'wx', 0o600))
  try {
    const db = new sup.DatabaseSync(tmp)
    try {
      db.exec('PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;')
      db.exec(schemaSql(sup.tokenizer))
      db.exec('CREATE TABLE rows (rowid INTEGER PRIMARY KEY, source_id TEXT NOT NULL, section_id TEXT NOT NULL, text_hash TEXT NOT NULL, length INTEGER NOT NULL);')
      db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);')
      db.exec('BEGIN')
      insertRows(db, rows)
      const lengths = rowLengths(db)
      const insertRow = db.prepare('INSERT INTO rows(rowid, source_id, section_id, text_hash, length) VALUES (?, ?, ?, ?, ?)')
      rows.forEach((row, i) => insertRow.run(i + 1, row.source_id, row.section_id, textHash(row.heading, row.body), lengths.get(i + 1) || 0))
      const insertMeta = db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)')
      insertMeta.run('fingerprint', fingerprint)
      insertMeta.run('tokenizer', sup.tokenizer)
      insertMeta.run('schema_version', String(FTS_SCHEMA_VERSION))
      db.exec('COMMIT')
      db.exec("INSERT INTO sections(sections) VALUES ('optimize')")
    } finally {
      db.close()
    }
    if (process.platform !== 'win32') chmodSync(tmp, 0o600)
    replaceCacheFile(tmp, path)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

// Removes regular files named fts5.sqlite.tmp-* older than STALE_TMP_MS from the catalog directory.
// Symlinks (and anything reached through one) are never followed or removed; a younger file may be a concurrent build.
export function removeStaleTempFiles(selfRoot, now = Date.now()) {
  const removed = []
  let dir
  try {
    dir = catalogRoot(selfRoot)
    if (linkBelow(selfRoot, dir, {}) !== null || !lstat(dir)?.isDirectory()) return removed
  } catch {
    return removed
  }
  let names = []
  try {
    names = readdirSync(dir).filter(name => TMP_RE.test(name)).sort()
  } catch {
    return removed
  }
  for (const name of names) {
    const target = join(dir, name)
    try {
      const entry = lstat(target)
      if (!entry || entry.isSymbolicLink() || !entry.isFile() || linkBelow(selfRoot, target) !== null) continue
      if (now - entry.mtimeMs <= STALE_TMP_MS) continue
      rmSync(target)
      removed.push(name)
    } catch {}
  }
  return removed
}

// Windows refuses to replace a file another process holds open: retry briefly, then report the cache as busy
// (the caller tokenizes in memory for this call, with identical scores).
function replaceCacheFile(from, to) {
  const backoffs = [20, 50, 100]
  for (let attempt = 0; ; attempt++) {
    try {
      return renameSync(from, to)
    } catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error
      if (attempt >= backoffs.length) {
        const busy = new Error('FTS cache busy')
        busy.code = 'FTS_CACHE_BUSY'
        throw busy
      }
      sleepSync(backoffs[attempt])
    }
  }
}

function openReadOnly(path, sup) {
  try {
    return new sup.DatabaseSync(path, { readOnly: true })
  } catch {
    return new sup.DatabaseSync(path)
  }
}

function readFingerprint(db) {
  try {
    return db.prepare("SELECT value FROM meta WHERE key = 'fingerprint'").get()?.value || null
  } catch {
    return null
  }
}

// Opens the persistent cache for the self partition, rebuilding it when stale, missing or unreadable.
// Returns { db, status } or { db: null, status } when the file cannot be used safely (the caller then
// tokenizes in memory, which yields the same scores).
export function openFtsIndex(selfRoot, partition, options = {}) {
  const sup = ftsSupport()
  if (!sup || !selfRoot || !partition) return { db: null, status: 'unavailable' }
  let path
  try {
    path = ftsIndexPath(selfRoot)
    if (linkBelow(selfRoot, path) !== null) return { db: null, status: 'refused-symlink' }
  } catch {
    return { db: null, status: 'refused-path' }
  }
  const fingerprint = ftsFingerprint(partition, sup.tokenizer)
  const existing = lstat(path)
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) return { db: null, status: 'refused-symlink' }
  if (existing && !options.rebuild) {
    let db = null
    try {
      db = openReadOnly(path, sup)
      if (readFingerprint(db) === fingerprint) return { db, status: 'fresh' }
    } catch {}
    try {
      db?.close()
    } catch {}
  }
  try {
    ensureDir(catalogRoot(selfRoot))
    if (linkBelow(selfRoot, path) !== null) return { db: null, status: 'refused-symlink' }
    removeStaleTempFiles(selfRoot)
    buildDatabase(path, partitionRows(partition), fingerprint, sup)
    return { db: openReadOnly(path, sup), status: 'rebuilt' }
  } catch (error) {
    return { db: null, status: error?.code === 'FTS_CACHE_BUSY' ? 'busy' : 'unwritable' }
  }
}

// Ensures the persistent cache is fresh (used by `holoself index`); returns its status only.
export function ensureFtsIndex(selfRoot, partition, options = {}) {
  const opened = openFtsIndex(selfRoot, partition, options)
  try {
    opened.db?.close()
  } catch {}
  return opened.status
}

function tokenInstances(db, terms, wanted) {
  // terms: [{ term, prefix }]; returns Map(termIndex -> Map(rowid -> { exact, prefix }))
  const exact = db.prepare('SELECT doc, col FROM sections_vocab WHERE term = ?')
  const ranged = db.prepare('SELECT doc, col, term FROM sections_vocab WHERE term > ? AND term < ?')
  const out = terms.map(() => new Map())
  terms.forEach((t, index) => {
    const add = (row, kind) => {
      const doc = Number(row.doc)
      if (!wanted.has(doc)) return
      const weight = row.col === 'heading' ? HEADING_WEIGHT : 1
      const entry = out[index].get(doc) || { exact: 0, prefix: 0 }
      entry[kind] += weight
      out[index].set(doc, entry)
    }
    for (const row of exact.all(t.term)) add(row, 'exact')
    if (t.prefix) for (const row of ranged.all(t.term, t.term + MAX_CHAR)) add(row, 'prefix')
  })
  return out
}

// Query terms: tokens (stopwords removed unless that leaves none) stemmed by the index tokenizer, de-duplicated.
function queryTerms(mem, query, options = {}) {
  const normalized = normalizeText(query)
  let tokens = tokenize(normalized)
  if (!tokens.length && options.keepStopwords) tokens = tokenize(normalized, { stopwords: false })
  if (!tokens.length) return []
  mem.exec(`CREATE VIRTUAL TABLE q USING fts5(x, tokenize = '${ftsSupport().tokenizer}'); CREATE VIRTUAL TABLE q_vocab USING fts5vocab(q, 'instance');`)
  const insert = mem.prepare('INSERT INTO q(rowid, x) VALUES (?, ?)')
  tokens.forEach((token, i) => insert.run(i + 1, token))
  const seen = new Set(),
    terms = []
  for (const row of mem.prepare('SELECT term FROM q_vocab ORDER BY doc, offset').all()) {
    if (seen.has(row.term)) continue
    seen.add(row.term)
    terms.push({ term: row.term, prefix: row.term.length >= MIN_PREFIX_LENGTH })
  }
  return terms
}

/**
 * BM25 over the caller's privacy-filtered documents only.
 * docs: [{ id, sections: [{ source_id, section_id, heading, text }] }]
 * Returns Map(id -> { bm25, matched, terms }) where matched counts query terms found (exactly or by prefix).
 * Returns null when FTS5 is unavailable or disabled.
 */
export function lexicalScores(docs, query, options = {}) {
  const sup = ftsSupport()
  if (!sup || requestedEngine(options.env || process.env) === 'json') return null
  try {
    return scoreDocuments(sup, docs, query, options)
  } catch {
    // Fail open to the JSON ranking: the index is an optional accelerator, never a reason to refuse context.
    return null
  }
}

function scoreDocuments(sup, docs, query, options) {
  const mem = new sup.DatabaseSync(':memory:')
  const opened = options.selfRoot && options.partition ? openFtsIndex(options.selfRoot, options.partition) : { db: null, status: 'memory' }
  try {
    mem.exec(schemaSql(sup.tokenizer))
    const terms = queryTerms(mem, query, options)
    const result = new Map()
    if (!terms.length) {
      for (const doc of docs) result.set(doc.id, { bm25: 0, matched: 0, terms: 0 })
      return result
    }
    // Map each section to a cached row (identical text) or an in-memory row.
    const cached = new Map()
    if (opened.db) {
      for (const row of opened.db.prepare('SELECT rowid, source_id, section_id, text_hash, length FROM rows').all())
        cached.set(sectionKey(row.source_id, row.section_id), { rowid: Number(row.rowid), text_hash: row.text_hash, length: Number(row.length) })
    }
    const diskRows = new Map(),
      memRows = new Map(),
      pending = []
    docs.forEach((doc, docIndex) => {
      for (const section of doc.sections || []) {
        const heading = section.heading || '',
          body = section.text || ''
        if (!normalizeText(`${heading} ${body}`).trim()) continue
        const hit = cached.get(sectionKey(section.source_id, section.section_id))
        if (hit && hit.text_hash === textHash(heading, body)) {
          const list = diskRows.get(hit.rowid) || []
          list.push(docIndex)
          diskRows.set(hit.rowid, list)
        } else pending.push({ docIndex, heading, body })
      }
    })
    let memLengths = new Map()
    if (pending.length) {
      insertRows(mem, pending.map(p => ({ heading: p.heading, body: p.body })))
      pending.forEach((p, i) => memRows.set(i + 1, [p.docIndex]))
      memLengths = rowLengths(mem)
    }
    // Per-document term frequencies and lengths.
    const tf = docs.map(() => terms.map(() => ({ exact: 0, prefix: 0 }))),
      lengths = docs.map(() => 0)
    const cachedLengths = new Map([...cached.values()].map(value => [value.rowid, value.length]))
    for (const [rowid, owners] of diskRows) for (const docIndex of owners) lengths[docIndex] += cachedLengths.get(rowid) || 0
    for (const [rowid, owners] of memRows) for (const docIndex of owners) lengths[docIndex] += memLengths.get(rowid) || 0
    const accumulate = (instances, rowsByRowid) =>
      instances.forEach((perRow, termIndex) => {
        for (const [rowid, counts] of perRow)
          for (const docIndex of rowsByRowid.get(rowid) || []) {
            tf[docIndex][termIndex].exact += counts.exact
            tf[docIndex][termIndex].prefix += counts.prefix
          }
      })
    if (diskRows.size) accumulate(tokenInstances(opened.db, terms, new Set(diskRows.keys())), diskRows)
    if (memRows.size) accumulate(tokenInstances(mem, terms, new Set(memRows.keys())), memRows)
    const n = docs.length || 1,
      avgdl = lengths.reduce((sum, value) => sum + value, 0) / n || 1
    const idf = terms.map((_, termIndex) => {
      const df = tf.filter(row => row[termIndex].exact + row[termIndex].prefix > 0).length
      return Math.log(1 + (n - df + 0.5) / (df + 0.5))
    })
    docs.forEach((doc, docIndex) => {
      let score = 0,
        matched = 0
      terms.forEach((_, termIndex) => {
        const { exact, prefix } = tf[docIndex][termIndex],
          f = exact + PREFIX_WEIGHT * prefix
        if (f <= 0) return
        matched++
        score += (idf[termIndex] * (f * (K1 + 1))) / (f + K1 * (1 - B + (B * lengths[docIndex]) / avgdl))
      })
      result.set(doc.id, { bm25: Math.round(score * 1e6) / 1e6, matched, terms: terms.length })
    })
    return result
  } finally {
    try {
      opened.db?.close()
    } catch {}
    try {
      mem.close()
    } catch {}
  }
}

// Context ranking signal: BM25 scaled to [0, LEXICAL_WEIGHT] relative to the best candidate, by source_id.
export function lexicalBonuses(scores) {
  if (!scores) return null
  const max = Math.max(0, ...[...scores.values()].map(s => s.bm25))
  const bonuses = new Map()
  for (const [id, s] of scores) bonuses.set(id, max > 0 ? Math.round((LEXICAL_WEIGHT * s.bm25 * 1e4) / max) / 1e4 : 0)
  return bonuses
}
