// Host session-start hook mode (`holoself context ... --hook holoself-session-start`).
// Fail-open for the session: the process always exits 0 and writes nothing to stderr, so the host session starts.
// Fail-closed for privacy: stdout carries the packet only after full link/lens authority checks succeed; any error
// (revoked link, missing binding, missing self root, bad arguments) produces no output at all.
import { appendFileSync } from 'node:fs'
import { HOOK_ID } from '../adapters/hooks.mjs'
import { packetFormat } from '../render/packet.mjs'
import { contextData } from '../retrieval/context.mjs'
import { parseArguments } from './args.mjs'

export function isHookInvocation(argv) {
  return argv[0] === 'context' && argv.includes('--hook')
}

// Resolves the session-start packet for a hook; throws on any refusal.
export function hookContext(o) {
  const refuse = (code, message) => Object.assign(new Error(message), { code })
  if (o.hook !== HOOK_ID) throw refuse('HOOK_ID_UNKNOWN', `unknown hook id: ${o.hook}`)
  if (!o.project) throw refuse('HOOK_PROJECT_REQUIRED', 'hook mode requires --project <linked-project>')
  if (o.output || o.snapshot || o.json || o.task || o.manifest || o.cursor || o.sources?.length)
    throw refuse('HOOK_OPTION_REFUSED', 'hook mode emits only the session-start packet')
  const data = contextData({ ...o, sessionStart: true }),
    content = packetFormat(data, o.adapter || o.format || 'packet')
  return { data, content: content.trimEnd() + '\n' }
}

// Opt-in local audit (HOLOSELF_HOOK_AUDIT_LOG): one line per run with outcome, error code and receipt; no content or paths.
function auditHook(entry) {
  const file = process.env.HOLOSELF_HOOK_AUDIT_LOG
  if (!file) return
  try {
    appendFileSync(file, JSON.stringify({ event: 'session-start-hook', hook_id: HOOK_ID, at: new Date().toISOString(), ...entry }) + '\n')
  } catch {}
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
