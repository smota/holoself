// C-00 observational worker: no product mutation; every write is synthetic fixture state.
import fs from 'node:fs'
import { performance } from 'node:perf_hooks'
import { createHash } from 'node:crypto'
import { join, relative, isAbsolute, sep, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { installIoMeter } from './c00-io.mjs'

let input = ''
for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 1_000_000) throw new Error('worker input exceeds limit') }
const request = JSON.parse(input)
const fixture = request.fixture
const within = (parent, path) => { const rel = relative(parent, path); return rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) }
const root = fs.realpathSync(fixture.root)
if (!within(fs.realpathSync(tmpdir()), root) || !root.split(/[\\/]/).at(-1).startsWith('holoself-c00-')) throw new Error('worker requires isolated C00 temporary fixture')
for (const field of ['self', 'project', 'peer']) if (!within(root, fs.realpathSync(fixture[field]))) throw new Error('fixture path escapes temporary root')
if (!Number.isInteger(fixture.count) || fixture.count < 0 || fixture.count > 10000) throw new Error('invalid fixture count')
const syntheticPaths = Array.from({ length: fixture.count }, (_, i) => join(fixture.self, 'context', `synthetic-${String(i).padStart(5, '0')}.md`))
const meter = installIoMeter({ roots: { self: fixture.self, project: fixture.project, peer: fixture.peer }, syntheticPaths })
const { run } = await import('../../src/cli.mjs')
const { createMcpSession } = await import('../../src/mcp-server.mjs')
const { cachedSelection, selectContextRecords, sourceId } = await import('../../src/context-selection.mjs')
const hash = x => createHash('sha256').update(x).digest('hex')
const byteLength = x => Buffer.byteLength(typeof x === 'string' ? x : JSON.stringify(x))
const task = 'career planning'
const docs = data => [...(data?.self?.documents || []), ...(data?.project?.documents || [])]
const content = data => docs(data).map(x => x.content).join('\n')
const metadata = access => `---\naccess_lenses: [${access.join(', ')}]\ndisclosure: internal-only\nsensitivity: personal\ndocument_role: content\n---\n`
const cacheDir = join(fixture.project, '.holoself', 'runtime', 'context-cache')
function clearCache() {
  if (!fs.existsSync(cacheDir)) return
  if (fs.lstatSync(cacheDir).isSymbolicLink() || !within(root, fs.realpathSync(cacheDir))) throw new Error('unsafe cache cleanup')
  fs.rmSync(cacheDir, { recursive: true })
}
function storageBytes(directory = cacheDir) {
  if (!fs.existsSync(directory)) return 0
  return fs.readdirSync(directory, { withFileTypes: true }).reduce((sum, entry) => {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error('unexpected cache symlink')
    return sum + (entry.isDirectory() ? storageBytes(path) : fs.statSync(path).size)
  }, 0)
}
async function cli(args) {
  const old = console.log; let stdout = ''
  console.log = (...items) => { stdout += `${items.join(' ')}\n` }
  try { await run(args) } finally { console.log = old }
  return { data: JSON.parse(stdout), payload: stdout, wire: stdout }
}
const contextArgs = (extra = []) => ['context', '--project', fixture.project, '--task', task, '--budget', 'small', ...extra, '--json']
function mcpSession() {
  let last, id = 0
  const accept = createMcpSession({ project: fixture.project, write: line => { last = line } })
  accept(JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'c00', version: '1' } } }))
  return (name, args = {}) => {
    accept(JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }))
    const wire = `${last}\n`, response = JSON.parse(last)
    if (!response.result) throw new Error('MCP protocol failure')
    return { data: response.result.structuredContent?.data, error: response.result.structuredContent?.error, payload: response.result, wire, isError: Boolean(response.result.isError) }
  }
}
function compactIo(io, data) {
  const selected = new Set([
    ...(data?.self?.documents || []).map(x => `self:${x.path}`),
    ...(data?.project?.documents || []).map(x => `project:${x.path}`),
    ...(data?.results || []).map(x => `${x.source_kind}:${x.source_file}`)
  ])
  const classification = {}; let selectedBodyReads = 0, nonselectedBodyReads = 0
  for (const entry of Object.values(io.byPath)) {
    const item = classification[entry.classification] ||= { reads: 0, bytes: 0, files: 0 }
    item.reads += entry.reads; item.bytes += entry.bytes; item.files++
    if (entry.bodyReads) {
      const kind = entry.classification === 'synthetic' ? 'self' : entry.classification.replace('-body', '')
      if (selected.has(`${kind}:${entry.path}`)) selectedBodyReads += entry.bodyReads
      else nonselectedBodyReads += entry.bodyReads
    }
  }
  const { byPath, ...rest } = io
  return { ...rest, classification, selectedBodyReads, nonselectedBodyReads, internalPhase: 'unavailable: boundary metrics only' }
}
async function measure(operation, allowedProductError = null) {
  meter.start(); const start = performance.now(); let value, io, latencyMs
  try { value = await operation(); latencyMs = performance.now() - start } finally { io = meter.stop() }
  if (io.unsupported.length) throw new Error(`unsupported measured IO: ${JSON.stringify(io.unsupported)}`)
  if (value.isError && value.error?.code !== allowedProductError) throw new Error(`unexpected MCP error ${value.error?.code}`)
  const payloadBytes = byteLength(value.payload)
  return { ...(value.isError ? { outcome: 'product-error', errorCode: value.error.code } : {}), latencyMs, payloadBytes, wireBytes: byteLength(value.wire), returnedChars: typeof value.payload === 'string' ? value.payload.length : JSON.stringify(value.payload).length, estimatedTokensBody: value.data?.selection?.estimated_tokens ?? null, estimatedTokensTotalHeuristic: Math.ceil((typeof value.payload === 'string' ? value.payload.length : JSON.stringify(value.payload).length) / 4), selectedCount: value.data?.selection?.selected_count ?? value.data?.results?.length ?? null, cache: value.data?.context_receipt?.cache ? { hit: value.data.context_receipt.cache.hit, persistent: Boolean(value.data.context_receipt.cache.persistent) } : null, io: compactIo(io, value.data), cacheStorageBytes: storageBytes() }
}
async function benchmark() {
  const n = request.iterations || 1
  if (!Number.isInteger(n) || n < 1 || n > 30) throw new Error('invalid iterations')
  let operation, allowedProductError = null
  switch (request.scenario) {
    case 'context-cold':
      if (n !== 1) throw new Error('cold samples require a new process each time')
      clearCache(); operation = () => cli(contextArgs()); break
    case 'context-disk-warm':
      if (n !== 1 || !fs.existsSync(cacheDir)) throw new Error('disk-warm needs prior persistent priming and one sample per process')
      operation = () => cli(contextArgs()); break
    case 'mcp-memory-warm': {
      clearCache(); const call = mcpSession()
      const manifest = call('holoself_context_manifest', { task, budget: 'small' })
      if (manifest.isError) {
        if (manifest.error?.code !== 'RESULT_TOO_LARGE') throw new Error(`unexpected MCP manifest priming error ${manifest.error?.code}`)
        allowedProductError = 'RESULT_TOO_LARGE'
        operation = () => {
          const response = call('holoself_context_manifest', { task, budget: 'small' })
          if (!response.isError || response.error?.code !== allowedProductError) throw new Error('MCP product-error state changed during immutable benchmark')
          return response
        }
        break
      }
      const source = manifest.data?.sources.find(x => x.path === 'context/synthetic-00000.md') || manifest.data?.sources[0]
      if (!source) throw new Error('no MCP expansion handle')
      operation = () => call('holoself_context_get', { task, budget: 'small', source_ids: [source.source_id] })
      const prime = operation(); if (prime.isError) throw new Error('MCP priming failed'); break
    }
    case 'manifest-warm': operation = () => cli(contextArgs(['--manifest'])); await operation(); break
    case 'expand-warm': {
      const manifest = await cli(contextArgs(['--manifest']))
      const source = manifest.data.sources.find(x => x.path === 'context/synthetic-00000.md') || manifest.data.sources[0]
      if (!source) throw new Error('no expansion handle')
      operation = () => cli(contextArgs(['--source', source.source_id])); await operation(); break
    }
    case 'search-warm':
      await cli(['index', 'rebuild', '--project', fixture.project]); operation = () => cli(['search', task, '--project', fixture.project]); await operation(); break
    default: throw new Error('unknown benchmark scenario')
  }
  const samples = []
  for (let i = 0; i < n; i++) samples.push(await measure(operation, allowedProductError))
  return { ok: true, samples }
}
async function quality() {
  const cases = request.qualityCases
  if (!Array.isArray(cases) || cases.length !== 36) throw new Error('expected all 36 frozen quality cases')
  const rows = []
  for (const item of cases) {
    let response
    const sample = await measure(async () => {
      response = await cli(['context', '--project', fixture.project, '--task', item.task, '--lens', item.lens, '--budget', item.budget, '--json'])
      return response
    })
    const text = content(response.data)
    const requiredPresent = item.requiredMarkers.every(marker => text.includes(marker))
    const forbiddenAbsent = item.forbiddenMarkers.every(marker => !text.includes(marker))
    const need = response.data.selection.context_need, needMatches = item.expectedNeed.includes(need)
    const personalBodyChars = (response.data.self?.documents || []).reduce((sum, doc) => sum + doc.content.length, 0)
    const mechanicalEmpty = item.class !== 'mechanical' || (sample.io.bodyReads === 0 && personalBodyChars === 0)
    rows.push({ id: item.id, class: item.class, language: item.language, task: item.task, requiredPresent, forbiddenAbsent, needMatches, personalBodyReads: sample.io.bodyReads, personalBodyChars, need, selectedCount: sample.selectedCount, status: requiredPresent && forbiddenAbsent && needMatches && mechanicalEmpty ? 'passed' : 'failed', measurements: sample })
  }
  return { ok: true, data: { cases: rows, labelDigest: request.labelDigest } }
}
async function characterize() {
  const E = {}; const call = mcpSession()
  clearCache()
  const cold = await measure(() => cli(contextArgs())), warm = await measure(() => cli(contextArgs()))
  const manifestSample = await measure(() => cli(contextArgs(['--manifest'])))
  const manifest = await cli(contextArgs(['--manifest']))
  const source = manifest.data.sources.find(x => x.path === 'context/synthetic-00000.md') || manifest.data.sources[0]
  if (!source) throw new Error('characterization requires scale sources')
  const expand = await measure(() => cli(contextArgs(['--source', source.source_id])))
  E['E-01'] = { reproduced: [cold, warm, manifestSample, expand].every(x => x.io.syntheticReads === fixture.count) && warm.cache.hit, count: fixture.count, cold, warm, manifest: manifestSample, expand }
  await cli(['index', 'rebuild', '--project', fixture.project])
  const search = await measure(() => cli(['search', task, '--project', fixture.project]))
  E['E-02'] = { reproduced: search.io.syntheticReads >= fixture.count, search }
  E['E-03'] = { reproduced: manifestSample.payloadBytes > 16384 && manifestSample.estimatedTokensBody === 0 && manifestSample.selectedCount > 10, bytes: manifestSample.payloadBytes, estimatedTokensBody: manifestSample.estimatedTokensBody, entries: manifestSample.selectedCount }
  let privateCli = null
  try { privateCli = await cli(['context', '--project', fixture.project, '--lens', 'private', '--manifest', '--json']) } catch (err) { privateCli = { data: null, error: err } }
  const privateMcp = call('holoself_context_manifest', { lens: 'private' })
  E['E-04'] = { reproduced: privateCli.data?.lens === 'private' && privateMcp.error?.code === 'LENS_NOT_GRANTED', cliLens: privateCli.data?.lens ?? null, cliErrorCode: privateCli.error?.code ?? null, mcpErrorCode: privateMcp.error?.code ?? null }
  const mechanical = await cli(['context', '--project', fixture.project, '--task', 'format this JSON', '--budget', 'small', '--json'])
  E['E-07'] = { reproduced: mechanical.data.selection.context_need === 'not-needed' && content(mechanical.data).length > 0, need: mechanical.data.selection.context_need, bodyChars: content(mechanical.data).length }
  const envelopes = []
  for (const budget of ['small', 'standard', 'deep']) {
    const normal = await cli(['context', '--project', fixture.project, '--task', task, '--budget', budget, '--manifest', '--json'])
    const remote = call('holoself_context_manifest', { task, budget })
    const error = call('holoself_context_manifest', { lens: 'private', budget })
    envelopes.push({ budget, limit: { small: 16384, standard: 49152, deep: 131072 }[budget], cliPayloadBytes: byteLength(normal.payload), mcpPayloadBytes: byteLength(remote.payload), mcpWireBytes: byteLength(remote.wire), mcpErrorPayloadBytes: byteLength(error.payload), mcpErrorWireBytes: byteLength(error.wire), mcpErrorCode: error.error?.code ?? null, cliManifestEntries: normal.data.sources.length, mcpManifestEntries: remote.data?.sources?.length ?? null, mcpManifestError: remote.error?.code ?? null })
  }
  // Registration in the existing UI catalog makes the isolated search gap explicit.
  fs.mkdirSync(join(fixture.self, 'ui'), { recursive: true })
  fs.writeFileSync(join(fixture.self, 'ui', 'catalog.json'), JSON.stringify({ schemaVersion: 1, spaces: [{ id: 'c00-consumer', path: fixture.project }, { id: 'c00-peer', path: fixture.peer }] }))
  fs.writeFileSync(join(fixture.peer, 'C00-PEER-EXCLUSIVE.md'), metadata(['general']) + '# Peer evidence\nC00_PEER_EXCLUSIVE\n')
  const ownPeer = await cli(['search', 'C00_PEER_EXCLUSIVE', '--project', fixture.peer, '--federated'])
  const consumer = await cli(['search', 'C00_PEER_EXCLUSIVE', '--project', fixture.project, '--federated'])
  E['E-06'] = { reproduced: ownPeer.data.results.length > 0 && consumer.data.results.length === 0, ownPeerHits: ownPeer.data.results.length, consumerHits: consumer.data.results.length, registry: 'existing synthetic UI catalog; not future federation registry' }
  const path = syntheticPaths[0], original = fs.readFileSync(path, 'utf8'), stat = fs.statSync(path), syntheticSourceId = sourceId({ kind: 'self', path: 'context/synthetic-00000.md' })
  call('holoself_context_get', { task, source_ids: [syntheticSourceId] })
  fs.writeFileSync(path, original.replace('access_lenses: [general, private]', 'access_lenses: [private]'))
  const revoked = call('holoself_context_get', { task, source_ids: [syntheticSourceId] })
  fs.writeFileSync(path, original); fs.utimesSync(path, stat.atime, stat.mtime)
  const before = call('holoself_context_get', { task, source_ids: [syntheticSourceId] })
  const changed = original.replace('C00_SCALE_00000', 'C00_SCALE_99999')
  if (byteLength(changed) !== byteLength(original)) throw new Error('same-size probe invalid')
  fs.writeFileSync(path, changed); fs.utimesSync(path, stat.atime, stat.mtime)
  const after = call('holoself_context_get', { task, source_ids: [syntheticSourceId] })
  const sameStatDetected = content(after.data).includes('C00_SCALE_99999') && before.data.sources[0].source_hash !== after.data.sources[0].source_hash
  fs.unlinkSync(path)
  const deleted = call('holoself_context_get', { task, source_ids: [syntheticSourceId] })
  fs.writeFileSync(path, original)
  const renamedPath = join(fixture.self, 'context', 'renamed-c00.md'); fs.renameSync(path, renamedPath)
  const renamed = call('holoself_context_get', { task, source_ids: [syntheticSourceId] })
  fs.renameSync(renamedPath, path); fs.utimesSync(path, stat.atime, stat.mtime)
  const records = [{ kind: 'self', path: 'context/c00-clock.md', content: 'career evidence C00_CLOCK', source_hash: hash('C00_CLOCK'), metadata: { valid_until: '2030-01-01T00:00:00Z' }, document_role: 'content' }]
  const clockBefore = { task: 'career clock probe', budget: 'small', now: '2029-12-31T23:59:59Z' }, clockAfter = { ...clockBefore, now: '2030-01-01T00:00:01Z' }
  const cachedBefore = cachedSelection(records, clockBefore), cachedAfter = cachedSelection(records, clockAfter), uncachedAfter = selectContextRecords(records, clockAfter)
  const probes = {
    'V-07': { sourceRevocationBlocked: revoked.isError && !content(revoked.data).includes('C00_SCALE_00000'), errorCode: revoked.error?.code, concurrentCatalog: 'not-implemented' },
    'V-08': { sameSizeMtimeContentChangeDetected: sameStatDetected, deleteInvalidated: deleted.isError, renameInvalidated: renamed.isError, temporalLayer: 'selection/cache unit with explicit now; not full interface clock test', beforeCount: cachedBefore.records.length, cachedAfterCount: cachedAfter.records.length, uncachedAfterCount: uncachedAfter.records.length, expiryCacheHit: cachedAfter.cache.hit, expiryStale: cachedAfter.records.length > uncachedAfter.records.length }
  }
  // Authorized custom lens isolates optional-method composition rather than grant denial.
  const oldLog = console.log; console.log = () => {}
  try { await run(['link', 'add', '--project', fixture.project, '--self', fixture.self, '--lens', 'spiritual', '--no-activate', '--force', '--yes']) } finally { console.log = oldLog }
  fs.writeFileSync(join(fixture.self, 'context', 'c00-spiritual.md'), metadata(['spiritual']) + '# Synthetic reflection\nC00_SPIRITUAL\n')
  let methodError = null
  try { await cli(['context', '--project', fixture.project, '--task', 'reflection', '--budget', 'small', '--json']) } catch (error) { methodError = error.message }
  E['E-05'] = { reproduced: Boolean(methodError?.includes('context leakage validation failed') && methodError.includes('contrib:')), error: methodError }
  return { ok: true, data: { evidence: E, probes, envelopes } }
}
try {
  let response
  if (request.operation === 'benchmark') response = await benchmark()
  else if (request.operation === 'prepare-disk') { await cli(contextArgs()); response = { ok: true, data: { prepared: true } } }
  else if (request.operation === 'quality') response = await quality()
  else if (request.operation === 'characterize') response = await characterize()
  else throw new Error('unknown worker operation')
  process.stdout.write(JSON.stringify(response) + '\n')
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: { message: String(error.message).replaceAll(root, '<FIXTURE>') } }) + '\n')
  process.exitCode = 2
} finally { meter.restore() }
