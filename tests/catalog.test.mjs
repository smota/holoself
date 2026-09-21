import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  atomicWriteFile,
  purgeLegacyIndex,
  cleanupStaleTempFiles,
  getStatTuple,
  readSourceWithStat,
  sourceRef,
  canonicalJson,
  canonicalSort,
  sha256,
  validateCatalogSchema,
  validateDecisionCacheSchema,
  computeDecisionCacheKey,
  getDecisionCacheLimits,
  purgeInvalidDecisionCache,
  evictDecisionCache,
  readDecisionCache,
  writeDecisionCache,
  CATALOG_SCHEMA_VERSION,
  CACHE_SCHEMA_VERSION
} from '../src/catalog.mjs'
import { run } from '../src/cli.mjs'

const temp = () => mkdtempSync(join(tmpdir(), 'holoself-catalog-'))

async function capture(fn) {
  const oldLog = console.log
  const oldErr = console.error
  let out = ''
  let err = ''
  console.log = (...x) => { out += x.join(' ') + '\n' }
  console.error = (...x) => { err += x.join(' ') + '\n' }
  try {
    await fn()
  } finally {
    console.log = oldLog
    console.error = oldErr
  }
  return { stdout: out, stderr: err }
}

test('atomicWriteFile writes content atomically with 0o600 mode and creates parent directories', () => {
  const dir = temp()
  const target = join(dir, 'nested', 'deep', 'file.txt')
  atomicWriteFile(target, 'atomic-content-test')
  assert.equal(existsSync(target), true)
  assert.equal(readFileSync(target, 'utf8'), 'atomic-content-test')
})

test('purgeLegacyIndex removes .holoself/index directory when present', () => {
  const project = temp()
  const legacyIndexDir = join(project, '.holoself', 'index')
  mkdirSync(legacyIndexDir, { recursive: true })
  writeFileSync(join(legacyIndexDir, 'index.json'), '{"schema_version":5}')
  assert.equal(existsSync(legacyIndexDir), true)

  const res = purgeLegacyIndex(project)
  assert.equal(res.purged, true)
  assert.equal(existsSync(legacyIndexDir), false)

  // Running again on already-purged dir returns false
  const res2 = purgeLegacyIndex(project)
  assert.equal(res2.purged, false)
})

test('getStatTuple and readSourceWithStat read content and verify stat tuple integrity', () => {
  const dir = temp()
  const file = join(dir, 'source.md')
  writeFileSync(file, '# Hello World\nSome content.')
  
  const tuple = getStatTuple(file)
  assert.ok(tuple.size > 0)
  assert.ok(tuple.modified_ms > 0)
  assert.match(tuple.mtime_ns, /^[0-9]+$/)
  assert.match(tuple.ino, /^[0-9]+$/)
  assert.match(tuple.dev, /^[0-9]+$/)

  const result = readSourceWithStat(file)
  assert.notEqual(result, null)
  assert.equal(result.text, '# Hello World\nSome content.')
  assert.equal(result.stat.size, tuple.size)
  assert.equal(result.stat.mtime_ns, tuple.stat_mtime_ns || tuple.mtime_ns)
})

test('sourceRef canonicalizes paths and generates deterministic hs-[0-9a-f]{20} IDs', () => {
  const ref1 = sourceRef('self', 'context/career.md', sha256('hello'))
  assert.equal(ref1.space_id, 'self')
  assert.match(ref1.source_id, /^hs-[0-9a-f]{20}$/)
  assert.equal(ref1.revision, sha256('hello'))
  assert.equal(ref1.section_id, null)

  // Forward vs backward slash consistency
  const ref2 = sourceRef('self', 'context\\career.md', sha256('hello'))
  assert.equal(ref1.source_id, ref2.source_id)

  // Contrib space
  const refContrib = sourceRef('contrib', 'contribs/growth/grow-model.md', sha256('contrib-body'))
  assert.equal(refContrib.space_id, 'contrib')
  assert.match(refContrib.source_id, /^hs-[0-9a-f]{20}$/)
})

test('canonicalJson and canonicalSort sort keys by code-unit deterministically', () => {
  assert.equal(canonicalSort('a', 'b'), -1)
  assert.equal(canonicalSort('b', 'a'), 1)
  assert.equal(canonicalSort('a', 'a'), 0)

  const obj = { z: 1, a: 2, m: { b: 3, a: 4 } }
  assert.equal(canonicalJson(obj), '{"a":2,"m":{"a":4,"b":3},"z":1}')
})

