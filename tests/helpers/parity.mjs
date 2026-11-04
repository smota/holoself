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
//     path-derived ids, cache keys, links-registry hashes) -> <HEX:n>, numbered by first appearance per
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
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../..', import.meta.url))
const bin = join(repo, 'bin', 'holoself.mjs')
const meta = (lenses, extra = '') => `---\naccess_lenses: [${lenses.join(', ')}]\ndisclosure: internal-only\nsensitivity: personal\ndocument_role: content\n${extra}---\n`

export async function buildParityFixture({ baseDir = tmpdir() } = {}) {
  // Canonical (realpath) spelling: child processes report process.cwd() resolved, so a symlinked
  // TMPDIR (macOS /var -> /private/var) would otherwise make --root and cwd spell the self root
  // differently and change owner-direct output (the "No project link found" warning).
  const root = realpathSync(await mkdtemp(join(baseDir, 'holoself-parity-')))
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
  await seedExtendedFixture(fx)
}

// Extra roots for owner-direct, discovery and error-path cases (issue #58 stage 3 review).
async function seedExtendedFixture(fx) {
  const { root, self } = fx
  const lens = { schema_version: 1, id: 'startup', title: 'Synthetic session start', session_start_sources: ['profile/identity.md', 'context/missing-*.md'] }
  await writeFile(join(self, 'lenses', 'startup.json'), JSON.stringify(lens, null, 2))
  fx.unlinked = join(root, 'unlinked')
  fx.nested = join(fx.project, 'packages', 'app')
  fx.orphanSelf = join(root, 'orphan-self')
  fx.orphan = join(root, 'orphan-project')
  fx.legacy = join(root, 'legacy-project')
  fx.fresh = join(root, 'fresh-project')
  for (const dir of [fx.unlinked, fx.nested, fx.orphanSelf, fx.orphan, join(fx.legacy, 'mount-target'), fx.fresh]) await mkdir(dir, { recursive: true })
  await writeFile(join(fx.fresh, 'AGENTS.md'), '# Agents\n\nSynthetic project instructions.\n')
  await writeFile(join(fx.fresh, 'profile-notes.md'), '# Profile notes\n\nSynthetic reusable context.\n')
  fx.cli('init orphan self', ['init', '--root', fx.orphanSelf])
  fx.cli('link add orphan', ['link', 'add', '--project', fx.orphan, '--self', fx.orphanSelf, '--no-activate', '--yes'])
  await rm(fx.orphanSelf, { recursive: true, force: true })
  // A directory junction on Windows (no privilege needed) and a symlink elsewhere: both are legacy mounts.
  await symlink(join(fx.legacy, 'mount-target'), join(fx.legacy, '.holoself'), 'junction')
}

export function runParityMatrix(fx) {
  const { project, self } = fx
  const p = ['--project', project]
  const cases = []
  const add = (name, args, extra = {}) => {
    const r = fx.cli(name, args, extra)
    cases.push({ name, args, status: r.status, stdout: r.stdout, stderr: r.stderr, pathDependentSize: Boolean(extra.pathDependentSize) })
    return r
  }
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
  runExtendedMatrix(fx, add, cases)
  return cases
}

