// Issue #69: optional SQLite FTS5 (BM25) retrieval index. Feature detection and JSON fallback, the derived
// cache (freshness, delete/corrupt/symlink safety, 0600), privacy (hidden documents are never returned or
// scored and do not change visible scores), claim/field/lifecycle filters, determinism and path handling.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from '../src/cli.mjs'
import { contextData } from '../src/ecosystem.mjs'
import { ensureCatalog } from '../src/catalog/partitions.mjs'
import { ENGINE_FTS5, FTS_FILE, STALE_TMP_MS, ftsIndexPath, ftsSupport, indexEngine, lexicalBonuses, lexicalScores, normalizeText, openFtsIndex, removeStaleTempFiles, requestedEngine } from '../src/catalog/fts.mjs'
import { loadLensRegistry } from '../src/lenses.mjs'
import { buildIndex, searchIndex } from '../src/catalog/index.mjs'
import { rankCandidates } from '../src/context-selection.mjs'

const BIN = fileURLToPath(new URL('../bin/holoself.mjs', import.meta.url))
const skip = ftsSupport() ? false : 'node:sqlite with FTS5 is unavailable on this Node build'
const meta = (lenses, extra = '') => `---\naccess_lenses: [${lenses.join(', ')}]\ndisclosure: internal-only\nsensitivity: personal\ndocument_role: content\n${extra}---\n`

const DOCS = {
  'context/orchard.md': meta(['general', 'professional']) + '# Orchard ledger\n\nThe orchard ledger tracks orchestration guarantees for apple harvests.\n',
  'context/storage.md': meta(['general']) + '# Storage notes\n\nFsync durability guarantees protect the orchard archive. Compensação anual revisada.\n',
  'context/plain.md': meta(['general']) + '# Plain notes\n\nNothing about fruit here, only weekly planning.\n',
  // Hidden from linked general callers: private lens only.
  'context/hidden.md': meta(['private']) + '# Hidden orchard\n\nzebraquartz orchard orchard orchard ledger ledger guarantees.\n',
  // Visible document with a private claim and a private field line.
  'context/claims.md':
    meta(['general'], 'field_visibility:\n  Salary: private\n') +
    '# Claims doc\n\nPublic orchard remark.\n\n<!-- holoself-claim visibility=private -->\nclaimsecret orchard private claim text.\n<!-- /holoself-claim -->\n\n## Lines\n\n- Salary: fieldsecret orchard\n- Team: visible orchard team\n',
  // Superseded knowledge is excluded by the default temporal selector.
  'context/old.md': meta(['general'], 'knowledge_status: superseded\nsuperseded_by: context/orchard.md\n') + '# Old orchard\n\nsupersededterm orchard history.\n'
}

async function quiet(fn) {
  const old = console.log
  const lines = []
  console.log = value => lines.push(String(value))
  try {
    await fn()
  } finally {
    console.log = old
  }
  return lines.join('\n')
}
async function fixture(name = 'holoself-fts-', docs = DOCS) {
  const base = await mkdtemp(join(tmpdir(), name))
  const root = join(base, 'self root ç'),
    project = join(base, 'project')
  await mkdir(project)
  await quiet(() => run(['init', '--root', root]))
  await quiet(() => run(['link', 'add', '--self', root, '--project', project, '--lens', 'general', '--secondary-lenses', 'professional', '--yes', '--no-activate']))
  for (const [path, text] of Object.entries(docs)) await writeFile(join(root, path), text)
  return { base, root, project }
}
async function withEngine(value, fn) {
  const previous = process.env.HOLOSELF_INDEX_ENGINE
  if (value === undefined) delete process.env.HOLOSELF_INDEX_ENGINE
  else process.env.HOLOSELF_INDEX_ENGINE = value
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env.HOLOSELF_INDEX_ENGINE
    else process.env.HOLOSELF_INDEX_ENGINE = previous
  }
}
const search = async (fx, query, extra = []) => JSON.parse(await quiet(() => run(['search', query, '--project', fx.project, ...extra])))
const context = (fx, task) => contextData({ project: fx.project, lens: 'general', task, budget: 'standard', json: true })
const selfPartition = root => ensureCatalog(root, null, null, loadLensRegistry(root)).self

