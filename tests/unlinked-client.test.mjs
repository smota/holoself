// Unlinked client identity (`client:unlinked`, issue #99): client registry, `mcp --client` binding, per-call
// attestation, self-only one-lens retrieval, ledger attribution, the opt-in proposal inbox with owner approval, and
// host configuration print/apply safety. See docs/decisions/unlinked-client-identity.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, linkSync, mkdirSync, rmSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArguments, run } from '../src/cli.mjs'
import { assertClientLens, attestClient, clientLensProblem, removeLensUnlessUsed } from '../src/clients/attestation.mjs'
import { addClient, clientsFilePath, readClientRegistry, writeClientRegistry } from '../src/clients/registry.mjs'
import { loadLensRegistry } from '../src/lenses.mjs'
import { createMcpSession, createMcpToolPool, executeToolJob, MCP_TOOLS, CLIENT_READ_TOOLS, CLIENT_PROPOSAL_TOOLS, resolveClientBinding } from '../src/mcp-server.mjs'
import {
  applyClientHostConfig,
  assertApplyPlatform,
  clientConfigSnippet,
  clientHostPlan,
  clientHostStatus
} from '../src/mcp-client-config.mjs'
import { clientInboxLockPath, createInboxProposal, CLIENT_INBOX_LIMIT, withClientInboxLock } from '../src/proposals/client-inbox.mjs'
import { spawn } from 'node:child_process'
import { scanProposalStore } from '../src/proposals/store.mjs'
import { resolveCaller } from '../src/retrieval/caller.mjs'
import { clientMcpContextData } from '../src/retrieval/client-mcp.mjs'
import { hash } from '../src/shared/fs.mjs'
import { startWebServer } from '../src/web-server.mjs'

const BIN = fileURLToPath(new URL('../bin/holoself.mjs', import.meta.url))
const temp = prefix => mkdtemp(join(tmpdir(), `holoself-client-${prefix}-`))
async function capture(fn) {
  const old = console.log
  let out = ''
  console.log = (...x) => {
    out += x.join(' ') + '\n'
  }
  try {
    await fn()
  } finally {
    console.log = old
  }
  return out
}
async function refusal(fn) {
  try {
    await fn()
  } catch (error) {
    return error
  }
  assert.fail('expected a refusal')
}
const doc = (lenses, body, extra = '') =>
  `---\naccess_lenses: [${lenses.join(', ')}]\ndisclosure: internal-only\nsensitivity: personal\ndocument_role: content\n${extra}---\n${body}\n`

async function fixture({ proposals = 'disabled', lens = 'professional' } = {}) {
  const self = await temp('self')
  await capture(() => run(['init', '--root', self]))
  await writeFile(join(self, 'profile', 'identity.md'), doc(['general', 'professional', 'private'], '# Identity\n\nClient parity marker.'))
  await writeFile(join(self, 'context', 'secret-diary.md'), doc(['private'], '# Diary\n\nPrivate diary marker.'))
  await writeFile(
    join(self, 'context', 'restricted-notes.md'),
    '---\naccess_lenses: [general, professional, private]\ndisclosure: internal-only\nsensitivity: restricted\ndocument_role: content\n---\n# Notes\n\nRestricted marker.\n'
  )
  await writeFile(join(self, 'context', 'scoped.md'), doc(['general', 'professional', 'private'], '# Scoped\n\nRestricted scope marker.', 'read_scope: restricted\n'))
  const added = JSON.parse(await capture(() => run(['client', 'add', '--root', self, '--name', 'desk', '--lens', lens, '--proposals', proposals, '--json'])))
  return { self, client: { self, client_id: added.client.client_id }, entry: added.client }
}
function session(client, extra = {}) {
  const output = [],
    accept = createMcpSession({ client, write: line => output.push(JSON.parse(line)), ...extra })
  accept(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', clientInfo: { name: 'Claude Desktop', version: '1' } } }))
  return {
    output,
    accept,
    list() {
      accept(JSON.stringify({ jsonrpc: '2.0', id: 'list', method: 'tools/list' }))
      return output.at(-1).result.tools
    },
    call(id, name, args = {}) {
      accept(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }))
      return output.at(-1).result.structuredContent
    }
  }
}
const ledgerLines = self => {
  const file = join(self, '.holoself', 'ledger.ndjson')
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
}

// ---------------------------------------------------------------------------------------------------------------
// Registry
test('client registry: absent reads empty; malformed, wrong schema, unknown fields and duplicates fail closed', async () => {
  const self = await temp('reg')
  await capture(() => run(['init', '--root', self]))
  assert.deepEqual(readClientRegistry(self).clients, [])
  const file = clientsFilePath(self),
    entry = { client_id: '6f1c2a0e-4d0b-4f7e-9a51-2a8d3b1e9c47', name: 'a', lens: 'professional', status: 'active', proposals: 'disabled', created_at: '2026-11-04T10:00:00.000Z', revoked_at: null }
  mkdirSync(join(self, '.holoself'), { recursive: true })
  const bad = [
    '{not json',
    JSON.stringify({ schema_version: 2, clients: [] }),
    JSON.stringify({ schema_version: 1, clients: [{ ...entry, extra: true }] }),
    JSON.stringify({ schema_version: 1, clients: [entry, { ...entry, name: 'b' }] }),
    JSON.stringify({ schema_version: 1, clients: [entry, { ...entry, client_id: '7f1c2a0e-4d0b-4f7e-9a51-2a8d3b1e9c47' }] }),
    JSON.stringify({ schema_version: 1, clients: [{ ...entry, status: 'revoked' }] }),
    JSON.stringify({ schema_version: 1, clients: [{ ...entry, client_id: 'not-a-uuid' }] }),
    JSON.stringify({ schema_version: 1, clients: [], other: 1 })
  ]
  for (const raw of bad) {
    writeFileSync(file, raw)
    assert.equal((await refusal(() => readClientRegistry(self))).code, 'CLIENT_REGISTRY_SCHEMA_INVALID', raw)
    // The server fails closed on the same file.
    assert.equal((await refusal(() => attestClient(self, entry.client_id))).code, 'CLIENT_REGISTRY_SCHEMA_INVALID')
  }
  writeFileSync(file, JSON.stringify({ schema_version: 1, clients: [entry] }))
  assert.equal(readClientRegistry(self).clients.length, 1)
  // Base-hash concurrency check.
  const before = readClientRegistry(self)
  writeFileSync(file, JSON.stringify({ schema_version: 1, clients: [] }))
  assert.equal((await refusal(() => writeClientRegistry(self, before.clients, before.baseHash))).code, 'CLIENT_REGISTRY_CONCURRENT_MODIFICATION')
})