function runExtendedMatrix(fx, add, cases) {
  const { project, self } = fx
  const p = ['--project', project]
  const r = ['--root', self]
  const lastJson = () => { try { return JSON.parse(cases.at(-1).stdout) } catch { return null } }
  // Linked CLI JSON lists pending proposals with absolute project paths (source_project_path, _path),
  // so once a proposal exists the linked packet sizes depend on the temporary path length too.
  const sized = { pathDependentSize: true }
  // Caller resolution and context paths.
  const owner = { cwd: self, pathDependentSize: true }
  const u = ['--budget', 'unbounded']
  add('owner context in self root', ['context', ...r, ...u, '--task', 'plan refactoring work', '--json'], owner)
  add('owner context private lens', ['context', ...r, ...u, '--lens', 'private', '--task', 'restricted notes', '--json'], owner)
  add('owner context without root', ['context', '--json'], owner)
  add('owner context below self root', ['context', ...r, ...u, '--json'], { ...owner, cwd: join(self, 'context') })
  add('owner unknown lens', ['context', ...r, '--lens', 'no-such-lens', '--json'], owner)
  add('owner session-start unmatched sources', ['context', ...r, ...u, '--lens', 'startup', '--session-start', '--json'], owner)
  add('linked context by cwd walk-up', ['context', '--budget', 'small', '--json'], { cwd: fx.nested, pathDependentSize: true })
  add('linked context unlinked project', ['context', '--project', fx.unlinked, '--json'])
  add('linked context self root as project', ['context', '--project', self, '--json'])
  add('linked context missing self root', ['context', '--project', fx.orphan, '--json'])
  add('linked context legacy mount', ['context', '--project', fx.legacy, '--json'])
  add('context not-needed task', ['context', ...p, '--task', 'Format this JSON object: {"x":1}', '--json'], sized)
  add('context contrib task', ['context', ...p, '--task', 'quarterly reflection on systems thinking', '--budget', 'deep', '--json'], sized)
  add('context cache miss', ['context', ...p, '--task', 'cache probe', '--budget', 'small', '--json'], sized)
  add('context cache hit', ['context', ...p, '--task', 'cache probe', '--budget', 'small', '--json'], sized)
  add('context no-cache', ['context', ...p, '--task', 'cache probe', '--budget', 'small', '--no-cache', '--json'], sized)
  add('context snapshot without yes', ['context', ...p, '--snapshot'])
  add('mcp unlinked project', ['mcp', '--project', fx.unlinked], { input: mcpInput() })
  add('mcp identity argument', ['mcp', ...p], { input: mcpIdentityInput() })
  // Lens commands.
  add('lens list', ['lens', 'list', ...r])
  add('lens show', ['lens', 'show', 'startup', ...r])
  add('lens validate', ['lens', 'validate', ...r])
  add('lens bindings', ['lens', 'bindings', ...r])
  add('lens bind dry-run', ['lens', 'bind', ...r, '--project', project, '--lens', 'general', '--secondary-lenses', 'leadership,professional', '--dry-run'])
  add('lens bind', ['lens', 'bind', ...r, '--project', project, '--lens', 'general', '--secondary-lenses', 'leadership,professional', '--yes'])
  add('lens unbind dry-run', ['lens', 'unbind', ...r, '--project', project, '--dry-run'])
  // Link lifecycle.
  add('link status text', ['link', 'status', ...p])
  add('link doctor', ['link', 'doctor', ...p])
  add('link setup dry-run', ['link', 'setup', '--project', fx.fresh, '--self', self, '--dry-run'])
  add('link setup dry-run confirmed', ['link', 'setup', '--project', fx.fresh, '--self', self, '--activate', 'claude', '--dry-run', '--yes'])
  add('link activate without yes', ['link', 'activate', ...p, '--activate', 'claude,codex'])
  add('link activate dry-run', ['link', 'activate', ...p, '--activate', 'claude,codex', '--dry-run', '--yes'])
  add('link activate', ['link', 'activate', ...p, '--activate', 'claude,codex', '--install-skill', 'none', '--yes'])
  add('link status after activate', ['link', 'status', ...p, '--json'])
  add('instructions render', ['instructions', 'render', ...p])
  add('instructions audit', ['instructions', 'audit', ...p])
  add('link deactivate dry-run', ['link', 'deactivate', ...p, '--adapters', 'codex', '--dry-run'])
  add('link repair dry-run', ['link', 'repair', ...p, '--dry-run', '--no-activate'])
  add('link approve', ['link', 'approve', ...p, '--self', self])
  add('link backfill', ['link', 'backfill', ...p, '--self', self])
  add('link prune', ['link', 'prune', '--self', self])
  add('link skill migrate-global dry-run', ['link', 'skill', 'migrate-global', ...p, '--dry-run'])
  add('skill status', ['skill', 'status', '--scope', 'user'])
  add('migrate policy dry-run', ['migrate', 'policy', ...r, '--dry-run', '--json'])
  // Analysis, index and proposals.
  add('analyze all', ['analyze', 'all', ...p])
  add('index status', ['index', 'status', ...p])
  add('index rebuild', ['index', 'rebuild', ...p])
  add('index status after rebuild', ['index', 'status', ...p])
  const ids = []
  for (const claim of ['Approve me: prefers reviewable refactors', 'Reject me: dislikes tests', 'Defer me: maybe likes pairing']) {
    add(`propose ${claim.split(':')[0]}`, ['propose', ...p, '--claim', claim, '--source-file', 'NOTES.md'])
    ids.push(lastJson()?.proposal_id)
  }
  if (ids.every(Boolean)) {
    add('proposals approve without yes', ['proposals', 'approve', ids[0], ...p])
    add('proposals approve', ['proposals', 'approve', ids[0], ...p, '--yes'])
    add('proposals reject', ['proposals', 'reject', ids[1], ...p, '--yes'])
    add('proposals defer', ['proposals', 'defer', ids[2], ...p, '--yes'])
    add('proposals reject non-pending', ['proposals', 'reject', ids[0], ...p, '--yes'])
    add('proposals audit', ['proposals', 'audit', ...p])
  } else cases.push({ name: 'proposals lifecycle', skipped: 'propose did not return ids' })
  add('context after approval', ['context', ...p, '--task', 'reviewable refactors', '--json'], sized)
  add('link deactivate', ['link', 'deactivate', ...p, '--yes'])
  add('link remove dry-run', ['link', 'remove', ...p, '--dry-run'])
  add('link remove dry-run confirmed', ['link', 'remove', ...p, '--dry-run', '--yes'])
  add('link status after remove dry-run', ['link', 'status', ...p, '--json'])
  add('validate after lifecycle', ['validate', ...r])
}

