// Non-blocking MCP server (#62): tool calls run on a bounded worker pool while protocol messages, cancellation and
// timeouts are handled on the main thread. Slow work is simulated with the worker's test-only busy-time seam
// (createMcpToolPool({ simulateWorkMs })) except in the spawned test, which uses a large synthetic self root.
import './helpers/isolated-config.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, link as hardlink, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from '../src/cli.mjs'
import { createMcpSession, createMcpToolPool, finishAtEof, mcpServerLimits, SERVER_BUSY_RPC_CODE, TOOL_TIMEOUT_RPC_CODE } from '../src/mcp-server.mjs'

const bin = fileURLToPath(new URL('../bin/holoself.mjs', import.meta.url))
const sleep = ms => new Promise(done => setTimeout(done, ms))

async function quiet(fn) {
  const old = console.log
  console.log = () => {}
  try {
    return await fn()
  } finally {
    console.log = old
  }
}
async function fixture({ docs = 0 } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'holoself-mcp-async-')),
    self = join(base, 'self'),
    project = join(base, 'project')
  await mkdir(join(project, 'Context'), { recursive: true })
  await quiet(() => run(['init', '--root', self]))
  await writeFile(join(self, 'profile', 'identity.md'), '---\naccess_lenses: [general, professional]\ndisclosure: internal-only\nsensitivity: personal\ndocument_role: content\n---\n# Identity\n\nAsync parity marker about refactoring.\n')
  const body = Array.from({ length: 200 }, (_, i) => `Line ${i} about refactoring architecture and delivery notes ${i % 17}.`).join('\n')
  for (let i = 0; i < docs; i++)
    await writeFile(join(self, 'context', `bulk-${i}.md`), `---\naccess_lenses: [general, professional]\ndisclosure: internal-only\nsensitivity: personal\ndocument_role: content\n---\n# Bulk ${i}\n\n${body}\n`)
  await writeFile(join(project, 'Context', 'evidence.md'), '# Evidence\n\nProject-bound marker.\n')
  await quiet(() => run(['link', 'add', '--project', project, '--self', self, '--lens', 'professional', '--no-activate', '--yes']))
  return { base, self, project }
}
function pooled(project, poolOptions = {}, sessionOptions = {}) {
  const pool = createMcpToolPool({ size: 2, ...poolOptions }),
    lines = [],
    output = []
  const accept = createMcpSession({
    project,
    pool,
    auditLog: undefined,
    ...sessionOptions,
    write: line => {
      lines.push(line)
      output.push(JSON.parse(line))
    }
  })
  const send = (id, method, params) => accept(JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params }))
  send(1, 'initialize', { protocolVersion: '2025-11-25' })
  const call = (id, name, args = {}) => send(id, 'tools/call', { name, arguments: args })
  const cancel = requestId => send(undefined, 'notifications/cancelled', { requestId, reason: 'test' })
  const byId = id => output.find(item => item.id === id)
  // Accessors that fail with the full response (or its absence) in the message, so CI logs show what came back.
  const show = id => `response ${JSON.stringify(id)}: ${JSON.stringify(byId(id)) ?? '<none>'}`.slice(0, 2000)
  const data = id => {
    const response = byId(id)
    assert.ok(response?.result?.structuredContent?.data, `expected a tool result; ${show(id)}`)
    return response.result.structuredContent.data
  }
  const errorOf = id => {
    const response = byId(id)
    assert.ok(response?.error, `expected a JSON-RPC error; ${show(id)}`)
    return response.error
  }
  return { pool, accept, lines, output, send, call, cancel, byId, show, data, errorOf, close: () => pool.close() }
}
async function until(predicate, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > end) throw new Error('condition not reached in time')
    await sleep(5)
  }
}

test('server limits default to 60 s and two workers and ignore invalid overrides', () => {
  const defaults = { timeoutMs: 60000, concurrency: 2, maxPending: 256, workerHeapMb: 512, writeTimeoutMs: 600000 }
  assert.deepEqual(mcpServerLimits({}), defaults)
  assert.deepEqual(
    mcpServerLimits({ HOLOSELF_MCP_TOOL_TIMEOUT_MS: '5000', HOLOSELF_MCP_CONCURRENCY: '3', HOLOSELF_MCP_MAX_PENDING: '32', HOLOSELF_MCP_WORKER_HEAP_MB: '1024', HOLOSELF_MCP_WRITE_TIMEOUT_MS: '1500' }),
    { timeoutMs: 5000, concurrency: 3, maxPending: 32, workerHeapMb: 1024, writeTimeoutMs: 1500 }
  )
  assert.deepEqual(mcpServerLimits({ HOLOSELF_MCP_TOOL_TIMEOUT_MS: 'soon', HOLOSELF_MCP_CONCURRENCY: '99', HOLOSELF_MCP_MAX_PENDING: '0', HOLOSELF_MCP_WORKER_HEAP_MB: '1', HOLOSELF_MCP_WRITE_TIMEOUT_MS: '-5' }), defaults)
})

