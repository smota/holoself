import { randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline'
import { closeSync, constants as fsConstants, existsSync, fchmodSync, fstatSync, lstatSync, openSync, readSync, writeSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import {
  holoselfMcpContext,
  holoselfMcpCreateProposal,
  holoselfMcpPreviewProposal,
  holoselfMcpSearch,
  holoselfMcpStatus,
  mcpToolEnvelope,
  PROPOSAL_TYPES,
  VISIBILITIES
} from './ecosystem.mjs'
import { readLink } from './link/config.mjs'
import { createToolPool } from './mcp-pool.mjs'
import { VERSION } from './version.mjs'

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26']
const TOOL_PREFIX = 'holoself_'
const MAX_LINE_BYTES = 1024 * 1024
const MAX_RESULT_BYTES = 512 * 1024
const TEMPORAL = ['current', 'historical', 'superseded', 'all']
const BUDGETS = ['small', 'standard', 'deep']
const AUDIT_LOG_MAX_BYTES = 10 * 1024 * 1024
export const DEFAULT_TOOL_TIMEOUT_MS = 60000
export const DEFAULT_TOOL_CONCURRENCY = 2
export const DEFAULT_MAX_PENDING_CALLS = 256
export const DEFAULT_WORKER_HEAP_MB = 512
export const DEFAULT_WRITE_TIMEOUT_MS = 10 * 60 * 1000
// JSON-RPC error code for a tool call refused because too many calls are already pending.
export const SERVER_BUSY_RPC_CODE = -32000
// JSON-RPC error code for a tool call that exceeded the per-call timeout (same value the MCP SDKs use).
export const TOOL_TIMEOUT_RPC_CODE = -32001

const baseContextProperties = {
  task: { type: 'string', minLength: 1, maxLength: 500, description: 'The current task; used only for deterministic relevance selection.' },
  lens: { type: 'string', minLength: 1, maxLength: 80, description: 'A lens ID defined in the canonical self root.' },
  budget: { type: 'string', enum: BUDGETS, default: 'standard' },
  temporal: { type: 'string', enum: TEMPORAL, default: 'current' },
  cursor: { type: 'string', minLength: 1, maxLength: 4096, description: 'Opaque pagination cursor from previous manifest request.' },
  session_start: {
    type: 'boolean',
    default: false,
    description: 'Recurring session-start load: without a task, return only the lens session_start_sources (default identity, preferences, work-context).'
  }
}
const objectSchema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
const resultSchema = objectSchema({ schema_version: { type: 'integer' }, data: { type: 'object' }, error: { type: 'object' } })

export const MCP_TOOLS = [
  {
    name: `${TOOL_PREFIX}status`,
    title: 'Holoself status',
    description: 'Check the fixed linked project, explicit link authority, context health, and pending proposals without revealing private root paths.',
    inputSchema: objectSchema({}),
    outputSchema: resultSchema,
    annotations: { title: 'Holoself status', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: `${TOOL_PREFIX}context`,
    title: 'Holoself context',
    description:
      'Resolve and deliver privacy-filtered, lens-scoped context for the current task in a single round-trip. ' +
      'Manifest and get remain optional for fine-grained inspection.',
    inputSchema: objectSchema(
      {
        ...baseContextProperties,
        source_ids: { type: 'array', minItems: 1, maxItems: 16, uniqueItems: true, items: { type: 'string', pattern: '^hs-[A-Za-z0-9_-]{8,}$' } }
      },
      ['task']
    ),
    outputSchema: resultSchema,
    annotations: { title: 'Holoself context', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: `${TOOL_PREFIX}context_manifest`,
    title: 'Holoself context manifest',
    description: 'Return bounded source handles, metadata, restrictions, and a deterministic receipt. It does not return source bodies.',
    inputSchema: objectSchema(baseContextProperties),
    outputSchema: resultSchema,
    annotations: { title: 'Holoself context manifest', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: `${TOOL_PREFIX}context_get`,
    title: 'Holoself context get',
    description: 'Resolve only the requested manifest source handles through the link, lens, lifecycle, and privacy gates.',
    inputSchema: objectSchema(
      {
        ...baseContextProperties,
        source_ids: { type: 'array', minItems: 1, maxItems: 16, uniqueItems: true, items: { type: 'string', pattern: '^hs-[A-Za-z0-9_-]{8,}$' } }
      },
      ['source_ids']
    ),
    outputSchema: resultSchema,
    annotations: { title: 'Holoself context get', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: `${TOOL_PREFIX}search`,
    title: 'Holoself search',
    description: 'Search the deterministic local privacy-filtered index for the fixed linked project.',
    inputSchema: objectSchema(
      {
        query: { type: 'string', minLength: 1, maxLength: 500 },
        lens: { type: 'string', minLength: 1, maxLength: 80 },
        temporal: { type: 'string', enum: TEMPORAL, default: 'current' },
        federated: { type: 'boolean', default: false },
        limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 }
      },
      ['query']
    ),
    outputSchema: resultSchema,
    annotations: { title: 'Holoself search', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: `${TOOL_PREFIX}proposal_create`,
    title: 'Create Holoself proposal',
    description: 'Create a project-local pending proposal backed by contained project evidence. It never writes canonical self.',
    inputSchema: objectSchema(
      {
        claim: { type: 'string', minLength: 1, maxLength: 4000 },
        evidence: { type: 'string', minLength: 1, maxLength: 4000 },
        source_files: { type: 'array', minItems: 1, maxItems: 8, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 500 } },
        target: { type: 'string', minLength: 1, maxLength: 500, default: 'context/claims.md' },
        proposal_type: { type: 'string', enum: PROPOSAL_TYPES, default: 'new_fact' },
        confidence: { type: 'string', minLength: 1, maxLength: 120, default: 'unverified' },
        visibility: { type: 'string', enum: VISIBILITIES, default: 'private' }
      },
      ['claim', 'source_files']
    ),
    outputSchema: resultSchema,
    annotations: { title: 'Create Holoself proposal', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: `${TOOL_PREFIX}proposal_preview`,
    title: 'Preview Holoself proposal',
    description: 'Preview the exact canonical changes and digest for a pending proposal without applying or approving it.',
    inputSchema: objectSchema({ proposal_id: { type: 'string', pattern: '^[0-9a-fA-F-]{8,36}$' } }, ['proposal_id']),
    outputSchema: resultSchema,
    annotations: { title: 'Preview Holoself proposal', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }
]

function fail(message, code = 'INVALID_ARGUMENT') {
  const error = new Error(message)
  error.code = code
  throw error
}
function validateObject(value, schema, path = 'arguments') {
  if (!value || Array.isArray(value) || typeof value !== 'object') fail(`${path} must be an object`)
  const allowed = new Set(Object.keys(schema.properties || {}))
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${path}.${key} is not allowed`)
  for (const key of schema.required || []) if (value[key] === undefined) fail(`${path}.${key} is required`)
  for (const [key, item] of Object.entries(value)) {
    const rule = schema.properties[key],
      label = `${path}.${key}`
    if (rule.type === 'string') {
      if (typeof item !== 'string') fail(`${label} must be a string`)
      if (rule.minLength && item.length < rule.minLength) fail(`${label} is too short`)
      if (rule.maxLength && item.length > rule.maxLength) fail(`${label} is too long`)
      if (rule.enum && !rule.enum.includes(item)) fail(`${label} must be one of ${rule.enum.join(', ')}`)
      if (rule.pattern && !new RegExp(rule.pattern).test(item)) fail(`${label} has an invalid format`)
    } else if (rule.type === 'boolean' && typeof item !== 'boolean') fail(`${label} must be a boolean`)
    else if (rule.type === 'integer') {
      if (!Number.isInteger(item)) fail(`${label} must be an integer`)
      if (rule.minimum !== undefined && item < rule.minimum) fail(`${label} is too small`)
      if (rule.maximum !== undefined && item > rule.maximum) fail(`${label} is too large`)
    } else if (rule.type === 'array') {
      if (!Array.isArray(item)) fail(`${label} must be an array`)
      if (rule.minItems && item.length < rule.minItems) fail(`${label} has too few items`)
      if (rule.maxItems && item.length > rule.maxItems) fail(`${label} has too many items`)
      if (rule.uniqueItems && new Set(item).size !== item.length) fail(`${label} must contain unique items`)
      for (let i = 0; i < item.length; i++) validateObject({ value: item[i] }, objectSchema({ value: rule.items }, ['value']), `${label}[${i}]`)
    }
  }
  return value
}
function resolveBoundProject(projectInput, env = process.env, cwd = process.cwd()) {
  const candidates = []
  if (projectInput) candidates.push(['--project', projectInput])
  if (env.CLAUDE_PROJECT_DIR) candidates.push(['CLAUDE_PROJECT_DIR', env.CLAUDE_PROJECT_DIR])
  if (!candidates.length) candidates.push(['cwd', cwd])
  const resolved = [...new Map(candidates.map(([source, value]) => [resolve(value), source])).entries()]
  if (resolved.length !== 1) fail(`ambiguous project binding from ${candidates.map(([source]) => source).join(' and ')}`, 'PROJECT_BINDING_AMBIGUOUS')
  const [project, source] = resolved[0]
  if (!isAbsolute(project) || !existsSync(project) || lstatSync(project).isSymbolicLink() || !lstatSync(project).isDirectory())
    fail('project binding is not a safe local directory', 'PROJECT_BINDING_INVALID')
  const holoselfDir = join(project, '.holoself')
  if (existsSync(holoselfDir) && lstatSync(holoselfDir).isSymbolicLink())
    fail('project has a legacy filesystem junction mount; run holoself link setup to migrate to a bounded link', 'LEGACY_MOUNT_DETECTED')
  const link = join(project, '.holoself', 'link.yaml')
  if (!existsSync(link) || lstatSync(link).isSymbolicLink() || !lstatSync(link).isFile()) fail('fixed project has no safe .holoself/link.yaml', 'LINK_REQUIRED')
  holoselfMcpStatus(project)
  return { project, source }
}
// Context results carry the packet once (structuredContent) with a short text summary; other tools echo JSON.
const CONTEXT_TOOLS = new Set([`${TOOL_PREFIX}context`, `${TOOL_PREFIX}context_manifest`, `${TOOL_PREFIX}context_get`])
function toolResult(data, name) {
  const result = CONTEXT_TOOLS.has(name)
    ? mcpToolEnvelope(data)
    : { content: [{ type: 'text', text: JSON.stringify({ schema_version: 1, data }) }], structuredContent: { schema_version: 1, data } }
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_RESULT_BYTES) fail('bounded MCP result exceeded 512 KiB', 'RESULT_TOO_LARGE')
  return result
}
function safeErrorMessage(error) {
  if (!error?.code) return 'Holoself operation failed closed. Run holoself link doctor locally for path-safe diagnostics.'
  return String(error.message || error)
    .replace(/\\\\[^\s;]+/g, '<local-path>')
    .replace(/[A-Za-z]:[\\/][^\s;]+/g, '<local-path>')
    .replace(/(^|[\s("'=])\/(?:[^\s;]+\/?)+/g, '$1<local-path>')
    .slice(0, 1000)
}
function toolError(error) {
  const structuredContent = { schema_version: 1, error: { code: error.code || 'HOLOSELF_ERROR', message: safeErrorMessage(error) } }
  return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent, isError: true }
}
function validateToolCall(name, args) {
  const tool = MCP_TOOLS.find(item => item.name === name)
  if (!tool) fail(`unknown tool: ${name}`, 'TOOL_NOT_FOUND')
  validateObject(args || {}, tool.inputSchema)
}
function invokeTool(project, name, args) {
  if (name === `${TOOL_PREFIX}status`) return holoselfMcpStatus(project)
  if (name === `${TOOL_PREFIX}context`) return holoselfMcpContext(project, { ...args, manifest: false })
  if (name === `${TOOL_PREFIX}context_manifest`) return holoselfMcpContext(project, { ...args, manifest: true })
  if (name === `${TOOL_PREFIX}context_get`) return holoselfMcpContext(project, { ...args, manifest: false })
  if (name === `${TOOL_PREFIX}search`) return holoselfMcpSearch(project, args)
  if (name === `${TOOL_PREFIX}proposal_create`) return holoselfMcpCreateProposal(project, args)
  if (name === `${TOOL_PREFIX}proposal_preview`) return holoselfMcpPreviewProposal(project, args.proposal_id)
  fail(`unknown tool: ${name}`, 'TOOL_NOT_FOUND')
}
function callTool(project, name, args) {
  validateToolCall(name, args)
  return invokeTool(project, name, args)
}
// Worker-side execution of an already validated call: the serialised result, or the error code and raw message
// (scrubbed by safeErrorMessage on the main thread exactly as for an inline call).
export function executeToolJob(project, name, args) {
  try {
    return { ok: true, json: JSON.stringify(toolResult(invokeTool(project, name, args), name)) }
  } catch (error) {
    const code = error?.code
    return { ok: false, error: { code: code === undefined || code === null || typeof code !== 'object' ? code : String(code), message: String(error?.message ?? error) } }
  }
}
function errorFromJob(error) {
  return Object.assign(new Error(error?.message ?? ''), { code: error?.code })
}
// Tools that write project state run alone in the pool; every other tool is read-only and may run in parallel.
const EXCLUSIVE_TOOLS = new Set([`${TOOL_PREFIX}proposal_create`])
const CONTEXT_MANIFEST = { [`${TOOL_PREFIX}context`]: false, [`${TOOL_PREFIX}context_get`]: false, [`${TOOL_PREFIX}context_manifest`]: true }
function canonicalArgs(value) {
  if (Array.isArray(value)) return value.map(canonicalArgs)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalArgs(value[key])]))
  return value
}
function linkDefaultLens(project) {
  try {
    return readLink(project).default_lens || null
  } catch {
    return null
  }
}
// Context calls are keyed by the options the selection cache key is built from (after mcpContextData applies its
// defaults), so equivalent spellings - omitted vs explicit defaults, context vs context_get - reach the same worker.
// `defaultLens` is read once when the session starts (the project is bound at startup); a link edited later only
// changes which worker a call is routed to, never what it returns.
function affinityKey(name, args = {}, defaultLens = null) {
  if (name in CONTEXT_MANIFEST)
    return JSON.stringify([
      'context',
      {
        task: args.task || '',
        lens: args.lens || defaultLens,
        budget: args.budget || 'standard',
        temporal: args.temporal || 'current',
        manifest: CONTEXT_MANIFEST[name],
        sources: args.source_ids || [],
        cursor: args.cursor || null,
        session_start: Boolean(args.session_start)
      }
    ])
  return JSON.stringify([name, canonicalArgs(args)])
}

function protocolError(code, message, data) {
  return { code, message, ...(data === undefined ? {} : { data }) }
}
function response(id, result, error) {
  return { jsonrpc: '2.0', id, ...(error ? { error } : { result }) }
}

// Opt-in verification audit (HOLOSELF_MCP_AUDIT_LOG, absolute path): one NDJSON line per tools/list and per
// tools/call with only the event, tool name, outcome, and error code. Arguments, results, and paths are never
// recorded; unknown tool names are recorded as 'unknown'. The log is never followed through a symlink, is kept at
// mode 0600 even when it already exists, and stops growing at maxBytes after one final audit_log_capped line.
const CAPPED_LINE = `${JSON.stringify({ event: 'audit_log_capped' })}\n`
function audit(logPath, entry, maxBytes = AUDIT_LOG_MAX_BYTES) {
  if (!logPath || !isAbsolute(logPath)) return
  let fd
  try {
    const noFollow = fsConstants.O_NOFOLLOW || 0
    if (!noFollow || process.platform === 'win32') {
      try {
        if (lstatSync(logPath).isSymbolicLink()) return
      } catch (error) {
        if (error.code !== 'ENOENT') return
      }
    }
    // O_RDWR (not O_WRONLY) so the tail can be checked for an existing cap marker.
    fd = openSync(logPath, fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_RDWR | noFollow, 0o600)
    const stat = fstatSync(fd)
    // A hard-linked log could append into another file the server has no business writing.
    if (!stat.isFile() || stat.nlink > 1) return
    if (process.platform !== 'win32')
      try {
        fchmodSync(fd, 0o600)
      } catch {
        // Best effort: a file owned by another user keeps its mode.
      }
    const line = `${JSON.stringify(entry)}\n`
    if (stat.size + Buffer.byteLength(line) <= maxBytes) {
      writeSync(fd, line)
      return
    }
    const tail = Buffer.alloc(Math.min(stat.size, Buffer.byteLength(CAPPED_LINE)))
    if (tail.length) readSync(fd, tail, 0, tail.length, stat.size - tail.length)
    if (tail.toString('utf8') !== CAPPED_LINE) writeSync(fd, CAPPED_LINE)
  } catch {
    // Auditing is diagnostic only; a failed append never changes the protocol response.
  } finally {
    if (fd !== undefined)
      try {
        closeSync(fd)
      } catch {}
  }
}
function auditToolCall(log, name, result) {
  const tool = MCP_TOOLS.some(item => item.name === name) ? name : 'unknown',
    error_code = result.isError ? result.structuredContent?.error?.code || 'HOLOSELF_ERROR' : null
  log({ at: new Date().toISOString(), event: 'tools/call', tool, ok: !result.isError, error_code })
}

// Without `pool`, tool calls run inline and each response is written before accept() returns (library and test
// use). With a pool (the stdio server), tools/call runs on a worker thread and its response is written when it
// settles; everything else is still answered synchronously. Responses are keyed by JSON-RPC id, never by order.
export function createMcpSession({
  project,
  write = line => process.stdout.write(`${line}\n`),
  auditLog = process.env.HOLOSELF_MCP_AUDIT_LOG,
  auditLogMaxBytes = AUDIT_LOG_MAX_BYTES,
  pool = null,
  maxPending = DEFAULT_MAX_PENDING_CALLS
} = {}) {
  const sessionLens = pool ? linkDefaultLens(project) : null
  let initialized = false,
    protocolVersion = null
  const log = entry => audit(auditLog, entry, auditLogMaxBytes),
    inFlight = new Map()
  let idle = []
  const idKey = id => JSON.stringify(id)
  function settled(key) {
    inFlight.delete(key)
    if (inFlight.size) return
    const waiters = idle
    idle = []
    for (const done of waiters) done()
  }
  function dispatch(request) {
    const name = request.params?.name,
      args = request.params?.arguments || {},
      key = idKey(request.id)
    try {
      validateToolCall(name, args)
    } catch (error) {
      const result = toolError(error)
      auditToolCall(log, name, result)
      write(JSON.stringify(response(request.id, result)))
      return
    }
    if (inFlight.size >= maxPending) {
      log({ at: new Date().toISOString(), event: 'tools/call', tool: name, ok: false, error_code: 'SERVER_BUSY' })
      write(JSON.stringify(response(request.id, null, protocolError(SERVER_BUSY_RPC_CODE, 'Server busy', { code: 'SERVER_BUSY' }))))
      return
    }
    const handle = pool.submit({ project, name, args }, { key: affinityKey(name, args, sessionLens), exclusive: EXCLUSIVE_TOOLS.has(name) })
    inFlight.set(key, handle)
    handle.promise.then(outcome => {
      settled(key)
      // A cancelled request gets no response (MCP cancellation) and never a partial packet.
      if (outcome.status === 'cancelled') return log({ at: new Date().toISOString(), event: 'tools/call', tool: name, ok: false, error_code: 'CANCELLED' })
      // A cancelled write that had already started ran to completion: record what it did, still send nothing.
      if (outcome.status === 'dropped') {
        const ok = Boolean(outcome.value?.ok)
        return log({ at: new Date().toISOString(), event: 'tools/call', tool: name, ok, cancelled: true, error_code: ok ? null : outcome.value?.error?.code || 'HOLOSELF_ERROR' })
      }
      if (outcome.status === 'timeout') {
        log({ at: new Date().toISOString(), event: 'tools/call', tool: name, ok: false, error_code: 'TOOL_TIMEOUT' })
        return write(JSON.stringify(response(request.id, null, protocolError(TOOL_TIMEOUT_RPC_CODE, 'Tool call timed out', { code: 'TOOL_TIMEOUT' }))))
      }
      if (outcome.status === 'ok' && outcome.value.ok) {
        log({ at: new Date().toISOString(), event: 'tools/call', tool: name, ok: true, error_code: null })
        // Same bytes as JSON.stringify(response(id, result)): the worker already serialised the result.
        return write(`{"jsonrpc":"2.0","id":${JSON.stringify(request.id)},"result":${outcome.value.json}}`)
      }
      const result = toolError(outcome.status === 'ok' ? errorFromJob(outcome.value.error) : new Error('worker stopped'))
      auditToolCall(log, name, result)
      write(JSON.stringify(response(request.id, result)))
    })
  }
  const accept = raw => {
    if (Buffer.byteLength(raw) > MAX_LINE_BYTES) {
      write(JSON.stringify(response(null, null, protocolError(-32600, 'Request exceeds 1 MiB'))))
      return
    }
    let request
    try {
      request = JSON.parse(raw)
    } catch {
      write(JSON.stringify(response(null, null, protocolError(-32700, 'Parse error'))))
      return
    }
    if (!request || Array.isArray(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      write(JSON.stringify(response(request?.id ?? null, null, protocolError(-32600, 'Invalid Request'))))
      return
    }
    if (request.id === undefined) {
      if (request.method === 'notifications/cancelled' && request.params?.requestId !== undefined)
        inFlight.get(idKey(request.params.requestId))?.cancel()
      return
    }
    // Ids identify responses, so no request may reuse the id of a call that has not been answered yet.
    if (inFlight.has(idKey(request.id))) {
      write(JSON.stringify(response(request.id, null, protocolError(-32600, 'Request id is already in progress'))))
      return
    }
    try {
      let result
      if (request.method === 'initialize') {
        const requested = request.params?.protocolVersion
        protocolVersion = PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0]
        initialized = true
        result = {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'holoself', title: 'Holoself local context', version: VERSION },
          instructions:
            'Use Holoself only when personal context can materially improve the task. The fixed project link controls ' +
            'access. Start with holoself_context_manifest, request only needed source handles, preserve provenance, and ' +
            'never treat readable content as publication approval. Durable self changes require a pending proposal and ' +
            'separate human approval outside MCP.'
        }
      } else if (request.method === 'ping') result = {}
      else if (!initialized) throw Object.assign(new Error('Server is not initialized'), { rpcCode: -32002 })
      else if (request.method === 'tools/list') {
        result = { tools: MCP_TOOLS }
        log({ at: new Date().toISOString(), event: 'tools/list', tools: MCP_TOOLS.length })
      } else if (request.method === 'tools/call') {
        if (pool) return dispatch(request)
        try {
          result = toolResult(callTool(project, request.params?.name, request.params?.arguments || {}), request.params?.name)
        } catch (error) {
          result = toolError(error)
        }
        auditToolCall(log, request.params?.name, result)
      } else throw Object.assign(new Error(`Method not found: ${request.method}`), { rpcCode: -32601 })
      write(JSON.stringify(response(request.id, result)))
    } catch (error) {
      write(JSON.stringify(response(request.id, null, protocolError(error.rpcCode || -32603, error.rpcCode ? error.message : 'Internal error'))))
    }
  }
  // Resolves once every dispatched tool call has written its response (or was cancelled).
  accept.drain = () => (inFlight.size ? new Promise(done => idle.push(done)) : Promise.resolve())
  accept.inFlight = () => inFlight.size
  return accept
}

function boundedInteger(value, fallback, min, max) {
  const number = Number(value)
  return value !== undefined && value !== '' && Number.isInteger(number) && number >= min && number <= max ? number : fallback
}
export function mcpServerLimits(env = process.env) {
  return {
    timeoutMs: boundedInteger(env.HOLOSELF_MCP_TOOL_TIMEOUT_MS, DEFAULT_TOOL_TIMEOUT_MS, 100, 3600000),
    concurrency: boundedInteger(env.HOLOSELF_MCP_CONCURRENCY, DEFAULT_TOOL_CONCURRENCY, 1, 8),
    maxPending: boundedInteger(env.HOLOSELF_MCP_MAX_PENDING, DEFAULT_MAX_PENDING_CALLS, 1, 65536),
    workerHeapMb: boundedInteger(env.HOLOSELF_MCP_WORKER_HEAP_MB, DEFAULT_WORKER_HEAP_MB, 64, 16384),
    writeTimeoutMs: boundedInteger(env.HOLOSELF_MCP_WRITE_TIMEOUT_MS, DEFAULT_WRITE_TIMEOUT_MS, 100, 86400000)
  }
}
export function createMcpToolPool({
  size = DEFAULT_TOOL_CONCURRENCY,
  timeoutMs = DEFAULT_TOOL_TIMEOUT_MS,
  writeTimeoutMs = DEFAULT_WRITE_TIMEOUT_MS,
  workerHeapMb = DEFAULT_WORKER_HEAP_MB,
  simulateWorkMs
} = {}) {
  if (!globalThis.__HOLOSELF_CURSOR_KEY__) globalThis.__HOLOSELF_CURSOR_KEY__ = randomBytes(32)
  return createToolPool({
    size,
    timeoutMs,
    writeTimeoutMs,
    maxOldGenerationSizeMb: workerHeapMb,
    workerData: { cursorKey: new Uint8Array(globalThis.__HOLOSELF_CURSOR_KEY__), ...(simulateWorkMs ? { simulateWorkMs } : {}) }
  })
}

// EOF shutdown: answer every accepted call, but never wait longer than `limitMs`. Past it (for example a write stuck
// behind the exclusive barrier), queued calls are cancelled without a response and the remaining workers are stopped.
export async function finishAtEof(session, pool, limitMs) {
  let timer
  const expired = new Promise(done => {
    timer = setTimeout(done, limitMs)
  })
  try {
    await Promise.race([session.drain(), expired])
  } finally {
    clearTimeout(timer)
    await pool.close()
  }
}

export async function startMcpServer({ project: projectInput, requireClaudeProject = false } = {}) {
  if (requireClaudeProject && !process.env.CLAUDE_PROJECT_DIR) fail('CLAUDE_PROJECT_DIR is required for this project-scoped server', 'PROJECT_BINDING_INVALID')
  const binding = resolveBoundProject(projectInput)
  const { timeoutMs, concurrency, maxPending, workerHeapMb, writeTimeoutMs } = mcpServerLimits()
  const pool = createMcpToolPool({ size: concurrency, timeoutMs, writeTimeoutMs, workerHeapMb })
  try {
    const session = createMcpSession({ project: binding.project, pool, maxPending })
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false })
    for await (const line of lines) if (line.trim()) session(line)
    // EOF: answer everything already accepted (bounded by the longest timeout), then stop the workers and exit.
    await finishAtEof(session, pool, Math.max(timeoutMs, writeTimeoutMs))
  } finally {
    await pool.close()
  }
}

export { resolveBoundProject }
