import { randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline'
import { existsSync, lstatSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import {
  holoselfMcpContext,
  holoselfMcpCreateProposal,
  holoselfMcpPreviewProposal,
  holoselfMcpSearch,
  holoselfMcpStatus,
  mcpToolEnvelope,
  PROPOSAL_OPERATIONS,
  PROPOSAL_TYPES,
  VISIBILITIES
} from './ecosystem.mjs'
import { attestClient, resolveClientSelf } from './clients/attestation.mjs'
import { readLink } from './link/config.mjs'
import { HARVEST_PROMPT_NAME, HARVEST_PROMPT_TEXT, HARVEST_PROMPT_VERSION, harvestPromptText, validateHarvestPromptArgs } from './instructions.mjs'
import { recordServedPacket } from './ledger.mjs'
import { createToolPool } from './mcp-pool.mjs'
import { clientMcpContextData, clientMcpCreateProposal, clientMcpPreviewProposal, clientMcpSearch, clientMcpStatus } from './retrieval/client-mcp.mjs'
import { AUDIT_LOG_MAX_BYTES, appendAuditLine } from './shared/audit-log.mjs'
import { VERSION } from './version.mjs'

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26']
const TOOL_PREFIX = 'holoself_'
const MAX_LINE_BYTES = 1024 * 1024
const MAX_RESULT_BYTES = 512 * 1024
const TEMPORAL = ['current', 'historical', 'superseded', 'all']
const BUDGETS = ['small', 'standard', 'deep']
const NEEDS = ['required', 'helpful', 'not-needed']
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
const needProperty = {
  type: 'string',
  enum: NEEDS,
  description: 'Explicit context-need override; overrides task keyword classification.'
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
        need: needProperty,
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
    inputSchema: objectSchema({ ...baseContextProperties, need: needProperty }),
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
    description:
      'Create a project-local pending proposal backed by contained project evidence. It never writes canonical self. ' +
      'operation append_claim (default) adds a claim; replace_claim, supersede_claim and retire_claim target an existing ' +
      'claim by the claim_id shown in delivered context and require evidence.',
    inputSchema: objectSchema(
      {
        operation: {
          type: 'string',
          enum: PROPOSAL_OPERATIONS,
          default: 'append_claim',
          description: 'append_claim and the claim operations replace_claim, supersede_claim (keeps the old claim as history) and retire_claim (marks it historical).'
        },
        claim: { type: 'string', minLength: 1, maxLength: 4000, description: 'Claim wording; required except for retire_claim.' },
        claim_id: {
          type: 'string',
          pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
          description: 'Id of the existing claim (the id= attribute of a holoself-claim block in delivered context); required for replace_claim, supersede_claim and retire_claim.'
        },
        reason: { type: 'string', minLength: 1, maxLength: 500, pattern: '^[^\\r\\n]+$', description: 'Single-line retirement reason; required for retire_claim.' },
        evidence: { type: 'string', minLength: 1, maxLength: 4000 },
        source_files: { type: 'array', minItems: 1, maxItems: 8, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 500 } },
        target: { type: 'string', minLength: 1, maxLength: 500, default: 'context/claims.md' },
        proposal_type: { type: 'string', enum: PROPOSAL_TYPES },
        confidence: { type: 'string', minLength: 1, maxLength: 120, default: 'unverified' },
        visibility: { type: 'string', enum: VISIBILITIES }
      },
      ['source_files']
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

// Unlinked client mode (`mcp --client <id> --root <self>`): the same tool names with client-scoped descriptions. The
// proposal tools append only to existing lens-visible documents and require evidence; they are listed only when the
// client's proposal mode is `inbox` at startup, and every call re-checks the mode.
const byName = name => MCP_TOOLS.find(tool => tool.name === name)
const withText = (tool, description, inputSchema = tool.inputSchema) => ({ ...tool, description, inputSchema })
export const CLIENT_READ_TOOLS = [
  withText(
    byName(`${TOOL_PREFIX}status`),
    'Check this desktop client grant (client name, its one lens and proposal mode) and context health without revealing local paths.'
  ),
  withText(
    byName(`${TOOL_PREFIX}context`),
    'Resolve and deliver privacy-filtered self context under this client lens for the current task in a single round-trip. ' +
      'Manifest and get remain optional for fine-grained inspection.'
  ),
  byName(`${TOOL_PREFIX}context_manifest`),
  withText(byName(`${TOOL_PREFIX}context_get`), 'Resolve only the requested manifest source handles through the client lens, lifecycle, and privacy gates.'),
  withText(byName(`${TOOL_PREFIX}search`), 'Search the deterministic local privacy-filtered self index under this client lens.')
]
export const CLIENT_PROPOSAL_TOOLS = [
  withText(
    byName(`${TOOL_PREFIX}proposal_create`),
    'Create a pending proposal in the owner review inbox that appends one claim to an existing document readable under this ' +
      'client lens. Evidence text is required. It never writes canonical self; only the owner approves it outside MCP.',
    objectSchema(
      {
        claim: { type: 'string', minLength: 1, maxLength: 4000, description: 'Claim wording to append.' },
        evidence: { type: 'string', minLength: 1, maxLength: 4000, description: 'Why this claim is true; the only basis the owner has for review.' },
        target: { type: 'string', minLength: 1, maxLength: 500, default: 'context/claims.md' },
        proposal_type: { type: 'string', enum: PROPOSAL_TYPES },
        confidence: { type: 'string', minLength: 1, maxLength: 120, default: 'unverified' },
        visibility: { type: 'string', enum: VISIBILITIES }
      },
      ['claim', 'evidence']
    )
  ),
  withText(
    byName(`${TOOL_PREFIX}proposal_preview`),
    'Preview the exact canonical changes and digest for one of this client pending inbox proposals without applying or approving it.'
  )
]
const CLIENT_TOOLS = [...CLIENT_READ_TOOLS, ...CLIENT_PROPOSAL_TOOLS]
export const MCP_PROMPTS = [
  {
    name: HARVEST_PROMPT_NAME,
    title: 'Holoself session harvest',
    description: 'Review the session and draft 0–3 evidence-backed pending proposals without writing canonical self.',
    arguments: [
      {
        name: 'focus',
        description: 'Optional topic or area to focus on when reviewing the session (at most 200 characters).',
        required: false
      }
    ]
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
function validateToolCall(name, args, tools = MCP_TOOLS) {
  const tool = tools.find(item => item.name === name)
  if (!tool) fail(`unknown tool: ${name}`, 'TOOL_NOT_FOUND')
  validateObject(args || {}, tool.inputSchema)
}
function invokeClientTool(client, name, args) {
  if (name === `${TOOL_PREFIX}status`) return clientMcpStatus(client)
  if (name === `${TOOL_PREFIX}context`) return clientMcpContextData(client, { ...args, manifest: false })
  if (name === `${TOOL_PREFIX}context_manifest`) return clientMcpContextData(client, { ...args, manifest: true })
  if (name === `${TOOL_PREFIX}context_get`) return clientMcpContextData(client, { ...args, manifest: false })
  if (name === `${TOOL_PREFIX}search`) return clientMcpSearch(client, args)
  if (name === `${TOOL_PREFIX}proposal_create`) return clientMcpCreateProposal(client, args)
  if (name === `${TOOL_PREFIX}proposal_preview`) return clientMcpPreviewProposal(client, args.proposal_id)
  fail(`unknown tool: ${name}`, 'TOOL_NOT_FOUND')
}
function validatePromptRequest(params) {
  if (!params || Array.isArray(params) || typeof params !== 'object') fail('params must be an object', 'INVALID_ARGUMENT')
  for (const key of Object.keys(params)) {
    if (!['name', 'arguments', '_meta'].includes(key)) fail(`params.${key} is not allowed`, 'INVALID_ARGUMENT')
  }
  if (typeof params.name !== 'string' || !params.name) fail('params.name must be a non-empty string', 'INVALID_ARGUMENT')
}
function getPrompt(name, args, prompts = MCP_PROMPTS) {
  const prompt = prompts.find(item => item.name === name)
  if (!prompt) fail(`unknown prompt: ${name}`, 'PROMPT_NOT_FOUND')
  const text = harvestPromptText(args === undefined ? {} : args)
  return {
    description: prompt.description,
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text
        }
      }
    ]
  }
}
function invokeTool(project, name, args, client = null) {
  if (client) return invokeClientTool(client, name, args)
  if (name === `${TOOL_PREFIX}status`) return holoselfMcpStatus(project)
  if (name === `${TOOL_PREFIX}context`) return holoselfMcpContext(project, { ...args, manifest: false })
  if (name === `${TOOL_PREFIX}context_manifest`) return holoselfMcpContext(project, { ...args, manifest: true })
  if (name === `${TOOL_PREFIX}context_get`) return holoselfMcpContext(project, { ...args, manifest: false })
  if (name === `${TOOL_PREFIX}search`) return holoselfMcpSearch(project, args)
  if (name === `${TOOL_PREFIX}proposal_create`) return holoselfMcpCreateProposal(project, args)
  if (name === `${TOOL_PREFIX}proposal_preview`) return holoselfMcpPreviewProposal(project, args.proposal_id)
  fail(`unknown tool: ${name}`, 'TOOL_NOT_FOUND')
}
function callTool(project, name, args, client = null) {
  validateToolCall(name, args, client ? CLIENT_TOOLS : MCP_TOOLS)
  if (client) attestClient(client.self, client.client_id)
  return invokeTool(project, name, args, client)
}
// Worker-side execution of an already validated call: the serialised result, or the error code and raw message
// (scrubbed by safeErrorMessage on the main thread exactly as for an inline call).
// In client mode `client` ({ self, client_id }) replaces the project; the worker attests it again on every call.
export function executeToolJob(project, name, args, client = null) {
  try {
    return { ok: true, json: JSON.stringify(toolResult(invokeTool(project, name, args, client), name)) }
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
        need: args.need || null,
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
// recorded; unknown tool names are recorded as 'unknown'. The hardened writer is src/shared/audit-log.mjs.
const audit = appendAuditLine
function auditToolCall(log, name, result) {
  const tool = MCP_TOOLS.some(item => item.name === name) ? name : 'unknown',
    error_code = result.isError ? result.structuredContent?.error?.code || 'HOLOSELF_ERROR' : null
  log({ at: new Date().toISOString(), event: 'tools/call', tool, ok: !result.isError, error_code })
}
function auditPromptGet(log, rawName, error = null) {
  const prompt = MCP_PROMPTS.some(item => item.name === rawName) ? rawName : 'unknown',
    error_code = error ? error.code || 'HOLOSELF_ERROR' : null
  log({ at: new Date().toISOString(), event: 'prompts/get', prompt, name: prompt, ok: !error, error_code })
}

// Without `pool`, tool calls run inline and each response is written before accept() returns (library and test
// use). With a pool (the stdio server), tools/call runs on a worker thread and its response is written when it
// settles; everything else is still answered synchronously. Responses are keyed by JSON-RPC id, never by order.
export function createMcpSession({
  project,
  client = null,
  write = line => process.stdout.write(`${line}\n`),
  auditLog = process.env.HOLOSELF_MCP_AUDIT_LOG,
  auditLogMaxBytes = AUDIT_LOG_MAX_BYTES,
  pool = null,
  maxPending = DEFAULT_MAX_PENDING_CALLS
} = {}) {
  // Client mode: the identity and the proposal mode shown in tools/list are fixed at startup; every call re-attests.
  const startupClient = client ? attestClient(client.self, client.client_id) : null,
    sessionTools = client ? [...CLIENT_READ_TOOLS, ...(startupClient.proposals === 'inbox' ? CLIENT_PROPOSAL_TOOLS : [])] : MCP_TOOLS,
    validationTools = client ? CLIENT_TOOLS : MCP_TOOLS,
    // The session-harvest prompt drafts project-evidence proposals, so an unlinked client lists no prompts.
    sessionPrompts = client ? [] : MCP_PROMPTS
  const sessionLens = client ? startupClient.lens : pool ? linkDefaultLens(project) : null
  let initialized = false,
    protocolVersion = null,
    clientHost = null
  const log = entry => audit(auditLog, entry, auditLogMaxBytes),
    inFlight = new Map()
  let idle = []
  const idKey = id => JSON.stringify(id)
  function recordMcpLedger(name, packetData) {
    if (!CONTEXT_TOOLS.has(name) || !packetData) return
    const mode = name === `${TOOL_PREFIX}context_manifest` ? 'manifest' : name === `${TOOL_PREFIX}context_get` ? 'get' : 'packet'
    recordServedPacket({
      data: packetData,
      ...(client ? { self: client.self, clientId: client.client_id } : { project }),
      surface: 'mcp',
      mode,
      clientInfoName: clientHost,
      onFailure: err => log({ at: new Date().toISOString(), event: 'ledger/write', tool: name, ok: false, error_code: err.code })
    })
  }
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
      validateToolCall(name, args, validationTools)
      // Revocation and lens edits take effect on the next call: the main thread re-reads the registry for each call
      // and the worker attests again before running the tool.
      if (client) attestClient(client.self, client.client_id)
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
    const handle = pool.submit({ project, client, name, args }, { key: affinityKey(name, args, sessionLens), exclusive: EXCLUSIVE_TOOLS.has(name) })
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
        if (client) {
          try {
            attestClient(client.self, client.client_id)
          } catch (error) {
            const result = toolError(error)
            auditToolCall(log, name, result)
            return write(JSON.stringify(response(request.id, result)))
          }
        }
        log({ at: new Date().toISOString(), event: 'tools/call', tool: name, ok: true, error_code: null })
        if (CONTEXT_TOOLS.has(name)) {
          try {
            recordMcpLedger(name, JSON.parse(outcome.value.json)?.structuredContent?.data)
          } catch {}
        }
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
        clientHost = typeof request.params?.clientInfo?.name === 'string' ? request.params.clientInfo.name : null
        initialized = true
        result = {
          protocolVersion,
          capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
          serverInfo: { name: 'holoself', title: 'Holoself local context', version: VERSION },
          instructions: client
            ? 'Use Holoself only when personal context can materially improve the task. This desktop client is bound by ' +
              'the owner to one lens; tool arguments cannot change it. Start with holoself_context_manifest, request only ' +
              'needed source handles, preserve provenance, and never treat readable content as publication approval. ' +
              'Durable self changes require separate human approval outside MCP.'
            : 'Use Holoself only when personal context can materially improve the task. The fixed project link controls ' +
              'access. Start with holoself_context_manifest, request only needed source handles, preserve provenance, and ' +
              'never treat readable content as publication approval. Durable self changes require a pending proposal and ' +
              'separate human approval outside MCP.'
        }
      } else if (request.method === 'ping') result = {}
      else if (!initialized) throw Object.assign(new Error('Server is not initialized'), { rpcCode: -32002 })
      else if (request.method === 'prompts/list') {
        result = { prompts: sessionPrompts }
        log({ at: new Date().toISOString(), event: 'prompts/list', prompts: sessionPrompts.length })
      } else if (request.method === 'prompts/get') {
        try {
          validatePromptRequest(request.params)
          result = getPrompt(request.params.name, request.params.arguments, sessionPrompts)
          auditPromptGet(log, request.params.name, null)
        } catch (error) {
          auditPromptGet(log, request.params?.name, error)
          write(JSON.stringify(response(request.id, null, protocolError(-32602, safeErrorMessage(error), { code: error.code || 'INVALID_ARGUMENT' }))))
          return
        }
      } else if (request.method === 'tools/list') {
        result = { tools: sessionTools }
        log({ at: new Date().toISOString(), event: 'tools/list', tools: sessionTools.length })
      } else if (request.method === 'tools/call') {
        if (pool) return dispatch(request)
        try {
          result = toolResult(callTool(project, request.params?.name, request.params?.arguments || {}, client), request.params?.name)
        } catch (error) {
          result = toolError(error)
        }
        auditToolCall(log, request.params?.name, result)
        if (!result.isError) recordMcpLedger(request.params?.name, result.structuredContent?.data)
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

// Client binding for `mcp --client <id> [--root <self>]`: never mixed with a project binding, never discovered from the
// working directory. An unknown or revoked client (or an invalid lens) stops the server before it reads stdin.
export function resolveClientBinding({ client, root, project = null, requireClaudeProject = false, env = process.env } = {}) {
  if (project || requireClaudeProject || (typeof env.CLAUDE_PROJECT_DIR === 'string' && env.CLAUDE_PROJECT_DIR.trim()))
    fail('--client cannot be combined with --project, --claude-project-dir or CLAUDE_PROJECT_DIR', 'CLIENT_BINDING_CONFLICT')
  const self = resolveClientSelf(root || env.HOLOSELF_HOME || join(homedir(), '.holoself'))
  const entry = attestClient(self, client)
  return { self, client_id: entry.client_id }
}

export async function startMcpServer({ project: projectInput, client: clientInput = null, root = null, requireClaudeProject = false } = {}) {
  const client = clientInput ? resolveClientBinding({ client: clientInput, root, project: projectInput, requireClaudeProject }) : null
  if (!client && requireClaudeProject && !process.env.CLAUDE_PROJECT_DIR)
    fail('CLAUDE_PROJECT_DIR is required for this project-scoped server', 'PROJECT_BINDING_INVALID')
  const binding = client ? { project: null } : resolveBoundProject(projectInput)
  const { timeoutMs, concurrency, maxPending, workerHeapMb, writeTimeoutMs } = mcpServerLimits()
  const pool = createMcpToolPool({ size: concurrency, timeoutMs, writeTimeoutMs, workerHeapMb })
  try {
    const session = createMcpSession({ project: binding.project, client, pool, maxPending })
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false })
    for await (const line of lines) if (line.trim()) session(line)
    // EOF: answer everything already accepted (bounded by the longest timeout), then stop the workers and exit.
    await finishAtEof(session, pool, Math.max(timeoutMs, writeTimeoutMs))
  } finally {
    await pool.close()
  }
}

export { HARVEST_PROMPT_NAME, HARVEST_PROMPT_TEXT, HARVEST_PROMPT_VERSION, harvestPromptText, resolveBoundProject, validateHarvestPromptArgs }
