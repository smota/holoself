// Issue #108 (0.11.0 stage of docs/decisions/privacy-fields-and-legacy-mount.md): the exact, non-widening mapping from
// the deprecated privacy fields to the target field set, proved exhaustively on synthetic fixtures through the runtime
// frontmatter parser, allowedDocument and publicationAllowed. No personal data.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { derivedPublicSafe } from '../src/annotations.mjs'
import { buildIndex, searchIndex } from '../src/catalog/index.mjs'
import { run } from '../src/cli.mjs'
import { contextData } from '../src/ecosystem.mjs'
import { CUSTOM_SENSITIVITY_CATEGORIES, DEFAULT_LENSES, DEFAULT_LENS_IDS } from '../src/lenses.mjs'
import {
  applyFrontmatterModifications,
  applyPolicyMigration,
  computeMeetMetadata,
  migrationChanges,
  planPolicyMigration,
  revertPolicyMigration,
  verifyNonAmplification
} from '../src/migration.mjs'
import { PUBLICATION_ADAPTERS, allowedDocument, publicationAllowed } from '../src/policy/access.mjs'
import { canonicalPrivacyMetadataErrors, frontmatter } from '../src/policy/privacy-fields.mjs'

const CUSTOM = Object.freeze({ id: 'custom-audit', sensitivity_access: ['personal', 'employer-confidential'] })
const REGISTRY = { lenses: [...DEFAULT_LENSES, CUSTOM], byId: new Map([...DEFAULT_LENSES, CUSTOM].map(lens => [lens.id, lens])) }
const LENS_IDS = [...DEFAULT_LENS_IDS, CUSTOM.id]
const SUBJECTS = [
  { kind: 'owner:direct', accessible_spaces: ['self', 'contrib'] },
  { kind: 'client:linked', accessible_spaces: ['self', 'contrib'], effective_allowed_lenses: new Set(LENS_IDS) }
]
const ADAPTERS = ['generic', ...PUBLICATION_ADAPTERS]
const RESOLUTIONS = lens => [{ sensitivity_access: REGISTRY.byId.get(lens).sensitivity_access || [] }, { sensitivity_access: [] }, { sensitivity_access: CUSTOM_SENSITIVITY_CATEGORIES }]

const DIMENSIONS = {
  visibility: [undefined, 'private', 'linked-projects', 'professional', 'public-voice', 'public-safe', 'career'],
  public_safe: [undefined, true, false],
  access_lenses: [undefined, [], ['general', 'private'], ['general', CUSTOM.id, 'private']],
  disclosure: [undefined, 'internal-only', 'review-required', 'publish-approved'],
  read_scope: [undefined, 'shared', 'local', 'restricted'],
  sensitivity: [undefined, 'personal', 'employer-confidential', 'restricted'],
  document_role: [undefined, 'policy']
}

function* combinations(keys = Object.keys(DIMENSIONS), acc = {}) {
  if (!keys.length) return yield acc
  const [key, ...rest] = keys
  for (const value of DIMENSIONS[key]) yield* combinations(rest, value === undefined ? acc : { ...acc, [key]: value })
}
function documentText(meta, body = '# Synthetic\n\nSynthetic body.\n') {
  const lines = Object.entries(meta).map(([key, value]) => `${key}: ${Array.isArray(value) ? `[${value.join(', ')}]` : value}`)
  return ['---', ...lines, '---', body].join('\n')
}
function migrate(text) {
  const before = frontmatter(text, { tolerant: true, registry: REGISTRY }).metadata
  const raw = frontmatter(text, { tolerant: true, validatePrivacy: false, registry: REGISTRY }).metadata
  const changes = migrationChanges(raw, computeMeetMetadata(before, 'self', REGISTRY))
  const afterText = Object.keys(changes).length ? applyFrontmatterModifications(text, changes) : text
  return { before, raw, changes, afterText, after: frontmatter(afterText, { tolerant: true, registry: REGISTRY }).metadata }
}
function canonicalValid(text) {
  try {
    return canonicalPrivacyMetadataErrors(frontmatter(text, { tolerant: false, registry: REGISTRY }).metadata, REGISTRY).length === 0
  } catch {
    return false
  }
}

