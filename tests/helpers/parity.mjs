// Packet-parity harness for the ecosystem module split (issue #58).
//
// Builds a synthetic self root and a linked project inside a fresh temporary directory, runs a
// representative matrix through the public entry points (the `holoself` CLI binary and the stdio
// MCP server, both as child processes), and normalises volatile fields so the result can be
// compared byte-for-byte with tests/fixtures/parity/golden.json.
//
// Volatile fields replaced by the normaliser (see normalise() below):
//   - the fixture temporary root -> <ROOT> and the repository checkout -> <REPO> (e.g. the
//     invoked bin path in link status); each as given and realpath'd, with forward or back
//     slashes, plus lowercase forms on win32
//   - ISO-8601 timestamps, including dash forms in generated file names -> <TIME>
//   - UUIDs (proposal ids, packet ids) -> <UUID:n>, numbered by first appearance per case
//   - hexadecimal values under the JSON keys in VOLATILE_HEX_KEYS (random salts and secrets,
//     path-derived ids, cache keys, registry hashes) -> <HEX:n>, numbered by first appearance per
//     case; the same values are masked wherever else they appear (plain-text packets, cursor
//     payloads). All other digests are content-derived and kept verbatim.
//   - pagination cursors (base64url { p, sig }) -> decoded payload kept, HMAC signature -> <HMAC>
//     (the cursor secret is random per self root); undecodable cursors -> <CURSOR>
//   - duration / elapsed-time keys (duration, elapsed, took, *_duration_ms) -> <DURATION>
//   - file modification-time keys (mtime, mtime_ms, mtimeMs, *_mtime) -> <MTIME>
// Normalisation is applied to parsed JSON string leaves (JSON stdout and JSON-line MCP output) or
// to raw text (packet formats, YAML, messages). Byte and token counts are kept verbatim: linked
// output carries only root-relative paths, and the path-independence test runs one fixture under
// a longer base directory, which also fails if a volatile digest escapes the masking rules.
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../..', import.meta.url))
const bin = join(repo, 'bin', 'holoself.mjs')
const meta = (lenses, extra = '') => `---\naccess_lenses: [${lenses.join(', ')}]\ndisclosure: internal-only\nsensitivity: personal\ndocument_role: content\n${extra}---\n`

export async function buildParityFixture({ baseDir = tmpdir() } = {}) {
  const root = await mkdtemp(join(baseDir, 'holoself-parity-'))
  const self = join(root, 'self'), project = join(root, 'project'), home = join(root, 'home')
  await Promise.all([self, project, home].map(path => mkdir(path)))
  const env = cleanEnv(home)
  const log = []
  const cli = (name, args, extra = {}) => {
    const result = spawnSync(process.execPath, [bin, ...args], { cwd: extra.cwd || project, env, input: extra.input || '', encoding: 'utf8', windowsHide: true })
    log.push({ name, args, status: result.status, stdout: result.stdout, stderr: result.stderr })
    return result
  }
  return { root, self, project, home, env, cli, log, cleanup: () => rm(root, { recursive: true, force: true }) }
}

function cleanEnv(home) {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) if (!/^(HOLOSELF_|CLAUDE|CODEX|OPENRIG|MESHLOOP)/i.test(key)) env[key] = value
  return { ...env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), NO_COLOR: '1', TZ: 'UTC' }
}

export async function seedParityFixture(fx) {
  const { self, project } = fx
  fx.cli('init', ['init', '--root', self])
  await mkdir(join(self, 'lenses'), { recursive: true })
  await writeFile(join(self, 'lenses', 'spiritual.json'), JSON.stringify({ schema_version: 1, id: 'spiritual', title: 'Synthetic spiritual perspective' }, null, 2))
  await writeFile(join(self, 'profile', 'identity.md'), meta(['general', 'professional', 'leadership', 'private']) + '# Identity\n\nPARITY_IDENTITY I am a synthetic engineer who values careful refactoring.\n\n## Priorities\n\n- Ship small, reviewable changes. #craft\n- Keep behaviour stable during refactors.\n')
  await writeFile(join(self, 'context', 'career-plan.md'), meta(['general', 'leadership']) + '# Career plan\n\nPARITY_CAREER Move toward staff engineering through architecture work.\n\n## Evidence\n\nLed the module split of a large file without behaviour change.\n')
  await writeFile(join(self, 'context', 'collaboration.md'), meta(['general', 'professional']) + '# Collaboration preferences\n\nPARITY_COLLAB Prefer written design notes before large changes.\nSee [identity](../profile/identity.md).\n')
  await writeFile(join(self, 'context', 'restricted.md'), '---\naccess_lenses: [private]\ndisclosure: internal-only\nsensitivity: restricted\ndocument_role: content\n---\n# Restricted\n\nPARITY_FORBIDDEN_RESTRICTED must never appear in linked output.\n')
  for (let index = 0; index < 14; index++) {
    const id = String(index).padStart(2, '0')
    await writeFile(join(self, 'context', `note-${id}.md`), meta(['general']) + `# Note ${id}\n\nPARITY_NOTE_${id} refactoring planning detail ${'with steady wording '.repeat(index + 2)}\n`)
  }
  fx.cli('link add', ['link', 'add', '--project', project, '--self', self, '--lens', 'general', '--secondary-lenses', 'leadership', '--no-activate', '--yes'])
  await writeFile(join(project, 'NOTES.md'), '# Project notes\n\nPARITY_PROJECT_NOTE This project prefers small reviewable refactors.\n')
}

