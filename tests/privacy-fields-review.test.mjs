// Findings of the independent review of the 0.12.0 stage of #108. The expected outcomes here are literal tables written
// by hand from the decision record, not derived from src: a test that runs the runtime on both sides cannot find a gap
// the runtime has on both sides. Synthetic data only.
import './helpers/isolated-config.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateAnnotationMetadata } from '../src/annotations.mjs'
import { buildIndex, searchIndex } from '../src/catalog/index.mjs'
import { run } from '../src/cli.mjs'
import { contextData } from '../src/ecosystem.mjs'
import { loadLensRegistry } from '../src/lenses.mjs'
import { applyFrontmatterModifications, applyPolicyMigration, deprecatedFieldMappings, planPolicyMigration, revertPolicyMigration } from '../src/migration.mjs'
import { legacyClaimId } from '../src/markdown/claim-blocks.mjs'
import { frontmatter, privacyValueValid } from '../src/policy/privacy-fields.mjs'
import { proposalPreviewData } from '../src/proposals/store.mjs'
import { holoselfMcpContext, holoselfMcpSearch } from '../src/retrieval/mcp.mjs'

const PUBLICATION = ['public', 'obsidian-public', 'restricted-host']
const SENTENCE = 'sentence long enough to be a claim.'
const claim = (attrs, text) => `<!-- holoself-claim ${attrs} -->\n${text}\n<!-- /holoself-claim -->\n`
const front = extra =>
  `---\naccess_lenses: [general, technical, private]\ndisclosure: publish-approved\nsensitivity: personal\ndocument_role: content\nread_scope: shared\n${extra}---\n`

async function quiet(fn) {
  const log = console.log,
    error = console.error
  let out = ''
  console.log = (...x) => {
    out += x.join(' ') + '\n'
  }
  console.error = () => {}
  try {
    await fn()
  } finally {
    console.log = log
    console.error = error
  }
  return out
}
async function tempDir(t, prefix = 'holoself-review-') {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}
async function linked(t, docs = {}) {
  const root = await tempDir(t),
    project = await tempDir(t, 'holoself-review-project-')
  await quiet(() => run(['init', '--root', root]))
  await quiet(() => run(['link', 'add', '--self', root, '--project', project, '--lens', 'general', '--secondary-lenses', 'technical', '--yes', '--no-activate']))
  for (const [rel, text] of Object.entries(docs)) await writeFile(join(root, rel), text)
  return { root, project }
}
function packet({ root, project }, caller, options) {
  const base = { task: 'sentence', budget: 'unbounded', json: true, ...options }
  if (caller === 'linked') return contextData({ ...base, project })
  const cwd = process.cwd()
  process.chdir(root)
  try {
    return contextData({ ...base, root, rootExplicit: true })
  } finally {
    process.chdir(cwd)
  }
}
// One document as a caller receives it, path by path.
function paths(fixture, caller, lens, adapter, rel) {
  const options = { lens, adapter },
    doc = packet(fixture, caller, options).self.documents.find(item => item.path === rel),
    entry = packet(fixture, caller, { ...options, manifest: true }).sources.find(item => item.path === rel)
  assert.ok(doc && entry, `${rel} is delivered to ${caller} ${lens} ${adapter}`)
  return { content: doc.content, sections: JSON.stringify(entry.sections), claims: JSON.stringify(entry.claims), tags: JSON.stringify(entry.tags), links: JSON.stringify(entry.links), entry, doc }
}
const present = (text, sentinels) => sentinels.filter(sentinel => text.includes(sentinel))

// `field` is the rule on `## Salary`; `marker` is a claim that would be readable on its own.
const RULED_BODY = marker =>
  `# Doc\n\nOPENTEXT ${SENTENCE}\n\n## Salary\n\nHEADTEXT ${SENTENCE}\n\n` +
  claim(marker, `CLAIMTEXT ${SENTENCE} #claimtag [c](https://claimlink.example)`) +
  `\n### Detail\n\nDETAILTEXT ${SENTENCE}\n\n## After\n\nAFTERTEXT ${SENTENCE}\n`
