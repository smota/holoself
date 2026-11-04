import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from '../src/cli.mjs'
import { HOOK_ID } from '../src/adapters/hooks.mjs'
import { hookContext } from '../src/cli/hook-mode.mjs'
import {
  LEDGER_MAX_BYTES,
  LEDGER_SCHEMA_VERSION,
  appendLedgerLine,
  computeTaskHmac,
  detectLedgerHost,
  getOrCreateLedgerKey,
  ledgerFilePath,
  ledgerKeyPath,
  ledgerLockPath,
  readLedgerEntries,
  rotatedLedgerFilePath
} from '../src/ledger.mjs'
import { readLink } from '../src/link/config.mjs'
import { createMcpSession, createMcpToolPool } from '../src/mcp-server.mjs'
import { hash } from '../src/shared/fs.mjs'
import { startWebServer } from '../src/web-server.mjs'

const temp = prefix => mkdtemp(join(tmpdir(), `holoself-ledger-${prefix}-`))

const SECRET_SELF_BODY = 'ULTRA_SECRET_RESTRICTED_COMPENSATION_9918273645'
const SECRET_SELF_HEADING = 'Secret Equity Vesting Table Heading'
const DELIVERED_SELF_BODY = 'DELIVERED_PROFESSIONAL_BIO_MARKER_77261543'
const DELIVERED_SELF_HEADING = 'Confidential Executive Biography Heading'
const PROJECT_DOC_BODY = 'LOCAL_PROJECT_ARCHITECTURE_SECRET_55443322'
const PROJECT_DOC_HEADING = 'Internal Service Topology Heading'

async function setupLinkedFixture() {
  const base = await temp('fixture')
  const self = join(base, 'self')
  const project = join(base, 'project')
  mkdirSync(project, { recursive: true })
  await run(['init', '--root', self])

  writeFileSync(
    join(self, 'profile', 'identity.md'),
    `---\nschema_version: 2\naccess_lenses:\n  - general\n  - professional\n  - private\ndisclosure: internal-only\nsensitivity: standard\ndocument_role: canonical\n---\n\n# Identity\n\n## ${DELIVERED_SELF_HEADING}\n\n${DELIVERED_SELF_BODY}\n`
  )
  writeFileSync(
    join(self, 'context', 'restricted-comp.md'),
    `---\nschema_version: 2\naccess_lenses:\n  - private\ndisclosure: internal-only\nsensitivity: restricted\ndocument_role: canonical\n---\n\n# Restricted Compensation\n\n## ${SECRET_SELF_HEADING}\n\n${SECRET_SELF_BODY}\n`
  )
  writeFileSync(join(project, 'README.md'), `# Project\n\n## ${PROJECT_DOC_HEADING}\n\n${PROJECT_DOC_BODY}\n`)

  await run(['link', 'add', '--project', project, '--self', self, '--lens', 'general', '--secondary-lenses', 'professional', '--no-activate', '--yes'])
  return { base, self, project }
}

async function captureCli(argv, { cwd = process.cwd(), env = {} } = {}) {
  const prevCwd = process.cwd()
  const prevEnv = {}
  const keys = new Set([
    ...Object.keys(env),
    'HOLOSELF_SURFACE',
    'HOLOSELF_HOST',
    'HOLOSELF_LEDGER',
    'CLAUDE_CODE',
    'CLAUDECODE',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_PROJECT_DIR',
    'CODEX',
    'CODEX_SANDBOX',
    'CODEX_THREAD_ID',
    'CODEX_HOME',
    'CODEX_CI',
    'AGY',
    'AGY_SESSION',
    'ANTIGRAVITY',
    'ANTIGRAVITY_AGENT',
    'ANTIGRAVITY_CLI'
  ])
  for (const k of keys) prevEnv[k] = process.env[k]
  const logs = []
  const errors = []
  const origLog = console.log
  const origErr = console.error
  console.log = (...a) => logs.push(a.join(' '))
  console.error = (...a) => errors.push(a.join(' '))
  try {
    for (const k of keys) delete process.env[k]
    for (const [k, v] of Object.entries(env)) {
      if (v !== undefined && v !== null) process.env[k] = String(v)
    }
    process.chdir(cwd)
    await run(argv)
  } finally {
    process.chdir(prevCwd)
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    console.log = origLog
    console.error = origErr
  }
  return { stdout: logs.join('\n'), stderr: errors.join('\n') }
}