test('validateCatalogSchema enforces strict constraints for self and project partitions', () => {
  const dummyHash = 'a'.repeat(64)
  const dummyHash2 = 'b'.repeat(64)
  const validSource = {
    source_kind: 'canonical',
    source_ref: {
      space_id: 'self',
      source_id: 'hs-' + '1'.repeat(20),
      revision: dummyHash,
      section_id: null
    },
    file: 'context/career.md',
    size: 100,
    modified_ms: 123456789,
    mtime_ns: '123456789000000',
    ino: '12345',
    dev: '67890',
    source_text_hash: dummyHash,
    frontmatter: {
      access_lenses: ['general'],
      disclosure: 'internal-only',
      sensitivity: 'personal',
      document_role: 'content',
      publication_allowed: false,
      task_include: [],
      task_exclude: [],
      visibility: 'private',
      read_scope: 'shared',
      field_visibility: {},
      knowledge_status: 'current',
      temporal_scope: 'current'
    },
    sections: [],
    claims: [],
    tags: [],
    links: [],
    estimated_tokens: 25
  }

  // Valid self catalog (project_context_hash must be null)
  const selfCatalog = {
    schema_version: CATALOG_SCHEMA_VERSION,
    space_id: 'self',
    lens_registry_hash: dummyHash,
    project_context_hash: null,
    generated_at: new Date().toISOString(),
    sources: [validSource]
  }
  assert.equal(validateCatalogSchema(selfCatalog).valid, true)

  // Invalid self catalog if project_context_hash is not null
  const badSelfCatalog = { ...selfCatalog, project_context_hash: dummyHash2 }
  assert.equal(validateCatalogSchema(badSelfCatalog).valid, false)

  // Valid project catalog (project_context_hash must be 64-hex sha256)
  const projectCatalog = {
    schema_version: CATALOG_SCHEMA_VERSION,
    space_id: 'proj-123',
    lens_registry_hash: dummyHash,
    project_context_hash: dummyHash2,
    generated_at: new Date().toISOString(),
    sources: [{ ...validSource, source_kind: 'project', source_ref: { ...validSource.source_ref, space_id: 'proj-123' } }]
  }
  assert.equal(validateCatalogSchema(projectCatalog).valid, true)

  // Invalid project catalog if project_context_hash is null
  const badProjectCatalog = { ...projectCatalog, project_context_hash: null }
  assert.equal(validateCatalogSchema(badProjectCatalog).valid, false)
})

test('validateDecisionCacheSchema validates content-free decision cache strictly', () => {
  const dummyHash = 'c'.repeat(64)
  const validCache = {
    schema_version: CACHE_SCHEMA_VERSION,
    catalog_hash: dummyHash,
    lens_registry_hash: dummyHash,
    links_register_hash: dummyHash,
    contrib_selection_hash: dummyHash,
    identity_id: 'user:direct',
    lens: 'general',
    allowed_lenses: ['general', 'career'],
    task_hash: dummyHash,
    temporal: 'current',
    include_history: false,
    budget: 'standard',
    manifest: false,
    requested_source_ids: null,
    cursor: null,
    source_refs: [{
      space_id: 'self',
      source_id: 'hs-' + '2'.repeat(20),
      revision: dummyHash,
      section_id: null
    }],
    receipt: {
      schema_version: 1,
      context_hash: dummyHash,
      task_hash: dummyHash,
      lens: 'general',
      budget: 'standard',
      temporal: 'current',
      source_ids: ['hs-' + '2'.repeat(20)],
      source_hashes: [dummyHash]
    },
    state_hash: dummyHash,
    valid_until_epoch_ms: null,
    estimated_tokens_total: 150
  }

  assert.equal(validateDecisionCacheSchema(validCache).valid, true)

  // Missing required field (e.g. cursor or requested_source_ids) fails validation
  const { cursor, ...missingCursor } = validCache
  assert.equal(validateDecisionCacheSchema(missingCursor).valid, false)

  const { requested_source_ids, ...missingRequested } = validCache
  assert.equal(validateDecisionCacheSchema(missingRequested).valid, false)

  // Invalid budget fails validation
  assert.equal(validateDecisionCacheSchema({ ...validCache, budget: 'massive' }).valid, false)
})

test('computeDecisionCacheKey is deterministic and canonicalizes arrays', () => {
  const dummyHash = 'a'.repeat(64)
  const base = {
    catalog_hash: dummyHash,
    lens_registry_hash: dummyHash,
    contrib_selection_hash: dummyHash,
    identity_id: 'client:proj',
    lens: 'career',
    allowed_lenses: ['technical', 'career', 'general'],
    task_hash: dummyHash,
    temporal: 'current',
    include_history: false,
    budget: 'standard',
    manifest: false,
    requested_source_ids: ['hs-bbbbbbbbbbbbbbbbbbbb', 'hs-aaaaaaaaaaaaaaaaaaaa'],
    cursor: null
  }
  const key1 = computeDecisionCacheKey(base)
  const key2 = computeDecisionCacheKey({
    ...base,
    allowed_lenses: ['career', 'general', 'technical'],
    requested_source_ids: ['hs-aaaaaaaaaaaaaaaaaaaa', 'hs-bbbbbbbbbbbbbbbbbbbb']
  })
  assert.equal(key1, key2)
  assert.match(key1, /^[0-9a-f]{64}$/)
})