const RULED_DOCS = {
  'context/modern.md': front('field_access:\n  Salary:\n    access_lenses: [private]\n') + RULED_BODY('disclosure=publish-approved'),
  'context/legacy.md': front('field_visibility:\n  Salary: private\n') + RULED_BODY('visibility=public-safe')
}
const ALL = ['OPENTEXT', 'HEADTEXT', 'CLAIMTEXT', 'DETAILTEXT', 'AFTERTEXT']
const OPEN_ONLY = ['OPENTEXT', 'AFTERTEXT']
// caller, lens, adapter, what that caller reads. `## Salary` covers its claim and its subsections.
const RULED_TABLE = [
  ['linked', 'general', 'generic', OPEN_ONLY],
  ['linked', 'technical', 'generic', OPEN_ONLY],
  ['linked', 'general', 'public', OPEN_ONLY],
  ['linked', 'general', 'obsidian-public', OPEN_ONLY],
  ['linked', 'general', 'restricted-host', OPEN_ONLY],
  ['owner', 'general', 'generic', OPEN_ONLY],
  ['owner', 'general', 'public', OPEN_ONLY],
  ['owner', 'private', 'generic', ALL],
  ['owner', 'private', 'public', OPEN_ONLY],
  ['owner', 'private', 'restricted-host', OPEN_ONLY]
]
for (const rel of Object.keys(RULED_DOCS))
  test(`B1: a heading rule covers its claims and subsections on all five paths (${rel})`, async t => {
    const fixture = await linked(t, RULED_DOCS)
    for (const [caller, lens, adapter, expected] of RULED_TABLE) {
      const label = `${caller} ${lens} ${adapter}`,
        got = paths(fixture, caller, lens, adapter, rel)
      assert.deepEqual(present(got.content, ALL), expected, `${label} content`)
      assert.deepEqual(present(got.sections, ALL), expected, `${label} sections`)
      assert.deepEqual(present(got.claims, ALL), expected, `${label} claims`)
      const secret = expected.includes('CLAIMTEXT')
      assert.equal(got.tags.includes('claimtag'), secret, `${label} tags`)
      assert.equal(got.links.includes('claimlink.example'), secret, `${label} links`)
    }
  })

test('B1: search and the MCP read tools apply the enclosing heading rule too', async t => {
  const fixture = await linked(t, RULED_DOCS)
  const passages = results => JSON.stringify(results.filter(item => item.source_file in RULED_DOCS || Object.keys(RULED_DOCS).includes(item.source_file)))
  for (const adapter of ['generic', ...PUBLICATION]) {
    const found = passages(searchIndex(buildIndex(fixture.project), 'sentence', 'general', null, null, 'current', { adapter }))
    assert.deepEqual(present(found, ALL), OPEN_ONLY, `search ${adapter}`)
  }
  assert.deepEqual(present(passages(holoselfMcpSearch(fixture.project, { query: 'sentence', limit: 50 }).results), ALL), OPEN_ONLY, 'MCP search')
  for (const manifest of [false, true]) {
    const data = holoselfMcpContext(fixture.project, { task: 'sentence', budget: 'deep', manifest }),
      text = JSON.stringify([data.self.documents.filter(doc => doc.path in RULED_DOCS), data.sources.filter(source => source.path in RULED_DOCS)])
    assert.deepEqual(present(text, ['HEADTEXT', 'CLAIMTEXT', 'DETAILTEXT']), [], `MCP context manifest=${manifest}`)
  }
})

test('B1: the claim heading approved proposals write does not lift a claim out of a ruled section', async t => {
  const rel = 'context/approved.md',
    doc = front('field_access:\n  Salary:\n    access_lenses: [private]\n') + `## Salary\n\n` + claim('disclosure=publish-approved', `## Approved proposal x/claim\n\nBODYTEXT ${SENTENCE}\n\n- Evidence: synthetic`) + `\n## After\n\nAFTERTEXT ${SENTENCE}\n`,
    fixture = await linked(t, { [rel]: doc })
  for (const adapter of ['generic', 'public']) {
    const got = paths(fixture, 'linked', 'general', adapter, rel)
    for (const path of ['content', 'sections', 'claims']) {
      assert.ok(!got[path].includes('BODYTEXT'), `${adapter} ${path} hides the claim`)
      assert.ok(got[path].includes('AFTERTEXT'), `${adapter} ${path} keeps the next section`)
    }
  }
})

