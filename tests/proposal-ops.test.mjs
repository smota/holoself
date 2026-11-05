// Proposal operations that replace, supersede and retire existing claims through the review flow (issue #70).
import './helpers/isolated-config.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { run } from '../src/cli.mjs'
import { ecosystemValidationErrors } from '../src/ecosystem.mjs'
import { legacyClaimId, parseClaimBlocks, proposalClaimId } from '../src/markdown/claim-blocks.mjs'
import { createMcpSession, MCP_TOOLS } from '../src/mcp-server.mjs'
import { registryLockPath } from '../src/link/registry.mjs'
import { createProposal, proposalPreviewData, validateProposal } from '../src/proposals/store.mjs'
import { validate } from './helpers/evidence-contract.mjs'

const sha = text => createHash('sha256').update(text).digest('hex')
const temp = () => mkdtemp(join(tmpdir(), 'holoself-ops-'))
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
const FRONT = '---\naccess_lenses: [general, professional, private]\ndisclosure: internal-only\nsensitivity: personal\ndocument_role: content\n---\n'
const legacyBlock = (visibility, label, text) =>
  `<!-- holoself-claim visibility=${visibility} -->\n## Approved proposal legacy/${label}\n\n${text}\n\n- Evidence: synthetic notes\n` +
  `- Confidence: confirmed\n- Visibility: ${visibility}\n- Provenance: synthetic:notes.md\n- Approved: 2026-01-01T00:00:00.000Z\n<!-- /holoself-claim -->\n`
const VISIBLE = 'Leads platform reliability engineering for regulated systems.'
const HIDDEN = 'Keeps a private weekly running routine on Sundays.'
const OTHER = 'Mentors two staff engineers on incident reviews.'
async function fixture() {
  const self = await temp(),
    project = await temp()
  await capture(() => run(['init', '--root', self]))
  await writeFile(
    join(self, 'context', 'claims.md'),
    `${FRONT}# Claims\n\n${legacyBlock('professional', 'one', VISIBLE)}\n${legacyBlock('private', 'two', HIDDEN)}\n${legacyBlock('professional', 'three', OTHER)}`
  )
  await mkdir(join(project, 'Context'), { recursive: true })
  await writeFile(join(project, 'Context', 'evidence.md'), '# Evidence\n\nSynthetic project evidence for claim review.\n')
  await capture(() => run(['link', 'add', '--project', project, '--self', self, '--lens', 'professional', '--no-activate', '--yes']))
  return { self, project, claims: join(self, 'context', 'claims.md') }
}
const ids = { visible: legacyClaimId('context/claims.md', VISIBLE), hidden: legacyClaimId('context/claims.md', HIDDEN), other: legacyClaimId('context/claims.md', OTHER) }
const propose = async (project, args) =>
  JSON.parse(await capture(() => run(['propose', '--project', project, '--source-file', 'Context/evidence.md', ...args])))
async function approve(project, id) {
  const preview = proposalPreviewData(project, id)
  await capture(() => run(['proposals', 'approve', id, '--project', project, '--preview-hash', preview.preview_hash, '--yes']))
  return preview
}
const receiptOf = async (self, id) => JSON.parse(await readFile(join(self, 'proposals', 'receipts', `${id}-approved.json`), 'utf8'))
const blockById = (text, id) => parseClaimBlocks(text, 'context/claims.md').find(block => block.claim_id === id)
const contextText = async (project, extra = []) =>
  JSON.parse(await capture(() => run(['context', '--project', project, '--lens', 'professional', '--json', ...extra])))
    .self.documents.map(doc => doc.content)
    .join('\n')
function session(project) {
  const output = [],
    accept = createMcpSession({ project, write: line => output.push(JSON.parse(line)) })
  accept(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }))
  return {
    call(id, name, args = {}) {
      accept(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }))
      return output.at(-1).result
    }
  }
}