function mcpIdentityInput() {
  const lines = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'parity', version: '1' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'holoself_context', arguments: { identity: 'owner:direct' } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'holoself_status', arguments: {} } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'holoself_search', arguments: { query: 'refactoring' } } }
  ]
  return lines.map(line => JSON.stringify(line)).join('\n') + '\n'
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
  'registry_hash', // links-registry hash (absolute project paths, timestamps); see volatileKey() for lens commands
  'hash', // lens bindings file hash: the bindings are keyed by absolute project path
  'preview_hash', // proposal preview hash embeds the random proposal UUID
  'sig' // cursor HMAC
])
// Owner-direct packets carry the absolute self path, and linked CLI JSON lists pending proposals
// with absolute paths, so their byte and token totals depend on the temporary path length; cases
// flagged pathDependentSize mask these keys. Owner cases use the unbounded budget so envelope
// trimming cannot depend on the path; the path-independence test proves the rest is stable.
const PATH_DEPENDENT_SIZE_KEYS = new Set(['total_bytes', 'estimated_tokens_total', 'estimated_tokens_total_heuristic'])
const HEX_RUN = /(?<![0-9a-z])[0-9a-f]{16,}(?![0-9a-z])/gi
// Volatility is scoped by command where one key name means different things: `lens list|show|validate`
// print the LENS registry hash under `registry_hash`, which is content-derived and stays verbatim
// (as does `lens_registry_hash` everywhere); elsewhere `registry_hash` is the links registry's hash.
function volatileKey(key, entry) {
  if (!VOLATILE_HEX_KEYS.has(key)) return false
  if (key === 'registry_hash' && entry.args?.[0] === 'lens') return false
  return true
}

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
  const textKey = new RegExp(`"(${[...VOLATILE_HEX_KEYS].join('|')})":\\s*"([^"]*)"|Preview hash: ([0-9a-f]+)`, 'g')
  for (const entry of cases) {
    if (entry.skipped) continue
    const learn = (value, key) => {
      if (typeof value === 'string' && volatileKey(key, entry)) for (const run of value.match(HEX_RUN) || []) volatile.add(run.toLowerCase())
    }
    entry.args?.forEach((arg, index) => { if (entry.args[index - 1] === '--cursor') visit(decodeCursor(arg), '', learn) })
    for (const parsed of parseOutput(entry.stdout || '')) visit(parsed, '', learn)
    // Plain-text output (concatenated JSON documents, approval previews) is scanned by pattern.
    for (const match of `${entry.stdout || ''}\n${entry.stderr || ''}`.matchAll(textKey)) {
      if (match[1] && !volatileKey(match[1], entry)) continue
      for (const run of (match[2] || match[3] || '').match(HEX_RUN) || []) volatile.add(run.toLowerCase())
    }
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
    if (entry.pathDependentSize) result.stdout = maskSizes(result.stdout)
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

function maskSizes(value, key = '') {
  if (Array.isArray(value)) return value.map(item => maskSizes(item, key))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskSizes(v, k)]))
  return PATH_DEPENDENT_SIZE_KEYS.has(key) && typeof value === 'number' ? '<SIZE>' : value
}

// The proposal store lists proposals by their random UUID file names; arrays of proposals are put
// in a UUID-independent order before normalisation so <UUID:n> numbering is stable too.
const UUID_ANY = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
function stableOrder(items) {
  if (items.length < 2 || !items.every(item => item && typeof item === 'object' && typeof item.proposal_id === 'string')) return items
  const key = item => JSON.stringify(item).replace(UUID_ANY, '')
  return [...items].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
}

function scrub(value, key, text) {
  if (Array.isArray(value)) return stableOrder(value).map(item => scrub(item, key, text))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [text(k), scrub(v, k, text)]))
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