test('a heading inside a claim stops at the claim: ordinary text after it is on every path, and markers stay balanced', async t => {
  const rel = 'context/closer.md',
    doc =
      front('field_access:\n  Salary:\n    access_lenses: [private]\n') +
      `## Intro\n\nINTROTEXT ${SENTENCE}\n\n` +
      claim('disclosure=publish-approved', `INNERPRE ${SENTENCE}\n\n## Salary\n\nINNERSECRET ${SENTENCE}`) +
      `\nTAILTEXT ${SENTENCE}\n`,
    fixture = await linked(t, { [rel]: doc })
  const sentinels = ['INTROTEXT', 'INNERPRE', 'INNERSECRET', 'TAILTEXT']
  for (const adapter of ['generic', 'public']) {
    const got = paths(fixture, 'linked', 'general', adapter, rel)
    assert.deepEqual(present(got.content, sentinels), ['INTROTEXT', 'INNERPRE', 'TAILTEXT'], `${adapter} content`)
    assert.deepEqual(present(got.sections, sentinels), ['INTROTEXT', 'INNERPRE', 'TAILTEXT'], `${adapter} sections`)
    assert.equal((got.content.match(/<!-- holoself-claim/g) || []).length, (got.content.match(/<!-- \/holoself-claim/g) || []).length, `${adapter} balanced markers`)
    for (const section of got.entry.sections)
      for (const line of section.snippet.split('\n').filter(x => x.trim())) assert.ok(got.content.includes(line.trim()), `${adapter}: sections is a subset of content: ${line}`)
  }
})

test('a ruled heading covers every deeper heading and stops at the next heading of its level or above', async t => {
  const rel = 'context/deep.md',
    doc = front('field_visibility:\n  Salary: private\n') + `## Salary\n\n### Detail\n\nDETAILTEXT ${SENTENCE}\n\n#### Deeper\n\nDEEPERTEXT ${SENTENCE}\n\n### Sibling\n\nSIBLINGTEXT ${SENTENCE}\n\n## Next\n\nNEXTTEXT ${SENTENCE}\n\n### Open\n\nOPENTEXT ${SENTENCE}\n`,
    fixture = await linked(t, { [rel]: doc }),
    sentinels = ['DETAILTEXT', 'DEEPERTEXT', 'SIBLINGTEXT', 'NEXTTEXT', 'OPENTEXT'],
    got = paths(fixture, 'linked', 'general', 'generic', rel)
  for (const path of ['content', 'sections', 'claims']) assert.deepEqual(present(got[path], sentinels), ['NEXTTEXT', 'OPENTEXT'], path)
})

// `field_visibility` stops at the first rule that matches; `field_access` applies every match. Literal expectations.
const FIRST_MATCH_BODY = `## Pay band\n\nBANDTEXT ${SENTENCE}\n\n## Lines\n\n- Pay: PAYLINE ${SENTENCE}\n- Pay band: BANDLINE ${SENTENCE}\n`
test('first-match semantics of field_visibility against every-match semantics of field_access', async t => {
  const docs = {
      'context/first.md': front('field_visibility:\n  Pay: public-safe\n  Pay band: private\n') + FIRST_MATCH_BODY,
      'context/every.md': front('field_access:\n  Pay:\n    disclosure: publish-approved\n  Pay band:\n    access_lenses: [private]\n') + FIRST_MATCH_BODY
    },
    fixture = await linked(t, docs),
    sentinels = ['BANDTEXT', 'PAYLINE', 'BANDLINE']
  const table = [
    ['context/first.md', 'generic', ['BANDTEXT', 'PAYLINE']],
    ['context/first.md', 'public', ['BANDTEXT', 'PAYLINE']],
    ['context/every.md', 'generic', ['PAYLINE']],
    ['context/every.md', 'public', ['PAYLINE']]
  ]
  for (const [rel, adapter, expected] of table) {
    const got = paths(fixture, 'linked', 'general', adapter, rel)
    assert.deepEqual(present(got.content, sentinels), expected, `${rel} ${adapter} content`)
    assert.deepEqual(present(got.sections, sentinels), expected, `${rel} ${adapter} sections`)
    assert.deepEqual(present(got.claims, sentinels), expected, `${rel} ${adapter} claims`)
  }
})

