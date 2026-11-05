// Issue #108 (0.12.0 stage of docs/decisions/privacy-fields-and-legacy-mount.md): the runtime reads `field_access` and
// lens-vocabulary claim markers, and `migrate policy` rewrites the deprecated forms exactly. Synthetic data only.
import './helpers/isolated-config.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { annotationSchema, validateAnnotationMetadata } from '../src/annotations.mjs'
import { buildIndex, searchIndex } from '../src/catalog/index.mjs'
import { validateCatalogSchema } from '../src/catalog/schema.mjs'
import { buildCatalogSections, extractSectionAnnotations, privacySections } from '../src/catalog/source.mjs'
import { run } from '../src/cli.mjs'
import { readDocument, saveAnnotatedDocument } from '../src/documents.mjs'
import { contextData, ecosystemValidationErrors } from '../src/ecosystem.mjs'
import { CUSTOM_SENSITIVITY_CATEGORIES, DEFAULT_LENSES, DEFAULT_LENS_IDS, loadLensRegistry } from '../src/lenses.mjs'
import { renameLensMetadata } from '../src/maintenance.mjs'
import { claimMarkerRewrites, formatClaimMarker, legacyClaimId, parseClaimBlocks, proposalClaimId, stripClaimMarkers, withClaimIds } from '../src/markdown/claim-blocks.mjs'
import {
  applyFrontmatterModifications,
  applyPolicyMigration,
  deprecatedFieldMappings,
  planPolicyMigration,
  revertPolicyMigration,
  verifyNonAmplification
} from '../src/migration.mjs'
import {
  PUBLICATION_ADAPTERS,
  allowedDocument,
  filterClaimStatus,
  filterClaimVisibility,
  filterFieldVisibility,
  intersectVisibility,
  privacyMetadata,
  publicationAllowed,
  visibleUnderBehavior
} from '../src/policy/access.mjs'
import { frontmatter, privacyValueValid } from '../src/policy/privacy-fields.mjs'
import {
  catalogElementVisible,
  fieldRuleTable,
  fieldHeadingRule,
  intersectRules,
  legacySubDocumentRule,
  normalizeRule,
  ruleForRegistry,
  ruleVisibility,
  subDocumentVisible
} from '../src/policy/sub-document-rules.mjs'
import { buildValidateFixPlan } from '../src/policy/validate-fix.mjs'
import { createProposal, proposalPreviewData, validateProposal } from '../src/proposals/store.mjs'
import { createRecordDelivery } from '../src/retrieval/delivery.mjs'

const CUSTOM = Object.freeze({ id: 'custom-audit', sensitivity_access: ['employer-confidential'] })
const REGISTRY = { lenses: [...DEFAULT_LENSES, CUSTOM], byId: new Map([...DEFAULT_LENSES, CUSTOM].map(lens => [lens.id, lens])) }
const LENS_IDS = [...DEFAULT_LENS_IDS, CUSTOM.id]
const ADAPTERS = ['generic', ...PUBLICATION_ADAPTERS]
const SUBJECTS = [
  { kind: 'owner:direct', accessible_spaces: ['self', 'contrib'] },
  { kind: 'client:linked', accessible_spaces: ['self', 'contrib'], effective_allowed_lenses: new Set(LENS_IDS) }
]
const RESOLUTIONS = lens => [{ sensitivity_access: REGISTRY.byId.get(lens).sensitivity_access || [] }, { sensitivity_access: [] }, { sensitivity_access: CUSTOM_SENSITIVITY_CATEGORIES }]
const KNOWN_VALUES = ['private', 'linked-projects', 'professional', 'public-voice', 'public-safe']
const UNKNOWN_VALUES = ['career', 'publishing', 'made-up']
const UUID = '11111111-1111-4111-8111-111111111111'
const MODERN = 'access_lenses: [general, professional, public-voice, private]\ndisclosure: publish-approved\nsensitivity: personal\ndocument_role: content\nread_scope: shared\n'

// A copy of the 0.11 `visibleUnderBehavior`, frozen here so the mapping is checked against the old semantics themselves.
function legacyOracle(value, lens, adapter) {
  const v = KNOWN_VALUES.includes(value) ? value : 'private'
  if (PUBLICATION_ADAPTERS.includes(adapter)) return v === 'public-safe'
  if (v === 'linked-projects' || v === 'public-safe') return true
  if (v === 'private') return lens === 'private'
  if (v === 'professional') return ['general', 'professional', 'interview', 'private'].includes(lens)
  return ['general', 'public-voice', 'private'].includes(lens)
}
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
async function tempDir(t, prefix = 'holoself-vocab-') {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}
// One document as callers receive it: `content` from the packet, the catalog paths from the --manifest view.
function fivePaths(options, rel) {
  const run = extra => {
    const cwd = process.cwd()
    if (options.root) process.chdir(options.root)
    try {
      return contextData({ task: 'mixed', budget: 'unbounded', json: true, ...options, ...(options.root ? { rootExplicit: true } : {}), ...extra })
    } finally {
      process.chdir(cwd)
    }
  }
  const doc = run({}).self.documents.find(item => item.path === rel),
    entry = run({ manifest: true }).sources.find(item => item.path === rel)
  return doc && entry ? { content: doc.content, sections: entry.sections, claims: entry.claims, tags: entry.tags, links: entry.links } : null
}
async function selfRoot(t) {
  const root = await tempDir(t)
  await quiet(() => run(['init', '--root', root]))
  return root
}
const block = (attrs, text) => `<!-- holoself-claim ${attrs} -->\n${text}\n<!-- /holoself-claim -->\n`
const sub = entries => entries.filter(Boolean).join('')

// Everything a caller receives from one document, for every lens, adapter, caller and resolution, through the runtime.
function delivered(text, registry = REGISTRY) {
  const meta = frontmatter(text, { tolerant: true, registry }).metadata,
    { body } = frontmatter(text, { tolerant: true, validatePrivacy: false, registry }),
    cells = {},
    outputs = new Map()
  const outputsFor = (lens, adapter) => {
    const key = `${lens}|${adapter}`
    if (outputs.has(key)) return outputs.get(key)
    const scratch = [],
      filtered = value =>
        filterFieldVisibility(filterClaimVisibility(value, lens, 'x', scratch, null, 'owner:direct', adapter, registry), meta, lens, 'x', scratch, null, 'owner:direct', adapter),
      policy = privacyMetadata(meta, registry),
      raw = privacySections(body, policy, registry),
      annotations = extractSectionAnnotations(raw, policy),
      visible = list => list.filter(item => catalogElementVisible(item, lens, adapter)),
      result = {
        content: stripClaimMarkers(filtered(body)).split(/\r?\n/).map(line => line.trim()).filter(Boolean),
        sections: visible(buildCatalogSections(raw)).map(section => [section.heading, filtered(section.snippet)]),
        claims: visible(annotations.claims).map(claim => claim.text),
        tags: visible(annotations.tags).map(tag => tag.value),
        links: visible(annotations.links).map(link => link.value)
      }
    outputs.set(key, result)
    return result
  }
  for (const lens of LENS_IDS)
    for (const adapter of ADAPTERS)
      for (const subject of SUBJECTS)
        RESOLUTIONS(lens).forEach((resolution, index) => {
          const allowed = allowedDocument(meta, lens, adapter, null, resolution, subject, 'self').allowed
          cells[`${lens}|${adapter}|${subject.kind}|${index}`] = allowed ? outputsFor(lens, adapter) : null
        })
  return { cells, publication: publicationAllowed(meta) }
}
function assertNoWider(before, after, label) {
  for (const [cell, value] of Object.entries(after.cells)) {
    if (value === null) continue
    assert.ok(before.cells[cell], `${label}: document denied before, allowed after at ${cell}`)
    for (const path of Object.keys(value))
      for (const item of value[path])
        assert.ok(before.cells[cell][path].some(x => JSON.stringify(x) === JSON.stringify(item)), `${label}: ${path} widened at ${cell}`)
  }
  if (after.publication) assert.ok(before.publication, `${label}: publicationAllowed widened`)
}

