import './helpers/isolated-config.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createMcpSession, createMcpToolPool, executeToolJob } from '../src/mcp-server.mjs'

const PRIVATE = 'PRIVATE_MCP_TELEMETRY_SENTINEL'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, ms = 4000) {
  const end = Date.now() + ms
  while (!check()) { if (Date.now() > end) assert.fail('bounded completion not observed'); await sleep(5) }
}
function fields(buffer) {
  const out = new Map(); let i = 0
  const number = () => { let n = 0n, shift = 0n, b; do { b = buffer[i++]; n |= BigInt(b & 127) << shift; shift += 7n } while (b & 128); return n }
  while (i < buffer.length) {
    const tag = Number(number()), key = tag >> 3, wire = tag & 7; let value
    if (wire === 2) { const size = Number(number()); value = buffer.subarray(i, i + size); i += size }
    else if (wire === 0) value = number()
    else if (wire === 1) { value = buffer.readBigUInt64LE(i); i += 8 }
    else if (wire === 5) { value = BigInt(buffer.readUInt32LE(i)); i += 4 }
    else assert.fail('unexpected protobuf wire type')
    out.set(key, [...(out.get(key) || []), value])
  }
  return out
}
function decode(body) {
  assert.equal(body.includes(Buffer.from(PRIVATE)), false, 'no private input, result, error or resource content')
  const resourceSpans = fields(fields(body).get(1)[0])
  const resource = fields(fields(resourceSpans.get(1)[0]).get(1)[0])
  assert.equal(resource.get(1)[0].toString(), 'service.name')
  assert.equal(fields(resource.get(2)[0]).get(1)[0].toString(), 'holoself')
  const span = fields(fields(resourceSpans.get(2)[0]).get(2)[0])
  assert.equal(span.get(5)[0].toString(), 'mcp.operation')
  assert.equal(span.has(4), false, 'process startup TRACEPARENT never parents requests')
  assert.notEqual(span.get(1)[0].toString('hex'), '0af7651916cd43dd8448eb211c80319c')
  assert.ok(span.get(8)[0] >= span.get(7)[0])
  const attributes = Object.fromEntries(span.get(9).map(b => { const kv = fields(b); return [kv.get(1)[0].toString(), fields(kv.get(2)[0]).get(1)[0].toString()] }))
  assert.deepEqual(Object.keys(attributes), ['operation.outcome'])
  assert.equal(fields(span.get(15)[0]).get(3)[0], attributes['operation.outcome'] === 'success' ? 1n : 2n)
  return { outcome: attributes['operation.outcome'], trace: span.get(1)[0].toString('hex') }
}
async function fixture(t, { stalled = false } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'holoself-mcp-telemetry-'))
  const self = join(base, 'self'), project = join(base, 'project'), home = join(base, 'home')
  await mkdir(project); await mkdir(home)
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), HOLOSELF_HOME: self, HOLOSELF_TELEMETRY: 'off', OTEL_SDK_DISABLED: 'true' }
  const cli = fileURLToPath(new URL('../bin/holoself.mjs', import.meta.url))
  const run = args => promisify(execFile)(process.execPath, [cli, ...args], { env })
  await run(['init', '--root', self])
  await writeFile(join(self, 'profile/identity.md'), `---\naccess_lenses: [general, professional]\ndisclosure: internal-only\nsensitivity: personal\ndocument_role: content\n---\n# Identity\n\n${PRIVATE} refactoring.\n`)
  await run(['link', 'add', '--project', project, '--self', self, '--lens', 'professional', '--no-activate', '--yes'])
  const bodies = [], sockets = new Set()
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    if (req.url !== '/v1/traces') { res.end(); return }
    assert.equal(req.headers['content-type'], 'application/x-protobuf')
    bodies.push(Buffer.concat(chunks)); if (!stalled) res.end()
  })
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const consumerFile = join(base, 'consumer.env')
  await writeFile(consumerFile, `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:${server.address().port}\nOTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf\nOTEL_RESOURCE_ATTRIBUTES=private=${PRIVATE}\n`)
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(base, { recursive: true, force: true }) })
  return { base, self, project, bodies, sockets, telemetry: { consumerFile, disabled: false } }
}
function session(f, pool = null, extra = {}) {
  const output = []
  const accept = createMcpSession({ project: f.project, pool, telemetry: f.telemetry, auditLog: null, write: line => output.push(JSON.parse(line)), ...extra })
  const send = (id, method, params) => accept(JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params }))
  send(1, 'initialize', { clientInfo: { name: PRIVATE } })
  return { accept, output, send, call: (id, name, args = {}) => send(id, 'tools/call', { name, arguments: args, _meta: { traceparent: `00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01`, private: PRIVATE } }) }
}