const bad = (extra = '') => `---\ntitle: "bad\n${extra}field_visibility:\n  Salary: private\n---\n`
test('B2: a document whose frontmatter does not parse is skipped with a warning, and its field rule stays', async t => {
  const { root, project } = await linked(t),
    rule = 'field_visibility:\n  Salary: private\n',
    self = bad() + '# Self\n\nNo line matches the rule.\n',
    selfMatching = bad() + '- Salary: value that matches the rule\n',
    local = bad() + '- Salary: value that matches the rule\n',
    good = front('field_visibility:\n  Bonus: private\n') + '# Good\n'
  await writeFile(join(root, 'context', 'bad.md'), self)
  await writeFile(join(root, 'context', 'bad-matching.md'), selfMatching)
  await writeFile(join(root, 'context', 'good.md'), good)
  await writeFile(join(project, 'local.md'), local)
  for (const options of [{ includeLinked: true }, { includeLinked: true, confirmActivation: true }]) {
    const plan = planPolicyMigration(root, { ...options, dryRun: true })
    for (const rel of ['context/bad.md', 'context/bad-matching.md', 'local.md']) {
      const item = [...plan.entries, ...plan.activations].find(entry => entry.path === rel)
      assert.ok(!item || (!item.needs_migration && !item.after_text), `${rel} is left out of the plan`)
      assert.ok(plan.warnings.some(warning => warning.includes(rel) && warning.includes('field_visibility')), `${rel} is reported`)
    }
    assert.ok(plan.entries.find(entry => entry.path === 'context/good.md')?.needs_migration, 'the rest of the plan goes on')
    assert.deepEqual(plan.summary.coverage_loss, {})
  }
  const plan = planPolicyMigration(root, { includeLinked: true })
  applyPolicyMigration(root, plan.plan_id)
  assert.equal(await readFile(join(root, 'context', 'bad.md'), 'utf8'), self)
  assert.equal(await readFile(join(project, 'local.md'), 'utf8'), local)
  assert.ok(self.includes(rule))
})

test('B2: one unusable document does not empty the validate --fix report', async t => {
  const { root } = await linked(t)
  await writeFile(join(root, 'context', 'bad-matching.md'), bad() + '- Salary: value that matches the rule\n')
  await writeFile(join(root, 'context', 'good.md'), front('field_visibility:\n  Bonus: private\n') + '# Good\n')
  const report = deprecatedFieldMappings(root)
  assert.equal(report.error, undefined)
  assert.deepEqual(report.files.map(file => file.path), ['context/good.md'])
  assert.ok(report.warnings.some(warning => warning.includes('context/bad-matching.md')))
  assert.match(await quiet(() => run(['validate', '--fix', '--root', root])), /context\/bad-matching\.md/)
})

test('B2: a field_visibility that parses but is not a mapping stays, with a warning', async t => {
  const { root } = await linked(t)
  for (const [name, value] of [['scalar', 'private'], ['list', '[Salary]'], ['empty', '']]) {
    const text = front(`field_visibility: ${value}\n`) + '# Doc\n'
    await writeFile(join(root, 'context', `${name}.md`), text)
    const plan = planPolicyMigration(root, { dryRun: true, confirmActivation: true }),
      item = [...plan.entries, ...plan.activations].find(entry => entry.path === `context/${name}.md`)
    assert.ok(!item?.after_text || item.after_text.includes(`field_visibility: ${value}`.trimEnd()), name)
    assert.ok(plan.warnings.some(warning => warning.includes(`context/${name}.md`) && warning.includes('field_visibility')), name)
  }
})

