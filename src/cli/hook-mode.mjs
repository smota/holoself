// Host session-start hook mode (`holoself context ... --hook holoself-session-start`).
// Fail-open for the session: the process always exits 0 and writes nothing to stderr, so the host session starts.
// Fail-closed for privacy: stdout carries the packet only after full link/lens authority checks succeed; any error
// (revoked link, missing binding, missing self root, missing project, bad arguments) produces no output (or an empty
// injectSteps envelope for `--hook-format agy-json`).
import { existsSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { HOOK_ID } from '../adapters/hooks.mjs'
import { recordServedPacket } from '../ledger.mjs'
import { packetFormat } from '../render/packet.mjs'
import { contextData } from '../retrieval/context.mjs'
import { appendAuditLine } from '../shared/audit-log.mjs'
import { parseArguments } from './args.mjs'

// Claude Code persists hook output above 10,000 characters to a file and shows the model only a preview
// (threshold 1e4 in the 2.1.318 hook runner), so the hook packet is capped below it. Bytes >= characters.
export const HOOK_PACKET_MAX_BYTES = 9000
export const HOOK_FORMATS = ['text', 'agy-json']
export const AGY_EMPTY_ENVELOPE = '{"injectSteps":[]}\n'

export function isHookInvocation(argv) {
  return argv[0] === 'context' && argv.includes('--hook')
}

export function agyHookEnvelope(packetText) {
  return JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage: packetText } }] }) + '\n'
}

function requestedHookFormat(argv) {
  const index = argv.lastIndexOf('--hook-format')
  return index !== -1 && argv[index + 1] === 'agy-json' ? 'agy-json' : 'text'
}

// The project comes from --project, else the host's CLAUDE_PROJECT_DIR environment variable (Claude Code), else the
// process working directory (Codex runs in the project root; AGY runs in the directory of <workspace>/.agents/hooks.json).
// The resolved path must always be absolute.
export function hookProject(o, env = process.env, cwd = process.cwd()) {
  if (o.project !== undefined || o.projectRaw !== undefined) {
    const raw = (o.projectRaw ?? o.project ?? '').trim()
    return raw && isAbsolute(raw) ? resolve(raw) : null
  }
  if (env.CLAUDE_PROJECT_DIR !== undefined) {
    const fromEnv = String(env.CLAUDE_PROJECT_DIR).trim()
    return fromEnv && isAbsolute(fromEnv) ? resolve(fromEnv) : null
  }
  const dir = typeof cwd === 'string' ? cwd.trim() : ''
  if (!dir || !isAbsolute(dir)) return null
  const resolved = resolve(dir)
  if (
    ['.agents', '.codex', '.claude'].includes(basename(resolved)) &&
    !existsSync(join(resolved, '.holoself', 'link.yaml')) &&
    existsSync(join(dirname(resolved), '.holoself', 'link.yaml'))
  )
    return dirname(resolved)
  return resolved
}

// Resolves the session-start packet for a hook; throws on any refusal.
export function hookContext(o, env = process.env, cwd = process.cwd()) {
  const refuse = (code, message) => Object.assign(new Error(message), { code })
  if (o.hook !== HOOK_ID) throw refuse('HOOK_ID_UNKNOWN', `unknown hook id: ${o.hook}`)
  const hookFormat = o.hookFormat || 'text'
  if (!HOOK_FORMATS.includes(hookFormat)) throw refuse('HOOK_OPTION_REFUSED', `unsupported hook format: ${hookFormat}`)
  const project = hookProject(o, env, cwd)
  if (!project) throw refuse('HOOK_PROJECT_REQUIRED', 'hook mode requires an absolute --project, CLAUDE_PROJECT_DIR, or working directory')
  if (o.output || o.snapshot || o.json || o.task || o.need || o.manifest || o.cursor || o.sources?.length || o.restrictedHost)
    throw refuse('HOOK_OPTION_REFUSED', 'hook mode emits only the live session-start packet')
  if (o.format && o.format !== 'packet') throw refuse('HOOK_OPTION_REFUSED', 'hook mode emits only the packet format')
  const buildPacket = capBytes => {
    const data = contextData({ ...o, project, sessionStart: true, envelopeCapBytes: capBytes }),
      packet = packetFormat(data, o.adapter || 'packet').trimEnd(),
      content = hookFormat === 'agy-json' ? agyHookEnvelope(packet) : packet + '\n'
    return { data, packet, content }
  }
  let { data, packet, content } = buildPacket(HOOK_PACKET_MAX_BYTES)
  if (hookFormat === 'agy-json' && Buffer.byteLength(content) > HOOK_PACKET_MAX_BYTES) {
    const overhead = Buffer.byteLength(content) - Buffer.byteLength(packet) + 64
    ;({ data, packet, content } = buildPacket(Math.max(1024, HOOK_PACKET_MAX_BYTES - overhead)))
  }
  if (Buffer.byteLength(content) > HOOK_PACKET_MAX_BYTES) throw refuse('HOOK_PACKET_TOO_LARGE', 'session-start packet exceeds the hook output cap')
  recordServedPacket({
    data,
    project,
    surface: 'hook',
    mode: 'packet',
    env,
    onFailure: err =>
      appendAuditLine(env.HOLOSELF_HOOK_AUDIT_LOG, {
        event: 'ledger/write',
        hook_id: HOOK_ID,
        at: new Date().toISOString(),
        ok: false,
        error_code: err.code
      })
  })
  return { data, content }
}

// Opt-in local audit (HOLOSELF_HOOK_AUDIT_LOG, absolute path): one line per run with outcome, error code and receipt;
// no content or paths. Written through the hardened shared audit writer.
function auditHook(entry) {
  appendAuditLine(process.env.HOLOSELF_HOOK_AUDIT_LOG, {
    event: 'session-start-hook',
    hook_id: HOOK_ID,
    at: new Date().toISOString(),
    ...entry
  })
}

export async function runHookInvocation(argv) {
  const quiet = () => {},
    saved = { log: console.log, error: console.error, warn: console.warn, info: console.info },
    format = requestedHookFormat(argv)
  Object.assign(console, { log: quiet, error: quiet, warn: quiet, info: quiet })
  let result = null
  try {
    result = hookContext(parseArguments(argv))
    auditHook({ ok: true, code: null, packet_id: result.data.packet_metadata.packet_id, receipt: result.data.context_receipt.context_hash })
  } catch (error) {
    auditHook({ ok: false, code: typeof error?.code === 'string' ? error.code : 'ERROR', packet_id: null, receipt: null })
  } finally {
    Object.assign(console, saved)
  }
  const output = result ? result.content : format === 'agy-json' ? AGY_EMPTY_ENVELOPE : ''
  if (output) {
    process.stdout.on('error', () => {})
    try {
      process.stdout.write(output)
    } catch {}
  }
  process.exitCode = 0
}
