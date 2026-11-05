import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const api = await import('../src/product-telemetry.mjs').catch(() => ({}))
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'product-otel-'))
  return { file: join(dir, 'consumer.env'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}
test('consumer contract parses only data and rejects unsafe endpoint/protocol values', () => {
  assert.equal(typeof api.parseConsumer, 'function', 'consumer parser is implemented')
  const valid = 'OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:24318\nOTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf\n'
  assert.equal(api.parseConsumer(valid).endpoint, 'http://127.0.0.1:24318')
  assert.equal(api.parseConsumer(valid + 'ARBITRARY=$(touch /never)\n').endpoint, 'http://127.0.0.1:24318')
  for (const endpoint of ['https://example.org', 'http://user:pass@127.0.0.1:24318', 'http://127.0.0.1:24318/?secret=x', '$(id)', 'http://127.0.0.1:24318/path']) {
    assert.equal(api.parseConsumer(valid.replace('http://127.0.0.1:24318', endpoint)), null)
  }
  assert.equal(api.parseConsumer(valid + 'OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:1\n'), null)
  assert.equal(api.parseConsumer(valid.replace('http/protobuf', 'grpc')), null)
  assert.equal(api.parseConsumer('x'.repeat(8193)), null)
  assert.equal(api.parseConsumer(valid + 'OTEL_RESOURCE_ATTRIBUTES=personal.secret=private-input\n').endpoint, 'http://127.0.0.1:24318')
})
// Minimal wire decoder checks the actual OTLP hierarchy and values, not a mock exporter.
function fields(bytes) {
  const result = new Map(); let offset = 0
  const number = () => { let n = 0n, shift = 0n, b; do { b = bytes[offset++]; n |= BigInt(b & 127) << shift; shift += 7n } while (b & 128); return n }
  while (offset < bytes.length) {
    const tag = Number(number()), kind = tag & 7, key = tag >> 3; let value
    if (kind === 2) { const length = Number(number()); value = bytes.subarray(offset, offset + length); offset += length }
    else if (kind === 1) { value = bytes.readBigUInt64LE(offset); offset += 8 }
    else if (kind === 0) value = number()
    else if (kind === 5) { value = BigInt(bytes.readUInt32LE(offset)); offset += 4 }
    else throw new Error('unexpected wire type')
    result.set(key, [...(result.get(key) || []), value])
  }
  return result
}
test('synthetic local sink receives private-safe OTLP completion with outcome and elapsed time', async () => {
  assert.equal(typeof api.observeOperation, 'function')
  const f = fixture(); const received = []
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    received.push({ url: req.url, type: req.headers['content-type'], body: Buffer.concat(chunks) })
    res.writeHead(200, { 'content-type': 'application/x-protobuf' }); res.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    writeFileSync(f.file, `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:${server.address().port}\nOTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf\nOTEL_RESOURCE_ATTRIBUTES=personal.secret=private-input\n`)
    const value = await api.observeOperation(async () => { await new Promise(r => setTimeout(r, 5)); return 'private-input' }, { consumerFile: f.file, disabled: false })
    assert.equal(value, 'private-input'); assert.equal(received.length, 1)
    const { body, url, type } = received[0]
    assert.equal(url, '/v1/traces'); assert.equal(type, 'application/x-protobuf')
    assert.equal(body.includes(Buffer.from('private-input')), false)
    const rs = fields(fields(body).get(1)[0]); const scope = fields(rs.get(2)[0]); const span = fields(scope.get(2)[0])
    assert.equal(span.get(5)[0].toString(), 'cli.operation')
    assert.ok(span.get(8)[0] > span.get(7)[0]); assert.equal(span.get(1)[0].length, 16)
    const attributes = Object.fromEntries(span.get(9).map(b => { const kv = fields(b); return [kv.get(1)[0].toString(), fields(kv.get(2)[0]).get(1)[0].toString()] }))
    assert.deepEqual(attributes, { 'operation.outcome': 'success' })
    assert.equal(fields(span.get(15)[0]).get(3)[0], 1n)
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); f.cleanup() }
})
test('off and absent config preserve result without contacting the sink', async () => {
  assert.equal(typeof api.observeOperation, 'function')
  const f = fixture()
  try {
    writeFileSync(f.file, 'OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:1\nOTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf\n')
    assert.equal(await api.observeOperation(async () => 7, { consumerFile: f.file, disabled: true }), 7)
    assert.equal(await api.observeOperation(async () => 8, { consumerFile: f.file + '.absent' }), 8)
  } finally { f.cleanup() }
})
test('unavailable exporter preserves result and original exception without exporting error contents', async () => {
  assert.equal(typeof api.observeOperation, 'function')
  const f = fixture(); const error = new Error('private-error-with-credential')
  try {
    writeFileSync(f.file, 'OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:1\nOTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf\n')
    assert.equal(await api.observeOperation(async () => 19, { consumerFile: f.file, disabled: false }), 19)
    assert.equal(await api.observeOperation(async () => 23, { consumerFile: f.file, disabled: false, classify: () => { throw new Error('private-classifier') } }), 23)
    await assert.rejects(api.observeOperation(async () => { throw error }, { consumerFile: f.file, disabled: false }), e => e === error)
  } finally { f.cleanup() }
})
test('stalled collector is bounded and exported errors contain no message', async () => {
  const f = fixture(); const bodies = []
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    bodies.push(Buffer.concat(chunks))
    // Deliberately never reply: exporter deadline must end the command.
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    writeFileSync(f.file, `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:${server.address().port}\nOTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf\n`)
    const start = performance.now(); const original = new Error('secret-error-text')
    await assert.rejects(api.observeOperation(async () => { throw original }, { consumerFile: f.file, disabled: false }), e => e === original)
    assert.ok(performance.now() - start < 1000)
    assert.equal(bodies.length, 1); assert.equal(bodies[0].includes(Buffer.from('secret-error-text')), false)
    const span = fields(fields(fields(fields(bodies[0]).get(1)[0]).get(2)[0]).get(2)[0])
    assert.equal(fields(span.get(15)[0]).get(3)[0], 2n)
    assert.equal(fields(fields(span.get(9)[0]).get(2)[0]).get(1)[0].toString(), 'error')
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); f.cleanup() }
})

