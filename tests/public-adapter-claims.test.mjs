// Issue #106: claim- and field-level restrictions on publication adapters. A publish-approved document delivers only
// its `public-safe` claims and fields on `public`, `obsidian-public` and `restricted-host`; standard adapters are unchanged.
import './helpers/isolated-config.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from '../src/cli.mjs'
import { contextData } from '../src/ecosystem.mjs'
import { buildIndex, searchIndex } from '../src/catalog/index.mjs'
import { PUBLICATION_ADAPTERS, filterClaimVisibility, filterFieldVisibility } from '../src/policy/access.mjs'

const VALUES = ['private', 'professional', 'linked-projects', 'public-voice', 'public-safe']
const FIELD_NAMES = { private: 'Private Notes', professional: 'Pro Notes', 'linked-projects': 'Linked Notes', 'public-voice': 'Voice Notes', 'public-safe': 'Safe Notes' }
const LINE_NAMES = { private: 'Hobby', professional: 'Salary', 'linked-projects': 'Team', 'public-voice': 'Tagline', 'public-safe': 'Motto' }
const tag = v => v.toUpperCase().replace('-', '_')
const sentinels = v => [`CLAIM_${tag(v)}_SENTINEL`, `FIELD_${tag(v)}_SENTINEL`, `LINE_${tag(v)}_SENTINEL`]
const fieldVisibility =
  'field_visibility:\n' + VALUES.map(v => `  ${FIELD_NAMES[v]}: ${v}\n  ${LINE_NAMES[v]}: ${v}\n`).join('')
const body =
  '# Mixed document\n\nOpen sentence.\n\n' +
  VALUES.map(v => `<!-- holoself-claim visibility=${v} -->\nCLAIM_${tag(v)}_SENTINEL claim.\n<!-- /holoself-claim -->\n`).join('\n') +
  '\n' +
  VALUES.map(v => `## ${FIELD_NAMES[v]}\n\nFIELD_${tag(v)}_SENTINEL text.\n`).join('\n') +
  '\n## Lines\n\n' +
  VALUES.map(v => `- ${LINE_NAMES[v]}: LINE_${tag(v)}_SENTINEL`).join('\n') +
  '\n'
const DOCS = {
  // Modern publication field set.
  'context/modern.md': `---\naccess_lenses: [general, professional, public-voice, private]\ndisclosure: publish-approved\nsensitivity: personal\ndocument_role: content\n${fieldVisibility}---\n${body}`,
  // Legacy `visibility: public-safe`, which maps to `disclosure: publish-approved` and also exposes catalog sections.
  'context/legacy.md': `---\nvisibility: public-safe\n${fieldVisibility}---\n${body}`
}

async function quiet(fn) {
  const old = console.log
  console.log = () => {}
  try {
    return await fn()
  } finally {
    console.log = old
  }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'holoself-public-claims-')),
    project = await mkdtemp(join(tmpdir(), 'holoself-public-claims-project-'))
  await quiet(() => run(['init', '--root', root]))
  await quiet(() =>
    run(['link', 'add', '--self', root, '--project', project, '--lens', 'general', '--secondary-lenses', 'professional,public-voice', '--yes', '--no-activate'])
  )
  for (const [path, text] of Object.entries(DOCS)) await writeFile(join(root, path), text)
  return { root, project }
}
function resolve({ root, project }, adapter, who) {
  const options = { lens: 'general', adapter, task: 'mixed document', json: true }
  if (who === 'linked') return contextData({ ...options, project })
  const cwd = process.cwd()
  process.chdir(root)
  try {
    return contextData({ ...options, root, rootExplicit: true })
  } finally {
    process.chdir(cwd)
  }
}
const mixedDocs = data => data.self.documents.filter(doc => doc.path in DOCS)
const mixedRestrictions = data => data.restrictions.filter(r => r.source in DOCS)

const fixturePromise = fixture()