test('spawned server answers ping within 100 ms while a large context call runs, then drains at EOF', { timeout: 120000 }, async () => {
  const { base, project } = await fixture({ docs: 2000 })
  try {
    const child = spawn(process.execPath, [bin, 'mcp', '--project', project], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let stdout = '',
      stderr = ''
    const seen = new Map()
    child.stdout.on('data', chunk => {
      stdout += chunk
      for (const line of stdout.split('\n').slice(0, -1)) {
        const message = JSON.parse(line)
        if (!seen.has(message.id)) seen.set(message.id, { at: performance.now(), message })
      }
    })
    child.stderr.on('data', chunk => (stderr += chunk))
    const exited = new Promise(done => child.on('close', code => done(code)))
    const send = message => child.stdin.write(`${JSON.stringify(message)}\n`)
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } })
    await until(() => seen.has(1))
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'holoself_context', arguments: { task: 'refactoring architecture delivery', budget: 'deep' } } })
    await sleep(30)
    const pingSent = performance.now()
    send({ jsonrpc: '2.0', id: 3, method: 'ping' })
    await until(() => seen.has(3))
    const pingMs = seen.get(3).at - pingSent
    assert.ok(pingMs < 100, `ping took ${pingMs.toFixed(1)} ms`)
    assert.equal(seen.has(2), false, 'the context call should still be running when ping is answered')
    assert.deepEqual(seen.get(3).message.result, {})
    child.stdin.end()
    assert.equal(await exited, 0)
    assert.equal(stderr, '')
    const lines = stdout.trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(lines.map(line => line.id), [1, 3, 2])
    assert.equal(lines[2].result.structuredContent.data.status, 'complete')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('out-of-order completion maps each response to its request id', { timeout: 60000 }, async () => {
  const { base, project } = await fixture()
  const m = pooled(project, { simulateWorkMs: { holoself_context: 2500 } })
  try {
    m.call(2, 'holoself_context', { task: 'refactoring marker', budget: 'small' })
    m.call(3, 'holoself_status')
    m.send(4, 'ping', {})
    assert.deepEqual(m.byId(4)?.result, {}, `ping is answered synchronously; ${m.show(4)}`)
    await m.accept.drain()
    assert.deepEqual(m.output.map(item => item.id), [1, 4, 3, 2])
    assert.equal(m.data(3).project.linked, true)
    assert.equal(m.data(2).status, 'complete')
  } finally {
    await m.close()
    await rm(base, { recursive: true, force: true })
  }
})

test('pooled results match inline results byte for byte (packet id and time masked) and keep cache hits', { timeout: 60000 }, async () => {
  const { base, project } = await fixture()
  const inlineLines = [],
    inline = createMcpSession({ project, write: line => inlineLines.push(line) })
  const m = pooled(project)
  try {
    inline(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }))
    // Warm the on-disk catalog first so both sides report the same catalog_reads.
    inline(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/call', params: { name: 'holoself_context_manifest', arguments: { budget: 'small' } } }))
    inlineLines.pop()
    const calls = [
      [2, 'holoself_context', { task: 'refactoring marker', budget: 'small' }],
      [3, 'holoself_context', { budget: 'small', task: 'refactoring marker' }],
      [4, 'holoself_search', { query: 'marker' }],
      [5, 'holoself_context_get', { source_ids: ['hs-doesnotexist'] }]
    ]
    for (const [id, name, args] of calls) {
      inline(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }))
      m.call(id, name, args)
      await m.accept.drain()
    }
    const scrubTime = line => line.replace(/"(generated_at|packet_id)":"[^"]*"/g, '"$1":"<volatile>"')
    assert.deepEqual(m.lines.map(scrubTime), inlineLines.map(scrubTime))
    assert.equal(m.data(2).context_receipt.cache.hit, false)
    assert.equal(m.data(3).context_receipt.cache.hit, true, 'the repeat call is routed to the worker that cached it')
  } finally {
    await m.close()
    await rm(base, { recursive: true, force: true })
  }
})