test('client add|list|revoke|remove behave as specified; registry is 0600 and gitignored', async () => {
  const { self, entry } = await fixture()
  assert.match(entry.client_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(entry.status, 'active')
  assert.equal(entry.proposals, 'disabled')
  assert.equal(entry.revoked_at, null)
  if (process.platform !== 'win32') assert.equal(statSync(clientsFilePath(self)).mode & 0o777, 0o600)
  assert.match(readFileSync(join(self, '.holoself', '.gitignore'), 'utf8'), /^clients\.json\*$/m)
  // Lens rules: missing, private, invalid name, duplicate name.
  for (const [args, code] of [
    [['--name', 'x', '--lens', 'private'], 'CLIENT_LENS_INVALID'],
    [['--name', 'x', '--lens', 'nope'], 'CLIENT_LENS_INVALID'],
    [['--name', 'Bad Name', '--lens', 'general'], 'INVALID_ARGUMENT'],
    [['--name', 'desk', '--lens', 'general'], 'CLIENT_NAME_TAKEN'],
    [['--name', 'x', '--lens', 'general', '--proposals', 'auto'], 'INVALID_ARGUMENT']
  ])
    assert.equal((await refusal(() => run(['client', 'add', '--root', self, ...args]))).code, code, args.join(' '))
  const listed = JSON.parse(await capture(() => run(['client', 'list', '--root', self, '--json'])))
  assert.deepEqual(listed.clients.map(c => c.name), ['desk'])
  assert.match(await capture(() => run(['client', 'list', '--root', self])), /desk\s+professional\s+active/)
  // remove refuses an active client; revoke by name, then remove by id.
  assert.equal((await refusal(() => run(['client', 'remove', '--root', self, 'desk']))).code, 'CLIENT_ACTIVE')
  const revoked = JSON.parse(await capture(() => run(['client', 'revoke', '--root', self, 'desk', '--json'])))
  assert.equal(revoked.client.status, 'revoked')
  assert.ok(Date.parse(revoked.client.revoked_at))
  assert.equal(JSON.parse(await capture(() => run(['client', 'list', '--root', self, '--json']))).clients[0].status, 'revoked')
  await capture(() => run(['client', 'remove', '--root', self, entry.client_id]))
  assert.deepEqual(readClientRegistry(self).clients, [])
  assert.equal((await refusal(() => run(['client', 'revoke', '--root', self, entry.client_id]))).code, 'CLIENT_UNKNOWN')
})

test('client lens and proposal mode are immutable: no edit command or flag exists', async () => {
  const { self } = await fixture()
  for (const argv of [
    ['client', 'revoke', 'desk', '--root', self, '--lens', 'general'],
    ['client', 'revoke', 'desk', '--root', self, '--proposals', 'inbox'],
    ['client', 'list', '--root', self, '--lens', 'general']
  ])
    assert.equal((await refusal(() => run(argv))).code, 'OPTION_NOT_SUPPORTED', argv.join(' '))
  for (const sub of ['set', 'edit', 'update'])
    await assert.rejects(() => run(['client', sub, 'desk', '--root', self]), /unknown command|client requires/)
  assert.equal(readClientRegistry(self).clients[0].lens, 'professional')
})

test('a lens used by any client entry cannot be removed (Workbench lens remove), until the client is removed', async () => {
  const self = await temp('lensrm')
  await capture(() => run(['init', '--root', self]))
  writeFileSync(join(self, 'lenses', 'desk-lens.json'), JSON.stringify({ schema_version: 1, id: 'desk-lens', title: 'Desk', sensitivity_access: [], instructions: { purpose: 'desk' } }))
  await capture(() => run(['client', 'add', '--root', self, '--name', 'desk', '--lens', 'desk-lens']))
  const registryHash = () => loadLensRegistry(self).registry_hash
  assert.equal((await refusal(() => removeLensUnlessUsed(self, 'desk-lens', registryHash()))).code, 'CLIENT_LENS_IN_USE')
  await capture(() => run(['client', 'revoke', '--root', self, 'desk']))
  assert.equal((await refusal(() => removeLensUnlessUsed(self, 'desk-lens', registryHash()))).code, 'CLIENT_LENS_IN_USE')
  await capture(() => run(['client', 'remove', '--root', self, 'desk']))
  const after = await removeLensUnlessUsed(self, 'desk-lens', registryHash())
  assert.equal(after.byId.has('desk-lens'), false)
})

test('Workbench: lens removal refuses a client lens; inbox review goes through the proposal API', async () => {
  const { self, client } = await fixture({ proposals: 'inbox' })
  rmSync(join(self, 'context', 'restricted-notes.md'))
  rmSync(join(self, 'context', 'scoped.md'))
  writeFileSync(join(self, 'lenses', 'desk-lens.json'), JSON.stringify({ schema_version: 1, id: 'desk-lens', title: 'Desk', sensitivity_access: [], instructions: { purpose: 'desk' } }))
  await capture(() => run(['client', 'add', '--root', self, '--name', 'other', '--lens', 'desk-lens']))
  const created = session(client).call(2, 'holoself_proposal_create', { claim: 'Workbench reviewed claim.', evidence: 'chat', target: 'profile/identity.md' }).data
  const app = await startWebServer({ project: await temp('wb-cwd'), root: self, port: 0 })
  const call = async (path, { method = 'GET', body } = {}) => {
    const origin = new URL(app.url).origin
    const response = await globalThis.fetch(`${app.url}${path}`, {
      method,
      headers: { 'x-holoself-token': app.token, origin, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    })
    return { status: response.status, json: await response.json() }
  }
  try {
    const lenses = await call('/api/lenses')
    const refused = await call('/api/lenses/desk-lens', { method: 'DELETE', body: { expectedHash: lenses.json.data.registry_hash } })
    assert.equal(refused.status, 400)
    assert.equal(refused.json.error.code, 'CLIENT_LENS_IN_USE')
    assert.ok(existsSync(join(self, 'lenses', 'desk-lens.json')))
    const listed = await call('/api/proposals?inbox=1')
    assert.deepEqual(listed.json.data.map(p => p.proposal_id), [created.proposal_id])
    const preview = await call(`/api/proposals/${created.proposal_id}/preview`, { method: 'POST', body: { inbox: true } })
    assert.equal(preview.status, 200, JSON.stringify(preview.json))
    const approved = await call(`/api/proposals/${created.proposal_id}/approve`, { method: 'POST', body: { inbox: true, previewHash: preview.json.data.previewHash } })
    assert.equal(approved.status, 200, JSON.stringify(approved.json))
    assert.match(readFileSync(join(self, 'profile', 'identity.md'), 'utf8'), /Workbench reviewed claim\./)
  } finally {
    await new Promise(done => app.server.close(done))
  }
})

test('client lens rule: private and restricted-granting lenses are refused', async () => {
  const fake = { byId: new Map([['wide', { id: 'wide', sensitivity_access: ['restricted'] }], ['ok', { id: 'ok', sensitivity_access: [] }]]) }
  assert.match(clientLensProblem(fake, 'wide'), /restricted/)
  assert.match(clientLensProblem(fake, 'private'), /owner-exclusive/)
  assert.equal(clientLensProblem(fake, 'ok'), null)
  const self = await temp('lensrule')
  await capture(() => run(['init', '--root', self]))
  assert.equal((await refusal(() => assertClientLens(self, 'private'))).code, 'CLIENT_LENS_INVALID')
})

// ---------------------------------------------------------------------------------------------------------------
// Binding
test('mcp --client refuses --project, --claude-project-dir and CLAUDE_PROJECT_DIR; unknown, revoked and bad roots', async () => {
  const { self, client } = await fixture()
  for (const options of [{ project: self }, { requireClaudeProject: true }, { env: { CLAUDE_PROJECT_DIR: '/tmp/somewhere' } }])
    assert.equal((await refusal(() => resolveClientBinding({ client: client.client_id, root: self, env: {}, ...options }))).code, 'CLIENT_BINDING_CONFLICT')
  assert.deepEqual(resolveClientBinding({ client: client.client_id, root: self, env: {} }), client)
  // Without --root the server uses HOLOSELF_HOME.
  assert.equal(resolveClientBinding({ client: client.client_id, env: { HOLOSELF_HOME: self } }).self, self)
  assert.equal((await refusal(() => resolveClientBinding({ client: '00000000-0000-4000-8000-000000000000', root: self, env: {} }))).code, 'CLIENT_UNKNOWN')
  assert.equal((await refusal(() => resolveClientBinding({ client: 'desk', root: self, env: {} }))).code, 'CLIENT_UNKNOWN')
  assert.equal((await refusal(() => resolveClientBinding({ client: client.client_id, root: './relative-self', env: {} }))).code, 'CLIENT_ROOT_NOT_ABSOLUTE')
  assert.equal((await refusal(() => parseArguments(['mcp', '--client', client.client_id, '--root', './relative-self']))).code, 'CLIENT_ROOT_NOT_ABSOLUTE')
  assert.equal((await refusal(() => run(['mcp', '--client', client.client_id, '--root', './relative-self']))).code, 'CLIENT_ROOT_NOT_ABSOLUTE')
  assert.equal((await refusal(() => run(['mcp', 'configure', '--client', client.client_id, '--platform', 'generic', '--root', 'relative/self']))).code, 'CLIENT_ROOT_NOT_ABSOLUTE')
  const notSelf = await temp('notself')
  assert.equal((await refusal(() => resolveClientBinding({ client: client.client_id, root: notSelf, env: {} }))).code, 'CLIENT_ROOT_INVALID')
  if (process.platform !== 'win32') {
    const alias = join(await temp('alias'), 'self')
    symlinkSync(self, alias)
    assert.equal((await refusal(() => resolveClientBinding({ client: client.client_id, root: alias, env: {} }))).code, 'CLIENT_ROOT_INVALID')
  }
  await capture(() => run(['client', 'revoke', '--root', self, 'desk']))
  assert.equal((await refusal(() => resolveClientBinding({ client: client.client_id, root: self, env: {} }))).code, 'CLIENT_REVOKED')
})

test('spawned holoself mcp --client serves status without a project, and fails closed on a binding conflict', async () => {
  const { self, client } = await fixture()
  const env = { ...process.env, HOLOSELF_ERROR_FORMAT: 'json' }
  delete env.CLAUDE_PROJECT_DIR
  const input =
    [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', clientInfo: { name: 'Claude Desktop' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'holoself_status', arguments: {} } }
    ]
      .map(JSON.stringify)
      .join('\n') + '\n'
  const cwd = await temp('cwd')
  const ok = spawnSync(process.execPath, [BIN, 'mcp', '--client', client.client_id, '--root', self], { input, cwd, env, encoding: 'utf8', windowsHide: true })
  assert.equal(ok.status, 0, ok.stderr)
  assert.equal(ok.stderr, '')
  const status = JSON.parse(ok.stdout.trim().split('\n')[1]).result.structuredContent.data
  assert.equal(status.identity, 'client:unlinked')
  assert.equal(status.client.name, 'desk')
  assert.doesNotMatch(ok.stdout, new RegExp(self.replaceAll('\\', '\\\\')))
  const conflict = spawnSync(process.execPath, [BIN, 'mcp', '--client', client.client_id, '--root', self, '--project', cwd], { input, env, encoding: 'utf8', windowsHide: true })
  assert.equal(conflict.status, 1)
  assert.equal(conflict.stdout, '')
  assert.equal(JSON.parse(conflict.stderr).holoself_error.code, 'CLIENT_BINDING_CONFLICT')
  const claude = spawnSync(process.execPath, [BIN, 'mcp', '--client', client.client_id, '--root', self], {
    input,
    env: { ...env, CLAUDE_PROJECT_DIR: cwd },
    encoding: 'utf8',
    windowsHide: true
  })
  assert.equal(JSON.parse(claude.stderr).holoself_error.code, 'CLIENT_BINDING_CONFLICT')
  await capture(() => run(['client', 'revoke', '--root', self, 'desk']))
  const revoked = spawnSync(process.execPath, [BIN, 'mcp', '--client', client.client_id, '--root', self], { input, env, encoding: 'utf8', windowsHide: true })
  assert.equal(revoked.status, 1)
  assert.equal(JSON.parse(revoked.stderr).holoself_error.code, 'CLIENT_REVOKED')
})

test('identity is never accepted from tool arguments; tool schemas carry no identity, root or client field', async () => {
  const { client } = await fixture()
  for (const tool of [...MCP_TOOLS, ...CLIENT_READ_TOOLS, ...CLIENT_PROPOSAL_TOOLS]) {
    assert.equal(tool.inputSchema.additionalProperties, false)
    for (const key of ['identity', 'root', 'self', 'client', 'client_id', 'project']) assert.equal(key in tool.inputSchema.properties, false, `${tool.name}.${key}`)
  }
  const m = session(client)
  const viaTool = m.call(2, 'holoself_context', { task: 'x', identity: 'owner:direct' })
  assert.equal(viaTool.error.code, 'INVALID_ARGUMENT')
  assert.match(viaTool.error.message, /identity is not allowed/)
  assert.equal(m.call(3, 'holoself_context', { task: 'x', client_id: '00000000-0000-4000-8000-000000000000' }).error.code, 'INVALID_ARGUMENT')
  assert.equal((await refusal(() => clientMcpContextData(client, { task: 'x', identity: 'owner:direct' }))).code, 'IDENTITY_NOT_ACCEPTED_FROM_CALLER')
  assert.equal((await refusal(() => clientMcpContextData(client, { task: 'x', root: '/' }))).code, 'IDENTITY_NOT_ACCEPTED_FROM_CALLER')
  assert.equal((await refusal(() => resolveCaller({ identity: 'owner:direct', unlinkedClient: client }))).code, 'IDENTITY_NOT_ACCEPTED_FROM_CALLER')
  // An unlinked binding can never be combined with a project selector.
  assert.equal((await refusal(() => resolveCaller({ unlinkedClient: client, project: client.self }))).code, 'CLIENT_BINDING_CONFLICT')
})

// ---------------------------------------------------------------------------------------------------------------
// Per-call attestation
test('per-call attestation: revocation and a lens edit fail the next call on a running inline session', async () => {
  const { self, client } = await fixture()
  writeFileSync(join(self, 'lenses', 'desk-lens.json'), JSON.stringify({ schema_version: 1, id: 'desk-lens', title: 'Desk', sensitivity_access: [], instructions: { purpose: 'desk' } }))
  const second = await addClient(self, { name: 'second', lens: 'desk-lens' }, { checkLens: lens => assertClientLens(self, lens) })
  const m = session(client),
    m2 = session({ self, client_id: second.client_id })
  assert.equal(m.call(2, 'holoself_status').data.client.lens, 'professional')
  assert.equal(m2.call(2, 'holoself_status').data.client.lens, 'desk-lens')
  // Editing the lens so it grants `restricted` makes the definition (and the grant) invalid.
  writeFileSync(join(self, 'lenses', 'desk-lens.json'), JSON.stringify({ schema_version: 1, id: 'desk-lens', title: 'Desk', sensitivity_access: ['restricted'], instructions: { purpose: 'desk' } }))
  assert.equal(m2.call(3, 'holoself_context', { task: 'parity' }).error.code, 'CLIENT_LENS_INVALID')
  writeFileSync(join(self, 'lenses', 'desk-lens.json'), JSON.stringify({ schema_version: 1, id: 'desk-lens', title: 'Desk', sensitivity_access: [], instructions: { purpose: 'desk' } }))
  assert.equal(m2.call(4, 'holoself_status').data.client.lens, 'desk-lens')
  await capture(() => run(['client', 'revoke', '--root', self, 'desk']))
  for (const [id, name, args] of [
    [5, 'holoself_status', {}],
    [6, 'holoself_context', { task: 'parity' }],
    [7, 'holoself_search', { query: 'parity' }]
  ])
    assert.equal(m.call(id, name, args).error.code, 'CLIENT_REVOKED', name)
  // Removing the entry entirely reads as unknown.
  await capture(() => run(['client', 'remove', '--root', self, 'desk']))
  assert.equal(m.call(8, 'holoself_status').error.code, 'CLIENT_UNKNOWN')
})

test('per-call attestation with the worker pool: revocation mid-session takes effect without a restart', async () => {
  const { self, client } = await fixture()
  const pool = createMcpToolPool({ size: 2 }),
    output = []
  try {
    const accept = createMcpSession({ client, pool, auditLog: undefined, write: line => output.push(JSON.parse(line)) })
    const send = (id, name, args = {}) => accept(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }))
    accept(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }))
    send(2, 'holoself_context', { task: 'parity marker' })
    send(3, 'holoself_status')
    await accept.drain()
    const byId = id => output.find(item => item.id === id)
    assert.ok(byId(2).result.structuredContent.data.self.documents.length)
    assert.equal(byId(3).result.structuredContent.data.identity, 'client:unlinked')
    await capture(() => run(['client', 'revoke', '--root', self, 'desk']))
    // Same worker-affinity key as call 2: a worker that had cached anything would still answer.
    send(4, 'holoself_context', { task: 'parity marker' })
    send(5, 'holoself_status')
    await accept.drain()
    assert.equal(byId(4).result.structuredContent.error.code, 'CLIENT_REVOKED')
    assert.equal(byId(5).result.structuredContent.error.code, 'CLIENT_REVOKED')
  } finally {
    await pool.close()
  }
  // The worker entry point attests on its own too (no reliance on the main-thread check).
  const job = executeToolJob(null, 'holoself_context', { task: 'parity marker' }, client)
  assert.equal(job.ok, false)
  assert.equal(job.error.code, 'CLIENT_REVOKED')
})