test('actual inline MCP completion stays synchronous, emits success/isError and no content', async t => {
  const f = await fixture(t), m = session(f)
  const previous = process.env.TRACEPARENT
  process.env.TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'
  t.after(() => { if (previous === undefined) delete process.env.TRACEPARENT; else process.env.TRACEPARENT = previous })
  assert.equal(m.call(2, 'holoself_context', { task: PRIVATE + ' refactoring', budget: 'small' }), undefined)
  assert.equal(m.output.at(-1).id, 2, 'reply exists before accept returns')
  assert.equal(m.output.at(-1).result.isError, undefined, JSON.stringify(m.output.at(-1)))
  await until(() => f.bodies.length === 1)
  m.call(3, PRIVATE)
  assert.equal(m.output.at(-1).result.isError, true)
  await until(() => f.bodies.length === 2)
  const job = executeToolJob(f.project, 'holoself_status', {})
  assert.equal(job.ok, true); assert.equal(job.then, undefined, 'worker execution still returns a non-Promise')
  const decoded = f.bodies.map(decode)
  assert.deepEqual(decoded.map(x => x.outcome), ['success', 'error'])
  assert.notEqual(decoded[0].trace, decoded[1].trace)
})

test('actual worker dispatcher observes success, validation isError and runtime failure', async t => {
  const f = await fixture(t), pool = createMcpToolPool({ size: 1 }), m = session(f, pool)
  t.after(() => pool.close())
  m.call(2, 'holoself_context', { task: PRIVATE + ' refactoring', budget: 'small' })
  await m.accept.drain(); assert.equal(m.output.at(-1).result.isError, undefined, JSON.stringify(m.output.at(-1)))
  await until(() => f.bodies.length === 1)
  m.call(3, 'holoself_search', {})
  assert.equal(m.output.at(-1).result.isError, true)
  await until(() => f.bodies.length === 2)
  m.call(4, 'holoself_context', { task: PRIVATE, lens: PRIVATE })
  await m.accept.drain(); assert.equal(m.output.at(-1).result.isError, true)
  await until(() => f.bodies.length === 3)
  assert.deepEqual(f.bodies.map(decode).map(x => x.outcome), ['success', 'error', 'error'])
})

test('real pool timeout and cancellation keep original protocol replies and record finite outcomes', async t => {
  const f = await fixture(t), pool = createMcpToolPool({ size: 1, timeoutMs: 100, simulateWorkMs: { holoself_search: 1000 } }), m = session(f, pool)
  t.after(() => pool.close())
  m.call(2, 'holoself_search', { query: PRIVATE })
  await m.accept.drain(); assert.equal(m.output.at(-1).error.code, -32001)
  await until(() => f.bodies.length === 1)
  m.call(3, 'holoself_search', { query: PRIVATE })
  m.send(undefined, 'notifications/cancelled', { requestId: 3, reason: PRIVATE })
  await m.accept.drain(); assert.equal(m.output.some(x => x.id === 3), false)
  await until(() => f.bodies.length === 2)
  assert.deepEqual(f.bodies.map(decode).map(x => x.outcome), ['timeout', 'cancelled'])
})