test('real CLI preserves exit/output while exporting only fixed completion fields', async () => {
  const f = fixture(); const received = []
  const home = join(f.file, '..')
  mkdirSync(join(home, '.config/observability'), { recursive: true })
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    received.push(Buffer.concat(chunks)); res.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const env = { ...process.env, HOME: home, HOLOSELF_TELEMETRY: 'on', OTEL_SDK_DISABLED: 'false', TRACEPARENT: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' }
  try {
    writeFileSync(join(home, '.config/observability/consumer.env'), `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:${server.address().port}\nOTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf\n`)
    const run = promisify(execFile)
    const cli = new URL('../bin/holoself.mjs', import.meta.url).pathname
    const good = await run(process.execPath, [cli, 'capabilities', '--json'], { env })
    assert.equal(JSON.parse(good.stdout).product, 'holoself')
    await assert.rejects(run(process.execPath, [cli, 'private-input'], { env }), error => error.code === 1)
    assert.equal(received.length, 2)
    const outcomes = received.map(body => {
      assert.equal(body.includes(Buffer.from('private-input')), false)
      const span = fields(fields(fields(fields(body).get(1)[0]).get(2)[0]).get(2)[0])
      return fields(fields(span.get(9)[0]).get(2)[0]).get(1)[0].toString()
    })
    assert.deepEqual(outcomes, ['success', 'error'])
    const first = fields(fields(fields(fields(received[0]).get(1)[0]).get(2)[0]).get(2)[0])
    assert.equal(first.get(1)[0].toString('hex'), '0af7651916cd43dd8448eb211c80319c')
    assert.equal(first.get(4)?.[0].toString('hex'), 'b7ad6b7169203331')
    await run(process.execPath, [cli, 'capabilities', '--json'], { env: { ...env, HOLOSELF_TELEMETRY: 'off' } })
    assert.equal(received.length, 2)
    for (const value of ['true', '1']) {
      const off = await run(process.execPath, [cli, 'capabilities', '--json'], { env: { ...env, OTEL_SDK_DISABLED: value } })
      assert.equal(JSON.parse(off.stdout).product, 'holoself')
      assert.equal(received.length, 2, `OTEL_SDK_DISABLED=${value} sends no telemetry`)
    }
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); f.cleanup() }
})