test('per-call attestation with the worker pool: revoking during a slow in-flight call returns CLIENT_REVOKED and writes no ledger entry', async () => {
  const { self, client } = await fixture()
  const pool = createMcpToolPool({ size: 1, simulateWorkMs: { holoself_context: 350 } }),
    output = []
  try {
    const accept = createMcpSession({ client, pool, auditLog: undefined, write: line => output.push(JSON.parse(line)) })
    accept(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', clientInfo: { name: 'Claude Desktop' } } }))
    accept(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'holoself_context', arguments: { task: 'parity marker' } } }))
    await new Promise(done => setTimeout(done, 60))
    assert.equal(accept.inFlight(), 1)
    assert.equal(output.find(item => item.id === 2), undefined)
    await capture(() => run(['client', 'revoke', '--root', self, 'desk']))
    await accept.drain()
    const reply = output.find(item => item.id === 2)
    assert.equal(reply.result.isError, true)
    assert.equal(reply.result.structuredContent.error.code, 'CLIENT_REVOKED')
    assert.equal(reply.result.structuredContent.data, undefined)
    assert.deepEqual(ledgerLines(self), [])
  } finally {
    await pool.close()
  }
})

// ---------------------------------------------------------------------------------------------------------------
// Scope
test('client scope: one lens, self only, never private or restricted material, no paths', async () => {
  const { self, client } = await fixture()
  // A linked project with its own content must never reach the client.
  const project = await temp('project')
  await mkdir(join(project, 'Context'), { recursive: true })
  await writeFile(join(project, 'Context', 'evidence.md'), '# Evidence\n\nProject-only marker.\n')
  await capture(() => run(['link', 'add', '--project', project, '--self', self, '--lens', 'professional', '--no-activate', '--yes']))
  const m = session(client)
  for (const lens of ['private', 'general', 'technical']) assert.equal(m.call(2, 'holoself_context', { task: 'marker', lens }).error.code, 'LENS_NOT_GRANTED', lens)
  assert.equal(m.call(3, 'holoself_search', { query: 'marker', lens: 'private' }).error.code, 'LENS_NOT_GRANTED')
  const inputs = [
    ['holoself_context', { task: 'marker' }],
    ['holoself_context', { task: 'private diary restricted notes scope', budget: 'deep', temporal: 'all' }],
    ['holoself_context_manifest', { task: 'marker', budget: 'deep' }],
    ['holoself_context_manifest', { session_start: true }],
    ['holoself_search', { query: 'marker' }],
    ['holoself_search', { query: 'diary' }]
  ]
  let id = 10
  for (const [name, args] of inputs) {
    const result = m.call(id++, name, args)
    assert.ok(result.data, `${name}: ${JSON.stringify(result.error)}`)
    const text = JSON.stringify(result.data)
    for (const marker of ['Private diary marker', 'Restricted marker', 'Restricted scope marker', 'Project-only marker'])
      assert.doesNotMatch(text, new RegExp(marker), `${name} leaked ${marker}`)
    assert.equal(text.includes(self), false, `${name} leaked the self path`)
    assert.equal(text.includes(project), false, `${name} leaked a project path`)
    if (name !== 'holoself_search') {
      assert.deepEqual(result.data.project, { name: null, documents: [] })
      assert.deepEqual(result.data.methods.documents, [])
      assert.equal(result.data.lens, 'professional')
      assert.ok(result.data.sources.every(source => !source.path.startsWith('Context/')))
    } else assert.ok(result.data.results.every(row => row.source_kind === 'self'))
  }
  // The session-harvest prompt drafts project-evidence proposals; an unlinked client lists no prompts.
  m.accept(JSON.stringify({ jsonrpc: '2.0', id: 'prompts', method: 'prompts/list' }))
  assert.deepEqual(m.output.at(-1).result.prompts, [])
  m.accept(JSON.stringify({ jsonrpc: '2.0', id: 'prompt', method: 'prompts/get', params: { name: 'holoself_session_harvest' } }))
  assert.equal(m.output.at(-1).error.data.code, 'PROMPT_NOT_FOUND')
  const status = m.call(30, 'holoself_status').data
  assert.deepEqual(status.client, { name: 'desk', lens: 'professional', proposals: 'disabled', status: 'active' })
  assert.equal(status.identity, 'client:unlinked')
  assert.equal(JSON.stringify(status).includes(self), false)
  assert.equal(JSON.stringify(status).includes(client.client_id), false)
})