const enumerationBody = value =>
  '# Synthetic\n\nOpen sentence long enough to be a claim. #opentag [open](https://open.example)\n\n' +
  block(`visibility=${value}`, 'MARKER_SENTINEL claim text long enough. #markertag [m](https://marker.example)') +
  '\n## Probe Notes\n\nHEADING_SENTINEL text long enough to be a claim. #headingtag [h](https://heading.example)\n\n' +
  '## Lines\n\n- Probe Line: LINE_SENTINEL value long enough to be a claim #linetag [l](https://line.example)\n'
const enumerationDoc = (front, value) => `---\n${front}field_visibility:\n  Probe Notes: ${value}\n  Probe Line: ${value}\n---\n${enumerationBody(value)}`
const DOC_FRONTS = {
  missing: '',
  ...Object.fromEntries(KNOWN_VALUES.map(v => [`visibility ${v}`, `visibility: ${v}\n`])),
  'invalid visibility': 'visibility: career\n',
  'public_safe true': 'public_safe: true\n',
  'public_safe false': 'public_safe: false\n',
  'modern publish-approved': MODERN
}

test('section 6: every field_visibility and claim-marker value, unknown ones included, is never wider after migration, and exact rows do not narrow', async t => {
  const root = await selfRoot(t),
    docs = new Map()
  await mkdir(join(root, 'context', 'enum'), { recursive: true })
  let n = 0
  for (const [label, front] of Object.entries(DOC_FRONTS))
    for (const value of [...KNOWN_VALUES, ...UNKNOWN_VALUES]) {
      const rel = `context/enum/doc-${++n}.md`,
        text = enumerationDoc(front, value)
      docs.set(rel, { label: `${label} / ${value}`, text, value })
      await writeFile(join(root, rel), text)
    }
  assert.deepEqual(planPolicyMigration(root, { dryRun: true, registry: REGISTRY }).summary.coverage_loss, {}, 'zero coverage loss')
  const plan = planPolicyMigration(root, { dryRun: true, registry: REGISTRY, confirmActivation: true })
  let exact = 0
  for (const [rel, doc] of docs) {
    const entry = plan.entries.find(item => item.path === rel)
    assert.ok(entry?.needs_migration, `${doc.label}: planned`)
    assert.doesNotMatch(entry.after_text, /^field_visibility:|holoself-claim visibility=/m, `${doc.label}: no deprecated sub-document form left`)
    const before = delivered(doc.text),
      after = delivered(entry.after_text)
    assertNoWider(before, after, doc.label)
    // A catalog-excluded document goes through --confirm-activation and its narrower rules; every other row is exact.
    if (!entry.activated) {
      assert.deepEqual(after, before, `${doc.label}: exact row produces no narrowing`)
      exact++
    }
  }
  assert.equal(exact, 30, 'six valid document forms by five known values are exact rows')
})

test('the mapping table matches the 0.11 semantics for every value, lens and adapter, through a parsed marker', () => {
  const table = {
    private: { access_lenses: ['private'], disclosure: 'review-required' },
    'linked-projects': { disclosure: 'review-required' },
    professional: { access_lenses: ['general', 'professional', 'interview', 'private'], disclosure: 'review-required' },
    'public-voice': { access_lenses: ['general', 'public-voice', 'private'], disclosure: 'review-required' },
    'public-safe': { disclosure: 'publish-approved' }
  }
  for (const value of [...KNOWN_VALUES, ...UNKNOWN_VALUES]) {
    assert.deepEqual(legacySubDocumentRule(value), table[value] || table.private, value)
    const text = block(`visibility=${value}`, 'Probe claim wording.'),
      [rewrite] = claimMarkerRewrites(text).rewrites,
      [parsed] = parseClaimBlocks(text.replace(rewrite.before, rewrite.after))
    assert.deepEqual(parsed.rule, table[value] || table.private, `${value}: written marker`)
    for (const lens of [...LENS_IDS, 'any-other-lens'])
      for (const adapter of ADAPTERS) {
        assert.equal(subDocumentVisible(parsed.rule, lens, adapter), legacyOracle(value, lens, adapter), `${value} ${lens} ${adapter}`)
        assert.equal(visibleUnderBehavior(value, lens, adapter), legacyOracle(value, lens, adapter), `runtime ${value} ${lens} ${adapter}`)
      }
  }
})

test('rule intersection reproduces the deprecated one exactly, including the fail-closed professional and public-voice case', () => {
  const expected = (a, b) => {
    if (a === b) return a
    if (a === 'public-safe') return b
    if (b === 'public-safe') return a
    if (a === 'linked-projects') return b
    if (b === 'linked-projects') return a
    return 'private'
  }
  for (const a of KNOWN_VALUES)
    for (const b of KNOWN_VALUES) {
      assert.equal(intersectVisibility(a, b), expected(a, b), `${a} with ${b}`)
      assert.equal(ruleVisibility(intersectRules(legacySubDocumentRule(a), legacySubDocumentRule(b))), expected(a, b))
    }
})

test('a rule never inherits publish-approved, inherits access when lenses are omitted, and cannot widen the document', () => {
  assert.deepEqual(normalizeRule({}), { disclosure: 'review-required' })
  assert.deepEqual(normalizeRule({ access_lenses: ['general'] }), { access_lenses: ['general'], disclosure: 'review-required' })
  const text = `---\naccess_lenses: [general, private]\ndisclosure: publish-approved\nsensitivity: personal\ndocument_role: content\nfield_access:\n  Inherited:\n    access_lenses: [general]\n  Wide:\n    access_lenses: [technical]\n    disclosure: publish-approved\n---\n- Inherited: INHERITED_SENTINEL\n- Wide: WIDE_SENTINEL\n`,
    { metadata, body } = frontmatter(text),
    shown = (lens, adapter) => filterFieldVisibility(body, metadata, lens, 'x', [], null, 'owner:direct', adapter)
  assert.match(shown('general', 'generic'), /INHERITED_SENTINEL/)
  assert.doesNotMatch(shown('general', 'public'), /INHERITED_SENTINEL/, 'omitted disclosure is review-required even on a publish-approved document')
  assert.doesNotMatch(shown('private', 'generic'), /INHERITED_SENTINEL/, 'the lens list restricts')
  assert.equal(allowedDocument(metadata, 'technical').allowed, false, 'a rule naming technical does not open a document closed to it')
})

test('claim markers read the lens vocabulary, with omitted lenses inheriting and omitted disclosure review-required', () => {
  const [inherit, lensOnly, full] = parseClaimBlocks(
    block('disclosure=publish-approved', 'One.') + block('access_lenses=general,technical', 'Two.') + block(`access_lenses=custom-audit disclosure=review-required id=${UUID}`, 'Three.'),
    '',
    { registry: REGISTRY }
  )
  assert.deepEqual(inherit.rule, { disclosure: 'publish-approved' })
  assert.deepEqual(lensOnly.rule, { access_lenses: ['general', 'technical'], disclosure: 'review-required' })
  assert.deepEqual(full.rule, { access_lenses: ['custom-audit'], disclosure: 'review-required' })
  assert.equal(full.claim_id, UUID)
  assert.equal(formatClaimMarker(lensOnly.rule, { id: UUID }), `<!-- holoself-claim access_lenses=general,technical disclosure=review-required id=${UUID} -->`)
  assert.equal(formatClaimMarker('private', { id: UUID }), `<!-- holoself-claim visibility=private id=${UUID} -->`)
  assert.match(withClaimIds(block('visibility=professional', 'Legacy wording.'), 'x.md'), /holoself-claim visibility=professional id=/, 'a legacy marker keeps working unchanged')
  assert.match(withClaimIds(block('access_lenses=general', 'Modern wording.'), 'x.md'), /holoself-claim access_lenses=general disclosure=review-required id=/)
})

