// A heading rule starts liberally and ends conservatively (#108). Any line that could present a ruled name as a heading
// opens the rule, and only an unambiguous real heading ends it, so unusual shapes hide more rather than less. Expected
// outcomes are literal tables written by hand. Synthetic data only.
import './helpers/isolated-config.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildIndex, searchIndex } from '../src/catalog/index.mjs'
import { run } from '../src/cli.mjs'
import { contextData } from '../src/ecosystem.mjs'
import { holoselfMcpContext, holoselfMcpSearch } from '../src/retrieval/mcp.mjs'

const S = 'sentence long enough to be a claim.'
const claim = (attrs, text) => `<!-- holoself-claim ${attrs} -->\n${text}\n<!-- /holoself-claim -->\n`
const META = 'access_lenses: [general, technical, private]\ndisclosure: publish-approved\nsensitivity: personal\ndocument_role: content\nread_scope: shared\n'
const RULES = {
  modern: 'field_access:\n  Salary:\n    access_lenses: [private]\n',
  legacy: 'field_visibility:\n  Salary: private\n'
}
const doc = (body, rules = RULES.modern) => `---\n${META}${rules}---\n${body}`

async function quiet(fn) {
  const log = console.log,
    error = console.error
  console.log = () => {}
  console.error = () => {}
  try {
    await fn()
  } finally {
    console.log = log
    console.error = error
  }
}
async function tempDir(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}
async function linked(t, docs) {
  const root = await tempDir(t, 'holoself-shape-'),
    project = await tempDir(t, 'holoself-shape-project-')
  await quiet(() => run(['init', '--root', root]))
  await quiet(() => run(['link', 'add', '--self', root, '--project', project, '--lens', 'general', '--yes', '--no-activate']))
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
function paths(fixture, caller, lens, adapter, rel) {
  const docItem = packet(fixture, caller, { lens, adapter }).self.documents.find(item => item.path === rel),
    entry = packet(fixture, caller, { lens, adapter, manifest: true }).sources.find(item => item.path === rel)
  assert.ok(docItem && entry, `${rel} is delivered to ${caller} ${lens} ${adapter}`)
  return { content: docItem.content, sections: JSON.stringify(entry.sections), claims: JSON.stringify(entry.claims), tags: JSON.stringify(entry.tags), links: JSON.stringify(entry.links) }
}
const present = (text, sentinels) => sentinels.filter(sentinel => text.includes(sentinel))
const REL = 'context/shape.md'
// Every path a caller can read, against one literal list. `secret` is the sentinel that also carries a tag and a link.
function assertEveryPath(fixture, sentinels, expected) {
  for (const adapter of ['generic', 'public', 'obsidian-public', 'restricted-host']) {
    const got = paths(fixture, 'linked', 'general', adapter, REL)
    for (const path of ['content', 'sections', 'claims']) assert.deepEqual(present(got[path], sentinels), expected, `${adapter} ${path}`)
    const shown = expected.includes('SECRETTEXT')
    assert.equal(got.tags.includes('secrettag'), shown, `${adapter} tags`)
    assert.equal(got.links.includes('secretlink.example'), shown, `${adapter} links`)
    const found = JSON.stringify(searchIndex(buildIndex(fixture.project), 'sentence', 'general', null, null, 'current', { adapter }).filter(item => item.source_file === REL))
    assert.deepEqual(present(found, sentinels), expected, `search ${adapter}`)
  }
  const mcpFound = JSON.stringify(holoselfMcpSearch(fixture.project, { query: 'sentence', limit: 50 }).results.filter(item => item.source_file === REL))
  assert.deepEqual(present(mcpFound, sentinels), expected, 'MCP search')
  for (const manifest of [false, true]) {
    const data = holoselfMcpContext(fixture.project, { task: 'sentence', budget: 'deep', manifest }),
      text = JSON.stringify([data.self.documents.filter(item => item.path === REL), data.sources.filter(item => item.path === REL)])
    assert.deepEqual(present(text, sentinels.filter(x => !expected.includes(x))), [], `MCP context manifest=${manifest}`)
  }
  const owner = paths(fixture, 'owner', 'private', 'generic', REL)
  assert.deepEqual(present(owner.content, sentinels), sentinels, 'the owner reads everything under the private lens')
}
const SECRET = `SECRETTEXT ${S} #secrettag [s](https://secretlink.example)`

// shape, and the level of real heading that ends it: 2 for a level-2 shape or one with no level, 1 for a level-1 shape.
const START_SHAPES = {
  'indented by two spaces': ['  ## Salary\n', 2],
  'indented by four spaces': ['    ## Salary\n', 2],
  'indented by a tab': ['\t## Salary\n', 2],
  'Setext with dashes': ['Salary\n------\n', 2],
  'Setext with equals': ['Salary\n======\n', 1],
  'Setext over two lines': ['Pay and\nSalary notes\n---\n', 2],
  blockquote: ['> ## Salary\n', 2],
  'nested blockquote': ['> > ## Salary\n', 2],
  'list prefix': ['- ## Salary\n', 2],
  'numbered list prefix': ['1. ## Salary\n', 2],
  'list inside a blockquote': ['> - ## Salary\n', 2],
  'closed ATX': ['## Salary ##\n', 2],
  'HTML heading': ['<h2>Salary</h2>\n', 2],
  'HTML heading with attributes': ['<H2 class="x">Salary</H2>\n', 2],
  'HTML heading over three lines': ['<h2>\nSalary\n</h2>\n', 2],
  'inside a closed pre': ['<pre>\n## Salary\n</pre>\n', 2],
  'inside a closed comment': ['<!--\n## Salary\n-->\n', 2],
  'on a one-line comment': ['<!-- ## Salary -->\n', 2],
  'without a space': ['##Salary\n', 2],
  'seven hashes': ['####### Salary\n', 2],
  'bold line': ['**Salary**\n', 2],
  'bold HTML line': ['<strong>Salary</strong>\n', 2],
  'italic line': ['*Salary*\n', 2],
  'bold italic line': ['***Salary***\n', 2],
  'name and colon alone on a line': ['Salary:\n', 2],
  'bold name and colon': ['**Salary:**\n', 2],
  'summary element': ['<summary>Salary</summary>\n', 2],
  'table caption element': ['<caption>Salary</caption>\n', 2]
}
for (const [label, [shape, level]] of Object.entries(START_SHAPES))
  for (const [vocabulary, rules] of Object.entries(RULES))
    test(`start: ${label} opens the rule on every path (${vocabulary})`, async t => {
      const body = `# Doc\n\nOPENTEXT ${S}\n\n## Intro\n\nINTROTEXT ${S}\n\n${shape}\n${SECRET}\n\n## After\n\nAFTERTEXT ${S}\n\n# Last\n\nLASTTEXT ${S}\n`,
        fixture = await linked(t, { [REL]: doc(body, rules) }),
        sentinels = ['OPENTEXT', 'INTROTEXT', 'SECRETTEXT', 'AFTERTEXT', 'LASTTEXT']
      assertEveryPath(fixture, sentinels, level === 2 ? ['OPENTEXT', 'INTROTEXT', 'AFTERTEXT', 'LASTTEXT'] : ['OPENTEXT', 'INTROTEXT', 'LASTTEXT'])
    })

const NON_END_SHAPES = {
  'four-space indent': '    ## Next\n',
  'Setext with dashes': 'Next\n----\n',
  'Setext with equals': 'Next\n====\n',
  blockquote: '> ## Next\n',
  'list prefix': '- ## Next\n',
  'HTML heading': '<h2>Next</h2>\n',
  'closed pre': '<pre>\n## Next\n</pre>\n',
  'closed comment': '<!--\n## Next\n-->\n',
  'raw HTML block': '<div>\n## Next\n</div>\n',
  'processing instruction': '<?php\n## Next\n?>\n',
  'no space': '##Next\n',
  'bold line': '**Next**\n',
  'italic line': '*Next*\n',
  'name and colon': 'Next:\n',
  'summary element': '<summary>Next</summary>\n',
  'ATX line that also holds an HTML heading': '## Next <h2>Other</h2>\n',
  'ATX line that opens a comment': '## Next <!-- open\n-->\n'
}
for (const [label, shape] of Object.entries(NON_END_SHAPES))
  for (const [vocabulary, rules] of Object.entries(RULES))
    test(`no end: ${label} under a ruled heading keeps the rule in force (${vocabulary})`, async t => {
      const body = `# Doc\n\nOPENTEXT ${S}\n\n## Salary\n\nHEADTEXT ${S}\n\n${shape}\n${SECRET}\n\n## After\n\nAFTERTEXT ${S}\n`,
        fixture = await linked(t, { [REL]: doc(body, rules) })
      assertEveryPath(fixture, ['OPENTEXT', 'HEADTEXT', 'SECRETTEXT', 'AFTERTEXT'], ['OPENTEXT', 'AFTERTEXT'])
    })

const UNCLOSED = { pre: '<pre>\n', comment: '<!--\n', 'comment in a line of text': `TEXT ${S} <!-- open\n`, script: '<script>\n' }
for (const [label, opener] of Object.entries(UNCLOSED))
  for (const [vocabulary, rules] of Object.entries(RULES))
    test(`no end: an unclosed ${label} runs to the end of the file (${vocabulary})`, async t => {
      const body = `# Doc\n\nOPENTEXT ${S}\n\n## Salary\n\n${opener}\n${SECRET}\n\n## After\n\nAFTERTEXT ${S}\n`,
        fixture = await linked(t, { [REL]: doc(body, rules) })
      assertEveryPath(fixture, ['OPENTEXT', 'SECRETTEXT', 'AFTERTEXT'], ['OPENTEXT'])
    })

const REAL_ENDS = {
  'column 0': '## Next\n',
  'closed ATX': '## Next ##\n',
  'above the rule': '# Next\n',
  'after a closed pre': '<pre>\nx\n</pre>\n\n## Next\n',
  'after a closed comment': '<!-- note -->\n\n## Next\n',
  'after a blank line ends a raw block': '<div>\nx\n</div>\n\n## Next\n'
}
for (const [label, shape] of Object.entries(REAL_ENDS))
  test(`real end: ${label} ends the rule`, async t => {
    const body = `# Doc\n\n## Salary\n\n${SECRET}\n\n${shape}\nTAILTEXT ${S}\n`,
      fixture = await linked(t, { [REL]: doc(body) })
    assertEveryPath(fixture, ['SECRETTEXT', 'TAILTEXT'], ['TAILTEXT'])
  })

test('a deeper real heading does not end a rule that started on an unusual shape', async t => {
  const body = `# Doc\n\nOPENTEXT ${S}\n\n<h2>Salary</h2>\n\n### Deeper\n\n${SECRET}\n\n## After\n\nAFTERTEXT ${S}\n`,
    fixture = await linked(t, { [REL]: doc(body) })
  assertEveryPath(fixture, ['OPENTEXT', 'SECRETTEXT', 'AFTERTEXT'], ['OPENTEXT', 'AFTERTEXT'])
})

test('an unusual shape inside a claim stops at the claim, and one around a claim covers it', async t => {
  const body =
      `# Doc\n\n${claim('disclosure=publish-approved', `INSIDETEXT ${S}\n\n<h2>Salary</h2>\n\nHIDDENTEXT ${S}`)}\nOPENTEXT ${S}\n\n` +
      `> ## Salary\n\n${claim('disclosure=publish-approved', `AROUNDTEXT ${S}`)}\n## After\n\nAFTERTEXT ${S}\n`,
    fixture = await linked(t, { [REL]: doc(body) })
  for (const adapter of ['generic', 'public']) {
    const got = paths(fixture, 'linked', 'general', adapter, REL),
      sentinels = ['INSIDETEXT', 'HIDDENTEXT', 'OPENTEXT', 'AROUNDTEXT', 'AFTERTEXT']
    for (const path of ['content', 'sections', 'claims']) assert.deepEqual(present(got[path], sentinels), ['INSIDETEXT', 'OPENTEXT', 'AFTERTEXT'], `${adapter} ${path}`)
  }
})

test('a Setext name cut off by the snippet limit does not reach the catalog', async t => {
  const filler = 'x'.repeat(340),
    body = `# Doc\n\n${filler}\nCUTTEXT Salary\n---\n\nHIDDENTEXT ${S}\n\n## After\n\nAFTERTEXT ${S}\n`,
    fixture = await linked(t, { [REL]: doc(body) }),
    got = paths(fixture, 'linked', 'general', 'generic', REL)
  assert.deepEqual(present(got.content, ['CUTTEXT', 'HIDDENTEXT', 'AFTERTEXT']), ['AFTERTEXT'])
  assert.deepEqual(present(got.sections, ['CUTTEXT', 'HIDDENTEXT', 'AFTERTEXT']), ['AFTERTEXT'])
})

// A heading or fence split across a multi-line claim block. With the block removed the pieces join into one line, which
// is how the catalog reads them, so `content` has to read them the same way.
const SPLIT = {
  'a ruled heading split by a claim': {
    body: `## Sal<!-- holoself-claim disclosure=publish-approved -->\nCLAIMTEXT ${S}\n<!-- /holoself-claim -->ary\n\nSECRETTEXT ${S}\n\n## After\n\nAFTERTEXT ${S}\n`,
    expected: ['AFTERTEXT']
  },
  'a fence opener split by a claim': {
    body: `## Salary\n\n\`\`<!-- holoself-claim disclosure=publish-approved -->\nCLAIMTEXT ${S}\n<!-- /holoself-claim -->\`\n# Comment\n\nSECRETTEXT ${S}\n\`\`\`\n\n## After\n\nAFTERTEXT ${S}\n`,
    expected: ['AFTERTEXT']
  },
  'a fence opener with an info string split by a claim': {
    body: `## Salary\n\n\`\`\`<!-- holoself-claim disclosure=publish-approved -->\nCLAIMTEXT ${S}\n<!-- /holoself-claim --> js\n# Comment\n\nSECRETTEXT ${S}\n\`\`\`\n\n## After\n\nAFTERTEXT ${S}\n`,
    expected: ['AFTERTEXT']
  },
  // With the block lifted out, the claim sits on the heading's own line, so the rule covers it.
  'a heading after a claim closer on the same line': {
    body: `<!-- holoself-claim disclosure=publish-approved -->\nCLAIMTEXT ${S}\n<!-- /holoself-claim -->## Salary\nSECRETTEXT ${S}\n\n## After\n\nAFTERTEXT ${S}\n`,
    expected: ['AFTERTEXT']
  },
  'a heading before a claim opener on the same line': {
    body: `## Salary <!-- holoself-claim disclosure=publish-approved -->\nCLAIMTEXT ${S}\n<!-- /holoself-claim -->\nSECRETTEXT ${S}\n\n## After\n\nAFTERTEXT ${S}\n`,
    expected: ['AFTERTEXT']
  },
  'a heading right after a claim opener': {
    body: `<!-- holoself-claim disclosure=publish-approved -->## Salary\nSECRETTEXT ${S}\n<!-- /holoself-claim -->\n\nAFTERTEXT ${S}\n`,
    expected: ['AFTERTEXT']
  }
}
for (const [label, { body, expected }] of Object.entries(SPLIT))
  test(`split across a claim: ${label} reads the same on content and the catalog`, async t => {
    const fixture = await linked(t, { [REL]: doc(`# Doc\n\n${body}`) }),
      sentinels = ['CLAIMTEXT', 'SECRETTEXT', 'AFTERTEXT']
    for (const adapter of ['generic', 'public']) {
      const got = paths(fixture, 'linked', 'general', adapter, REL)
      for (const path of ['content', 'sections', 'claims']) assert.deepEqual(present(got[path], sentinels), expected, `${adapter} ${path}`)
    }
  })

test('CRLF: shapes behave the same', async t => {
  const body = `# Doc\n\n## Intro\n\nINTROTEXT ${S}\n\nSalary\n---\n\n${SECRET}\n\n<pre>\n## Next\n</pre>\n\nTAILTEXT ${S}\n\n## After\n\nAFTERTEXT ${S}\n`,
    fixture = await linked(t, { [REL]: doc(body).replaceAll('\n', '\r\n') })
  assertEveryPath(fixture, ['INTROTEXT', 'SECRETTEXT', 'TAILTEXT', 'AFTERTEXT'], ['INTROTEXT', 'AFTERTEXT'])
})
