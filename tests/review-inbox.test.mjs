// Workbench review inbox: cross-space pending inbox, deterministic duplicate grouping, conflict hints and atomic batch actions (issue #71).
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, rmSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { run } from '../src/cli.mjs'
import { ecosystemValidationErrors } from '../src/ecosystem.mjs'
import { legacyClaimId } from '../src/markdown/claim-blocks.mjs'
import { similarity } from '../src/proposals/analysis.mjs'
import {
  DEFAULT_INBOX_LIMIT,
  INBOX_DUPLICATE_THRESHOLD,
  MAX_CONFLICT_HINTS_PER_ITEM,
  MAX_HINT_EXCERPT_CHARS,
  MAX_INBOX_BATCH_SIZE,
  applyInboxBatch,
  buildReviewInbox,
  computeDuplicateGroups
} from '../src/proposals/inbox.mjs'
import { createProposal, proposalPreviewData, proposalText } from '../src/proposals/store.mjs'
import { slash } from '../src/shared/fs.mjs'
import { reconcileCatalog } from '../src/web/server-helpers.mjs'
import { startWebServer as startServer } from '../src/web-server.mjs'

const temp = () => mkdtemp(join(tmpdir(), 'holoself-inbox-'))
async function capture(fn) {
  const old = console.log
  let out = ''
  console.log = (...x) => {
    out += x.join(' ') + '\n'
  }
  try {
    await fn()
  } finally {
    console.log = old
  }
  return out
}

const FRONT = '---\naccess_lenses: [general, professional, private]\ndisclosure: internal-only\nsensitivity: personal\ndocument_role: content\n---\n'
const legacyBlock = (visibility, label, text) =>
  `<!-- holoself-claim visibility=${visibility} -->\n## Approved proposal legacy/${label}\n\n${text}\n\n- Evidence: synthetic notes\n` +
  `- Confidence: confirmed\n- Visibility: ${visibility}\n- Provenance: synthetic:notes.md\n- Approved: 2026-01-01T00:00:00.000Z\n<!-- /holoself-claim -->\n`

const CLAIM_METRIC = 'Leads a team of 5 platform reliability engineers across regulated systems.'
const CLAIM_MENTOR = 'Mentors 2 staff engineers on incident reviews.'

async function setupFixture() {
  const self = await temp(),
    projectA = await temp(),
    projectB = await temp()
  await capture(() => run(['init', '--root', self]))
  await writeFile(
    join(self, 'context', 'claims.md'),
    `${FRONT}# Claims\n\n${legacyBlock('professional', 'one', CLAIM_METRIC)}\n${legacyBlock('professional', 'two', CLAIM_MENTOR)}`
  )
  await mkdir(join(self, 'topics'), { recursive: true })
  await writeFile(
    join(self, 'topics', 'roles.md'),
    `${FRONT}# Roles\n\n${legacyBlock('professional', 'three', 'Owns the quarterly architecture review calendar.')}`
  )
  for (const proj of [projectA, projectB]) {
    await mkdir(join(proj, 'Context'), { recursive: true })
    await writeFile(join(proj, 'Context', 'evidence.md'), '# Evidence\n\nSynthetic project evidence for inbox review.\n')
    await capture(() => run(['link', 'add', '--project', proj, '--self', self, '--lens', 'professional', '--no-activate', '--yes']))
  }
  const catalog = reconcileCatalog(self),
    spaceEntryA = catalog.spaces.find(s => basename(s.path) === basename(projectA)),
    spaceEntryB = catalog.spaces.find(s => basename(s.path) === basename(projectB)),
    app = await startServer({ root: self, port: 0 }),
    origin = new URL(app.url).origin,
    call = async (path, { method = 'GET', body, token = app.token, customOrigin = origin, headers = {} } = {}) => {
      const reqHeaders = {
        ...(token !== null ? { 'x-holoself-token': token } : {}),
        ...(method === 'GET' ? {} : { ...(customOrigin !== null ? { origin: customOrigin } : {}), 'content-type': 'application/json' }),
        ...headers
      }
      const res = await globalThis.fetch(`${app.url}${path}`, {
        method,
        headers: reqHeaders,
        body: body !== undefined ? JSON.stringify(body) : undefined
      })
      const text = await res.text()
      let json = null
      try {
        json = JSON.parse(text)
      } catch {}
      return { status: res.status, text, json }
    }
  return {
    self,
    projectA,
    projectB,
    spaceA: basename(projectA),
    spaceB: basename(projectB),
    spaceIdA: spaceEntryA.id,
    spaceIdB: spaceEntryB.id,
    claimsPath: join(self, 'context', 'claims.md'),
    rolesPath: join(self, 'topics', 'roles.md'),
    ids: {
      metric: legacyClaimId('context/claims.md', CLAIM_METRIC),
      mentor: legacyClaimId('context/claims.md', CLAIM_MENTOR),
      roles: legacyClaimId('topics/roles.md', 'Owns the quarterly architecture review calendar.')
    },
    app,
    call,
    close: () => new Promise(done => app.server.close(done))
  }
}

