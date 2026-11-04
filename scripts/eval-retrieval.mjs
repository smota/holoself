// Retrieval golden-set evaluation runner (issue #67).
// Spawns `bin/holoself.mjs context --project ... --json` against a synthetic linked project for every case,
// computes recall@budget, precision, forbidden leaks, and bytes used, prints a summary table, and outputs JSON.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { HOLOSELF_BIN, SYNTHETIC_DOCUMENTS, createRetrievalEvalFixture } from '../tests/fixtures/retrieval-eval/corpus.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_CASES_PATH = join(REPO_ROOT, 'tests', 'fixtures', 'retrieval-eval', 'cases.json')
export const DEFAULT_BASELINE_PATH = join(REPO_ROOT, 'tests', 'fixtures', 'retrieval-eval', 'baseline.json')
export const DEFAULT_FTS5_BASELINE_PATH = join(REPO_ROOT, 'tests', 'fixtures', 'retrieval-eval', 'baseline-fts5.json')
export const EVAL_ENGINES = Object.freeze(['auto', 'json', 'fts5'])
const JSON_ENGINE = 'deterministic-json'

// Each retrieval engine keeps its own baseline: deterministic-json in baseline.json, fts5 in baseline-fts5.json.
export function baselinePathFor(engine) {
  return engine === 'fts5' ? DEFAULT_FTS5_BASELINE_PATH : DEFAULT_BASELINE_PATH
}

// known_gap is either a boolean or the list of engines for which the case is still a known gap.
export function isKnownGap(evalCase, engine = JSON_ENGINE) {
  return Array.isArray(evalCase.known_gap) ? evalCase.known_gap.includes(engine) : Boolean(evalCase.known_gap)
}
const RESTRICTED_PATHS = new Set(
  SYNTHETIC_DOCUMENTS.filter(doc => doc.frontmatter.sensitivity === 'restricted').map(doc => doc.path)
)

const round4 = value => Math.round(Number(value) * 10_000) / 10_000

export function parseEvalOptions(argv = []) {
  const options = {
    out: null,
    updateBaseline: false,
    casesPath: DEFAULT_CASES_PATH,
    baselinePath: null,
    engine: 'auto',
    concurrency: 6,
    quietTable: false
  }
  const valueAfter = (flag, index) => {
    const next = argv[index + 1]
    if (next === undefined || next === '' || next.startsWith('--')) {
      throw new Error(`${flag} requires a value`)
    }
    return next
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--out' || arg === '--output') options.out = resolve(valueAfter(arg, i++))
    else if (arg === '--update-baseline') options.updateBaseline = true
    else if (arg === '--cases') options.casesPath = resolve(valueAfter(arg, i++))
    else if (arg === '--baseline') options.baselinePath = resolve(valueAfter(arg, i++))
    else if (arg === '--engine') {
      const engine = valueAfter(arg, i++)
      if (!EVAL_ENGINES.includes(engine)) throw new Error(`--engine must be one of ${EVAL_ENGINES.join(', ')}`)
      options.engine = engine
    }
    else if (arg === '--concurrency') {
      const n = Number(valueAfter(arg, i++))
      if (!Number.isInteger(n) || n < 1 || n > 16) throw new Error('--concurrency must be an integer from 1 to 16')
      options.concurrency = n
    } else if (arg === '--quiet-table') options.quietTable = true
    else throw new Error(`unknown option: ${arg}`)
  }
  return options
}

export function buildCliArgs(evalCase, projectDir) {
  const args = ['context', '--project', projectDir]
  if (evalCase.lens) args.push('--lens', evalCase.lens)
  if (evalCase.budget) args.push('--budget', evalCase.budget)
  if (evalCase.session_start) args.push('--session-start')
  else if (typeof evalCase.task === 'string' && evalCase.task.length > 0) args.push('--task', evalCase.task)
  if (evalCase.temporal) args.push('--temporal', evalCase.temporal)
  if (evalCase.include_history) args.push('--include-history')
  if (evalCase.adapter) args.push('--adapter', evalCase.adapter)
  args.push('--json')
  return args
}

function invokeContextCli(projectDir, env, cliArgs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [HOLOSELF_BIN, ...cliArgs], {
      cwd: projectDir,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const stdoutChunks = []
    const stderrChunks = []
    child.stdout.on('data', chunk => stdoutChunks.push(chunk))
    child.stderr.on('data', chunk => stderrChunks.push(chunk))
    child.once('error', rejectPromise)
    child.once('close', code => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8')
      const stderr = Buffer.concat(stderrChunks).toString('utf8')
      if (code !== 0) {
        return rejectPromise(new Error(`holoself context exited with code ${code}: ${stderr.trim() || stdout.trim()}`))
      }
      let parsed
      try {
        parsed = JSON.parse(stdout)
      } catch {
        return rejectPromise(new Error(`holoself context returned invalid JSON: ${stdout.slice(0, 300)}`))
      }
      resolvePromise({ data: parsed, stdout })
    })
  })
}