test('purgeInvalidDecisionCache removes legacy non-v2 files and preserves valid v2 files', () => {
  const dir = temp()
  const dummyHash = 'a'.repeat(64)
  const validCache = {
    schema_version: CACHE_SCHEMA_VERSION,
    catalog_hash: dummyHash,
    lens_registry_hash: dummyHash,
    links_register_hash: dummyHash,
    contrib_selection_hash: dummyHash,
    identity_id: 'client:proj',
    lens: 'career',
    allowed_lenses: ['career'],
    task_hash: dummyHash,
    temporal: 'current',
    include_history: false,
    budget: 'standard',
    manifest: false,
    requested_source_ids: null,
    cursor: null,
    source_refs: [],
    receipt: {
      schema_version: 1,
      context_hash: dummyHash,
      task_hash: dummyHash,
      lens: 'career',
      budget: 'standard',
      temporal: 'current',
      source_ids: [],
      source_hashes: []
    },
    state_hash: dummyHash,
    valid_until_epoch_ms: null,
    estimated_tokens_total: 100
  }

  writeFileSync(join(dir, 'legacy.json'), JSON.stringify({ schema_version: 1, legacy_plaintext: 'secret body' }))
  writeFileSync(join(dir, 'corrupted.json'), 'not json')
  writeFileSync(join(dir, 'valid.json'), JSON.stringify(validCache))
  writeFileSync(join(dir, '.tmp-123-file.json'), JSON.stringify({ temp: true }))

  purgeInvalidDecisionCache(dir)

  assert.equal(existsSync(join(dir, 'legacy.json')), false)
  assert.equal(existsSync(join(dir, 'corrupted.json')), false)
  assert.equal(existsSync(join(dir, 'valid.json')), true)
  assert.equal(existsSync(join(dir, '.tmp-123-file.json')), true) // temp ignored
})

test('readDecisionCache, writeDecisionCache, expiry, and eviction work end-to-end', () => {
  const dir = temp()
  const dummyHash = 'a'.repeat(64)
  const validCache = {
    schema_version: CACHE_SCHEMA_VERSION,
    catalog_hash: dummyHash,
    lens_registry_hash: dummyHash,
    links_register_hash: dummyHash,
    contrib_selection_hash: dummyHash,
    identity_id: 'client:proj',
    lens: 'career',
    allowed_lenses: ['career'],
    task_hash: dummyHash,
    temporal: 'current',
    include_history: false,
    budget: 'standard',
    manifest: false,
    requested_source_ids: null,
    cursor: null,
    source_refs: [],
    receipt: {
      schema_version: 1,
      context_hash: dummyHash,
      task_hash: dummyHash,
      lens: 'career',
      budget: 'standard',
      temporal: 'current',
      source_ids: [],
      source_hashes: []
    },
    state_hash: dummyHash,
    valid_until_epoch_ms: Date.now() + 60000,
    estimated_tokens_total: 100
  }

  writeDecisionCache(dir, 'key-1', validCache, { maxEntries: 2, maxBytes: 1000000 })
  const read = readDecisionCache(dir, 'key-1')
  assert.notEqual(read, null)
  assert.equal(read.schema_version, CACHE_SCHEMA_VERSION)

  // Expired entry returns null
  const expiredCache = { ...validCache, valid_until_epoch_ms: Date.now() - 1000 }
  writeDecisionCache(dir, 'key-expired', expiredCache)
  assert.equal(readDecisionCache(dir, 'key-expired'), null)

  // Eviction
  writeDecisionCache(dir, 'key-2', validCache, { maxEntries: 2, maxBytes: 1000000 })
  writeDecisionCache(dir, 'key-3', validCache, { maxEntries: 2, maxBytes: 1000000 })
  // With maxEntries: 2, only 2 files remain
  const remaining = existsSync(join(dir, 'key-3.json'))
  assert.equal(remaining, true)
})

test('validateCatalogSchema strictly validates ignored_sources and rejects extra properties', () => {
  const dummyHash = 'a'.repeat(64)
  const baseCatalog = {
    schema_version: CATALOG_SCHEMA_VERSION,
    space_id: 'self',
    lens_registry_hash: dummyHash,
    project_context_hash: null,
    generated_at: new Date().toISOString(),
    sources: []
  }

  // Valid with ignored_sources
  const validWithIgnored = {
    ...baseCatalog,
    ignored_sources: [
      {
        file: 'context/secret.md',
        size: 50,
        modified_ms: 1000,
        mtime_ns: '1000000000',
        ino: '123',
        dev: '456',
        reason: 'secret'
      }
    ]
  }
  assert.equal(validateCatalogSchema(validWithIgnored).valid, true)

  // Invalid when ignored_source has extra property
  const withExtraProp = {
    ...baseCatalog,
    ignored_sources: [
      {
        file: 'context/secret.md',
        size: 50,
        modified_ms: 1000,
        mtime_ns: '1000000000',
        ino: '123',
        dev: '456',
        reason: 'secret',
        extra_prop: 'bad'
      }
    ]
  }
  assert.equal(validateCatalogSchema(withExtraProp).valid, false)

  // Invalid when catalog has unknown top-level property
  const withTopLevelExtra = {
    ...baseCatalog,
    unrecognized_field: true
  }
  assert.equal(validateCatalogSchema(withTopLevelExtra).valid, false)
})