test('document-level mapping is exact: 0 widened, 0 narrowed, 0 publication differences over every combination', () => {
  let combos = 0,
    cells = 0,
    widened = 0,
    narrowed = 0,
    publication = 0,
    gateFailures = 0,
    gateCoverageLoss = 0,
    legacyLeft = 0,
    canonicalBroken = 0,
    unreachable = 0,
    aliasMismatch = 0
  const examples = []
  for (const meta of combinations()) {
    combos++
    const text = documentText(meta)
    const { before, after, afterText } = migrate(text)
    if (/^(visibility|public_safe):/m.test(afterText)) legacyLeft++
    if (publicationAllowed(before) !== publicationAllowed(after)) publication++
    if (derivedPublicSafe(before) !== publicationAllowed(before) || derivedPublicSafe(after) !== publicationAllowed(after)) aliasMismatch++
    let reachable = false
    for (const lens of LENS_IDS)
      for (const resolution of RESOLUTIONS(lens))
        for (const subject of SUBJECTS)
          for (const adapter of ADAPTERS)
            for (const task of [null, 'synthetic task']) {
              cells++
              const b = allowedDocument(before, lens, adapter, task, resolution, subject, 'self').allowed,
                a = allowedDocument(after, lens, adapter, task, resolution, subject, 'self').allowed
              reachable ||= b
              if (a && !b) widened++
              if (b && !a) narrowed++
              if (a !== b && examples.length < 5) examples.push({ meta, lens, adapter, subject: subject.kind, before: b, after: a })
            }
    const gate = verifyNonAmplification(before, after, { registry: REGISTRY })
    if (!gate.valid) gateFailures++
    if (Object.keys(gate.coverageLoss).length) gateCoverageLoss++
    // A document the runtime admits canonically stays canonically valid after migration, except one that was already
    // unreachable for every caller (a restricted gate without the private lens), whose decisions stay all-deny.
    if (canonicalValid(text) && !canonicalValid(afterText)) {
      if (reachable) canonicalBroken++
      else unreachable++
    }
  }
  assert.equal(combos, 7 * 3 * 4 * 4 * 4 * 4 * 2)
  assert.equal(cells, combos * LENS_IDS.length * 3 * SUBJECTS.length * ADAPTERS.length * 2)
  assert.deepEqual(examples, [])
  assert.equal(widened, 0)
  assert.equal(narrowed, 0)
  assert.equal(publication, 0)
  assert.equal(gateFailures, 0)
  assert.equal(gateCoverageLoss, 0)
  assert.equal(legacyLeft, 0, 'migration removes visibility and public_safe')
  assert.equal(canonicalBroken, 0)
  assert.equal(aliasMismatch, 0, 'derivedPublicSafe is an alias of publicationAllowed')
  assert.equal(unreachable, 0)
})

test('every migrated document carries the four required fields plus read_scope and no deprecated field', () => {
  for (const meta of combinations()) {
    const { after, afterText } = migrate(documentText(meta))
    for (const key of ['access_lenses', 'disclosure', 'sensitivity', 'document_role', 'read_scope'])
      assert.ok(new RegExp(`^${key}:`, 'm').test(afterText) || Object.hasOwn(meta, key), `${JSON.stringify(meta)} lacks ${key}`)
    assert.ok(Array.isArray(after.access_lenses) && after.access_lenses.length > 0)
  }
})

test('the record table: each legacy value maps to its target fields', () => {
  const target = meta => {
    const { raw, changes } = migrate(documentText(meta))
    return { ...raw, ...changes }
  }
  const seven = [...DEFAULT_LENS_IDS]
  assert.deepEqual(target({ visibility: 'private' }), {
    visibility: null,
    access_lenses: ['private'],
    read_scope: 'restricted',
    disclosure: 'internal-only',
    sensitivity: 'personal',
    document_role: 'content'
  })
  assert.deepEqual(target({ visibility: 'linked-projects' }).access_lenses, seven)
  assert.deepEqual(target({ visibility: 'professional' }).access_lenses, ['general', 'professional', 'interview', 'private'])
  assert.deepEqual(target({ visibility: 'public-voice' }).access_lenses, ['general', 'public-voice', 'private'])
  assert.equal(target({ visibility: 'public-safe' }).disclosure, 'publish-approved')
  assert.equal(target({ visibility: 'public-safe', public_safe: false }).disclosure, 'review-required')
  assert.equal(target({ visibility: 'linked-projects', public_safe: true }).disclosure, 'publish-approved')
  assert.equal(target({ visibility: 'linked-projects', public_safe: true, disclosure: 'review-required' }).disclosure, 'review-required')
  assert.equal(target({ visibility: 'linked-projects', public_safe: false, disclosure: 'publish-approved' }).disclosure, 'review-required')
  assert.equal(target({ visibility: 'linked-projects', public_safe: false, disclosure: 'internal-only' }).disclosure, 'internal-only')
  const invalid = target({ visibility: 'career' })
  assert.deepEqual([invalid.access_lenses, invalid.read_scope, invalid.disclosure, invalid.sensitivity], [['private'], 'restricted', 'internal-only', 'restricted'])
})