export function packetEngine(packet) {
  return packet?.context_receipt?.engine || JSON_ENGINE
}

export function scoreCaseResult(evalCase, packet, engine = packetEngine(packet)) {
  const selfDocs = Array.isArray(packet?.self?.documents) ? packet.self.documents : []
  const sources = Array.isArray(packet?.sources) ? packet.sources : []
  const deliveredPaths = [...new Set([...selfDocs.map(doc => doc.path), ...sources.map(src => src.path)])]
  const deliveredSet = new Set(deliveredPaths)

  const expected = Array.isArray(evalCase.expected_source_paths) ? evalCase.expected_source_paths : []
  const forbidden = Array.isArray(evalCase.forbidden_source_paths) ? evalCase.forbidden_source_paths : []

  const expectedFound = expected.filter(path => deliveredSet.has(path))
  const missingPaths = expected.filter(path => !deliveredSet.has(path))
  const leakedSet = new Set([
    ...forbidden.filter(path => deliveredSet.has(path)),
    ...deliveredPaths.filter(path => RESTRICTED_PATHS.has(path))
  ])
  const leakedPaths = [...leakedSet]

  let recall
  let precision
  if (expected.length === 0) {
    recall = deliveredPaths.length === 0 ? 1 : 0
    precision = deliveredPaths.length === 0 ? 1 : 0
  } else {
    recall = round4(expectedFound.length / expected.length)
    precision = deliveredPaths.length > 0 ? round4(expectedFound.length / deliveredPaths.length) : 0
  }

  const contentBytes = selfDocs.reduce((sum, doc) => sum + Buffer.byteLength(doc.content || '', 'utf8'), 0)
  const bytesUsed =
    typeof packet?.selection?.total_bytes === 'number'
      ? packet.selection.total_bytes
      : Buffer.byteLength(JSON.stringify(packet, null, 2) + '\n', 'utf8')

  return {
    id: evalCase.id,
    category: evalCase.category,
    language: evalCase.language || 'en',
    task: evalCase.task ?? null,
    session_start: Boolean(evalCase.session_start),
    temporal: evalCase.temporal || 'current',
    lens: evalCase.lens,
    budget: evalCase.budget,
    known_gap: isKnownGap(evalCase, engine),
    gap_issue: evalCase.gap_issue || null,
    context_need: packet?.selection?.context_need || 'helpful',
    expected_count: expected.length,
    expected_found: expectedFound.length,
    delivered_count: deliveredPaths.length,
    recall,
    precision,
    forbidden_leaks: leakedPaths.length,
    leaked_paths: leakedPaths,
    bytes_used: bytesUsed,
    content_bytes: contentBytes,
    content_chars: packet?.selection?.content_chars ?? 0,
    expected_source_paths: expected,
    delivered_source_paths: deliveredPaths,
    missing_source_paths: missingPaths,
    notes: evalCase.notes || ''
  }
}

export function aggregateMetrics(caseResults) {
  const mean = values => (values.length ? round4(values.reduce((sum, v) => sum + v, 0) / values.length) : 1)
  const buildGroup = items => {
    const nonGap = items.filter(item => !item.known_gap)
    const knownGap = items.filter(item => item.known_gap)
    const totalBytes = items.reduce((sum, item) => sum + item.bytes_used, 0)
    const totalContentBytes = items.reduce((sum, item) => sum + item.content_bytes, 0)
    return {
      cases: items.length,
      non_gap_cases: nonGap.length,
      known_gap_cases: knownGap.length,
      mean_recall: mean(items.map(item => item.recall)),
      non_gap_mean_recall: mean(nonGap.map(item => item.recall)),
      known_gap_mean_recall: knownGap.length ? mean(knownGap.map(item => item.recall)) : null,
      mean_precision: mean(items.map(item => item.precision)),
      forbidden_leaks: items.reduce((sum, item) => sum + item.forbidden_leaks, 0),
      mean_bytes_used: items.length ? Math.round(totalBytes / items.length) : 0,
      total_bytes_used: totalBytes,
      total_content_bytes: totalContentBytes
    }
  }

  const categories = [...new Set(caseResults.map(item => item.category))]
  const byCategory = {}
  for (const category of categories) {
    byCategory[category] = buildGroup(caseResults.filter(item => item.category === category))
  }

  const languages = [...new Set(caseResults.map(item => item.language))]
  const byLanguage = {}
  for (const language of languages) {
    byLanguage[language] = buildGroup(caseResults.filter(item => item.language === language))
  }

  const overall = buildGroup(caseResults)
  return {
    total_cases: overall.cases,
    non_gap_cases: overall.non_gap_cases,
    known_gap_cases: overall.known_gap_cases,
    mean_recall: overall.mean_recall,
    non_gap_mean_recall: overall.non_gap_mean_recall,
    known_gap_mean_recall: overall.known_gap_mean_recall,
    mean_precision: overall.mean_precision,
    total_forbidden_leaks: overall.forbidden_leaks,
    mean_bytes_used: overall.mean_bytes_used,
    total_bytes_used: overall.total_bytes_used,
    total_content_bytes: overall.total_content_bytes,
    by_category: byCategory,
    by_language: byLanguage
  }
}

