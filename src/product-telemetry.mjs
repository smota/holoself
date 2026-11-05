// Deliberately narrow OTLP/HTTP producer: no SDK, argv, content or error serialization.
import { openSync, readSync, closeSync, fstatSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { request } from 'node:http'

const SERVICE = 'holoself'
const OFF_ENV = 'HOLOSELF_TELEMETRY'
const KEYS = new Set(['OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_PROTOCOL', 'OTEL_RESOURCE_ATTRIBUTES'])
export function parseConsumer(source) {
  if (Buffer.byteLength(source) > 8192) return null
  const values = new Map()
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const index = line.indexOf('=')
    const key = line.slice(0, index).trim()
    if (index < 0 || !KEYS.has(key)) continue
    if (values.has(key)) return null
    let value = line.slice(index + 1).trim()
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1)
    values.set(key, value)
  }
  if (values.get('OTEL_EXPORTER_OTLP_PROTOCOL') !== 'http/protobuf') return null
  try {
    const url = new URL(values.get('OTEL_EXPORTER_OTLP_ENDPOINT'))
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) ||
        url.username || url.password || url.search || url.hash || url.pathname !== '/') return null
    // Resource attributes are intentionally not forwarded: only this product's fixed identity is exported.
    return { endpoint: url.origin }
  } catch { return null }
}
function loadConsumer(file) {
  let fd
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > 8192) return null
    const bytes = Buffer.alloc(8193)
    const length = readSync(fd, bytes, 0, bytes.length, 0)
    return parseConsumer(bytes.subarray(0, length).toString('utf8'))
  } catch { return null }
  finally { if (fd !== undefined) { try { closeSync(fd) } catch { /* advisory read */ } } }
}
// The small fixed schema below is ExportTraceServiceRequest from OTLP trace/v1.
const varint = value => {
  let n = BigInt(value); const bytes = []
  while (n > 127n) { bytes.push(Number(n & 127n) | 128); n >>= 7n }
  return Buffer.from([...bytes, Number(n)])
}
const message = (...parts) => Buffer.concat(parts)
const bytes = (field, value) => {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value)
  return message(varint(field * 8 + 2), varint(data.length), data)
}
const fixed64 = (field, value) => {
  const data = Buffer.alloc(8); data.writeBigUInt64LE(value)
  return message(varint(field * 8 + 1), data)
}
const attribute = (key, value) => message(bytes(1, key), bytes(2, bytes(1, value)))
function parseProductTraceparent(value) {
  if (typeof value !== 'string' || value.length !== 55) return null
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(value)
  if (!match || /^0+$/.test(match[1]) || /^0+$/.test(match[2])) return null
  return { traceId: Buffer.from(match[1], 'hex'), spanId: Buffer.from(match[2], 'hex'), flags: parseInt(match[3], 16) }
}
function randomProductId(length) {
  const id = randomBytes(length)
  if (id.every(byte => byte === 0)) id[0] = 1
  return id
}
function payload(start, elapsed, outcome, parent, name = 'cli.operation') {
  const childId = randomProductId(8)
  if (parent && childId.equals(parent.spanId)) {
    childId[7] ^= 1
    if (childId.every(byte => byte === 0)) childId[0] = 1
  }
  const flags = Buffer.alloc(4)
  flags.writeUInt32LE(parent?.flags ?? 0)
  const span = message(bytes(1, parent?.traceId ?? randomProductId(16)), bytes(2, childId),
    ...(parent ? [bytes(4, parent.spanId)] : []), bytes(5, name),
    varint(6 * 8), varint(1), fixed64(7, start), fixed64(8, start + elapsed),
    bytes(9, attribute('operation.outcome', outcome)), bytes(15, message(varint(3 * 8), varint(outcome === 'success' ? 1 : 2))),
    varint(16 * 8 + 5), flags)
  const resource = bytes(1, attribute('service.name', SERVICE))
  const scopeSpans = message(bytes(1, bytes(1, `${SERVICE}.product`)), bytes(2, span))
  return bytes(1, message(bytes(1, resource), bytes(2, scopeSpans)))
}
async function sendProductTelemetry(endpoint, body, background = false) {
  await new Promise(resolve => {
    let req, timer
    const finish = () => { clearTimeout(timer); resolve() }
    timer = setTimeout(() => { req?.destroy(); finish() }, 200)
    if (background) timer.unref()
    req = request(`${endpoint}/v1/traces`, {
      method: 'POST', agent: false,
      headers: { 'content-type': 'application/x-protobuf', 'content-length': body.length }
    }, response => { response.destroy(); finish() })
    req.on('error', finish)
    if (background) req.on('socket', socket => socket.unref())
    req.end(body)
  })
}
export async function observeOperation(action, {
  consumerFile = join(homedir(), '.config', 'observability', 'consumer.env'),
  disabled = process.env[OFF_ENV] === 'off' || ['true', '1'].includes(process.env.OTEL_SDK_DISABLED?.toLowerCase()),
  traceparent = process.env.TRACEPARENT,
  classify = () => 'success'
} = {}) {
  const config = disabled ? null : loadConsumer(consumerFile)
  if (!config) return action()
  const parent = parseProductTraceparent(traceparent)
  const start = BigInt(Date.now()) * 1000000n
  const clock = process.hrtime.bigint()
  let outcome = 'error'
  try {
    const result = await action()
    let classification
    try { classification = classify(result) } catch { classification = 'error' }
    outcome = ['success', 'degraded', 'invalid', 'error'].includes(classification) ? classification : 'error'
    return result
  } finally {
    const elapsed = process.hrtime.bigint() - clock
    try { await sendProductTelemetry(config.endpoint, payload(start, elapsed, outcome, parent)) } catch { /* advisory, never replace the product result */ }
  }
}

// Persistent servers never await telemetry. No pending queue: four requests may be
// in flight across all sessions; overloaded completions are dropped immediately.
const MCP_EXPORT_CAP = 4
let mcpExports = 0
const noop = () => {}
const noObservation = () => noop
const MCP_OUTCOMES = new Set(['success', 'error', 'timeout', 'cancelled', 'busy'])
export function createMcpObserver(options = {}) {
  let config
  try {
    const disabled = options.disabled ?? (process.env[OFF_ENV] === 'off' || ['true', '1'].includes(process.env.OTEL_SDK_DISABLED?.toLowerCase()))
    config = disabled ? null : loadConsumer(options.consumerFile ?? join(homedir(), '.config', 'observability', 'consumer.env'))
  } catch { return noObservation }
  if (!config) return noObservation
  return () => {
    try {
      const start = BigInt(Date.now()) * 1000000n, clock = process.hrtime.bigint()
      let finished = false
      // The caller supplies only a closed outcome, never arguments/results/errors.
      // There is no declared request trace-context contract here, so each call is
      // an independent root; process TRACEPARENT and arbitrary _meta are ignored.
      return outcome => {
        try {
          if (finished) return
          finished = true
          if (mcpExports >= MCP_EXPORT_CAP) return
          const body = payload(start, process.hrtime.bigint() - clock,
            MCP_OUTCOMES.has(outcome) ? outcome : 'error', null, 'mcp.operation')
          mcpExports++
          void sendProductTelemetry(config.endpoint, body, true)
            .catch(noop).finally(() => { mcpExports-- })
        } catch { /* telemetry cannot affect a reply, error or cancellation */ }
      }
    } catch { return noop }
  }
}