const NON_UTF8 = Buffer.concat([Buffer.from(`---\nvisibility: private\n---\n# Caf`), Buffer.from([0xe9]), Buffer.from('\n\nBody text here.\n')])
test('B3: a file that is not valid UTF-8 is skipped with a warning and keeps its bytes', async t => {
  const { root } = await linked(t),
    path = join(root, 'context', 'latin1.md')
  await writeFile(path, NON_UTF8)
  await writeFile(join(root, 'context', 'good.md'), '---\nvisibility: private\n---\n# Good\n')
  const plan = planPolicyMigration(root)
  assert.ok(!plan.entries.some(entry => entry.path === 'context/latin1.md'))
  assert.ok(plan.warnings.some(warning => warning.includes('context/latin1.md') && warning.includes('UTF-8')))
  const receipt = applyPolicyMigration(root, plan.plan_id)
  assert.ok(NON_UTF8.equals(await readFile(path)))
  revertPolicyMigration(root, receipt.receipt_id)
  assert.ok(NON_UTF8.equals(await readFile(path)))
})

test('B3: apply compares bytes, so a file that decodes to the planned text but differs in bytes is refused', async t => {
  const { root } = await linked(t),
    path = join(root, 'context', 'replacement.md'),
    planned = `---\nvisibility: private\n---\n# Caf�\n`,
    swapped = Buffer.concat([Buffer.from('---\nvisibility: private\n---\n# Caf'), Buffer.from([0xe9, 0x0a])])
  await writeFile(path, planned)
  const plan = planPolicyMigration(root)
  await writeFile(path, swapped)
  assert.throws(() => applyPolicyMigration(root, plan.plan_id), /TOCTOU/)
  assert.ok(swapped.equals(await readFile(path)))
})

test('B3: receipts keep prior bytes as base64, and receipts written by earlier versions still revert', async t => {
  const { root } = await linked(t),
    path = join(root, 'context', 'doc.md'),
    text = `---\r\nvisibility: private\r\n---\r\n# Café \u{1f600}\r\nNo trailing newline`
  await writeFile(path, text)
  const receipt = applyPolicyMigration(root, planPolicyMigration(root).plan_id),
    entry = receipt.entries.find(item => item.path === 'context/doc.md')
  assert.equal(Buffer.from(entry.before_base64, 'base64').toString('utf8'), text)
  const stored = JSON.parse(await readFile(join(root, '.holoself', 'migrations', `receipt-${receipt.receipt_id}.json`), 'utf8')),
    older = { ...stored, entries: stored.entries.map(({ before_base64, ...item }) => ({ ...item, before_text: Buffer.from(before_base64, 'base64').toString('utf8') })) }
  await writeFile(join(root, '.holoself', 'migrations', `receipt-${receipt.receipt_id}.json`), JSON.stringify(older))
  assert.equal(revertPolicyMigration(root, receipt.receipt_id).status, 'reverted')
  assert.equal(await readFile(path, 'utf8'), text)
})

const receiptFiles = root => readdirSync(join(root, '.holoself', 'migrations')).filter(name => name.startsWith('receipt-'))
test('M1: every entry is verified before the first write, so an edit after planning leaves all files as they were', async t => {
  const { root } = await linked(t),
    a = join(root, 'context', 'a.md'),
    z = join(root, 'context', 'z.md'),
    text = '---\nvisibility: private\n---\n# Doc\n'
  await writeFile(a, text)
  await writeFile(z, text)
  const plan = planPolicyMigration(root)
  await writeFile(z, text + 'Edited after planning.\n')
  assert.throws(() => applyPolicyMigration(root, plan.plan_id), /TOCTOU/)
  assert.equal(await readFile(a, 'utf8'), text, 'the earlier file is untouched')
  assert.deepEqual(receiptFiles(root), [])
  await writeFile(z, text)
  assert.equal(applyPolicyMigration(root, plan.plan_id).status, 'applied', 'the same plan applies once the file is back')
})

