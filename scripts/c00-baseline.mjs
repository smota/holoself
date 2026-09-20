import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createFixture } from '../tests/helpers/c00-fixture.mjs'
import { run } from '../src/cli.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_WORKER = join(REPO, 'tests', 'helpers', 'c00-worker.mjs')
const QUALITY_LABELS = join(REPO, 'tests', 'fixtures', 'c00', 'quality-cases.json')
const CONTRACT_DIGEST = '5bd850b7b8b543ef130cdf97ea1016fb1bd4714fce5947848a80630e71794ad9'
const QUALITY_DIGEST = '47e5812f687d535418eb00d4f09e2138bf5281ef30272e9c7aba5c9eb7c14c81'
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_STDOUT_BYTES = 8 * 1024 * 1024
const MAX_STDERR_BYTES = 64 * 1024
const SCENARIOS = ['context-cold', 'context-disk-warm', 'mcp-memory-warm', 'manifest-warm', 'expand-warm', 'search-warm']
const STATUSES = new Set(['passed', 'failed', 'partial', 'not-implemented'])
const usage = 'Usage: node scripts/c00-baseline.mjs [--sizes 100,1000,10000] [--iterations 30] [--output file] [--timeout milliseconds] [--acceptance]'

export function parseOptions(argv) {
  const options = { sizes: [100], iterations: 1, timeoutMs: DEFAULT_TIMEOUT_MS, acceptance: false, output: null }
  const valueAfter = (option, index) => {
    const value = argv[index + 1]
    if (value === undefined || value === '' || value.startsWith('--')) throw new Error(`${option} requires a value`)
    return value
  }
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]
    if (option === '--sizes') options.sizes = valueAfter(option, index++).split(',').map(Number)
    else if (option === '--iterations') options.iterations = Number(valueAfter(option, index++))
    else if (option === '--output') options.output = resolve(valueAfter(option, index++))
    else if (option === '--timeout' || option === '--timeout-ms') options.timeoutMs = Number(valueAfter(option, index++))
    else if (option === '--acceptance') options.acceptance = true
    else throw new Error(`unknown option: ${option}`)
  }
  if (options.sizes.length === 0 || options.sizes.some(size => !Number.isInteger(size) || size < 0 || size > 10_000)) throw new Error('--sizes must contain integers from 0 to 10000')
  if (new Set(options.sizes).size !== options.sizes.length) throw new Error('--sizes must not contain duplicates')
  if (!Number.isInteger(options.iterations) || options.iterations < 1 || options.iterations > 30) throw new Error('--iterations must be an integer from 1 to 30')
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1_000 || options.timeoutMs > 3_600_000) throw new Error('--timeout must be an integer from 1000 to 3600000 milliseconds')
  return options
}