export function runParityMatrix(fx) {
  const { project, self } = fx
  const p = ['--project', project]
  const cases = []
  const add = (name, args, extra) => { const r = fx.cli(name, args, extra); cases.push({ name, args, status: r.status, stdout: r.stdout, stderr: r.stderr }); return r }
  add('validate', ['validate', '--root', self])
  add('link status --json', ['link', 'status', ...p, '--json'])
  for (const budget of ['small', 'standard', 'deep']) add(`context general ${budget}`, ['context', ...p, '--lens', 'general', '--task', 'plan refactoring work', '--budget', budget, '--json'])
  add('context leadership task', ['context', ...p, '--lens', 'leadership', '--task', 'next career step toward staff engineering', '--json'])
  add('context no task', ['context', ...p, '--json'])
  add('context ungranted lens', ['context', ...p, '--lens', 'private', '--json'])
  add('context session-start', ['context', ...p, '--session-start', '--json'])
  const manifest = add('context manifest page 1', ['context', ...p, '--manifest', '--budget', 'small', '--json'])
  let cursor = null
  try { cursor = JSON.parse(manifest.stdout).selection.next_cursor || null } catch {}
  if (cursor) add('context manifest page 2', ['context', ...p, '--manifest', '--budget', 'small', '--cursor', cursor, '--json'])
  else cases.push({ name: 'context manifest page 2', skipped: 'no cursor in page 1' })
  for (const adapter of ['generic', 'claude', 'codex', 'restricted-host']) add(`context packet ${adapter}`, ['context', ...p, '--task', 'plan refactoring work', '--format', 'packet', '--adapter', adapter])
  add('search', ['search', 'refactoring', ...p])
  add('propose', ['propose', ...p, '--claim', 'Prefers small reviewable refactors', '--source-file', 'NOTES.md'])
  add('proposals list', ['proposals', 'list', ...p])
  let proposalId = null
  try { proposalId = JSON.parse(cases.at(-2).stdout).proposal_id } catch {}
  if (proposalId) add('proposals show', ['proposals', 'show', proposalId, ...p])
  add('mcp', ['mcp', ...p], { input: mcpInput() })
  return cases
}

function mcpInput() {
  const lines = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'parity', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'holoself_context', arguments: { task: 'plan refactoring work', budget: 'small' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'holoself_context', arguments: { lens: 'leadership', task: 'next career step', budget: 'standard' } } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'holoself_context', arguments: { lens: 'private' } } }
  ]
  return lines.map(line => JSON.stringify(line)).join('\n') + '\n'
}

// JSON keys whose hexadecimal values are volatile: random per run, or derived from absolute paths.
// Every other digest (source ids, content sha256/source_hash, revisions, lens_registry_hash,
// context/task/state hashes, contradiction digests) is a pure function of fixture content and is
// kept verbatim, so a change to hash inputs or algorithms shows up as parity drift.
export const VOLATILE_HEX_KEYS = new Set([
  'key', // decision-cache key: includes the canonical self/project location
  'identity_id', // HMAC over the caller identity with the random per-root cursor secret
  'self_id', // derived from the canonical self root path
  'binding_salt', // random per link
  'project_id', // hs-space-<hash of canonical project path>
  'space_id',
  'registry_hash', // links registry stores absolute project paths and timestamps
  'sig' // cursor HMAC
])
const HEX_RUN = /(?<![0-9a-z])[0-9a-f]{16,}(?![0-9a-z])/gi

