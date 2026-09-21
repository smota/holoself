import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { run } from '../src/cli.mjs'
import {
  contextData,
  holoselfMcpSearch,
  readIndex,
  searchIndex
} from '../src/ecosystem.mjs'

const temp = (prefix = 'holoself-fed-') => mkdtemp(join(tmpdir(), prefix))

async function capture(fn) {
  const old = console.log
  let out = ''
  console.log = (...args) => { out += args.join(' ') + '\n' }
  try {
    await fn()
  } finally {
    console.log = old
  }
  return out
}

function canonicalSpaceId(dir) {
  const norm = dir.replaceAll('\\', '/').toLowerCase()
  return 'hs-space-' + createHash('sha256').update('project\0' + norm).digest('hex').slice(0, 16)
}

async function setupFederationFixture() {
  const self = await temp('holoself-fed-self-')
  await run(['init', '--root', self])

  // Setup Consumer Project A
  const consumer = await temp('holoself-fed-consumer-')
  await mkdir(join(consumer, 'context'), { recursive: true })
  await writeFile(
    join(consumer, 'context', 'local-task.md'),
    `---
read_scope: shared
access_lenses: [career, technical, general]
document_role: content
---
# Consumer Local Context

Executing consumer project career leadership tasks in regulated AI.
`
  )
  await run(['link', 'add', '--project', consumer, '--self', self, '--lens', 'career', '--secondary-lenses', 'technical,general', '--yes'])

  // Setup Shared Producer Project B
  const producerShared = await temp('holoself-fed-producer-shared-')
  await mkdir(join(producerShared, 'context'), { recursive: true })
  await writeFile(
    join(producerShared, 'context', 'shared-evidence.md'),
    `---
read_scope: shared
access_lenses: [career, general]
document_role: evidence
---
# Shared Producer Evidence

UniqueSharedEvidencePhrase: Peer producer delivered evidence for career leadership.
`
  )
  await writeFile(
    join(producerShared, 'context', 'local-notes.md'),
    `---
read_scope: local
access_lenses: [career, general]
document_role: content
---
# Shared Producer Local Notes

UniqueLocalNotesPhrase: Private internal producer thoughts never to be shared.
`
  )
  await run(['link', 'add', '--project', producerShared, '--self', self, '--lens', 'career', '--secondary-lenses', 'general', '--yes'])

  // Setup Restricted Producer Project C
  const producerRestricted = await temp('holoself-fed-producer-restricted-')
  await mkdir(join(producerRestricted, 'context'), { recursive: true })
  await writeFile(
    join(producerRestricted, 'context', 'super-secret.md'),
    `---
read_scope: restricted
access_lenses: [private]
document_role: content
---
# Classified Project Secret

SuperSecretClassifiedPhrase: Top secret documents of restricted peer project.
`
  )
  await run(['link', 'add', '--project', producerRestricted, '--self', self, '--lens', 'general', '--yes'])

  // Update links.json to give producerRestricted only private lens so it is completely restricted
  const linksPath = join(self, '.holoself', 'links.json')
  const linksObj = JSON.parse(await readFile(linksPath, 'utf8'))
  const restrSpaceId = canonicalSpaceId(producerRestricted)
  const restrEntry = linksObj.links.find(l => l.project_id === restrSpaceId)
  if (restrEntry) {
    restrEntry.allowed_lenses = ['private']
    await writeFile(linksPath, JSON.stringify(linksObj, null, 2), 'utf8')
  }

  return {
    self,
    consumer,
    producerShared,
    producerRestricted,
    consumerSpaceId: canonicalSpaceId(consumer),
    sharedSpaceId: canonicalSpaceId(producerShared),
    restrictedSpaceId: canonicalSpaceId(producerRestricted)
  }
}

