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
import { frontmatter } from '../src/policy/privacy-fields.mjs'

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

  // Doc with visibility: linked-projects and access_lenses: [] is restricted to private by runtime frontmatter()
  const docPath = join(self, 'context', 'empty-lenses.md')
  await writeFile(docPath, '---\nvisibility: linked-projects\naccess_lenses: []\n---\n# Restricted\n')

  // Also test block-style empty access_lenses and other present-but-empty fields
  const emptyBlockPath = join(self, 'context', 'empty-block.md')
  await writeFile(emptyBlockPath, '---\nvisibility: public-safe\naccess_lenses:\n---\n# Restricted Block\n')

  const emptyVisPath = join(self, 'context', 'empty-vis.md')
  await writeFile(emptyVisPath, '---\nvisibility: ""\n---\n# Empty Visibility\n')

  const plan = planPolicyMigration(self, { dryRun: true })
  assert.equal(plan.summary.non_amplification_verified, true)
  assert.deepEqual(plan.summary.coverage_loss, {})

  for (const rel of ['context/empty-lenses.md', 'context/empty-block.md', 'context/empty-vis.md']) {
    const entry = plan.entries.find(e => e.path === rel)
    assert.ok(entry, `expected entry for ${rel}`)
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

  // Granting custom lens 'coaching' when it was not granted before is refused as amplification
  const customWidened = verifyNonAmplification(
    { visibility: 'linked-projects', read_scope: 'shared', access_lenses: ['general', 'private'] },
    { visibility: 'linked-projects', read_scope: 'shared', access_lenses: ['general', 'coaching', 'private'] },
    { selfRoot: self }
  )
  assert.equal(customWidened.valid, false)
  assert.match(customWidened.violation, /Cell \(coaching, .+\) transited DENY -> ALLOW/)

  // Preserving custom lens 'coaching' has 0 widening and 0 coverage loss
  const customExact = verifyNonAmplification(
    { visibility: 'linked-projects', read_scope: 'shared', access_lenses: ['general', 'coaching', 'private'] },
    { visibility: 'linked-projects', read_scope: 'shared', access_lenses: ['general', 'coaching', 'private'] },
    { selfRoot: self }
  )
  assert.equal(customExact.valid, true)
  assert.deepEqual(customExact.coverageLoss, {})

  // Removing custom lens 'coaching' is reported as coverage loss for 'coaching'
  const customNarrowed = verifyNonAmplification(
    { visibility: 'linked-projects', read_scope: 'shared', access_lenses: ['general', 'coaching', 'private'] },
    { visibility: 'linked-projects', read_scope: 'shared', access_lenses: ['general', 'private'] },
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

              // Parse BEFORE exactly as catalog parses it
              const beforeParsed = frontmatter(rawText, { tolerant: true, registry })
              const beforeMeta = beforeParsed.metadata

              // 1. Check the migration plan the tool would compute and apply
              const rawParsed = frontmatter(rawText, { tolerant: true, validatePrivacy: false, registry })
              const rawMeta = rawParsed.metadata
              const wasRestricted = beforeParsed.warnings.some(w => w.includes('restricted'))
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

              const afterText = Object.keys(changes).length > 0 ? applyFrontmatterModifications(rawText, changes) : rawText
              const afterParsed = frontmatter(afterText, { tolerant: true, registry })
              const afterMeta = afterParsed.metadata

              const planCheck = verifyNonAmplification(beforeMeta, afterMeta, { registry })
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

              // 2. Check exact runtime mapping: must have 0 widened and 0 false coverage loss
              const exactAfter = {
                ...beforeMeta,
                read_scope: ['shared', 'local', 'restricted'].includes(beforeMeta.read_scope)
                  ? beforeMeta.read_scope
                  : visibility(beforeMeta) === 'private'
                    ? 'restricted'
                    : 'shared',
                access_lenses: accessLenses(beforeMeta),
                disclosure: disclosure(beforeMeta),
                sensitivity: beforeMeta.sensitivity || 'personal',
                document_role: beforeMeta.document_role || 'content'
              }
              const exactCheck = verifyNonAmplification(beforeMeta, exactAfter, { registry })
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
  assert.equal(exactLegacyCombinations, 1728)
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