test('trap: malformed marker attributes fail closed to private and historical', () => {
  const openers = [
    'access_lenses=ghost disclosure=review-required',
    'access_lenses= disclosure=review-required',
    'access_lenses=general,,private',
    'access_lenses=general,general',
    'access_lenses=General',
    'access_lenses=general;private',
    'access_lenses="general"',
    'access_lenses=gen​eral',
    'disclosure=approved',
    'disclosure=publish-approved,review-required',
    'disclosure=publish-approved disclosure=internal-only',
    'access_lenses=general access_lenses=private',
    'access_lenses=general owner=me',
    'ACCESS_LENSES=general',
    'disclosure=publish-approved --> SMUGGLED <!-- holoself-claim visibility=private',
    `id=${UUID}`,
    ''
  ]
  for (const attrs of openers) {
    const text = `Open line.\n\n<!-- holoself-claim ${attrs} -->\nSECRET_SENTINEL claim wording.\n<!-- /holoself-claim -->\n`,
      [parsed] = parseClaimBlocks(text, '', { registry: REGISTRY })
    assert.ok(parsed.malformed, `malformed: ${attrs}`)
    assert.equal(parsed.status, 'historical', attrs)
    assert.deepEqual(parsed.rule, { access_lenses: ['private'], disclosure: 'review-required' }, attrs)
    for (const adapter of ADAPTERS)
      for (const lens of LENS_IDS.filter(id => id !== 'private'))
        assert.doesNotMatch(filterClaimVisibility(text, lens, 'x', [], null, 'owner:direct', adapter, REGISTRY), /SECRET_SENTINEL/, `${attrs} ${lens} ${adapter}`)
    assert.doesNotMatch(filterClaimStatus(text, 'current', 'x', [], 'owner:direct', REGISTRY), /SECRET_SENTINEL/, `not current: ${attrs}`)
  }
  const broken = 'Open.\n\n<!-- holoself-claim access_lenses=general>x -->\nSECRET_SENTINEL wording.\n<!-- /holoself-claim -->\n'
  assert.doesNotMatch(filterClaimVisibility(broken, 'general', 'x', []), /SECRET_SENTINEL/, 'a value that breaks the comment drops the text after it')
})

test('trap: malformed field_access fails closed: strict parsing rejects it and tolerant parsing restricts the document', () => {
  const invalid = [
    'field_access: private\n',
    'field_access: [Salary]\n',
    'field_access:\n  Salary: private\n',
    'field_access:\n  Salary:\n    access_lenses: []\n',
    'field_access:\n  Salary:\n    access_lenses: [ghost]\n',
    'field_access:\n  Salary:\n    access_lenses: [general, general]\n',
    'field_access:\n  Salary:\n    access_lenses: general\n',
    'field_access:\n  Salary:\n    disclosure: approved\n',
    'field_access:\n  Salary:\n    disclosure:\n',
    'field_access:\n  Salary:\n    owner: me\n',
    'field_access: {"__proto__": {"disclosure": "review-required"}}\n',
    'field_access: {" ": {"disclosure": "review-required"}}\n'
  ]
  for (const yaml of invalid) {
    const text = `---\n${MODERN}${yaml}---\n- Salary: SECRET_SENTINEL\n`
    assert.throws(() => frontmatter(text, { registry: REGISTRY }), /field_access|unsafe/, yaml)
    const { metadata } = frontmatter(text, { tolerant: true, registry: REGISTRY })
    assert.deepEqual(metadata.access_lenses, ['private'], yaml)
    assert.equal(metadata.sensitivity, 'restricted', yaml)
    assert.equal(allowedDocument(metadata, 'general').allowed, false, yaml)
  }
  const salvaged = frontmatter(`---\n${MODERN}field_access:\n  Salary:\n    disclosure: review-required\n\tbad: yaml\n---\nBody.\n`, { tolerant: true, registry: REGISTRY }).metadata
  assert.deepEqual(salvaged.access_lenses, ['private'], 'a document needing salvage cannot keep nested rules, so it is restricted')
  assert.equal(privacyValueValid('field_access', { Salary: { access_lenses: ['custom-audit'] } }, REGISTRY), true)
  assert.equal(privacyValueValid('field_access', { Salary: { access_lenses: ['custom-audit'] } }, { byId: new Map() }), false)
  const stored = fieldRuleTable({ field_access: { Salary: { disclosure: 'nonsense' } } })
  assert.deepEqual(stored.modern[0].rule, { access_lenses: ['private'], disclosure: 'review-required' }, 'an invalid stored entry means private')
})

test('trap: a marker carrying both vocabularies resolves to the narrower result, and migration keeps it', () => {
  const cases = [
    ['visibility=public-safe access_lenses=private disclosure=review-required', { access_lenses: ['private'], disclosure: 'review-required' }],
    ['visibility=private disclosure=publish-approved', { access_lenses: ['private'], disclosure: 'review-required' }],
    ['visibility=linked-projects disclosure=publish-approved', { disclosure: 'review-required' }],
    ['visibility=public-safe access_lenses=general', { access_lenses: ['general'], disclosure: 'review-required' }],
    ['visibility=public-safe disclosure=publish-approved', { disclosure: 'publish-approved' }],
    ['visibility=professional access_lenses=general,technical', { access_lenses: ['private'].filter(() => false), disclosure: 'review-required' }],
    ['visibility=career disclosure=publish-approved', { access_lenses: ['private'], disclosure: 'review-required' }]
  ]
  for (const [attrs, rule] of cases) {
    const text = block(attrs, 'Mixed marker wording here.'),
      [parsed] = parseClaimBlocks(text)
    assert.deepEqual(parsed.rule, rule, attrs)
    assert.equal(parsed.status, 'current', attrs)
    const { rewrites, skipped } = claimMarkerRewrites(text)
    if (rule.access_lenses?.length === 0) {
      assert.equal(rewrites.length, 0, 'no written form: left in place')
      assert.match(skipped[0].reason, /admits no lens/)
      continue
    }
    const [after] = parseClaimBlocks(text.replace(rewrites[0].before, rewrites[0].after))
    assert.deepEqual(after.rule, rule, `rewritten ${attrs}`)
    assert.equal(after.attrs.visibility, undefined, attrs)
  }
})

test('trap: field_visibility and field_access for one name resolve to the narrower, at runtime and after migration', async t => {
  const front = (legacy, modern) => `---\n${MODERN}field_visibility:\n  Salary: ${legacy}\nfield_access:\n  ${modern}---\n- Salary: SECRET_SENTINEL\n`
  const shown = (text, lens, adapter = 'generic') => {
    const { metadata, body } = frontmatter(text, { registry: REGISTRY })
    return /SECRET_SENTINEL/.test(filterFieldVisibility(body, metadata, lens, 'x', [], null, 'owner:direct', adapter))
  }
  const wideLegacy = front('public-safe', 'Salary:\n    access_lenses: [private]\n')
  assert.equal(shown(wideLegacy, 'general'), false, 'field_access narrows a wide field_visibility')
  assert.equal(shown(wideLegacy, 'private', 'public'), false, 'omitted disclosure beats public-safe')
  const wideModern = front('private', 'Salary:\n    disclosure: publish-approved\n')
  assert.equal(shown(wideModern, 'general'), false, 'field_visibility narrows a wide field_access')
  assert.equal(shown(wideModern, 'private', 'public'), false)
  const otherCase = front('public-safe', 'SALARY:\n    access_lenses: [private]\n')
  assert.equal(shown(otherCase, 'general'), false, 'names compare case-insensitively across both fields')

  const root = await selfRoot(t)
  await writeFile(join(root, 'context', 'wide.md'), wideLegacy)
  await writeFile(join(root, 'context', 'other.md'), wideModern)
  await writeFile(join(root, 'context', 'case.md'), otherCase)
  const plan = planPolicyMigration(root, { dryRun: true, registry: REGISTRY })
  assert.deepEqual(plan.summary.coverage_loss, {})
  for (const rel of ['context/wide.md', 'context/other.md', 'context/case.md']) {
    const entry = plan.entries.find(item => item.path === rel)
    assert.deepEqual(delivered(entry.after_text), delivered(entry.before_text), rel)
    assert.doesNotMatch(entry.after_text, /^field_visibility:/m)
  }
  assert.deepEqual(plan.entries.find(item => item.path === 'context/wide.md').changes.field_access, { Salary: { access_lenses: ['private'], disclosure: 'review-required' } })
})

