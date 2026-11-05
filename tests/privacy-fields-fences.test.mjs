// Heading rules across fenced code (#108). A `#` line inside a fence is code, so it must not end a field heading rule.
// Expected outcomes are literal tables written by hand, and the narrowing proof uses an oracle written here that knows
// nothing about fences. Synthetic data only.
import './helpers/isolated-config.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildIndex, searchIndex } from '../src/catalog/index.mjs'
import { buildCatalogSections, extractSectionAnnotations, privacySections } from '../src/catalog/source.mjs'
import { run } from '../src/cli.mjs'
import { contextData } from '../src/ecosystem.mjs'
import { classifyLines } from '../src/markdown/lines.mjs'
import { parseClaimBlocks } from '../src/markdown/claim-blocks.mjs'
import { sections } from '../src/markdown/text.mjs'
import { filterClaimVisibility, filterFieldVisibility, privacyMetadata } from '../src/policy/access.mjs'
import { catalogElementVisible } from '../src/policy/sub-document-rules.mjs'
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
  const root = await tempDir(t, 'holoself-fence-'),
    project = await tempDir(t, 'holoself-fence-project-')
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
function assertTextPaths(got, sentinels, expected, label) {
  for (const path of ['content', 'sections', 'claims']) assert.deepEqual(present(got[path], sentinels), expected, `${label} ${path}`)
}

const FENCE_LINE = `FENCETEXT ${S} #fencetag [f](https://fencelink.example)`
const FENCES = {
  'backtick with a # line': { fence: `\`\`\`sh\n# a shell comment\n${FENCE_LINE}\n\`\`\`\n` },
  'backtick with a ## line': { fence: `\`\`\`\n## Example\n${FENCE_LINE}\n\`\`\`\n` },
  'tilde fence': { fence: `~~~\n# a comment\n${FENCE_LINE}\n~~~\n` },
  'longer closer': { fence: `\`\`\`\n# a comment\n${FENCE_LINE}\n\`\`\`\`\`\n` },
  'shorter line does not close': { fence: `\`\`\`\`\n\`\`\`\n# a comment\n${FENCE_LINE}\n\`\`\`\`\n` },
  'other character does not close': { fence: `\`\`\`\n~~~\n# a comment\n${FENCE_LINE}\n\`\`\`\n` },
  'info string does not close': { fence: `\`\`\`\n\`\`\` js\n# a comment\n${FENCE_LINE}\n\`\`\`\n` },
  'indented up to three spaces': { fence: `   \`\`\`\n# a comment\n${FENCE_LINE}\n  \`\`\`\n` },
  'unclosed runs to end of file': { fence: `\`\`\`\n# a comment\n${FENCE_LINE}\n`, unclosed: true }
}
const fencedBody = fence => `# Doc\n\nOPENTEXT ${S}\n\n## Salary\n\nHEADTEXT ${S}\n\n${fence}\nTAILTEXT ${S}\n\n### Deep\n\nDEEPTEXT ${S}\n\n## After\n\nAFTERTEXT ${S}\n`
const ALL = ['OPENTEXT', 'HEADTEXT', 'FENCETEXT', 'TAILTEXT', 'DEEPTEXT', 'AFTERTEXT']

