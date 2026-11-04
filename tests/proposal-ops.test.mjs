// Proposal operations that replace, supersede and retire existing claims through the review flow (issue #70).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from '../src/cli.mjs'
import { ecosystemValidationErrors } from '../src/ecosystem.mjs'
import { legacyClaimId, parseClaimBlocks, proposalClaimId } from '../src/markdown/claim-blocks.mjs'
import { createMcpSession, MCP_TOOLS } from '../src/mcp-server.mjs'
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
  assert.match(preview.changes[0].preview, new RegExp(`^\\+<!-- holoself-claim visibility=professional id=${ids.visible} -->`, 'm'))
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
  assert.equal(preview.changes[0].before_sha256, preview.changes[1].before_sha256)
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
  assert.match(delivered, new RegExp(`<!-- holoself-claim visibility=professional id=${ids.visible} -->`))
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