test('verifyNonAmplification accepts visibility: public-safe mapped to disclosure: publish-approved without coverage loss', () => {
  const before = '---\nvisibility: public-safe\n---\n# Doc\n'
  const after =
    '---\naccess_lenses: [general, professional, public-voice, technical, leadership, interview, private]\nread_scope: shared\ndisclosure: publish-approved\nsensitivity: personal\ndocument_role: content\n---\n# Doc\n'
  const result = verifyNonAmplification(before, after)
  assert.equal(result.valid, true)
  assert.deepEqual(result.coverageLoss, {})
  assert.equal(verifyNonAmplification(after, before).valid, true, 'and the reverse direction: the mapping is exact')
})

const BODY = [
  '# Synthetic',
  '',
  'Open sentence long enough to be a claim. #opentag [open](https://open.example)',
  '',
  '<!-- holoself-claim visibility=public-safe -->',
  'SAFE_CLAIM_SENTINEL claim text. #safetag',
  '<!-- /holoself-claim -->',
  '',
  '<!-- holoself-claim visibility=private -->',
  'PRIVATE_CLAIM_SENTINEL claim text. #privatetag [p](https://private.example)',
  '<!-- /holoself-claim -->',
  '',
  '## Pro Notes',
  '',
  'FIELD_PRO_SENTINEL text.',
  ''
].join('\n')
const FIELD_VISIBILITY = { 'Pro Notes': 'professional' }

test('planPolicyMigration reports zero coverage loss for the exact cases, and apply then revert is byte-identical', async () => {
  const self = await mkdtemp(join(tmpdir(), 'holoself-fields-plan-'))
  await quiet(() => run(['init', '--root', self]))
  await mkdir(join(self, 'context', 'legacy'), { recursive: true })
  const files = {}
  let n = 0
  for (const visibility of DIMENSIONS.visibility.filter(v => v !== 'career'))
    for (const public_safe of DIMENSIONS.public_safe)
      for (const disclosure of DIMENSIONS.disclosure) {
        const meta = { ...(visibility ? { visibility } : {}), ...(public_safe !== undefined ? { public_safe } : {}), ...(disclosure ? { disclosure } : {}) }
        const fm = documentText(meta, '').replace(/\n---\n$/, '\nfield_visibility:\n  Pro Notes: professional\n---\n')
        const text = `${fm}${BODY}`
        if (!canonicalValid(text)) continue
        const path = join(self, 'context', 'legacy', `doc-${String(++n).padStart(3, '0')}.md`)
        await writeFile(path, text)
        files[path] = text
      }
  assert.equal(n, 56, 'canonically valid legacy fixtures (visibility x public_safe x disclosure)')
  const plan = planPolicyMigration(self)
  assert.equal(plan.summary.non_amplification_verified, true)
  assert.deepEqual(plan.summary.coverage_loss, {})
  assert.equal(plan.entries.filter(e => e.path.startsWith('context/legacy/') && e.needs_migration).length, n)
  const receipt = applyPolicyMigration(self, plan.plan_id)
  assert.equal(receipt.narrowing_confirmed, false)
  for (const path of Object.keys(files)) {
    const migrated = await readFile(path, 'utf8')
    assert.doesNotMatch(migrated, /^(visibility|public_safe):/m)
    assert.match(migrated, /^field_visibility:\n {2}Pro Notes: professional$/m, 'field_visibility stays until 0.12.0')
    assert.ok(migrated.endsWith(BODY), 'body and claim markers are untouched')
    assert.ok(canonicalValid(migrated))
  }
  const reverted = revertPolicyMigration(self, receipt.receipt_id)
  assert.equal(reverted.status, 'reverted')
  for (const [path, text] of Object.entries(files)) assert.equal(await readFile(path, 'utf8'), text)
})

