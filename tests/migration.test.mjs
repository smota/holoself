import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from '../src/cli.mjs'
import { DEFAULT_LENSES, DEFAULT_LENS_IDS } from '../src/lenses.mjs'
import {
  verifyNonAmplification,
  computeMeetMetadata,
  planPolicyMigration,
  applyPolicyMigration,
  applyFrontmatterModifications
} from '../src/migration.mjs'
import { accessLenses, allowedDocument, disclosure, publicationAllowed, visibility, PUBLICATION_ADAPTERS } from '../src/policy/access.mjs'
import { canonicalPrivacyMetadataErrors, frontmatter } from '../src/policy/privacy-fields.mjs'

async function temp(prefix = 'holoself-migration-') {
  return mkdtemp(join(tmpdir(), prefix))
}

async function capture(fn) {
  const old = console.log
  let out = ''
  console.log = (...x) => { out += x.join(' ') + '\n' }
  try {
    await fn()
  } finally {
    console.log = old
  }
  return out
}

test('verifyNonAmplification gate detects illegal permission expansion', () => {
  // Safe narrowing / identity: allowed_after => allowed_before
  const safe = verifyNonAmplification(
    { visibility: 'linked-projects' },
    { visibility: 'linked-projects', read_scope: 'shared', access_lenses: ['general', 'professional', 'public-voice', 'technical', 'leadership', 'interview', 'private'] }
  )
  assert.equal(safe.valid, true)

  // Narrowing (linked-projects -> professional removes public-voice, technical, leadership): allowed
  const narrowing = verifyNonAmplification(
    { visibility: 'linked-projects' },
    { visibility: 'professional', read_scope: 'shared', access_lenses: ['general', 'professional', 'interview', 'private'] }
  )
  assert.equal(narrowing.valid, true)
  assert.ok(narrowing.coverageLoss['public-voice'] > 0)
  assert.ok(narrowing.coverageLoss.technical > 0)
  assert.ok(narrowing.coverageLoss.leadership > 0)

  // Amplification: private gaining access under general lens
  const amplified = verifyNonAmplification(
    { visibility: 'private' },
    { visibility: 'private', read_scope: 'shared', access_lenses: ['general', 'private'] }
  )
  assert.equal(amplified.valid, false)
  assert.match(amplified.violation, /DENY -> ALLOW/)
})

test('computeMeetMetadata maps legacy visibility to the exact runtime fields for every document kind', () => {
  const selfPrivate = computeMeetMetadata({ visibility: 'private' }, 'self')
  assert.equal(selfPrivate.read_scope, 'restricted')
  assert.deepEqual(selfPrivate.access_lenses, ['private'])
  assert.equal(selfPrivate.disclosure, 'internal-only')
  assert.equal(Object.hasOwn(selfPrivate, 'visibility'), false)

  for (const kind of ['self', 'project']) {
    const linked = computeMeetMetadata({ visibility: 'linked-projects' }, kind)
    assert.equal(linked.read_scope, 'shared')
    assert.deepEqual(linked.access_lenses, DEFAULT_LENS_IDS)
    assert.equal(linked.sensitivity, 'personal')
    assert.equal(linked.document_role, 'content')
    const publicSafe = computeMeetMetadata({ visibility: 'public-safe', public_safe: true }, kind)
    assert.deepEqual(publicSafe.access_lenses, DEFAULT_LENS_IDS)
    assert.equal(publicSafe.disclosure, 'publish-approved')
    assert.equal(Object.hasOwn(publicSafe, 'public_safe'), false)
  }
  assert.deepEqual(computeMeetMetadata({ visibility: 'professional' }).access_lenses, ['general', 'professional', 'interview', 'private'])
  assert.deepEqual(computeMeetMetadata({ visibility: 'public-voice' }).access_lenses, ['general', 'public-voice', 'private'])
  // public_safe: false overrides publish-approved; an explicit internal-only is kept.
  assert.equal(computeMeetMetadata({ disclosure: 'publish-approved', public_safe: false }).disclosure, 'review-required')
  assert.equal(computeMeetMetadata({ disclosure: 'internal-only', public_safe: false }).disclosure, 'internal-only')
})

test('migrate policy saves a plan without mutating source documents', async () => {
  const self = await temp()
  await run(['init', '--root', self])

  const initialContent = '---\nvisibility: linked-projects\nsensitivity: personal\n---\n# Legacy Note\nContent stays intact.\n'
  await writeFile(join(self, 'context', 'legacy-note.md'), initialContent)

  const output = await capture(() => run(['migrate', 'policy', '--root', self]))
  const planData = JSON.parse(output)

  assert.equal(planData.status, 'planned')
  assert.ok(planData.plan_id)
  assert.ok(planData.summary.modified_files > 0)
  assert.equal(planData.summary.non_amplification_verified, true)

  // Verify file on disk was NOT mutated during dry-run
  const onDisk = await readFile(join(self, 'context', 'legacy-note.md'), 'utf8')
  assert.equal(onDisk, initialContent)

  // Verify plan file exists and has correct schema
  const planFile = await readFile(planData.plan_file, 'utf8')
  const savedPlan = JSON.parse(planFile)
  assert.equal(savedPlan.plan_id, planData.plan_id)
  assert.equal(savedPlan.schema_version, 1)
})