test('retrieval parity: a client packet equals the self portion of a linked packet (handles, hashes, caps)', async () => {
  const { self, client } = await fixture()
  const project = await temp('parity-project')
  await capture(() => run(['link', 'add', '--project', project, '--self', self, '--lens', 'professional', '--no-activate', '--yes']))
  const linkedOut = []
  const linkedAccept = createMcpSession({ project, write: line => linkedOut.push(JSON.parse(line)) })
  linkedAccept(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }))
  const linkedCall = (id, name, args) => {
    linkedAccept(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }))
    return linkedOut.at(-1).result.structuredContent.data
  }
  const m = session(client)
  for (const [name, args] of [
    // Budgets whose envelope is not under pressure: at the byte cap the linked packet's extra project fields can
    // drop one more trailing document than the client packet, which is the same cap applied to different bytes.
    ['holoself_context', { task: 'client parity marker', budget: 'standard' }],
    ['holoself_context', { task: 'client parity marker', budget: 'deep' }]
  ]) {
    const a = m.call(2, name, args).data,
      b = linkedCall(2, name, args)
    const selfOf = data => ({
      documents: data.self.documents.map(({ source_id, path, content, sha256, source_hash }) => ({ source_id, path, content, sha256, source_hash })),
      hashes: data.packet_metadata.source_hashes.filter(item => item.kind === 'self'),
      sources: data.sources.filter(item => item.kind === 'self').map(item => item.source_id),
      cap: data.selection.envelope_cap_bytes
    })
    assert.equal(a.selection.envelope_dropped, undefined)
    assert.equal(b.selection.envelope_dropped, undefined)
    assert.deepEqual(selfOf(a), selfOf(b), `${name} ${args.budget}`)
  }
  const manifest = m.call(3, 'holoself_context_manifest', { task: 'client parity marker' }).data,
    handle = manifest.sources.find(item => item.path === 'profile/identity.md').source_id
  const got = m.call(4, 'holoself_context_get', { source_ids: [handle] }).data
  assert.match(got.self.documents[0].content, /Client parity marker/)
  const linkedGot = linkedCall(4, 'holoself_context_get', { source_ids: [handle] })
  assert.deepEqual(got.self.documents, linkedGot.self.documents)
  // Over the same self records the receipt is identical too.
  assert.equal(got.context_receipt.context_hash, linkedGot.context_receipt.context_hash)
})