test('engine selection: env override, feature detection and the test-only sqlite kill switch', () => {
  assert.equal(requestedEngine({ HOLOSELF_INDEX_ENGINE: 'json' }), 'json')
  assert.equal(requestedEngine({ HOLOSELF_INDEX_ENGINE: 'deterministic-json' }), 'json')
  assert.equal(requestedEngine({ HOLOSELF_INDEX_ENGINE: 'FTS5' }), 'fts5')
  assert.equal(requestedEngine({}), 'auto')
  assert.equal(indexEngine({ HOLOSELF_INDEX_ENGINE: 'json' }), 'deterministic-json')
  const [major, minor] = process.versions.node.split('.').map(Number)
  // node:sqlite loads without --experimental-sqlite from Node 22.13.0; FTS5 ships in Node's bundled SQLite.
  if (major > 22 || (major === 22 && minor >= 13)) assert.ok(ftsSupport(), 'node:sqlite with FTS5 expected on Node >= 22.13')
  assert.equal(indexEngine({}), ftsSupport() ? ENGINE_FTS5 : 'deterministic-json')
  process.env.HOLOSELF_TEST_DISABLE_SQLITE = '1'
  try {
    assert.equal(ftsSupport(), null)
    assert.equal(indexEngine({}), 'deterministic-json')
    assert.equal(lexicalScores([{ id: 'a', sections: [] }], 'orchard'), null)
  } finally {
    delete process.env.HOLOSELF_TEST_DISABLE_SQLITE
  }
  assert.equal(normalizeText('Compensação ＡＢＣ ﬁle'), 'compensacao abc file')
})

test('JSON fallback when node:sqlite is unavailable: same search output as the JSON engine and no FTS file', async () => {
  const fx = await fixture('holoself-fts-fallback-')
  try {
    process.env.HOLOSELF_TEST_DISABLE_SQLITE = '1'
    let fallback, packet
    try {
      fallback = await search(fx, 'orchard ledger')
      packet = context(fx, 'orchard ledger')
    } finally {
      delete process.env.HOLOSELF_TEST_DISABLE_SQLITE
    }
    const json = await withEngine('json', () => search(fx, 'orchard ledger'))
    assert.equal(fallback.engine, 'deterministic-json')
    assert.deepEqual(fallback, json)
    assert.ok(fallback.results.length > 0)
    assert.ok(fallback.results.every(r => !('bm25' in r)))
    assert.equal(packet.context_receipt.engine, undefined, 'JSON-engine receipts keep their previous shape')
    assert.equal(existsSync(ftsIndexPath(fx.root)), false)
  } finally {
    rmSync(fx.base, { recursive: true, force: true })
  }
})

test('CLI context under FTS5 reports the engine, keeps stderr free of the SQLite ExperimentalWarning, and writes a 0600 cache', { skip }, async () => {
  const fx = await fixture('holoself-fts-cli-')
  try {
    const env = { ...process.env }
    delete env.HOLOSELF_INDEX_ENGINE
    const res = spawnSync(process.execPath, [BIN, 'context', '--project', fx.project, '--task', 'orchard guarantees', '--json'], { cwd: fx.project, env, encoding: 'utf8', windowsHide: true })
    assert.equal(res.status, 0, res.stderr)
    assert.doesNotMatch(res.stderr, /ExperimentalWarning|SQLite is an experimental/)
    assert.equal(JSON.parse(res.stdout).context_receipt.engine, 'fts5')
    const path = ftsIndexPath(fx.root)
    assert.equal(path, join(fx.root, '.holoself', 'catalog', FTS_FILE), 'native separators below the self root, including spaces and non-ASCII')
    assert.ok(lstatSync(path).isFile())
    if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600)
    assert.match(readFileSync(join(fx.root, '.holoself', '.gitignore'), 'utf8'), /^catalog\/$/m)
    const rebuild = spawnSync(process.execPath, [BIN, 'index', 'rebuild', '--project', fx.project], { cwd: fx.project, env, encoding: 'utf8', windowsHide: true })
    assert.equal(rebuild.status, 0, rebuild.stderr)
    assert.equal(JSON.parse(rebuild.stdout).engine, 'fts5')
    assert.doesNotMatch(rebuild.stderr, /ExperimentalWarning/)
  } finally {
    rmSync(fx.base, { recursive: true, force: true })
  }
})