function httpCall(app, path, { method = 'GET', headers = {}, body } = {}) {
  const { port } = new URL(app.url)
  return new Promise((ok, no) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: { host: `127.0.0.1:${port}`, ...headers }
      },
      res => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', chunk => {
          data += chunk
        })
        res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: data }))
      }
    )
    req.on('error', no)
    req.end(body)
  })
}

test('detectLedgerHost identifies CLAUDE_CODE, CODEX, AGY, and MCP clientInfo markers', () => {
  assert.equal(detectLedgerHost({ env: {} }), null)
  assert.equal(detectLedgerHost({ env: { CLAUDE_CODE: '1' } }), 'claude')
  assert.equal(detectLedgerHost({ env: { CODEX_SANDBOX: 'seatbelt' } }), 'codex')
  assert.equal(detectLedgerHost({ env: { AGY: '1' } }), 'agy')
  assert.equal(detectLedgerHost({ clientInfoName: 'claude-code-mcp', env: { CODEX: '1' } }), 'claude-code-mcp')
})

test('.holoself/.gitignore protects local-only artefacts while keeping link.yaml, BOOTSTRAP.md, README.md, and proposals trackable', async t => {
  const gitVersion = spawnSync('git', ['--version'], { encoding: 'utf8' })
  if (gitVersion.status !== 0) {
    t.skip('git binary not available')
    return
  }

  const { self, project } = await setupLinkedFixture()
  // Trigger a ledger write in both project and self
  await captureCli(['context', '--project', project, '--lens', 'professional', '--task', 'career bio', '--json'])
  await captureCli(['context', '--root', self, '--lens', 'private', '--task', 'owner review', '--json'], { cwd: self })

  for (const dir of [project, self]) {
    assert.equal(existsSync(join(dir, '.gitignore')), false, 'must never create or touch top-level .gitignore')
    assert.equal(existsSync(join(dir, '.holoself', '.gitignore')), true, 'must create .holoself/.gitignore')
    const initGit = spawnSync('git', ['init'], { cwd: dir, encoding: 'utf8' })
    assert.equal(initGit.status, 0)

    const shouldBeIgnored = [
      '.holoself/ledger.ndjson',
      '.holoself/ledger.1.ndjson',
      '.holoself/ledger.ndjson.rotate.lock',
      '.holoself/catalog/project.json',
      '.holoself/index/manifest.json',
      '.holoself/runtime.json',
      '.holoself/runtime/ledger.key',
      '.holoself/conversations/thread.ndjson',
      '.holoself/reports/audit.json',
      '.holoself/links.json'
    ]
    for (const rel of shouldBeIgnored) {
      const check = spawnSync('git', ['check-ignore', '-q', rel], { cwd: dir })
      assert.equal(check.status, 0, `expected git check-ignore to ignore ${rel} in ${dir}`)
    }

    const shouldBeTrackable = [
      '.holoself/link.yaml',
      '.holoself/BOOTSTRAP.md',
      '.holoself/README.md',
      '.holoself/proposals/pending/prop-001.yaml'
    ]
    for (const rel of shouldBeTrackable) {
      const check = spawnSync('git', ['check-ignore', '-q', rel], { cwd: dir })
      assert.equal(check.status, 1, `expected ${rel} to remain trackable (not ignored) in ${dir}`)
    }
  }

  const readmeText = readFileSync(join(project, '.holoself', 'README.md'), 'utf8')
  assert.match(readmeText, /\.gitignore/)
  assert.match(readmeText, /ledger\*\.ndjson/)
})