test('M1: a write failure rolls back every file already written and leaves no receipt', { skip: process.platform === 'win32' }, async t => {
  const { root } = await linked(t),
    a = join(root, 'context', 'a.md'),
    locked = join(root, 'context', 'zz'),
    z = join(locked, 'z.md'),
    text = '---\nvisibility: private\n---\n# Doc\n'
  await mkdir(locked)
  await writeFile(a, text)
  await writeFile(z, text)
  const plan = planPolicyMigration(root)
  chmodSync(locked, 0o555)
  try {
    assert.throws(() => applyPolicyMigration(root, plan.plan_id), /rolled back/)
  } finally {
    chmodSync(locked, 0o755)
  }
  assert.equal(await readFile(a, 'utf8'), text)
  assert.equal(await readFile(z, 'utf8'), text)
  assert.deepEqual(receiptFiles(root), [])
})

async function withCustomLens(fixture) {
  await writeFile(
    join(fixture.root, 'lenses', 'acme-talks.json'),
    JSON.stringify({ schema_version: 1, id: 'acme-talks', title: 'Synthetic custom lens', sensitivity_access: [], instructions: { purpose: 'Synthetic perspective' } })
  )
  return fixture
}
const REDACTED_DOC =
  front('field_access:\n  Bonus:\n    access_lenses: [general, acme-talks]\n    disclosure: publish-approved\n  Pay Notes:\n    access_lenses: [acme-talks]\n') +
  claim('access_lenses=general,acme-talks disclosure=publish-approved', `Marker ${SENTENCE}`) +
  claim('access_lenses=acme-talks disclosure=review-required', `Hidden marker ${SENTENCE}`) +
  `\n## Bonus\n\nBONUSTEXT ${SENTENCE}\n\n## Pay Notes\n\nHIDDENTEXT ${SENTENCE}\n`

test('rule details are not delivered on publication adapters or to any non-owner caller, and the owner keeps them', async t => {
  const rel = 'context/rules.md',
    fixture = await withCustomLens(await linked(t, { 'context/rules.md': REDACTED_DOC }))
  const rows = [
    ['linked', 'generic', false],
    ['linked', 'public', false],
    ['linked', 'obsidian-public', false],
    ['linked', 'restricted-host', false],
    ['owner', 'public', false],
    ['owner', 'obsidian-public', false],
    ['owner', 'restricted-host', false],
    ['owner', 'generic', true]
  ]
  for (const [caller, adapter, kept] of rows) {
    for (const manifest of [false, true]) {
      const data = JSON.stringify(packet(fixture, caller, { lens: 'general', adapter, manifest }))
      assert.equal(data.includes('acme-talks'), kept, `${caller} ${adapter} manifest=${manifest}: custom lens name`)
    }
    const data = packet(fixture, caller, { lens: 'general', adapter }),
      doc = data.self.documents.find(item => item.path === rel)
    assert.equal(Object.hasOwn(doc.metadata, 'field_access'), kept, `${caller} ${adapter}: field_access metadata`)
    assert.match(doc.content, /<!-- holoself-claim disclosure=publish-approved|<!-- holoself-claim access_lenses=general,acme-talks/, `${caller} ${adapter}: marker stays well formed`)
    assert.ok(doc.content.includes('Marker sentence') && doc.content.includes('BONUSTEXT'), `${caller} ${adapter}: the text itself is delivered`)
  }
  const mcp = JSON.stringify(holoselfMcpContext(fixture.project, { task: 'sentence', budget: 'deep', manifest: true }))
  assert.ok(!mcp.includes('acme-talks'), 'MCP context')
})

test('redacted markers keep claim ids, so a linked proposal can still target the claim', async t => {
  const wording = `Target ${SENTENCE}`,
    id = legacyClaimId('context/claims.md', wording),
    fixture = await withCustomLens(await linked(t, { 'context/claims.md': front('') + claim('access_lenses=general,acme-talks disclosure=review-required', wording) }))
  const doc = packet(fixture, 'linked', { lens: 'general', adapter: 'generic' }).self.documents.find(item => item.path === 'context/claims.md')
  assert.ok(doc.content.includes(`<!-- holoself-claim disclosure=review-required id=${id} -->`))
})

