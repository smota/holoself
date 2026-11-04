import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_BASELINE_PATH,
  DEFAULT_CASES_PATH,
  DEFAULT_FTS5_BASELINE_PATH,
  isKnownGap,
  compareWithBaseline,
  formatEvalTable,
  parseEvalOptions,
  runRetrievalEval,
  scoreCaseResult
} from '../scripts/eval-retrieval.mjs'
import { HOLOSELF_BIN, SYNTHETIC_DOCUMENTS, createRetrievalEvalFixture } from './fixtures/retrieval-eval/corpus.mjs'
import { ftsSupport } from '../src/catalog/fts.mjs'

const EVAL_SCRIPT = fileURLToPath(new URL('../scripts/eval-retrieval.mjs', import.meta.url))

test('synthetic retrieval-eval corpus has 40–60 valid documents across profile/, context/, and history/', async () => {
  assert.ok(
    SYNTHETIC_DOCUMENTS.length >= 40 && SYNTHETIC_DOCUMENTS.length <= 60,
    `expected 40..60 synthetic documents, got ${SYNTHETIC_DOCUMENTS.length}`
  )
  const prefixes = new Set(SYNTHETIC_DOCUMENTS.map(doc => doc.path.split('/')[0]))
  assert.deepEqual([...prefixes].sort(), ['context', 'history', 'profile'])

  const sensitivities = new Set(SYNTHETIC_DOCUMENTS.map(doc => doc.frontmatter.sensitivity))
  for (const required of [
    'personal',
    'compensation-confidential',
    'third-party-personal',
    'recruiter-confidential',
    'employer-confidential',
    'application-private',
    'restricted'
  ]) {
    assert.ok(sensitivities.has(required), `missing sensitivity category: ${required}`)
  }

  const statuses = new Set(SYNTHETIC_DOCUMENTS.map(doc => doc.frontmatter.knowledge_status || 'current'))
  assert.deepEqual([...statuses].sort(), ['current', 'historical', 'superseded'])
  assert.ok(
    SYNTHETIC_DOCUMENTS.some(doc => (doc.frontmatter.knowledge_status || 'current') === 'current' && doc.frontmatter.valid_until === '2024-06-30'),
    'expected at least one expired valid_until document'
  )

  const fixture = await createRetrievalEvalFixture()
  try {
    const validate = spawnSync(process.execPath, [HOLOSELF_BIN, 'validate', '--root', fixture.self], {
      cwd: fixture.project,
      env: fixture.env,
      encoding: 'utf8',
      windowsHide: true
    })
    assert.equal(validate.status, 0, `validate failed: ${validate.stderr || validate.stdout}`)
    assert.doesNotMatch(validate.stdout, /\[warn\]/i)
  } finally {
    await fixture.cleanup()
  }
})

test('retrieval-eval golden set runs against CLI under the JSON engine, matches baseline without regression, and has zero leaks', async () => {
  const [rawCases, baseline] = await Promise.all([
    readFile(DEFAULT_CASES_PATH, 'utf8').then(JSON.parse),
    readFile(DEFAULT_BASELINE_PATH, 'utf8').then(JSON.parse)
  ])

  assert.ok(rawCases.cases.length >= 40, `expected >= 40 golden cases, found ${rawCases.cases.length}`)
  const categories = new Set(rawCases.cases.map(item => item.category))
  for (const requiredCategory of ['personal', 'mechanical', 'synonyms', 'lifecycle', 'privacy', 'budget', 'session-start']) {
    assert.ok(categories.has(requiredCategory), `missing category: ${requiredCategory}`)
  }
  const languages = new Set(rawCases.cases.map(item => item.language))
  assert.deepEqual([...languages].sort(), ['en', 'pt'])

  const report = await runRetrievalEval({ engine: 'json' })
  assert.equal(report.engine, 'deterministic-json')
  assert.equal(baseline.engine, 'deterministic-json')

  // (a) Zero forbidden leaks across all cases.
  assert.equal(report.summary.total_forbidden_leaks, 0, 'forbidden leaks must be 0')
  for (const item of report.cases) {
    assert.equal(item.forbidden_leaks, 0, `case ${item.id} leaked forbidden sources: ${item.leaked_paths.join(', ')}`)
  }

  // (b) Gate comparison against recorded baseline.
  const comparison = compareWithBaseline(report, baseline)
  if (comparison.hint) {
    process.stdout.write(`[retrieval-eval] ${comparison.hint}\n`)
  }
  assert.equal(comparison.passed, true, comparison.failures.join('\n'))

  // Verify determinism of digests and case metrics.
  assert.equal(report.corpus_digest, baseline.corpus_digest)
  assert.equal(report.cases_digest, baseline.cases_digest)
  assert.equal(report.cases.length, baseline.cases.length)

  const table = formatEvalTable(report)
  assert.match(table, /Retrieval Evaluation Summary \(by category\)/)
  assert.match(table, /Known-Gap Cases/)
})