test('cancelling a queued call and a running call sends no response and the next call works', { timeout: 60000 }, async () => {
  const { base, project } = await fixture()
  const m = pooled(project, { size: 1, simulateWorkMs: { holoself_context: 800 } })
  try {
    m.call(2, 'holoself_context', { task: 'refactoring marker', budget: 'small' })
    m.call(3, 'holoself_search', { query: 'marker' })
    assert.deepEqual(m.pool.stats(), { running: 1, queued: 1, workers: 1, spawned: 1 })
    m.cancel(3)
    assert.equal(m.pool.stats().queued, 0)
    await m.accept.drain()
    assert.deepEqual(m.output.map(item => item.id), [1, 2])

    m.call(4, 'holoself_context', { task: 'another refactoring marker', budget: 'small' })
    await sleep(100)
    m.cancel(4)
    assert.deepEqual(m.pool.stats(), { running: 0, queued: 0, workers: 0, spawned: 1 }, 'the running worker is terminated')
    await m.accept.drain()
    await sleep(900)
    assert.equal(m.byId(4), undefined, 'a cancelled call never produces a partial or late packet')
    m.call(5, 'holoself_status')
    await m.accept.drain()
    assert.equal(m.data(5).project.linked, true)
    m.cancel(5)
    m.cancel('unknown')
    assert.equal(m.output.length, 3)
  } finally {
    await m.close()
    await rm(base, { recursive: true, force: true })
  }
})

test('a call that exceeds the timeout returns a stable JSON-RPC error and the worker is recycled', { timeout: 60000 }, async () => {
  const { base, project } = await fixture(),
    dir = await mkdtemp(join(tmpdir(), 'holoself-mcp-audit-')),
    log = join(dir, 'audit.ndjson')
  // The timeout covers a call from dispatch, including a fresh worker's start-up, so the follow-up status call on a
  // replacement worker gets a generous timeout on slow CI hosts while the slow context call times out quickly.
  const m = pooled(project, { size: 1, timeoutMs: { holoself_context: 500, holoself_status: 30000 }, simulateWorkMs: { holoself_context: 20000 } }, { auditLog: log })
  try {
    m.call(2, 'holoself_context', { task: 'refactoring marker', budget: 'small' })
    m.call(3, 'holoself_status')
    await m.accept.drain()
    assert.deepEqual(m.output.map(item => item.id), [1, 2, 3])
    assert.deepEqual(m.errorOf(2), { code: TOOL_TIMEOUT_RPC_CODE, message: 'Tool call timed out', data: { code: 'TOOL_TIMEOUT' } })
    assert.equal(m.byId(2).result, undefined, m.show(2))
    assert.equal(m.data(3).project.linked, true, 'the queued call runs on a fresh worker')
    assert.equal(m.pool.stats().spawned, 2, 'the timed-out worker was recycled and replaced')
    const audit = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(audit.map(({ at, ...rest }) => rest), [
      { event: 'tools/call', tool: 'holoself_context', ok: false, error_code: 'TOOL_TIMEOUT' },
      { event: 'tools/call', tool: 'holoself_status', ok: true, error_code: null }
    ])
  } finally {
    await m.close()
    await rm(base, { recursive: true, force: true })
    await rm(dir, { recursive: true, force: true })
  }
})

test('stdout framing stays one complete JSON object per line under concurrency', { timeout: 60000 }, async () => {
  const { base, project } = await fixture()
  const m = pooled(project, { simulateWorkMs: { holoself_search: 50 } })
  try {
    const expected = [1]
    for (let id = 2; id < 22; id++) {
      if (id % 4 === 0) m.send(id, 'ping', {})
      else if (id % 4 === 1) m.call(id, 'holoself_search', { query: `marker ${id}` })
      else if (id % 4 === 2) m.call(id, 'holoself_context_manifest', { task: `refactoring ${id}`, budget: 'small' })
      else m.call(id, 'holoself_context_get', { source_ids: ['../../escape'] })
      expected.push(id)
    }
    m.send(99, 'tools/list', {})
    expected.push(99)
    await m.accept.drain()
    assert.ok(m.lines.every(line => !line.includes('\n') && JSON.parse(line).jsonrpc === '2.0'))
    assert.deepEqual(m.output.map(item => item.id).sort((a, b) => a - b), expected)
    for (const item of m.output.filter(item => item.id % 4 === 3 && item.id !== 99)) assert.equal(item.result.structuredContent.error.code, 'INVALID_ARGUMENT')
    for (const item of m.output.filter(item => item.id % 4 === 1 && item.id > 1)) assert.equal(item.result.structuredContent.data.query, `marker ${item.id}`)
  } finally {
    await m.close()
    await rm(base, { recursive: true, force: true })
  }
})