test('several field_access rules on one heading all apply, whichever comes first', () => {
  const table = fieldRuleTable({ field_access: { history: { disclosure: 'publish-approved' }, salary: { access_lenses: ['private'] } } }),
    match = fieldHeadingRule('Salary history', table)
  assert.deepEqual(match.rule, { access_lenses: ['private'], disclosure: 'review-required' })
})

test('trap: the rewrite uses the runtime parser: fenced blocks the runtime enforces are rewritten, text it does not read as a block is not', async t => {
  const fenced = '```md\n' + block('visibility=private', 'FENCED_SENTINEL wording here.') + '```\n'
  assert.doesNotMatch(filterClaimVisibility(fenced, 'general', 'x', []), /FENCED_SENTINEL/, 'the runtime enforces a complete block inside a fence')
  const strayOpener = 'Tail text.\n\n```md\n<!-- holoself-claim visibility=private -->\n```\n'
  const strayCloser = 'An example closer: <!-- /holoself-claim -->\n'
  const inline = 'Written about in prose: holoself-claim visibility=private is the old form.\n'
  const malformed = block('visibility=private owner=me', 'MALFORMED_SENTINEL wording here.')
  const root = await selfRoot(t)
  const body = `# Doc\n\n${fenced}\n${inline}\n${malformed}\n${strayCloser}\n${strayOpener}`
  const text = `---\n${MODERN}note: "<!-- holoself-claim visibility=private -->x<!-- /holoself-claim -->"\n---\n${body}`
  await writeFile(join(root, 'context', 'fence.md'), text)
  const plan = planPolicyMigration(root, { dryRun: true }),
    entry = plan.entries.find(item => item.path === 'context/fence.md')
  assert.equal(entry.changes.claim_markers.length, 1, 'only the complete, well-formed block')
  assert.match(entry.after_text, /```md\n<!-- holoself-claim access_lenses=private disclosure=review-required -->\nFENCED_SENTINEL/)
  assert.ok(entry.after_text.includes(`note: "<!-- holoself-claim visibility=private -->x<!-- /holoself-claim -->"`), 'frontmatter strings are not markers')
  for (const untouched of [inline, malformed, strayCloser, strayOpener]) assert.ok(entry.after_text.includes(untouched), untouched)
  assert.ok(plan.warnings.some(warning => warning.includes('context/fence.md') && warning.includes('malformed')), 'the malformed block is reported')
  assert.deepEqual(delivered(entry.after_text, null).cells, delivered(text, null).cells)
})

const EOL_CASES = {
  'CRLF, no trailing newline': {
    before: `---\r\n${MODERN.replaceAll('\n', '\r\n')}field_visibility:\r\n  Salary: private\r\ncustom_key: kept\r\n---\r\n# T\r\n\r\n<!--  holoself-claim   id=${UUID}\tvisibility=public-safe  -->\r\nClaim text stays here.\r\n<!-- /holoself-claim -->\r\nTail without newline`,
    after: `---\r\n${MODERN.replaceAll('\n', '\r\n')}field_access:\r\n  Salary:\r\n    access_lenses: [private]\r\n    disclosure: review-required\r\ncustom_key: kept\r\n---\r\n# T\r\n\r\n<!--  holoself-claim   id=${UUID}\tdisclosure=publish-approved  -->\r\nClaim text stays here.\r\n<!-- /holoself-claim -->\r\nTail without newline`
  },
  'LF frontmatter, CRLF body with a rule': {
    before: `---\n${MODERN}field_visibility:\n  Salary: professional\n---\r\n# T\r\n\r\n---\r\n\r\n${block('visibility=linked-projects', 'Claim wording stays.').replaceAll('\n', '\r\n')}`,
    after: `---\n${MODERN}field_access:\n  Salary:\n    access_lenses: [general, professional, interview, private]\n    disclosure: review-required\n---\r\n# T\r\n\r\n---\r\n\r\n${block('disclosure=review-required', 'Claim wording stays.').replaceAll('\n', '\r\n')}`
  },
  'mixed line endings inside frontmatter': {
    before: `---\r\n${MODERN}custom_a: one\r\ncustom_b: two\nfield_visibility:\r\n  Salary: public-safe\r\n\r\n  Bonus: private\r\ncustom_c: three\n---\nNo trailing newline`,
    after: `---\r\n${MODERN}custom_a: one\r\ncustom_b: two\nfield_access:\r\n  Salary:\r\n    disclosure: publish-approved\r\n  Bonus:\r\n    access_lenses: [private]\r\n    disclosure: review-required\r\ncustom_c: three\n---\nNo trailing newline`
  },
  'no frontmatter': {
    before: `# Notes\r\n\r\n${block('visibility=public-voice', 'Marker in a plain file.')}`,
    after: `# Notes\r\n\r\n${block('access_lenses=general,public-voice,private disclosure=review-required', 'Marker in a plain file.')}`
  }
}
for (const [label, { before, after }] of Object.entries(EOL_CASES))
  test(`trap: ${label}: only the targeted bytes change, and revert is byte-identical`, async t => {
    const root = await selfRoot(t),
      path = join(root, 'context', 'eol.md')
    await writeFile(path, before)
    const plan = planPolicyMigration(root),
      entry = plan.entries.find(item => item.path === 'context/eol.md')
    assert.deepEqual(plan.summary.coverage_loss, {})
    assert.equal(entry.after_text, after)
    const receipt = applyPolicyMigration(root, plan.plan_id)
    assert.ok(Buffer.from(after).equals(await readFile(path)), 'applied bytes')
    assert.equal(revertPolicyMigration(root, receipt.receipt_id).status, 'reverted')
    assert.ok(Buffer.from(before).equals(await readFile(path)), 'reverted bytes')
  })

test('a plan binds its marker rewrites: digest, receipts and a concurrent edit behave as for frontmatter', async t => {
  const root = await selfRoot(t),
    path = join(root, 'context', 'bound.md'),
    text = `---\n${MODERN}---\n${block('visibility=private', 'Bound claim wording.')}`
  await writeFile(path, text)
  const plan = planPolicyMigration(root),
    tampered = JSON.parse(JSON.stringify(plan)),
    entry = tampered.entries.find(item => item.path === 'context/bound.md')
  entry.changes.claim_markers[0].after = '<!-- holoself-claim disclosure=publish-approved -->'
  assert.throws(() => applyPolicyMigration(root, tampered), /digest mismatch/)
  await writeFile(path, text + 'Edited.\n')
  assert.throws(() => applyPolicyMigration(root, plan.plan_id), /TOCTOU/)
  assert.equal(await readFile(path, 'utf8'), text + 'Edited.\n')
})

test('section 6: apply then revert restores byte-identical files for fixtures carrying every deprecated field', async t => {
  const root = await selfRoot(t),
    files = {}
  await mkdir(join(root, 'topics', 'deep'), { recursive: true })
  KNOWN_VALUES.forEach((value, i) => {
    files[`context/all-${i}.md`] = enumerationDoc(`visibility: ${value}\n${value === 'public-safe' ? '' : 'public_safe: true\n'}`, value)
    files[`topics/deep/crlf-${i}.md`] = enumerationDoc(`visibility: ${value}\n`, value).replaceAll('\n', '\r\n')
  })
  for (const [rel, text] of Object.entries(files)) await writeFile(join(root, rel), text)
  const plan = planPolicyMigration(root)
  assert.deepEqual(plan.summary.coverage_loss, {})
  const receipt = applyPolicyMigration(root, plan.plan_id)
  for (const rel of Object.keys(files)) {
    const migrated = await readFile(join(root, rel), 'utf8')
    assert.doesNotMatch(migrated, /^(?:visibility|public_safe|field_visibility):|holoself-claim visibility=/m, rel)
  }
  assert.deepEqual(ecosystemValidationErrors(root), [])
  revertPolicyMigration(root, receipt.receipt_id)
  for (const [rel, text] of Object.entries(files)) assert.ok(Buffer.from(text).equals(await readFile(join(root, rel))), rel)
})

test('trap: claim identity survives the rewrite for legacy and explicit ids, and the marker is not part of it', async t => {
  const wording = 'Identity probe wording for the claim.',
    rel = 'context/identity.md',
    root = await selfRoot(t),
    text = `---\n${MODERN}---\n${block('visibility=professional', wording)}\n${block(`id=${UUID} visibility=private status=superseded superseded_by=22222222-2222-4222-8222-222222222222`, 'Explicit id wording.')}`
  await writeFile(join(root, rel), text)
  const entry = planPolicyMigration(root, { dryRun: true }).entries.find(item => item.path === rel),
    ids = source => parseClaimBlocks(frontmatter(source).body, rel).map(item => [item.claim_id, item.status, item.text, item.legacy])
  assert.deepEqual(ids(entry.after_text), ids(text))
  assert.equal(ids(entry.after_text)[0][0], legacyClaimId(rel, wording))
  assert.equal(ids(entry.after_text)[1][0], UUID)
  assert.deepEqual(entry.changes.claim_markers.map(item => item.claim_id), [legacyClaimId(rel, wording), UUID])
})

async function claimsFixture(t) {
  const self = await selfRoot(t),
    project = await tempDir(t, 'holoself-vocab-project-'),
    text = wording => `## Approved proposal legacy/x\n\n${wording}\n\n- Evidence: synthetic notes\n- Confidence: confirmed\n- Visibility: professional\n- Provenance: synthetic:notes.md\n- Approved: 2026-01-01T00:00:00.000Z`,
    wordings = ['Replace target wording for the claim.', 'Supersede target wording for the claim.', 'Retire target wording for the claim.']
  await writeFile(join(self, 'context', 'claims.md'), `---\n${MODERN}---\n# Claims\n\n${wordings.map(wording => block('visibility=professional', text(wording))).join('\n')}`)
  await mkdir(join(project, 'Context'), { recursive: true })
  await writeFile(join(project, 'Context', 'evidence.md'), '# Evidence\n\nSynthetic evidence.\n')
  await quiet(() => run(['link', 'add', '--project', project, '--self', self, '--lens', 'professional', '--no-activate', '--yes']))
  return { self, project, claims: join(self, 'context', 'claims.md'), ids: wordings.map(wording => legacyClaimId('context/claims.md', wording)) }
}

test('trap: pending replace, supersede and retire proposals still resolve after migration', async t => {
  const { self, project, claims, ids } = await claimsFixture(t),
    propose = async args => JSON.parse(await quiet(() => run(['propose', '--project', project, '--source-file', 'Context/evidence.md', '--evidence', 'Synthetic notes.', ...args]))),
    replace = await propose(['--op', 'replace', '--claim-id', ids[0], '--claim', 'Replacement wording for the first claim.']),
    supersede = await propose(['--op', 'supersede', '--claim-id', ids[1], '--claim', 'Superseding wording for the second claim.']),
    retire = await propose(['--op', 'retire', '--claim-id', ids[2], '--reason', 'No longer accurate.'])
  const plan = planPolicyMigration(self)
  assert.equal(plan.entries.find(item => item.path === 'context/claims.md').changes.claim_markers.length, 3)
  applyPolicyMigration(self, plan.plan_id)
  for (const made of [replace, supersede, retire]) {
    const preview = proposalPreviewData(project, made.proposal_id)
    await quiet(() => run(['proposals', 'approve', made.proposal_id, '--project', project, '--preview-hash', preview.preview_hash, '--yes']))
  }
  const after = await readFile(claims, 'utf8'),
    blocks = parseClaimBlocks(after, 'context/claims.md'),
    byId = id => blocks.find(item => item.claim_id === id)
  assert.equal(byId(ids[0]).status, 'current')
  assert.match(byId(ids[0]).text, /Replacement wording/)
  assert.equal(byId(ids[1]).status, 'superseded')
  assert.equal(byId(ids[2]).status, 'historical')
  assert.equal(byId(proposalClaimId(supersede.proposal_id, 'claim')).attrs.supersedes, ids[1])
  assert.doesNotMatch(after, /holoself-claim [^>]*visibility=/, 'nothing writes the deprecated marker')
  assert.deepEqual(byId(ids[0]).rule, legacySubDocumentRule('professional'), 'an operation without visibility keeps the rule')
  assert.deepEqual(ecosystemValidationErrors(self), [])
})

test('approved proposals write the lens vocabulary and keep a custom rule; archived records with old values stay readable', async t => {
  const { self, project, claims, ids } = await claimsFixture(t)
  const propose = async args => JSON.parse(await quiet(() => run(['propose', '--project', project, '--source-file', 'Context/evidence.md', '--evidence', 'Synthetic notes.', ...args])))
  const approve = async id => {
    const preview = proposalPreviewData(project, id)
    await quiet(() => run(['proposals', 'approve', id, '--project', project, '--preview-hash', preview.preview_hash, '--yes']))
    return preview
  }
  const expected = {
    private: 'access_lenses=private disclosure=review-required',
    'linked-projects': 'disclosure=review-required',
    'public-voice': 'access_lenses=general,public-voice,private disclosure=review-required',
    'public-safe': 'disclosure=publish-approved'
  }
  for (const [visibility, attrs] of Object.entries(expected)) {
    const made = await propose(['--claim', `Appended claim wording for ${visibility} marker.`, '--visibility', visibility])
    await approve(made.proposal_id)
    assert.ok((await readFile(claims, 'utf8')).includes(`<!-- holoself-claim ${attrs} id=${proposalClaimId(made.proposal_id, 'claim')} -->`), visibility)
  }
  const text = await readFile(claims, 'utf8')
  await writeFile(claims, text.replace('visibility=professional', 'access_lenses=general,technical disclosure=review-required'))
  const replaced = await propose(['--op', 'replace', '--claim-id', ids[0], '--claim', 'New wording under a rule with no old name.'])
  const preview = await approve(replaced.proposal_id)
  assert.equal(preview.changes[0].visibility_change, null)
  assert.deepEqual(parseClaimBlocks(await readFile(claims, 'utf8'), 'context/claims.md').find(item => item.claim_id === ids[0]).rule, { access_lenses: ['general', 'technical'], disclosure: 'review-required' })

  const widened = await propose(['--op', 'replace', '--claim-id', ids[1], '--claim', 'New wording with a stated visibility.', '--visibility', 'private'])
  assert.deepEqual(proposalPreviewData(project, widened.proposal_id).changes[0].visibility_change, { from: 'professional', to: 'private' })

  const archived = createProposal(project, { claim: 'Archived record wording for the old lens.', visibility: 'private', source_files: ['Context/evidence.md'] })
  for (const change of archived.changes || []) change.visibility = 'career'
  archived.status = 'approved'
  archived.visibility = 'career'
  assert.deepEqual(validateProposal(archived), [], 'an archived record may keep a retired visibility value')
})

test('trap: custom lenses and registries: the mapping never widens and never writes an unknown lens', async t => {
  for (const value of ['professional', 'public-voice', 'private']) {
    assert.equal(subDocumentVisible(legacySubDocumentRule(value), CUSTOM.id), false, value)
    assert.equal(visibleUnderBehavior(value, CUSTOM.id), false, value)
  }
  const small = { byId: new Map([['general', {}], ['private', {}], ['custom-audit', {}]]) }
  assert.deepEqual(ruleForRegistry(legacySubDocumentRule('professional'), small).access_lenses, ['general', 'private'])
  assert.equal(ruleForRegistry({ access_lenses: ['interview'], disclosure: 'review-required' }, small), null)
  const text = block('visibility=professional', 'Registry probe wording.'),
    [rewrite] = claimMarkerRewrites(text, { registry: small }).rewrites,
    [parsed] = parseClaimBlocks(text.replace(rewrite.before, rewrite.after), '', { registry: small })
  assert.equal(parsed.malformed, false, 'a registry without a seeded lens still gets a valid marker')
  assert.equal(parsed.status, 'current')
  assert.deepEqual(parsed.rule.access_lenses, ['general', 'private'])
  const root = await selfRoot(t)
  await writeFile(join(root, 'context', 'custom.md'), `---\n${MODERN}---\n${block('access_lenses=ghost-lens', 'Unknown lens wording.')}`)
  assert.ok(ecosystemValidationErrors(root).some(error => error.includes('ghost-lens')), 'validate reports a marker naming an unknown lens')
})

test('trap: _policy.yaml defaults do not widen migrated sub-document rules, and cannot carry them', async t => {
  const root = await selfRoot(t),
    dir = join(root, 'context', 'shared')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, '_policy.yaml'), 'disclosure: publish-approved\ndocument_role: policy\nsensitivity: public\naccess_lenses: [general, professional, public-voice, private]\n')
  const docs = {
    'context/shared/legacy-doc.md': `---\nvisibility: professional\nfield_visibility:\n  Salary: linked-projects\n---\n- Salary: SECRET_SENTINEL\n\n${block('visibility=linked-projects', 'Inherited marker wording here.')}`,
    'context/shared/field-only.md': `---\nfield_visibility:\n  Salary: professional\n---\nOrdinary sentence that follows the document.\n\n- Salary: SECRET_SENTINEL\n\n${block('visibility=public-voice', 'Field only marker wording.')}`
  }
  for (const [rel, text] of Object.entries(docs)) await writeFile(join(root, rel), text)
  const snapshot = async adapter =>
    Object.fromEntries(
      Object.keys(docs).map(rel => {
        const paths = fivePaths({ lens: 'general', adapter, task: 'marker wording', root }, rel)
        return [rel, paths && { ...paths, content: stripClaimMarkers(paths.content) }]
      })
    )
  const before = {}
  for (const adapter of ADAPTERS) before[adapter] = await snapshot(adapter)
  const plan = planPolicyMigration(root)
  assert.deepEqual(plan.summary.coverage_loss, {})
  applyPolicyMigration(root, plan.plan_id)
  for (const adapter of ADAPTERS) assert.deepEqual(await snapshot(adapter), before[adapter], adapter)
  assert.ok(before.public['context/shared/field-only.md'], 'the default makes this document publishable')
  assert.doesNotMatch(JSON.stringify(before.public), /SECRET_SENTINEL|marker wording/i, 'a publish-approved directory default never publishes a rule without its own approval')
  await writeFile(join(dir, '_policy.yaml'), 'field_access:\n  Salary:\n    disclosure: publish-approved\n')
  assert.ok(ecosystemValidationErrors(root).some(error => /_policy\.yaml/.test(error)), '_policy.yaml rejects sub-document rules')
})