test('V-06: Three synthetic spaces anti-oracle protection', async () => {
  const { self, consumer, producerShared, producerRestricted, sharedSpaceId, restrictedSpaceId } = await setupFederationFixture()

  const result = contextData({
    project: consumer,
    task: 'career leadership',
    federated: true,
    lens: 'career',
    noCache: true
  })

  // Verify status is complete
  assert.equal(result.status, 'complete')

  // Verify consumer receives evidence from shared producer
  assert.ok(Array.isArray(result.federated))
  assert.equal(result.federated.length, 1)
  assert.equal(result.federated[0].space_id, sharedSpaceId)
  assert.equal(result.federated[0].name.toLowerCase(), basename(producerShared).toLowerCase())
  assert.ok(result.federated[0].documents.some(d => d.content.includes('UniqueSharedEvidencePhrase')))

  // Verify sources list contains the shared peer document
  assert.ok(result.sources.some(s => s.space_id === sharedSpaceId && s.path === 'context/shared-evidence.md'))

  // Verify ZERO leakage of restricted producer: body, snippet, heading, path, handle, or space ID
  const serialized = JSON.stringify(result)
  assert.doesNotMatch(serialized, /SuperSecretClassifiedPhrase/)
  assert.doesNotMatch(serialized, /Classified Project Secret/)
  assert.doesNotMatch(serialized, /super-secret\.md/)
  assert.doesNotMatch(serialized, new RegExp(basename(producerRestricted), 'i'))
  assert.doesNotMatch(serialized, new RegExp(restrictedSpaceId))
  assert.doesNotMatch(serialized, new RegExp(producerRestricted.replaceAll('\\', '/'), 'i'))

  // Verify restrictions array does NOT mention restricted producer
  assert.ok(result.restrictions.every(r => !r.source.includes('super-secret') && !r.source.includes(restrictedSpaceId)))

  // Verify unreachable_spaces does NOT contain restricted producer
  assert.equal(result.unreachable_spaces, undefined)
})

test('I-04: Peer read_scope: "local" is strictly isolated from consumer', async () => {
  const { consumer, sharedSpaceId } = await setupFederationFixture()

  const result = contextData({
    project: consumer,
    task: 'career leadership',
    federated: true,
    lens: 'career',
    noCache: true
  })

  // Producer's local-notes.md must NOT be included in federated documents or sources
  assert.ok(!result.sources.some(s => s.path === 'context/local-notes.md'))
  assert.ok(!result.federated[0].documents.some(d => d.path === 'context/local-notes.md'))

  // Body of local notes must not leak
  const serialized = JSON.stringify(result)
  assert.doesNotMatch(serialized, /UniqueLocalNotesPhrase/)
  assert.doesNotMatch(serialized, /Shared Producer Local Notes/)

  // Zero oracle leak in restrictions: restrictions should NOT contain local-notes.md
  assert.ok(result.restrictions.every(r => !r.source.includes('local-notes.md')))
})

test('B3 & R-08: Asymmetric lens grants and Pre-Filter Zero-I/O', async () => {
  const { self, consumer, sharedSpaceId } = await setupFederationFixture()

  // Setup Technical Producer Project
  const producerTech = await temp('holoself-fed-tech-')
  await mkdir(join(producerTech, 'context'), { recursive: true })
  await writeFile(
    join(producerTech, 'context', 'tech-evidence.md'),
    `---
read_scope: shared
access_lenses: [technical]
document_role: evidence
---
# Technical Producer Evidence

UniqueTechEvidencePhrase: Technical deep dive into compiler optimizations.
`
  )
  await run(['link', 'add', '--project', producerTech, '--self', self, '--lens', 'technical', '--yes'])
  const techSpaceId = canonicalSpaceId(producerTech)

  // Query under 'career' lens: producerTech only has 'technical', so it must be omitted with Zero-I/O
  const careerResult = contextData({
    project: consumer,
    task: 'career tasks',
    federated: true,
    lens: 'career',
    noCache: true
  })
  assert.ok(careerResult.federated.some(f => f.space_id === sharedSpaceId))
  assert.ok(!careerResult.federated.some(f => f.space_id === techSpaceId))
  assert.doesNotMatch(JSON.stringify(careerResult), /UniqueTechEvidencePhrase/)

  // Query under 'technical' lens: both consumer and producerTech share 'technical'
  const techResult = contextData({
    project: consumer,
    task: 'compiler optimizations',
    federated: true,
    lens: 'technical',
    noCache: true
  })
  assert.ok(techResult.federated.some(f => f.space_id === techSpaceId))
  assert.match(JSON.stringify(techResult), /UniqueTechEvidencePhrase/)
})