test('migrate policy requires --confirm-narrowing when coverage loss occurs', async () => {
  const self = await temp()
  await run(['init', '--root', self])

  // visibility: professional maps exactly: no coverage loss, applies without --confirm-narrowing.
  await writeFile(join(self, 'context', 'career-guide.md'), '---\nvisibility: professional\n---\n# Career\nCareer details.\n')
  const exact = JSON.parse(await capture(() => run(['migrate', 'policy', '--root', self])))
  assert.deepEqual(exact.summary.coverage_loss, {})
  const exactReceipt = JSON.parse(await capture(() => run(['migrate', 'policy', '--root', self, '--apply', exact.plan_id])))
  assert.equal(exactReceipt.narrowing_confirmed, false)
  const updated = await readFile(join(self, 'context', 'career-guide.md'), 'utf8')
  assert.match(updated, /read_scope:\s*shared/)
  assert.match(updated, /access_lenses:\s*\[general, professional, interview, private\]/)
  assert.doesNotMatch(updated, /^visibility:/m)
  assert.match(updated, /# Career\nCareer details\./)

  // Removing legacy visibility turns _policy.yaml inheritance on: an inherited exclude_lenses narrows the document,
  // which is coverage loss and needs --confirm-narrowing.
  await mkdir(join(self, 'topics', 'narrow'), { recursive: true })
  await writeFile(join(self, 'topics', 'narrow', '_policy.yaml'), 'exclude_lenses: [technical]\n')
  await writeFile(join(self, 'topics', 'narrow', 'note.md'), '---\nvisibility: linked-projects\n---\n# Note\n')
  const plan = JSON.parse(await capture(() => run(['migrate', 'policy', '--root', self])))
  assert.ok(plan.summary.coverage_loss.technical > 0)
  await assert.rejects(run(['migrate', 'policy', '--root', self, '--apply', plan.plan_id]), /confirm-narrowing|NARROWING_CONFIRMATION_REQUIRED/)
  const receipt = JSON.parse(await capture(() => run(['migrate', 'policy', '--root', self, '--apply', plan.plan_id, '--confirm-narrowing'])))
  assert.equal(receipt.status, 'applied')
  assert.equal(receipt.narrowing_confirmed, true)
})

test('migrate policy revert restores exact original file contents and marks receipt', async () => {
  const self = await temp()
  await run(['init', '--root', self])

  const originalContent = '---\nvisibility: linked-projects\n---\n# Unmigrated\nOriginal text.\n'
  const filePath = join(self, 'context', 'test-doc.md')
  await writeFile(filePath, originalContent)

  const planOutput = await capture(() => run(['migrate', 'policy', '--root', self]))
  const plan = JSON.parse(planOutput)

  await run(['migrate', 'policy', '--root', self, '--apply', plan.plan_id, '--confirm-narrowing'])
  const migratedContent = await readFile(filePath, 'utf8')
  assert.notEqual(migratedContent, originalContent)

  // Revert migration
  const revertOutput = await capture(() => run(['migrate', 'policy', '--root', self, '--revert', plan.plan_id]))
  const revertReceipt = JSON.parse(revertOutput)
  assert.equal(revertReceipt.status, 'reverted')

  // Verify file restored to exact bytes
  const restoredContent = await readFile(filePath, 'utf8')
  assert.equal(restoredContent, originalContent)
})

test('migrate policy revert handles post-migration modifications with --allow-partial', async () => {
  const self = await temp()
  await run(['init', '--root', self])

  const file1 = join(self, 'context', 'file1.md')
  const file2 = join(self, 'context', 'file2.md')
  await writeFile(file1, '---\nvisibility: linked-projects\n---\n# One\n')
  await writeFile(file2, '---\nvisibility: linked-projects\n---\n# Two\n')

  const plan = JSON.parse(await capture(() => run(['migrate', 'policy', '--root', self])))
  await run(['migrate', 'policy', '--root', self, '--apply', plan.plan_id, '--confirm-narrowing'])

  // Externally modify file1 after migration
  await writeFile(file1, '# Modified externally\nAfter migration change.\n')

  // Revert without --allow-partial must abort fail-closed
  await assert.rejects(
    run(['migrate', 'policy', '--root', self, '--revert', plan.plan_id]),
    /modified after migration/i
  )

  // Revert with --allow-partial succeeds for file2 and skips file1
  const partialOutput = await capture(() => run(['migrate', 'policy', '--root', self, '--revert', plan.plan_id, '--allow-partial']))
  const partialReceipt = JSON.parse(partialOutput)
  assert.equal(partialReceipt.status, 'partially-reverted')

  // file2 restored to original
  assert.equal(await readFile(file2, 'utf8'), '---\nvisibility: linked-projects\n---\n# Two\n')
  // file1 preserves external change
  assert.match(await readFile(file1, 'utf8'), /Modified externally/)
})

test('migrate policy --include-linked migrates linked project files under sovereign registry', async () => {
  const self = await temp()
  const project = await temp()
  await run(['init', '--root', self])
  await mkdir(join(project, 'Context'), { recursive: true })

  const projDoc = join(project, 'Context', 'project-doc.md')
  await writeFile(projDoc, '---\nvisibility: linked-projects\n---\n# Project Doc\nProject details.\n')

  await run(['link', 'add', '--project', project, '--self', self, '--lens', 'general', '--yes'])

  // Plan with --include-linked
  const planInfo = JSON.parse(await capture(() => run(['migrate', 'policy', '--root', self, '--include-linked'])))
  assert.equal(planInfo.include_linked, true)
  const plan = JSON.parse(await readFile(planInfo.plan_file, 'utf8'))
  assert.ok(plan.entries.some(e => e.path === 'Context/project-doc.md' && e.space_id !== 'self'))

  // Apply
  await run(['migrate', 'policy', '--root', self, '--apply', plan.plan_id, '--confirm-narrowing'])
  const updatedProjDoc = await readFile(projDoc, 'utf8')
  assert.match(updatedProjDoc, /read_scope:\s*shared/)
  assert.match(updatedProjDoc, /access_lenses:/)

  // Revert
  await run(['migrate', 'policy', '--root', self, '--revert', plan.plan_id])
  assert.equal(await readFile(projDoc, 'utf8'), '---\nvisibility: linked-projects\n---\n# Project Doc\nProject details.\n')
})
test('migrate policy revert rejects tampered receipt entries fail-closed', async () => {
  const self = await temp()
  await run(['init', '--root', self])

  const filePath = join(self, 'context', 'tamper-test.md')
  await writeFile(filePath, '---\nvisibility: linked-projects\n---\n# Original\n')

  const plan = JSON.parse(await capture(() => run(['migrate', 'policy', '--root', self])))
  await run(['migrate', 'policy', '--root', self, '--apply', plan.plan_id, '--confirm-narrowing'])

  // Tamper with receipt file
  const receiptPath = join(self, '.holoself', 'migrations', `receipt-${plan.plan_id}.json`)
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
  receipt.entries[0].before_sha256 = '0'.repeat(64)
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2))

  await assert.rejects(
    run(['migrate', 'policy', '--root', self, '--revert', plan.plan_id]),
    /receipt integrity failure/i
  )
})