export function normalise(cases, fx) {
  const roots = []
  for (const [base, label] of [[fx.root, '<ROOT>'], [resolve(repo), '<REPO>']]) {
    for (const path of [base, realpathSync(base)]) {
      for (const form of [path, path.replaceAll('\\', '/')]) {
        roots.push([form, label])
        if (process.platform === 'win32') roots.push([form.toLowerCase(), label])
      }
    }
  }
  roots.sort((a, b) => b[0].length - a[0].length)
  // Pass 1: learn the volatile hex values from volatile keys anywhere in the run (JSON output,
  // embedded JSON strings, decoded cursors), so the same values are also masked in plain text.
  const volatile = new Set()
  const learn = (value, key) => {
    if (typeof value === 'string' && VOLATILE_HEX_KEYS.has(key)) for (const run of value.match(HEX_RUN) || []) volatile.add(run.toLowerCase())
  }
  for (const entry of cases) {
    if (entry.skipped) continue
    entry.args?.forEach((arg, index) => { if (entry.args[index - 1] === '--cursor') visit(decodeCursor(arg), '', learn) })
    for (const parsed of parseOutput(entry.stdout || '')) visit(parsed, '', learn)
  }
  // Pass 2: normalise each case with its own ordinal numbering.
  return cases.map(entry => {
    const maps = { uuid: new Map(), hex: new Map() }
    const text = value => {
      if (typeof value !== 'string') return value
      let out = value
      for (const [root, label] of roots) out = out.split(root).join(label)
      out = out.replace(/<(?:ROOT|REPO)>[^\s"'`)\]]*/g, match => match.replaceAll('\\\\', '/').replaceAll('\\', '/'))
      out = out.replace(/\d{4}-\d{2}-\d{2}T\d{2}[:-]\d{2}[:-]\d{2}(?:[.-]\d{1,9})?Z/g, '<TIME>')
      out = out.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, match => ordinal(maps.uuid, match.toLowerCase(), 'UUID'))
      out = out.replace(HEX_RUN, match => volatile.has(match.toLowerCase()) ? ordinal(maps.hex, match.toLowerCase(), 'HEX') : match)
      return out
    }
    const args = entry.args?.map((arg, index) => entry.args[index - 1] === '--cursor' ? cursor(arg, text) : text(arg))
    const result = { name: entry.name, args }
    if (entry.skipped) return { ...result, skipped: entry.skipped }
    result.status = entry.status
    result.stdout = structured(entry.stdout, text)
    result.stderr = text(entry.stderr)
    return result
  })
}

function ordinal(map, key, label) {
  if (!map.has(key)) map.set(key, `<${label}:${map.size + 1}>`)
  return map.get(key)
}

const VOLATILE_KEYS = [
  [/^(duration|elapsed|took)(_ms|Ms)?$|_(duration|elapsed)(_ms)?$/, '<DURATION>'],
  [/^mtime(_ms|Ms|_ns)?$|_mtime(_ms)?$/, '<MTIME>']
]

const tryJson = value => { try { return { ok: true, value: JSON.parse(value) } } catch { return { ok: false } } }

function parseOutput(stdout) {
  const trimmed = stdout.trim()
  if (!trimmed) return []
  const whole = tryJson(trimmed)
  if (whole.ok) return [whole.value]
  const each = trimmed.split('\n').map(tryJson)
  return each.every(x => x.ok) ? each.map(x => x.value) : []
}

// Walks parsed output like scrub() does (cursor payloads and embedded JSON strings included).
function visit(value, key, fn) {
  if (Array.isArray(value)) return value.forEach(item => visit(item, key, fn))
  if (value && typeof value === 'object') return Object.entries(value).forEach(([k, v]) => visit(v, k, fn))
  if (typeof value !== 'string') return
  if (/cursor$/.test(key)) return visit(decodeCursor(value), '', fn)
  if (value.startsWith('{') || value.startsWith('[')) {
    const embedded = tryJson(value)
    if (embedded.ok) return visit(embedded.value, '', fn)
  }
  fn(value, key)
}

function decodeCursor(value) {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    return { payload: typeof parsed.p === 'string' ? JSON.parse(parsed.p) : parsed.p, sig: parsed.sig }
  } catch {
    return null
  }
}

// Cursors are base64url JSON { p, sig }: keep the decoded payload (offset, lens, budget, ...)
// and mask only the HMAC signature, which depends on the per-root random cursor secret.
function cursor(value, text) {
  if (typeof value !== 'string') return value
  const decoded = decodeCursor(value)
  return decoded ? { cursor: scrub(decoded.payload, '', text), sig: '<HMAC>' } : '<CURSOR>'
}

function structured(stdout, text) {
  const trimmed = stdout.trim()
  if (!trimmed) return text(stdout)
  const whole = tryJson(trimmed)
  if (whole.ok) return { json: scrub(whole.value, '', text) }
  const each = trimmed.split('\n').map(tryJson)
  if (each.every(x => x.ok)) return { jsonLines: each.map(x => scrub(x.value, '', text)) }
  return text(stdout)
}

function scrub(value, key, text) {
  if (Array.isArray(value)) return value.map(item => scrub(item, key, text))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, k, text)]))
  if (value === null || value === undefined) return value
  if (/cursor$/.test(key)) return cursor(value, text)
  for (const [pattern, replacement] of VOLATILE_KEYS) if (pattern.test(key)) return replacement
  if (typeof value === 'string' && (value.startsWith('{') || value.startsWith('['))) {
    const embedded = tryJson(value)
    if (embedded.ok) return { embeddedJson: scrub(embedded.value, '', text) }
  }
  return text(value)
}

export async function parityRun(options) {
  const fx = await buildParityFixture(options)
  try {
    await seedParityFixture(fx)
    const setup = normalise(fx.log.splice(0), fx)
    const cases = normalise(runParityMatrix(fx), fx)
    return { schema_version: 1, setup, cases }
  } finally {
    await fx.cleanup()
  }
}