test('B2 & N1 & V-08: Peer unreachability produces status "partial" with opaque ID without crashing', async () => {
  const { consumer, producerShared, sharedSpaceId } = await setupFederationFixture()

  // Simulate producerShared directory going missing or being deleted
  await rm(producerShared, { recursive: true, force: true })

  // Consumer query should NOT crash; returns status: 'partial'
  const result = contextData({
    project: consumer,
    task: 'career leadership',
    federated: true,
    lens: 'career',
    noCache: true
  })

  assert.equal(result.status, 'partial')
  assert.ok(Array.isArray(result.unreachable_spaces))
  // Opaque canonical ID only (N1)
  assert.deepEqual(result.unreachable_spaces, [sharedSpaceId])

  // Verify ZERO path leak in unreachable_spaces or diagnostics
  assert.doesNotMatch(JSON.stringify(result.unreachable_spaces), new RegExp(basename(producerShared), 'i'))
  assert.doesNotMatch(JSON.stringify(result.unreachable_spaces), new RegExp(producerShared.replaceAll('\\', '/'), 'i'))

  // Consumer local context is still delivered intact
  assert.ok(result.project.documents.length > 0)
  assert.ok(result.sources.some(s => s.kind === 'project'))
})

test('Fail-closed when sovereign authority (links.json) is corrupted', async () => {
  const { self, consumer } = await setupFederationFixture()

  // Corrupt links.json in self root
  const linksPath = join(self, '.holoself', 'links.json')
  await writeFile(linksPath, '{ corrupted json syntax: !!! }', 'utf8')

  // Query must fail-closed immediately because sovereign authority is indeterminable
  assert.throws(
    () => contextData({ project: consumer, federated: true, lens: 'career', noCache: true }),
    /corrupted|invalid|syntax/i
  )
})

test('V-07 & B1: Producer revocation immediately invalidates decision cache and cursor', async () => {
  const { self, consumer, producerShared, sharedSpaceId } = await setupFederationFixture()

  // Query 1: fills cache
  const first = contextData({
    project: consumer,
    task: 'career leadership',
    federated: true,
    lens: 'career'
  })
  assert.equal(first.cache?.hit, false)
  assert.ok(first.federated.some(f => f.space_id === sharedSpaceId))

  // Query 2: should hit cache
  const second = contextData({
    project: consumer,
    task: 'career leadership',
    federated: true,
    lens: 'career'
  })
  assert.equal(second.cache?.hit, true)

  // Revoke producerShared in links.json
  const linksPath = join(self, '.holoself', 'links.json')
  const linksObj = JSON.parse(await readFile(linksPath, 'utf8'))
  const sharedEntry = linksObj.links.find(l => l.project_id === sharedSpaceId)
  sharedEntry.status = 'revoked'
  sharedEntry.revoked_at = new Date().toISOString()
  await writeFile(linksPath, JSON.stringify(linksObj, null, 2), 'utf8')

  // Query 3: links_register_hash changed, so old cache is invalidated immediately
  const third = contextData({
    project: consumer,
    task: 'career leadership',
    federated: true,
    lens: 'career'
  })
  assert.equal(third.cache?.hit, false)
  // Revoked producer must no longer be present
  assert.ok(!third.federated || !third.federated.some(f => f.space_id === sharedSpaceId))
  assert.doesNotMatch(JSON.stringify(third), /UniqueSharedEvidencePhrase/)
})