test('proposal_create runs alone and a duplicate in-flight id is rejected', { timeout: 60000 }, async () => {
  const { base, project } = await fixture()
  const m = pooled(project, { simulateWorkMs: { holoself_context: 400, holoself_proposal_create: 200 } })
  try {
    m.call(2, 'holoself_context', { task: 'refactoring marker', budget: 'small' })
    m.call(3, 'holoself_proposal_create', { claim: 'Review the marker.', source_files: ['Context/evidence.md'] })
    m.call(4, 'holoself_status')
    assert.deepEqual(m.pool.stats(), { running: 1, queued: 2, workers: 1, spawned: 1 }, 'the writer waits and later calls do not overtake it')
    m.call(2, 'holoself_status')
    assert.equal(m.output.at(-1).id, 2)
    assert.equal(m.output.at(-1).error.code, -32600)
    await until(() => m.byId(3))
    assert.equal(m.data(3).status, 'pending')
    await m.accept.drain()
    assert.deepEqual(m.output.filter(item => item.result).map(item => item.id), [1, 2, 3, 4])
  } finally {
    await m.close()
    await rm(base, { recursive: true, force: true })
  }
})

test('a cancelled proposal_create finishes its write, sends no response, is audited as committed and keeps its worker', { timeout: 60000 }, async () => {
  const { base, project } = await fixture(),
    log = join(base, 'audit.ndjson')
  const m = pooled(project, { size: 1, simulateWorkMs: { holoself_proposal_create: 600 } }, { auditLog: log })
  try {
    m.call(2, 'holoself_proposal_create', { claim: 'Cancelled but complete.', source_files: ['Context/evidence.md'] })
    await sleep(100)
    m.cancel(2)
    assert.equal(m.pool.stats().running, 1, 'the write is not terminated')
    await m.accept.drain()
    assert.equal(m.byId(2), undefined)
    const dir = join(project, '.holoself', 'proposals'),
      files = await readdir(dir)
    assert.equal(files.filter(name => name.endsWith('.yaml')).length, 1, 'the proposal was written completely')
    assert.equal(files.filter(name => name.includes('.tmp-')).length, 0, 'no temporary file is left behind')
    m.call(3, 'holoself_status')
    await m.accept.drain()
    assert.equal(m.data(3).pending_proposals, 1)
    assert.equal(m.pool.stats().spawned, 1, 'the worker was never recycled')
    const audit = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(audit.map(({ at, ...rest }) => rest)[0], { event: 'tools/call', tool: 'holoself_proposal_create', ok: true, cancelled: true, error_code: null })
  } finally {
    await m.close()
    await rm(base, { recursive: true, force: true })
  }
})

test('proposal_create is exempt from the read-tool timeout and returns its real result', { timeout: 60000 }, async () => {
  const { base, project } = await fixture()
  const m = pooled(project, { size: 1, timeoutMs: 200, simulateWorkMs: { holoself_proposal_create: 700 } })
  try {
    m.call(2, 'holoself_proposal_create', { claim: 'Slow but complete.', source_files: ['Context/evidence.md'] })
    await m.accept.drain()
    assert.equal(m.byId(2).error, undefined, m.show(2))
    assert.equal(m.data(2).status, 'pending')
  } finally {
    await m.close()
    await rm(base, { recursive: true, force: true })
  }
})