export async function runRetrievalEval(options = {}) {
  const casesPath = options.casesPath || DEFAULT_CASES_PATH
  const rawCases = JSON.parse(await readFile(casesPath, 'utf8'))
  if (!rawCases || !Array.isArray(rawCases.cases) || rawCases.cases.length < 40) {
    throw new Error(`cases file must contain at least 40 cases (found ${rawCases?.cases?.length ?? 0})`)
  }
  const casesDigest = createHash('sha256').update(JSON.stringify(rawCases.cases)).digest('hex')
  const concurrency = options.concurrency || 6

  const fixture = await createRetrievalEvalFixture()
  const requested = options.engine || 'auto'
  const env = { ...fixture.env }
  if (requested === 'auto') delete env.HOLOSELF_INDEX_ENGINE
  else env.HOLOSELF_INDEX_ENGINE = requested
  try {
    const results = new Array(rawCases.cases.length),
      engines = new Set()
    let cursor = 0
    const worker = async () => {
      while (cursor < rawCases.cases.length) {
        const index = cursor++
        const evalCase = rawCases.cases[index]
        const cliArgs = buildCliArgs(evalCase, fixture.project)
        const { data } = await invokeContextCli(fixture.project, env, cliArgs)
        engines.add(packetEngine(data))
        results[index] = scoreCaseResult(evalCase, data)
      }
    }
    const workers = Array.from({ length: Math.min(concurrency, rawCases.cases.length) }, () => worker())
    await Promise.all(workers)
    if (engines.size !== 1) throw new Error(`cases ran under more than one engine: ${[...engines].sort().join(', ')}`)
    const engine = [...engines][0]
    if (requested === 'fts5' && engine !== 'fts5') throw new Error('--engine fts5 requested but node:sqlite with FTS5 is unavailable')

    const summary = aggregateMetrics(results)
    return {
      schema_version: 1,
      kind: 'retrieval-eval-report',
      engine,
      dataset_version: rawCases.dataset_version || 1,
      corpus_document_count: fixture.documentCount,
      corpus_digest: fixture.corpusDigest,
      cases_digest: casesDigest,
      summary,
      cases: results
    }
  } finally {
    await fixture.cleanup()
  }
}

export function formatEvalTable(report) {
  const lines = []
  lines.push('Retrieval Evaluation Summary (by category)')
  lines.push(`Engine: ${report.engine || JSON_ENGINE}`)
  lines.push('Category       | Cases | Non-Gap | Gap | Recall | Non-Gap Recall | Precision | Leaks | Avg Bytes')
  lines.push('---------------+-------+---------+-----+--------+----------------+-----------+-------+----------')
  for (const [category, stats] of Object.entries(report.summary.by_category)) {
    lines.push(
      [
        category.padEnd(14),
        String(stats.cases).padStart(5),
        String(stats.non_gap_cases).padStart(7),
        String(stats.known_gap_cases).padStart(3),
        stats.mean_recall.toFixed(4).padStart(6),
        stats.non_gap_mean_recall.toFixed(4).padStart(14),
        stats.mean_precision.toFixed(4).padStart(9),
        String(stats.forbidden_leaks).padStart(5),
        String(stats.mean_bytes_used).padStart(9)
      ].join(' | ')
    )
  }
  lines.push('---------------+-------+---------+-----+--------+----------------+-----------+-------+----------')
  const s = report.summary
  lines.push(
    [
      'TOTAL'.padEnd(14),
      String(s.total_cases).padStart(5),
      String(s.non_gap_cases).padStart(7),
      String(s.known_gap_cases).padStart(3),
      s.mean_recall.toFixed(4).padStart(6),
      s.non_gap_mean_recall.toFixed(4).padStart(14),
      s.mean_precision.toFixed(4).padStart(9),
      String(s.total_forbidden_leaks).padStart(5),
      String(s.mean_bytes_used).padStart(9)
    ].join(' | ')
  )

  const gapCases = report.cases.filter(item => item.known_gap)
  if (gapCases.length > 0) {
    lines.push('')
    lines.push(`Known-Gap Cases (${gapCases.length}):`)
    for (const item of gapCases) {
      const issue = item.gap_issue ? ` (${item.gap_issue})` : ''
      lines.push(
        `  - ${item.id}${issue}: recall=${item.recall.toFixed(2)}, need=${item.context_need}, missing=[${item.missing_source_paths.join(', ')}]`
      )
    }
  }
  return lines.join('\n')
}

