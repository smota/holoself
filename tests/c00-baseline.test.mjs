import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { invokeWorker, nearestRank, parseOptions, sanitize, validateSample } from '../scripts/c00-baseline.mjs'

const SCRIPT = fileURLToPath(new URL('../scripts/c00-baseline.mjs', import.meta.url))
const run = args => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', shell: false, windowsHide: true, timeout: 180_000 })

test('C00 quick run records measured scenarios, observations, quality, and target gaps', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'holoself-c00-result-'))
  const output = join(directory, 'baseline.json')
  try {
    const result = run(['--sizes', '100', '--iterations', '1', '--output', output])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stderr, /context-cold/)
    assert.match(result.stderr, /quality 36 frozen cases/)
    const raw = await readFile(output, 'utf8')
    const artifact = JSON.parse(raw)
    assert.deepEqual(Object.keys(artifact.machine).sort(), ['arch', 'platform', 'runtime'])
    assert.deepEqual(artifact.scenarios.map(item => item.scenario), ['context-cold', 'context-disk-warm', 'mcp-memory-warm', 'manifest-warm', 'expand-warm', 'search-warm'])
    assert.equal(new Set(artifact.scenarios.map(item => item.sourceDigest)).size, 1)
    for (const scenario of artifact.scenarios) {
      assert.equal(scenario.iterations, 1)
      assert.equal(scenario.samples.length, 1)
      assert.equal(scenario.metrics.latencyMs.p50, scenario.samples[0].latencyMs)
      assert.equal(scenario.metrics.latencyMs.p95, scenario.samples[0].latencyMs)
      assert.ok(Number.isFinite(scenario.totalExternalDurationMs))
      assert.ok(Number.isFinite(scenario.metrics.cacheStorageBytes.max))
      assert.equal(scenario.samples[0].io.unsupported.length, 0)
    }
    assert.match(artifact.scenarios.find(item => item.scenario === 'mcp-memory-warm').operationScope, /one-handle context_get/)
    assert.deepEqual(Object.keys(artifact.characterization.evidence).sort(), ['E-01', 'E-02', 'E-03', 'E-04', 'E-05', 'E-06', 'E-07', 'E-08'])
    assert.equal(artifact.characterization.evidence['E-01'].reproduced, true)
    assert.equal(artifact.characterization.evidence['E-02'].reproduced, true)
    assert.equal(artifact.characterization.evidence['E-03'].reproduced, false)
    assert.equal(artifact.characterization.evidence['E-04'].reproduced, false)
    assert.equal(artifact.characterization.evidence['E-05'].reproduced, false)
    assert.equal(artifact.characterization.evidence['E-06'].reproduced, true)
    assert.equal(artifact.characterization.evidence['E-07'].reproduced, true)
    assert.equal(artifact.acceptance.find(item => item.id === 'V-03').status, 'passed')
    assert.equal(artifact.characterization.probes['V-07'].sourceRevocationBlocked, true)
    assert.equal(artifact.characterization.probes['V-08'].sameSizeMtimeContentChangeDetected, true)
    assert.equal(artifact.characterization.probes['V-08'].deleteInvalidated, true)
    assert.equal(artifact.characterization.probes['V-08'].renameInvalidated, true)
    assert.equal(artifact.characterization.envelopes.length, 3)
    assert.deepEqual(artifact.characterization.envelopes.map(item => item.budget), ['small', 'standard', 'deep'])
    assert.equal(artifact.quality.cases.length, 36)
    assert.equal(new Set(artifact.quality.cases.map(item => item.id)).size, 36)
    assert.equal(new Set(artifact.quality.cases.map(item => item.task)).size, 36)
    assert.ok(artifact.quality.cases.every(item => typeof item.requiredPresent === 'boolean' && typeof item.personalBodyReads === 'number'))
    assert.equal(artifact.acceptance.length, 12)
    assert.equal(artifact.acceptance.find(item => item.id === 'V-10').status, 'not-implemented')
    assert.ok(artifact.acceptance.some(item => item.status === 'failed'))
    assert.doesNotMatch(raw, /[A-Z]:[\\/]Users[\\/]|\/(?:Users|home)\/|samue|sk-proj-|Bearer\s+/i)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('C00 acceptance executes the same oracles and exits 1 for known gaps', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'holoself-c00-acceptance-'))
  const output = join(directory, 'acceptance.json')
  try {
    const result = run(['--sizes', '100', '--iterations', '1', '--output', output, '--acceptance'])
    assert.equal(result.status, 1, result.stderr)
    const artifact = JSON.parse(await readFile(output, 'utf8'))
    assert.equal(artifact.acceptance.length, 12)
    assert.ok(artifact.acceptance.every(item => ['passed', 'failed', 'partial', 'not-implemented'].includes(item.status)))
    assert.ok(artifact.acceptance.some(item => ['failed', 'partial', 'not-implemented'].includes(item.status)))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('C00 CLI rejects invalid input as a harness error with exit 2', () => {
  for (const args of [['--sizes', '100,wat'], ['--sizes', '100,100'], ['--iterations', '0'], ['--timeout', '999'], ['--output']]) {
    const result = run(args)
    assert.equal(result.status, 2, `${args.join(' ')}\n${result.stderr}`)
    assert.match(result.stderr, /c00 baseline harness error:/)
  }
})

test('nearest-rank percentiles use ceil rank and reject non-finite input', () => {
  assert.equal(nearestRank([9, 1, 7, 3], 0.5), 3)
  assert.equal(nearestRank([9, 1, 7, 3], 0.95), 9)
  assert.equal(nearestRank([5], 0.95), 5)
  assert.throws(() => nearestRank([1, Number.NaN], 0.5), /finite/)
  assert.throws(() => nearestRank([], 0.5), /at least one/)
})

test('option parsing keeps the contract defaults and validates bounds', () => {
  assert.deepEqual(parseOptions([]), { sizes: [100], iterations: 1, timeoutMs: 120_000, acceptance: false, output: null })
  assert.deepEqual(parseOptions(['--sizes', '100,1000,10000', '--iterations', '30', '--timeout-ms', '300000', '--acceptance']).sizes, [100, 1000, 10000])
  assert.throws(() => parseOptions(['--iterations', '31']), /1 to 30/)
  assert.throws(() => parseOptions(['--unknown']), /unknown option/)
})

test('worker transport uses stdin and rejects worker failures and malformed JSON', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'holoself-c00-worker-test-'))
  const worker = join(directory, 'worker.mjs')
  try {
    await writeFile(worker, `let input='';for await(const chunk of process.stdin)input+=chunk;const value=JSON.parse(input);if(value.mode==='bad'){process.stdout.write('not json')}else if(value.mode==='error'){process.stdout.write(JSON.stringify({ok:false,error:{message:'measured failure'}}));process.exitCode=2}else{process.stdout.write(JSON.stringify({ok:true,data:{length:input.length}}))}`)
    const large = 'x'.repeat(40_000)
    const response = await invokeWorker(worker, { mode: 'ok', large }, 5_000)
    assert.ok(response.value.data.length > 32_000)
    assert.ok(Number.isFinite(response.externalDurationMs))
    await assert.rejects(invokeWorker(worker, { mode: 'bad' }, 5_000), /invalid JSON/)
    await assert.rejects(invokeWorker(worker, { mode: 'error' }, 5_000), /measured failure/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('sample validation rejects unsupported IO and non-finite metrics', () => {
  const sample = {
    latencyMs: 1, payloadBytes: 2, wireBytes: 2, returnedChars: 2, estimatedTokensBody: null,
    estimatedTokensTotalHeuristic: 1, selectedCount: 0, cache: null, cacheStorageBytes: 0,
    io: { bodyReads: 0, bodyBytes: 0, syntheticReads: 0, syntheticBytes: 0, uniqueBodyFiles: 0, metadataOps: 0, selectedBodyReads: 0, nonselectedBodyReads: 0, byApi: {}, classification: {}, unsupported: [] }
  }
  assert.equal(validateSample(structuredClone(sample), 0).latencyMs, 1)
  const unsupported = structuredClone(sample); unsupported.io.unsupported.push({ api: 'readSync' })
  assert.throws(() => validateSample(unsupported, 0), /unsupported I\/O/)
  const invalid = structuredClone(sample); invalid.latencyMs = Infinity
  assert.throws(() => validateSample(invalid, 0), /finite non-negative/)
})

test('artifact sanitizer replaces fixture paths and credentials recursively', () => {
  const value = sanitize({ path: 'C:\\Users\\samue\\fixture\\self\\context\\x.md', authorization: 'Bearer secret', nested: ['sk-proj-abcdefghijklmnop'] }, {
    root: 'C:\\Users\\samue\\fixture', self: 'C:\\Users\\samue\\fixture\\self'
  })
  assert.equal(value.path, 'SELF\\context\\x.md')
  assert.equal(value.authorization, '[REDACTED]')
  assert.equal(value.nested[0], '[REDACTED_SECRET]')
})