test('FTS5 search: stemming, diacritic folding and prefix expansion, ranked by BM25', { skip }, async () => {
  const fx = await fixture('holoself-fts-search-')
  try {
    await withEngine(undefined, async () => {
      const stemmed = await search(fx, 'guaranteeing')
      assert.equal(stemmed.engine, 'fts5')
      assert.deepEqual([...new Set(stemmed.results.map(r => r.source_file))].sort(), ['context/orchard.md', 'context/storage.md'])
      const folded = await search(fx, 'compensacao')
      assert.deepEqual(folded.results.map(r => r.source_file), ['context/storage.md'])
      // Prefix expansion on the stemmed term: 'durab' matches 'durability' (stemmed 'durabl').
      const prefix = await search(fx, 'durab')
      assert.deepEqual(prefix.results.map(r => r.source_file), ['context/storage.md'])
      const ranked = await search(fx, 'orchard ledger')
      assert.ok(ranked.results.every(r => typeof r.bm25 === 'number' && r.score === 2))
      assert.deepEqual(
        ranked.results.map(r => r.bm25),
        [...ranked.results.map(r => r.bm25)].sort((a, b) => b - a)
      )
      assert.equal(ranked.results[0].source_file, 'context/orchard.md')
    })
  } finally {
    rmSync(fx.base, { recursive: true, force: true })
  }
})

test('FTS5 privacy: hidden, claim-, field- and lifecycle-filtered text is never returned or scored', { skip }, async () => {
  const fx = await fixture('holoself-fts-privacy-')
  try {
    await withEngine(undefined, async () => {
      for (const secret of ['zebraquartz', 'claimsecret', 'fieldsecret', 'supersededterm']) {
        const found = await search(fx, secret)
        assert.equal(found.engine, 'fts5')
        assert.deepEqual(found.results, [], `${secret} must not be searchable by a linked general caller`)
        const packet = context(fx, secret)
        assert.doesNotMatch(JSON.stringify(packet.self.documents), new RegExp(secret))
      }
      // Hidden documents do not change visible scores or counts: identical output with and without them.
      const withHidden = await search(fx, 'orchard guarantees')
      const packetWith = context(fx, 'orchard guarantees ledger')
      assert.ok(withHidden.results.length > 0)
      assert.ok(withHidden.results.every(r => r.source_file !== 'context/hidden.md'))
      rmSync(join(fx.root, 'context', 'hidden.md'))
      const withoutHidden = await search(fx, 'orchard guarantees')
      const packetWithout = context(fx, 'orchard guarantees ledger')
      assert.deepEqual(withoutHidden, withHidden)
      assert.deepEqual(packetWithout.selection.selected_sources, packetWith.selection.selected_sources)
      assert.equal(packetWithout.selection.eligible_count, packetWith.selection.eligible_count)
      assert.equal(packetWithout.context_receipt.context_hash, packetWith.context_receipt.context_hash)
      // A filtered field line does not contribute: the claims document scores as if the line were absent.
      const claims = await search(fx, 'orchard')
      const claimsScore = claims.results.find(r => r.source_file === 'context/claims.md' && r.section === 'Lines')
      assert.ok(claimsScore, 'visible part of the claims document is still searchable')
      assert.doesNotMatch(claimsScore.matching_passage, /fieldsecret/)
    })
  } finally {
    rmSync(fx.base, { recursive: true, force: true })
  }
})