test('a write past its write timeout is answered with TOOL_TIMEOUT but keeps the barrier until it finishes', { timeout: 60000 }, async () => {
  const { base, project } = await fixture()
  // The read timeout is generous on purpose: it starts when a call is dispatched (queue time never counts), so the
  // status call below only has to finish its own work, which is slow on some filesystems (Windows CI).
  const m = pooled(project, { size: 2, timeoutMs: 30000, writeTimeoutMs: 250, simulateWorkMs: { holoself_proposal_create: 1500 } })
  try {
    m.call(2, 'holoself_proposal_create', { claim: 'Slow write.', source_files: ['Context/evidence.md'] })
    m.call(3, 'holoself_status')
    await until(() => m.byId(2))
    assert.deepEqual(m.errorOf(2), { code: TOOL_TIMEOUT_RPC_CODE, message: 'Tool call timed out', data: { code: 'TOOL_TIMEOUT' } })
    assert.equal(m.byId(3), undefined, `the queued call still waits behind the running write; ${m.show(3)}`)
    assert.deepEqual(m.pool.stats(), { running: 1, queued: 1, workers: 1, spawned: 1 })
    await m.accept.drain()
    assert.deepEqual(m.output.map(item => item.id), [1, 2, 3], 'timeout answer first, then the queued call')
    assert.equal(m.data(3).pending_proposals, 1, 'the write completed before the next call ran')
    assert.equal(m.pool.stats().spawned, 1, 'the write was never terminated')
  } finally {
    await m.close()
    await rm(base, { recursive: true, force: true })
  }
})

test('EOF shutdown is bounded when a write is stuck: queued calls are dropped and workers stopped', { timeout: 60000 }, async () => {
  const { base, project } = await fixture()
  const m = pooled(project, { size: 1, writeTimeoutMs: 200, simulateWorkMs: { holoself_proposal_create: 30000 } })
  try {
    m.call(2, 'holoself_proposal_create', { claim: 'Stuck write.', source_files: ['Context/evidence.md'] })
    m.call(3, 'holoself_status')
    const started = Date.now()
    await finishAtEof(m.accept, m.pool, 400)
    assert.ok(Date.now() - started < 5000, `shutdown took ${Date.now() - started} ms`)
    await sleep(20)
    assert.equal(m.errorOf(2).data.code, 'TOOL_TIMEOUT')
    assert.equal(m.byId(3), undefined)
    assert.equal(m.accept.inFlight(), 0)
    assert.deepEqual(m.pool.stats(), { running: 0, queued: 0, workers: 0, spawned: 1 })
  } finally {
    await m.close()
    await rm(base, { recursive: true, force: true })
  }
})

test('a burst of cancellations spawns no worker per message', { timeout: 60000 }, async () => {
  const { base, project } = await fixture()
  const m = pooled(project, { simulateWorkMs: { holoself_search: 300 } }, { maxPending: 1000 })
  try {
    for (let id = 2; id < 202; id++) m.call(id, 'holoself_search', { query: `burst ${id}` })
    for (let id = 2; id < 202; id++) m.cancel(id)
    await m.accept.drain()
    await sleep(50)
    assert.deepEqual(m.pool.stats(), { running: 0, queued: 0, workers: 0, spawned: 2 })
    assert.deepEqual(m.output.map(item => item.id), [1])
    m.call(300, 'holoself_status')
    await m.accept.drain()
    assert.equal(m.data(300).project.linked, true)
    assert.equal(m.pool.stats().spawned, 3)
  } finally {
    await m.close()
    await rm(base, { recursive: true, force: true })
  }
})