function assertNoAbsolutePaths(text, forbiddenPaths = []) {
  for (const p of [...forbiddenPaths, tmpdir(), homedir()]) {
    if (!p) continue
    assert.equal(text.includes(p), false, `response leaked path ${p}: ${text}`)
    assert.equal(text.includes(p.replaceAll('\\', '/')), false, `response leaked normalized path ${p}: ${text}`)
  }
  assert.doesNotMatch(text, /(?:^|[\s("'=])\/(?:tmp|home|var|usr|etc|opt|root|Users|private)\b|(?<![A-Za-z0-9])[A-Za-z]:[\\/](?!\/)/)
}

test('GET /api/inbox aggregates pending proposals with duplicate groups, conflict hints, visibility changes, ID-only groups, lazy preview, and no absolute paths', async () => {
  const f = await setupFixture()
  try {
    const dupA = createProposal(f.projectA, {
        source_files: ['Context/evidence.md'],
        claim: 'Prefers written architecture decision records before major platform refactors.',
        visibility: 'professional'
      }),
      dupB = createProposal(f.projectB, {
        source_files: ['Context/evidence.md'],
        claim: 'Prefers written architecture decision records before major platform refactors!',
        visibility: 'professional'
      }),
      contradicting = createProposal(f.projectA, {
        source_files: ['Context/evidence.md'],
        claim: 'Leads a team of 14 platform reliability engineers across regulated systems.',
        visibility: 'professional'
      }),
      visChange = createProposal(f.projectB, {
        source_files: ['Context/evidence.md'],
        changes: [
          {
            operation: 'replace_claim',
            claim_id: f.ids.mentor,
            claim: 'Mentors staff engineers on public incident review practices.',
            evidence: 'Context/evidence.md',
            visibility: 'public-safe'
          }
        ]
      })

    const allRes = await f.call('/api/inbox?space=all')
    assert.equal(allRes.status, 200)
    assertNoAbsolutePaths(allRes.text, [f.self, f.projectA, f.projectB])

    const inbox = allRes.json.data
    assert.equal(inbox.duplicate_similarity_threshold, INBOX_DUPLICATE_THRESHOLD)
    assert.equal(inbox.items.length, 4)
    assert.equal(inbox.total, 4)
    assert.equal(inbox.truncated, false)

    // Groups list item IDs only (never full objects) and space groups are keyed by space_id.
    for (const g of inbox.groups) {
      assert.ok(Array.isArray(g.item_ids) && g.item_ids.length > 0)
      assert.ok(g.item_ids.every(id => typeof id === 'string'))
      assert.deepEqual(g.items, g.item_ids)
      if (g.kind === 'space') {
        assert.ok(g.space_id === f.spaceIdA || g.space_id === f.spaceIdB)
        assert.equal(g.group_id, `space-${g.space_id}`)
      }
    }

    const itemDupA = inbox.items.find(x => x.id === dupA.proposal_id),
      itemDupB = inbox.items.find(x => x.id === dupB.proposal_id),
      itemContra = inbox.items.find(x => x.id === contradicting.proposal_id),
      itemVis = inbox.items.find(x => x.id === visChange.proposal_id)

    assert.equal(itemDupA.space, f.spaceA)
    assert.equal(itemDupA.space_id, f.spaceIdA)
    assert.equal(itemDupB.space, f.spaceB)
    assert.equal(itemDupB.space_id, f.spaceIdB)
    assert.ok(itemDupA.duplicate_group && itemDupA.duplicate_group.startsWith('dup-'))
    assert.equal(itemDupA.duplicate_group, itemDupB.duplicate_group)
    assert.deepEqual(itemDupA.duplicate_of, [dupB.proposal_id])
    assert.deepEqual(itemDupB.duplicate_of, [dupA.proposal_id])

    assert.equal(itemContra.duplicate_group, null)
    assert.ok(itemContra.conflict_hints.some(h => h.kind === 'contradicts_current_claim' && /5.*14|14.*5/.test(h.evidence)))

    assert.deepEqual(itemVis.visibility_change, { from: 'professional', to: 'public-safe' })
    assert.deepEqual(itemVis.operations, ['replace_claim'])
    assert.deepEqual(itemVis.targets, ['context/claims.md'])
    // Full preview diff is lazy (not embedded in GET /api/inbox items), fetched on expand via existing preview route.
    assert.equal(itemVis.preview, undefined)
    assert.equal(itemVis.changes, undefined)

    const previewRes = await f.call(`/api/proposals/${visChange.proposal_id}/preview`, {
      method: 'POST',
      body: { project: f.projectB }
    })
    assert.equal(previewRes.status, 200)
    assert.match(previewRes.json.data.previewHash, /^[0-9a-f]{64}$/)
    assert.equal(previewRes.json.data.changes.length, 1)

    // Filter by catalog space_id (preferred) and by space name.
    const byIdRes = await f.call(`/api/inbox?space=${encodeURIComponent(f.spaceIdA)}`)
    assert.equal(byIdRes.status, 200)
    assertNoAbsolutePaths(byIdRes.text, [f.self, f.projectA, f.projectB])
    assert.ok(byIdRes.json.data.items.every(x => x.space_id === f.spaceIdA))
    assert.equal(byIdRes.json.data.items.length, 2)

    const byNameRes = await f.call(`/api/inbox?space=${encodeURIComponent(f.spaceA)}`)
    assert.equal(byNameRes.status, 200)
    assert.equal(byNameRes.json.data.items.length, 2)
  } finally {
    await f.close()
  }
})

test('duplicate grouping is deterministic and uses complete-linkage without transitive chaining (A~B, B~C != A~C)', async () => {
  const f = await setupFixture()
  try {
    const p1 = createProposal(f.projectA, {
        source_files: ['Context/evidence.md'],
        claim: 'Maintains deterministic local indexes without external database dependencies.'
      }),
      p2 = createProposal(f.projectB, {
        source_files: ['Context/evidence.md'],
        claim: 'Maintains deterministic local indexes without any external database dependencies.'
      }),
      p3 = createProposal(f.projectA, {
        source_files: ['Context/evidence.md'],
        claim: 'Uses explicit human review before adopting durable personal context.'
      })

    const inbox1 = buildReviewInbox(f.self, {
        spaces: [
          { id: '1', name: f.spaceA, path: f.projectA },
          { id: '2', name: f.spaceB, path: f.projectB }
        ]
      }),
      inbox2 = buildReviewInbox(f.self, {
        spaces: [
          { id: '2', name: f.spaceB, path: f.projectB },
          { id: '1', name: f.spaceA, path: f.projectA }
        ]
      })

    assert.deepEqual(
      inbox1.items.map(x => [x.id, x.duplicate_group, x.duplicate_of]),
      inbox2.items.map(x => [x.id, x.duplicate_group, x.duplicate_of])
    )
    const g1 = inbox1.items.find(x => x.id === p1.proposal_id).duplicate_group,
      g2 = inbox1.items.find(x => x.id === p2.proposal_id).duplicate_group,
      g3 = inbox1.items.find(x => x.id === p3.proposal_id).duplicate_group
    assert.ok(g1 && g1 === g2)
    assert.equal(g3, null)

    const reversedMap = computeDuplicateGroups([...inbox1.items].reverse().map(x => ({ ...x, _normClaim: x.claim_preview.toLowerCase() })))
    assert.equal(reversedMap.get(p1.proposal_id).group_id, reversedMap.get(p2.proposal_id).group_id)

    // Non-transitive check: A~B (0.80 >= 0.72) and B~C (0.80 >= 0.72), but A~C (0.60 < 0.72).
    const claimA = 'alpha beta gamma delta epsilon zeta eta theta',
      claimB = 'alpha beta gamma delta epsilon zeta eta theta iota kappa',
      claimC = 'gamma delta epsilon zeta eta theta iota kappa'
    assert.ok(similarity(claimA, claimB) >= INBOX_DUPLICATE_THRESHOLD)
    assert.ok(similarity(claimB, claimC) >= INBOX_DUPLICATE_THRESHOLD)
    assert.ok(similarity(claimA, claimC) < INBOX_DUPLICATE_THRESHOLD)

    const chainMap = computeDuplicateGroups([
      { id: 'id-a', _normClaim: claimA },
      { id: 'id-b', _normClaim: claimB },
      { id: 'id-c', _normClaim: claimC }
    ])
    const dupA = chainMap.get('id-a'),
      dupB = chainMap.get('id-b'),
      dupC = chainMap.get('id-c')
    assert.ok(dupA && dupB && dupA.group_id === dupB.group_id)
    assert.equal(dupC, undefined, 'C must not chain transitively into {A, B} when similarity(A, C) < threshold')
  } finally {
    await f.close()
  }
})

test('conflict hints are capped at top 3 by score and excerpts are truncated to <= 200 chars', async () => {
  const f = await setupFixture()
  try {
    const longPadding = 'regulated distributed reliability engineering architecture governance '.repeat(6).trim()
    const claimsDoc = [
      FRONT,
      '# Claims',
      legacyBlock('professional', 'c1', `Leads a team of 3 platform reliability engineers across systems ${longPadding}`),
      legacyBlock('professional', 'c2', `Leads a team of 4 platform reliability engineers across systems ${longPadding}`),
      legacyBlock('professional', 'c3', `Leads a team of 6 platform reliability engineers across systems ${longPadding}`),
      legacyBlock('professional', 'c4', `Leads a team of 7 platform reliability engineers across systems ${longPadding}`),
      legacyBlock('professional', 'c5', `Leads a team of 9 platform reliability engineers across systems ${longPadding}`)
    ].join('\n\n')
    await writeFile(f.claimsPath, claimsDoc)

    const p = createProposal(f.projectA, {
      source_files: ['Context/evidence.md'],
      claim: `Leads a team of 12 platform reliability engineers across systems ${longPadding}`,
      visibility: 'professional'
    })

    const res = await f.call('/api/inbox?space=all')
    assert.equal(res.status, 200)
    const item = res.json.data.items.find(x => x.id === p.proposal_id)
    assert.equal(item.conflict_hints.length, MAX_CONFLICT_HINTS_PER_ITEM)
    for (let i = 0; i < item.conflict_hints.length; i++) {
      const h = item.conflict_hints[i]
      assert.ok(h.existing_claim.length <= MAX_HINT_EXCERPT_CHARS, `existing_claim exceeded 200 chars: ${h.existing_claim.length}`)
      assert.ok(h.detail.length <= MAX_HINT_EXCERPT_CHARS, `detail exceeded 200 chars: ${h.detail.length}`)
      if (i > 0) assert.ok(item.conflict_hints[i - 1].score >= h.score)
    }
  } finally {
    await f.close()
  }
})

test('conflicting pending operations on the same claim_id are flagged and the second approval is refused', async () => {
  const f = await setupFixture()
  try {
    const supersedeProp = createProposal(f.projectA, {
        source_files: ['Context/evidence.md'],
        changes: [
          {
            operation: 'supersede_claim',
            claim_id: f.ids.metric,
            claim: 'Leads a team of 8 platform reliability engineers across regulated systems.',
            evidence: 'Context/evidence.md'
          }
        ]
      }),
      retireProp = createProposal(f.projectB, {
        source_files: ['Context/evidence.md'],
        changes: [
          {
            operation: 'retire_claim',
            claim_id: f.ids.metric,
            reason: 'Role transitioned to architecture group.',
            evidence: 'Context/evidence.md'
          }
        ]
      }),
      prevSup = proposalPreviewData(f.projectA, supersedeProp.proposal_id),
      prevRet = proposalPreviewData(f.projectB, retireProp.proposal_id)

    const inboxRes = await f.call('/api/inbox?space=all')
    assert.equal(inboxRes.status, 200)
    const itemSup = inboxRes.json.data.items.find(x => x.id === supersedeProp.proposal_id),
      itemRet = inboxRes.json.data.items.find(x => x.id === retireProp.proposal_id)

    assert.ok(
      itemSup.conflict_hints.some(
        h => h.kind === 'competing_pending_claim' && h.claim_id === f.ids.metric && h.conflicting_proposal_id === retireProp.proposal_id
      )
    )
    assert.ok(
      itemRet.conflict_hints.some(
        h => h.kind === 'competing_pending_claim' && h.claim_id === f.ids.metric && h.conflicting_proposal_id === supersedeProp.proposal_id
      )
    )

    // Attempting to approve both conflicting proposals in a single batch is refused all-or-nothing.
    const claimsBefore = await readFile(f.claimsPath, 'utf8')
    const bothBatch = await f.call('/api/inbox/batch', {
      method: 'POST',
      body: {
        action: 'approve',
        items: [
          { id: itemSup.id, space: itemSup.space_id, preview_hash: prevSup.preview_hash },
          { id: itemRet.id, space: itemRet.space_id, preview_hash: prevRet.preview_hash }
        ]
      }
    })
    assert.equal(bothBatch.status, 400)
    assert.equal(bothBatch.json.error.code, 'CLAIM_NOT_CURRENT')
    assert.equal(await readFile(f.claimsPath, 'utf8'), claimsBefore)
    assert.equal(existsSync(join(f.self, 'proposals', 'approved', `${itemSup.id}.yaml`)), false)
    assert.equal(existsSync(join(f.self, 'proposals', 'receipts', `${itemSup.id}-approved.json`)), false)

    // Approving the first proposal succeeds; approving the second afterwards is refused.
    const firstBatch = await f.call('/api/inbox/batch', {
      method: 'POST',
      body: {
        action: 'approve',
        items: [{ id: itemSup.id, space: itemSup.space_id, preview_hash: prevSup.preview_hash }]
      }
    })
    assert.equal(firstBatch.status, 200)
    assertNoAbsolutePaths(firstBatch.text, [f.self, f.projectA, f.projectB])

    const secondBatch = await f.call('/api/inbox/batch', {
      method: 'POST',
      body: {
        action: 'approve',
        items: [{ id: itemRet.id, space: itemRet.space_id, preview_hash: prevRet.preview_hash }]
      }
    })
    assert.equal(secondBatch.status, 400)
    assert.equal(secondBatch.json.error.code, 'CLAIM_NOT_CURRENT')
  } finally {
    await f.close()
  }
})

test('batch approve is all-or-nothing, cleans up created empty dirs, gates test env var on NODE_TEST_CONTEXT, and reports ROLLBACK_INCOMPLETE on restore failure', async t => {
  const f = await setupFixture()
  try {
    const p1 = createProposal(f.projectA, {
        source_files: ['Context/evidence.md'],
        target: 'topics/nested-a/nested-b/new-claims.md',
        claim: 'Uses deterministic simulation tests for transactional storage paths.',
        visibility: 'professional'
      }),
      p2 = createProposal(f.projectB, {
        source_files: ['Context/evidence.md'],
        changes: [
          {
            operation: 'retire_claim',
            target: 'topics/roles.md',
            claim_id: f.ids.roles,
            reason: 'Quarterly calendar replaced by continuous review.',
            evidence: 'Context/evidence.md'
          }
        ]
      }),
      prev1 = proposalPreviewData(f.projectA, p1.proposal_id),
      prev2 = proposalPreviewData(f.projectB, p2.proposal_id),
      nestedTarget = join(f.self, 'topics', 'nested-a', 'nested-b', 'new-claims.md'),
      nestedDirA = join(f.self, 'topics', 'nested-a'),
      nestedDirB = join(f.self, 'topics', 'nested-a', 'nested-b'),
      rolesBefore = await readFile(f.rolesPath, 'utf8'),
      prop1Path = join(f.projectA, '.holoself', 'proposals', `${p1.proposal_id}.yaml`),
      prop2Path = join(f.projectB, '.holoself', 'proposals', `${p2.proposal_id}.yaml`),
      prop1Before = await readFile(prop1Path, 'utf8'),
      prop2Before = await readFile(prop2Path, 'utf8'),
      archive1 = join(f.self, 'proposals', 'approved', `${p1.proposal_id}.yaml`),
      receipt1 = join(f.self, 'proposals', 'receipts', `${p1.proposal_id}-approved.json`),
      archive2 = join(f.self, 'proposals', 'approved', `${p2.proposal_id}.yaml`),
      receipt2 = join(f.self, 'proposals', 'receipts', `${p2.proposal_id}-approved.json`)

    // 1. Direct failure injection after item 1 has created nested target dirs, archive and receipt.
    let item1WrittenBeforeFailure = false
    await assert.rejects(
      applyInboxBatch(f.self, {
        action: 'approve',
        items: [
          { id: p1.proposal_id, space: f.spaceIdA, preview_hash: prev1.preview_hash },
          { id: p2.proposal_id, space: f.spaceIdB, preview_hash: prev2.preview_hash }
        ],
        onItemApplied(index) {
          if (index === 0) {
            item1WrittenBeforeFailure = existsSync(nestedTarget) && existsSync(archive1) && existsSync(receipt1)
          }
          if (index === 1) throw new Error('injected failure on 2nd batch item')
        }
      }),
      /injected failure on 2nd batch item/
    )
    assert.equal(item1WrittenBeforeFailure, true, 'item 1 target, archive and receipt were written before item 2 failed')
    assert.equal(existsSync(nestedTarget), false)
    assert.equal(existsSync(nestedDirB), false, 'created empty child directory removed on rollback')
    assert.equal(existsSync(nestedDirA), false, 'created empty parent directory removed on rollback')
    assert.equal(existsSync(join(f.self, 'topics')), true, 'pre-existing topics/ directory preserved')
    assert.equal(await readFile(f.rolesPath, 'utf8'), rolesBefore)
    assert.equal(await readFile(prop1Path, 'utf8'), prop1Before)
    assert.equal(await readFile(prop2Path, 'utf8'), prop2Before)
    assert.equal(existsSync(archive1), false)
    assert.equal(existsSync(receipt1), false)
    assert.equal(existsSync(archive2), false)
    assert.equal(existsSync(receipt2), false)

    // 2. HTTP batch failure injection on the 2nd item via HOLOSELF_TEST_FAIL_BATCH_ITEM=2.
    process.env.HOLOSELF_TEST_FAIL_BATCH_ITEM = '2'
    try {
      const failRes = await f.call('/api/inbox/batch', {
        method: 'POST',
        body: {
          action: 'approve',
          items: [
            { id: p1.proposal_id, space: f.spaceIdA, preview_hash: prev1.preview_hash },
            { id: p2.proposal_id, space: f.spaceIdB, preview_hash: prev2.preview_hash }
          ]
        }
      })
      assert.equal(failRes.status, 400)
      assert.equal(failRes.json.error.code, 'BATCH_ITEM_FAILED')
    } finally {
      delete process.env.HOLOSELF_TEST_FAIL_BATCH_ITEM
    }
    assert.equal(existsSync(nestedTarget), false)
    assert.equal(existsSync(nestedDirA), false)
    assert.equal(existsSync(archive1), false)
    assert.equal(existsSync(receipt1), false)

    // 3. Rollback failure surfaces ROLLBACK_INCOMPLETE listing affected root-relative paths while still completing other restores.
    const blockerFile = join(nestedTarget, 'blocker.txt')
    try {
      await assert.rejects(
        applyInboxBatch(f.self, {
          action: 'approve',
          items: [
            { id: p1.proposal_id, space: f.spaceIdA, preview_hash: prev1.preview_hash },
            { id: p2.proposal_id, space: f.spaceIdB, preview_hash: prev2.preview_hash }
          ],
          async onItemApplied(index) {
            if (index === 0) {
              // Replace the newly written file with a non-empty directory so non-recursive rmSync(snap.target) fails on rollback.
              rmSync(nestedTarget, { force: true })
              await mkdir(nestedTarget, { recursive: true })
              await writeFile(blockerFile, 'block restore')
            }
            if (index === 1) throw new Error('trigger rollback after target obstruction')
          }
        }),
        err => {
          assert.equal(err.code, 'ROLLBACK_INCOMPLETE')
          assert.ok(Array.isArray(err.affected_paths))
          assert.ok(err.affected_paths.includes('topics/nested-a/nested-b/new-claims.md'))
          assert.match(err.message, /topics\/nested-a\/nested-b\/new-claims\.md/)
          assertNoAbsolutePaths(err.message, [f.self, f.projectA, f.projectB])
          return true
        }
      )
      // Proposal file, archive, and receipt for item 1 were still rolled back despite target restore failure!
      assert.equal(await readFile(prop1Path, 'utf8'), prop1Before)
      assert.equal(existsSync(archive1), false)
      assert.equal(existsSync(receipt1), false)
    } finally {
      rmSync(nestedDirA, { recursive: true, force: true })
    }

    // 4. HOLOSELF_TEST_FAIL_BATCH_ITEM is ignored when NODE_TEST_CONTEXT is not set, and successful batch approve writes targets & receipts.
    const savedTestCtx = process.env.NODE_TEST_CONTEXT
    process.env.HOLOSELF_TEST_FAIL_BATCH_ITEM = '1'
    delete process.env.NODE_TEST_CONTEXT
    try {
      const okRes = await f.call('/api/inbox/batch', {
        method: 'POST',
        body: {
          action: 'approve',
          items: [
            { id: p1.proposal_id, space: f.spaceIdA, preview_hash: prev1.preview_hash },
            { id: p2.proposal_id, space: f.spaceIdB, preview_hash: prev2.preview_hash }
          ]
        }
      })
      assert.equal(okRes.status, 200)
      assertNoAbsolutePaths(okRes.text, [f.self, f.projectA, f.projectB])
      assert.equal(okRes.json.data.count, 2)
    } finally {
      if (savedTestCtx !== undefined) process.env.NODE_TEST_CONTEXT = savedTestCtx
      delete process.env.HOLOSELF_TEST_FAIL_BATCH_ITEM
    }
    assert.equal(existsSync(archive1), true)
    assert.equal(existsSync(receipt1), true)
    assert.equal(existsSync(archive2), true)
    assert.equal(existsSync(receipt2), true)
    const r1 = JSON.parse(await readFile(receipt1, 'utf8')),
      r2 = JSON.parse(await readFile(receipt2, 'utf8'))
    assert.equal(r1.decision, 'approved')
    assert.equal(r1.preview_sha256, prev1.preview_hash)
    assert.equal(r1.batch_preview_sha256, prev1.preview_hash)
    assert.equal(r2.decision, 'approved')
    assert.equal(r2.preview_sha256, prev2.preview_hash)
    assert.equal(r2.batch_preview_sha256, prev2.preview_hash)
    assert.deepEqual(ecosystemValidationErrors(f.self), [])
  } finally {
    await f.close()
  }
})

test('stale or missing preview_hash in one item refuses the entire batch with 409 STALE_PREVIEW', async () => {
  const f = await setupFixture()
  try {
    const p1 = createProposal(f.projectA, {
        source_files: ['Context/evidence.md'],
        claim: 'Documents every architectural trade-off in repository decision records.',
        visibility: 'professional'
      }),
      p2 = createProposal(f.projectB, {
        source_files: ['Context/evidence.md'],
        claim: 'Keeps runtime dependencies at zero across CLI and Workbench.',
        visibility: 'professional'
      }),
      prev1 = proposalPreviewData(f.projectA, p1.proposal_id),
      claimsBefore = await readFile(f.claimsPath, 'utf8')

    const staleRes = await f.call('/api/inbox/batch', {
      method: 'POST',
      body: {
        action: 'approve',
        items: [
          { id: p1.proposal_id, space: f.spaceIdA, preview_hash: prev1.preview_hash },
          { id: p2.proposal_id, space: f.spaceIdB, preview_hash: '0'.repeat(64) }
        ]
      }
    })
    assert.equal(staleRes.status, 409)
    assert.equal(staleRes.json.error.code, 'STALE_PREVIEW')
    assert.equal(await readFile(f.claimsPath, 'utf8'), claimsBefore)
    assert.equal(existsSync(join(f.self, 'proposals', 'approved', `${p1.proposal_id}.yaml`)), false)
    assert.equal(existsSync(join(f.self, 'proposals', 'receipts', `${p1.proposal_id}-approved.json`)), false)

    const missingHashRes = await f.call('/api/inbox/batch', {
      method: 'POST',
      body: {
        action: 'approve',
        items: [
          { id: p1.proposal_id, space: f.spaceIdA, preview_hash: prev1.preview_hash },
          { id: p2.proposal_id, space: f.spaceIdB }
        ]
      }
    })
    assert.equal(missingHashRes.status, 409)
    assert.equal(missingHashRes.json.error.code, 'STALE_PREVIEW')
    assert.equal(await readFile(f.claimsPath, 'utf8'), claimsBefore)
  } finally {
    await f.close()
  }
})

test('HTTP space resolution is strictly limited to catalog id or name; CLI allows 1-entry path; invalid input types return 400 INVALID_INPUT', async () => {
  const f = await setupFixture(),
    otherSelf = await temp(),
    otherProject = await temp(),
    uncatalogedSameRoot = await temp()
  try {
    await capture(() => run(['init', '--root', otherSelf]))
    await mkdir(join(otherProject, 'Context'), { recursive: true })
    await writeFile(join(otherProject, 'Context', 'evidence.md'), '# Foreign evidence\n\nEvidence in another root.\n')
    await capture(() => run(['link', 'add', '--project', otherProject, '--self', otherSelf, '--lens', 'professional', '--no-activate', '--yes']))

    // Create a linked space pointing at f.self, create a proposal, then unbind it so it is not in the catalog.
    await mkdir(join(uncatalogedSameRoot, 'Context'), { recursive: true })
    await writeFile(join(uncatalogedSameRoot, 'Context', 'evidence.md'), '# Uncataloged evidence\n')
    await capture(() =>
      run(['link', 'add', '--project', uncatalogedSameRoot, '--self', f.self, '--lens', 'professional', '--no-activate', '--yes'])
    )
    const pUncat = createProposal(uncatalogedSameRoot, {
        source_files: ['Context/evidence.md'],
        claim: 'Proposal from uncataloged folder pointing at same self root.'
      }),
      prevUncat = proposalPreviewData(uncatalogedSameRoot, pUncat.proposal_id)
    await capture(() => run(['lens', 'unbind', '--root', f.self, '--project', uncatalogedSameRoot, '--yes']))
    reconcileCatalog(f.self)

    const p1 = createProposal(f.projectA, {
        source_files: ['Context/evidence.md'],
        claim: 'Validates every proposal against its linked canonical self root.',
        visibility: 'professional'
      }),
      prev1 = proposalPreviewData(f.projectA, p1.proposal_id)

    // 1. Over HTTP GET /api/inbox, passing an absolute path (cataloged or uncataloged) is rejected with 400 SPACE_NOT_FOUND (no existence probe).
    for (const absPath of [f.projectA, otherProject, uncatalogedSameRoot, '/nonexistent/path/probe']) {
      const res = await f.call(`/api/inbox?space=${encodeURIComponent(absPath)}`)
      assert.equal(res.status, 400)
      assert.equal(res.json.error.code, 'SPACE_NOT_FOUND')
      assertNoAbsolutePaths(res.text, [f.self, otherSelf, f.projectA, otherProject, uncatalogedSameRoot])
    }

    // 2. Over HTTP POST /api/inbox/batch, passing an absolute path (even for cataloged projectA or uncatalogedSameRoot) is rejected with 400 SPACE_NOT_FOUND.
    for (const [id, spaceVal, hashVal] of [
      [p1.proposal_id, f.projectA, prev1.preview_hash],
      [pUncat.proposal_id, uncatalogedSameRoot, prevUncat.preview_hash],
      [pUncat.proposal_id, basename(uncatalogedSameRoot), prevUncat.preview_hash]
    ]) {
      const res = await f.call('/api/inbox/batch', {
        method: 'POST',
        body: { action: 'approve', items: [{ id, space: spaceVal, preview_hash: hashVal }] }
      })
      assert.equal(res.status, 400)
      assert.equal(res.json.error.code, 'SPACE_NOT_FOUND')
      assertNoAbsolutePaths(res.text, [f.self, f.projectA, uncatalogedSameRoot])
    }

    // Also verify applyInboxBatch rejects a bound project path when it is omitted from the passed catalog spaces.
    await assert.rejects(
      applyInboxBatch(f.self, {
        action: 'approve',
        items: [{ id: p1.proposal_id, space: f.projectA, preview_hash: prev1.preview_hash }],
        spaces: [{ id: f.spaceIdB, name: f.spaceB, path: f.projectB, discoveredFrom: 'lenses/bindings.json' }],
        allowAbsoluteSpace: false
      }),
      err => err.code === 'SPACE_NOT_FOUND'
    )

    // 3. Invalid input types (object space, object id, non-hex preview_hash) return 400 INVALID_INPUT (never 500 TypeError).
    const invalidPayloads = [
      { action: 'defer', items: [{ id: p1.proposal_id, space: {} }] },
      { action: 'defer', items: [{ id: p1.proposal_id, space: { toString: null } }] },
      { action: 'defer', items: [{ id: p1.proposal_id, space: 123 }] },
      { action: 'defer', items: [{ id: {}, space: f.spaceIdA }] },
      { action: 'defer', items: [{ id: { toString: null }, space: f.spaceIdA }] },
      { action: 'defer', items: [{ id: 123, space: f.spaceIdA }] },
      { action: 'approve', items: [{ id: p1.proposal_id, space: f.spaceIdA, preview_hash: {} }] },
      { action: 'approve', items: [{ id: p1.proposal_id, space: f.spaceIdA, preview_hash: 12345 }] },
      { action: 'approve', items: [{ id: p1.proposal_id, space: f.spaceIdA, preview_hash: 'not-a-valid-hex-hash' }] },
      { action: 'approve', items: [{ id: p1.proposal_id, space: f.spaceIdA, preview_hash: 'abcd1234' }] }
    ]
    for (const payload of invalidPayloads) {
      const res = await f.call('/api/inbox/batch', { method: 'POST', body: payload })
      assert.equal(res.status, 400, `expected 400 for payload ${JSON.stringify(payload)}, got ${res.status}: ${res.text}`)
      assert.equal(res.json.error.code, 'INVALID_INPUT')
    }

    // 4. When a cataloged space's link.yaml points at a foreign self root, both GET /api/inbox and POST /api/inbox/batch return 400 MIXED_SELF_ROOTS.
    const linkBPath = join(f.projectB, '.holoself', 'link.yaml'),
      linkBBefore = await readFile(linkBPath, 'utf8')
    try {
      await capture(() => run(['lens', 'bind', '--root', otherSelf, '--project', f.projectB, '--lens', 'professional', '--yes']))
      await writeFile(linkBPath, await readFile(join(otherProject, '.holoself', 'link.yaml'), 'utf8'))
      const getMixed = await f.call('/api/inbox?space=all')
      assert.equal(getMixed.status, 400)
      assert.equal(getMixed.json.error.code, 'MIXED_SELF_ROOTS')

      const postMixed = await f.call('/api/inbox/batch', {
        method: 'POST',
        body: {
          action: 'defer',
          items: [{ id: p1.proposal_id, space: f.spaceIdB }]
        }
      })
      assert.equal(postMixed.status, 400)
      assert.equal(postMixed.json.error.code, 'MIXED_SELF_ROOTS')
    } finally {
      await writeFile(linkBPath, linkBBefore)
    }

    // 5. Oversized batch (> MAX_INBOX_BATCH_SIZE) is refused.
    const oversized = Array.from({ length: MAX_INBOX_BATCH_SIZE + 1 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      space: f.spaceIdA,
      preview_hash: '0'.repeat(64)
    }))
    const capRes = await f.call('/api/inbox/batch', {
      method: 'POST',
      body: { action: 'defer', items: oversized }
    })
    assert.equal(capRes.status, 400)
    assert.equal(capRes.json.error.code, 'BATCH_TOO_LARGE')

    // 6. Malformed ui/catalog.json does not crash web-server error handler.
    const catalogFile = join(f.self, 'ui', 'catalog.json'),
      catalogBefore = await readFile(catalogFile, 'utf8')
    try {
      await writeFile(catalogFile, '{"spaces": null}\n')
      const badReq = await f.call('/api/proposals?project=')
      assert.equal(badReq.status, 400)
      assert.equal(badReq.json.error.code, 'INVALID_INPUT')
    } finally {
      await writeFile(catalogFile, catalogBefore)
    }
  } finally {
    await f.close()
  }
})

test('spaces sharing the same basename are disambiguated by space_id in groups, filters, and batch actions', async () => {
  const f = await setupFixture(),
    parent1 = await temp(),
    parent2 = await temp(),
    sameName1 = join(parent1, 'shared-app'),
    sameName2 = join(parent2, 'shared-app')
  try {
    for (const proj of [sameName1, sameName2]) {
      await mkdir(join(proj, 'Context'), { recursive: true })
      await writeFile(join(proj, 'Context', 'evidence.md'), '# Shared-name evidence\n')
      await capture(() => run(['link', 'add', '--project', proj, '--self', f.self, '--lens', 'professional', '--no-activate', '--yes']))
    }
    const pSame1 = createProposal(sameName1, {
        source_files: ['Context/evidence.md'],
        claim: 'First distinct claim from shared-app workspace one.'
      }),
      pSame2 = createProposal(sameName2, {
        source_files: ['Context/evidence.md'],
        claim: 'Second unrelated claim from shared-app workspace two.'
      }),
      prevSame1 = proposalPreviewData(sameName1, pSame1.proposal_id)

    const inboxRes = await f.call('/api/inbox?space=all')
    assert.equal(inboxRes.status, 200)
    const inbox = inboxRes.json.data,
      item1 = inbox.items.find(x => x.id === pSame1.proposal_id),
      item2 = inbox.items.find(x => x.id === pSame2.proposal_id)

    assert.equal(item1.space, 'shared-app')
    assert.equal(item2.space, 'shared-app')
    assert.notEqual(item1.space_id, item2.space_id)

    const group1 = inbox.groups.find(g => g.group_id === `space-${item1.space_id}`),
      group2 = inbox.groups.find(g => g.group_id === `space-${item2.space_id}`)
    assert.ok(group1 && group2)
    assert.deepEqual(group1.item_ids, [pSame1.proposal_id])
    assert.deepEqual(group2.item_ids, [pSame2.proposal_id])

    const filter1 = await f.call(`/api/inbox?space=${encodeURIComponent(item1.space_id)}`)
    assert.equal(filter1.status, 200)
    assert.deepEqual(filter1.json.data.items.map(x => x.id), [pSame1.proposal_id])

    const approve1 = await f.call('/api/inbox/batch', {
      method: 'POST',
      body: {
        action: 'approve',
        items: [{ id: pSame1.proposal_id, space: item1.space_id, preview_hash: prevSame1.preview_hash }]
      }
    })
    assert.equal(approve1.status, 200)
    assert.equal(approve1.json.data.results[0].space_id, item1.space_id)
  } finally {
    await f.close()
  }
})

test('batch defer and reject apply atomically with receipts, CLI supports multiple ids, and same-file receipts record chained batch_preview_sha256', async () => {
  const f = await setupFixture()
  try {
    const d1 = createProposal(f.projectA, {
        source_files: ['Context/evidence.md'],
        claim: 'Deferred claim one for batch state transition testing.'
      }),
      d2 = createProposal(f.projectB, {
        source_files: ['Context/evidence.md'],
        claim: 'Deferred claim two for batch state transition testing.'
      }),
      prevD1 = proposalPreviewData(f.projectA, d1.proposal_id),
      prevD2 = proposalPreviewData(f.projectB, d2.proposal_id)

    const deferRes = await f.call('/api/inbox/batch', {
      method: 'POST',
      body: {
        action: 'defer',
        items: [
          { id: d1.proposal_id, space: f.spaceIdA, preview_hash: prevD1.preview_hash },
          { id: d2.proposal_id, space: f.spaceIdB, preview_hash: prevD2.preview_hash }
        ]
      }
    })
    assert.equal(deferRes.status, 200)
    assert.equal(deferRes.json.data.count, 2)
    assert.equal(existsSync(join(f.self, 'proposals', 'receipts', `${d1.proposal_id}-deferred.json`)), true)
    assert.equal(existsSync(join(f.self, 'proposals', 'receipts', `${d2.proposal_id}-deferred.json`)), true)

    const c1 = createProposal(f.projectA, {
        source_files: ['Context/evidence.md'],
        claim: 'First CLI batch-approved claim across the same canonical target.',
        visibility: 'professional'
      }),
      c2 = createProposal(f.projectA, {
        source_files: ['Context/evidence.md'],
        claim: 'Second CLI batch-approved claim across the same canonical target.',
        visibility: 'professional'
      }),
      preBatchPrev1 = proposalPreviewData(f.projectA, c1.proposal_id),
      preBatchPrev2 = proposalPreviewData(f.projectA, c2.proposal_id)

    const out = await capture(() => run(['proposals', 'approve', c1.proposal_id, c2.proposal_id, '--project', f.projectA, '--yes']))
    assert.match(out, new RegExp(`\\[ok\\] approved ${c1.proposal_id}`))
    assert.match(out, new RegExp(`\\[ok\\] approved ${c2.proposal_id}`))
    const r1 = JSON.parse(await readFile(join(f.self, 'proposals', 'receipts', `${c1.proposal_id}-approved.json`), 'utf8')),
      r2 = JSON.parse(await readFile(join(f.self, 'proposals', 'receipts', `${c2.proposal_id}-approved.json`), 'utf8'))
    assert.equal(r1.preview_sha256, preBatchPrev1.preview_hash)
    assert.equal(r1.batch_preview_sha256, preBatchPrev1.preview_hash)
    assert.equal(r2.preview_sha256, preBatchPrev2.preview_hash)
    assert.match(r2.batch_preview_sha256, /^[0-9a-f]{64}$/)
    assert.notEqual(
      r2.batch_preview_sha256,
      r2.preview_sha256,
      '2nd same-file item batch_preview_sha256 reflects chained file state after 1st item'
    )
    assert.equal(r2.applied_changes[0].before_sha256, r1.applied_changes[0].after_sha256)
  } finally {
    await f.close()
  }
})

test('benchmark: 400 proposals x 300 sections -> GET /api/inbox response < 2 MB and < 500 ms with pagination', async t => {
  const f = await setupFixture()
  try {
    // Write 300 sections into context/claims.md (mix of claim blocks and prose sections with metrics).
    const sectionBlocks = [FRONT, '# Claims']
    for (let s = 1; s <= 300; s++) {
      if (s % 10 === 0) {
        sectionBlocks.push(
          legacyBlock(
            'professional',
            `sec-${s}`,
            `Operates service tier ${s} handling ${s * 10} requests per second across regional clusters.`
          )
        )
      } else {
        sectionBlocks.push(
          `## Section ${s}\n\nMaintains subsystem ${s} with ${s + 2} automated verification checks and deterministic replay.`
        )
      }
    }
    await writeFile(f.claimsPath, sectionBlocks.join('\n\n') + '\n')

    // Write 400 pending proposal YAML files (200 in projectA, 200 in projectB).
    const propDirA = join(f.projectA, '.holoself', 'proposals'),
      propDirB = join(f.projectB, '.holoself', 'proposals')
    await mkdir(propDirA, { recursive: true })
    await mkdir(propDirB, { recursive: true })

    const writes = []
    for (let i = 1; i <= 400; i++) {
      const isA = i <= 200,
        proj = isA ? f.projectA : f.projectB,
        dir = isA ? propDirA : propDirB,
        id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        claimText =
          i % 25 === 0
            ? `Operates service tier ${i % 300 || 10} handling ${i * 15} requests per second across regional clusters.`
            : `Documents architecture pattern ${i} for deterministic local review workflow item ${i}.`,
        record = {
          schema_version: 2,
          proposal_id: id,
          title: `Benchmark proposal ${i}`,
          source_project: basename(proj),
          source_project_path: slash(proj),
          source_files: ['Context/evidence.md'],
          status: 'pending',
          created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
          provenance: [`${basename(proj)}:Context/evidence.md`],
          changes: [
            {
              change_id: 'claim',
              target: 'context/claims.md',
              operation: 'append_claim',
              proposal_type: 'new_fact',
              claim: claimText,
              evidence: 'Source project files: Context/evidence.md',
              confidence: 'confirmed',
              visibility: 'professional'
            }
          ]
        }
      writes.push(writeFile(join(dir, `${id}.yaml`), proposalText(record)))
    }
    await Promise.all(writes)

    const t0 = performance.now(),
      res = await f.call('/api/inbox?space=all'),
      elapsedMs = Number((performance.now() - t0).toFixed(1)),
      bytes = Buffer.byteLength(res.text, 'utf8')

    t.diagnostic(`benchmark 400 proposals x 300 sections: ${elapsedMs} ms, ${bytes} bytes (${(bytes / 1024).toFixed(1)} KiB)`)
    console.log(`[benchmark] 400 proposals x 300 sections: ${elapsedMs} ms, ${bytes} bytes (${(bytes / 1024).toFixed(1)} KiB)`)

    assert.equal(res.status, 200)
    assert.ok(bytes < 2 * 1024 * 1024, `expected response < 2 MB, got ${bytes} bytes`)
    assert.ok(elapsedMs < 500, `expected response < 500 ms, got ${elapsedMs} ms`)
    assert.equal(res.json.data.total, 400)
    assert.equal(res.json.data.limit, DEFAULT_INBOX_LIMIT)
    assert.equal(res.json.data.offset, 0)
    assert.equal(res.json.data.items.length, DEFAULT_INBOX_LIMIT)
    assert.equal(res.json.data.truncated, true)
    assert.equal(res.json.data.next_offset, 200)

    const page2 = await f.call('/api/inbox?space=all&offset=200&limit=200')
    assert.equal(page2.status, 200)
    assert.equal(page2.json.data.items.length, 200)
    assert.equal(page2.json.data.truncated, false)
    assert.equal(page2.json.data.next_offset, null)
  } finally {
    await f.close()
  }
})

test('Inbox API enforces token auth, loopback Host allowlist, and Origin verification', async () => {
  const f = await setupFixture()
  try {
    const noTokenGet = await f.call('/api/inbox', { token: null })
    assert.equal(noTokenGet.status, 403)

    const badTokenGet = await f.call('/api/inbox', { token: '0'.repeat(f.app.token.length) })
    assert.equal(badTokenGet.status, 403)

    const noTokenPost = await f.call('/api/inbox/batch', { method: 'POST', token: null, body: { action: 'defer', items: [] } })
    assert.equal(noTokenPost.status, 403)

    const badOriginPost = await f.call('/api/inbox/batch', {
      method: 'POST',
      customOrigin: 'http://evil.example',
      body: { action: 'defer', items: [] }
    })
    assert.equal(badOriginPost.status, 403)

    const { port } = new URL(f.app.url)
    const badHostStatus = await new Promise((ok, no) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path: '/api/inbox',
          method: 'GET',
          headers: { host: `evil.example:${port}`, 'x-holoself-token': f.app.token }
        },
        res => {
          res.resume()
          res.on('end', () => ok(res.statusCode))
        }
      )
      req.on('error', no)
      req.end()
    })
    assert.equal(badHostStatus, 421)
  } finally {
    await f.close()
  }
})