test('stalled exporter cannot delay inline replies or pool drain, drops overload, and has a deadline', async t => {
  const f = await fixture(t, { stalled: true }), m = session(f)
  // Validation errors avoid repeated profile I/O in the response timing assertion.
  for (let i = 0; i < 30; i++) m.call(i + 2, PRIVATE)
  assert.equal(m.output.length, 31)
  assert.equal(f.bodies.length, 0, 'all synchronous replies precede collector I/O')
  await until(() => f.bodies.length > 0)
  assert.ok(f.bodies.length <= 4, 'at most four in-flight exports, with no pending queue')
  await sleep(300)
  assert.equal(f.sockets.size, 0, 'all stalled export sockets are closed at deadline')
  const pool = createMcpToolPool({ size: 1 }), p = session(f, pool)
  t.after(() => pool.close())
  const count = f.bodies.length
  p.call(100, 'holoself_status')
  await p.accept.drain()
  assert.equal(p.output.at(-1).id, 100)
  await until(() => f.bodies.length > count)
  assert.ok(f.sockets.size > 0, 'pool drain completes while export is still awaiting a response')
  await sleep(300); assert.equal(f.sockets.size, 0)
  f.bodies.forEach(decode)
})

test('product/global opt-out and absent/unsafe consumer prevent MCP network export', async t => {
  const f = await fixture(t)
  const old = { product: process.env.HOLOSELF_TELEMETRY, global: process.env.OTEL_SDK_DISABLED }
  try {
    for (const [product, global] of [['off', 'false'], ['on', 'true'], ['on', '1']]) {
      process.env.HOLOSELF_TELEMETRY = product; process.env.OTEL_SDK_DISABLED = global
      const m = session(f, null, { telemetry: { consumerFile: f.telemetry.consumerFile } })
      m.call(2, 'holoself_status'); assert.equal(m.output.at(-1).result.isError, undefined, JSON.stringify(m.output.at(-1)))
    }
    for (const consumerFile of [join(f.base, 'absent'), join(f.base, 'unsafe.env')]) {
      if (consumerFile.endsWith('unsafe.env')) await writeFile(consumerFile, 'OTEL_EXPORTER_OTLP_ENDPOINT=https://example.invalid\nOTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf\n')
      const m = session(f, null, { telemetry: { consumerFile, disabled: false } })
      m.call(2, PRIVATE); assert.equal(m.output.at(-1).result.isError, true)
    }
    await sleep(250); assert.equal(f.bodies.length, 0)
  } finally {
    for (const [key, value] of [['HOLOSELF_TELEMETRY', old.product], ['OTEL_SDK_DISABLED', old.global]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
  }
})


test('telemetry configuration exceptions cannot change synchronous replies or original worker errors', async t => {
  const f = await fixture(t)
  const broken = new Proxy({}, { get() { throw new Error(PRIVATE) } })
  const normal = session(f, null, { telemetry: { disabled: true } })
  const observed = session(f, null, { telemetry: broken })
  for (const m of [normal, observed]) {
    assert.equal(m.call(2, 'holoself_status'), undefined)
    assert.equal(m.call(3, PRIVATE), undefined)
  }
  assert.deepEqual(observed.output, normal.output)
  const pool = createMcpToolPool({ size: 1 }), m = session(f, pool, { telemetry: broken })
  t.after(() => pool.close())
  m.call(4, 'holoself_context', { task: PRIVATE, lens: PRIVATE })
  await m.accept.drain()
  assert.equal(m.output.at(-1).result.isError, true)
  await sleep(250); assert.equal(f.bodies.length, 0)
})

test('server busy reply is unchanged and observed without altering queue policy', async t => {
  const f = await fixture(t)
  const pool = createMcpToolPool({ size: 1, simulateWorkMs: { holoself_search: 500 } })
  t.after(() => pool.close())
  const m = session(f, pool, { maxPending: 1 })
  m.call(2, 'holoself_search', { query: PRIVATE })
  m.call(3, 'holoself_status')
  assert.equal(m.output.at(-1).error.code, -32000)
  await until(() => f.bodies.length === 1)
  assert.equal(decode(f.bodies[0]).outcome, 'busy')
  m.send(undefined, 'notifications/cancelled', { requestId: 2 })
  await m.accept.drain()
  await until(() => f.bodies.length === 2)
  assert.equal(decode(f.bodies[1]).outcome, 'cancelled')
  assert.equal(m.output.some(x => x.id === 2), false)
})