for (const adapter of PUBLICATION_ADAPTERS) {
  for (const who of ['linked', 'owner']) {
    test(`${adapter} adapter delivers only public-safe claims and fields (${who} caller)`, async () => {
      const data = resolve(await fixturePromise, adapter, who)
      const docs = mixedDocs(data)
      assert.deepEqual(docs.map(doc => doc.path).sort(), Object.keys(DOCS).sort(), 'both publish-approved documents pass phase 7')
      for (const doc of docs) {
        for (const value of VALUES)
          for (const sentinel of sentinels(value)) {
            const haystack = JSON.stringify([doc.content, doc.sections, doc.claims])
            if (value === 'public-safe') assert.match(doc.content, new RegExp(sentinel), `${doc.path}: ${sentinel} kept`)
            else assert.doesNotMatch(haystack, new RegExp(sentinel), `${doc.path}: ${sentinel} leaked on ${adapter}`)
          }
        assert.doesNotMatch(doc.content, /holoself-claim visibility=(?!public-safe)/, 'no non-public claim marker survives')
      }
      // Sizes are measured after filtering.
      assert.equal(data.selection.content_chars, data.self.documents.reduce((sum, doc) => sum + doc.content.length, 0) + data.project.documents.reduce((sum, doc) => sum + doc.content.length, 0))
      assert.equal(data.selection.total_bytes, Buffer.byteLength(JSON.stringify(data, null, 2) + '\n'))
      // Restrictions name the publication gate for elements the lens alone would show.
      const reasons = mixedRestrictions(data).map(r => r.reason)
      assert.ok(reasons.includes(`field not approved for publication on ${adapter} adapter`))
      assert.ok(!reasons.some(reason => Object.values(FIELD_NAMES).some(name => reason.includes(name))), 'no field name in a reason')
      assert.ok(reasons.includes('field excluded by general lens'))
      assert.ok(!reasons.some(reason => /Safe Notes|Motto/.test(reason)), 'public-safe fields are not reported')
      const claimReasons = reasons.filter(reason => reason.startsWith('claim '))
      if (who === 'linked') assert.deepEqual(claimReasons, [], 'hidden claims are not reported to linked callers')
      else assert.ok(claimReasons.includes(`claim visibility linked-projects not approved for publication on ${adapter} adapter`))
    })
  }
}

test('generic and claude adapters keep claims and fields as before (#106 narrows publication adapters only)', async () => {
  const fx = await fixturePromise
  const baseline = {}
  for (const adapter of ['generic', 'claude']) {
    for (const who of ['linked', 'owner']) {
      const data = resolve(fx, adapter, who)
      const docs = mixedDocs(data)
      assert.equal(docs.length, 2)
      for (const doc of docs) {
        // Under the general lens every visibility except `private` was and stays visible on standard adapters.
        for (const value of VALUES)
          for (const sentinel of sentinels(value)) {
            if (value === 'private') assert.doesNotMatch(doc.content, new RegExp(sentinel))
            else assert.match(doc.content, new RegExp(sentinel), `${adapter}/${who} ${doc.path}: ${sentinel}`)
          }
      }
      const reasons = mixedRestrictions(data).map(r => r.reason)
      assert.ok(!reasons.some(reason => /publication/.test(reason)), 'no publication reasons on standard adapters')
      const view = docs.map(doc => [doc.path, doc.content, doc.sections, doc.claims])
      baseline[who] ??= view
      assert.deepEqual(view, baseline[who], `${adapter} matches generic for ${who}`)
    }
  }
})

test('filters default to the generic adapter and narrow only when a publication adapter is passed', () => {
  const claimBody = VALUES.map(v => `<!-- holoself-claim visibility=${v} -->\n${v}\n<!-- /holoself-claim -->`).join('\n')
  const withDefault = filterClaimVisibility(claimBody, 'general', 'x.md', [])
  assert.equal(filterClaimVisibility(claimBody, 'general', 'x.md', [], null, 'owner:direct', 'generic'), withDefault)
  assert.equal(filterClaimVisibility(claimBody, 'general', 'x.md', [], null, 'owner:direct', 'claude'), withDefault)
  for (const adapter of PUBLICATION_ADAPTERS) {
    const restrictions = []
    const out = filterClaimVisibility(claimBody, 'general', 'x.md', restrictions, null, 'client:linked', adapter)
    assert.match(out, /visibility=public-safe/)
    assert.doesNotMatch(out, /visibility=(private|professional|linked-projects|public-voice)/)
    assert.deepEqual(restrictions, [])
    const fields = filterFieldVisibility('- Salary: 1\n- Motto: 2\n', { field_visibility: { Salary: 'linked-projects', Motto: 'public-safe' } }, 'general', 'x.md', [], null, 'owner:direct', adapter)
    assert.equal(fields, '- Motto: 2\n')
  }
  assert.equal(filterFieldVisibility('- Salary: 1\n', { field_visibility: { Salary: 'linked-projects' } }, 'general', 'x.md', []), '- Salary: 1\n')
})

test('search narrows claims and fields when a publication adapter is requested and is unchanged by default', async () => {
  const { project } = await fixturePromise
  const index = buildIndex(project)
  const passages = results => results.map(r => r.matching_passage).join('\n')
  const standard = passages(searchIndex(index, 'sentinel', 'general'))
  assert.match(standard, /CLAIM_LINKED_PROJECTS_SENTINEL/)
  for (const adapter of PUBLICATION_ADAPTERS) {
    const text = passages(searchIndex(index, 'sentinel', 'general', null, null, 'current', { adapter }))
    assert.match(text, /CLAIM_PUBLIC_SAFE_SENTINEL/)
    for (const value of VALUES.filter(v => v !== 'public-safe')) for (const sentinel of sentinels(value)) assert.doesNotMatch(text, new RegExp(sentinel))
  }
})