const finiteNonnegative = (value, label) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${label} must be a finite non-negative number`)
  return value
}

export function nearestRank(values, percentile) {
  if (!Array.isArray(values) || values.length === 0) throw new Error('percentile requires at least one value')
  if (typeof percentile !== 'number' || percentile <= 0 || percentile > 1) throw new Error('percentile must be greater than 0 and at most 1')
  const ordered = values.map((value, index) => finiteNonnegative(value, `values[${index}]`)).sort((left, right) => left - right)
  return ordered[Math.ceil(percentile * ordered.length) - 1]
}

const metricSummary = (values, unit) => ({ unit, min: Math.min(...values), p50: nearestRank(values, 0.5), p95: nearestRank(values, 0.95), max: Math.max(...values) })

export function validateSample(sample, index, scenario = null) {
  if (!sample || typeof sample !== 'object' || Array.isArray(sample)) throw new Error(`sample ${index} must be an object`)
  const productError = sample.outcome === 'product-error'
  if (sample.outcome !== undefined && sample.outcome !== 'success' && !productError) throw new Error(`sample ${index}.outcome is invalid`)
  if (productError) {
    if (scenario !== 'mcp-memory-warm' || sample.errorCode !== 'RESULT_TOO_LARGE') throw new Error(`sample ${index} reported an unsupported product error: ${sample.errorCode ?? 'missing code'}`)
    for (const field of ['selectedCount', 'cache', 'estimatedTokensBody']) if (sample[field] !== null) throw new Error(`sample ${index}.${field} must be null when the MCP operation is unavailable`)
  } else if (sample.errorCode !== undefined && sample.errorCode !== null) throw new Error(`sample ${index} reported an error code without a product-error outcome`)
  for (const field of ['latencyMs', 'payloadBytes', 'wireBytes', 'returnedChars', 'estimatedTokensTotalHeuristic', 'cacheStorageBytes']) finiteNonnegative(sample[field], `sample ${index}.${field}`)
  if (!productError) finiteNonnegative(sample.selectedCount, `sample ${index}.selectedCount`)
  if (sample.estimatedTokensBody !== null) finiteNonnegative(sample.estimatedTokensBody, `sample ${index}.estimatedTokensBody`)
  if (sample.cache !== null && (!sample.cache || typeof sample.cache !== 'object')) throw new Error(`sample ${index}.cache must be an object or null`)
  if (sample.cache) for (const field of ['hit', 'persistent']) if (typeof sample.cache[field] !== 'boolean') throw new Error(`sample ${index}.cache.${field} must be boolean`)
  if (!sample.io || typeof sample.io !== 'object') throw new Error(`sample ${index}.io must be an object`)
  for (const field of ['bodyReads', 'bodyBytes', 'syntheticReads', 'syntheticBytes', 'uniqueBodyFiles', 'metadataOps', 'selectedBodyReads', 'nonselectedBodyReads']) finiteNonnegative(sample.io[field], `sample ${index}.io.${field}`)
  if (!sample.io.byApi || typeof sample.io.byApi !== 'object' || Array.isArray(sample.io.byApi)) throw new Error(`sample ${index}.io.byApi must be an object`)
  if (!sample.io.classification || typeof sample.io.classification !== 'object' || Array.isArray(sample.io.classification)) throw new Error(`sample ${index}.io.classification must be an object`)
  if (!Array.isArray(sample.io.unsupported)) throw new Error(`sample ${index}.io.unsupported must be an array`)
  if (sample.io.unsupported.length > 0) throw new Error(`sample ${index} used unsupported I/O: ${JSON.stringify(sample.io.unsupported).slice(0, 500)}`)
  return sample
}

function validateMeasurementTree(value, label = 'worker data') {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`)
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateMeasurementTree(item, `${label}[${index}]`))
    return value
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'unsupported' && Array.isArray(item) && item.length > 0) throw new Error(`${label}.${key} reports unsupported I/O`)
      validateMeasurementTree(item, `${label}.${key}`)
    }
  }
  return value
}

function fixtureRequest(fixture, count) {
  return { root: fixture.root, self: fixture.self, project: fixture.project, peer: fixture.peer, count }
}

export function invokeWorker(worker, payload, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolvePromise, rejectPromise) => {
    const started = performance.now()
    const child = spawn(process.execPath, [worker], { cwd: REPO, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = Buffer.alloc(0)
    let stderr = Buffer.alloc(0)
    let settled = false
    let overflow = null
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) rejectPromise(error)
      else resolvePromise({ value, externalDurationMs: performance.now() - started })
    }
    const timer = setTimeout(() => { child.kill(); finish(new Error(`worker timeout after ${timeoutMs}ms`)) }, timeoutMs)
    child.stdout.on('data', chunk => {
      if (stdout.length + chunk.length > MAX_STDOUT_BYTES) { overflow = `worker stdout exceeded ${MAX_STDOUT_BYTES} bytes`; child.kill() } else stdout = Buffer.concat([stdout, chunk])
    })
    child.stderr.on('data', chunk => {
      if (stderr.length + chunk.length > MAX_STDERR_BYTES) { overflow = `worker stderr exceeded ${MAX_STDERR_BYTES} bytes`; child.kill() } else stderr = Buffer.concat([stderr, chunk])
    })
    child.once('error', error => finish(error))
    child.once('close', code => {
      if (overflow) return finish(new Error(overflow))
      const diagnostic = stderr.toString('utf8').trim().slice(0, 2_000)
      let response
      try { response = JSON.parse(stdout.toString('utf8')) }
      catch { return finish(new Error(`worker returned invalid JSON${diagnostic ? `: ${diagnostic}` : ''}`)) }
      if (code !== 0 || response?.ok !== true) return finish(new Error(response?.error?.message || diagnostic || `worker exited with code ${code}`))
      finish(null, response)
    })
    child.stdin.once('error', error => finish(error))
    child.stdin.end(JSON.stringify(payload))
  })
}