test('FTS5 scores are computed only over the documents passed in and do not depend on their order', { skip }, () => {
  const docs = [
    { id: 'a', sections: [{ source_id: 'hs-a', section_id: 'x', heading: 'Orchard', text: 'orchard ledger guarantees' }] },
    { id: 'b', sections: [{ source_id: 'hs-b', section_id: 'x', heading: 'Plain', text: 'weekly planning only' }] },
    { id: 'c', sections: [{ source_id: 'hs-c', section_id: 'x', heading: 'Ledger', text: 'ledger ledger orchestration' }] }
  ]
  const first = lexicalScores(docs, 'orchard ledger')
  const reversed = lexicalScores([...docs].reverse(), 'orchard ledger')
  assert.deepEqual([...first.keys()].sort(), ['a', 'b', 'c'])
  for (const id of ['a', 'b', 'c']) assert.deepEqual(reversed.get(id), first.get(id))
  assert.equal(first.get('b').bm25, 0)
  assert.ok(first.get('a').bm25 > 0 && first.get('c').bm25 > 0)
  // Adding a document changes statistics only for the call that includes it.
  const subset = lexicalScores(docs.slice(0, 2), 'orchard ledger')
  assert.deepEqual([...subset.keys()].sort(), ['a', 'b'])
})

test('FTS5 context ranking is deterministic and adds BM25 to token overlap', { skip }, async () => {
  const fx = await fixture('holoself-fts-determinism-')
  try {
    await withEngine(undefined, async () => {
      const a = context(fx, 'orchard guarantees')
      const b = context(fx, 'orchard guarantees')
      assert.equal(a.context_receipt.engine, 'fts5')
      assert.deepEqual(a.selection.selected_sources, b.selection.selected_sources)
      assert.equal(a.context_receipt.context_hash, b.context_receipt.context_hash)
      const first = await search(fx, 'orchard')
      const second = await search(fx, 'orchard')
      assert.deepEqual(first, second)
    })
  } finally {
    rmSync(fx.base, { recursive: true, force: true })
  }
})

test('FTS5 cache: rebuilt on freshness change, after deletion or corruption, and refused through a symlink', { skip }, async () => {
  const fx = await fixture('holoself-fts-cache-')
  try {
    await withEngine(undefined, async () => {
      const path = ftsIndexPath(fx.root)
      await search(fx, 'orchard')
      assert.ok(existsSync(path))
      const fresh = openFtsIndex(fx.root, selfPartition(fx.root))
      assert.equal(fresh.status, 'fresh')
      fresh.db.close()
      // Freshness: an edited source invalidates the cache and the new text is searchable.
      await writeFile(join(fx.root, 'context', 'plain.md'), meta(['general']) + '# Plain notes\n\nNow mentions nectarinewidget planning.\n')
      assert.equal((await search(fx, 'nectarinewidget')).results.length, 1)
      const after = openFtsIndex(fx.root, selfPartition(fx.root))
      assert.equal(after.status, 'fresh', 'the search above already rebuilt the cache')
      after.db.close()
      const baseline = await search(fx, 'orchard guarantees')
      // Delete-and-rebuild safe.
      rmSync(path)
      assert.deepEqual(await search(fx, 'orchard guarantees'), baseline)
      assert.ok(existsSync(path))
      // Corrupt file: rebuilt, never trusted.
      writeFileSync(path, 'not a sqlite database')
      assert.deepEqual(await search(fx, 'orchard guarantees'), baseline)
      const repaired = openFtsIndex(fx.root, selfPartition(fx.root))
      assert.equal(repaired.status, 'fresh')
      repaired.db.close()
      // Symlink: refused, the target is untouched, and scores are identical (in-memory tokenization).
      const outside = join(fx.base, 'outside.sqlite')
      writeFileSync(outside, 'OUTSIDE_SENTINEL')
      rmSync(path)
      try {
        symlinkSync(outside, path)
      } catch {
        return // symlinks need privileges on some Windows hosts
      }
      assert.equal(openFtsIndex(fx.root, selfPartition(fx.root)).status, 'refused-symlink')
      assert.deepEqual(await search(fx, 'orchard guarantees'), baseline)
      assert.ok(lstatSync(path).isSymbolicLink())
      assert.equal(readFileSync(outside, 'utf8'), 'OUTSIDE_SENTINEL')
    })
  } finally {
    rmSync(fx.base, { recursive: true, force: true })
  }
})