test('migrate policy explicit dry-run writes no files or directories',async()=>{
  const root=await temp();await run(['init','--root',root])
  async function snapshot(path){const entries=[];for(const item of (await readdir(path,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name)))entries.push([item.name,item.isDirectory()?await snapshot(join(path,item.name)):await readFile(join(path,item.name),'base64')]);return entries}
  for(const existing of [false,true]){
    if(existing){await mkdir(join(root,'.holoself','migrations'),{recursive:true});await writeFile(join(root,'.holoself','migrations','keep.json'),'{}')}
    const before=await snapshot(root),result=JSON.parse(await capture(()=>run(['migrate','policy','--root',root,'--dry-run'])))
    assert.equal(result.status,'planned');assert.equal(result.plan_file,null);assert.deepEqual(await snapshot(root),before)
    for(const flag of ['--output','--apply','--revert'])await assert.rejects(run(['migrate','policy','--root',root,'--dry-run',flag,'example']),/cannot be combined|not supported/)
    assert.deepEqual(await snapshot(root),before)
  }
})

test('regression (a): runtime-private doc with access_lenses: [] or present-but-empty privacy fields never grants other lenses', async () => {
  const self = await temp()
  await mkdir(join(self, 'context'), { recursive: true })

  // Doc with visibility: linked-projects and access_lenses: [] is excluded by the catalog before migration
  const docPath = join(self, 'context', 'empty-lenses.md')
  await writeFile(docPath, '---\nvisibility: linked-projects\naccess_lenses: []\n---\n# Restricted\n')

  // Also test block-style empty access_lenses and other present-but-empty fields
  const emptyBlockPath = join(self, 'context', 'empty-block.md')
  await writeFile(emptyBlockPath, '---\nvisibility: public-safe\naccess_lenses:\n---\n# Restricted Block\n')

  const emptyVisPath = join(self, 'context', 'empty-vis.md')
  await writeFile(emptyVisPath, '---\nvisibility: ""\n---\n# Empty Visibility\n')

  // By default, catalog-excluded documents are skipped with a warning and listed under activations
  const defaultPlan = planPolicyMigration(self, { dryRun: true })
  assert.equal(defaultPlan.summary.non_amplification_verified, true)
  assert.equal(defaultPlan.summary.modified_files, 0)
  assert.equal(defaultPlan.activations.length, 3)
  assert.equal(defaultPlan.warnings.length, 3)
  for (const rel of ['context/empty-lenses.md', 'context/empty-block.md', 'context/empty-vis.md']) {
    const act = defaultPlan.activations.find(a => a.path === rel)
    assert.ok(act, `expected activation for ${rel}`)
    assert.equal(act.skipped, true)
    assert.deepEqual(act.lenses, ['private'])
    assert.deepEqual(act.adapters, ['generic'])
    assert.equal(act.publication_allowed, false)
    const entry = defaultPlan.entries.find(e => e.path === rel)
    assert.ok(entry, `expected entry for ${rel}`)
    assert.equal(entry.needs_migration, false)
  }

  // With confirmActivation: true, they are migrated to private-only restricted metadata and never grant other lenses
  const plan = planPolicyMigration(self, { dryRun: true, confirmActivation: true })
  assert.equal(plan.summary.non_amplification_verified, true)
  assert.deepEqual(plan.summary.coverage_loss, {})
  assert.notEqual(plan.plan_id, defaultPlan.plan_id)

  for (const rel of ['context/empty-lenses.md', 'context/empty-block.md', 'context/empty-vis.md']) {
    const entry = plan.entries.find(e => e.path === rel)
    assert.ok(entry, `expected entry for ${rel}`)
    assert.equal(entry.needs_migration, true)
    assert.deepEqual(entry.after_metadata.access_lenses, ['private'])
    assert.equal(entry.after_metadata.read_scope, 'restricted')
    const afterParsed = frontmatter(entry.after_text, { tolerant: true })
    assert.deepEqual(afterParsed.metadata.access_lenses, ['private'])
    assert.equal(afterParsed.metadata.read_scope, 'restricted')
    assert.equal(publicationAllowed(afterParsed.metadata), false)
  }

  // Present-but-empty values in computeMeetMetadata and verifyNonAmplification
  for (const emptyMeta of [
    { visibility: 'linked-projects', access_lenses: [] },
    { access_lenses: [] },
    { visibility: '' },
    { read_scope: '' },
    { disclosure: '' },
    { sensitivity: '' },
    { document_role: '' },
    { public_safe: null },
    { task_include: [] },
    { task_exclude: [] }
  ]) {
    const meet = computeMeetMetadata(emptyMeta, 'self')
    assert.deepEqual(meet.access_lenses, ['private'])
    assert.equal(meet.read_scope, 'restricted')
    assert.equal(meet.disclosure, 'internal-only')

    // Even migrating an excluded doc to private-only counts as DENY -> ALLOW unless confirmActivation is set
    const toPrivate = verifyNonAmplification(emptyMeta, meet)
    assert.equal(toPrivate.valid, false)
    assert.match(toPrivate.violation, /DENY -> ALLOW/)

    // Widening an empty-lenses or invalid doc to general lens must be refused
    const widened = verifyNonAmplification(emptyMeta, {
      visibility: 'linked-projects',
      read_scope: 'shared',
      access_lenses: ['general', 'private']
    })
    assert.equal(widened.valid, false)
    assert.match(widened.violation, /DENY -> ALLOW/)
  }
})