for (const [label, { fence, unclosed }] of Object.entries(FENCES))
  for (const [vocabulary, rules] of Object.entries(RULES))
    test(`a fence keeps the heading rule in force on every path: ${label} (${vocabulary})`, async t => {
      const rel = 'context/fence.md',
        fixture = await linked(t, { [rel]: doc(fencedBody(fence), rules) }),
        open = unclosed ? ['OPENTEXT'] : ['OPENTEXT', 'AFTERTEXT']
      const rows = [
        ['linked', 'general', 'generic', open],
        ['linked', 'general', 'public', open],
        ['linked', 'general', 'obsidian-public', open],
        ['linked', 'general', 'restricted-host', open],
        ['owner', 'general', 'generic', open],
        ['owner', 'private', 'generic', ALL]
      ]
      for (const [caller, lens, adapter, expected] of rows) {
        const got = paths(fixture, caller, lens, adapter, rel),
          name = `${caller} ${lens} ${adapter}`
        assertTextPaths(got, ALL, expected, name)
        assert.equal(got.tags.includes('fencetag'), expected.includes('FENCETEXT'), `${name} tags`)
        assert.equal(got.links.includes('fencelink.example'), expected.includes('FENCETEXT'), `${name} links`)
      }
      for (const adapter of ['generic', 'public']) {
        const found = JSON.stringify(searchIndex(buildIndex(fixture.project), 'sentence', 'general', null, null, 'current', { adapter }).filter(item => item.source_file === rel))
        assert.deepEqual(present(found, ALL), open, `search ${adapter}`)
      }
      const mcpFound = JSON.stringify(holoselfMcpSearch(fixture.project, { query: 'sentence', limit: 50 }).results.filter(item => item.source_file === rel))
      assert.deepEqual(present(mcpFound, ALL), open, 'MCP search')
      for (const manifest of [false, true]) {
        const data = holoselfMcpContext(fixture.project, { task: 'sentence', budget: 'deep', manifest }),
          text = JSON.stringify([data.self.documents.filter(item => item.path === rel), data.sources.filter(item => item.path === rel)])
        assert.deepEqual(present(text, ['HEADTEXT', 'FENCETEXT', 'TAILTEXT', 'DEEPTEXT']), [], `MCP context manifest=${manifest}`)
      }
    })

test('CRLF files behave the same', async t => {
  const rel = 'context/crlf.md',
    fixture = await linked(t, { [rel]: doc(fencedBody(FENCES['backtick with a # line'].fence)).replaceAll('\n', '\r\n') })
  assertTextPaths(paths(fixture, 'linked', 'general', 'generic', rel), ALL, ['OPENTEXT', 'AFTERTEXT'], 'CRLF')
  assertTextPaths(paths(fixture, 'owner', 'private', 'generic', rel), ALL, ALL, 'CRLF owner')
  const closed = sections('## A\r\n\r\n```\r\n## B\r\n```\r\n\r\ntext\r\n\r\n## C\r\n\r\nmore\r\n').map(section => section.heading)
  assert.deepEqual(closed, ['A', 'C'])
})

test('the line classifier follows CommonMark for fences and fails closed', () => {
  const walk = lines =>
    classifyLines(lines).map(({ raw, real, starts }) => {
      const heading = real || starts[0]
      return [raw, heading ? `${heading.level}:${heading.text}` : null]
    })
  assert.deepEqual(walk(['# Real', 'text', '####### seven', '#nospace']), [[false, '1:Real'], [false, null], [false, '1:seven'], [false, '1:nospace']])
  assert.deepEqual(walk(['```', '# In', '```', '# Out']), [[true, null], [true, '1:In'], [true, null], [false, '1:Out']])
  assert.deepEqual(walk(['~~~ info', '# In', '~~~', '# Out']), [[true, null], [true, '1:In'], [true, null], [false, '1:Out']])
  assert.deepEqual(walk(['   ```', '# In', '   ```', '# Out']), [[true, null], [true, '1:In'], [true, null], [false, '1:Out']])
  assert.deepEqual(walk(['    ```', '# Out']), [[false, null], [false, '1:Out']], 'four spaces is not a fence')
  assert.deepEqual(walk(['\t```', '# Out']), [[false, null], [false, '1:Out']], 'a tab is not a fence')
  assert.deepEqual(walk(['``', '# Out']), [[false, null], [false, '1:Out']], 'two backticks are not a fence')
  assert.deepEqual(walk(['``` a`b', '# Out']), [[false, null], [false, '1:Out']], 'a backtick info string is inline code')
  assert.deepEqual(walk(['~~~ a~b', '# In']), [[true, null], [true, '1:In']], 'a tilde info string may hold tildes')
  assert.deepEqual(walk(['````', '```', '# In', '`````  ', '# Out']), [[true, null], [true, null], [true, '1:In'], [true, null], [false, '1:Out']])
  assert.deepEqual(walk(['```', '```js', '# In']), [[true, null], [true, null], [true, '1:In']])
  assert.deepEqual(walk(['```', '~~~', '# In']), [[true, null], [true, null], [true, '1:In']])
  assert.deepEqual(walk(['```', '    ```', '# In']), [[true, null], [true, null], [true, '1:In']], 'a closer takes at most three spaces too')
})

