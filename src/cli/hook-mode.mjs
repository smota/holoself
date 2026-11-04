// Host session-start hook mode (`holoself context ... --hook holoself-session-start`).
// Fail-open for the session: the process always exits 0 and writes nothing to stderr, so the host session starts.
// Fail-closed for privacy: stdout carries the packet only after full link/lens authority checks succeed; any error
// (revoked link, missing binding, missing self root, missing project, bad arguments) produces no output at all.
import { isAbsolute } from 'node:path'
import { HOOK_ID } from '../adapters/hooks.mjs'
import { recordServedPacket } from '../ledger.mjs'
import { packetFormat } from '../render/packet.mjs'
import { contextData } from '../retrieval/context.mjs'
import { appendAuditLine } from '../shared/audit-log.mjs'
import { parseArguments } from './args.mjs'

// Claude Code persists hook output above 10,000 characters to a file and shows the model only a preview
// (threshold 1e4 in the 2.1.318 hook runner), so the hook packet is capped below it. Bytes >= characters.
export const HOOK_PACKET_MAX_BYTES = 9000

export function isHookInvocation(argv) {
  return argv[0] === 'context' && argv.includes('--hook')
}

// The project comes from --project or, without it, from the host's CLAUDE_PROJECT_DIR environment variable,
// so the installed command needs no shell expansion (Windows hosts may not run hooks through a POSIX shell).
function hookProject(o, env) {
  const project = o.project || env.CLAUDE_PROJECT_DIR || ''
  return project.trim() && isAbsolute(project) ? project : null
}

// Resolves the session-start packet for a hook; throws on any refusal.
export function hookContext(o, env = process.env) {
  const refuse = (code, message) => Object.assign(new Error(message), { code })
  if (o.hook !== HOOK_ID) throw refuse('HOOK_ID_UNKNOWN', `unknown hook id: ${o.hook}`)
  const project = hookProject(o, env)
  if (!project) throw refuse('HOOK_PROJECT_REQUIRED', 'hook mode requires --project or an absolute CLAUDE_PROJECT_DIR')
  if (o.output || o.snapshot || o.json || o.task || o.manifest || o.cursor || o.sources?.length || o.restrictedHost)
    throw refuse('HOOK_OPTION_REFUSED', 'hook mode emits only the live session-start packet')
  if (o.format && o.format !== 'packet') throw refuse('HOOK_OPTION_REFUSED', 'hook mode emits only the packet format')
  const options = { ...o, project, sessionStart: true, envelopeCapBytes: HOOK_PACKET_MAX_BYTES },
    data = contextData(options),
    content = packetFormat(data, o.adapter || 'packet').trimEnd() + '\n'
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
    saved = { log: console.log, error: console.error, warn: console.warn, info: console.info }
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
  if (result) {
    process.stdout.on('error', () => {})
    try {
      process.stdout.write(result.content)
    } catch {}
  }
  process.exitCode = 0
}