test('regression (b): removing public_safe: false is refused as publication widening', () => {
  // Doc with visibility: public-safe and public_safe: false is NOT publishable before, but removing public_safe: false makes it publishable
  const beforeWithPublicSafeFalse = {
    visibility: 'public-safe',
    public_safe: false,
    read_scope: 'shared',
    access_lenses: ['general', 'public-voice', 'private']
  }
  const afterRemovedPublicSafeFalse = {
    visibility: 'public-safe',
    read_scope: 'shared',
    access_lenses: ['general', 'public-voice', 'private']
  }
  assert.equal(publicationAllowed(beforeWithPublicSafeFalse), false)
  assert.equal(publicationAllowed(afterRemovedPublicSafeFalse), true)

  const check1 = verifyNonAmplification(beforeWithPublicSafeFalse, afterRemovedPublicSafeFalse)
  assert.equal(check1.valid, false)
  assert.match(check1.violation, /DENY -> ALLOW/)

  // Even when access_lenses is ['private'] and read_scope is 'restricted', removing public_safe: false from a publish-approved doc widens publicationAllowed
  const beforePrivatePub = {
    visibility: 'private',
    read_scope: 'restricted',
    access_lenses: ['private'],
    disclosure: 'publish-approved',
    public_safe: false,
    sensitivity: 'personal'
  }
  const afterPrivatePub = {
    visibility: 'private',
    read_scope: 'restricted',
    access_lenses: ['private'],
    disclosure: 'publish-approved',
    sensitivity: 'personal'
  }
  assert.equal(publicationAllowed(beforePrivatePub), false)
  assert.equal(publicationAllowed(afterPrivatePub), true)

  const check2 = verifyNonAmplification(beforePrivatePub, afterPrivatePub)
  assert.equal(check2.valid, false)
  assert.match(check2.violation, /DENY -> ALLOW/)
})

test('regression (c): visibility: private mapping is exact with zero coverage loss', async () => {
  const self = await temp()
  await mkdir(join(self, 'context'), { recursive: true })

  const docPath = join(self, 'context', 'private-note.md')
  await writeFile(docPath, '---\nvisibility: private\n---\n# Secret Note\n')

  const plan = planPolicyMigration(self)
  assert.equal(plan.summary.modified_files, 1)
  assert.equal(plan.summary.non_amplification_verified, true)
  assert.deepEqual(plan.summary.coverage_loss, {})

  const entry = plan.entries[0]
  assert.equal(entry.changes.read_scope, 'restricted')
  assert.deepEqual(entry.changes.access_lenses, ['private'])

  // Applies cleanly without --confirm-narrowing because there is no coverage loss
  const receipt = applyPolicyMigration(self, plan.plan_id)
  assert.equal(receipt.status, 'applied')
  assert.equal(receipt.narrowing_confirmed, false)

  const updated = await readFile(docPath, 'utf8')
  assert.match(updated, /read_scope: restricted/)
  assert.match(updated, /access_lenses: \[private\]/)
})