const quietRun = async args => {
  const original = console.log
  console.log = () => {}
  try { return await run(args) } finally { console.log = original }
}

async function runBenchmark(worker, fixture, count, scenario, iterations, timeoutMs) {
  process.stderr.write(`[c00] size=${count} scenario=${scenario} samples=${iterations}\n`)
  const request = { operation: 'benchmark', fixture: fixtureRequest(fixture, count), scenario }
  const samples = []
  const processDurations = []
  let primingExternalDurationMs = 0
  if (scenario === 'context-disk-warm') {
    const prepared = await invokeWorker(worker, { operation: 'prepare-disk', fixture: fixtureRequest(fixture, count) }, timeoutMs)
    if (prepared.value.data?.prepared !== true) throw new Error('disk-warm priming worker did not confirm preparation')
    primingExternalDurationMs = prepared.externalDurationMs
  }
  if (scenario === 'context-cold' || scenario === 'context-disk-warm') {
    for (let index = 0; index < iterations; index += 1) {
      const response = await invokeWorker(worker, { ...request, iterations: 1 }, timeoutMs)
      if (!Array.isArray(response.value.samples) || response.value.samples.length !== 1) throw new Error(`${scenario} worker must return exactly one sample`)
      const sample = validateSample(response.value.samples[0], index, scenario)
      if (scenario === 'context-cold' && (sample.cache?.hit !== false || sample.cache.persistent !== true)) throw new Error('cold context sample did not report a persistent cache miss')
      if (scenario === 'context-disk-warm' && (sample.cache?.hit !== true || sample.cache.persistent !== true)) throw new Error('disk-warm context sample did not report a persistent cache hit')
      samples.push({ ...sample, externalDurationMs: response.externalDurationMs })
      processDurations.push(response.externalDurationMs)
    }
  } else {
    const response = await invokeWorker(worker, { ...request, iterations }, timeoutMs)
    if (!Array.isArray(response.value.samples) || response.value.samples.length !== iterations) throw new Error(`${scenario} worker returned ${response.value.samples?.length ?? 'no'} samples; expected ${iterations}`)
    samples.push(...response.value.samples.map((sample, index) => validateSample(sample, index, scenario)))
    const productErrors = samples.filter(sample => sample.outcome === 'product-error')
    if (scenario === 'mcp-memory-warm' && productErrors.length > 0 && productErrors.length !== samples.length) throw new Error('memory-warm MCP samples mixed successful operations and product errors')
    if (scenario === 'mcp-memory-warm' && productErrors.length === 0 && samples.some(sample => sample.cache?.hit !== true || sample.cache.persistent !== false)) throw new Error('memory-warm MCP sample did not report a non-persistent memory cache hit')
    processDurations.push(response.externalDurationMs)
  }
  const numericMetrics = {
    latencyMs: 'milliseconds', payloadBytes: 'bytes', wireBytes: 'bytes', returnedChars: 'characters',
    estimatedTokensBody: 'estimated-tokens', estimatedTokensTotalHeuristic: 'estimated-tokens', selectedCount: 'sources', cacheStorageBytes: 'bytes'
  }
  const metrics = Object.fromEntries(Object.entries(numericMetrics).map(([field, unit]) => {
    const values = samples.map(sample => sample[field]).filter(value => typeof value === 'number')
    return [field, values.length ? { ...metricSummary(values, unit), observed: values.length, unavailable: samples.length - values.length } : { unit, observed: 0, unavailable: samples.length }]
  }))
  metrics.externalProcessDurationMs = metricSummary(processDurations, 'milliseconds')
  const productErrors = samples.filter(sample => sample.outcome === 'product-error')
  const errorCounts = Object.fromEntries([...new Set(productErrors.map(sample => sample.errorCode))].sort().map(code => [code, productErrors.filter(sample => sample.errorCode === code).length]))
  const expectedOperationUnavailable = scenario === 'mcp-memory-warm' && productErrors.length === samples.length
  return {
    size: count, scenario, iterations,
    processModel: scenario === 'context-cold' || scenario === 'context-disk-warm' ? 'one-worker-per-sample' : 'one-resident-worker',
    operationScope: expectedOperationUnavailable ? 'MCP manifest acquisition blocked; resident repeated manifest attempts; context_get/cache-hit unavailable' : scenario === 'mcp-memory-warm' ? 'one-handle context_get after manifest and context_get priming' : 'full scenario operation described by scenario name',
    sourceDigest: fixture.sourceDigest,
    successfulSamples: samples.length - productErrors.length,
    productErrorSamples: productErrors.length,
    errorCounts,
    expectedOperationUnavailable,
    cacheObservations: samples.filter(sample => sample.cache !== null).length,
    actualCacheHits: samples.filter(sample => sample.cache?.hit === true).length,
    actualPersistentCacheHits: samples.filter(sample => sample.cache?.hit === true && sample.cache.persistent).length,
    primingExternalDurationMs,
    totalExternalDurationMs: processDurations.reduce((total, value) => total + value, 0), metrics, samples
  }
}