test('verifyNonAmplification evaluates sub-document rules through the runtime: it rejects widening and reports narrowing', () => {
  const doc = (front, marker) => `---\n${MODERN}${front}---\n- Salary: FIELD_SENTINEL value long enough\n\n${block(marker, 'MARKER_SENTINEL wording long enough.')}`,
    base = doc('field_visibility:\n  Salary: private\n', 'visibility=private'),
    check = after => verifyNonAmplification(base, after, { registry: REGISTRY })
  assert.equal(check(doc('field_access:\n  Salary:\n    access_lenses: [private]\n    disclosure: review-required\n', 'access_lenses=private disclosure=review-required')).valid, true)
  const widenMarker = check(doc('field_visibility:\n  Salary: private\n', 'access_lenses=general,private disclosure=review-required'))
  assert.equal(widenMarker.valid, false)
  assert.match(widenMarker.violation, /Sub-document content cell \(general, generic\)/)
  assert.doesNotMatch(widenMarker.violation, /SENTINEL/, 'a violation never quotes document text')
  assert.equal(check(doc('field_access:\n  Salary:\n    disclosure: review-required\n', 'visibility=private')).valid, false, 'field rule widened to every lens')
  assert.equal(check(doc('field_visibility:\n  Salary: private\n', 'disclosure=publish-approved')).valid, false, 'marker widened to publication')
  assert.equal(check(doc('', 'visibility=private')).valid, false, 'dropping the rule widens')

  const open = doc('field_visibility:\n  Salary: public-safe\n', 'visibility=public-safe'),
    narrowed = verifyNonAmplification(open, doc('field_visibility:\n  Salary: public-safe\n', 'access_lenses=general disclosure=publish-approved'), { registry: REGISTRY })
  assert.equal(narrowed.valid, true)
  assert.ok(narrowed.coverageLoss.technical > 0, 'a narrowing is coverage loss')
  assert.ok(narrowed.coverageLoss[CUSTOM.id] > 0, 'custom lenses are covered')
  assert.equal(verifyNonAmplification(open, open.replace('MARKER_SENTINEL', 'MARKER_SENTINEL'), {}).valid, true)
})