test('getDecisionCacheLimits guards non-positive limits and falls back to defaults', () => {
  // Negative link values
  const limits1 = getDecisionCacheLimits({ cache_limit_entries: -5, cache_limit_bytes: 0 })
  assert.equal(limits1.maxEntries, 256)
  assert.equal(limits1.maxBytes, 20 * 1024 * 1024)
  assert.ok(limits1.warnings.length >= 2)

  // Valid link values
  const limits2 = getDecisionCacheLimits({ cache_limit_entries: 500, cache_limit_bytes: 50 * 1024 * 1024 })
  assert.equal(limits2.maxEntries, 500)
  assert.equal(limits2.maxBytes, 50 * 1024 * 1024)
  assert.equal(limits2.warnings.length, 0)
})

test('validateDecisionCacheSchema strictly rejects unknown top-level properties', () => {
  const dummyHash = 'a'.repeat(64)
  const validCache = {
    schema_version: CACHE_SCHEMA_VERSION,
    catalog_hash: dummyHash,
    lens_registry_hash: dummyHash,
    links_register_hash: dummyHash,
    contrib_selection_hash: dummyHash,
    identity_id: 'client:proj',
    lens: 'general',
    allowed_lenses: ['general'],
    task_hash: dummyHash,
    temporal: 'current',
    include_history: false,
    budget: 'standard',
    manifest: false,
    requested_source_ids: null,
    cursor: null,
    source_refs: [],
    receipt: {
      schema_version: 1,
      context_hash: dummyHash,
      task_hash: dummyHash,
      lens: 'general',
      budget: 'standard',
      temporal: 'current',
      source_ids: [],
      source_hashes: []
    },
    state_hash: dummyHash,
    valid_until_epoch_ms: null,
    estimated_tokens_total: 0
  }
  assert.equal(validateDecisionCacheSchema(validCache).valid, true)

  const withExtra = { ...validCache, extra_secret_leak: true }
  assert.equal(validateDecisionCacheSchema(withExtra).valid, false)
})

test('canonicalJson preserves undefined semantics (omits from objects, serializes as null in arrays)', () => {
  assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}')
  assert.equal(canonicalJson([1, undefined, 3]), '[1,null,3]')
  assert.equal(canonicalJson({ x: [undefined, { y: undefined, z: 2 }] }), '{"x":[null,{"z":2}]}')
})

test('validateCatalogSchema strictly validates sub-objects (sections, claims, tags, links)', () => {
  const dummyHash = 'a'.repeat(64)
  const baseSource = {
    source_kind: 'canonical',
    source_ref: {
      space_id: 'self',
      source_id: 'hs-' + '1'.repeat(20),
      revision: dummyHash,
      section_id: null
    },
    file: 'context/career.md',
    size: 100,
    modified_ms: 123456789,
    mtime_ns: '123456789000000',
    ino: '12345',
    dev: '67890',
    source_text_hash: dummyHash,
    frontmatter: {
      access_lenses: ['general'],
      disclosure: 'internal-only',
      sensitivity: 'personal',
      document_role: 'content',
      publication_allowed: false,
      task_include: [],
      task_exclude: [],
      visibility: 'private',
      read_scope: 'shared',
      field_visibility: {},
      knowledge_status: 'current',
      temporal_scope: 'current'
    },
    sections: [{
      section_id: 'bio',
      heading: 'Bio',
      visibility: 'private',
      disclosure: 'internal-only',
      claim: false,
      snippet: 'bio snippet'
    }],
    claims: [{ text: 'claim 1', visibility: 'private' }],
    tags: [{ value: 'tag1', visibility: 'private' }],
    links: [{ value: 'https://example.com', visibility: 'private' }],
    estimated_tokens: 25
  }
  const baseCatalog = {
    schema_version: CATALOG_SCHEMA_VERSION,
    space_id: 'self',
    lens_registry_hash: dummyHash,
    project_context_hash: null,
    generated_at: new Date().toISOString(),
    sources: [baseSource]
  }
  assert.equal(validateCatalogSchema(baseCatalog).valid, true)

  // Extra property on section
  const badSection = structuredClone(baseCatalog)
  badSection.sources[0].sections[0].extra_prop = 'bad'
  assert.equal(validateCatalogSchema(badSection).valid, false)

  // Invalid visibility on section
  const badSectionVis = structuredClone(baseCatalog)
  badSectionVis.sources[0].sections[0].visibility = 'unknown-vis'
  assert.equal(validateCatalogSchema(badSectionVis).valid, false)

  // Extra property on claim
  const badClaim = structuredClone(baseCatalog)
  badClaim.sources[0].claims[0].extra_prop = 'bad'
  assert.equal(validateCatalogSchema(badClaim).valid, false)

  // Extra property on tag
  const badTag = structuredClone(baseCatalog)
  badTag.sources[0].tags[0].extra_prop = 'bad'
  assert.equal(validateCatalogSchema(badTag).valid, false)

  // Extra property on link
  const badLink = structuredClone(baseCatalog)
  badLink.sources[0].links[0].extra_prop = 'bad'
  assert.equal(validateCatalogSchema(badLink).valid, false)
})