export function compareWithBaseline(report, baseline, { tolerance = 0.02 } = {}) {
  const failures = []
  const improvements = []
  const EPS = 1e-9

  const reportEngine = report.engine || JSON_ENGINE,
    baselineEngine = baseline?.engine || JSON_ENGINE
  if (reportEngine !== baselineEngine) failures.push(`Engine mismatch: report ran under ${reportEngine} but the baseline was recorded under ${baselineEngine}`)

  if (report.summary.total_forbidden_leaks > 0) {
    const leakingCases = report.cases.filter(c => c.forbidden_leaks > 0).map(c => `${c.id} (${c.leaked_paths.join(', ')})`)
    failures.push(`Forbidden privacy/lifecycle leaks detected (${report.summary.total_forbidden_leaks}): ${leakingCases.join('; ')}`)
  }
  for (const c of report.cases) {
    if (c.forbidden_leaks > 0 && !failures.some(f => f.includes(c.id))) {
      failures.push(`Case ${c.id} leaked forbidden sources: ${c.leaked_paths.join(', ')}`)
    }
  }

  const baselineRecall = baseline?.summary?.mean_recall
  if (typeof baselineRecall === 'number') {
    const minAllowed = round4(baselineRecall - tolerance)
    if (report.summary.mean_recall + EPS < minAllowed) {
      failures.push(
        `Aggregate mean_recall dropped from ${baselineRecall.toFixed(4)} to ${report.summary.mean_recall.toFixed(4)} (below floor ${minAllowed.toFixed(4)})`
      )
    } else if (report.summary.mean_recall > baselineRecall + EPS) {
      improvements.push(
        `Aggregate mean_recall improved from ${baselineRecall.toFixed(4)} to ${report.summary.mean_recall.toFixed(4)}`
      )
    }
  }

  const baselineById = new Map((baseline?.cases || []).map(item => [item.id, item]))
  for (const current of report.cases) {
    const base = baselineById.get(current.id)
    if (!base) continue
    if (!current.known_gap && current.recall + EPS < base.recall) {
      failures.push(
        `Non-known_gap case '${current.id}' recall dropped from ${base.recall.toFixed(4)} to ${current.recall.toFixed(4)}`
      )
    } else if (current.recall > base.recall + EPS) {
      improvements.push(`Case '${current.id}' recall improved from ${base.recall.toFixed(4)} to ${current.recall.toFixed(4)}`)
    }
  }

  const hint =
    improvements.length > 0
      ? `Retrieval recall improved over baseline. Update the baseline with: npm run eval:retrieval -- --update-baseline --engine ${reportEngine === 'fts5' ? 'fts5' : 'json'}`
      : null

  return {
    passed: failures.length === 0,
    failures,
    improvements,
    hint
  }
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseEvalOptions(argv)
    const report = await runRetrievalEval(options)
    const table = formatEvalTable(report)
    const json = `${JSON.stringify(report, null, 2)}\n`

    if (options.updateBaseline) {
      const baselinePath = options.baselinePath || baselinePathFor(report.engine)
      await mkdir(dirname(baselinePath), { recursive: true })
      await writeFile(baselinePath, json, 'utf8')
    }
    if (options.out) {
      await mkdir(dirname(options.out), { recursive: true })
      await writeFile(options.out, json, 'utf8')
    }

    if (options.out || options.updateBaseline) {
      if (!options.quietTable) process.stdout.write(`${table}\n`)
    } else {
      if (!options.quietTable) process.stderr.write(`${table}\n\n`)
      process.stdout.write(json)
    }

    if (report.summary.total_forbidden_leaks > 0) {
      process.exitCode = 1
    }
  } catch (error) {
    process.stderr.write(`retrieval eval error: ${error.message}\n`)
    process.exitCode = 2
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null
if (invokedPath === import.meta.url) await main()