test('a deprecated first-match rule shadowed by name is dropped exactly, and a heading overlap is reported as narrowing', async t => {
  const root = await selfRoot(t),
    shadowed = `---\n${MODERN}field_visibility:\n  Salary: public-safe\n  salary: private\n---\n- Salary: VISIBLE_SENTINEL value\n`
  await writeFile(join(root, 'context', 'shadow.md'), shadowed)
  const first = planPolicyMigration(root, { dryRun: true, registry: REGISTRY }),
    entry = first.entries.find(item => item.path === 'context/shadow.md')
  assert.deepEqual(entry.changes.field_access, { Salary: { disclosure: 'publish-approved' } })
  assert.deepEqual(first.summary.coverage_loss, {})
  await writeFile(join(root, 'context', 'overlap.md'), `---\n${MODERN}field_visibility:\n  Salary: public-safe\n  Salary band: private\n---\n## Salary band\n\nOVERLAP_SENTINEL section text.\n`)
  const plan = planPolicyMigration(root, { registry: REGISTRY })
  assert.ok(Object.keys(plan.summary.coverage_loss).length > 0, 'field_access applies both rules, narrower than first-match')
  assert.throws(() => applyPolicyMigration(root, plan.plan_id), /--confirm-narrowing/)
})

test('a rule that cannot be written stays in place with a warning instead of being lost', async t => {
  const root = await selfRoot(t)
  await writeFile(join(root, 'context', 'bad.md'), `---\n${MODERN}field_visibility:\n  Salary: private\nfield_access:\n  Salary:\n    disclosure: nonsense\n---\n- Salary: SECRET_SENTINEL\n`)
  const plan = planPolicyMigration(root, { dryRun: true, confirmActivation: true }),
    entry = plan.entries.find(item => item.path === 'context/bad.md')
  assert.match(entry.after_text, /^field_visibility:\n {2}Salary: private$/m)
  assert.ok(plan.warnings.some(warning => warning.includes('context/bad.md') && warning.includes('field_access')))
})