test('a migrated former-legacy document keeps its decisions under a publish-approved, policy-role _policy.yaml', async () => {
  const self = await mkdtemp(join(tmpdir(), 'holoself-fields-policy-'))
  await quiet(() => run(['init', '--root', self]))
  await mkdir(join(self, 'context', 'shared'), { recursive: true })
  await writeFile(
    join(self, 'context', 'shared', '_policy.yaml'),
    'access_lenses: [general, professional, public-voice, technical, leadership, interview, private]\nread_scope: shared\ndisclosure: publish-approved\nsensitivity: personal\ndocument_role: policy\n'
  )
  const docs = {
    'context/shared/private.md': '---\nvisibility: private\n---\n# Private\n',
    'context/shared/professional.md': '---\nvisibility: professional\nsensitivity: employer-confidential\n---\n# Pro\n',
    'context/shared/linked.md': '---\nvisibility: linked-projects\npublic_safe: false\n---\n# Linked\n'
  }
  for (const [rel, text] of Object.entries(docs)) await writeFile(join(self, rel), text)
  const plan = planPolicyMigration(self, { dryRun: true })
  assert.deepEqual(plan.summary.coverage_loss, {})
  for (const rel of Object.keys(docs)) {
    const entry = plan.entries.find(e => e.path === rel)
    assert.equal(entry.needs_migration, true)
    assert.equal(entry.after_metadata.document_role, 'content', `${rel} does not inherit document_role: policy`)
    assert.notEqual(entry.after_metadata.disclosure, 'publish-approved', `${rel} does not inherit publish-approved`)
    const opts = { selfRoot: self, docPath: join(self, rel) }
    const forward = verifyNonAmplification(docs[rel], entry.after_text, opts)
    assert.equal(forward.valid, true)
    assert.deepEqual(forward.coverageLoss, {})
    assert.equal(verifyNonAmplification(entry.after_text, docs[rel], opts).valid, true, `${rel}: exact in both directions`)
  }
})

async function quiet(fn) {
  const old = console.log
  console.log = () => {}
  try {
    return await fn()
  } finally {
    console.log = old
  }
}

test('publication adapters: migrated documents deliver what legacy ones did, and sections stay a subset of content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holoself-fields-sections-')),
    project = await mkdtemp(join(tmpdir(), 'holoself-fields-sections-project-'))
  await quiet(() => run(['init', '--root', root]))
  await quiet(() => run(['link', 'add', '--self', root, '--project', project, '--lens', 'general', '--secondary-lenses', 'professional', '--yes', '--no-activate']))
  const fv = `field_visibility:\n${Object.entries(FIELD_VISIBILITY).map(([k, v]) => `  ${k}: ${v}`).join('\n')}\n`
  const legacy = {
    'context/safe.md': `---\nvisibility: public-safe\n${fv}---\n${BODY}\nSafe document.\n`,
    'context/linked-approved.md': `---\nvisibility: linked-projects\npublic_safe: true\n${fv}---\n${BODY}\nLinked document.\n`,
    'context/pro-approved.md': `---\nvisibility: professional\ndisclosure: publish-approved\nsensitivity: personal\n${fv}---\n${BODY}\nPro document.\n`
  }
  for (const [rel, text] of Object.entries(legacy)) await writeFile(join(root, rel), text)
  const snapshot = async () => {
    const out = {}
    for (const adapter of ['generic', ...PUBLICATION_ADAPTERS]) {
      const cwd = process.cwd()
      process.chdir(root)
      let data
      try {
        data = contextData({ lens: 'general', adapter, task: 'synthetic', budget: 'unbounded', json: true, root, rootExplicit: true })
      } finally {
        process.chdir(cwd)
      }
      const index = buildIndex(project)
      const passages = searchIndex(index, 'sentinel', 'general', null, null, 'current', { adapter })
      for (const rel of Object.keys(legacy)) {
        const doc = data.self.documents.find(d => d.path === rel)
        out[`${adapter} ${rel}`] = {
          content: doc?.content ?? null,
          passages: passages.filter(p => p.source_file === rel).map(p => p.matching_passage)
        }
      }
    }
    return out
  }
  const before = await snapshot()
  const plan = planPolicyMigration(root)
  assert.deepEqual(plan.summary.coverage_loss, {})
  applyPolicyMigration(root, plan.plan_id)
  const after = await snapshot()
  for (const [key, value] of Object.entries(after)) {
    assert.equal(value.content, before[key].content, `${key}: content unchanged by migration`)
    assert.ok(value.content !== null, `${key}: delivered`)
    for (const passage of value.passages)
      for (const line of passage.replace(/\.\.\.$/, '').split('\n').filter(x => x.trim()))
        assert.ok(value.content.includes(line.trim()), `${key}: section line ${JSON.stringify(line)} is not in content`)
    if (PUBLICATION_ADAPTERS.some(a => key.startsWith(`${a} `))) {
      const all = JSON.stringify(value)
      for (const hidden of ['PRIVATE_CLAIM_SENTINEL', 'FIELD_PRO_SENTINEL', 'privatetag', 'private.example']) assert.doesNotMatch(all, new RegExp(hidden), `${key}: ${hidden}`)
      assert.match(value.content, /SAFE_CLAIM_SENTINEL/)
    }
  }
})