test('HOLOSELF_INDEX_ENGINE=json forces the JSON engine even when FTS5 is available', async () => {
  const fx = await fixture('holoself-fts-forced-json-')
  try {
    await withEngine('json', async () => {
      const found = await search(fx, 'orchard ledger')
      assert.equal(found.engine, 'deterministic-json')
      assert.ok(found.results.every(r => !('bm25' in r)))
      const packet = context(fx, 'orchard ledger')
      assert.equal(packet.context_receipt.engine, undefined)
      const index = JSON.parse(await quiet(() => run(['index', 'rebuild', '--project', fx.project])))
      assert.equal(index.engine, 'deterministic-json')
      assert.equal(existsSync(ftsIndexPath(fx.root)), false, 'no FTS file is written under the JSON engine')
    })
  } finally {
    rmSync(fx.base, { recursive: true, force: true })
  }
})

test('FTS5 rebuild removes stale temporary build files only: old regular files, never young files or symlinks', { skip }, async () => {
  const fx = await fixture('holoself-fts-tmp-')
  try {
    await withEngine(undefined, async () => {
      await search(fx, 'orchard')
      const dir = join(fx.root, '.holoself', 'catalog')
      const old = join(dir, `${FTS_FILE}.tmp-1-1-stale`),
        young = join(dir, `${FTS_FILE}.tmp-2-2-young`),
        unrelated = join(dir, 'notes.tmp-old')
      for (const path of [old, young, unrelated]) writeFileSync(path, 'x')
      const past = new Date(Date.now() - STALE_TMP_MS - 60_000)
      utimesSync(old, past, past)
      utimesSync(unrelated, past, past)
      const outside = join(fx.base, 'outside-target')
      writeFileSync(outside, 'OUTSIDE_SENTINEL')
      utimesSync(outside, past, past)
      const link = join(dir, `${FTS_FILE}.tmp-3-3-link`)
      let linked = true
      try {
        symlinkSync(outside, link)
      } catch {
        linked = false // symlinks need privileges on some Windows hosts
      }
      // A freshness change triggers a rebuild, which sweeps stale temporaries first.
      await writeFile(join(fx.root, 'context', 'plain.md'), meta(['general']) + '# Plain notes\n\nRebuild trigger.\n')
      await search(fx, 'orchard')
      assert.equal(existsSync(old), false, 'stale temporary file removed')
      assert.ok(existsSync(young), 'a young temporary file may be a concurrent build')
      assert.ok(existsSync(unrelated), 'only fts5.sqlite.tmp-* names are touched')
      if (linked) {
        assert.ok(lstatSync(link).isSymbolicLink(), 'symlinked temporary entries are left alone')
        assert.equal(readFileSync(outside, 'utf8'), 'OUTSIDE_SENTINEL')
      }
      assert.deepEqual(removeStaleTempFiles(fx.root), [])
      assert.deepEqual(removeStaleTempFiles(fx.root, Date.now() + STALE_TMP_MS + 60_000), [`${FTS_FILE}.tmp-2-2-young`])
    })
  } finally {
    rmSync(fx.base, { recursive: true, force: true })
  }
})

test('capabilities --json reports the available and selected index engines', async () => {
  const caps = JSON.parse(await quiet(() => run(['capabilities', '--json'])))
  assert.deepEqual(caps.index.engine.available, ftsSupport() ? ['fts5', 'deterministic-json'] : ['deterministic-json'])
  assert.equal(caps.index.engine.selected, indexEngine())
  const forced = await withEngine('json', async () => JSON.parse(await quiet(() => run(['capabilities', '--json']))))
  assert.equal(forced.index.engine.selected, 'deterministic-json')
})