test('records schema v2 entries with mode (packet|manifest|get), per-self-root task_hmac, and no content/paths/headings across all surfaces', async () => {
  const { base, self, project } = await setupLinkedFixture()
  const keyFile = ledgerKeyPath(self)
  assert.equal(existsSync(keyFile), true, 'init should create <self>/.holoself/runtime/ledger.key')
  const keyBuf = getOrCreateLedgerKey(self)
  assert.equal(keyBuf.length, 32)
  if (process.platform !== 'win32') {
    assert.equal(statSync(keyFile).mode & 0o777, 0o600)
  }

  // 1. CLI linked packet surface (mode: "packet")
  const cliTask = 'prepare career leadership summary'
  const cliRes = await captureCli(['context', '--project', project, '--lens', 'professional', '--task', cliTask, '--json'], {
    env: { CODEX: '1' }
  })
  const cliPacket = JSON.parse(cliRes.stdout)
  let entries = readLedgerEntries(project)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].schema_version, LEDGER_SCHEMA_VERSION)
  assert.equal(entries[0].schema_version, 2)
  assert.equal(entries[0].surface, 'cli')
  assert.equal(entries[0].mode, 'packet')
  assert.equal(entries[0].host, 'codex')
  assert.equal(entries[0].lens, 'professional')
  assert.equal(entries[0].budget, 'standard')
  assert.equal(entries[0].need, 'required')
  assert.equal(entries[0].task_hmac, computeTaskHmac(cliTask, keyBuf))
  assert.notEqual(entries[0].task_hmac, hash(cliTask), 'task_hmac must be keyed HMAC, never unsalted SHA-256')
  assert.equal(entries[0].task_sha256, undefined)
  assert.equal(entries[0].task, undefined)
  assert.equal(entries[0].context_hash, cliPacket.context_receipt.context_hash)
  assert.equal(entries[0].packet_id, cliPacket.packet_metadata.packet_id)
  assert.deepEqual(entries[0].source_ids, cliPacket.context_receipt.source_ids)
  assert.ok(entries[0].counts.documents_delivered >= 1)
  assert.equal(entries[0].counts.items_listed, undefined)
  assert.ok(entries[0].counts.restricted >= 1)
  assert.equal(entries[0].counts.envelope_dropped, 0)
  assert.equal(entries[0].total_bytes, cliPacket.selection.total_bytes)

  // 1b. CLI manifest mode (mode: "manifest" records items_listed instead of documents_delivered)
  const cliManifestRes = await captureCli(
    ['context', '--project', project, '--lens', 'professional', '--task', cliTask, '--manifest', '--json'],
    { env: { CODEX: '1' } }
  )
  const cliManifestPacket = JSON.parse(cliManifestRes.stdout)
  const firstCliHandle = cliManifestPacket.sources[0].source_id
  entries = readLedgerEntries(project)
  assert.equal(entries.length, 2)
  assert.equal(entries[1].surface, 'cli')
  assert.equal(entries[1].mode, 'manifest')
  assert.ok(entries[1].counts.items_listed >= 1)
  assert.equal(entries[1].counts.documents_delivered, undefined)

  // 1c. CLI source get mode (mode: "get" records fetched handle IDs)
  await captureCli(
    ['context', '--project', project, '--lens', 'professional', '--task', cliTask, '--source', firstCliHandle, '--json'],
    { env: { CODEX: '1' } }
  )
  entries = readLedgerEntries(project)
  assert.equal(entries.length, 3)
  assert.equal(entries[2].surface, 'cli')
  assert.equal(entries[2].mode, 'get')
  assert.deepEqual(entries[2].source_ids, [firstCliHandle])
  assert.equal(entries[2].counts.documents_delivered, 1)
  assert.equal(entries[2].counts.items_listed, undefined)

  // 2. Owner-direct CLI writes to <self>/.holoself/ledger.ndjson, not project
  await captureCli(['context', '--root', self, '--lens', 'private', '--task', 'review personal identity'], {
    cwd: self,
    env: { AGY: '1' }
  })
  assert.equal(readLedgerEntries(project).length, 3)
  const selfEntries = readLedgerEntries(self)
  assert.equal(selfEntries.length, 1)
  assert.equal(selfEntries[0].surface, 'cli')
  assert.equal(selfEntries[0].mode, 'packet')
  assert.equal(selfEntries[0].host, 'agy')
  assert.equal(selfEntries[0].lens, 'private')
  assert.equal(selfEntries[0].task_hmac, computeTaskHmac('review personal identity', keyBuf))

  // 3. SessionStart hook surface
  const hookRes = hookContext(
    { hook: HOOK_ID, project, sessionStart: true, budget: 'small', format: 'packet' },
    { CLAUDE_PROJECT_DIR: project, CLAUDE_CODE: '1' }
  )
  assert.ok(hookRes.content.includes('Holoself context packet'))
  entries = readLedgerEntries(project)
  assert.equal(entries.length, 4)
  assert.equal(entries[3].surface, 'hook')
  assert.equal(entries[3].mode, 'packet')
  assert.equal(entries[3].host, 'claude')
  assert.equal(entries[3].budget, 'small')
  assert.equal(entries[3].task_hmac, null)
  assert.equal(entries[3].packet_id, hookRes.data.packet_metadata.packet_id)

  // 4. MCP surface (worker pool): initialize with clientInfo, then call holoself_context_manifest, holoself_context_get, holoself_context, and holoself_status
  const pool = createMcpToolPool({ size: 2, timeoutMs: 10000 })
  const mcpResponses = []
  let firstHandle = null
  try {
    const session = createMcpSession({
      project,
      pool,
      write: line => mcpResponses.push(JSON.parse(line))
    })
    session(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', clientInfo: { name: 'claude-desktop', version: '1.0.0' } }
      })
    )
    // Status is not a served context packet and must not add a ledger entry
    session(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'holoself_status', arguments: {} } }))
    session(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'holoself_context_manifest', arguments: { task: 'career identity check', lens: 'professional', budget: 'small' } }
      })
    )
    await session.drain()
    const manifestResp = mcpResponses.find(r => r.id === 3)
    firstHandle = manifestResp.result.structuredContent.data.sources[0].source_id
    session(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'holoself_context_get', arguments: { source_ids: [firstHandle], lens: 'professional' } }
      })
    )
    session(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'holoself_context', arguments: { task: 'voice and preferences', lens: 'general' } }
      })
    )
    // Error call must NOT write a ledger entry
    session(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'holoself_context', arguments: { task: 'forbidden lens', lens: 'private' } }
      })
    )
    await session.drain()
  } finally {
    await pool.close()
  }

  entries = readLedgerEntries(project)
  // 4 prior + 3 MCP served context calls (manifest, get, context) = 7
  assert.equal(entries.length, 7)
  for (const entry of entries.slice(4, 7)) {
    assert.equal(entry.surface, 'mcp')
    assert.equal(entry.host, 'claude-desktop')
  }
  assert.equal(entries[4].mode, 'manifest')
  assert.ok(entries[4].counts.items_listed >= 1)
  assert.equal(entries[4].counts.documents_delivered, undefined)

  assert.equal(entries[5].mode, 'get')
  assert.deepEqual(entries[5].source_ids, [firstHandle])
  assert.equal(entries[5].counts.documents_delivered, 1)
  assert.equal(entries[5].counts.items_listed, undefined)

  assert.equal(entries[6].mode, 'packet')
  assert.ok(entries[6].counts.documents_delivered >= 1)
  assert.equal(entries[6].counts.items_listed, undefined)

  // Cancelled MCP call in worker pool does NOT write a ledger entry
  const slowPool = createMcpToolPool({ size: 1, timeoutMs: 10000, simulateWorkMs: 400 })
  try {
    const session = createMcpSession({ project, pool: slowPool, write: () => {} })
    session(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }))
    session(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: { name: 'holoself_context', arguments: { task: 'cancelled task' } }
      })
    )
    session(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 10 } }))
    await session.drain()
  } finally {
    await slowPool.close()
  }
  assert.equal(readLedgerEntries(project).length, 7)

  // 5. Workbench surface:
  // - Preview context (POST /api/spaces/:id/context) must NOT record a ledger entry
  // - Failing conversation harness must NOT record a ledger entry
  // - Succeeding conversation harness records exactly one surface: "workbench", mode: "packet" entry
  mkdirSync(join(self, 'ui'), { recursive: true })
  writeFileSync(
    join(self, 'ui', 'settings.json'),
    JSON.stringify({
      schemaVersion: 1,
      harnesses: {
        codex: {
          schemaVersion: 1,
          id: 'codex',
          executable: process.execPath,
          arguments: ['-e', 'process.stdout.write("assistant-ok")'],
          promptTransport: 'stdin',
          timeoutSeconds: 30,
          verifiedAt: new Date().toISOString()
        },
        claude: {
          schemaVersion: 1,
          id: 'claude',
          executable: process.execPath,
          arguments: ['-e', 'process.stderr.write("boom"); process.exit(1)'],
          promptTransport: 'stdin',
          timeoutSeconds: 30,
          verifiedAt: new Date().toISOString()
        }
      }
    })
  )
  const app = await startWebServer({ root: self, project, port: 0 })
  let ledgerApiBody = ''
  try {
    const { port } = new URL(app.url)
    const spacesRes = await httpCall(app, '/api/spaces', {
      headers: { 'x-holoself-token': app.token }
    })
    const spaces = JSON.parse(spacesRes.body).data
    const linkedSpace = spaces.find(s => s.kind !== 'self')
    assert.ok(linkedSpace, 'expected linked project space in /api/spaces')

    // 5a. Owner preview in Workbench must NOT log a false CLI serve
    const previewRes = await httpCall(app, `/api/spaces/${encodeURIComponent(linkedSpace.id)}/context`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-holoself-token': app.token,
        origin: `http://127.0.0.1:${port}`
      },
      body: '{}'
    })
    assert.equal(previewRes.status, 200)
    assert.equal(readLedgerEntries(project).length, 7, 'Workbench preview context must not record a ledger entry')

    // 5b. Failing harness conversation must NOT record a ledger entry
    const failedConvRes = await httpCall(app, '/api/conversation', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-holoself-token': app.token,
        origin: `http://127.0.0.1:${port}`
      },
      body: JSON.stringify({
        project,
        harness: 'claude',
        lens: 'professional',
        message: 'Help me draft my career bio (will fail)'
      })
    })
    assert.equal(failedConvRes.status, 500)
    assert.equal(readLedgerEntries(project).length, 7, 'Failed harness conversation must not record a ledger entry')

    // 5c. Succeeding harness conversation records 1 workbench entry
    const convRes = await httpCall(app, '/api/conversation', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-holoself-token': app.token,
        origin: `http://127.0.0.1:${port}`
      },
      body: JSON.stringify({
        project,
        harness: 'codex',
        lens: 'professional',
        message: 'Help me draft my career bio'
      })
    })
    assert.equal(convRes.status, 200)

    const apiLedgerRes = await httpCall(app, '/api/ledger?limit=50', {
      headers: { 'x-holoself-token': app.token }
    })
    assert.equal(apiLedgerRes.status, 200)
    ledgerApiBody = apiLedgerRes.body
  } finally {
    await new Promise(done => app.server.close(done))
  }

  entries = readLedgerEntries(project)
  assert.equal(entries.length, 8)
  assert.equal(entries[7].surface, 'workbench')
  assert.equal(entries[7].mode, 'packet')
  assert.equal(entries[7].host, 'codex')
  assert.equal(entries[7].lens, 'professional')
  assert.equal(entries[7].task_hmac, computeTaskHmac('Help me draft my career bio', keyBuf))

  // Verify NO content bodies, headings, snippets, filesystem paths, relative paths, or restricted source IDs appear in raw ledger files or /api/ledger
  const rawProjectLedger = readFileSync(ledgerFilePath(project), 'utf8')
  const rawSelfLedger = readFileSync(ledgerFilePath(self), 'utf8')
  const restrictedSourceId = `hs-${hash('self\0context/restricted-comp.md').slice(0, 20)}`

  const forbiddenStrings = [
    SECRET_SELF_BODY,
    SECRET_SELF_HEADING,
    DELIVERED_SELF_BODY,
    DELIVERED_SELF_HEADING,
    PROJECT_DOC_BODY,
    PROJECT_DOC_HEADING,
    '# Identity',
    '# Restricted Compensation',
    base,
    self,
    project,
    'profile/identity.md',
    'context/restricted-comp.md',
    'README.md'
  ]

  for (const [label, text] of [
    ['project ledger.ndjson', rawProjectLedger],
    ['self ledger.ndjson', rawSelfLedger],
    ['GET /api/ledger', ledgerApiBody]
  ]) {
    for (const forbidden of forbiddenStrings) {
      assert.ok(!text.includes(forbidden), `${label} must never contain "${forbidden}"`)
    }
  }
  assert.ok(!rawProjectLedger.includes(restrictedSourceId), 'linked project ledger must never contain restricted source IDs')
  assert.ok(!ledgerApiBody.includes(restrictedSourceId), '/api/ledger must never contain restricted source IDs')
})