test('verifyNonAmplification evaluates custom lenses from registry across all callers and public adapters', async () => {
  const self = await temp()
  await run(['init', '--root', self])
  await mkdir(join(self, 'lenses'), { recursive: true })
  await writeFile(
    join(self, 'lenses', 'coaching.json'),
    JSON.stringify({
      schema_version: 1,
      id: 'coaching',
      label: 'Coaching',
      description: 'Custom coaching lens',
      behavior_lens: 'general',
      sensitivity_access: ['personal', 'compensation-confidential'],
      allow_linked_clients: true
    })
  )

  const baseCanonical = {
    disclosure: 'internal-only',
    sensitivity: 'personal',
    document_role: 'content'
  }

  // Granting custom lens 'coaching' when it was not granted before is refused as amplification
  const customWidened = verifyNonAmplification(
    { ...baseCanonical, visibility: 'linked-projects', read_scope: 'shared', access_lenses: ['general', 'private'] },
    { ...baseCanonical, visibility: 'linked-projects', read_scope: 'shared', access_lenses: ['general', 'coaching', 'private'] },
    { selfRoot: self }
  )
  assert.equal(customWidened.valid, false)
  assert.match(customWidened.violation, /Cell \(coaching, .+\) transited DENY -> ALLOW/)

  // Preserving custom lens 'coaching' has 0 widening and 0 coverage loss
  const customExact = verifyNonAmplification(
    { ...baseCanonical, visibility: 'linked-projects', read_scope: 'shared', access_lenses: ['general', 'coaching', 'private'] },
    { ...baseCanonical, visibility: 'linked-projects', read_scope: 'shared', access_lenses: ['general', 'coaching', 'private'] },
    { selfRoot: self }
  )
  assert.equal(customExact.valid, true)
  assert.deepEqual(customExact.coverageLoss, {})

  // Removing custom lens 'coaching' is reported as coverage loss for 'coaching'
  const customNarrowed = verifyNonAmplification(
    { ...baseCanonical, visibility: 'linked-projects', read_scope: 'shared', access_lenses: ['general', 'coaching', 'private'] },
    { ...baseCanonical, visibility: 'linked-projects', read_scope: 'shared', access_lenses: ['general', 'private'] },
    { selfRoot: self }
  )
  assert.equal(customNarrowed.valid, true)
  assert.ok(customNarrowed.coverageLoss.coaching > 0)
})