// ---------------------------------------------------------------------------------------------------------------
// Ledger
test('ledger: successful client context calls append one entry each with surface mcp and client_id; ledger --client filters', async () => {
  const { self, client } = await fixture()
  await capture(() => run(['client', 'add', '--root', self, '--name', 'other', '--lens', 'general']))
  const other = readClientRegistry(self).clients.find(entry => entry.name === 'other')
  const m = session(client),
    m2 = session({ self, client_id: other.client_id })
  m.call(2, 'holoself_status')
  m.call(3, 'holoself_context', { task: 'x', lens: 'private' })
  m.call(4, 'holoself_search', { query: 'marker' })
  assert.equal(ledgerLines(self).length, 0, 'status, search and failed calls append nothing')
  m.call(5, 'holoself_context', { task: 'client parity marker' })
  m.call(6, 'holoself_context_manifest', { task: 'client parity marker' })
  m2.call(7, 'holoself_context', { task: 'client parity marker' })
  const lines = ledgerLines(self)
  assert.equal(lines.length, 3)
  assert.deepEqual(lines.map(line => [line.surface, line.client_id, line.mode]), [
    ['mcp', client.client_id, 'packet'],
    ['mcp', client.client_id, 'manifest'],
    ['mcp', other.client_id, 'packet']
  ])
  assert.equal(lines[0].host, 'Claude Desktop')
  assert.doesNotMatch(JSON.stringify(lines), /Client parity marker/)
  const byName = JSON.parse(await capture(() => run(['ledger', '--root', self, '--client', 'desk', '--json'])))
  assert.equal(byName.count, 2)
  assert.ok(byName.entries.every(entry => entry.client_id === client.client_id))
  const byId = JSON.parse(await capture(() => run(['ledger', '--root', self, '--client', other.client_id, '--json'])))
  assert.equal(byId.count, 1)
  assert.equal((await refusal(() => run(['ledger', '--root', self, '--client', 'nobody']))).code, 'INVALID_LEDGER_FILTER')
  // A revoked client's call appends nothing.
  await capture(() => run(['client', 'revoke', '--root', self, 'desk']))
  m.call(8, 'holoself_context', { task: 'client parity marker' })
  assert.equal(ledgerLines(self).length, 3)
})

// ---------------------------------------------------------------------------------------------------------------
// Proposals
test('proposals disabled (default): tools are absent and refused, nothing is written', async () => {
  const { self, client } = await fixture()
  const m = session(client),
    names = m.list().map(tool => tool.name)
  assert.deepEqual(names, ['holoself_status', 'holoself_context', 'holoself_context_manifest', 'holoself_context_get', 'holoself_search'])
  assert.equal(m.call(2, 'holoself_proposal_create', { claim: 'x', evidence: 'y', target: 'profile/identity.md' }).error.code, 'CLIENT_PROPOSALS_DISABLED')
  assert.equal(m.call(3, 'holoself_proposal_preview', { proposal_id: '00000000-0000-4000-8000-000000000000' }).error.code, 'CLIENT_PROPOSALS_DISABLED')
  assert.equal(existsSync(join(self, 'proposals', 'inbox')), false)
})

test('proposals inbox: evidence, secrets, caps, provenance and writes only under proposals/inbox', async () => {
  const { self, client, entry } = await fixture({ proposals: 'inbox' })
  const m = session(client)
  const tools = m.list()
  assert.deepEqual(
    tools.map(tool => tool.name),
    ['holoself_status', 'holoself_context', 'holoself_context_manifest', 'holoself_context_get', 'holoself_search', 'holoself_proposal_create', 'holoself_proposal_preview']
  )
  const create = tools.find(tool => tool.name === 'holoself_proposal_create')
  assert.deepEqual(create.inputSchema.required, ['claim', 'evidence'])
  for (const key of ['source_files', 'operation', 'claim_id']) assert.equal(key in create.inputSchema.properties, false)
  assert.equal(tools.some(tool => /approve/.test(tool.name)), false)
  const before = hash(readFileSync(join(self, 'profile', 'identity.md'), 'utf8'))
  const ok = m.call(2, 'holoself_proposal_create', { claim: 'Prefers async written updates.', evidence: 'Said so in this chat.', target: 'profile/identity.md' })
  assert.ok(ok.data, JSON.stringify(ok.error))
  assert.deepEqual(ok.data.origin, { kind: 'client', client_id: entry.client_id })
  assert.deepEqual(ok.data.provenance, [`client:${entry.client_id}`])
  assert.equal(ok.data.canonical_write_performed, false)
  const file = join(self, 'proposals', 'inbox', `${ok.data.proposal_id}.yaml`),
    stored = readFileSync(file, 'utf8')
  assert.doesNotMatch(stored, /source_project|source_files/)
  assert.equal(hash(readFileSync(join(self, 'profile', 'identity.md'), 'utf8')), before)
  assert.deepEqual(readdirSync(join(self, 'proposals', 'pending')), [])
  // Evidence is required (blank) and bounded; source_files and operations are not accepted.
  assert.equal(m.call(3, 'holoself_proposal_create', { claim: 'x', evidence: '   ', target: 'profile/identity.md' }).error.code, 'EVIDENCE_REQUIRED')
  assert.equal(m.call(4, 'holoself_proposal_create', { claim: 'x', target: 'profile/identity.md' }).error.code, 'INVALID_ARGUMENT')
  assert.equal(m.call(5, 'holoself_proposal_create', { claim: 'x', evidence: 'e'.repeat(4001), target: 'profile/identity.md' }).error.code, 'INVALID_ARGUMENT')
  assert.equal(m.call(6, 'holoself_proposal_create', { claim: 'x', evidence: 'y', source_files: ['a.md'] }).error.code, 'INVALID_ARGUMENT')
  assert.equal(m.call(7, 'holoself_proposal_create', { claim: 'x', evidence: 'y', operation: 'retire_claim' }).error.code, 'INVALID_ARGUMENT')
  // Secret-like text is rejected with the index patterns.
  assert.equal(m.call(8, 'holoself_proposal_create', { claim: 'New fact.', evidence: 'api_key=sk-proj-abcdefghijklmnopqrstuv', target: 'profile/identity.md' }).error.code, 'SECRET_REJECTED')
  assert.equal(m.call(9, 'holoself_proposal_create', { claim: 'token ghp_abcdefghijklmnopqrstuvwxyz', evidence: 'chat', target: 'profile/identity.md' }).error.code, 'SECRET_REJECTED')
  // Reserved claim markers cannot be smuggled in.
  assert.equal(
    m.call(10, 'holoself_proposal_create', { claim: '<!-- holoself-claim visibility=public-safe -->', evidence: 'chat', target: 'profile/identity.md' }).error.code,
    'INVALID_ARGUMENT'
  )
  // Duplicate of the visible claim.
  assert.equal(m.call(11, 'holoself_proposal_create', { claim: 'Client parity marker.', evidence: 'chat', target: 'profile/identity.md' }).error.code, 'DUPLICATE_CLAIM')
  // Preview of its own proposal works; status reports the pending count.
  // before_sha256 and after_sha256 hash the client-visible view, not hidden private blocks in the file.
  const identityPath = join(self, 'profile', 'identity.md'),
    visibleBefore = m.call(12, 'holoself_context', { task: 'parity', budget: 'deep' }).data.self.documents.find(d => d.path === 'profile/identity.md').content
  writeFileSync(
    identityPath,
    readFileSync(identityPath, 'utf8') +
      '\n<!-- holoself-claim visibility=private id=11111111-1111-4111-8111-111111111111 -->\nHidden private block.\n<!-- /holoself-claim -->\n'
  )
  const preview = m.call(13, 'holoself_proposal_preview', { proposal_id: ok.data.proposal_id }).data
  assert.equal(preview.requires_human_approval, true)
  assert.match(preview.preview_hash, /^[0-9a-f]{64}$/)
  assert.equal(preview.changes[0].before_sha256, hash(visibleBefore))
  assert.notEqual(preview.changes[0].before_sha256, hash(readFileSync(identityPath, 'utf8')))
  writeFileSync(identityPath, readFileSync(identityPath, 'utf8').replace('Hidden private block.', 'Edited hidden private block.'))
  const previewAfterHiddenEdit = m.call(14, 'holoself_proposal_preview', { proposal_id: ok.data.proposal_id }).data
  assert.equal(previewAfterHiddenEdit.changes[0].before_sha256, preview.changes[0].before_sha256)
  assert.equal(previewAfterHiddenEdit.changes[0].after_sha256, preview.changes[0].after_sha256)
  assert.equal(m.call(15, 'holoself_status').data.pending_proposals, 1)
  assert.equal(readdirSync(join(self, 'proposals', 'inbox')).length, 1)
})