test('task is HMAC-hashed by default (keyed per self root), recorded as plain text only when ledger.record_task_text is true; ledger.enabled: false disables writes', async () => {
  const { self, project } = await setupLinkedFixture()
  const otherSelf = await temp('other-self')
  await run(['init', '--root', otherSelf])

  const keyA = getOrCreateLedgerKey(self)
  const keyB = getOrCreateLedgerKey(otherSelf)
  assert.notDeepEqual(keyA, keyB)
  assert.notEqual(
    computeTaskHmac('same task string', keyA),
    computeTaskHmac('same task string', keyB),
    'task_hmac must be linkable only on the same self root'
  )

  const linkYamlPath = join(project, '.holoself', 'link.yaml')
  const baseYaml = readFileSync(linkYamlPath, 'utf8')

  // Opt in to record_task_text: true
  writeFileSync(linkYamlPath, `${baseYaml}\nledger:\n  enabled: true\n  record_task_text: true\n`)
  await captureCli(['context', '--project', project, '--task', 'plain text opt-in task', '--json'])
  let entries = readLedgerEntries(project)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].task, 'plain text opt-in task')
  assert.equal(entries[0].task_hmac, computeTaskHmac('plain text opt-in task', keyA))

  // Disable ledger with ledger.enabled: false
  writeFileSync(linkYamlPath, `${baseYaml}\nledger:\n  enabled: false\n`)
  await captureCli(['context', '--project', project, '--task', 'should not be recorded', '--json'])
  entries = readLedgerEntries(project)
  assert.equal(entries.length, 1)

  // Unknown key under ledger in link.yaml is rejected by readLink validator
  writeFileSync(linkYamlPath, `${baseYaml}\nledger:\n  unknown_option: true\n`)
  assert.throws(() => readLink(project), /unknown ledger field: unknown_option/)
})