test('valid W3C parent becomes a fresh child on the same trace, including errors', async () => {
  const f = fixture(); const bodies = []
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    bodies.push(Buffer.concat(chunks)); res.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const traceId = '0af7651916cd43dd8448eb211c80319c', parentId = 'b7ad6b7169203331'
  try {
    writeFileSync(f.file, `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:${server.address().port}\nOTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf\n`)
    const options = { consumerFile: f.file, disabled: false, traceparent: `00-${traceId}-${parentId}-01` }
    const result = { private: 'private-return-data' }
    assert.equal(await api.observeOperation(async () => result, options), result)
    const error = new Error('private-error-data')
    await assert.rejects(api.observeOperation(async () => { throw error }, options), value => value === error)
    const childIds = []
    for (const body of bodies) {
      const span = fields(fields(fields(fields(body).get(1)[0]).get(2)[0]).get(2)[0])
      assert.equal(span.get(1)[0].toString('hex'), traceId)
      assert.equal(span.get(4)?.[0].toString('hex'), parentId)
      const id = span.get(2)[0].toString('hex'); childIds.push(id)
      assert.notEqual(id, parentId); assert.notEqual(id, '0'.repeat(16))
      assert.equal(span.get(16)?.[0], 1n)
      assert.equal(body.includes(Buffer.from('private-')), false)
    }
    assert.equal(bodies.length, 2); assert.notEqual(childIds[0], childIds[1])
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.cleanup() }
})
test('malformed or oversized parent context is ignored without string leakage', async () => {
  const f = fixture(); const bodies = []
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    bodies.push(Buffer.concat(chunks)); res.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const valid = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00'
  const invalid = [null, '', 'private-parent-data', 'private-parent-data'.repeat(1000), valid.toUpperCase(), valid.replace(/^00/, '01'), valid.slice(0, -1), valid + '0', ' ' + valid, valid + '\n', valid.replace('0af7651916cd43dd8448eb211c80319c', '0'.repeat(32)), valid.replace('b7ad6b7169203331', '0'.repeat(16)), valid.slice(0, -2) + 'zz']
  try {
    writeFileSync(f.file, `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:${server.address().port}\nOTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf\n`)
    for (const traceparent of invalid) {
      assert.equal(await api.observeOperation(async () => 31, { consumerFile: f.file, disabled: false, traceparent }), 31)
    }
    assert.equal(bodies.length, invalid.length)
    for (const body of bodies) {
      const span = fields(fields(fields(fields(body).get(1)[0]).get(2)[0]).get(2)[0])
      assert.equal(span.has(4), false)
      assert.notEqual(span.get(1)[0].toString('hex'), valid.slice(3, 35))
      assert.notEqual(span.get(1)[0].toString('hex'), '0'.repeat(32))
      assert.equal(span.get(9).length, 1)
      assert.equal(body.includes(Buffer.from('private-parent-data')), false)
    }
    // Explicit null suppresses an inherited parent; explicit disabled=false also
    // overrides the environment opt-out for synthetic fixture delivery.
    await api.observeOperation(async () => 32, { consumerFile: f.file, disabled: false, traceparent: valid })
    const sampledOff = fields(fields(fields(fields(bodies.at(-1)).get(1)[0]).get(2)[0]).get(2)[0])
    assert.equal(sampledOff.get(16)?.[0], 0n)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.cleanup() }
})

test('standard SDK opt-out disables actual CLI export without changing output', async () => {
  const f = fixture(); const home = join(f.file, '..'); let requests = 0
  mkdirSync(join(home, '.config/observability'), { recursive: true })
  const server = createServer(async (req, res) => {
    for await (const chunk of req) { /* drain the synthetic request */ }
    requests++; res.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    writeFileSync(join(home, '.config/observability/consumer.env'), `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:${server.address().port}\nOTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf\n`)
    for (const value of ['true', '1']) {
      const result = await promisify(execFile)(process.execPath, [new URL('../bin/holoself.mjs', import.meta.url).pathname, 'capabilities', '--json'], {
        env: { ...process.env, HOME: home, HOLOSELF_TELEMETRY: 'on', OTEL_SDK_DISABLED: value, TRACEPARENT: 'private-parent-data' }
      })
      assert.equal(JSON.parse(result.stdout).product, 'holoself')
      assert.equal(requests, 0)
    }
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.cleanup() }
})