// The CI machine runs Node 22.13+ where node:sqlite loads unflagged; older builds skip this suite and keep the JSON gate.
test('retrieval-eval golden set under the FTS5 engine has zero leaks, no regression against its baseline, and never loses recall versus JSON', { skip: ftsSupport() ? false : 'node:sqlite with FTS5 is unavailable' }, async () => {
  const [baseline, jsonBaseline] = await Promise.all([
    readFile(DEFAULT_FTS5_BASELINE_PATH, 'utf8').then(JSON.parse),
    readFile(DEFAULT_BASELINE_PATH, 'utf8').then(JSON.parse)
  ])
  assert.equal(baseline.engine, 'fts5')
  const report = await runRetrievalEval({ engine: 'fts5' })
  assert.equal(report.engine, 'fts5')
  assert.equal(report.summary.total_forbidden_leaks, 0, 'forbidden leaks must be 0')
  const comparison = compareWithBaseline(report, baseline)
  if (comparison.hint) process.stdout.write(`[retrieval-eval fts5] ${comparison.hint}\n`)
  assert.equal(comparison.passed, true, comparison.failures.join('\n'))
  assert.equal(report.cases_digest, baseline.cases_digest)

  // FTS5 is an additional signal: no case may recall less than under the JSON engine.
  const jsonById = new Map(jsonBaseline.cases.map(item => [item.id, item]))
  for (const item of report.cases) {
    const json = jsonById.get(item.id)
    assert.ok(item.recall >= json.recall, `case ${item.id} recall ${item.recall} under fts5 is below json ${json.recall}`)
  }
  assert.ok(report.summary.mean_recall >= jsonBaseline.summary.mean_recall)
  // Engine-specific known gaps: a case listed only for deterministic-json must meet expectations under fts5.
  const cases = JSON.parse(await readFile(DEFAULT_CASES_PATH, 'utf8')).cases
  for (const evalCase of cases.filter(c => Array.isArray(c.known_gap) && !isKnownGap(c, 'fts5'))) {
    assert.equal(report.cases.find(item => item.id === evalCase.id).recall, 1, `${evalCase.id} must be resolved under fts5`)
  }
})

test('eval engine selection: known_gap may name engines, and a baseline from another engine fails the gate', async () => {
  assert.equal(parseEvalOptions(['--engine', 'json']).engine, 'json')
  assert.equal(parseEvalOptions([]).engine, 'auto')
  assert.throws(() => parseEvalOptions(['--engine', 'lucene']), /--engine must be one of/)
  assert.equal(isKnownGap({ known_gap: true }, 'fts5'), true)
  assert.equal(isKnownGap({ known_gap: ['deterministic-json'] }, 'fts5'), false)
  assert.equal(isKnownGap({ known_gap: ['deterministic-json'] }, 'deterministic-json'), true)
  assert.equal(isKnownGap({}, 'fts5'), false)
  const baseline = JSON.parse(await readFile(DEFAULT_BASELINE_PATH, 'utf8'))
  const other = { ...structuredClone(baseline), engine: 'fts5' }
  const check = compareWithBaseline(other, baseline)
  assert.equal(check.passed, false)
  assert.match(check.failures.join(' '), /Engine mismatch/)
})