test('a claim whose rule admits no lens is refused by replace, supersede and retire, never turned into [private]', async t => {
  const wording = `Target wording for the conflict ${SENTENCE}`,
    id = legacyClaimId('context/claims.md', wording),
    text = front('') + claim('visibility=professional access_lenses=general,technical', wording),
    fixture = await linked(t, { 'context/claims.md': text })
  await mkdir(join(fixture.project, 'Context'), { recursive: true })
  await writeFile(join(fixture.project, 'Context', 'evidence.md'), '# Evidence\n\nSynthetic evidence.\n')
  const attempt = async args => {
    const made = JSON.parse(await quiet(() => run(['propose', '--project', fixture.project, '--source-file', 'Context/evidence.md', '--evidence', 'Synthetic notes.', ...args])))
    proposalPreviewData(fixture.project, made.proposal_id)
  }
  for (const args of [
    ['--op', 'replace', '--claim-id', id, '--claim', 'Replacement wording for the conflict.'],
    ['--op', 'supersede', '--claim-id', id, '--claim', 'Superseding wording for the conflict.'],
    ['--op', 'retire', '--claim-id', id, '--reason', 'No longer accurate.']
  ])
    await assert.rejects(attempt(args), /admits no lens/, args[1])
  assert.equal(await readFile(join(fixture.root, 'context', 'claims.md'), 'utf8'), text)
})

test('a field_access name with surrounding spaces is rejected everywhere it is validated', async () => {
  for (const name of ['Salary ', ' Salary', 'Salary\t']) {
    assert.equal(privacyValueValid('field_access', { [name]: { disclosure: 'review-required' } }), false, JSON.stringify(name))
    assert.equal(validateAnnotationMetadata({ access_lenses: ['general'], disclosure: 'internal-only', sensitivity: 'personal', document_role: 'content', field_access: { [name]: {} } }, ['general']).valid, false, JSON.stringify(name))
  }
  const schema = JSON.parse(await readFile(new URL('../schemas/document-metadata.schema.json', import.meta.url), 'utf8'))
  assert.ok(schema.properties.field_access.propertyNames?.pattern)
  assert.throws(() => frontmatter(front('field_access: {"Salary ": {"disclosure": "review-required"}}\n') + '# Doc\n'), /field_access/)
})

test('a valid empty rule is written through its normal form and parses back', async t => {
  const written = applyFrontmatterModifications(front(''), { field_access: { Pay: {} } })
  assert.equal(JSON.stringify(frontmatter(written).metadata.field_access), '{"Pay":{"disclosure":"review-required"}}')
  const { root } = await linked(t)
  await writeFile(join(root, 'context', 'empty.md'), front('field_visibility:\n  Salary: private\nfield_access:\n  Pay: {}\n') + '# Doc\n')
  const plan = planPolicyMigration(root, { dryRun: true }),
    entry = plan.entries.find(item => item.path === 'context/empty.md')
  assert.equal(JSON.stringify(frontmatter(entry.after_text).metadata.field_access), '{"Pay":{"disclosure":"review-required"},"Salary":{"access_lenses":["private"],"disclosure":"review-required"}}')
})

test('the report states what validate --fix does to deprecated fields', async t => {
  const { root } = await linked(t, { 'context/doc.md': front('field_visibility:\n  Salary: private\n') + '# Doc\n' }),
    out = await quiet(() => run(['validate', '--fix', '--root', root]))
  assert.match(out, /does not migrate these/)
  assert.doesNotMatch(out, /never edits/)
})

test('catalogs built before these fixes are rebuilt', async () => {
  const { CATALOG_SCHEMA_VERSION } = await import('../src/catalog/schema.mjs')
  assert.equal(CATALOG_SCHEMA_VERSION, 5)
  assert.equal(existsSync(new URL('../schemas/catalog.schema.json', import.meta.url)), true)
  assert.equal(JSON.parse(await readFile(new URL('../schemas/catalog.schema.json', import.meta.url), 'utf8')).properties.schema_version.const, 5)
})

test('a lens file on disk reaches the registry the rules are checked against', async t => {
  const fixture = await withCustomLens(await linked(t))
  assert.ok(loadLensRegistry(fixture.root).byId.has('acme-talks'))
})
