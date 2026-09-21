import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from '../src/cli.mjs'
import { verifyNonAmplification, computeMeetMetadata } from '../src/migration.mjs'

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
    { visibility: 'linked-projects', read_scope: 'shared', access_lenses: ['general', 'career', 'publishing', 'technical', 'leadership', 'interview', 'private'] }
  )
  assert.equal(safe.valid, true)

  // Narrowing (career removes publishing, technical, leadership): allowed
  const narrowing = verifyNonAmplification(
    { visibility: 'career' },
    { visibility: 'career', read_scope: 'shared', access_lenses: ['general', 'career', 'interview', 'private'] }
  )
  assert.equal(narrowing.valid, true)

  // Amplification: private gaining access under general lens
  const amplified = verifyNonAmplification(
    { visibility: 'private' },
    { visibility: 'private', read_scope: 'shared', access_lenses: ['general', 'private'] }
  )
  assert.equal(amplified.valid, false)
  assert.match(amplified.violation, /DENY -> ALLOW/)
})

test('computeMeetMetadata derives minimal-privilege meet for self and project', () => {
  const selfPrivate = computeMeetMetadata({ visibility: 'private' }, 'self')
  assert.equal(selfPrivate.read_scope, 'restricted')
  assert.deepEqual(selfPrivate.access_lenses, ['private'])

  const selfLinked = computeMeetMetadata({ visibility: 'linked-projects' }, 'self')
  assert.equal(selfLinked.read_scope, 'shared')
  assert.ok(selfLinked.access_lenses.includes('general'))
  assert.ok(selfLinked.access_lenses.includes('technical'))
  assert.ok(selfLinked.access_lenses.includes('private'))

  const projLinked = computeMeetMetadata({ visibility: 'linked-projects' }, 'project')
  assert.equal(projLinked.read_scope, 'shared')
  assert.deepEqual(projLinked.access_lenses, ['general', 'technical'])
})

test('migrate policy dry-run plans migration without mutating files', async () => {
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

  // Create a document with visibility: career (which loses publishing, technical, leadership coverage)
  await writeFile(join(self, 'context', 'career-guide.md'), '---\nvisibility: career\n---\n# Career\nCareer details.\n')

  const planOutput = await capture(() => run(['migrate', 'policy', '--root', self]))
  const plan = JSON.parse(planOutput)
  assert.ok(plan.plan_id)

  // Attempt to apply without --confirm-narrowing
  await assert.rejects(
    run(['migrate', 'policy', '--root', self, '--apply', plan.plan_id]),
    /confirm-narrowing|NARROWING_CONFIRMATION_REQUIRED/
  )

  // Apply with --confirm-narrowing succeeds
  const applyOutput = await capture(() => run(['migrate', 'policy', '--root', self, '--apply', plan.plan_id, '--confirm-narrowing']))
  const receipt = JSON.parse(applyOutput)
  assert.equal(receipt.status, 'applied')
  assert.equal(receipt.narrowing_confirmed, true)

  // Verify file on disk now has read_scope and access_lenses
  const updated = await readFile(join(self, 'context', 'career-guide.md'), 'utf8')
  assert.match(updated, /read_scope:\s*shared/)
  assert.match(updated, /access_lenses:\s*\[.+\]/)
  assert.match(updated, /# Career\nCareer details\./)
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