test('new approvals write a stable claim id derived from the proposal', async () => {
  const { self, project, claims } = await fixture(),
    made = await propose(project, ['--claim', 'Prefers written design reviews before large refactors.', '--visibility', 'professional'])
  await approve(project, made.proposal_id)
  const block = blockById(await readFile(claims, 'utf8'), proposalClaimId(made.proposal_id, 'claim'))
  assert.ok(block && !block.legacy && block.status === 'current')
  assert.deepEqual(ecosystemValidationErrors(self), [])
})

test('replace_claim rewrites the targeted claim in place, keeps its id, and records a receipt', async () => {
  const { self, project, claims } = await fixture(),
    before = await readFile(claims, 'utf8'),
    made = await propose(project, ['--op', 'replace', '--claim-id', ids.visible, '--claim', 'Leads platform reliability for regulated AI systems.', '--evidence', 'Context/evidence.md'])
  assert.equal(made.changes[0].operation, 'replace_claim')
  assert.equal(made.changes[0].proposal_type, 'fact_correction')
  const shown = await capture(() => run(['proposals', 'show', made.proposal_id, '--project', project]))
  assert.match(shown, new RegExp(`# claim: replace claim ${ids.visible} in context/claims.md`))
  const preview = await approve(project, made.proposal_id)
  assert.match(preview.changes[0].preview, /^-<!-- holoself-claim visibility=professional -->/m)
  assert.match(preview.changes[0].preview, new RegExp(`^\\+<!-- holoself-claim access_lenses=general,professional,interview,private disclosure=review-required id=${ids.visible} -->`, 'm'))
  assert.equal(preview.changes[0].before_sha256, sha(before))
  const after = await readFile(claims, 'utf8'),
    block = blockById(after, ids.visible)
  assert.equal(block.text, 'Leads platform reliability for regulated AI systems.')
  assert.equal(block.status, 'current')
  assert.doesNotMatch(after, new RegExp(VISIBLE))
  assert.equal(parseClaimBlocks(after).filter(x => x.legacy).length, 2, 'untargeted legacy claims are not rewritten')
  const receipt = await receiptOf(self, made.proposal_id)
  assert.deepEqual(receipt.applied_changes, [
    { change_id: 'claim', operation: 'replace_claim', target: 'context/claims.md', claim_id: ids.visible, before_sha256: sha(before), after_sha256: sha(after) }
  ])
  assert.deepEqual(ecosystemValidationErrors(self), [])
})