async function prepareQualityFixture(fixture) {
  const entries = await readdir(fixture.qualityRoot, { withFileTypes: true })
  const markdown = entries.filter(entry => entry.isFile() && entry.name.endsWith('.md'))
  if (markdown.length !== 37) throw new Error(`quality fixture must contain 37 Markdown sources, found ${markdown.length}`)
  await Promise.all(markdown.map(entry => copyFile(join(fixture.qualityRoot, entry.name), join(fixture.self, 'context', entry.name))))
  await quietRun(['link', 'add', '--project', fixture.project, '--self', fixture.self, '--lens', 'general', '--secondary-lenses', 'career', '--force', '--no-activate', '--yes'])
}

function validateQuality(data, expectedCases, expectedDigest) {
  if (!data || !Array.isArray(data.cases) || data.cases.length !== expectedCases.length) throw new Error(`quality worker must return ${expectedCases.length} cases`)
  if (data.labelDigest !== expectedDigest || data.labelDigest !== QUALITY_DIGEST) throw new Error('quality label digest does not match the frozen labels')
  const labels = new Map(expectedCases.map(item => [item.id, item]))
  const seen = new Set()
  for (const item of data.cases) {
    if (!item || !labels.has(item.id) || seen.has(item.id)) throw new Error(`quality worker returned an unknown or duplicate case: ${item?.id}`)
    seen.add(item.id)
    const label = labels.get(item.id)
    if (item.class !== label.class || item.language !== label.language) throw new Error(`quality worker changed frozen labels for ${item.id}`)
    for (const field of ['requiredPresent', 'forbiddenAbsent', 'needMatches']) if (typeof item[field] !== 'boolean') throw new Error(`quality case ${item.id}.${field} must be boolean`)
    for (const field of ['personalBodyReads', 'personalBodyChars', 'selectedCount']) finiteNonnegative(item[field], `quality case ${item.id}.${field}`)
    if (!['passed', 'failed'].includes(item.status)) throw new Error(`quality case ${item.id} has invalid status`)
    if (typeof item.need !== 'string') throw new Error(`quality case ${item.id}.need must be a string`)
  }
  return data
}