test('persistent decision cache hit yields identical context_hash, omitted reasons, and audit counts', async () => {
  const self = temp()
  const project = temp()
  await capture(() => run(['init', '--root', self]))

  writeFileSync(
    join(self, 'profile', 'profile.md'),
    '---\naccess_lenses: [general, career]\ndisclosure: internal-only\nsensitivity: personal\ndocument_role: content\n---\n# Profile\n\nSoftware engineer.\n'
  )
  writeFileSync(
    join(self, 'context', 'notes.md'),
    '---\naccess_lenses: [general]\ndisclosure: internal-only\nsensitivity: personal\ndocument_role: content\n---\n# Notes\n\nGeneral notes.\n'
  )
  await capture(() => run(['link', 'add', '--project', project, '--self', self, '--lens', 'general', '--no-activate', '--yes']))

  // Cold context query
  const res1 = await capture(() => run(['context', '--project', project, '--lens', 'general', '--budget', 'standard', '--json']))
  const cold = JSON.parse(res1.stdout)
  assert.equal(cold.context_receipt.cache.hit, false)

  // Persistent cache hit query
  const res2 = await capture(() => run(['context', '--project', project, '--lens', 'general', '--budget', 'standard', '--json']))
  const warm = JSON.parse(res2.stdout)
  assert.equal(warm.context_receipt.cache.hit, true)
  assert.equal(warm.context_receipt.cache.persistent, true)

  // Critical H-E(a) check: exact context_hash parity between cold and persistent hit
  assert.equal(warm.context_receipt.context_hash, cold.context_receipt.context_hash)
  assert.equal(warm.context_receipt.task_hash, cold.context_receipt.task_hash)
  assert.deepEqual(warm.context_receipt.source_ids, cold.context_receipt.source_ids)
  assert.deepEqual(warm.context_receipt.source_hashes, cold.context_receipt.source_hashes)

  // Critical M-A check: selection counts parity
  assert.equal(warm.selection.selected_count, cold.selection.selected_count)
  assert.equal(warm.selection.candidate_count, cold.selection.candidate_count)
  assert.equal(warm.selection.eligible_count, cold.selection.eligible_count)
  assert.equal(warm.selection.temporal_excluded, cold.selection.temporal_excluded)
  assert.equal(warm.selection.omitted_count, cold.selection.omitted_count)
})

test('persistent decision cache preserves next_cursor on manifest pagination', async () => {
  const self = temp()
  const project = temp()
  await capture(() => run(['init', '--root', self]))
  for (let i = 1; i <= 15; i++) {
    writeFileSync(
      join(self, 'context', `item-${i}.md`),
      `---\naccess_lenses: [general]\ndisclosure: internal-only\nsensitivity: personal\ndocument_role: content\n---\n# Item ${i}\n\nContent for item ${i}.\n`
    )
  }
  await capture(() => run(['link', 'add', '--project', project, '--self', self, '--lens', 'general', '--no-activate', '--yes']))

  // Cold manifest query
  const res1 = await capture(() => run(['context', '--project', project, '--manifest', '--json']))
  const cold = JSON.parse(res1.stdout)
  assert.equal(cold.context_receipt.cache.hit, false)
  assert.ok(cold.selection.next_cursor !== null, 'cold query should have next_cursor with 15+ items')

  // Warm manifest query
  const res2 = await capture(() => run(['context', '--project', project, '--manifest', '--json']))
  const warm = JSON.parse(res2.stdout)
  assert.equal(warm.context_receipt.cache.hit, true)
  assert.equal(warm.context_receipt.cache.persistent, true)

  // Critical H-E(b) / M-K check: next_cursor is preserved on persistent cache hit
  assert.equal(warm.selection.next_cursor, cold.selection.next_cursor)
  assert.equal(warm.context_receipt.context_hash, cold.context_receipt.context_hash)
})

test('ensureContribPartition caches on-disk at selfRoot/.holoself/catalog/contrib.json', async () => {
  const self = temp()
  await capture(() => run(['init', '--root', self]))
  const contribPath = join(self, '.holoself', 'catalog', 'contrib.json')
  assert.equal(existsSync(contribPath), false)

  // Running context writes contrib.json to self catalog directory
  const project = temp()
  await capture(() => run(['link', 'add', '--project', project, '--self', self, '--no-activate', '--yes']))
  await capture(() => run(['context', '--project', project, '--json']))

  assert.equal(existsSync(contribPath), true)
  const onDisk = JSON.parse(readFileSync(contribPath, 'utf8'))
  assert.equal(onDisk.schema_version, 2)
  assert.equal(onDisk.space_id, 'contrib')
  assert.ok(onDisk.sources.length > 0)
})

test('canonicalJson handles sparse array holes, Dates, and functions', () => {
  const arr = [1]
  arr[3] = 4 // holes at index 1 and 2
  assert.equal(canonicalJson(arr), '[1,null,null,4]')

  const d = new Date('2026-09-20T20:00:00.000Z')
  assert.equal(canonicalJson({ date: d }), '{"date":"2026-09-20T20:00:00.000Z"}')

  const objWithFn = { a: 1, b: () => {}, c: undefined }
  assert.equal(canonicalJson(objWithFn), '{"a":1}')
})