test('proposals inbox: invalid targets fail with one uniform error (no hidden-document oracle)', async () => {
  const { client } = await fixture({ proposals: 'inbox' })
  const m = session(client),
    errors = []
  let id = 2
  for (const target of ['context/secret-diary.md', 'context/restricted-notes.md', 'context/scoped.md', 'context/missing.md', '../outside.md', 'profile/identity.txt', 'reports/x.md', 'context'])
    errors.push(m.call(id++, 'holoself_proposal_create', { claim: 'A new claim.', evidence: 'chat', target }).error)
  assert.ok(errors.every(error => error.code === 'PROPOSAL_TARGET_INVALID'), JSON.stringify(errors))
  assert.equal(new Set(errors.map(error => error.message)).size, 1)
})

test('proposals inbox: 50 pending proposals per client, and preview is limited to the client own proposals', async () => {
  const { self, client, entry } = await fixture({ proposals: 'inbox' })
  for (let i = 0; i < CLIENT_INBOX_LIMIT; i++)
    createInboxProposal(self, entry, { claim: `Bulk claim ${i}.`, evidence: 'loop', target: 'profile/identity.md' })
  const m = session(client)
  assert.equal(m.call(2, 'holoself_proposal_create', { claim: 'One more.', evidence: 'loop', target: 'profile/identity.md' }).error.code, 'CLIENT_INBOX_FULL')
  // Another client's proposals are invisible to this client.
  await capture(() => run(['client', 'add', '--root', self, '--name', 'other', '--lens', 'professional', '--proposals', 'inbox']))
  const other = readClientRegistry(self).clients.find(item => item.name === 'other')
  const m2 = session({ self, client_id: other.client_id })
  const own = m2.call(3, 'holoself_proposal_create', { claim: 'Other client claim.', evidence: 'chat', target: 'profile/identity.md' }).data
  assert.equal(m.call(4, 'holoself_proposal_preview', { proposal_id: own.proposal_id }).error.code, 'PROPOSAL_NOT_FOUND')
  assert.equal(m.call(5, 'holoself_proposal_preview', { proposal_id: '00000000-0000-4000-8000-000000000000' }).error.code, 'PROPOSAL_NOT_FOUND')
})

test('proposals inbox cap holds under concurrency: two processes creating at 49 pending yield exactly 50', async () => {
  const { self, entry } = await fixture({ proposals: 'inbox' })
  for (let i = 0; i < CLIENT_INBOX_LIMIT - 1; i++) createInboxProposal(self, entry, { claim: `Bulk claim ${i}.`, evidence: 'loop', target: 'profile/identity.md' })
  const moduleUrl = new URL('../src/proposals/client-inbox.mjs', import.meta.url).href,
    startAt = Date.now() + 600
  const script = n =>
    `const { createInboxProposal } = await import(${JSON.stringify(moduleUrl)});` +
    `while (Date.now() < ${startAt});` +
    `try { createInboxProposal(${JSON.stringify(self)}, ${JSON.stringify(entry)}, { claim: 'Racing claim ${n}.', evidence: 'race', target: 'profile/identity.md' }); console.log('ok') }` +
    `catch (error) { console.log(error.code) }`
  const runChild = n =>
    new Promise((done, fail) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script(n)], { windowsHide: true })
      let out = ''
      child.stdout.on('data', chunk => (out += chunk))
      child.on('error', fail)
      child.on('close', () => done(out.trim()))
    })
  const results = (await Promise.all([runChild(1), runChild(2)])).sort()
  assert.deepEqual(results, ['CLIENT_INBOX_FULL', 'ok'])
  const pending = readdirSync(join(self, 'proposals', 'inbox')).filter(name => name.endsWith('.yaml'))
  assert.equal(pending.length, CLIENT_INBOX_LIMIT)
  assert.equal(existsSync(clientInboxLockPath(self)), false)
})

test('client inbox lock: a live holder blocks until timeout; a dead holder is broken; concurrent stale-lock breakers never exceed the cap', async () => {
  const self = await temp('inboxlock')
  mkdirSync(join(self, '.holoself'), { recursive: true })
  writeFileSync(clientInboxLockPath(self), JSON.stringify({ pid: process.pid, timestamp: Date.now() }))
  assert.equal((await refusal(() => withClientInboxLock(self, () => 'never', { timeoutMs: 100 }))).code, 'CLIENT_INBOX_LOCK_TIMEOUT')
  writeFileSync(clientInboxLockPath(self), JSON.stringify({ pid: 2147483646, timestamp: Date.now() }))
  assert.equal(withClientInboxLock(self, () => 'ran', { timeoutMs: 100 }), 'ran')
  assert.equal(existsSync(clientInboxLockPath(self)), false)
  // On release, only delete the lock if it still contains our own token.
  const foreignToken = JSON.stringify({ pid: 2147483646, timestamp: Date.now(), token: 'foreign' }) + '\n'
  withClientInboxLock(self, () => {
    writeFileSync(clientInboxLockPath(self), foreignToken)
  })
  assert.equal(readFileSync(clientInboxLockPath(self), 'utf8'), foreignToken)
  rmSync(clientInboxLockPath(self), { force: true })

  // Concurrent stale-lock breakers at 48 pending never exceed the 50-item cap.
  const { self: capSelf, entry } = await fixture({ proposals: 'inbox' })
  for (let i = 0; i < CLIENT_INBOX_LIMIT - 2; i++)
    createInboxProposal(capSelf, entry, { claim: `Stale race seed ${i}.`, evidence: 'loop', target: 'profile/identity.md' })
  writeFileSync(clientInboxLockPath(capSelf), JSON.stringify({ pid: 2147483646, timestamp: 1 }) + '\n')
  const moduleUrl = new URL('../src/proposals/client-inbox.mjs', import.meta.url).href,
    startAt = Date.now() + 600
  const script = n =>
    `const { createInboxProposal } = await import(${JSON.stringify(moduleUrl)});` +
    `while (Date.now() < ${startAt});` +
    `try { createInboxProposal(${JSON.stringify(capSelf)}, ${JSON.stringify(entry)}, { claim: 'Stale breaker claim ${n}.', evidence: 'race', target: 'profile/identity.md' }); console.log('ok') }` +
    `catch (error) { console.log(error.code) }`
  const runChild = n =>
    new Promise((done, fail) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script(n)], { windowsHide: true })
      let out = ''
      child.stdout.on('data', chunk => (out += chunk))
      child.on('error', fail)
      child.on('close', () => done(out.trim()))
    })
  const outcomes = (await Promise.all([runChild(1), runChild(2), runChild(3), runChild(4)])).sort()
  assert.deepEqual(outcomes, ['CLIENT_INBOX_FULL', 'CLIENT_INBOX_FULL', 'ok', 'ok'])
  const pending = readdirSync(join(capSelf, 'proposals', 'inbox')).filter(name => name.endsWith('.yaml'))
  assert.equal(pending.length, CLIENT_INBOX_LIMIT)
  assert.equal(existsSync(clientInboxLockPath(capSelf)), false)
})