test('FTS5 on publication adapters scores only adapter-filtered claim and field text (#110)', { skip }, async () => {
  const doc = hobby =>
    meta(['general', 'public-voice'], 'field_visibility:\n  Motto: public-safe\n  Hobby: private\n').replace('disclosure: internal-only', 'disclosure: publish-approved') +
    '# Published doc\n\n## Motto\n\npublicorchard motto line.\n' +
    (hobby ? '- Hobby: privatepear orchard motto\n\n<!-- holoself-claim visibility=private -->\nclaimpear orchard motto.\n<!-- /holoself-claim -->\n' : '')
  const withHidden = await fixture('holoself-fts-adapter-a-', { 'context/published.md': doc(true) })
  const without = await fixture('holoself-fts-adapter-b-', { 'context/published.md': doc(false) })
  try {
    await withEngine(undefined, async () => {
      const searchWith = query => searchIndex(buildIndex(withHidden.project), query, 'general', null, null, 'current', { adapter: 'public' })
      const searchWithout = query => searchIndex(buildIndex(without.project), query, 'general', null, null, 'current', { adapter: 'public' })
      for (const secret of ['privatepear', 'claimpear']) assert.deepEqual(searchWith(secret), [], `${secret} hidden on the public adapter`)
      const a = searchWith('publicorchard motto'),
        b = searchWithout('publicorchard motto')
      assert.equal(a.engine, 'fts5')
      assert.ok(a.length > 0)
      const shape = rows => rows.map(r => [r.source_file, r.section, r.matching_passage, r.bm25])
      assert.deepEqual(shape(a), shape(b), 'hidden field lines and claims do not change passages or BM25')
      assert.doesNotMatch(JSON.stringify(a), /privatepear|claimpear/)
      // The standard adapter on the same document sees no private text either under the general lens.
      assert.deepEqual(searchIndex(buildIndex(withHidden.project), 'privatepear', 'general'), [])
    })
  } finally {
    rmSync(withHidden.base, { recursive: true, force: true })
    rmSync(without.base, { recursive: true, force: true })
  }
})

test('FTS5 context bonus is computed only over temporally included candidates: superseded documents do not shift scores', { skip }, () => {
  const record = (path, heading, text, metadata = {}) => ({
    kind: 'self',
    path,
    source_id: `hs-${path.replace(/\W/g, '')}`,
    metadata,
    search_text: `${path} ${heading} ${text}`,
    sections: [{ section_id: 'a', heading, snippet: text }]
  })
  const x = record('context/x.md', 'Orchard', 'orchard ledger notes for the harvest')
  const y = record('context/y.md', 'Ledger', 'ledger ledger guarantees and orchard planning')
  const old = record('context/old.md', 'Old orchard', 'orchard orchard orchard ledger ledger ledger history', { knowledge_status: 'superseded' })
  const seen = []
  const scorer = eligible => {
    seen.push(eligible.map(r => r.path))
    const docs = eligible.map(r => ({ id: r.source_id, sections: r.sections.map(s => ({ source_id: r.source_id, section_id: s.section_id, heading: s.heading, text: s.snippet })) }))
    return lexicalBonuses(lexicalScores(docs, 'orchard ledger'))
  }
  const rank = records => rankCandidates(records, { task: 'orchard ledger', lexicalScorer: scorer }).candidates.map(c => [c.path, c.task_relevance])
  const without = rank([x, y])
  const withOld = rank([x, y, old])
  assert.deepEqual(withOld, without)
  assert.ok(seen.every(paths => !paths.includes('context/old.md')), 'the superseded document never reaches the scorer')
  // Under an explicit history request it is a candidate and is scored with the others.
  const history = rankCandidates([x, y, old], { task: 'orchard ledger', temporal: 'all', includeHistory: true, lexicalScorer: scorer }).candidates
  assert.ok(history.some(c => c.path === 'context/old.md'))
  assert.ok(seen.at(-1).includes('context/old.md'))
})

test('FTS5 context packets are identical with and without a superseded document under the default temporal selector', { skip }, async () => {
  const fx = await fixture('holoself-fts-superseded-')
  try {
    await withEngine(undefined, async () => {
      const task = 'orchard ledger guarantees'
      const withOld = context(fx, task)
      rmSync(join(fx.root, 'context', 'old.md'))
      const withoutOld = context(fx, task)
      assert.equal(withOld.context_receipt.engine, 'fts5')
      assert.deepEqual(withoutOld.selection.selected_sources, withOld.selection.selected_sources)
      assert.equal(withoutOld.context_receipt.context_hash, withOld.context_receipt.context_hash)
    })
  } finally {
    rmSync(fx.base, { recursive: true, force: true })
  }
})