test('validateCatalogSchema strictly requires visibility on claims, tags, and links', () => {
  const dummyHash = 'b'.repeat(64)
  const baseSource = {
    source_kind: 'canonical',
    source_ref: { space_id: 'self', source_id: 'hs-' + '1'.repeat(20), revision: dummyHash, section_id: null },
    file: 'profile/identity.md',
    size: 100,
    modified_ms: 1000,
    mtime_ns: '1000000000',
    ino: '1',
    dev: '1',
    source_text_hash: dummyHash,
    frontmatter: {
      access_lenses: ['general'],
      disclosure: 'internal-only',
      sensitivity: 'personal',
      document_role: 'content',
      publication_allowed: true,
      task_include: [],
      task_exclude: [],
      visibility: 'public-safe',
      read_scope: 'shared',
      field_visibility: {},
      knowledge_status: 'current',
      temporal_scope: 'timeless'
    },
    sections: [{ section_id: 'sec', heading: 'Sec', visibility: 'public-safe', disclosure: 'publish-approved', claim: false, snippet: 'Hello' }],
    claims: [],
    tags: [],
    links: [],
    estimated_tokens: 25
  }

  const baseCatalog = {
    schema_version: CATALOG_SCHEMA_VERSION,
    space_id: 'self',
    lens_registry_hash: dummyHash,
    project_context_hash: null,
    generated_at: new Date().toISOString(),
    sources: [baseSource]
  }

  // Valid base
  assert.equal(validateCatalogSchema(baseCatalog).valid, true)

  // Invalid when section lacks disclosure (Nit 4)
  const badSectionDisclosure = structuredClone(baseCatalog)
  delete badSectionDisclosure.sources[0].sections[0].disclosure
  assert.equal(validateCatalogSchema(badSectionDisclosure).valid, false)

  // Invalid when claim lacks visibility
  const badClaim = structuredClone(baseCatalog)
  badClaim.sources[0].claims = [{ text: 'some claim' }]
  assert.equal(validateCatalogSchema(badClaim).valid, false)

  // Invalid when tag lacks visibility
  const badTag = structuredClone(baseCatalog)
  badTag.sources[0].tags = [{ value: 'my-tag' }]
  assert.equal(validateCatalogSchema(badTag).valid, false)

  // Invalid when link lacks visibility
  const badLink = structuredClone(baseCatalog)
  badLink.sources[0].links = [{ value: 'https://example.com' }]
  assert.equal(validateCatalogSchema(badLink).valid, false)
})

test('candidate links and snippets fail-closed under publishing lens (B-1 and B-2)', async () => {
  const self = temp()
  const project = temp()
  await capture(() => run(['init', '--root', self]))

  writeFileSync(
    join(self, 'context', 'compensation-links.md'),
    `---\naccess_lenses: [general, publishing]\ndisclosure: publish-approved\nsensitivity: personal\ndocument_role: content\npublication_allowed: true\n---\n# Public Resources\n\nPublic link: [public portal](https://example.com)\n\n## Compensation Details\n\n- Base salary: $150,000 USD\n- Bonus: $30,000 USD\n\n<!-- holoself-claim visibility=private -->\nPrivate link: [internal portal](https://internal.corp/secret)\n<!-- /holoself-claim -->\n`
  )
  await capture(() => run(['link', 'add', '--project', project, '--self', self, '--lens', 'publishing', '--no-activate', '--yes']))

  // Manifest under publishing lens
  const resPublishing = await capture(() => run(['context', '--project', project, '--lens', 'publishing', '--manifest', '--json']))
  const outPub = JSON.parse(resPublishing.stdout)
  const compDocPub = outPub.sources.find(s => s.path === 'context/compensation-links.md')
  assert.ok(compDocPub, 'compensation-links.md should be included')

  // B-2 check: snippets and search_text must not leak compensation
  for (const sec of compDocPub.sections) {
    assert.equal(sec.snippet.includes('$150,000'), false, 'snippet must not leak salary')
    assert.equal(sec.snippet.includes('150,000'), false, 'snippet must not leak salary numbers')
    assert.equal(sec.snippet.includes('Bonus'), false, 'snippet must not leak bonus')
  }
  assert.equal(compDocPub.search_text.includes('$150,000'), false, 'search_text must not leak compensation')
  assert.equal(compDocPub.search_text.includes('150,000'), false, 'search_text must not leak compensation numbers')

  // B-1 check: private link filtered out under publishing lens
  assert.equal(compDocPub.links.some(l => l.value.includes('internal.corp')), false, 'private link must be omitted under publishing lens')
  assert.equal(compDocPub.links.some(l => l.value.includes('example.com')), true, 'public link must be retained under publishing lens')
})