const outcome = (condition, pass, fail) => condition ? { status: 'passed', evidence: pass } : { status: 'failed', evidence: fail }

function acceptanceMatrix({ scenarios, characterization, quality, sizes }) {
  const repeated = scenarios.filter(item => ['context-disk-warm', 'mcp-memory-warm'].includes(item.scenario)).flatMap(item => item.samples)
  const manifest = scenarios.filter(item => item.scenario === 'manifest-warm').flatMap(item => item.samples)
  const expansion = scenarios.filter(item => item.scenario === 'expand-warm').flatMap(item => item.samples)
  const v01 = outcome(repeated.length > 0 && repeated.every(sample => sample.outcome !== 'product-error' && sample.io.bodyReads === 0), 'Repeated warm samples read zero body files.', 'At least one repeated warm sample reread body files or the requested repeated operation was unavailable; D-08 remains open.')
  const manifestBounded = manifest.length > 0 && manifest.every(sample => sample.selectedCount <= 10 && sample.estimatedTokensBody === 0 && sample.io.bodyReads === 0)
  const expansionBounded = expansion.length > 0 && expansion.every(sample => sample.selectedCount >= 1 && sample.io.nonselectedBodyReads === 0 && sample.io.selectedBodyReads <= sample.selectedCount)
  const v02 = outcome(manifestBounded && expansionBounded, 'Manifest reads zero bodies and direct expansion reads only selected bodies.', 'Manifest or direct-expansion body-read target is not yet met.')
  const envelopeRows = Array.isArray(characterization.envelopes) ? characterization.envelopes : []
  const limits = { small: 16_384, standard: 49_152, deep: 131_072 }
  const envelopeOk = envelopeRows.length === 3 && envelopeRows.every(row => {
    const limit = limits[row.budget]
    return limit && ['cliPayloadBytes', 'mcpPayloadBytes', 'mcpErrorPayloadBytes'].every(field => typeof row[field] === 'number' && row[field] <= limit)
  })
  const v03 = outcome(envelopeOk, 'Measured CLI and MCP envelopes are within the frozen byte limits.', 'One or more measured CLI/MCP envelopes exceed a frozen byte limit or are missing.')
  const allQualityPassed = quality.cases.length === 36 && quality.cases.every(item => item.status === 'passed')
  const rows = [
    { id: 'V-01', ...v01, reason: 'Strict repeated-query zero-body-read target measured without deciding D-08.', owner_cycle: 'C-02' },
    { id: 'V-02', ...v02, reason: 'Manifest and source expansion were measured independently.', owner_cycle: 'C-02' },
    { id: 'V-03', ...v03, reason: 'UTF-8 adapter payload envelopes were measured for all three budgets.', owner_cycle: 'C-01' },
    { id: 'V-04', status: 'partial', evidence: characterization.evidence?.['E-04'] ?? null, reason: 'CLI/MCP parity is measured; Workbench evidence remains static in C-00.', owner_cycle: 'C-01/C-03/C-05' },
    { id: 'V-05', status: 'not-implemented', evidence: characterization.evidence?.['E-05'] ?? null, reason: 'Current custom-method behavior is characterized; the new sharing protocol does not exist.', owner_cycle: 'C-01/C-03' },
    { id: 'V-06', status: 'not-implemented', evidence: characterization.evidence?.['E-06'] ?? null, reason: 'Current non-federation is reproduced; registration and lens intersection do not exist.', owner_cycle: 'C-04' },
    { id: 'V-07', status: 'partial', evidence: characterization.probes?.['V-07'] ?? null, reason: 'Revocation is probed; future catalog concurrency remains unimplemented.', owner_cycle: 'C-02/C-04' },
    { id: 'V-08', status: 'partial', evidence: characterization.probes?.['V-08'] ?? null, reason: 'Content, deletion, and controlled-time probes run; incremental freshness remains unimplemented.', owner_cycle: 'C-02/C-04' },
    { id: 'V-09', status: allQualityPassed ? 'passed' : 'failed', evidence: { passed: quality.cases.filter(item => item.status === 'passed').length, total: quality.cases.length, labelDigest: quality.labelDigest }, reason: 'All frozen PT/EN quality oracles are evaluated independently.', owner_cycle: 'C-01/C-03' },
    { id: 'V-10', status: 'not-implemented', evidence: null, reason: 'No migration was executed and no green stub is reported.', owner_cycle: 'C-03' },
    { id: 'V-11', status: 'not-implemented', evidence: { measuredSizes: sizes, cacheStorageBytes: scenarios.map(item => ({ size: item.size, scenario: item.scenario, max: item.metrics.cacheStorageBytes.max })) }, reason: 'Current scaling and cache storage are measured; future limits and eviction do not exist.', owner_cycle: 'C-02' },
    { id: 'V-12', status: 'partial', evidence: { existingPrivacyPathSafetyTests: 35 }, reason: 'Existing privacy/path-safety evidence is referenced; federated and prompt-injection guarantees remain.', owner_cycle: 'C-03/C-04/C-05/C-06' }
  ]
  if (rows.length !== 12 || rows.some(row => !STATUSES.has(row.status) || typeof row.evidence === 'undefined' || !row.reason || !row.owner_cycle)) throw new Error('acceptance matrix is incomplete')
  return rows
}

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const replacePath = (text, path, token) => {
  if (!path) return text
  const variants = new Set([path, path.replaceAll('\\', '/'), path.replaceAll('/', '\\')])
  let output = text
  for (const variant of variants) output = output.replace(new RegExp(escapeRegExp(variant), process.platform === 'win32' ? 'gi' : 'g'), token)
  return output
}