test('inbox and project proposal records never validate in each other\'s store', async () => {
  const { self, entry } = await fixture({ proposals: 'inbox' })
  const p = createInboxProposal(self, entry, { claim: 'Cross-store claim.', evidence: 'chat', target: 'profile/identity.md' })
  const project = await temp('cross')
  await capture(() => run(['link', 'add', '--project', project, '--self', self, '--lens', 'professional', '--no-activate', '--yes']))
  mkdirSync(join(project, '.holoself', 'proposals'), { recursive: true })
  writeFileSync(join(project, '.holoself', 'proposals', `${p.proposal_id}.yaml`), readFileSync(join(self, 'proposals', 'inbox', `${p.proposal_id}.yaml`)))
  const scan = scanProposalStore(project)
  assert.equal(scan.managed.length, 0)
  assert.equal(scan.diagnostics[0].code, 'INVALID_PROPOSAL')
})

test('owner approval of inbox proposals via CLI (preview hash, transaction, archive, receipt); revoked clients stay reviewable', async () => {
  const { self, client } = await fixture({ proposals: 'inbox' })
  // Approval runs the full ecosystem validation, so drop the deliberately invalid leak-test documents first.
  rmSync(join(self, 'context', 'restricted-notes.md'))
  rmSync(join(self, 'context', 'scoped.md'))
  const m = session(client)
  const first = m.call(2, 'holoself_proposal_create', { claim: 'Prefers written updates.', evidence: 'Said so twice.', target: 'profile/identity.md' }).data
  const second = m.call(3, 'holoself_proposal_create', { claim: 'Dislikes surprise meetings.', evidence: 'Said so.', target: 'profile/identity.md' }).data
  const listed = JSON.parse(await capture(() => run(['proposals', 'list', '--inbox', '--root', self])))
  assert.equal(listed.length, 2)
  assert.deepEqual(listed[0].client, { name: 'desk', status: 'active', lens: 'professional' })
  assert.match(await capture(() => run(['proposals', 'show', first.proposal_id, '--inbox', '--root', self])), /# client: desk \(active\)/)
  // --inbox cannot be mixed with a project.
  await assert.rejects(() => run(['proposals', 'list', '--inbox', '--root', self, '--project', self]), /cannot be combined/)
  // The client is revoked after writing; the owner can still review, but plain-text approve warns that
  // 'client <name> is REVOKED' and requires --allow-revoked in non-TTY (or explicit interactive confirmation).
  await capture(() => run(['client', 'revoke', '--root', self, 'desk']))
  let stale = null
  const printed = await capture(() =>
    run(['proposals', 'approve', first.proposal_id, '--inbox', '--root', self, '--json', '--digest', '0'.repeat(64)]).catch(error => {
      stale = error
    })
  )
  assert.equal(stale?.code, 'STALE_PREVIEW', String(stale?.stack))
  const preview = JSON.parse(printed)
  assert.equal(preview.client.status, 'revoked')
  let withoutAllow = null
  const plainRevokedOut = await capture(() =>
    run(['proposals', 'approve', first.proposal_id, '--inbox', '--root', self, '--digest', preview.preview_hash, '--yes']).catch(error => {
      withoutAllow = error
    })
  )
  assert.equal(withoutAllow?.code, 'CLIENT_REVOKED')
  assert.match(withoutAllow?.message || '', /client desk is REVOKED/)
  assert.match(withoutAllow?.message || '', /--allow-revoked/)
  assert.match(plainRevokedOut, /client desk is REVOKED/)
  assert.doesNotMatch(readFileSync(join(self, 'profile', 'identity.md'), 'utf8'), /Prefers written updates\./)
  const approvedOut = await capture(() =>
    run(['proposals', 'approve', first.proposal_id, '--inbox', '--root', self, '--digest', preview.preview_hash, '--allow-revoked', '--yes'])
  )
  assert.match(approvedOut, /client desk is REVOKED/)
  const identity = readFileSync(join(self, 'profile', 'identity.md'), 'utf8')
  assert.match(identity, /Prefers written updates\./)
  assert.match(identity, new RegExp(`Provenance: client:${client.client_id}`))
  assert.ok(existsSync(join(self, 'proposals', 'approved', `${first.proposal_id}.yaml`)))
  const receipt = JSON.parse(readFileSync(join(self, 'proposals', 'receipts', `${first.proposal_id}-approved.json`), 'utf8'))
  assert.equal(receipt.preview_sha256, preview.preview_hash)
  assert.match(readFileSync(join(self, 'proposals', 'inbox', `${first.proposal_id}.yaml`), 'utf8'), /status: "approved"/)
  // Removed client also shows 'client <id> is REMOVED' and requires --allow-revoked in non-TTY.
  await capture(() => run(['client', 'remove', '--root', self, 'desk']))
  let removedRefusal = null
  const removedOut = await capture(() =>
    run(['proposals', 'approve', second.proposal_id, '--inbox', '--root', self, '--yes']).catch(error => {
      removedRefusal = error
    })
  )
  assert.equal(removedRefusal?.code, 'CLIENT_REVOKED')
  assert.match(removedOut, new RegExp(`client ${client.client_id} is REMOVED`))
  await capture(() => run(['proposals', 'reject', second.proposal_id, '--inbox', '--root', self, '--yes']))
  assert.ok(existsSync(join(self, 'proposals', 'rejected', `${second.proposal_id}.yaml`)))
  assert.doesNotMatch(readFileSync(join(self, 'profile', 'identity.md'), 'utf8'), /surprise meetings/)
})

// ---------------------------------------------------------------------------------------------------------------
// Host configuration
const VERIFIED = {
  platforms: [
    {
      platform: 'claude-desktop',
      host_version: 'test',
      verified_at: '2026-11-04',
      discovery: 'verified',
      no_canonical_write: true,
      pending_proposal_created: true,
      tools: Object.fromEntries(MCP_TOOLS.map(tool => [tool.name, { result: 'pass' }]))
    }
  ]
}
const COMMAND = { command: '/opt/holoself/bin/holoself', prefix: [], source: 'path' }
async function hostFixture() {
  const { self, client, entry } = await fixture()
  const home = await temp('home')
  const options = { platform: 'claude-desktop', os: 'darwin', home, env: {}, command: COMMAND, matrix: VERIFIED }
  const file = join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
  const apply = (extra = {}, io) => {
    const plan = clientHostPlan(self, entry.client_id, { ...options, ...extra })
    return applyClientHostConfig(self, entry.client_id, { ...options, ...extra, expectedPlanHash: plan.plan_sha256 }, io)
  }
  return { self, client, entry, home, options, file, apply }
}
test('mcp configure --client prints the snippet by default and writes nothing', async () => {
  const { self, entry } = await fixture()
  const snippet = clientConfigSnippet(self, 'desk', { platform: 'claude-desktop', command: COMMAND })
  assert.deepEqual(snippet.snippet.mcpServers.holoself, { command: '/opt/holoself/bin/holoself', args: ['mcp', '--client', entry.client_id, '--root', self] })
  assert.equal(snippet.writes, 'none')
  const generic = clientConfigSnippet(self, entry.client_id, { platform: 'generic', command: COMMAND })
  assert.deepEqual(generic.args, ['mcp', '--client', entry.client_id, '--root', self])
  // Through the CLI the command path is absolute (PATH lookup or node plus the package bin script).
  const home = await temp('printhome'),
    oldHome = process.env.HOME,
    oldAppData = process.env.APPDATA
  process.env.HOME = home
  process.env.APPDATA = home
  try {
    const printed = JSON.parse(await capture(() => run(['mcp', 'configure', '--client', 'desk', '--platform', 'claude-desktop', '--root', self])))
    const server = printed.snippet.mcpServers.holoself
    assert.ok(server.command.startsWith('/') || /^[A-Za-z]:[\\/]/.test(server.command))
    assert.deepEqual(server.args.slice(-5), ['mcp', '--client', entry.client_id, '--root', self])
    assert.deepEqual(readdirSync(home), [])
    // --apply refuses an unverified platform (the recorded matrix has no Claude Desktop run) and writes nothing.
    assert.equal(
      (await refusal(() => run(['mcp', 'configure', '--client', 'desk', '--platform', 'claude-desktop', '--apply', '--yes', '--root', self]))).code,
      'MCP_PLATFORM_NOT_VERIFIED'
    )
    assert.equal(
      (await refusal(() => run(['mcp', 'configure', '--client', 'desk', '--platform', 'generic', '--apply', '--yes', '--root', self]))).code,
      'MCP_PLATFORM_PRINT_ONLY'
    )
    assert.deepEqual(readdirSync(home), [])
    await assert.rejects(() => run(['mcp', 'configure', '--client', 'desk', '--platform', 'claude-desktop', '--project', self, '--root', self]), /cannot be combined/)
  } finally {
    if (oldHome === undefined) delete process.env.HOME
    else process.env.HOME = oldHome
    if (oldAppData === undefined) delete process.env.APPDATA
    else process.env.APPDATA = oldAppData
  }
  await capture(() => run(['client', 'revoke', '--root', self, 'desk']))
  assert.equal((await refusal(() => clientConfigSnippet(self, 'desk', { platform: 'claude-desktop', command: COMMAND }))).code, 'CLIENT_REVOKED')
})

test('mcp configure --client --apply: verified platform, preview hash, create/update with mode, backup, status and remove', async () => {
  const { self, entry, options, file, apply } = await hostFixture()
  assert.equal((await refusal(() => assertApplyPlatform('claude-desktop'))).code, 'MCP_PLATFORM_NOT_VERIFIED')
  assert.equal(assertApplyPlatform('claude-desktop', VERIFIED), undefined)
  assert.equal((await refusal(() => applyClientHostConfig(self, 'desk', { ...options, expectedPlanHash: 'stale' }))).code, 'MCP_PLAN_CHANGED')
  assert.equal(existsSync(file), false)
  // Create: new file, mode 0600, no backup.
  const created = apply()
  assert.equal(created.status, 'configured')
  assert.equal(created.backup, null)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).mcpServers.holoself.args, ['mcp', '--client', entry.client_id, '--root', self])
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.equal(apply().status, 'unchanged')
  assert.equal(clientHostStatus(self, 'desk', { os: 'darwin', home: options.home, env: {}, command: COMMAND, matrix: VERIFIED }).platforms[0].client_state, 'configured')
  // Update: other servers and keys are kept, mode 0644 is preserved, backup is 0600 with the original bytes.
  const original = JSON.stringify({ globalShortcut: 'x', mcpServers: { other: { command: '/bin/other', env: { TOKEN: 'secret-value-123' } } } }, null, 2)
  writeFileSync(file, original)
  if (process.platform !== 'win32') chmodSync(file, 0o644)
  const plan = clientHostPlan(self, 'desk', options)
  assert.equal(plan.preview.action, 'update')
  assert.equal(plan.preview.current_sha256, hash(original))
  assert.doesNotMatch(JSON.stringify({ ...plan, _write: undefined }), /secret-value-123/)
  const updated = apply()
  const next = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(next.mcpServers.other, { command: '/bin/other', env: { TOKEN: 'secret-value-123' } })
  assert.equal(next.globalShortcut, 'x')
  assert.ok(next.mcpServers.holoself)
  assert.ok(updated.backup.includes('.holoself-backup-'))
  assert.equal(readFileSync(updated.backup, 'utf8'), original)
  if (process.platform !== 'win32') {
    assert.equal(statSync(file).mode & 0o777, 0o644)
    assert.equal(statSync(updated.backup).mode & 0o777, 0o600)
  }
  // Remove deletes only the Holoself entry.
  const removed = apply({ remove: true })
  assert.equal(removed.status, 'removed')
  const after = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal('holoself' in after.mcpServers, false)
  assert.ok(after.mcpServers.other)
  assert.equal(apply({ remove: true }).status, 'unchanged')
  // Unknown OS path stays print-only.
  assert.equal((await refusal(() => clientHostPlan(self, 'desk', { ...options, os: 'linux' }))).code, 'MCP_HOST_PATH_UNKNOWN')
  const win = await temp('appdata')
  const winPlan = clientHostPlan(self, 'desk', { ...options, os: 'win32', env: { APPDATA: win } })
  assert.equal(winPlan.preview.path.endsWith('Claude/claude_desktop_config.json'), true)
})