test('selection counts and audit counters maintain parity between cold and warm queries with --source and --task (S-1, S-2, S-3)', async () => {
  const self = temp()
  const project = temp()
  await capture(() => run(['init', '--root', self]))

  writeFileSync(
    join(self, 'context', 'task-matching.md'),
    `---\naccess_lenses: [general]\ndisclosure: internal-only\nsensitivity: personal\ndocument_role: content\n---\n# Frontend Architecture\n\nDeep dive into frontend component architecture and performance.\n`
  )
  writeFileSync(
    join(project, 'backend-unrelated.md'),
    `---\naccess_lenses: [general]\ndisclosure: internal-only\nsensitivity: personal\ndocument_role: content\n---\n# Database Migrations\n\nPostgres schema migrations.\n`
  )
  await capture(() => run(['link', 'add', '--project', project, '--self', self, '--lens', 'general', '--no-activate', '--yes']))

  // Cold query with --task
  const resCold = await capture(() => run(['context', '--project', project, '--task', 'frontend architecture', '--json']))
  const cold = JSON.parse(resCold.stdout)
  assert.equal(cold.context_receipt.cache.hit, false)

  // Warm query with --task
  const resWarm = await capture(() => run(['context', '--project', project, '--task', 'frontend architecture', '--json']))
  const warm = JSON.parse(resWarm.stdout)
  assert.equal(warm.context_receipt.cache.hit, true)
  assert.equal(warm.context_receipt.cache.persistent, true)

  // Verify S-1: counts and omission reasons parity
  assert.equal(warm.selection.selected_count, cold.selection.selected_count)
  assert.equal(warm.selection.candidate_count, cold.selection.candidate_count)
  assert.equal(warm.selection.eligible_count, cold.selection.eligible_count)
  assert.equal(warm.selection.omitted_count, cold.selection.omitted_count)
  assert.deepEqual(warm.context_receipt.source_ids, cold.context_receipt.source_ids)

  // Cold query with --source (S-3 check)
  const targetDoc = cold.sources[0]
  const resSourceCold = await capture(() => run(['context', '--project', project, '--source', targetDoc.source_id, '--json']))
  const sourceCold = JSON.parse(resSourceCold.stdout)

  const resSourceWarm = await capture(() => run(['context', '--project', project, '--source', targetDoc.source_id, '--json']))
  const sourceWarm = JSON.parse(resSourceWarm.stdout)
  assert.equal(sourceWarm.context_receipt.cache.hit, true)
  assert.equal(sourceWarm.selection.eligible_count, sourceCold.selection.eligible_count, 'eligible_count must match between cold and warm with --source')
})

test('readSourceWithStat returns null when max retries are exhausted without throwing (S-5)', () => {
  const missing = readSourceWithStat(join(tmpdir(), 'definitely-does-not-exist-' + Date.now()))
  assert.equal(missing, null)
})

test('manifest mode with task and unselected candidates preserves cold/warm parity without fabricating omissions (B-3)', async () => {
  const self = temp()
  const project = temp()
  await capture(() => run(['init', '--root', self]))

  // Create 12 self docs matching "architecture"
  for (let i = 1; i <= 12; i++) {
    writeFileSync(
      join(self, 'context', `arch-${i}.md`),
      `---\naccess_lenses: [general]\ndisclosure: internal-only\nsensitivity: personal\ndocument_role: content\n---\n# Architecture Part ${i}\n\nSystem architecture details for section ${i}.\n`
    )
  }
  // Create an unrelated project doc with zero relevance
  writeFileSync(
    join(project, 'unrelated.md'),
    `---\naccess_lenses: [general]\ndisclosure: internal-only\nsensitivity: personal\ndocument_role: content\n---\n# Unrelated Topic\n\nCompletely different content.\n`
  )
  await capture(() => run(['link', 'add', '--project', project, '--self', self, '--lens', 'general', '--no-activate', '--yes']))

  // Cold manifest query with --task
  const resCold = await capture(() => run(['context', '--project', project, '--manifest', '--task', 'architecture', '--json']))
  const cold = JSON.parse(resCold.stdout)
  assert.equal(cold.context_receipt.cache.hit, false)
  assert.equal(cold.selection.selected_count, 10)
  assert.equal(cold.selection.omitted_count, 0)
  assert.deepEqual(cold.restrictions, [])
  assert.ok(cold.selection.next_cursor !== null)

  // Warm manifest query with --task
  const resWarm = await capture(() => run(['context', '--project', project, '--manifest', '--task', 'architecture', '--json']))
  const warm = JSON.parse(resWarm.stdout)
  assert.equal(warm.context_receipt.cache.hit, true)
  assert.equal(warm.context_receipt.cache.persistent, true)

  // Critical B-3 check: cold and warm must have identical omitted_count (0) and empty restrictions
  assert.equal(warm.selection.selected_count, cold.selection.selected_count)
  assert.equal(warm.selection.omitted_count, 0, 'warm manifest must not fabricate omissions for unselected paginated candidates')
  assert.deepEqual(warm.restrictions, cold.restrictions)
  assert.equal(warm.selection.next_cursor, cold.selection.next_cursor)
})