test('a heading inside a fence creates no section, in the splitter and the catalog', () => {
  const body = `## One\n\nFirst ${S}\n\n\`\`\`\n## Not a heading\n# Nor this\n\`\`\`\n\n## Two\n\nSecond ${S}\n`
  assert.deepEqual(sections(body).map(section => section.heading), ['One', 'Two'])
  assert.deepEqual(sections(body, { raw: true }).length, 2)
  const policy = privacyMetadata({ access_lenses: ['general'], disclosure: 'internal-only', sensitivity: 'personal', document_role: 'content', read_scope: 'shared' })
  assert.deepEqual(buildCatalogSections(privacySections(body, policy)).map(section => section.section_id), ['one', 'two'])
  assert.deepEqual(sections('```\n# Unclosed\n\n## Swallowed\n').map(section => section.heading), ['(document)'])
})

const REVERSE = [
  [
    'a real ruled heading after an unclosed fence stays ruled',
    `INTROTEXT ${S}\n\n\`\`\`\n\n## Salary\n\nSECRETTEXT ${S}\n\n## After\n\nAFTERTEXT ${S}\n`,
    ['INTROTEXT']
  ],
  [
    'a ruled name inside a closed fence opens the rule, up to the next real heading',
    `INTROTEXT ${S}\n\n\`\`\`\n## Salary\nSECRETTEXT ${S}\n\`\`\`\n\nTAILTEXT ${S}\n\n## After\n\nAFTERTEXT ${S}\n`,
    ['INTROTEXT', 'AFTERTEXT']
  ],
  [
    'a deep real heading after a fenced ruled name stays covered',
    `\`\`\`\n## Salary\n\`\`\`\n\n### Deep\n\nSECRETTEXT ${S}\n\n## After\n\nAFTERTEXT ${S}\n`,
    ['AFTERTEXT']
  ],
  [
    'an opener inside a claim ends with the claim, so it cannot swallow a real ruled heading',
    `${claim('disclosure=publish-approved', `INTROTEXT ${S}\n\n\`\`\``)}\n## Salary\n\nSECRETTEXT ${S}\n\n## After\n\nAFTERTEXT ${S}\n`,
    ['INTROTEXT', 'AFTERTEXT']
  ],
  [
    'an opener in a ruled section hides the rest of the file',
    `## Salary\n\n\`\`\`\n\n## After\n\nSECRETTEXT ${S}\n`,
    []
  ],
  [
    'a fence around a claim keeps the rule on the claim and the text after it',
    `## Salary\n\n\`\`\`\n${claim('disclosure=publish-approved', `SECRETTEXT ${S}`)}\`\`\`\n\nTAILTEXT ${S}\n\n## After\n\nAFTERTEXT ${S}\n`,
    ['AFTERTEXT']
  ],
  [
    'a closer inside a claim cannot end a fence that opened outside it',
    `## Salary\n\n\`\`\`\n${claim('disclosure=publish-approved', `\`\`\`\nSECRETTEXT ${S}`)}\n# Still code\n\nTAILTEXT ${S}\n\`\`\`\n\n## After\n\nAFTERTEXT ${S}\n`,
    ['AFTERTEXT']
  ],
  [
    'a ruled name fenced inside a claim stops at the claim',
    `${claim('disclosure=publish-approved', `INTROTEXT ${S}\n\n\`\`\`\n## Salary\nSECRETTEXT ${S}\n\`\`\``)}\nAFTERTEXT ${S}\n`,
    ['INTROTEXT', 'AFTERTEXT']
  ]
]
for (const [label, body, expected] of REVERSE)
  test(`reverse direction: ${label}`, async t => {
    const rel = 'context/reverse.md',
      opener = `# Doc\n\nOPENTEXT ${S}\n\n`,
      fixture = await linked(t, { [rel]: doc(opener + body) }),
      sentinels = ['INTROTEXT', 'SECRETTEXT', 'TAILTEXT', 'AFTERTEXT']
    for (const adapter of ['generic', 'public']) {
      const got = paths(fixture, 'linked', 'general', adapter, rel)
      assertTextPaths(got, sentinels, expected, adapter)
      assert.equal((got.content.match(/<!-- holoself-claim/g) || []).length, (got.content.match(/<!-- \/holoself-claim/g) || []).length, `${adapter} balanced markers`)
    }
  })