test('regression (d): synthetic exhaustive check over visibility x public_safe x disclosure x sensitivity x access_lenses x read_scope', () => {
  const visibilities = [undefined, 'private', 'linked-projects', 'professional', 'public-voice', 'public-safe']
  const publicSafes = [undefined, true, false]
  const disclosures = [undefined, 'internal-only', 'review-required', 'publish-approved']
  const sensitivities = [undefined, 'public', 'personal', 'employer-confidential', 'restricted']
  const accessLensOpts = [undefined, [], ['general', 'private']]
  const readScopes = [undefined, 'shared', 'local', 'restricted']

  const customLens = {
    id: 'custom-audit',
    sensitivity_access: ['personal', 'employer-confidential']
  }
  const registry = {
    lenses: [...DEFAULT_LENSES, customLens],
    byId: new Map([...DEFAULT_LENSES, customLens].map(l => [l.id, l]))
  }
  const allLenses = [...DEFAULT_LENS_IDS, customLens.id]
  const subjects = [
    { kind: 'owner:direct', accessible_spaces: ['self', 'contrib'] },
    { kind: 'client:linked', accessible_spaces: ['self', 'contrib'], effective_allowed_lenses: new Set(allLenses) }
  ]
  const adapters = ['generic', 'public', 'obsidian-public', 'restricted-host']

  let totalCombinations = 0
  let exactLegacyCombinations = 0
  let appliedPlans = 0
  let skippedActivations = 0
  let planWidened = 0
  let exactWidened = 0
  let exactFalseCoverageLoss = 0

  for (const vis of visibilities) {
    for (const pubSafe of publicSafes) {
      for (const disc of disclosures) {
        for (const sens of sensitivities) {
          for (const al of accessLensOpts) {
            for (const rs of readScopes) {
              totalCombinations++

              const lines = ['---']
              if (vis !== undefined) lines.push(`visibility: ${vis}`)
              if (pubSafe !== undefined) lines.push(`public_safe: ${pubSafe}`)
              if (disc !== undefined) lines.push(`disclosure: ${disc}`)
              if (sens !== undefined) lines.push(`sensitivity: ${sens}`)
              if (al !== undefined) lines.push(`access_lenses: [${al.join(', ')}]`)
              if (rs !== undefined) lines.push(`read_scope: ${rs}`)
              lines.push('---', '# Synthetic Doc', '')
              const rawText = lines.join('\n')

              // Check whether the catalog excludes BEFORE
              let beforeExcluded = false
              try {
                const strictParsed = frontmatter(rawText, { tolerant: false, registry })
                beforeExcluded = canonicalPrivacyMetadataErrors(strictParsed.metadata, registry).length > 0
              } catch {
                beforeExcluded = true
              }

              // Parse BEFORE as tolerant fallback for meet computation
              const beforeParsed = frontmatter(rawText, { tolerant: true, registry })
              const beforeMeta = beforeParsed.metadata

              const rawParsed = frontmatter(rawText, { tolerant: true, validatePrivacy: false, registry })
              const rawMeta = rawParsed.metadata
              const wasRestricted =
                beforeParsed.warnings.some(w => w.includes('restricted')) ||
                (rawMeta.visibility === 'public-safe' && rawMeta.public_safe === false) ||
                ((rawMeta.sensitivity === 'restricted' || rawMeta.read_scope === 'restricted') &&
                  Array.isArray(rawMeta.access_lenses) &&
                  rawMeta.access_lenses.some(l => l !== 'private'))
              const meetMeta = computeMeetMetadata(beforeMeta, 'self', registry)

              const changes = {}
              if (rawMeta.read_scope !== meetMeta.read_scope) changes.read_scope = meetMeta.read_scope
              const beforeAccess = Array.isArray(rawMeta.access_lenses) ? rawMeta.access_lenses : null
              if (!beforeAccess || JSON.stringify(beforeAccess) !== JSON.stringify(meetMeta.access_lenses)) {
                changes.access_lenses = meetMeta.access_lenses
              }
              if (wasRestricted) {
                if (rawMeta.visibility !== undefined && rawMeta.visibility !== meetMeta.visibility) changes.visibility = meetMeta.visibility
                if (rawMeta.disclosure !== undefined && rawMeta.disclosure !== meetMeta.disclosure) changes.disclosure = meetMeta.disclosure
                if (rawMeta.public_safe !== undefined && rawMeta.public_safe !== meetMeta.public_safe) changes.public_safe = meetMeta.public_safe
                if (rawMeta.sensitivity !== undefined && rawMeta.sensitivity !== meetMeta.sensitivity) changes.sensitivity = meetMeta.sensitivity
                if (rawMeta.document_role !== undefined && rawMeta.document_role !== meetMeta.document_role) changes.document_role = meetMeta.document_role
              }
              if (Object.keys(changes).length > 0 || beforeExcluded) {
                for (const key of ['access_lenses', 'disclosure', 'sensitivity', 'document_role', 'read_scope']) {
                  if (!Object.hasOwn(changes, key) && rawMeta[key] === undefined && meetMeta[key] !== undefined) {
                    changes[key] = meetMeta[key]
                  }
                }
              }

              const proposedAfterText = Object.keys(changes).length > 0 ? applyFrontmatterModifications(rawText, changes) : rawText
              const proposedAfterParsed = frontmatter(proposedAfterText, { tolerant: true, registry })
              const proposedAfterMeta = proposedAfterParsed.metadata

              if (beforeExcluded) {
                skippedActivations++
                // Default plan skips excluded documents, so verifyNonAmplification on the proposed activation detects DENY -> ALLOW
                const rawActivationCheck = verifyNonAmplification(rawText, proposedAfterText, { registry })
                assert.equal(rawActivationCheck.valid, false, 'activating an excluded document without confirmActivation must be flagged as DENY -> ALLOW')
                // Even when confirmed, the proposed activation must never widen beyond the conservative meet baseline
                const confirmedCheck = verifyNonAmplification(beforeMeta, proposedAfterMeta, { registry, confirmActivation: true })
                if (!confirmedCheck.valid) planWidened++
                continue
              }

              appliedPlans++
              const afterText = proposedAfterText
              const afterMeta = proposedAfterMeta

              const planCheck = verifyNonAmplification(rawText, afterText, { registry })
              if (!planCheck.valid) planWidened++

              // Directly verify with runtime allowedDocument & publicationAllowed across all lenses, callers, and adapters
              if (publicationAllowed(afterMeta) && !publicationAllowed(beforeMeta)) {
                planWidened++
              }
              for (const lens of allLenses) {
                const lensObj = registry.byId.get(lens)
                const res = { sensitivity_access: lensObj.sensitivity_access || [] }
                for (const s of subjects) {
                  for (const a of adapters) {
                    const bAllow = allowedDocument(beforeMeta, lens, a, null, res, s, 'self').allowed
                    const aAllow = allowedDocument(afterMeta, lens, a, null, res, s, 'self').allowed
                    if (aAllow && !bAllow) planWidened++
                  }
                }
              }

              // 2. Check exact runtime mapping on included docs: must have 0 widened and 0 false coverage loss
              const exactReadScope = ['shared', 'local', 'restricted'].includes(beforeMeta.read_scope)
                ? beforeMeta.read_scope
                : visibility(beforeMeta) === 'private'
                  ? 'restricted'
                  : 'shared'
              const exactAfter = {
                ...beforeMeta,
                read_scope: exactReadScope,
                access_lenses:
                  beforeMeta.sensitivity === 'restricted' || exactReadScope === 'restricted'
                    ? ['private']
                    : accessLenses(beforeMeta),
                disclosure: disclosure(beforeMeta),
                sensitivity: beforeMeta.sensitivity || 'personal',
                document_role: beforeMeta.document_role || 'content'
              }
              const exactCheck = verifyNonAmplification(rawText, exactAfter, { registry })
              if (!exactCheck.valid) exactWidened++
              if (Object.keys(exactCheck.coverageLoss).length > 0) exactFalseCoverageLoss++

              if ((!Array.isArray(al) || al.length > 0) && sens !== 'employer-confidential' && rs !== 'local') {
                exactLegacyCombinations++
              }
            }
          }
        }
      }
    }
  }

  assert.equal(totalCombinations, 4320)
  assert.equal(appliedPlans + skippedActivations, 4320)
  assert.ok(appliedPlans > 0)
  assert.ok(skippedActivations > 0)
  assert.equal(planWidened, 0)
  assert.equal(exactWidened, 0)
  assert.equal(exactFalseCoverageLoss, 0)
})