test('rotates ledger.ndjson at 5 MiB keeping up to 3 rotated files and handles 8 concurrent child writers with zero silent line loss', async () => {
  const { project } = await setupLinkedFixture()
  const activePath = ledgerFilePath(project)
  mkdirSync(join(project, '.holoself'), { recursive: true })

  // 1. Seed ledger.ndjson just at the 5 MiB threshold and rotate 4 times
  for (let cycle = 1; cycle <= 4; cycle++) {
    const filler = JSON.stringify({ schema_version: 2, cycle, pad: 'x'.repeat(1024) }) + '\n'
    const repeats = Math.ceil(LEDGER_MAX_BYTES / Buffer.byteLength(filler))
    writeFileSync(activePath, filler.repeat(repeats), { mode: 0o600 })
    appendLedgerLine(project, {
      schema_version: 2,
      served_at: new Date(Date.UTC(2026, 9, cycle)).toISOString(),
      surface: 'cli',
      mode: 'packet',
      host: null,
      lens: 'general',
      budget: 'standard',
      need: 'helpful',
      task_hmac: null,
      context_hash: `hash-${cycle}`,
      packet_id: `pkt-${cycle}`,
      source_ids: [],
      counts: { documents_delivered: 1, restricted: 0, envelope_dropped: 0 },
      total_bytes: 100
    })
  }

  assert.ok(existsSync(activePath))
  assert.ok(existsSync(rotatedLedgerFilePath(project, 1)))
  assert.ok(existsSync(rotatedLedgerFilePath(project, 2)))
  assert.ok(existsSync(rotatedLedgerFilePath(project, 3)))
  assert.ok(!existsSync(rotatedLedgerFilePath(project, 4)), 'rotation must keep at most 3 rotated files')

  // 2. Concurrent rotation race test: 8 concurrent child processes appending with a small maxBytes threshold
  const raceDir = await temp('race')
  mkdirSync(join(raceDir, '.holoself'), { recursive: true })
  const ledgerModuleUrl = new URL('../src/ledger.mjs', import.meta.url).href
  const workerScript = `
    import { appendLedgerLine } from ${JSON.stringify(ledgerModuleUrl)};
    const [dir, writerId] = process.argv.slice(1);
    for (let seq = 0; seq < 3; seq++) {
      appendLedgerLine(
        dir,
        {
          schema_version: 2,
          served_at: new Date().toISOString(),
          surface: 'cli',
          mode: 'packet',
          host: null,
          lens: 'general',
          budget: 'standard',
          need: 'helpful',
          task_hmac: 'hmac-' + writerId + '-' + seq + '-' + 'p'.repeat(120),
          context_hash: 'ctx-' + writerId + '-' + seq,
          packet_id: 'pkt-' + writerId + '-' + seq,
          source_ids: ['hs-00000000000000000001'],
          counts: { documents_delivered: 1, restricted: 0, envelope_dropped: 0 },
          total_bytes: 256
        },
        { maxBytes: 800, keep: 40 }
      );
    }
  `

  const children = Array.from({ length: 8 }, (_, idx) => {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', workerScript, raceDir, String(idx)], {
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let stderr = ''
      child.stderr.on('data', d => {
        stderr += d.toString()
      })
      child.on('error', reject)
      child.on('close', code => resolve({ code, stderr }))
    })
  })

  const results = await Promise.all(children)
  for (const r of results) {
    assert.equal(r.code, 0, `concurrent writer failed: ${r.stderr}`)
  }

  // Collect all lines across ledger.ndjson and rotated files ledger.1..40.ndjson
  const collectedIds = new Set()
  const slots = [ledgerFilePath(raceDir)]
  for (let i = 1; i <= 40; i++) slots.push(rotatedLedgerFilePath(raceDir, i))
  for (const file of slots) {
    if (!existsSync(file)) continue
    const lines = readFileSync(file, 'utf8')
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
    for (const line of lines) {
      const parsed = JSON.parse(line)
      collectedIds.add(parsed.packet_id)
    }
  }
  assert.equal(collectedIds.size, 8 * 3, 'all 24 entries from 8 concurrent rotating writers must be preserved without silent loss')
  assert.equal(existsSync(ledgerLockPath(raceDir)), false, 'rotation lock file must be cleaned up after writes finish')
})