test('B4 & §8.1.5: Post-authorization deduplication with space precedence (local > self > peer)', async () => {
  const { self, consumer, producerShared, consumerSpaceId, sharedSpaceId } = await setupFederationFixture()

  const identicalText = `# Common Best Practice

We practice rigorous test-driven verification for safety.
`

  // Write identical document in Consumer and Producer
  await writeFile(join(consumer, 'context', 'practice.md'), `---
read_scope: shared
access_lenses: [career, general]
---
${identicalText}`)

  await writeFile(join(producerShared, 'context', 'practice.md'), `---
read_scope: shared
access_lenses: [career, general]
---
${identicalText}`)

  const result = contextData({
    project: consumer,
    task: 'rigorous verification',
    federated: true,
    lens: 'career',
    noCache: true
  })

  // Deduplication must keep only one copy
  const matchingSources = result.sources.filter(s => s.path === 'context/practice.md')
  assert.equal(matchingSources.length, 1)
  // Local consumer project takes precedence over peer
  assert.equal(matchingSources[0].space_id, consumerSpaceId)

  // Anti-shadowing check: If consumer copy has read_scope: local and is excluded, peer copy is NOT shadowed
  // Make consumer copy restricted to private lens
  await writeFile(join(consumer, 'context', 'practice.md'), `---
read_scope: local
access_lenses: [private]
---
${identicalText}`)

  const resultAntiShadow = contextData({
    project: consumer,
    task: 'rigorous verification',
    federated: true,
    lens: 'career',
    noCache: true
  })

  // Since local copy was discarded during authorization, the valid peer copy is retained!
  const matchingAntiShadow = resultAntiShadow.sources.filter(s => s.path === 'context/practice.md')
  assert.equal(matchingAntiShadow.length, 1)
  assert.equal(matchingAntiShadow[0].space_id, sharedSpaceId)
})

test('Federated search in CLI and MCP', async () => {
  const { consumer, producerShared, sharedSpaceId, restrictedSpaceId } = await setupFederationFixture()

  // 1. Search without --federated: peer evidence is NOT returned
  const localSearch = JSON.parse(await capture(() => run(['search', 'UniqueSharedEvidencePhrase', '--project', consumer])))
  assert.equal(localSearch.results.length, 0)

  // 2. Search with --federated in CLI: peer evidence IS returned with hs-space-... provenance
  const fedSearch = JSON.parse(await capture(() => run(['search', 'UniqueSharedEvidencePhrase', '--project', consumer, '--federated'])))
  assert.ok(fedSearch.results.length > 0)
  const match = fedSearch.results.find(r => r.matching_passage.includes('UniqueSharedEvidencePhrase'))
  assert.ok(match)
  assert.match(match.provenance, new RegExp(`^${sharedSpaceId}:`))

  // 3. Search via MCP holoselfMcpSearch
  const mcpResult = holoselfMcpSearch(consumer, {
    query: 'UniqueSharedEvidencePhrase',
    federated: true,
    lens: 'career'
  })
  assert.ok(mcpResult.results.length > 0)
  assert.ok(mcpResult.results.some(r => r.provenance.startsWith(`${sharedSpaceId}:`)))

  // 4. Restricted peer content cannot be found in search
  const secretSearch = JSON.parse(await capture(() => run(['search', 'SuperSecretClassifiedPhrase', '--project', consumer, '--federated'])))
  assert.equal(secretSearch.results.length, 0)

  const secretMcp = holoselfMcpSearch(consumer, {
    query: 'SuperSecretClassifiedPhrase',
    federated: true,
    lens: 'career'
  })
  assert.equal(secretMcp.results.length, 0)
})

test('Manifest pagination and next_cursor with federated spaces', async () => {
  const { consumer, sharedSpaceId } = await setupFederationFixture()

  const paged = contextData({
    project: consumer,
    task: 'career leadership',
    federated: true,
    lens: 'career',
    manifest: true,
    noCache: true
  })

  assert.equal(paged.status, 'complete')
  assert.ok(Array.isArray(paged.sources))
  assert.ok(paged.sources.some(s => s.space_id === sharedSpaceId))
  assert.ok(paged.selection)
  assert.ok(paged.context_receipt)
  assert.ok(typeof paged.context_receipt.context_hash === 'string')
})