test('field names needing quoting survive the rewrite and parse back to the same rule', () => {
  const fieldAccess = { 'Pay: base #1': { access_lenses: ['private'], disclosure: 'review-required' } },
    after = applyFrontmatterModifications(`---\n${MODERN}---\nBody.\n`, { field_access: fieldAccess })
  assert.deepEqual({ ...frontmatter(after).metadata.field_access }, fieldAccess)
})

const VALUE_NAMES = { approved: 'Approved Notes', review: 'Review Notes', lens: 'Lens Notes', other: 'Technical Notes' }
const PATH_RULES = {
  approved: { attrs: 'disclosure=publish-approved', field: '    disclosure: publish-approved\n', shows: true },
  review: { attrs: 'disclosure=review-required', field: '    disclosure: review-required\n', shows: false },
  lens: { attrs: 'access_lenses=general,private', field: '    access_lenses: [general, private]\n', shows: false },
  other: { attrs: 'access_lenses=technical disclosure=publish-approved', field: '    access_lenses: [technical]\n    disclosure: publish-approved\n', shows: false }
}
const sentinel = (kind, key) => `${kind}${key}sentinel`
const pathDoc = () => {
  const fieldAccess = Object.keys(PATH_RULES).map(key => `  ${VALUE_NAMES[key]}:\n${PATH_RULES[key].field}  ${key} line:\n${PATH_RULES[key].field}`).join('')
  const line = (kind, key) => `${sentinel(kind, key)} text long enough to be a claim. #${sentinel(kind, key)}tag [x](https://${sentinel(kind, key)}.example)`
  return (
    `---\n${MODERN}field_access:\n${fieldAccess}---\n# Mixed\n\nOpen sentence long enough to be a claim. #opentag [open](https://open.example)\n\n` +
    Object.keys(PATH_RULES).map(key => block(PATH_RULES[key].attrs, line('claim', key))).join('\n') +
    '\n' +
    Object.keys(PATH_RULES).map(key => `## ${VALUE_NAMES[key]}\n\n${line('heading', key)}\n`).join('\n') +
    '\n## Lines\n\n' +
    Object.keys(PATH_RULES).map(key => `- ${key} line: ${line('line', key)}`).join('\n') +
    '\n'
  )
}
function assertPaths(doc, adapter, label) {
  const paths = { content: doc.content, sections: JSON.stringify(doc.sections), claims: JSON.stringify(doc.claims), tags: JSON.stringify(doc.tags), links: JSON.stringify(doc.links) }
  for (const [path, text] of Object.entries(paths))
    for (const key of Object.keys(PATH_RULES))
      for (const kind of ['claim', 'heading', 'line']) {
        const found = text.includes(sentinel(kind, key))
        if (!PATH_RULES[key].shows) assert.equal(found, false, `${label} ${adapter} ${path}: ${kind} ${key} hidden`)
        else if (path === 'content') assert.equal(found, true, `${label} ${adapter} content: ${kind} ${key} delivered`)
      }
  for (const key of ['claim', 'heading', 'line'])
    assert.ok(JSON.stringify([doc.claims, doc.tags, doc.links]).includes(sentinel(key, 'approved')), `${label} ${adapter}: approved ${key} reaches the catalog paths`)
  for (const section of doc.sections)
    for (const line of section.snippet.replace(/\.\.\.$/, '').split('\n').filter(x => x.trim())) assert.ok(doc.content.includes(line.trim()), `${label} ${adapter}: sections text is a subset of content`)
}

test('section 6: on every publication adapter content, sections, claims, tags and links apply one rule, and sections are a subset of content', async t => {
  const root = await selfRoot(t),
    project = await tempDir(t, 'holoself-vocab-project-')
  await quiet(() => run(['link', 'add', '--self', root, '--project', project, '--lens', 'general', '--yes', '--no-activate']))
  await writeFile(join(root, 'context', 'paths.md'), pathDoc())
  for (const adapter of PUBLICATION_ADAPTERS) {
    assertPaths(fivePaths({ lens: 'general', adapter, project }, 'context/paths.md'), adapter, 'linked')
    assertPaths(fivePaths({ lens: 'general', adapter, root }, 'context/paths.md'), adapter, 'owner')
    const passages = searchIndex(buildIndex(project), 'sentinel text', 'general', null, null, 'current', { adapter })
    for (const key of Object.keys(PATH_RULES).filter(name => !PATH_RULES[name].shows))
      assert.doesNotMatch(JSON.stringify(passages), new RegExp(`(?:claim|heading|line)${key}sentinel`), `search ${adapter} ${key}`)
  }
  const generic = contextData({ lens: 'general', adapter: 'generic', task: 'mixed', budget: 'unbounded', json: true, project }).self.documents.find(doc => doc.path === 'context/paths.md')
  for (const key of ['approved', 'review', 'lens']) assert.ok(generic.content.includes(sentinel('claim', key)), `generic adapter keeps ${key}`)
  assert.ok(!generic.content.includes(sentinel('claim', 'other')), 'a lens outside the rule is hidden on generic too')
})

test('the delivery reconcile path applies the same rule to all five outputs', async t => {
  const root = await selfRoot(t),
    path = join(root, 'context', 'paths.md'),
    registry = loadLensRegistry(root)
  await writeFile(path, pathDoc())
  for (const adapter of PUBLICATION_ADAPTERS) {
    const { deliverRecord } = createRecordDelivery(
      { temporal: 'current', task: null },
      { project: root, self: root, identity: { kind: 'owner:direct' }, registry, lens: 'general', resolution: { sensitivity_access: [] }, subject: null, adapter }
    )
    const result = deliverRecord({ absolute_path: path, path: 'context/paths.md', kind: 'self', source_ref: { revision: 'stale' }, sections: [], claims: [], tags: [], links: [] })
    assert.ok(result, adapter)
    assertPaths(result, adapter, 'reconciled')
  }
})

test('the catalog stores a rule with no deprecated name and validates against the schema', async t => {
  const root = await selfRoot(t),
    project = await tempDir(t, 'holoself-vocab-project-')
  await quiet(() => run(['link', 'add', '--self', root, '--project', project, '--lens', 'general', '--yes', '--no-activate']))
  await writeFile(join(root, 'context', 'paths.md'), pathDoc())
  contextData({ lens: 'general', adapter: 'generic', task: 'mixed', budget: 'unbounded', json: true, project })
  const catalog = JSON.parse(await readFile(join(root, '.holoself', 'catalog', 'catalog.json'), 'utf8')),
    source = catalog.sources.find(item => item.file === 'context/paths.md')
  assert.deepEqual(validateCatalogSchema(catalog).errors, [])
  assert.equal(catalog.schema_version, 4)
  assert.deepEqual(source.frontmatter.field_access['Approved Notes'], { disclosure: 'publish-approved' })
  assert.deepEqual(source.frontmatter.field_access['Lens Notes'], { access_lenses: ['general', 'private'], disclosure: 'review-required' })
  const withRule = source.sections.find(section => section.heading === 'Technical Notes')
  assert.deepEqual(withRule.access_rule, { access_lenses: ['technical'], disclosure: 'publish-approved' })
  assert.equal(withRule.visibility, 'private', 'the deprecated label takes the narrowest name')
  assert.equal(catalogElementVisible(withRule, 'technical', 'public'), true)
  assert.equal(catalogElementVisible(withRule, 'general', 'public'), false)
  assert.equal(source.sections.find(section => section.heading === 'Approved Notes').access_rule, undefined, 'an exact name needs no rule')
  const broken = JSON.parse(JSON.stringify(catalog))
  broken.sources.find(item => item.file === 'context/paths.md').sections.find(section => section.heading === 'Technical Notes').access_rule = { disclosure: 'nonsense' }
  assert.ok(validateCatalogSchema(broken).errors.some(error => error.includes('access_rule')))
  assert.equal(catalogElementVisible({ visibility: 'public-safe', access_rule: { disclosure: 'nonsense' } }, 'general', 'public'), false, 'an invalid stored rule fails closed')
  assert.equal(catalogElementVisible({ visibility: 'nonsense' }, 'general'), false)
})