test('refuses symlinks at ledger.ndjson or rotated files and never breaks packet delivery on write failure', async () => {
  const { base, project } = await setupLinkedFixture()
  const outsideTarget = join(base, 'outside-target.ndjson')
  writeFileSync(outsideTarget, '')

  const activePath = ledgerFilePath(project)
  symlinkSync(outsideTarget, activePath)

  // 1. CLI packet still succeeds and emits a scrubbed stderr warning without leaking content or paths
  const cliRes = await captureCli(['context', '--project', project, '--task', 'career identity check', '--json'])
  const packet = JSON.parse(cliRes.stdout)
  assert.equal(packet.status, 'complete')
  assert.match(cliRes.stderr, /\[warn\] served-context ledger write failed/)
  assert.ok(!cliRes.stderr.includes(project), 'warning must scrub project path')
  assert.ok(!cliRes.stderr.includes(DELIVERED_SELF_BODY), 'warning must never leak document content')
  assert.equal(readFileSync(outsideTarget, 'utf8'), '', 'symlink target must stay untouched')

  // 2. MCP packet still succeeds and writes one ledger/write audit entry on failure
  const auditFile = join(base, 'mcp-audit.ndjson')
  const mcpOut = []
  const session = createMcpSession({
    project,
    auditLog: auditFile,
    write: line => mcpOut.push(JSON.parse(line))
  })
  session(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }))
  session(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'holoself_context', arguments: { task: 'mcp symlink test' } }
    })
  )
  const toolResp = mcpOut.find(r => r.id === 2)
  assert.ok(toolResp.result.structuredContent.data.context_receipt.context_hash)
  const auditLines = readFileSync(auditFile, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
  assert.ok(auditLines.some(item => item.event === 'ledger/write' && item.ok === false && item.error_code === 'LEDGER_SYMLINK_REFUSED'))

  // 3. Reading ledger entries refuses symlinked ledger file
  assert.throws(() => readLedgerEntries(project), /refuses symlink/)
})