test('spawned server exits promptly after a burst of calls and cancellations', { timeout: 60000 }, async () => {
  const { base, project } = await fixture()
  try {
    const lines = [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }]
    for (let id = 2; id < 202; id++) lines.push({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'holoself_search', arguments: { query: `burst ${id}` } } })
    for (let id = 2; id < 202; id++) lines.push({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } })
    const started = Date.now()
    const child = spawn(process.execPath, [bin, 'mcp', '--project', project], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let stdout = '',
      stderr = ''
    child.stdout.on('data', chunk => (stdout += chunk))
    child.stderr.on('data', chunk => (stderr += chunk))
    const exited = new Promise(done => child.on('close', code => done(code)))
    child.stdin.end(lines.map(line => JSON.stringify(line)).join('\n') + '\n')
    assert.equal(await exited, 0)
    assert.ok(Date.now() - started < 20000, `exit took ${Date.now() - started} ms`)
    assert.equal(stderr, '')
    const out = stdout.trim().split('\n').map(line => JSON.parse(line))
    assert.equal(out[0].id, 1)
    assert.ok(out.every(line => line.jsonrpc === '2.0' && (line.id === 1 || line.result?.structuredContent)))
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('calls beyond the pending limit are refused with SERVER_BUSY', { timeout: 60000 }, async () => {
  const { base, project } = await fixture()
  const m = pooled(project, { size: 1, simulateWorkMs: { holoself_search: 300 } }, { maxPending: 3 })
  try {
    for (let id = 2; id < 7; id++) m.call(id, 'holoself_search', { query: `busy ${id}` })
    for (const id of [5, 6]) assert.deepEqual(m.errorOf(id), { code: SERVER_BUSY_RPC_CODE, message: 'Server busy', data: { code: 'SERVER_BUSY' } })
    await m.accept.drain()
    for (const id of [2, 3, 4]) assert.equal(m.data(id).query, `busy ${id}`)
    m.call(7, 'holoself_status')
    await m.accept.drain()
    assert.equal(m.data(7).project.linked, true)
  } finally {
    await m.close()
    await rm(base, { recursive: true, force: true })
  }
})

test('any request reusing the id of an unanswered call is rejected', { timeout: 60000 }, async () => {
  const { base, project } = await fixture()
  const m = pooled(project, { simulateWorkMs: { holoself_search: 300 } })
  try {
    m.call(2, 'holoself_search', { query: 'marker' })
    m.send(2, 'ping', {})
    assert.deepEqual(m.output.at(-1), { jsonrpc: '2.0', id: 2, error: { code: -32600, message: 'Request id is already in progress' } })
    await m.accept.drain()
    m.send(2, 'ping', {})
    assert.deepEqual(m.output.at(-1), { jsonrpc: '2.0', id: 2, result: {} })
  } finally {
    await m.close()
    await rm(base, { recursive: true, force: true })
  }
})

test('equivalent context spellings reach the worker that cached the selection', { timeout: 60000 }, async () => {
  const { base, project } = await fixture()
  const m = pooled(project)
  try {
    m.call(2, 'holoself_context', { task: 'refactoring marker' })
    await m.accept.drain()
    m.call(3, 'holoself_context', { budget: 'standard', lens: 'professional', temporal: 'current', session_start: false, task: 'refactoring marker' })
    await m.accept.drain()
    const hit = id => m.data(id).context_receipt.cache.hit
    assert.equal(hit(2), false)
    assert.equal(hit(3), true)
  } finally {
    await m.close()
    await rm(base, { recursive: true, force: true })
  }
})

test('audit log refuses symlinks and hard links, enforces 0600 and stops at its size cap', { timeout: 60000 }, async () => {
  const { base, project } = await fixture(),
    dir = await mkdtemp(join(tmpdir(), 'holoself-mcp-audit-'))
  try {
    const run = (auditLog, extra = {}) => {
      const accept = createMcpSession({ project, write: () => {}, auditLog, ...extra })
      accept(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }))
      return () => accept(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }))
    }
    const target = join(dir, 'target.txt'),
      link = join(dir, 'link.ndjson')
    await writeFile(target, 'original\n')
    let linked = true
    try {
      await symlink(target, link)
    } catch {
      linked = false // symlink creation may need privileges on Windows
    }
    if (linked) {
      run(link)()
      assert.equal(await readFile(target, 'utf8'), 'original\n')
      assert.ok((await lstat(link)).isSymbolicLink())
    }

    const existing = join(dir, 'existing.ndjson')
    await writeFile(existing, '')
    if (process.platform !== 'win32') {
      await chmod(existing, 0o644)
      run(existing)()
      assert.equal((await stat(existing)).mode & 0o777, 0o600)
    }

    if (process.platform !== 'win32') {
      const original = join(dir, 'original.ndjson'),
        second = join(dir, 'hardlinked.ndjson')
      await writeFile(original, '')
      await hardlink(original, second)
      run(second)()
      assert.equal(await readFile(original, 'utf8'), '', 'a hard-linked log is refused')
    }

    const capped = join(dir, 'capped.ndjson'),
      list = run(capped, { auditLogMaxBytes: 300 })
    for (let i = 0; i < 20; i++) list()
    run(capped, { auditLogMaxBytes: 300 })()
    const text = await readFile(capped, 'utf8'),
      lines = text.trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(lines.at(-1), { event: 'audit_log_capped' })
    assert.equal(lines.filter(line => line.event === 'audit_log_capped').length, 1)
    assert.ok(lines.length > 2 && Buffer.byteLength(text) <= 300 + 30)
  } finally {
    await rm(base, { recursive: true, force: true })
    await rm(dir, { recursive: true, force: true })
  }
})