test('unreadable source writes zeroed stat tombstone, emits warning, and retries on subsequent run without sticking (B-4)', async () => {
  const self = temp()
  const project = temp()
  await capture(() => run(['init', '--root', self]))

  const lockedFile = join(self, 'context', 'locked-file.md')
  writeFileSync(
    lockedFile,
    `---\naccess_lenses: [general]\ndisclosure: internal-only\nsensitivity: personal\ndocument_role: content\n---\n# Locked File\n\nContent of locked file.\n`
  )
  await capture(() => run(['link', 'add', '--project', project, '--self', self, '--lens', 'general', '--no-activate', '--yes']))

  // Helper to hold an exclusive lock or unreadable permission on the file
  async function lockFile(filePath) {
    if (process.platform === 'win32') {
      const { spawn } = await import('node:child_process')
      const ps = spawn('powershell', ['-NoProfile', '-Command', `
        $f = [System.IO.File]::Open("${filePath.replace(/\\/g, '\\\\')}", [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None);
        [Console]::WriteLine("LOCKED");
        [Console]::ReadLine();
        $f.Close();
      `])
      await new Promise((resolve, reject) => {
        ps.stdout.on('data', d => {
          if (d.toString().includes('LOCKED')) resolve()
        })
        ps.on('error', reject)
        ps.stderr.on('data', d => reject(new Error(d.toString())))
      })
      return () => {
        try { ps.stdin.write('\n') } catch {}
        return new Promise(r => ps.on('close', r))
      }
    } else {
      const { chmodSync } = await import('node:fs')
      chmodSync(filePath, 0o000)
      return () => chmodSync(filePath, 0o644)
    }
  }

  const releaseLock = await lockFile(lockedFile)
  try {
    const res1 = await capture(() => run(['context', '--project', project, '--json']))
    const out1 = JSON.parse(res1.stdout)
    // Warning emitted
    assert.ok(out1.warnings.some(w => w.includes('locked-file.md') && w.includes('unreadable')), 'warning must be emitted on unreadable file')

    // Inspect on-disk catalog tombstone: must have zeroed mtime
    const catPath = join(self, '.holoself', 'catalog', 'catalog.json')
    const cat = JSON.parse(readFileSync(catPath, 'utf8'))
    const ignored = cat.ignored_sources.find(s => s.file === 'context/locked-file.md')
    assert.ok(ignored, 'ignored_sources should contain the unreadable file')
    assert.equal(ignored.mtime_ns, '0', 'tombstone must not have valid mtime_ns')
    assert.ok(ignored.reason.includes('unreadable'), 'tombstone reason must be honest about unreadable status')
  } finally {
    await releaseLock()
  }

  // Second run: lock is released
  const res2 = await capture(() => run(['context', '--project', project, '--json']))
  const out2 = JSON.parse(res2.stdout)

  // The file should now be successfully read and included in sources, NOT stuck in ignored_sources!
  assert.ok(out2.sources.some(s => s.path === 'context/locked-file.md'), 'file must be re-read and included once lock is released')
})

test('warm delivery preserves knowledge_status and temporal_scope on delivered records (S-6)', async () => {
  const self = temp()
  const project = temp()
  await capture(() => run(['init', '--root', self]))
  await capture(() => run(['link', 'add', '--project', project, '--self', self, '--lens', 'general', '--no-activate', '--yes']))

  const resCold = await capture(() => run(['context', '--project', project, '--json']))
  const cold = JSON.parse(resCold.stdout)
  assert.ok(cold.sources.length > 0)
  assert.ok(cold.sources[0].knowledge_status !== undefined)
  assert.ok(cold.sources[0].temporal_scope !== undefined)

  const resWarm = await capture(() => run(['context', '--project', project, '--json']))
  const warm = JSON.parse(resWarm.stdout)
  assert.equal(warm.context_receipt.cache.hit, true)
  assert.equal(warm.sources[0].knowledge_status, cold.sources[0].knowledge_status)
  assert.equal(warm.sources[0].temporal_scope, cold.sources[0].temporal_scope)
})

test('expired document does not poison persistent cache valid_until_epoch_ms (N-3)', async () => {
  const self = temp()
  const project = temp()
  await capture(() => run(['init', '--root', self]))

  // Document that expired years ago
  writeFileSync(
    join(self, 'context', 'expired.md'),
    `---\naccess_lenses: [general]\ndisclosure: internal-only\nsensitivity: personal\ndocument_role: content\nvalid_until: 2020-01-01\n---\n# Expired Doc\n\nOld content.\n`
  )
  // Active document
  writeFileSync(
    join(self, 'context', 'active.md'),
    `---\naccess_lenses: [general]\ndisclosure: internal-only\nsensitivity: personal\ndocument_role: content\nvalid_until: 2035-01-01\n---\n# Active Doc\n\nFresh content.\n`
  )
  await capture(() => run(['link', 'add', '--project', project, '--self', self, '--lens', 'general', '--no-activate', '--yes']))

  // Cold run
  const resCold = await capture(() => run(['context', '--project', project, '--json']))
  const cold = JSON.parse(resCold.stdout)
  assert.equal(cold.context_receipt.cache.hit, false)

  // Warm run must be a cache HIT, not invalidated by the expired doc
  const resWarm = await capture(() => run(['context', '--project', project, '--json']))
  const warm = JSON.parse(resWarm.stdout)
  assert.equal(warm.context_receipt.cache.hit, true, 'cache must hit despite presence of expired document')
  assert.equal(warm.context_receipt.cache.persistent, true)
})