test('CLI holoself ledger filters by --since, --lens, --surface, --limit, and --json', async () => {
  const { self, project } = await setupLinkedFixture()
  const keyBuf = getOrCreateLedgerKey(self)
  const baseEntries = [
    {
      served_at: '2026-10-01T10:00:00.000Z',
      surface: 'cli',
      mode: 'packet',
      host: 'claude',
      lens: 'general',
      task: 'task one'
    },
    {
      served_at: '2026-10-02T10:00:00.000Z',
      surface: 'mcp',
      mode: 'manifest',
      host: 'codex',
      lens: 'professional',
      task: 'task two'
    },
    {
      served_at: '2026-10-03T10:00:00.000Z',
      surface: 'hook',
      mode: 'packet',
      host: 'claude',
      lens: 'professional',
      task: null
    }
  ]
  for (const [idx, item] of baseEntries.entries()) {
    appendLedgerLine(project, {
      schema_version: 2,
      served_at: item.served_at,
      surface: item.surface,
      mode: item.mode,
      host: item.host,
      lens: item.lens,
      budget: 'standard',
      need: 'helpful',
      task_hmac: item.task ? computeTaskHmac(item.task, keyBuf) : null,
      context_hash: `ctx-${idx}`,
      packet_id: `pkt-${idx}`,
      source_ids: [`hs-0000000000000000000${idx}`],
      counts:
        item.mode === 'manifest'
          ? { items_listed: idx + 1, restricted: 0, envelope_dropped: 0 }
          : { documents_delivered: idx + 1, restricted: 0, envelope_dropped: 0 },
      total_bytes: 500 + idx
    })
  }

  const byLens = JSON.parse((await captureCli(['ledger', '--project', project, '--lens', 'professional', '--json'])).stdout)
  assert.equal(byLens.schema_version, 2)
  assert.equal(byLens.count, 2)
  assert.deepEqual(
    byLens.entries.map(e => e.surface),
    ['mcp', 'hook']
  )

  const bySurface = JSON.parse((await captureCli(['ledger', '--project', project, '--surface', 'mcp', '--json'])).stdout)
  assert.equal(bySurface.count, 1)
  assert.equal(bySurface.entries[0].host, 'codex')
  assert.equal(bySurface.entries[0].mode, 'manifest')

  const bySince = JSON.parse((await captureCli(['ledger', '--project', project, '--since', '2026-10-02T12:00:00.000Z', '--json'])).stdout)
  assert.equal(bySince.count, 1)
  assert.equal(bySince.entries[0].surface, 'hook')

  const byLimit = JSON.parse((await captureCli(['ledger', '--project', project, '--limit', '1', '--json'])).stdout)
  assert.equal(byLimit.count, 1)
  assert.equal(byLimit.entries[0].packet_id, 'pkt-2')

  const humanTable = (await captureCli(['ledger', '--project', project])).stdout
  assert.match(humanTable, /SERVED_AT/)
  assert.match(humanTable, /MODE/)
  assert.match(humanTable, /TASK_HMAC/)
  assert.match(humanTable, /professional/)
})