test('regression (e): applyFrontmatterModifications anchors keys at column 0 to preserve nested field_visibility', async () => {
  // Assert verifyNonAmplification adapter list includes every entry of PUBLICATION_ADAPTERS
  assert.ok(Array.isArray(verifyNonAmplification.adapters))
  for (const adapter of PUBLICATION_ADAPTERS) {
    assert.ok(
      verifyNonAmplification.adapters.includes(adapter),
      `verifyNonAmplification adapters must include publication adapter ${adapter}`
    )
  }

  const self = await temp()
  await mkdir(join(self, 'context'), { recursive: true })

  const nestedLine = '  visibility: public-safe'
  const initialContent = [
    '---',
    'field_visibility:',
    nestedLine,
    'visibility: private',
    '---',
    '# Canonical Doc',
    'Body text.',
    ''
  ].join('\n')

  const docPath = join(self, 'context', 'canonical-doc.md')
  await writeFile(docPath, initialContent)

  // Run the migrate-policy plan/apply path existing tests use
  const plan = planPolicyMigration(self)
  assert.equal(plan.summary.modified_files, 1)
  assert.equal(plan.summary.non_amplification_verified, true)
  assert.deepEqual(plan.summary.coverage_loss, {})

  const entry = plan.entries[0]
  assert.equal(entry.changes.read_scope, 'restricted')
  assert.deepEqual(entry.changes.access_lenses, ['private'])

  const receipt = applyPolicyMigration(self, plan.plan_id)
  assert.equal(receipt.status, 'applied')

  const updated = await readFile(docPath, 'utf8')

  // Assert the nested line is byte-unchanged
  assert.ok(
    updated.includes(nestedLine),
    'nested field_visibility line must remain byte-unchanged'
  )
  assert.match(updated, /field_visibility:\r?\n  visibility: public-safe/)

  // Assert the deprecated top-level key is removed, not the nested one
  assert.doesNotMatch(updated, /^visibility:/m)
  assert.match(updated, /^read_scope:\s*restricted/m)
  assert.match(updated, /^access_lenses:\s*\[private\]/m)

  // Also assert directly that applyFrontmatterModifications modifies top-level key without rewriting nested key
  const directModified = applyFrontmatterModifications(initialContent, { visibility: 'public-safe' })
  assert.ok(
    directModified.includes(nestedLine),
    'applyFrontmatterModifications must not rewrite nested line when modifying visibility'
  )
  assert.match(directModified, /^visibility:\s*public-safe/m)
})

test('catalog-excluded documents require --confirm-activation while already-included documents migrate normally', async () => {
  const self = await temp()
  await run(['init', '--root', self])

  // 1. Legacy incomplete/invalid visibility-only and partial documents excluded by the catalog
  const legacyCareerPath = join(self, 'context', 'legacy-career.md')
  const legacyCareerContent = '---\nvisibility: career\n---\n# Legacy Career\nExcluded by invalid legacy visibility.\n'
  await writeFile(legacyCareerPath, legacyCareerContent)

  const partialLegacyPath = join(self, 'context', 'partial-legacy.md')
  const partialLegacyContent =
    '---\nvisibility: professional\naccess_lenses: [general, professional, interview, private]\n---\n# Partial Legacy\nExcluded by missing disclosure, sensitivity, document_role.\n'
  await writeFile(partialLegacyPath, partialLegacyContent)

  const legacyPublicSafeOnlyPath = join(self, 'context', 'public-safe-only.md')
  const legacyPublicSafeOnlyContent = '---\npublic_safe: true\n---\n# Public Safe Only\nExcluded because access_lenses and visibility are both missing.\n'
  await writeFile(legacyPublicSafeOnlyPath, legacyPublicSafeOnlyContent)

  // 2. Invalid-metadata document excluded by the catalog
  const invalidMetaPath = join(self, 'context', 'invalid-meta.md')
  const invalidMetaContent = '---\nvisibility: linked-projects\ndisclosure: invalid-value\n---\n# Invalid Disclosure\nExcluded by invalid disclosure value.\n'
  await writeFile(invalidMetaPath, invalidMetaContent)

  // 3. Already-included document with valid legacy visibility
  const includedDocPath = join(self, 'context', 'included-doc.md')
  const includedDocContent = '---\nvisibility: private\n---\n# Already Included\nIncluded in catalog before migration.\n'
  await writeFile(includedDocPath, includedDocContent)

  // Verify verifyNonAmplification treats each excluded document as denied everywhere before migration
  for (const excludedText of [legacyCareerContent, partialLegacyContent, legacyPublicSafeOnlyContent, invalidMetaContent]) {
    const check = verifyNonAmplification(excludedText, {
      access_lenses: ['private'],
      read_scope: 'restricted',
      disclosure: 'internal-only',
      sensitivity: 'restricted',
      document_role: 'content'
    })
    assert.equal(check.valid, false)
    assert.match(check.violation, /DENY -> ALLOW/)
  }

  // Default CLI plan: lists excluded docs under activations, emits warnings, skips them, and migrates included docs
  const oldErr = console.error
  let stderrOut = ''
  console.error = (...x) => {
    stderrOut += x.join(' ') + '\n'
  }
  let defaultPlanOut
  try {
    defaultPlanOut = JSON.parse(await capture(() => run(['migrate', 'policy', '--root', self])))
  } finally {
    console.error = oldErr
  }

  assert.equal(defaultPlanOut.confirm_activation, false)
  assert.equal(defaultPlanOut.activations.length, 4)
  assert.equal(defaultPlanOut.warnings.length, 4)
  assert.match(stderrOut, /\[warn\].*context\/legacy-career\.md.*--confirm-activation/)
  assert.match(stderrOut, /\[warn\].*context\/partial-legacy\.md.*--confirm-activation/)
  assert.match(stderrOut, /\[warn\].*context\/invalid-meta\.md.*--confirm-activation/)

  const partialActivation = defaultPlanOut.activations.find(a => a.path === 'context/partial-legacy.md')
  assert.ok(partialActivation)
  assert.equal(partialActivation.skipped, true)
  assert.deepEqual(partialActivation.lenses, ['general', 'professional', 'interview', 'private'])
  assert.deepEqual(partialActivation.adapters, ['generic'])
  assert.equal(partialActivation.publication_allowed, false)

  const invalidActivation = defaultPlanOut.activations.find(a => a.path === 'context/invalid-meta.md')
  assert.ok(invalidActivation)
  assert.equal(invalidActivation.skipped, true)
  assert.deepEqual(invalidActivation.lenses, ['private'])
  assert.deepEqual(invalidActivation.adapters, ['generic'])

  // Apply default plan (with --confirm-narrowing for seeded docs): included-doc.md is migrated, excluded docs are untouched
  await capture(() => run(['migrate', 'policy', '--root', self, '--apply', defaultPlanOut.plan_id, '--confirm-narrowing']))
  assert.equal(await readFile(legacyCareerPath, 'utf8'), legacyCareerContent)
  assert.equal(await readFile(partialLegacyPath, 'utf8'), partialLegacyContent)
  assert.equal(await readFile(legacyPublicSafeOnlyPath, 'utf8'), legacyPublicSafeOnlyContent)
  assert.equal(await readFile(invalidMetaPath, 'utf8'), invalidMetaContent)
  const migratedIncluded = await readFile(includedDocPath, 'utf8')
  assert.match(migratedIncluded, /access_lenses: \[private\]/)
  assert.match(migratedIncluded, /read_scope: restricted/)

  // Revert default plan so we can compare plan_id digest with and without --confirm-activation on identical disk state
  await capture(() => run(['migrate', 'policy', '--root', self, '--revert', defaultPlanOut.plan_id]))
  const recheckDefaultPlan = planPolicyMigration(self, { dryRun: true })
  assert.equal(recheckDefaultPlan.plan_id, defaultPlanOut.plan_id)

  // Plan with --confirm-activation: digest changes and activations have skipped: false
  const confirmedPlanOut = JSON.parse(await capture(() => run(['migrate', 'policy', '--root', self, '--confirm-activation'])))
  assert.equal(confirmedPlanOut.confirm_activation, true)
  assert.notEqual(confirmedPlanOut.plan_id, defaultPlanOut.plan_id, 'plan digest must change when --confirm-activation is enabled')
  assert.equal(confirmedPlanOut.activations.length, 4)
  for (const act of confirmedPlanOut.activations) {
    assert.equal(act.skipped, false)
  }

  // Tampering with confirm_activation in saved plan file must fail digest verification
  const savedPlanPath = confirmedPlanOut.plan_file
  const savedPlan = JSON.parse(await readFile(savedPlanPath, 'utf8'))
  const tamperedPlan = { ...savedPlan, confirm_activation: false }
  assert.throws(() => applyPolicyMigration(self, tamperedPlan, { confirmNarrowing: true }), /migration plan digest mismatch/)

  // Apply with --confirm-activation: all 4 excluded documents are now migrated on disk to valid canonical metadata
  const applyConfirmedOut = JSON.parse(
    await capture(() => run(['migrate', 'policy', '--root', self, '--apply', confirmedPlanOut.plan_id, '--confirm-narrowing', '--confirm-activation']))
  )
  assert.equal(applyConfirmedOut.status, 'applied')
  assert.equal(applyConfirmedOut.activation_confirmed, true)

  for (const p of [legacyCareerPath, partialLegacyPath, legacyPublicSafeOnlyPath, invalidMetaPath]) {
    const updatedText = await readFile(p, 'utf8')
    const strictParsed = frontmatter(updatedText, { tolerant: false })
    assert.deepEqual(canonicalPrivacyMetadataErrors(strictParsed.metadata), [])
  }
  assert.match(await readFile(partialLegacyPath, 'utf8'), /access_lenses: \[general, professional, interview, private\]/)
  assert.match(await readFile(invalidMetaPath, 'utf8'), /access_lenses: \[private\]/)
  assert.match(await readFile(legacyCareerPath, 'utf8'), /access_lenses: \[private\]/)
})