test('compareWithBaseline enforces zero leaks, aggregate recall floor, non-gap case floor, and improvement hints', async () => {
  const baseline = JSON.parse(await readFile(DEFAULT_BASELINE_PATH, 'utf8'))

  // 1. Forbidden leak fails the gate immediately.
  const leaked = structuredClone(baseline)
  leaked.cases[0].forbidden_leaks = 1
  leaked.cases[0].leaked_paths = ['context/restricted-vault.md']
  leaked.summary.total_forbidden_leaks = 1
  const leakCheck = compareWithBaseline(leaked, baseline)
  assert.equal(leakCheck.passed, false)
  assert.match(leakCheck.failures.join(' '), /Forbidden privacy\/lifecycle leaks detected/)

  // 2. Aggregate recall drop > 0.02 fails the gate.
  const aggDrop = structuredClone(baseline)
  aggDrop.summary.mean_recall = Number((baseline.summary.mean_recall - 0.025).toFixed(4))
  const aggCheck = compareWithBaseline(aggDrop, baseline)
  assert.equal(aggCheck.passed, false)
  assert.match(aggCheck.failures.join(' '), /Aggregate mean_recall dropped/)

  // 3. Single non-known_gap case recall drop fails even if aggregate recall is unchanged.
  const singleDrop = structuredClone(baseline)
  const nonGapCase = singleDrop.cases.find(item => !item.known_gap && item.recall === 1)
  assert.ok(nonGapCase)
  nonGapCase.recall = 0.5
  const singleCheck = compareWithBaseline(singleDrop, baseline)
  assert.equal(singleCheck.passed, false)
  assert.match(singleCheck.failures.join(' '), new RegExp(`Non-known_gap case '${nonGapCase.id}' recall dropped`))

  // 4. Improvement on a known_gap case is allowed and emits the --update-baseline hint.
  const improved = structuredClone(baseline)
  const gapCase = improved.cases.find(item => item.known_gap)
  assert.ok(gapCase)
  gapCase.recall = 1
  improved.summary.mean_recall = Number((baseline.summary.mean_recall + 0.0208).toFixed(4))
  const improvedCheck = compareWithBaseline(improved, baseline)
  assert.equal(improvedCheck.passed, true)
  assert.ok(improvedCheck.improvements.length >= 1)
  assert.match(improvedCheck.hint, /npm run eval:retrieval -- --update-baseline/)
})

test('eval-retrieval CLI writes JSON to --out and validates options', async () => {
  assert.equal(parseEvalOptions([]).out, null)
  assert.equal(parseEvalOptions(['--update-baseline']).updateBaseline, true)
  assert.throws(() => parseEvalOptions(['--concurrency', '0']), /1 to 16/)
  assert.throws(() => parseEvalOptions(['--unknown']), /unknown option/)

  const dir = await mkdtemp(join(tmpdir(), 'holoself-eval-cli-'))
  const outPath = join(dir, 'report.json')
  try {
    const res = spawnSync(process.execPath, [EVAL_SCRIPT, '--out', outPath], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 120_000
    })
    assert.equal(res.status, 0, res.stderr)
    assert.match(res.stdout, /Retrieval Evaluation Summary/)
    const written = JSON.parse(await readFile(outPath, 'utf8'))
    assert.equal(written.kind, 'retrieval-eval-report')
    assert.equal(written.summary.total_forbidden_leaks, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }

  const bad = spawnSync(process.execPath, [EVAL_SCRIPT, '--unknown-flag'], {
    encoding: 'utf8',
    windowsHide: true
  })
  assert.equal(bad.status, 2)
  assert.match(bad.stderr, /retrieval eval error:/)

  // Unit check for scoreCaseResult detecting restricted leaks even if omitted from case.forbidden_source_paths.
  const syntheticLeak = scoreCaseResult(
    {
      id: 'leak-check',
      category: 'privacy',
      lens: 'general',
      budget: 'small',
      expected_source_paths: ['profile/identity.md'],
      forbidden_source_paths: []
    },
    {
      self: { documents: [{ path: 'profile/identity.md', content: 'ok' }, { path: 'context/restricted-vault.md', content: 'leak' }] },
      sources: [],
      selection: { context_need: 'helpful', total_bytes: 500, content_chars: 6 }
    }
  )
  assert.equal(syntheticLeak.forbidden_leaks, 1)
  assert.deepEqual(syntheticLeak.leaked_paths, ['context/restricted-vault.md'])
})