test('rules with no shared lens hide an element from every lens, and the catalog stores that without widening it', async t => {
  const root = await selfRoot(t),
    project = await tempDir(t, 'holoself-vocab-project-')
  await quiet(() => run(['link', 'add', '--self', root, '--project', project, '--lens', 'general', '--yes', '--no-activate']))
  await writeFile(
    join(root, 'context', 'disjoint.md'),
    `---\n${MODERN}field_access:\n  Notes:\n    access_lenses: [general]\n  Pay Notes:\n    access_lenses: [technical]\n---\n## Pay Notes\n\nDISJOINT_SENTINEL text long enough to be a claim.\n`
  )
  contextData({ lens: 'general', adapter: 'generic', task: 'x', budget: 'unbounded', json: true, project })
  const catalog = JSON.parse(await readFile(join(root, '.holoself', 'catalog', 'catalog.json'), 'utf8')),
    section = catalog.sources.find(item => item.file === 'context/disjoint.md').sections[0]
  assert.deepEqual(section.access_rule.access_lenses, [])
  assert.deepEqual(validateCatalogSchema(catalog).errors, [])
  for (const lens of LENS_IDS) assert.equal(catalogElementVisible(section, lens), false, lens)
})

test('schemas and the annotation schema accept the new fields', async () => {
  const metadata = JSON.parse(await readFile(new URL('../schemas/document-metadata.schema.json', import.meta.url), 'utf8')),
    catalog = JSON.parse(await readFile(new URL('../schemas/catalog.schema.json', import.meta.url), 'utf8'))
  assert.deepEqual(Object.keys(metadata.properties.field_access.additionalProperties.properties), ['access_lenses', 'disclosure'])
  assert.equal(catalog.properties.schema_version.const, 4)
  assert.ok(catalog.$defs.access_rule)
  assert.equal(annotationSchema([]).fields.field_access.type, 'field-rules')
  const base = { access_lenses: ['general'], disclosure: 'internal-only', sensitivity: 'personal', document_role: 'content' }
  assert.equal(validateAnnotationMetadata({ ...base, field_access: { Salary: { access_lenses: ['private'], disclosure: 'review-required' } } }, ['general', 'private']).valid, true)
  for (const field_access of ['private', { Salary: 'private' }, { Salary: { owner: 'me' } }, { Salary: { access_lenses: [] } }, { Salary: { disclosure: 'x' } } ])
    assert.equal(validateAnnotationMetadata({ ...base, field_access }, ['general']).valid, false, JSON.stringify(field_access))
})

test('Workbench saves preserve nested field_access', async t => {
  const root = await selfRoot(t),
    rel = 'context/rules.md',
    rules = 'field_access:\n  Salary:\n    access_lenses: [private]\n    disclosure: review-required\n'
  await writeFile(join(root, rel), `---\nschema_version: 1\n${MODERN}${rules}---\n# Rules\n`)
  const doc = readDocument(root, rel)
  await saveAnnotatedDocument(root, rel, { metadata: { ...doc.annotations.metadata, confidence: 'mixed' }, segments: doc.annotations.segments, expectedHash: doc.hash })
  assert.ok((await readFile(join(root, rel), 'utf8')).includes(rules))
})

test('validate --fix prints the exact mapping per file and hands off, without editing or changing its plan', async t => {
  const root = await selfRoot(t),
    legacy = `---\nvisibility: professional\npublic_safe: false\nfield_visibility:\n  Salary: private\n---\n${block('visibility=public-safe', 'Report marker wording.')}`,
    missing = '---\naccess_lenses: [general]\n---\n# Missing fields\n'
  await writeFile(join(root, 'context', 'legacy.md'), legacy)
  await writeFile(join(root, 'context', 'missing.md'), missing)
  const digest = buildValidateFixPlan(root, { cachePlan: false }).digest,
    out = await quiet(() => run(['validate', '--fix', '--root', root]))
  assert.match(out, /File: context\/legacy\.md\n/)
  assert.match(out, /- visibility, public_safe: visibility: professional, public_safe: false -> access_lenses: \[general, professional, interview, private\], disclosure: review-required, sensitivity: personal, document_role: content, read_scope: shared/)
  assert.match(out, /- field_visibility\.Salary: private -> field_access\.Salary: \{ access_lenses: \[private\], disclosure: review-required \}/)
  assert.ok(out.includes('<!-- holoself-claim visibility=public-safe --> -> <!-- holoself-claim disclosure=publish-approved -->'))
  assert.match(out, /Next: holoself migrate policy --dry-run/)
  assert.equal(await readFile(join(root, 'context', 'legacy.md'), 'utf8'), legacy, 'never edits')
  const json = JSON.parse(await quiet(() => run(['validate', '--fix', '--json', '--root', root])))
  assert.equal(json.digest, digest, 'the report stays outside the plan digest')
  assert.equal(json.deprecated_fields.handoff, 'holoself migrate policy --dry-run')
  assert.equal(json.deprecated_fields.files.find(file => file.path === 'context/legacy.md').mappings.length, 3)
  assert.ok(json.files.some(file => file.path === 'context/missing.md'), 'the missing-metadata repair is unchanged')
  assert.ok(!json.operations.some(operation => operation.path === 'context/legacy.md'), 'no repair operation touches the deprecated fields')
  const clean = await selfRoot(t)
  assert.deepEqual(deprecatedFieldMappings(clean).files, [])
  assert.doesNotMatch(await quiet(() => run(['validate', '--fix', '--root', clean])), /Deprecated privacy fields/)
})

test('validate --fix leaves a broken document with field rules excluded rather than dropping the rules', async t => {
  const root = await selfRoot(t),
    text = '---\naccess_lenses: [general]\nfield_access:\n  Salary:\n    access_lenses: [private]\n\tbroken: yaml\n---\n- Salary: SECRET_SENTINEL\n'
  await writeFile(join(root, 'context', 'broken.md'), text)
  assert.ok(!buildValidateFixPlan(root, { cachePlan: false }).operations.some(operation => operation.path === 'context/broken.md'))
})

test('migrate policy --dry-run lists field and marker rewrites and writes nothing', async t => {
  const root = await selfRoot(t),
    text = `---\n${MODERN}field_visibility:\n  Salary: private\n---\n${block('visibility=public-safe', 'Dry run marker wording.')}`
  await writeFile(join(root, 'context', 'dry.md'), text)
  const report = JSON.parse(await quiet(() => run(['migrate', 'policy', '--root', root, '--dry-run']))),
    rewrite = report.sub_document_rewrites.find(item => item.path === 'context/dry.md')
  assert.deepEqual(rewrite.field_access, { Salary: { access_lenses: ['private'], disclosure: 'review-required' } })
  assert.equal(rewrite.claim_markers[0].after, '<!-- holoself-claim disclosure=publish-approved -->')
  assert.equal(await readFile(join(root, 'context', 'dry.md'), 'utf8'), text)
})

test('the lens rename covers the new vocabulary too', () => {
  const text = `---\nfield_access:\n  career notes:\n    access_lenses: [career, general]\n  Other:\n    access_lenses:\n      - publishing\n---\n${block('access_lenses=career,professional disclosure=review-required', 'The career wording stays.')}`,
    renamed = renameLensMetadata(text)
  assert.match(renamed, /^ {2}career notes:\n {4}access_lenses: \[professional, general\]$/m, 'a field name is not a lens')
  assert.match(renamed, /^ {6}- public-voice$/m)
  assert.match(renamed, /holoself-claim access_lenses=professional disclosure=review-required -->\nThe career wording stays\./)
  assert.equal(sub([renamed]), renameLensMetadata(renamed), 'idempotent')
})