test('catalog exclusion check respects _policy.yaml inheritance and still refuses widening on already-included documents', async () => {
  const self = await temp()
  await run(['init', '--root', self])

  // Directory with a broken _policy.yaml: incomplete document underneath is catalog-excluded and treated as activation
  const brokenDir = join(self, 'topics', 'broken-policy')
  await mkdir(brokenDir, { recursive: true })
  await writeFile(join(brokenDir, '_policy.yaml'), 'unknown_key: invalid\n')
  const excludedUnderBroken = join(brokenDir, 'incomplete.md')
  await writeFile(excludedUnderBroken, '---\ndocument_role: evidence\n---\n# Incomplete Under Broken Policy\n')

  const plan = planPolicyMigration(self, { dryRun: true })
  const act = plan.activations.find(a => a.path === 'topics/broken-policy/incomplete.md')
  assert.ok(act, 'document under broken _policy.yaml lacking required fields must be treated as catalog-excluded activation')
  assert.equal(act.skipped, true)
  assert.deepEqual(act.lenses, ['private'])
  assert.deepEqual(act.adapters, ['generic'])

  // Other widening (DENY -> ALLOW on an already-included document) is still refused even when confirmActivation: true
  const widenedCheck = verifyNonAmplification(
    '---\nvisibility: private\n---\n# Included Private\n',
    '---\nvisibility: private\nread_scope: shared\naccess_lenses: [general, private]\ndisclosure: internal-only\nsensitivity: personal\ndocument_role: content\n---\n# Widened\n',
    { selfRoot: self, confirmActivation: true }
  )
  assert.equal(widenedCheck.valid, false)
  assert.match(widenedCheck.violation, /DENY -> ALLOW/)
})