export function sanitize(value, paths = {}) {
  if (Array.isArray(value)) return value.map(item => sanitize(item, paths))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /(?:password|secret|api[_-]?key|access[_-]?token|authorization)/i.test(key) ? '[REDACTED]' : sanitize(item, paths)]))
  if (typeof value !== 'string') return value
  let output = value
  const replacements = [[paths.qualityRoot, 'QUALITY'], [paths.self, 'SELF'], [paths.project, 'PROJECT'], [paths.peer, 'PEER'], [paths.root, 'FIXTURE'], [REPO, 'REPO'], [homedir(), 'USER_HOME']]
    .filter(([path]) => path).sort((left, right) => right[0].length - left[0].length)
  for (const [path, token] of replacements) output = replacePath(output, path, token)
  output = output.replace(/\b(?:sk-(?:proj-)?|gh[pousr]_)[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_SECRET]')
  output = output.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
  output = output.replace(/\b[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/\s"']+/gi, 'USER_HOME')
  output = output.replace(/\/(?:Users|home)\/[^/\s"']+/g, 'USER_HOME')
  output = output.replace(/(?:\\\\\?\\)?\b[A-Za-z]:[\\/][^\r\n"'<>]*/g, 'ABSOLUTE_PATH')
  output = output.replace(/\\\\[^\\\s"']+\\[^\s"']+(?:\\[^\r\n"'<>]*)?/g, 'ABSOLUTE_PATH')
  output = output.replace(/\/(?:tmp|var|etc|opt|srv|mnt)\/[^\r\n"'<>]*/g, 'ABSOLUTE_PATH')
  return output
}

async function readFrozenLabels() {
  const bytes = await readFile(QUALITY_LABELS)
  const digest = createHash('sha256').update(bytes).digest('hex')
  const parsed = JSON.parse(bytes.toString('utf8'))
  if (!Array.isArray(parsed.cases) || parsed.cases.length !== 36) throw new Error('frozen quality label file must contain 36 cases')
  const semanticDigest = createHash('sha256').update(JSON.stringify(parsed.cases)).digest('hex')
  if (semanticDigest !== QUALITY_DIGEST) throw new Error('frozen quality labels do not match the approved semantic digest')
  return { ...parsed, fileDigest: digest, semanticDigest }
}

export async function buildBaseline(options, worker = DEFAULT_WORKER) {
  const started = performance.now()
  const labels = await readFrozenLabels()
  const artifact = {
    schemaVersion: 1, kind: 'c00-baseline', contract: { id: 'C00-CONTRACT-1', digest: CONTRACT_DIGEST },
    machine: { platform: process.platform, arch: process.arch, runtime: process.version },
    configuration: { sizes: options.sizes, iterations: options.iterations, timeoutMs: options.timeoutMs },
    qualityLabels: { semanticDigest: labels.semanticDigest, fileDigest: labels.fileDigest },
    scenarios: [], characterization: {}, quality: {}, acceptance: []
  }
  const sanitizationPaths = []
  for (const count of options.sizes) {
    const fixture = await createFixture({ count })
    sanitizationPaths.push(fixture)
    try { for (const scenario of SCENARIOS) artifact.scenarios.push(await runBenchmark(worker, fixture, count, scenario, options.iterations, options.timeoutMs)) }
    finally { await fixture.cleanup() }
  }
  const characterizationFixture = await createFixture({ count: 100 })
  sanitizationPaths.push(characterizationFixture)
  try {
    process.stderr.write('[c00] characterization E-01..E-08 and V-07/V-08 probes\n')
    const response = await invokeWorker(worker, { operation: 'characterize', fixture: fixtureRequest(characterizationFixture, 100) }, options.timeoutMs)
    if (!response.value.data || typeof response.value.data !== 'object') throw new Error('characterization worker returned no data')
    validateMeasurementTree(response.value.data, 'characterization')
    artifact.characterization = { ...response.value.data, evidence: { ...response.value.data.evidence, 'E-08': { observation: 'historical-test-snapshot', observedPassed: 35, observedTotal: 35, baselineCommit: '1217e7c5241fcd3bc9a8aa1a6e759f6e16c78a95', evidence: 'Coordinator-verified pre-D2 snapshot; the C00 runner does not rerun these tests.' } }, externalDurationMs: response.externalDurationMs }
  } finally { await characterizationFixture.cleanup() }
  const qualityFixture = await createFixture({ count: 0 })
  sanitizationPaths.push(qualityFixture)
  try {
    process.stderr.write('[c00] quality 36 frozen cases\n')
    await prepareQualityFixture(qualityFixture)
    const qualityCases = labels.cases.map(({ sourcePath: _sourcePath, ...item }) => item)
    const response = await invokeWorker(worker, { operation: 'quality', fixture: fixtureRequest(qualityFixture, 0), qualityCases, labelDigest: QUALITY_DIGEST }, options.timeoutMs)
    validateMeasurementTree(response.value.data, 'quality')
    artifact.quality = { ...validateQuality(response.value.data, labels.cases, QUALITY_DIGEST), externalDurationMs: response.externalDurationMs }
  } finally { await qualityFixture.cleanup() }
  artifact.acceptance = acceptanceMatrix({ scenarios: artifact.scenarios, characterization: artifact.characterization, quality: artifact.quality, sizes: options.sizes })
  artifact.totalHarnessDurationMs = performance.now() - started
  let sanitized = artifact
  for (const paths of sanitizationPaths) sanitized = sanitize(sanitized, paths)
  return sanitize(sanitized)
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseOptions(argv)
    const artifact = await buildBaseline(options)
    const json = `${JSON.stringify(artifact, null, 2)}\n`
    if (options.output) { await mkdir(dirname(options.output), { recursive: true }); await writeFile(options.output, json) }
    else process.stdout.write(json)
    if (options.acceptance && artifact.acceptance.some(item => item.status !== 'passed')) process.exitCode = 1
  } catch (error) {
    process.stderr.write(`c00 baseline harness error: ${sanitize(error.message)}\n${usage}\n`)
    process.exitCode = 2
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null
if (invokedPath === import.meta.url) await main()
