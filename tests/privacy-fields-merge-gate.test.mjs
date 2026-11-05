// Merge-gate findings on the 0.12.0 stage of #108. Expected outcomes are literal, written by hand. Synthetic data only.
import './helpers/isolated-config.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildIndex, searchIndex } from '../src/catalog/index.mjs'
import { run } from '../src/cli.mjs'
import { contextData } from '../src/ecosystem.mjs'
import { parseClaimBlocks } from '../src/markdown/claim-blocks.mjs'
import { sections } from '../src/markdown/text.mjs'
import { applyPolicyMigration, planPolicyMigration } from '../src/migration.mjs'
import { filterFieldVisibility } from '../src/policy/access.mjs'
import { fieldHeadingRule, fieldLineRule, fieldRuleTable } from '../src/policy/sub-document-rules.mjs'
import { planProposalChanges, proposalPreviewData } from '../src/proposals/store.mjs'
import { clientMcpCreateProposal, clientMcpPreviewProposal } from '../src/retrieval/client-mcp.mjs'
import { holoselfMcpContext, holoselfMcpCreateProposal, holoselfMcpPreviewProposal, holoselfMcpSearch } from '../src/retrieval/mcp.mjs'

const S = 'sentence long enough to be a claim.'
const ID = '22222222-2222-4222-8222-222222222222'
const claim = (attrs, text) => `<!-- holoself-claim ${attrs} -->\n${text}\n<!-- /holoself-claim -->\n`
const META = 'access_lenses: [general, technical, private]\ndisclosure: publish-approved\nsensitivity: personal\ndocument_role: content\nread_scope: shared\n'
const RULES = {
  modern: 'field_access:\n  Salary:\n    access_lenses: [private]\n',
  legacy: 'field_visibility:\n  Salary: private\n'
}
const doc = (body, rules = RULES.modern, meta = META) => `---\n${meta}${rules}---\n${body}`
const REL = 'context/gate.md'

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
async function tempDir(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}
async function linked(t, docs = {}, { customLens = false } = {}) {
  const root = await tempDir(t, 'holoself-gate-'),
    project = await tempDir(t, 'holoself-gate-project-')
  await quiet(() => run(['init', '--root', root]))
  if (customLens)
    await writeFile(
      join(root, 'lenses', 'acme-talks.json'),
      JSON.stringify({ schema_version: 1, id: 'acme-talks', title: 'Synthetic custom lens', sensitivity_access: [], instructions: { purpose: 'Synthetic perspective' } })
    )
  await quiet(() => run(['link', 'add', '--self', root, '--project', project, '--lens', 'general', '--yes', '--no-activate']))
  await mkdir(join(project, 'Context'), { recursive: true })
  await writeFile(join(project, 'Context', 'evidence.md'), '# Evidence\n\nSynthetic evidence.\n')
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
function paths(fixture, caller, lens, adapter, rel = REL, task = 'sentence') {
  const docItem = packet(fixture, caller, { lens, adapter, task }).self.documents.find(item => item.path === rel),
    entry = packet(fixture, caller, { lens, adapter, task, manifest: true }).sources.find(item => item.path === rel)
  assert.ok(docItem && entry, `${rel} is delivered to ${caller} ${lens} ${adapter}`)
  return { content: docItem.content, sections: JSON.stringify(entry.sections), claims: JSON.stringify(entry.claims), tags: JSON.stringify(entry.tags), links: JSON.stringify(entry.links) }
}
const present = (text, sentinels) => sentinels.filter(sentinel => text.includes(sentinel))
function assertEveryPath(fixture, sentinels, expected, rel = REL) {
  for (const adapter of ['generic', 'public']) {
    const got = paths(fixture, 'linked', 'general', adapter, rel)
    for (const path of ['content', 'sections', 'claims']) assert.deepEqual(present(got[path], sentinels), expected, `${adapter} ${path}`)
    const found = JSON.stringify(searchIndex(buildIndex(fixture.project), 'sentence', 'general', null, null, 'current', { adapter }).filter(item => item.source_file === rel))
    assert.deepEqual(present(found, sentinels), expected, `search ${adapter}`)
  }
  const mcpFound = JSON.stringify(holoselfMcpSearch(fixture.project, { query: 'sentence', limit: 50 }).results.filter(item => item.source_file === rel))
  assert.deepEqual(present(mcpFound, sentinels), expected, 'MCP search')
  const data = holoselfMcpContext(fixture.project, { task: 'sentence', budget: 'deep', manifest: true })
  assert.deepEqual(present(JSON.stringify(data.sources.filter(item => item.path === rel)), sentinels.filter(x => !expected.includes(x))), [], 'MCP manifest')
}

// N1. Only column 0 ends a rule.
const SECRET = `SECRETTEXT ${S}`
const NOT_ENDS = {
  'an indented heading': `  # base\n  ${SECRET}\n`,
  'an indented comment in a list item': `- base\n  # bonus\n  ${SECRET}\n`,
  'a bullet fence': `- \`\`\`sh\n  # base\n  ${SECRET}\n  \`\`\`\n`,
  'a numbered fence': `1. \`\`\`sh\n   # base\n   ${SECRET}\n   \`\`\`\n`,
  'a bullet fence with a column 0 comment': `- \`\`\`sh\n# base\n${SECRET}\n  \`\`\`\n`,
  'a numbered fence with a wide marker': `10. \`\`\`sh\n# base\n${SECRET}\n    \`\`\`\n`,
  'a blockquote fence': `> \`\`\`\n# base\n${SECRET}\n> \`\`\`\n`,
  'three spaces of indent': `   ## Note\n\n${SECRET}\n`,
  'one space of indent': ` # Note\n\n${SECRET}\n`,
  'a no-break space after the hashes': `# Note\n\n${SECRET}\n`,
  'an ideographic space after the hashes': `#　Note\n\n${SECRET}\n`
}
for (const [label, shape] of Object.entries(NOT_ENDS))
  for (const [vocabulary, rules] of Object.entries(RULES))
    test(`N1: ${label} does not end a rule (${vocabulary})`, async t => {
      const body = `# Doc\n\nOPENTEXT ${S}\n\n## Salary\n\nHEADTEXT ${S}\n\n${shape}\n## After\n\nAFTERTEXT ${S}\n`,
        fixture = await linked(t, { [REL]: doc(body, rules) })
      assertEveryPath(fixture, ['OPENTEXT', 'HEADTEXT', 'SECRETTEXT', 'AFTERTEXT'], ['OPENTEXT', 'AFTERTEXT'])
    })

test('N1: indented headings do not split sections', () => {
  assert.deepEqual(sections('## One\n\ntext\n\n   ## Not\n\nmore\n\n## Two\n\nend\n').map(section => section.heading), ['One', 'Two'])
})

// N2. MCP proposal responses carry the delivered text only.
const SCAN = ['HIDDENLINE', 'HIDDENHEAD', 'acme-talks', 'access_lenses=', 'field_access', 'Bonus Plan']
const proposalDoc = doc(
  `# Doc\n\n<!-- holoself-claim access_lenses=general,acme-talks disclosure=publish-approved id=${ID} -->\nVisible wording of the claim, ${S}\n- Bonus Plan: HIDDENLINE ${S}\n\n## Bonus Plan\n\nHIDDENHEAD ${S}\n<!-- /holoself-claim -->\n`,
  'field_access:\n  Bonus Plan:\n    access_lenses: [private]\n'
)
for (const [operation, extra] of [
  ['replace_claim', { claim: 'Replaced wording long enough for the claim.' }],
  ['supersede_claim', { claim: 'Superseding wording long enough for the claim.' }],
  ['retire_claim', { reason: 'No longer accurate.' }]
])
  test(`N2: a linked MCP preview of ${operation} holds only what the caller was delivered`, async t => {
    const fixture = await linked(t, { [REL]: proposalDoc }, { customLens: true }),
      made = holoselfMcpCreateProposal(fixture.project, { operation, target: REL, claim_id: ID, evidence: 'Synthetic notes.', source_files: ['Context/evidence.md'], ...extra }),
      preview = holoselfMcpPreviewProposal(fixture.project, made.proposal_id),
      text = JSON.stringify([made, preview])
    assert.deepEqual(present(text, SCAN), [], operation)
    assert.ok(preview.changes[0].before_block.includes('Visible wording of the claim'), 'the visible wording is the before block')
    assert.ok(!text.includes(fixture.root), 'no absolute path')
  })

test('N2: the owner preview still shows the real file, and approval writes the real rule', async t => {
  const fixture = await linked(t, { [REL]: proposalDoc }, { customLens: true }),
    made = holoselfMcpCreateProposal(fixture.project, { operation: 'replace_claim', target: REL, claim_id: ID, claim: 'Replaced wording long enough for the claim.', evidence: 'Synthetic notes.', source_files: ['Context/evidence.md'] }),
    owner = proposalPreviewData(fixture.project, made.proposal_id)
  assert.ok(owner.changes[0].before_block.includes('HIDDENLINE'))
  assert.ok(owner.changes[0].after_block.includes('access_lenses=general,acme-talks'))
  await quiet(() => run(['proposals', 'approve', made.proposal_id, '--project', fixture.project, '--preview-hash', owner.preview_hash, '--yes']))
  const [block] = parseClaimBlocks(await readFile(join(fixture.root, REL), 'utf8'), REL)
  assert.deepEqual(block.rule, { access_lenses: ['general', 'acme-talks'], disclosure: 'publish-approved' })
})

test('N2: a view never falls back to raw text, and a change of visibility names no lens list', async t => {
  const fixture = await linked(t, { [REL]: proposalDoc }, { customLens: true }),
    delivered = holoselfMcpContext(fixture.project, { task: 'sentence', budget: 'deep' }).self.documents.find(item => item.path === REL).content,
    p = { proposal_id: '33333333-3333-4333-8333-333333333333', provenance: ['synthetic'], changes: [{ change_id: 'c1', operation: 'replace_claim', target: REL, claim_id: ID, claim: 'New wording long enough for the claim.', evidence: 'e', confidence: 'confirmed', visibility: 'private' }] },
    view = { visible: () => true, delivered: () => [delivered], baseText: () => delivered },
    { previews } = planProposalChanges(p, fixture.root, view)
  assert.deepEqual(present(JSON.stringify(previews), SCAN.filter(x => x !== 'access_lenses=')), [])
  assert.deepEqual(previews[0].visibility_change, { from: 'not shown', to: 'private' })
  assert.throws(() => planProposalChanges(p, fixture.root, { visible: () => true, delivered: () => [], baseText: () => null }), error => error.code === 'CLAIM_NOT_FOUND')
})

test('N2: an unlinked client preview holds only what the client was delivered', async t => {
  const fixture = await linked(t, { [REL]: proposalDoc }, { customLens: true })
  await quiet(() => run(['client', 'add', '--root', fixture.root, '--name', 'desk', '--lens', 'general', '--proposals', 'inbox']))
  const registry = JSON.parse(await readFile(join(fixture.root, '.holoself', 'clients.json'), 'utf8')),
    client = { self: fixture.root, client_id: registry.clients[0].client_id },
    made = clientMcpCreateProposal(client, { target: REL, claim: 'Appended wording long enough for the claim.', evidence: 'Synthetic notes.' }),
    preview = clientMcpPreviewProposal(client, made.proposal_id)
  // The one marker shown is the new claim's own, built from the visibility its author asked for.
  assert.deepEqual(present(JSON.stringify([made, preview]), SCAN.filter(x => x !== 'access_lenses=')), [])
})

test('N2: errors from a hidden claim say no more than a missing one', async t => {
  const hidden = '44444444-4444-4444-8444-444444444444',
    text = doc(`# Doc\n\nOpen ${S}\n\n${claim(`access_lenses=private id=${hidden}`, `HIDDENCLAIM ${S}`)}`, ''),
    fixture = await linked(t, { [REL]: text }),
    attempt = id => {
      try {
        holoselfMcpCreateProposal(fixture.project, { operation: 'retire_claim', target: REL, claim_id: id, reason: 'x', evidence: 'e', source_files: ['Context/evidence.md'] })
      } catch (error) {
        return [error.code, error.message.replace(id, '<id>')]
      }
      return null
    }
  assert.deepEqual(attempt(hidden), attempt('55555555-5555-4555-8555-555555555555'))
})

// N3. A snippet is cut from text that is already filtered.
const pad = n => 'Filler words that are ordinary and open to every lens here. '.repeat(Math.ceil(n / 60)).slice(0, n)
const CUT_SHAPES = {
  emphasis: '**Salary is 200000**',
  underscore: '__Salary is 200000__',
  label: 'Salary is 200000:',
  summary: '<summary>Salary is 200000</summary>',
  'quoted emphasis': '> **Salary is 200000**',
  setext: 'Salary is 200000\n---',
  'setext equals': 'Salary is 200000\n===',
  'html heading': '<h2>Salary is 200000</h2>'
}
for (const [label, shape] of Object.entries(CUT_SHAPES))
  test(`N3: sections is a subset of content when the snippet limit falls on ${label}`, async t => {
    const docs = {}
    for (const n of [280, 300, 330, 340, 345, 350, 355]) docs[`context/cut-${n}.md`] = doc(`# T\n\n${pad(n)}\n\n${shape}\n\n${pad(200)}\n`)
    const fixture = await linked(t, docs)
    for (const rel of Object.keys(docs)) {
      const got = paths(fixture, 'linked', 'general', 'generic', rel, 'filler')
      assert.ok(!got.content.includes('200000'), `${rel} content`)
      assert.ok(!got.sections.includes('200000'), `${rel} sections`)
      assert.ok(!got.claims.includes('200000'), `${rel} claims`)
      assert.ok(!got.sections.includes('full_text'), `${rel}: the full text never leaves the catalog`)
    }
    assert.ok(!JSON.stringify(searchIndex(buildIndex(fixture.project), 'filler', 'general', null, null, 'current', {})).includes('200000'), 'search')
  })

test('N3: a long ruled section still shows a cut snippet, and its allowed text is not lost', async t => {
  const fixture = await linked(t, { [REL]: doc(`# T\n\n${pad(600)}\n\n**Salary is 200000**\n`) }),
    entry = packet(fixture, 'linked', { lens: 'general', adapter: 'generic', task: 'filler', manifest: true }).sources.find(item => item.path === REL),
    { snippet } = entry.sections.find(section => section.heading === 'T')
  assert.equal(snippet.length, 360)
  assert.ok(snippet.endsWith('...'))
})

// N4. Rule details stay with the owner.
test('N4: approval writes no lens list into a claim body, and a known name stays', async t => {
  const fixture = await linked(t, { [REL]: proposalDoc }, { customLens: true }),
    propose = args => quiet(() => run(['propose', '--project', fixture.project, '--source-file', 'Context/evidence.md', '--evidence', 'Synthetic notes.', '--target-file', REL, ...args])),
    made = JSON.parse(await propose(['--op', 'replace', '--claim-id', ID, '--claim', 'Replaced wording long enough for the claim.'])),
    preview = proposalPreviewData(fixture.project, made.proposal_id)
  await quiet(() => run(['proposals', 'approve', made.proposal_id, '--project', fixture.project, '--preview-hash', preview.preview_hash, '--yes']))
  const text = await readFile(join(fixture.root, REL), 'utf8')
  assert.doesNotMatch(text, /^- Visibility:/m)
  assert.match(text, /holoself-claim access_lenses=general,acme-talks disclosure=publish-approved/)
  const named = JSON.parse(await propose(['--claim', 'Appended wording long enough for the claim.', '--visibility', 'professional'])),
    second = proposalPreviewData(fixture.project, named.proposal_id)
  await quiet(() => run(['proposals', 'approve', named.proposal_id, '--project', fixture.project, '--preview-hash', second.preview_hash, '--yes']))
  assert.match(await readFile(join(fixture.root, REL), 'utf8'), /^- Visibility: professional$/m)
})

const BODY_LINE = `- Visibility: access_lenses=general,acme-talks disclosure=publish-approved`
test('N4: a lens list already in a claim body reaches only the owner', async t => {
  const body = `# Doc\n\n${claim('disclosure=publish-approved', `Claim wording, ${S}\n${BODY_LINE}`)}`,
    fixture = await linked(t, { [REL]: doc(body, '') }, { customLens: true })
  for (const adapter of ['generic', 'public', 'obsidian-public', 'restricted-host'])
    assert.deepEqual(present(JSON.stringify(paths(fixture, 'linked', 'general', adapter)), ['acme-talks', 'access_lenses=']), [], `linked ${adapter}`)
  assert.deepEqual(present(JSON.stringify(paths(fixture, 'owner', 'general', 'public')), ['acme-talks', 'access_lenses=']), [], 'owner on a publication adapter')
  assert.deepEqual(present(JSON.stringify(searchIndex(buildIndex(fixture.project), 'wording', 'general', null, null, 'current', {})), ['acme-talks', 'access_lenses=']), [], 'search')
  assert.ok(packet(fixture, 'owner', { lens: 'general', adapter: 'generic' }).self.documents.find(item => item.path === REL).content.includes(BODY_LINE), 'the owner keeps it')
})

test('N4: restriction reasons name no field for non-owner or publication callers', async t => {
  const body = `# Doc\n\nOpen ${S}\n\n- Pay Grade: hidden value\n\n## Bonus Plan\n\nHidden ${S}\n`,
    rules = 'field_access:\n  Bonus Plan:\n    access_lenses: [private]\n  Pay Grade:\n    access_lenses: [private]\n',
    fixture = await linked(t, { [REL]: doc(body, rules) }),
    reasons = (caller, adapter) => [...new Set(packet(fixture, caller, { lens: 'general', adapter }).restrictions.filter(item => item.source === REL).map(item => item.reason))].sort()
  assert.deepEqual(reasons('linked', 'generic'), ['field excluded by general lens'])
  assert.deepEqual(reasons('linked', 'public'), ['field excluded by general lens'])
  assert.deepEqual(reasons('owner', 'public'), ['field excluded by general lens'])
  assert.deepEqual(reasons('owner', 'generic'), ['field Bonus Plan excluded by general lens', 'field Pay Grade excluded by general lens'])
})

test('N4: a custom lens in a document\'s own lists reaches only the owner', async t => {
  const meta = 'access_lenses: [general, technical, private, acme-talks]\nexclude_lenses: [acme-talks]\ndisclosure: publish-approved\nsensitivity: personal\ndocument_role: content\nread_scope: shared\n',
    fixture = await linked(t, { [REL]: doc(`# Doc\n\nOpen ${S}\n`, '', meta) }, { customLens: true }),
    own = (caller, adapter, extra = {}) => packet(fixture, caller, { lens: 'general', adapter, ...extra })
  for (const [caller, adapter] of [['linked', 'generic'], ['linked', 'public'], ['owner', 'public'], ['owner', 'restricted-host']]) {
    const data = own(caller, adapter)
    assert.ok(!JSON.stringify(data).includes('acme-talks'), `${caller} ${adapter} packet`)
    assert.deepEqual(data.self.documents.find(item => item.path === REL).metadata.access_lenses, ['general', 'technical', 'private'], `${caller} ${adapter}`)
    assert.ok(!JSON.stringify(own(caller, adapter, { manifest: true })).includes('acme-talks'), `${caller} ${adapter} manifest`)
  }
  assert.ok(JSON.stringify(own('owner', 'generic')).includes('acme-talks'), 'the owner keeps it')
  const text = await quiet(() => run(['context', '--project', fixture.project, '--lens', 'general', '--format', 'packet']))
  assert.ok(!text.includes('acme-talks'), 'text packet')
  assert.ok(!JSON.stringify(searchIndex(buildIndex(fixture.project), 'open', 'general', null, null, 'current', {})).includes('acme-talks'), 'linked search')
  assert.ok(!JSON.stringify(holoselfMcpSearch(fixture.project, { query: 'open', limit: 50 })).includes('acme-talks'), 'MCP search')
})

// N5. Names match through presentation.
const START_GAPS = {
  'full-width hashes': '＃＃ Salary',
  'a full-width letter': '## Ｓalary',
  'a zero-width space in the name': '## Sal​ary',
  'a soft hyphen in the name': '## Sal­ary',
  'a zero-width character before the hashes': '​## Salary',
  'a byte order mark before the hashes': '﻿## Salary',
  'emphasis inside the name': '## *Sal*ary',
  'inline code around the name': '## `Salary`',
  'a numeric entity': '## Sal&#97;ry',
  'a hex entity': '## &#x53;alary',
  'details and summary on one line': '<details><summary>Salary</summary>',
  'paragraph and strong on one line': '<p><strong>Salary</strong></p>',
  'a comment inside the name': '## Sal<!-- -->ary',
  'an inline tag inside the name': '## Sal<b>ary</b>',
  'an h2 with its name split across lines': '<h2>Sal\nary</h2>',
  'an h2 with its tag split across lines': '<h2\nclass="x">Salary</h2>',
  'a table header cell': '| **Salary** |\n|---|',
  'a table header cell in a later column': '| Name | Salary |\n| --- | --- |'
}
for (const [label, shape] of Object.entries(START_GAPS))
  for (const [vocabulary, rules] of Object.entries(RULES))
    test(`N5: ${label} opens the rule (${vocabulary})`, async t => {
      const body = `# Doc\n\nOPENTEXT ${S}\n\n${shape}\n\n${SECRET}\n\n## After\n\nAFTERTEXT ${S}\n`,
        fixture = await linked(t, { [REL]: doc(body, rules) })
      assertEveryPath(fixture, ['OPENTEXT', 'SECRETTEXT', 'AFTERTEXT'], ['OPENTEXT', 'AFTERTEXT'])
    })

test('N5: whitespace folds in a rule name, and the rule name is normalised too', () => {
  const table = fieldRuleTable({ field_access: { 'Base Pay': { access_lenses: ['private'] }, 'Ｂonus​ Plan': { access_lenses: ['private'] } } })
  for (const heading of ['Base Pay', 'Base Pay', 'base   pay', '*Base* Pay', 'Bonus Plan', 'BONUS PLAN', 'Bonus&nbsp;Plan']) assert.ok(fieldHeadingRule(heading, table), heading)
  assert.equal(fieldHeadingRule('Basepay', table), null)
  assert.equal(fieldHeadingRule('Unrelated', table), null)
})

const FIELD_LINES = {
  plain: 'Salary: 200000',
  bullet: '- Salary: 200000',
  'bold name and colon': '**Salary:** 200000',
  'bold name': '**Salary**: 200000',
  'italic name': '*Salary*: 200000',
  numbered: '1. Salary: 200000',
  quoted: '> Salary: 200000',
  task: '- [ ] Salary: 200000',
  'done task': '- [x] Salary: 200000',
  'table row': '| Salary | 200000 |',
  'table row with bold': '| **Salary** | 200000 |',
  'html cells': '<td>Salary</td><td>200000</td>',
  'html bold': '<b>Salary:</b> 200000',
  'full-width colon': 'Salary： 200000',
  equals: 'Salary = 200000',
  'spaced dash': 'Salary - 200000',
  'zero-width name': 'Sal​ary: 200000'
}
for (const [label, line] of Object.entries(FIELD_LINES))
  for (const [vocabulary, rules] of Object.entries(RULES))
    test(`N5: a field line as ${label} is hidden on every path (${vocabulary})`, async t => {
      const body = `# Doc\n\nOPENTEXT ${S}\n\nKEPTLINE ${S}\n${line}\nMORETEXT ${S}\n`,
        fixture = await linked(t, { [REL]: doc(body, rules) })
      assertEveryPath(fixture, ['OPENTEXT', 'KEPTLINE', '200000', 'MORETEXT'], ['OPENTEXT', 'KEPTLINE', 'MORETEXT'])
    })

test('N5: field lines do not match a different name', () => {
  const table = fieldRuleTable({ field_visibility: { Salary: 'private' } })
  for (const line of ['Salary band: 3', '| Salary band | 3 |', 'No salary here', 'Salary', '1. Base: 3']) assert.equal(fieldLineRule(line, table), null, line)
})

test('a document the gate refuses is left out with a warning, and the rest of the plan goes on', async t => {
  const fixture = await linked(t, {
    'context/odd.md': `---\n---\n# Title\n\nFirst ${S}\n\n${claim('visibility=professional', `Claim ${S}`)}\nBand\n---\n\nSecond ${S}\n`,
    'context/good.md': doc('# Good\n', 'field_visibility:\n  Salary: private\n')
  })
  const before = await readFile(join(fixture.root, 'context/odd.md'), 'utf8'),
    plan = planPolicyMigration(fixture.root, { confirmActivation: true })
  assert.ok(plan.warnings.some(warning => warning.includes('context/odd.md') && warning.includes('left out')), 'reported')
  assert.ok(!JSON.stringify(plan.warnings).includes('Second'), 'a warning quotes no text')
  assert.ok(plan.entries.find(entry => entry.path === 'context/good.md').needs_migration, 'the rest goes on')
  applyPolicyMigration(fixture.root, plan.plan_id)
  assert.equal(await readFile(join(fixture.root, 'context/odd.md'), 'utf8'), before)
})

// N6. A shape with no real level ends at any real heading, so it hides less than a level would.
const LEVEL_LESS = {
  label: 'My salary history:',
  emphasis: '*Salary was never the point*',
  tag: '#salary',
  'fenced comment': '```sh\n# set salary\n```',
  'table header': '| Salary |\n|---|'
}
for (const [label, shape] of Object.entries(LEVEL_LESS))
  test(`N6: ${label} ends at any real heading`, async t => {
    const body = `# Doc\n\n${shape}\n\n${SECRET}\n\n### Deep\n\nDEEPTEXT ${S}\n\n## Experience\n\nWORKTEXT ${S}\n`,
      fixture = await linked(t, { [REL]: doc(body) })
    assertEveryPath(fixture, ['SECRETTEXT', 'DEEPTEXT', 'WORKTEXT'], ['DEEPTEXT', 'WORKTEXT'])
  })

const LEVELLED = {
  'indented ATX': '  ## Salary',
  'blockquoted ATX': '> ## Salary',
  'list ATX': '- ## Salary',
  'HTML h2': '<h2>Salary</h2>',
  Setext: 'Salary\n---'
}
for (const [label, shape] of Object.entries(LEVELLED))
  test(`N6: ${label} keeps its level, so a deeper heading does not end it`, async t => {
    const body = `# Doc\n\n${shape}\n\n${SECRET}\n\n### Deep\n\nDEEPTEXT ${S}\n\n## Experience\n\nWORKTEXT ${S}\n`,
      fixture = await linked(t, { [REL]: doc(body) })
    assertEveryPath(fixture, ['SECRETTEXT', 'DEEPTEXT', 'WORKTEXT'], ['WORKTEXT'])
  })

// N7. An ATX line stays a heading whatever its text ends with.
test('N7: `## Education:` stays a real heading with no rules, and with a rule on it', async t => {
  assert.deepEqual(sections('# A\n\nx\n\n## Education:\n\ny\n\n## Work\n\nz\n').map(section => section.heading), ['A', 'Education:', 'Work'])
  assert.deepEqual(sections('# A\n\nx\n\n## *Education*\n\ny\n').map(section => section.heading), ['A', '*Education*'])
  const body = `## Salary\n\n${SECRET}\n\n## Education:\n\nEDUTEXT ${S}\n`,
    metadata = { field_visibility: { Salary: 'private' } },
    out = filterFieldVisibility(body, metadata, 'general', 'x', [])
  assert.ok(out.includes('EDUTEXT') && !out.includes('SECRETTEXT'), 'it ends the rule before it')
  const fixture = await linked(t, { [REL]: doc(`# Doc\n\n## Education:\n\n${SECRET}\n\n## Work\n\nAFTERTEXT ${S}\n`, 'field_access:\n  Education:\n    access_lenses: [private]\n') })
  assertEveryPath(fixture, ['SECRETTEXT', 'AFTERTEXT'], ['AFTERTEXT'])
})

// N9. The walk is linear in the size of a claim.
test('N9: a 30,000-line claim is filtered quickly', () => {
  const body = claim('disclosure=publish-approved', Array.from({ length: 30000 }, (_, i) => `line ${i}`).join('\n')),
    started = performance.now()
  filterFieldVisibility(body, { field_visibility: { Salary: 'private' } }, 'general', 'x', [])
  const elapsed = performance.now() - started
  assert.ok(elapsed < 2000, `took ${Math.round(elapsed)} ms`)
})
test('N9: many small claims and very long odd lines stay linear', () => {
  const claims = Array.from({ length: 5000 }, (_, i) => claim('disclosure=publish-approved', `c ${i}`)).join(''),
    started = performance.now()
  filterFieldVisibility(claims, { field_visibility: { Salary: 'private' } }, 'general', 'x', [])
  for (const line of ['<'.repeat(200000), '*'.repeat(200000), `${'_'.repeat(50000)}a`, `${'a'.repeat(200000)}:`, '<h2'.repeat(60000), '|'.repeat(200000)])
    filterFieldVisibility(`${line}\n`, { field_visibility: { Salary: 'private' } }, 'general', 'x', [])
  const elapsed = performance.now() - started
  assert.ok(elapsed < 4000, `took ${Math.round(elapsed)} ms`)
})
