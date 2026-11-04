import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { run } from '../src/cli.mjs'
import {
  CONSERVATIVE_PRIVACY_DEFAULTS,
  applyValidateFixPlan,
  buildValidateFixPlan,
  contextData,
  excludedCanonicalDocuments,
  excludedIncompleteMetadataNotice,
  holoselfMcpContext
} from '../src/ecosystem.mjs'
import { startWebServer } from '../src/web-server.mjs'

function makeTempDir(prefix = 'holoself-validate-fix-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

async function runCliCapture(argv) {
  const prevLog = console.log
  const prevErr = console.error
  const prevCode = process.exitCode
  let stdout = ''
  let stderr = ''
  process.exitCode = 0
  console.log = (...args) => {
    stdout += args.join(' ') + '\n'
  }
  console.error = (...args) => {
    stderr += args.join(' ') + '\n'
  }
  try {
    await run(argv)
    return { stdout, stderr, exitCode: process.exitCode || 0 }
  } finally {
    console.log = prevLog
    console.error = prevErr
    process.exitCode = prevCode
  }
}

test('validate --fix plans conservative defaults for missing and invalid fields with exact frontmatter diff', async () => {
  const root = makeTempDir()
  try {
    await runCliCapture(['init', '--root', root])

    // 1. Document with no frontmatter at all
    const untaggedPath = join(root, 'context', 'untagged.md')
    writeFileSync(untaggedPath, '# Untagged note\n\nBody text stays untouched.\n')

    // 2. Document with invalid fields
    const invalidPath = join(root, 'profile', 'invalid-meta.md')
    writeFileSync(
      invalidPath,
      [
        '---',
        'access_lenses: [nonexistent-lens]',
        'disclosure: world-public',
        'sensitivity: top-secret-invalid',
        'document_role: blog',
        '---',
        '# Invalid metadata note',
        ''
      ].join('\n')
    )

    const cliRes = await runCliCapture(['validate', '--fix', '--root', root])
    assert.equal(cliRes.exitCode, 0)
    assert.match(cliRes.stdout, /2 canonical documents are excluded from context because their privacy metadata is incomplete — run `holoself validate --fix`/)
    assert.match(cliRes.stdout, /File: context\/untagged\.md/)
    assert.match(cliRes.stdout, /\+access_lenses: \[private\]/)
    assert.match(cliRes.stdout, /\+disclosure: internal-only/)
    assert.match(cliRes.stdout, /\+sensitivity: personal/)
    assert.match(cliRes.stdout, /\+document_role: content/)
    assert.match(cliRes.stdout, /File: profile\/invalid-meta\.md/)
    assert.match(cliRes.stdout, /invalid access_lenses value \["nonexistent-lens"\]; replaced with conservative \[private\]/)
    assert.match(cliRes.stdout, /invalid disclosure value world-public; replaced with conservative internal-only/)
    assert.match(cliRes.stdout, /invalid sensitivity value top-secret-invalid; replaced with conservative personal/)
    assert.match(cliRes.stdout, /invalid document_role value blog; replaced with conservative content/)

    const jsonRes = await runCliCapture(['validate', '--fix', '--json', '--root', root])
    const plan = JSON.parse(jsonRes.stdout)
    assert.equal(plan.excluded_count, 2)
    assert.match(plan.digest, /^[0-9a-f]{64}$/)

    const untaggedEntry = plan.files.find(f => f.path === 'context/untagged.md')
    assert.ok(untaggedEntry)
    assert.deepEqual(untaggedEntry.missing_fields, ['access_lenses', 'disclosure', 'sensitivity', 'document_role'])
    assert.deepEqual(untaggedEntry.invalid_fields, [])
    assert.deepEqual(untaggedEntry.proposed_metadata, {
      access_lenses: ['private'],
      disclosure: 'internal-only',
      sensitivity: 'personal',
      document_role: 'content'
    })
    assert.match(untaggedEntry.frontmatter_diff, /\+---/)
    assert.match(untaggedEntry.frontmatter_diff, /\+access_lenses: \[private\]/)

    const invalidEntry = plan.files.find(f => f.path === 'profile/invalid-meta.md')
    assert.ok(invalidEntry)
    assert.deepEqual(invalidEntry.missing_fields, [])
    assert.equal(invalidEntry.invalid_fields.length, 4)
    assert.deepEqual(invalidEntry.proposed_metadata, {
      access_lenses: ['private'],
      disclosure: 'internal-only',
      sensitivity: 'personal',
      document_role: 'content'
    })
    assert.match(invalidEntry.frontmatter_diff, /-access_lenses: \[nonexistent-lens\]/)
    assert.match(invalidEntry.frontmatter_diff, /\+access_lenses: \[private\]/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('validate --fix never widens existing valid privacy metadata fields', async () => {
  const root = makeTempDir()
  try {
    await runCliCapture(['init', '--root', root])

    // Document 1: has valid narrow sensitivity (restricted) and disclosure (review-required), missing access_lenses and document_role
    const narrowDoc = join(root, 'context', 'narrow.md')
    writeFileSync(
      narrowDoc,
      [
        '---',
        'sensitivity: restricted',
        'disclosure: review-required',
        '---',
        '# Narrow doc',
        ''
      ].join('\n')
    )

    // Document 2: has valid employer-confidential sensitivity, access_lenses: [private], document_role: evidence, missing disclosure
    const evidenceDoc = join(root, 'profile', 'evidence-note.md')
    writeFileSync(
      evidenceDoc,
      [
        '---',
        'access_lenses: [private]',
        'sensitivity: employer-confidential',
        'document_role: evidence',
        '---',
        '# Evidence note',
        ''
      ].join('\n')
    )

    // Document 3: has restricted sensitivity but wider access_lenses: [general] (invalid combination -> narrowed to [private])
    const conflictDoc = join(root, 'topics', 'conflict.md')
    writeFileSync(
      conflictDoc,
      [
        '---',
        'access_lenses: [general]',
        'disclosure: internal-only',
        'sensitivity: restricted',
        'document_role: content',
        '---',
        '# Conflict doc',
        ''
      ].join('\n')
    )

    const plan = buildValidateFixPlan(root)
    assert.equal(plan.excluded_count, 3)

    const narrowEntry = plan.files.find(f => f.path === 'context/narrow.md')
    assert.deepEqual(narrowEntry.kept_fields, ['disclosure', 'sensitivity'])
    assert.deepEqual(narrowEntry.missing_fields, ['access_lenses', 'document_role'])
    assert.equal(narrowEntry.proposed_metadata.sensitivity, 'restricted')
    assert.equal(narrowEntry.proposed_metadata.disclosure, 'review-required')
    assert.deepEqual(narrowEntry.proposed_metadata.access_lenses, ['private'])
    assert.equal(narrowEntry.proposed_metadata.document_role, 'content')

    const evidenceEntry = plan.files.find(f => f.path === 'profile/evidence-note.md')
    assert.deepEqual(evidenceEntry.kept_fields, ['access_lenses', 'sensitivity', 'document_role'])
    assert.deepEqual(evidenceEntry.missing_fields, ['disclosure'])
    assert.equal(evidenceEntry.proposed_metadata.sensitivity, 'employer-confidential')
    assert.equal(evidenceEntry.proposed_metadata.document_role, 'evidence')
    assert.equal(evidenceEntry.proposed_metadata.disclosure, 'internal-only')

    const conflictEntry = plan.files.find(f => f.path === 'topics/conflict.md')
    assert.equal(conflictEntry.proposed_metadata.sensitivity, 'restricted')
    assert.deepEqual(conflictEntry.proposed_metadata.access_lenses, ['private'])
    assert.equal(conflictEntry.invalid_fields.length, 1)
    assert.equal(conflictEntry.invalid_fields[0].field, 'access_lenses')

    // Apply and verify files on disk preserve narrow fields and pass `holoself validate`
    applyValidateFixPlan(root, plan, { expectedDigest: plan.digest })
    const narrowAfter = readFileSync(narrowDoc, 'utf8')
    assert.match(narrowAfter, /sensitivity: restricted/)
    assert.match(narrowAfter, /disclosure: review-required/)
    assert.match(narrowAfter, /access_lenses: \[private\]/)
    assert.match(narrowAfter, /document_role: content/)

    const valRes = await runCliCapture(['validate', '--root', root])
    assert.equal(valRes.exitCode, 0)
    assert.match(valRes.stdout, /\[ok\] .* is valid/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('validate --fix digest-bound apply, --out plan file, PLAN_CHANGED refusal, transactional rollback, and immutable receipt', async () => {
  const root = makeTempDir()
  try {
    await runCliCapture(['init', '--root', root])

    const docA = join(root, 'context', 'alpha.md')
    const docB = join(root, 'context', 'beta.md')
    writeFileSync(docA, '# Alpha\n')
    writeFileSync(docB, '# Beta\n')

    const planFile = join(root, 'fix-plan.json')
    const planRes = await runCliCapture(['validate', '--fix', '--out', planFile, '--json', '--root', root])
    assert.equal(planRes.exitCode, 0)
    assert.ok(existsSync(planFile))
    const savedPlan = JSON.parse(readFileSync(planFile, 'utf8'))
    assert.equal(savedPlan.excluded_count, 2)

    // Remove the temporary plan file before running validate later so markdownFiles doesn't see any stray files
    rmSync(planFile)

    // 1. Refuse wrong digest
    await assert.rejects(
      run(['validate', '--fix', '--apply', '--digest', '0'.repeat(64), '--yes', '--root', root]),
      /validate --fix plan digest mismatch/
    )

    // 2. Refuse non-TTY without --yes
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      await assert.rejects(
        run(['validate', '--fix', '--apply', '--digest', savedPlan.digest, '--root', root]),
        /Re-run with --yes to confirm/
      )
    }

    // 3. Refuse when a file changed since planning (PLAN_CHANGED)
    writeFileSync(docA, '# Alpha modified after planning\n')
    await assert.rejects(
      run(['validate', '--fix', '--apply', '--digest', savedPlan.digest, '--yes', '--root', root]),
      err => err.code === 'PLAN_CHANGED' && /PLAN_CHANGED/.test(err.message)
    )
    assert.equal(readFileSync(docB, 'utf8'), '# Beta\n')

    // Restore docA to original planned content
    writeFileSync(docA, '# Alpha\n')

    // 4. Transactional rollback if an error occurs mid-apply
    assert.throws(
      () =>
        applyValidateFixPlan(root, savedPlan, {
          expectedDigest: savedPlan.digest,
          afterWrite: op => {
            if (op.path === 'context/alpha.md') {
              throw new Error('simulated mid-apply write failure')
            }
          }
        }),
      /simulated mid-apply write failure/
    )
    // Verify context/alpha.md was rolled back to its exact before state and no receipt was written
    assert.equal(readFileSync(docA, 'utf8'), '# Alpha\n')
    assert.equal(readFileSync(docB, 'utf8'), '# Beta\n')
    assert.equal(existsSync(join(root, '.holoself', 'validate-fix-receipts', `${savedPlan.digest}.json`)), false)

    // 5. Apply cleanly via CLI and verify immutable receipt + idempotent replay
    const applyRes = await runCliCapture(['validate', '--fix', '--apply', '--digest', savedPlan.digest, '--yes', '--json', '--root', root])
    assert.equal(applyRes.exitCode, 0)
    const receipt = JSON.parse(applyRes.stdout)
    assert.equal(receipt.status, 'applied')
    assert.equal(receipt.plan_digest, savedPlan.digest)
    assert.equal(receipt.replayed, false)
    assert.equal(receipt.operations.length, 2)
    assert.ok(existsSync(receipt.receipt_path))

    // Replaying the same plan digest returns replayed: true
    const replay = applyValidateFixPlan(root, savedPlan, { expectedDigest: savedPlan.digest })
    assert.equal(replay.replayed, true)
    assert.equal(replay.plan_digest, savedPlan.digest)

    // Now holoself validate passes with 0 errors and 0 excluded files
    const valAfter = await runCliCapture(['validate', '--root', root])
    assert.equal(valAfter.exitCode, 0)
    assert.match(valAfter.stdout, /\[ok\] .* is valid/)
    assert.doesNotMatch(valAfter.stdout, /excluded from context/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('validate --fix offers directory _policy.yaml suggestions and --with-policy-files creates but never overwrites _policy.yaml', async () => {
  const root = makeTempDir()
  try {
    await runCliCapture(['init', '--root', root])

    // Directory 1: context/work has 2 files missing all 4 fields, and NO _policy.yaml
    const workDir = join(root, 'context', 'work')
    mkdirSync(workDir, { recursive: true })
    const workDoc1 = join(workDir, 'one.md')
    const workDoc2 = join(workDir, 'two.md')
    writeFileSync(workDoc1, '# Work one\n')
    writeFileSync(workDoc2, '# Work two\n')

    // Directory 2: topics/research has an EXISTING _policy.yaml with only access_lenses + disclosure,
    // and 2 files still missing sensitivity + document_role.
    const researchDir = join(root, 'topics', 'research')
    mkdirSync(researchDir, { recursive: true })
    const existingPolicyPath = join(researchDir, '_policy.yaml')
    const existingPolicyContent = 'access_lenses: [private]\ndisclosure: internal-only\n'
    writeFileSync(existingPolicyPath, existingPolicyContent)
    const resDoc1 = join(researchDir, 'paper-a.md')
    const resDoc2 = join(researchDir, 'paper-b.md')
    writeFileSync(resDoc1, '# Paper A\n')
    writeFileSync(resDoc2, '# Paper B\n')

    // Default plan offers context/work/_policy.yaml as a suggestion, and records topics/research/_policy.yaml in skipped_policy_files
    const defaultPlan = buildValidateFixPlan(root)
    assert.equal(defaultPlan.excluded_count, 4)
    assert.equal(defaultPlan.policy_suggestions.length, 1)
    assert.equal(defaultPlan.policy_suggestions[0].path, 'context/work/_policy.yaml')
    assert.deepEqual(defaultPlan.policy_suggestions[0].covered_files, ['context/work/one.md', 'context/work/two.md'])
    assert.deepEqual(defaultPlan.policy_suggestions[0].proposed_defaults, {
      access_lenses: ['private'],
      disclosure: 'internal-only',
      sensitivity: 'personal',
      document_role: 'content'
    })
    assert.equal(defaultPlan.skipped_policy_files.length, 1)
    assert.equal(defaultPlan.skipped_policy_files[0].path, 'topics/research/_policy.yaml')
    assert.match(defaultPlan.skipped_policy_files[0].reason, /never overwritten/)

    // Plan with --with-policy-files creates context/work/_policy.yaml instead of per-file frontmatter for context/work/*,
    // and falls back to per-file frontmatter for topics/research/* without touching topics/research/_policy.yaml
    const policyPlanRes = await runCliCapture(['validate', '--fix', '--with-policy-files', '--json', '--root', root])
    const policyPlan = JSON.parse(policyPlanRes.stdout)
    assert.equal(policyPlan.with_policy_files, true)
    assert.deepEqual(
      policyPlan.operations.map(op => ({ path: op.path, kind: op.kind })),
      [
        { path: 'context/work/_policy.yaml', kind: 'policy-file' },
        { path: 'topics/research/paper-a.md', kind: 'frontmatter' },
        { path: 'topics/research/paper-b.md', kind: 'frontmatter' }
      ]
    )

    // Test that if context/work/_policy.yaml is created before --apply, apply refuses with PLAN_CHANGED and never overwrites it
    const sneakyPolicyPath = join(workDir, '_policy.yaml')
    writeFileSync(sneakyPolicyPath, '# user created policy\naccess_lenses: [private]\n')
    await assert.rejects(
      run(['validate', '--fix', '--apply', '--with-policy-files', '--digest', policyPlan.digest, '--yes', '--root', root]),
      err => err.code === 'PLAN_CHANGED'
    )
    assert.equal(readFileSync(sneakyPolicyPath, 'utf8'), '# user created policy\naccess_lenses: [private]\n')
    rmSync(sneakyPolicyPath)

    // Apply --with-policy-files cleanly
    const applyRes = await runCliCapture([
      'validate',
      '--fix',
      '--apply',
      '--with-policy-files',
      '--digest',
      policyPlan.digest,
      '--yes',
      '--json',
      '--root',
      root
    ])
    assert.equal(applyRes.exitCode, 0)

    // Verify context/work/_policy.yaml was created and context/work/*.md were NOT modified
    assert.ok(existsSync(sneakyPolicyPath))
    assert.equal(readFileSync(workDoc1, 'utf8'), '# Work one\n')
    assert.equal(readFileSync(workDoc2, 'utf8'), '# Work two\n')

    // Verify topics/research/_policy.yaml was NEVER overwritten, and paper-a.md / paper-b.md got missing fields in frontmatter
    assert.equal(readFileSync(existingPolicyPath, 'utf8'), existingPolicyContent)
    assert.match(readFileSync(resDoc1, 'utf8'), /sensitivity: personal/)
    assert.match(readFileSync(resDoc1, 'utf8'), /document_role: content/)
    assert.doesNotMatch(readFileSync(resDoc1, 'utf8'), /access_lenses:/)

    // Verify holoself validate passes completely
    const valRes = await runCliCapture(['validate', '--root', root])
    assert.equal(valRes.exitCode, 0)
    assert.match(valRes.stdout, /\[ok\] .* is valid/)
    assert.equal(excludedCanonicalDocuments(root).length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('exclusion counts appear in doctor, validate, and owner-direct context_receipt, and are absent in linked context_receipt and MCP', async () => {
  const root = makeTempDir('holoself-excl-self-')
  const project = makeTempDir('holoself-excl-proj-')
  const prevCwd = process.cwd()
  try {
    await runCliCapture(['init', '--root', root])
    await runCliCapture(['link', 'add', '--project', project, '--self', root, '--lens', 'general', '--no-activate', '--yes'])

    // Add 2 canonical documents with incomplete privacy metadata
    writeFileSync(join(root, 'context', 'missing-one.md'), '# Missing 1\n')
    writeFileSync(join(root, 'history', 'missing-two.md'), '# Missing 2\n')

    const expectedLine = excludedIncompleteMetadataNotice(2)
    assert.equal(
      expectedLine,
      '2 canonical documents are excluded from context because their privacy metadata is incomplete — run `holoself validate --fix`'
    )

    // 1. holoself doctor prints the prominent count
    const docRes = await runCliCapture(['doctor', '--root', root])
    assert.ok(docRes.stdout.includes(expectedLine), `doctor output should include notice, got:\n${docRes.stdout}`)

    // 2. holoself validate prints the prominent count
    const valRes = await runCliCapture(['validate', '--root', root])
    assert.ok(valRes.stdout.includes(expectedLine), `validate output should include notice, got:\n${valRes.stdout}`)

    // 3. Owner-direct context_receipt includes excluded_incomplete_metadata: 2
    process.chdir(root)
    const ownerPacket = contextData({ root, rootExplicit: true, lens: 'private', args: [] })
    assert.equal(ownerPacket.context_receipt.excluded_incomplete_metadata, 2)

    // 4. Linked caller context_receipt MUST NOT include excluded_incomplete_metadata
    process.chdir(project)
    const linkedPacket = contextData({ project, args: [] })
    assert.equal(Object.hasOwn(linkedPacket.context_receipt, 'excluded_incomplete_metadata'), false)
    assert.equal(Object.hasOwn(linkedPacket, 'excluded_incomplete_metadata'), false)

    // 5. MCP context and manifest MUST NOT include excluded_incomplete_metadata
    const mcpFull = holoselfMcpContext(project, {})
    assert.equal(Object.hasOwn(mcpFull.context_receipt, 'excluded_incomplete_metadata'), false)
    assert.equal(Object.hasOwn(mcpFull, 'excluded_incomplete_metadata'), false)

    const mcpManifest = holoselfMcpContext(project, { manifest: true })
    assert.equal(Object.hasOwn(mcpManifest.context_receipt, 'excluded_incomplete_metadata'), false)
    assert.equal(Object.hasOwn(mcpManifest, 'excluded_incomplete_metadata'), false)

    // 6. After applying validate --fix, owner-direct context_receipt has excluded_incomplete_metadata: 0
    const plan = buildValidateFixPlan(root)
    applyValidateFixPlan(root, plan, { expectedDigest: plan.digest })

    process.chdir(root)
    const ownerPacketAfter = contextData({ root, rootExplicit: true, lens: 'private', args: [] })
    assert.equal(ownerPacketAfter.context_receipt.excluded_incomplete_metadata, 0)
  } finally {
    process.chdir(prevCwd)
    rmSync(root, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})

test('Workbench /api/overview is token-protected and returns excluded_incomplete_metadata count, and Overview UI links to Knowledge', async () => {
  const root = makeTempDir('holoself-web-excl-')
  let server = null
  try {
    await runCliCapture(['init', '--root', root])
    writeFileSync(join(root, 'context', 'incomplete-a.md'), '# Incomplete A\n')
    writeFileSync(join(root, 'profile', 'incomplete-b.md'), '---\naccess_lenses: [private]\n---\n# Incomplete B\n')

    server = await startWebServer({ root, project: root, port: 0 })
    const pageHtml = await (await fetch(server.url)).text()
    const token = pageHtml.match(/name="holoself-token" content="([^"]+)"/)?.[1]
    assert.ok(token, 'session token meta tag must be present')

    // Unauthenticated request to /api/overview is rejected with 403
    const forbiddenRes = await fetch(`${server.url}/api/overview`)
    assert.equal(forbiddenRes.status, 403)

    // Authenticated request returns excluded_incomplete_metadata: 2
    const overviewRes = await fetch(`${server.url}/api/overview`, {
      headers: { 'x-holoself-token': token }
    })
    assert.equal(overviewRes.status, 200)
    const overviewBody = await overviewRes.json()
    assert.equal(overviewBody.ok, true)
    assert.equal(overviewBody.data.excluded_incomplete_metadata, 2)

    // Fix the excluded documents and confirm /api/overview reports 0
    const plan = buildValidateFixPlan(root)
    applyValidateFixPlan(root, plan, { expectedDigest: plan.digest })

    const overviewAfterRes = await fetch(`${server.url}/api/overview`, {
      headers: { 'x-holoself-token': token }
    })
    const overviewAfterBody = await overviewAfterRes.json()
    assert.equal(overviewAfterBody.data.excluded_incomplete_metadata, 0)

    // Verify web/app.mjs renders excluded_incomplete_metadata in home() with a link/button to Knowledge
    const appJs = readFileSync(new URL('../web/app.mjs', import.meta.url), 'utf8')
    assert.match(appJs, /d\.excluded_incomplete_metadata/)
    assert.match(appJs, /data-go="knowledge"/)
  } finally {
    if (server) await new Promise(resolve => server.server.close(resolve))
    rmSync(root, { recursive: true, force: true })
  }
})