test('supersede_claim appends the new claim and keeps the old one as linked history', async () => {
  const { self, project, claims } = await fixture(),
    made = await propose(project, ['--op', 'supersede', '--claim-id', ids.visible, '--claim', 'Leads AI platform engineering across regulated products.', '--evidence', 'Context/evidence.md'])
  await approve(project, made.proposal_id)
  const after = await readFile(claims, 'utf8'),
    newId = proposalClaimId(made.proposal_id, 'claim'),
    old = blockById(after, ids.visible),
    replacement = blockById(after, newId)
  assert.equal(old.status, 'superseded')
  assert.equal(old.attrs.superseded_by, newId)
  assert.match(old.attrs.superseded_at, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(old.text, VISIBLE, 'superseded wording is preserved')
  assert.equal(replacement.attrs.supersedes, ids.visible)
  assert.equal(replacement.visibility, 'professional')
  assert.ok(after.trimEnd().endsWith(replacement.raw))
  const receipt = await receiptOf(self, made.proposal_id)
  assert.equal(receipt.applied_changes[0].operation, 'supersede_claim')
  assert.equal(receipt.applied_changes[0].claim_id, newId)
  assert.equal(receipt.applied_changes[0].after_sha256, sha(after))
  assert.deepEqual(ecosystemValidationErrors(self), [])
})

test('retire_claim marks the claim historical with a reason and keeps its text', async () => {
  const { self, project, claims } = await fixture(),
    made = await propose(project, ['--op', 'retire', '--claim-id', ids.other, '--reason', 'Mentoring program ended in 2026.', '--evidence', 'Context/evidence.md'])
  assert.equal(made.changes[0].claim, undefined)
  await approve(project, made.proposal_id)
  const after = await readFile(claims, 'utf8'),
    block = blockById(after, ids.other)
  assert.equal(block.status, 'historical')
  assert.match(block.attrs.retired_at, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(block.text, OTHER)
  assert.match(block.raw, /- Retirement reason: Mentoring program ended in 2026\./)
  assert.doesNotMatch(after, /<commit-time>/)
  assert.deepEqual(ecosystemValidationErrors(self), [])
})

test('approval with a stale preview hash or a target changed after preview fails STALE_PREVIEW', async () => {
  const { project, claims } = await fixture(),
    made = await propose(project, ['--op', 'retire', '--claim-id', ids.other, '--reason', 'No longer accurate.', '--evidence', 'Context/evidence.md']),
    preview = proposalPreviewData(project, made.proposal_id)
  await writeFile(claims, (await readFile(claims, 'utf8')) + '\nManual edit after preview.\n')
  const changed = await readFile(claims, 'utf8')
  await assert.rejects(
    capture(() => run(['proposals', 'approve', made.proposal_id, '--project', project, '--preview-hash', preview.preview_hash, '--yes'])),
    error => error.code === 'STALE_PREVIEW'
  )
  assert.equal(await readFile(claims, 'utf8'), changed)
  assert.match(await readFile(join(project, '.holoself', 'proposals', `${made.proposal_id}.yaml`), 'utf8'), /status: "pending"/)
})

test('missing, hidden-by-status and already superseded claims are refused', async () => {
  const { project } = await fixture()
  await assert.rejects(
    propose(project, ['--op', 'retire', '--claim-id', '00000000-0000-4000-8000-000000000000', '--reason', 'gone', '--evidence', 'e']),
    error => error.code === 'CLAIM_NOT_FOUND'
  )
  const first = await propose(project, ['--op', 'supersede', '--claim-id', ids.visible, '--claim', 'A newer reliability leadership claim.', '--evidence', 'e']),
    second = await propose(project, ['--op', 'replace', '--claim-id', ids.visible, '--claim', 'A competing reliability correction.', '--evidence', 'e'])
  await approve(project, first.proposal_id)
  // A pending proposal whose claim was superseded meanwhile cannot be previewed or approved.
  assert.throws(() => proposalPreviewData(project, second.proposal_id), error => error.code === 'CLAIM_NOT_CURRENT')
  await assert.rejects(capture(() => run(['proposals', 'approve', second.proposal_id, '--project', project, '--yes'])), error => error.code === 'CLAIM_NOT_CURRENT')
  await assert.rejects(propose(project, ['--op', 'retire', '--claim-id', ids.visible, '--reason', 'again', '--evidence', 'e']), error => error.code === 'CLAIM_NOT_CURRENT')
  await assert.rejects(propose(project, ['--op', 'replace', '--claim-id', ids.other, '--claim', OTHER, '--evidence', 'e']), error => error.code === 'CLAIM_UNCHANGED')
  await assert.rejects(propose(project, ['--op', 'retire', '--claim-id', ids.other, '--reason', 'r', '--evidence', 'e', '--target-file', '../outside.md']), /contained relative Markdown path|Markdown under/)
  await assert.rejects(propose(project, ['--op', 'retire', '--claim-id', ids.other, '--reason', 'r']), /requires --evidence/)
})

test('grouped changes apply in order and a failure on the second target restores every target', async t => {
  const { self, project, claims } = await fixture(),
    topic = join(self, 'topics', 'roles.md')
  await mkdir(join(self, 'topics'), { recursive: true })
  await writeFile(topic, `${FRONT}# Roles\n\n${legacyBlock('professional', 'four', 'Owns the reliability review calendar.')}`)
  const claimsBefore = await readFile(claims, 'utf8'),
    topicBefore = await readFile(topic, 'utf8'),
    topicId = legacyClaimId('topics/roles.md', 'Owns the reliability review calendar.'),
    p = createProposal(project, {
      source_files: ['Context/evidence.md'],
      changes: [
        { operation: 'supersede_claim', claim_id: ids.visible, claim: 'Leads reliability across regulated AI products.', evidence: 'e' },
        { operation: 'retire_claim', claim_id: ids.other, reason: 'Program ended.', evidence: 'e' },
        { operation: 'retire_claim', target: 'topics/roles.md', claim_id: topicId, reason: 'Calendar handed over.', evidence: 'e' }
      ]
    })
  assert.deepEqual(
    p.changes.map(x => x.change_id),
    ['change-1', 'change-2', 'change-3']
  )
  const preview = proposalPreviewData(project, p.proposal_id)
  assert.deepEqual(
    preview.changes.map(x => [x.operation, x.target]),
    [
      ['supersede_claim', 'context/claims.md'],
      ['retire_claim', 'context/claims.md'],
      ['retire_claim', 'topics/roles.md']
    ]
  )
  // Hashes chain across changes to the same file: each change starts from the file its predecessor produced.
  assert.equal(preview.changes[1].before_sha256, preview.changes[0].after_sha256)
  assert.equal(preview.changes[0].before_sha256, sha(claimsBefore))
  // Post-apply validation failure: an invalid canonical file makes approval roll back both targets.
  const bad = join(self, 'context', 'invalid.md')
  await writeFile(bad, '---\nvisibility: invalid\n---\n# Invalid\n')
  await assert.rejects(capture(() => run(['proposals', 'approve', p.proposal_id, '--project', project, '--yes'])), /validation/)
  assert.equal(await readFile(claims, 'utf8'), claimsBefore)
  assert.equal(await readFile(topic, 'utf8'), topicBefore)
  await writeFile(bad, FRONT + '# Valid now\n')
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    // Mid-apply write failure: the second target's directory is read-only, so the first target must be restored.
    chmodSync(join(self, 'topics'), 0o555)
    try {
      await assert.rejects(capture(() => run(['proposals', 'approve', p.proposal_id, '--project', project, '--yes'])))
    } finally {
      chmodSync(join(self, 'topics'), 0o755)
    }
    assert.equal(await readFile(claims, 'utf8'), claimsBefore)
    assert.equal(await readFile(topic, 'utf8'), topicBefore)
  } else t.diagnostic('read-only directory failure injection skipped on this platform/user')
  await capture(() => run(['proposals', 'approve', p.proposal_id, '--project', project, '--yes']))
  const after = await readFile(claims, 'utf8')
  assert.equal(blockById(after, ids.visible).status, 'superseded')
  assert.equal(blockById(after, ids.other).status, 'historical')
  assert.equal(parseClaimBlocks(await readFile(topic, 'utf8'), 'topics/roles.md')[0].status, 'historical')
  const receipt = await receiptOf(self, p.proposal_id)
  assert.equal(receipt.applied_changes[0].before_sha256, sha(claimsBefore))
  assert.equal(receipt.applied_changes[1].before_sha256, receipt.applied_changes[0].after_sha256)
  assert.equal(receipt.applied_changes[1].after_sha256, sha(after))
  assert.equal(receipt.applied_changes[2].before_sha256, sha(topicBefore))
  assert.deepEqual(
    receipt.applied_changes.map(x => [x.change_id, x.operation, x.target]),
    [
      ['change-1', 'supersede_claim', 'context/claims.md'],
      ['change-2', 'retire_claim', 'context/claims.md'],
      ['change-3', 'retire_claim', 'topics/roles.md']
    ]
  )
})

test('retrieval excludes superseded and retired claims unless the temporal selector asks for them', async () => {
  const { project } = await fixture(),
    next = 'Leads AI platform engineering across regulated products.',
    superseding = await propose(project, ['--op', 'supersede', '--claim-id', ids.visible, '--claim', next, '--evidence', 'e']),
    search = async (extra = []) => JSON.parse(await capture(() => run(['search', 'mentors', '--project', project, '--json', ...extra]))).results
  assert.ok((await search()).length > 0, 'the claim is searchable while current')
  await approve(project, superseding.proposal_id)
  await approve(project, (await propose(project, ['--op', 'retire', '--claim-id', ids.other, '--reason', 'ended', '--evidence', 'e'])).proposal_id)
  const current = await contextText(project)
  assert.match(current, new RegExp(next))
  assert.doesNotMatch(current, new RegExp(VISIBLE))
  assert.doesNotMatch(current, new RegExp(OTHER))
  const all = await contextText(project, ['--temporal', 'all'])
  assert.match(all, new RegExp(VISIBLE))
  assert.match(all, new RegExp(OTHER))
  assert.match(all, new RegExp(next))
  assert.equal((await search()).length, 0)
  assert.ok((await search(['--temporal', 'all'])).length > 0, 'retired claims stay searchable as history')
})

test('MCP accepts the claim operations, never approves, and only exposes ids of visible claims', async () => {
  const { project, claims } = await fixture(),
    m = session(project),
    tool = MCP_TOOLS.find(x => x.name === 'holoself_proposal_create')
  assert.deepEqual(tool.inputSchema.properties.operation.enum, ['append_claim', 'replace_claim', 'supersede_claim', 'retire_claim'])
  assert.equal(tool.inputSchema.additionalProperties, false)
  assert.ok(!MCP_TOOLS.some(x => /approve|reject|apply/.test(x.name)))
  const packet = JSON.stringify(m.call(2, 'holoself_context', { task: 'platform reliability engineering claims' }).structuredContent)
  assert.match(packet, new RegExp(`id=${ids.visible}`))
  assert.ok(!packet.includes(ids.hidden), 'hidden claim id must not appear in delivered context')
  assert.ok(!packet.includes(HIDDEN))
  const hidden = m.call(3, 'holoself_proposal_create', { operation: 'retire_claim', claim_id: ids.hidden, reason: 'probe', evidence: 'e', source_files: ['Context/evidence.md'] })
  assert.equal(hidden.isError, true)
  assert.equal(hidden.structuredContent.error.code, 'CLAIM_NOT_FOUND')
  const unknown = m.call(4, 'holoself_proposal_create', { operation: 'retire_claim', claim_id: ids.other, reason: 'r', evidence: 'e', source_files: ['Context/evidence.md'], extra: 1 })
  assert.equal(unknown.isError, true)
  const before = await readFile(claims, 'utf8'),
    created = m.call(5, 'holoself_proposal_create', {
      operation: 'supersede_claim',
      claim_id: ids.visible,
      claim: 'Leads AI platform engineering across regulated products.',
      evidence: 'Context/evidence.md',
      source_files: ['Context/evidence.md']
    }).structuredContent.data
  assert.equal(created.status, 'pending')
  const preview = m.call(6, 'holoself_proposal_preview', { proposal_id: created.proposal_id }).structuredContent.data
  assert.equal(preview.canonical_write_performed, false)
  assert.equal(preview.changes[0].operation, 'supersede_claim')
  assert.match(preview.changes[0].before_block, new RegExp(VISIBLE))
  assert.ok(!JSON.stringify(preview).includes(HIDDEN))
  assert.equal(await readFile(claims, 'utf8'), before, 'MCP never writes canonical self')
  // A proposal the owner made against a hidden claim cannot be previewed through MCP.
  const owner = await propose(project, ['--op', 'retire', '--claim-id', ids.hidden, '--reason', 'private', '--evidence', 'e'])
  const refused = m.call(7, 'holoself_proposal_preview', { proposal_id: owner.proposal_id })
  assert.equal(refused.isError, true)
  assert.ok(!JSON.stringify(refused).includes(HIDDEN))
})

test('legacy claims get their deterministic id only when targeted, matching delivered context', async () => {
  const { project, claims } = await fixture(),
    delivered = await contextText(project)
  assert.match(delivered, new RegExp(`<!-- holoself-claim disclosure=review-required id=${ids.visible} -->`))
  assert.doesNotMatch(await readFile(claims, 'utf8'), /id=/, 'delivery never rewrites canonical files')
  await approve(project, (await propose(project, ['--op', 'retire', '--claim-id', ids.visible, '--reason', 'r', '--evidence', 'e'])).proposal_id)
  const after = await readFile(claims, 'utf8')
  assert.match(after, new RegExp(`id=${ids.visible} status=historical`))
  assert.equal((after.match(/ id=/g) || []).length, 1)
})

test('proposal validation rejects unknown change keys and requires evidence, and the JSON schema agrees', () => {
  const base = {
      schema_version: 2,
      proposal_id: '11111111-2222-4333-8444-555555555555',
      title: 'Synthetic',
      source_project: 'p',
      source_files: ['notes.md'],
      status: 'pending',
      created_at: '2026-11-04T00:00:00.000Z',
      provenance: ['p:notes.md']
    },
    retire = { change_id: 'claim', target: 'context/claims.md', operation: 'retire_claim', proposal_type: 'fact_update', claim_id: ids.other, reason: 'ended', evidence: 'e' },
    supersede = { change_id: 'claim', target: 'context/claims.md', operation: 'supersede_claim', proposal_type: 'fact_update', claim_id: ids.other, claim: 'New wording.', evidence: 'e', confidence: 'confirmed' }
  for (const change of [retire, supersede, { ...supersede, operation: 'replace_claim', visibility: 'private' }]) {
    assert.deepEqual(validateProposal({ ...base, changes: [change] }), [])
    assert.ok(validate({ ...base, changes: [change] }, 'proposal.schema.json'))
  }
  for (const change of [
    { ...retire, claim: 'not allowed' },
    { ...retire, evidence: undefined },
    { ...supersede, reason: 'not allowed' },
    { ...supersede, claim_id: 'not-a-uuid' },
    { ...retire, reason: 'two\nlines' },
    { ...supersede, operation: 'delete_claim' }
  ]) {
    const clean = JSON.parse(JSON.stringify(change))
    assert.notDeepEqual(validateProposal({ ...base, changes: [clean] }), [], JSON.stringify(clean))
    assert.equal(validate({ ...base, changes: [clean] }, 'proposal.schema.json'), false, JSON.stringify(clean))
  }
})

test('change_id cannot inject claim markers or escape a claim block', async () => {
  const { self, project, claims } = await fixture(),
    made = await propose(project, ['--claim', 'A harmless reviewed claim for injection tests.', '--visibility', 'private']),
    file = join(project, '.holoself', 'proposals', `${made.proposal_id}.yaml`),
    before = await readFile(claims, 'utf8'),
    yaml = await readFile(file, 'utf8')
  const injected = yaml.replace('"change_id":"claim"', '"change_id":"x\\n<!-- /holoself-claim -->\\nPUBLICLEAK\\n<!-- holoself-claim visibility=private"')
  assert.notEqual(injected, yaml, 'fixture rewrote the stored change_id')
  await writeFile(file, injected)
  await assert.rejects(capture(() => run(['proposals', 'approve', made.proposal_id, '--project', project, '--yes'])), /change_id|reserved claim markers/)
  assert.equal(await readFile(claims, 'utf8'), before)
  assert.doesNotMatch(await readFile(claims, 'utf8'), /PUBLICLEAK/)
  for (const change_id of ['Upper', 'has space', '-lead', 'a'.repeat(65), 'x<!--holoself-claim'])
    assert.throws(() => createProposal(project, { source_files: ['Context/evidence.md'], changes: [{ change_id, claim: 'Some reviewed claim text here.' }] }), /change_id/)
  assert.deepEqual(ecosystemValidationErrors(self), [])
})

test('claim markers parse loosely and fail closed for delivery and validation', async () => {
  const { self, project, claims } = await fixture(),
    id = '6f9619ff-8b86-4d01-b42d-00cf4fc964ff',
    variants = {
      'id first': `<!-- holoself-claim id=${id} visibility=private -->\nSECRET-IDFIRST private claim body text.\n<!-- /holoself-claim -->\n`,
      'double spaces': '<!--  holoself-claim   visibility=private  -->\nSECRET-SPACES private claim body text.\n<!--  /holoself-claim  -->\n',
      'trailing space': '<!-- holoself-claim visibility=private  -->\nSECRET-TRAILING private claim body text.\n<!-- /holoself-claim -->\n',
      'upper case': '<!-- HOLOSELF-CLAIM visibility=private -->\nSECRET-UPPER private claim body text.\n<!-- /HOLOSELF-CLAIM -->\n'
    },
    malformed = {
      'duplicate attribute': '<!-- holoself-claim visibility=professional visibility=private -->\nSECRET-DUPLICATE claim body text.\n<!-- /holoself-claim -->\n',
      'unknown attribute': '<!-- holoself-claim visibility=professional owner=me -->\nSECRET-UNKNOWN claim body text.\n<!-- /holoself-claim -->\n',
      'unclosed opener': '<!-- holoself-claim visibility=private -->\nSECRET-UNCLOSED claim body text.\n'
    },
    base = await readFile(claims, 'utf8')
  for (const [name, block] of Object.entries({ ...variants, ...malformed })) {
    await writeFile(claims, `${base}\n${block}`)
    const secret = block.match(/SECRET-[A-Z]+/)[0]
    for (const temporal of ['current', 'all']) assert.doesNotMatch(await contextText(project, ['--temporal', temporal]), new RegExp(secret), `${name} (${temporal})`)
    const packet = JSON.stringify(session(project).call(2, 'holoself_context', { task: 'claim body text', temporal: 'all' }).structuredContent)
    assert.ok(!packet.includes(secret), `${name} via MCP`)
    const errors = ecosystemValidationErrors(self)
    if (name in malformed) assert.ok(errors.some(x => /claim marker|unbalanced/.test(x)), `${name} must fail validation: ${errors}`)
    else assert.deepEqual(errors, [], name)
  }
})

test('MCP duplicate and ambiguity checks only consider claims the link can read', async () => {
  const { project, claims } = await fixture()
  // A private twin of the visible legacy claim shares its wording and therefore its computed id.
  await writeFile(claims, (await readFile(claims, 'utf8')) + '\n' + legacyBlock('private', 'twin', VISIBLE))
  const m = session(project),
    hiddenDuplicate = m.call(2, 'holoself_proposal_create', { claim: HIDDEN, evidence: 'e', source_files: ['Context/evidence.md'], visibility: 'professional' })
  assert.ok(!hiddenDuplicate.isError, 'a hidden duplicate must not be revealed through MCP')
  await assert.rejects(capture(() => run(['proposals', 'approve', hiddenDuplicate.structuredContent.data.proposal_id, '--project', project, '--yes'])), error => error.code === 'DUPLICATE_CLAIM')
  const visibleDuplicate = m.call(3, 'holoself_proposal_create', { claim: OTHER, evidence: 'e', source_files: ['Context/evidence.md'] })
  assert.equal(visibleDuplicate.structuredContent.error.code, 'DUPLICATE_CLAIM')
  const twin = m.call(4, 'holoself_proposal_create', { operation: 'retire_claim', claim_id: ids.visible, reason: 'r', evidence: 'e', source_files: ['Context/evidence.md'] })
  assert.ok(!twin.isError, JSON.stringify(twin))
  const preview = m.call(5, 'holoself_proposal_preview', { proposal_id: twin.structuredContent.data.proposal_id })
  assert.ok(!preview.isError)
  assert.match(preview.structuredContent.data.changes[0].before_block, /disclosure=review-required/)
  await assert.rejects(capture(() => run(['proposals', 'approve', twin.structuredContent.data.proposal_id, '--project', project, '--yes'])), error => error.code === 'CLAIM_AMBIGUOUS')
})

test('MCP preview reports a hidden target as not found even after its status changed', async () => {
  const { project } = await fixture(),
    retire = await propose(project, ['--op', 'retire', '--claim-id', ids.hidden, '--reason', 'r', '--evidence', 'e']),
    later = await propose(project, ['--op', 'supersede', '--claim-id', ids.hidden, '--claim', 'A different private routine claim.', '--evidence', 'e'])
  await approve(project, retire.proposal_id)
  const result = session(project).call(2, 'holoself_proposal_preview', { proposal_id: later.proposal_id })
  assert.equal(result.structuredContent.error.code, 'CLAIM_NOT_FOUND')
})

test('literal <commit-time> text is preserved; only this proposal\'s placeholder is stamped', async () => {
  const { project, claims } = await fixture()
  await writeFile(claims, (await readFile(claims, 'utf8')) + '\nOwner note: templates mention <commit-time> literally.\n')
  const made = await propose(project, ['--claim', 'Release notes keep the <commit-time> token verbatim.', '--visibility', 'professional'])
  const preview = await approve(project, made.proposal_id),
    after = await readFile(claims, 'utf8')
  assert.match(preview.changes[0].preview, /- Approved: <commit-time>/)
  assert.match(after, /templates mention <commit-time> literally/)
  assert.match(after, /keep the <commit-time> token verbatim/)
  assert.match(after, /- Approved: \d{4}-\d{2}-\d{2}T/)
  assert.doesNotMatch(after, /@@holoself-commit-time/)
})

test('preview flags visibility changes and approval waits on the self registry lock', async () => {
  const { self, project, claims } = await fixture(),
    made = await propose(project, ['--op', 'replace', '--claim-id', ids.visible, '--claim', 'Leads reliability engineering in public talks.', '--evidence', 'e', '--visibility', 'public-safe']),
    preview = proposalPreviewData(project, made.proposal_id)
  assert.deepEqual(preview.changes[0].visibility_change, { from: 'professional', to: 'public-safe' })
  assert.equal(preview.changes[0].evidence, 'e')
  const lock = registryLockPath(self),
    before = await readFile(claims, 'utf8')
  await mkdir(dirname(lock), { recursive: true })
  writeFileSync(lock, JSON.stringify({ pid: process.pid, timestamp: Date.now() }) + '\n')
  await assert.rejects(
    capture(() => run(['proposals', 'approve', made.proposal_id, '--project', project, '--yes'])),
    error => error.code === 'REGISTRY_LOCK_TIMEOUT'
  )
  assert.equal(await readFile(claims, 'utf8'), before)
  await rm(lock)
  const output = await capture(() => run(['proposals', 'approve', made.proposal_id, '--project', project, '--yes']))
  assert.match(output, /! visibility: professional → public-safe/)
})

test('invisible format characters cannot hide a claim marker from parsing or from the reserved-marker check', async () => {
  const { self, project, claims } = await fixture(),
    base = await readFile(claims, 'utf8'),
    spaces = { ZWSP: '​', ZWNJ: '‌', ZWJ: '‍', BOM: '﻿', NBSP: ' ' }
  for (const [name, x] of Object.entries(spaces)) {
    const secret = `SECRET${name}`
    await writeFile(claims, `${base}\n<!--${x} holoself-claim${x}visibility=private${x}-->\n${secret} private claim body text.\n<!--${x}/${x}holoself-claim${x}-->\n`)
    const blocks = parseClaimBlocks(await readFile(claims, 'utf8'))
    assert.ok(blocks.some(block => block.text.includes(secret) && block.visibility === 'private' && !block.malformed), `${name} opener parses`)
    assert.doesNotMatch(await contextText(project, ['--temporal', 'all']), new RegExp(secret), name)
    assert.deepEqual(ecosystemValidationErrors(self), [], name)
    for (const claim of [`Leak <!--${x} holoself-claim visibility=public-safe --> now.`, `End <!--${x}/holoself-claim--> here.`])
      assert.throws(() => createProposal(project, { source_files: ['Context/evidence.md'], claim }), /reserved claim markers/, `${name} in proposal text`)
  }
})

test('a stray closing marker fails closed back to the previous block boundary', async () => {
  const { self, project, claims } = await fixture()
  await writeFile(claims, `${await readFile(claims, 'utf8')}\nSECRET-STRAY text whose opener was lost.\n<!-- /holoself-claim -->\n\n## Notes\n\nAfter-closer ordinary notes stay visible.\n`)
  const delivered = await contextText(project, ['--temporal', 'all'])
  assert.doesNotMatch(delivered, /SECRET-STRAY/)
  assert.match(delivered, /After-closer ordinary notes stay visible/)
  assert.match(delivered, new RegExp(VISIBLE), 'blocks before the stray closer are kept')
  assert.ok(ecosystemValidationErrors(self).some(x => /unbalanced claim markers/.test(x)))
})