test('a claim beside a fence is parsed the same, and a hidden claim cannot change what the fence does for other lenses', async t => {
  const rel = 'context/adjacent.md',
    body =
      `# Doc\n\n\`\`\`\ncode ${S}\n\`\`\`\n${claim('disclosure=publish-approved', `CLAIMTEXT ${S}`)}\`\`\`\nmore ${S}\n\`\`\`\n\n` +
      claim('access_lenses=private', `HIDDENCLAIM ${S}\n\n\`\`\``) +
      `\n## Salary\n\nSECRETTEXT ${S}\n\n## After\n\nAFTERTEXT ${S}\n`,
    fixture = await linked(t, { [rel]: doc(body) }),
    sentinels = ['CLAIMTEXT', 'HIDDENCLAIM', 'SECRETTEXT', 'AFTERTEXT']
  assert.equal(parseClaimBlocks(body).length, 2)
  assert.equal(parseClaimBlocks(body).every(block => !block.malformed), true)
  assertTextPaths(paths(fixture, 'linked', 'general', 'generic', rel), sentinels, ['CLAIMTEXT', 'AFTERTEXT'], 'general')
  assertTextPaths(paths(fixture, 'owner', 'private', 'generic', rel), sentinels, sentinels, 'private')
})

test('text sharing a line with a claim marker counts on both walks', async t => {
  const rel = 'context/line.md',
    body =
      `# Doc\n\n## Salary\n\n${`<!-- holoself-claim disclosure=publish-approved -->ONE ${S}<!-- /holoself-claim --><!-- holoself-claim disclosure=publish-approved -->TWO ${S}<!-- /holoself-claim -->`}\n\n` +
      `## Salary notes <!-- holoself-claim disclosure=publish-approved -->\nTHREE ${S}\n<!-- /holoself-claim -->\nTAILTEXT ${S}\n\n## After\n\nAFTERTEXT ${S}\n`,
    fixture = await linked(t, { [rel]: doc(body) })
  assertTextPaths(paths(fixture, 'linked', 'general', 'generic', rel), ['ONE', 'TWO', 'THREE', 'TAILTEXT', 'AFTERTEXT'], ['AFTERTEXT'], 'general')
})