test('mcp configure --client --apply refuses collisions, unparseable JSON, symlinks and hard links; rolls back a failed write', async () => {
  const { self, file, options, apply } = await hostFixture()
  mkdirSync(join(file, '..'), { recursive: true })
  // Collision with a different holoself entry.
  const divergent = JSON.stringify({ mcpServers: { holoself: { command: 'holoself', args: ['mcp', '--project', '/x'] } } })
  writeFileSync(file, divergent)
  assert.equal((await refusal(() => clientHostPlan(self, 'desk', options))).code, 'MCP_DIVERGENT')
  assert.equal((await refusal(() => apply({ remove: true }))).code, 'MCP_DIVERGENT')
  assert.equal(readFileSync(file, 'utf8'), divergent)
  const replaced = apply({ forceReplace: true })
  assert.equal(replaced.preview.action, 'replace')
  assert.equal(readFileSync(replaced.backup, 'utf8'), divergent)
  // Unparseable JSON is never rewritten.
  writeFileSync(file, '{ "mcpServers": { broken')
  assert.equal((await refusal(() => apply())).code, 'MCP_HOST_CONFIG_INVALID')
  assert.equal(readFileSync(file, 'utf8'), '{ "mcpServers": { broken')
  // Rollback: a failing write restores the original bytes and mode.
  writeFileSync(file, '{}\n')
  assert.throws(() =>
    apply({}, {
      write: (path, content) => {
        writeFileSync(path, content.slice(0, 5))
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
      }
    })
  , /disk full/)
  assert.equal(readFileSync(file, 'utf8'), '{}\n')
  if (process.platform === 'win32') return
  // Hard link.
  const other = join(options.home, 'hardlink.json')
  linkSync(file, other)
  assert.equal((await refusal(() => apply())).code, 'MCP_HOST_UNSAFE_PATH')
  rmLink(other)
  // Symlinked file.
  const real = join(options.home, 'real.json')
  writeFileSync(real, '{}')
  rmLink(file)
  symlinkSync(real, file)
  assert.equal((await refusal(() => apply())).code, 'MCP_HOST_UNSAFE_PATH')
  assert.equal(readFileSync(real, 'utf8'), '{}')
  // Symlinked directory below the home boundary.
  const home2 = await temp('home2'),
    elsewhere = await temp('elsewhere')
  symlinkSync(elsewhere, join(home2, 'Library'))
  assert.equal((await refusal(() => clientHostPlan(self, 'desk', { ...options, home: home2 }))).code, 'MCP_HOST_UNSAFE_PATH')
  assert.deepEqual(readdirSync(elsewhere), [])
})
function rmLink(path) {
  rmSync(path, { force: true })
}