test('Workbench GET /api/ledger enforces token auth, filters by space/lens/surface/limit, and omits paths', async () => {
  const { self, project } = await setupLinkedFixture()
  await captureCli(['context', '--project', project, '--lens', 'professional', '--task', 'workbench api check', '--json'], {
    env: { CLAUDE_CODE: '1' }
  })

  const app = await startWebServer({ root: self, project, port: 0 })
  try {
    // Rejects missing or wrong token
    const unauth = await httpCall(app, '/api/ledger')
    assert.equal(unauth.status, 403)

    // Authorized call returns entries and space summaries with IDs only (no paths)
    const authed = await httpCall(app, '/api/ledger?limit=10&lens=professional&surface=cli', {
      headers: { 'x-holoself-token': app.token }
    })
    assert.equal(authed.status, 200)
    const body = JSON.parse(authed.body)
    assert.equal(body.ok, true)
    assert.equal(body.data.entries.length, 1)
    assert.equal(body.data.entries[0].lens, 'professional')
    assert.equal(body.data.entries[0].surface, 'cli')
    assert.equal(body.data.entries[0].mode, 'packet')
    assert.equal(body.data.entries[0].host, 'claude')
    assert.ok(body.data.entries[0].task_hmac)
    assert.ok(!authed.body.includes(project), '/api/ledger response must never expose project filesystem path')
    assert.ok(!authed.body.includes(self), '/api/ledger response must never expose self filesystem path')
  } finally {
    await new Promise(done => app.server.close(done))
  }
})