// The proof that fence handling can only narrow. A random document is built from a small vocabulary, and each sentinel
// is judged by a walk that treats every heading-shaped line as a heading and has never heard of fences. What that walk
// hides must stay hidden on every path, however the fences fall.
function random(seed) {
  let state = seed
  return n => {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    return state % n
  }
}
const PIECES = [
  '```', '~~~', '````', '``` js', '   ```', '# Top', '## Salary', '## Other', '### Salary band', '### Deep', '#### Deeper', '', 'plain', 'plain',
  '   ## Other', '    ## Other', '    ## Salary', '> ## Other', '> ## Salary', '- ## Other', '- ## Salary', '## Other ##', '## Salary ##', '<h2>Other</h2>', '<h2>Salary</h2>',
  '##Other', '##Salary', '**Other**', '**Salary**', 'Other\n---', 'Salary\n---', 'Salary\n===', 'Other\n===', '<pre>', '</pre>', '<!--', '-->', '<div>', '</div>', '<!-- note -->'
]
function generate(next) {
  const lines = []
  let id = 0
  const sentinel = () => {
    id++
    return `SENT${id}X ${S} #sent${id}tag [l](https://sent${id}.example)`
  }
  const emit = target => {
    const piece = PIECES[next(PIECES.length)]
    target.push(...(piece === 'plain' ? sentinel() : piece).split('\n'))
  }
  for (let i = 0, count = 8 + next(18); i < count; i++) {
    if (next(6) === 0) {
      const inner = [sentinel()]
      for (let j = 0, size = next(5); j < size; j++) emit(inner)
      inner.push(sentinel())
      lines.push('<!-- holoself-claim disclosure=publish-approved -->', ...inner, '<!-- /holoself-claim -->')
    } else emit(lines)
  }
  return lines
}
function fenceBlindHidden(lines) {
  const hidden = new Set(),
    ruled = text => text.toLowerCase().includes('salary')
  let outer = [],
    inner = null
  for (const line of lines) {
    if (line.startsWith('<!-- holoself-claim')) {
      inner = [...outer]
      continue
    }
    if (line.startsWith('<!-- /holoself-claim')) {
      inner = null
      continue
    }
    const heading = line.match(/^ {0,3}(#{1,6}) (.+)$/)
    if (heading) {
      const level = heading[1].length,
        scope = (inner ?? outer).filter(value => value < level)
      if (ruled(heading[2])) scope.push(level)
      if (inner) inner = scope
      else outer = scope
      continue
    }
    if ((inner ?? outer).length && line.startsWith('SENT')) hidden.add(line.split(' ')[0])
  }
  return hidden
}
test('fences and unusual shapes can only narrow: 2,000 generated documents against the plain rule, on content, sections, claims, tags and links', () => {
  const metadata = { access_lenses: ['general', 'private'], disclosure: 'publish-approved', sensitivity: 'personal', document_role: 'content', read_scope: 'shared', field_access: { Salary: { access_lenses: ['private'] } } },
    policy = privacyMetadata(metadata)
  let hiddenChecked = 0
  for (let seed = 1; seed <= 2000; seed++) {
    const lines = generate(random(seed)),
      body = lines.join('\n') + '\n',
      hidden = fenceBlindHidden(lines),
      raw = privacySections(body, policy),
      annotations = extractSectionAnnotations(raw, policy),
      filter = text => filterFieldVisibility(filterClaimVisibility(text, 'general', 'x', []), metadata, 'general', 'x', []),
      content = filter(body),
      visible = list => list.filter(item => catalogElementVisible(item, 'general', 'generic')),
      sectionText = visible(buildCatalogSections(raw)).map(section => filter(section.snippet)).join('\n'),
      claimText = visible(annotations.claims).map(item => item.text).join('\n'),
      tagText = visible(annotations.tags).map(item => item.value).join('\n'),
      linkText = visible(annotations.links).map(item => item.value).join('\n')
    for (const sentinel of hidden) {
      hiddenChecked++
      assert.ok(!content.includes(`${sentinel} `), `seed ${seed}: ${sentinel} in content`)
      assert.ok(!sectionText.includes(`${sentinel} `), `seed ${seed}: ${sentinel} in sections`)
      assert.ok(!claimText.includes(`${sentinel} `), `seed ${seed}: ${sentinel} in claims`)
      const id = sentinel.slice(4, -1)
      assert.ok(!tagText.split('\n').includes(`sent${id}tag`), `seed ${seed}: ${sentinel} in tags`)
      assert.ok(!linkText.split('\n').includes(`https://sent${id}.example`), `seed ${seed}: ${sentinel} in links`)
    }
    for (const line of sectionText.split('\n')) if (line.startsWith('SENT')) assert.ok(content.includes(line.replace(/\.\.\.$/, '')), `seed ${seed}: sections is a subset of content: ${line}`)
    for (const line of claimText.split('\n')) if (line.startsWith('SENT')) assert.ok(content.includes(line), `seed ${seed}: claims is a subset of content: ${line}`)
  }
  assert.ok(hiddenChecked > 2000, `hidden sentinels checked: ${hiddenChecked}`)
})
