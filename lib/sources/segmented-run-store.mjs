import { reduceRun } from '../core/run-state.mjs'
import { requireDeliveryRecord, sealDeliveryRecord } from '../core/delivery-record.mjs'
import { recordDigest } from '../core/record-digest.mjs'
import { planGitHubCoordination } from './github-run-store.mjs'

export const V2_SCHEMA_VERSION = 2
export const SEGMENTED_FORMAT = 'segmented-v2'
export const DEFAULT_SEGMENT_SIZE = 500
export const DEFAULT_SEGMENT_BYTES = 256 * 1024

function segmentDigest(segmentEvents) {
  return recordDigest({ events: segmentEvents })
}

export function createSegmentedRunStore({
  repo,
  runId,
  client,
  branch = 'agentflow-state',
  boundary,
  setupConfirm,
  segmentSize = DEFAULT_SEGMENT_SIZE,
  segmentBytes = DEFAULT_SEGMENT_BYTES,
  readCacheBytes = 2 * 1024 * 1024,
  metrics,
}) {
  if (
    !Number.isSafeInteger(readCacheBytes) ||
    readCacheBytes < 0 ||
    readCacheBytes > 2 * 1024 * 1024
  )
    throw new Error('Invalid immutable read cache capacity')
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(repo ?? '') ||
    !/^[\w-]{1,100}$/.test(runId ?? '') ||
    !/^[\w/-]+$/.test(branch)
  )
    throw new Error('Invalid GitHub run store identity')
  if (!Number.isSafeInteger(segmentSize) || segmentSize < 1 || segmentSize > 5000)
    throw new Error('Invalid segment size')
  if (!Number.isSafeInteger(segmentBytes) || segmentBytes < 1024 || segmentBytes > 1024 * 1024)
    throw new Error('Invalid segment bytes capacity')

  const prefix = `/repos/${repo}`
  const refPath = `${prefix}/git/ref/heads/${branch}`
  const manifestPath = `runs/${runId}-manifest.json`
  const snapshotPath = `runs/${runId}-snapshot.json`
  const tailPath = `runs/${runId}-tail.json`
  const legacyFilePath = `runs/${runId}.json`
  const request = (...args) => client.request(...args)
  const replay = (events) => {
    if (metrics) {
      metrics.reducerCalls = (metrics.reducerCalls ?? 0) + 1
      metrics.reducerEvents = (metrics.reducerEvents ?? 0) + events.length
    }
    return reduceRun(events)
  }
  const hashSegment = (events) => {
    if (metrics) {
      metrics.segmentHashCalls = (metrics.segmentHashCalls ?? 0) + 1
      metrics.segmentHashEvents = (metrics.segmentHashEvents ?? 0) + events.length
    }
    return segmentDigest(events)
  }

  let cached = null
  // Entries are immutable only after their source blob and manifest digest agree.
  // Cache admission and eviction are bounded by the configured byte capacity.
  const verifiedSegments = new Map()
  let verifiedSegmentBytes = 0
  let verifiedSnapshot = null
  function rememberSegment(key, events, bytes) {
    if (!readCacheBytes || bytes > readCacheBytes) return
    if (verifiedSegments.has(key)) return
    while (verifiedSegmentBytes + bytes > readCacheBytes) {
      const oldest = verifiedSegments.keys().next().value
      verifiedSegmentBytes -= verifiedSegments.get(oldest).bytes
      verifiedSegments.delete(oldest)
    }
    verifiedSegments.set(key, { events, bytes })
    verifiedSegmentBytes += bytes
  }

  const write = (path, body, method = 'POST') => {
    if (boundary !== 'external-action')
      throw new Error('Coordination writes require external-action authority')
    return request(path, { method, body })
  }

  async function readBlob(sha) {
    const blob = await request(`${prefix}/git/blobs/${sha}`)
    if (blob.encoding !== 'base64') throw new Error('Invalid blob encoding')
    return Buffer.from(blob.content.replaceAll('\n', ''), 'base64').toString('utf8')
  }

  async function readTreeAndRef() {
    let ref
    try {
      ref = await request(refPath)
    } catch (error) {
      cached = null
      if (error.status === 404) return null
      throw error
    }
    const sourceRevision = ref?.object?.sha
    if (typeof sourceRevision !== 'string' || !sourceRevision) {
      cached = null
      throw new Error('Missing coordination revision')
    }
    const commit = await request(`${prefix}/git/commits/${sourceRevision}`)
    const tree = await request(`${prefix}/git/trees/${commit.tree.sha}?recursive=1`)
    if (tree.truncated) throw new Error('Coordination tree truncated')
    if (
      !Array.isArray(tree.tree) ||
      tree.tree.some(
        (entry) =>
          !(entry.path === 'runs' && entry.type === 'tree' && entry.mode === '040000') &&
          !(
            entry.type === 'blob' &&
            entry.mode === '100644' &&
            /^runs\/[\w-]+\.json$/.test(entry.path)
          ),
      )
    )
      throw new Error('Coordination branch contains unmanaged data')
    return { ref, commit, tree, sourceRevision }
  }

  async function read({ cache = true, verifyAllSegments = true } = {}) {
    const treeInfo = await readTreeAndRef()
    if (!treeInfo) return { events: [], revision: null, sourceRevision: null, formatVersion: 2 }
    const { ref, commit, tree, sourceRevision } = treeInfo

    if (!cache) cached = null
    if (cached?.sourceRevision !== sourceRevision) cached = null
    if (cache && cached) return JSON.parse(cached.serialized)

    const manifestEntry = tree.tree.find((item) => item.path === manifestPath)
    let events = []
    let manifest = null
    let formatVersion = 2

    if (manifestEntry) {
      const manifestContent = await readBlob(manifestEntry.sha)
      manifest = JSON.parse(manifestContent)
      if (manifest.schemaVersion !== V2_SCHEMA_VERSION || manifest.format !== SEGMENTED_FORMAT)
        throw new Error('Unsupported manifest format or schema version')
      if (manifest.runId !== runId) throw new Error('Stored run identity mismatch in manifest')

      if (!Array.isArray(manifest.segments)) throw new Error('Invalid segment manifest')
      if (
        manifest.tailPath !== tailPath ||
        !Number.isSafeInteger(manifest.tailEventCount) ||
        manifest.tailEventCount < 0
      )
        throw new Error('Invalid tail manifest')
      // Verify and load segments. A cache hit is tied to both the immutable
      // blob identity and the digest that was checked on its first read.
      let previousDigest = null
      let previousRevision = null
      for (const seg of manifest.segments) {
        if (
          typeof seg.path !== 'string' ||
          !seg.path.startsWith(`runs/${runId}-seg-`) ||
          !Number.isSafeInteger(seg.eventCount) ||
          seg.eventCount < 1
        )
          throw new Error('Invalid event segment manifest')
        const segEntry = tree.tree.find((item) => item.path === seg.path)
        if (!segEntry) throw new Error(`Corrupted or missing event segment: ${seg.path}`)
        if (seg.parentDigest !== previousDigest)
          throw new Error(
            `Segment parent digest mismatch: expected ${previousDigest}, received ${seg.parentDigest}`,
          )
        const cacheKey = `${segEntry.sha}:${seg.digest}`
        const cachedSegment = cache && verifyAllSegments ? verifiedSegments.get(cacheKey) : null
        let segEvents = cachedSegment?.events
        if (cachedSegment && cachedSegment.bytes !== seg.byteLength)
          throw new Error(`Segment byte length mismatch: ${seg.path}`)
        if (!segEvents) {
          const segRaw = await readBlob(segEntry.sha)
          segEvents = JSON.parse(segRaw)
          if (!Array.isArray(segEvents) || hashSegment(segEvents) !== seg.digest)
            throw new Error(`Segment digest mismatch: ${seg.path}`)
          if (seg.byteLength !== Buffer.byteLength(segRaw))
            throw new Error(`Segment byte length mismatch: ${seg.path}`)
          if (cache && verifyAllSegments)
            rememberSegment(cacheKey, segEvents, Buffer.byteLength(segRaw))
        }
        if (segEvents.length !== seg.eventCount)
          throw new Error(`Segment event count mismatch: ${seg.path}`)
        if (
          previousRevision !== seg.startRevision ||
          (segEvents.at(-1)?.digest !== seg.endRevision &&
            replay([...events, ...segEvents])?.revision !== seg.endRevision)
        )
          throw new Error(`Segment revision mismatch: ${seg.path}`)
        previousDigest = seg.digest
        previousRevision = seg.endRevision
        events.push(...segEvents)
      }

      // Load tail events
      const tailEntry = tree.tree.find((item) => item.path === manifest.tailPath)
      if (!tailEntry) throw new Error('Corrupted or missing event tail')
      const tailEvents = JSON.parse(await readBlob(tailEntry.sha))
      if (!Array.isArray(tailEvents) || tailEvents.length !== manifest.tailEventCount)
        throw new Error('Tail event count mismatch')
      events.push(...tailEvents)
    } else {
      // Check legacy v1 file
      const legacyEntry = tree.tree.find((item) => item.path === legacyFilePath)
      if (legacyEntry) {
        const legacyRaw = await readBlob(legacyEntry.sha)
        const parsed = JSON.parse(legacyRaw)
        // If legacy file was replaced with v2 fail-closed marker
        if (!Array.isArray(parsed)) {
          throw new Error('Unsupported legacy run layout; use v2 segmented reader')
        }
        events = parsed
        formatVersion = 1
      }
    }

    const state = replay(events)
    if (state && state.runId !== runId) throw new Error('Stored run identity mismatch')

    // If a snapshot exists in manifest, verify snapshot consistency with reduced state
    if (manifest?.snapshot) {
      const descriptor = manifest.snapshot
      const segmentCount = manifest.segments.reduce((sum, seg) => sum + seg.eventCount, 0)
      if (
        descriptor.path !== snapshotPath ||
        !Number.isSafeInteger(descriptor.eventCount) ||
        descriptor.eventCount !== segmentCount ||
        descriptor.eventCount > events.length
      )
        throw new Error('Invalid snapshot event count or path')
      const snapshotEntry = tree.tree.find((item) => item.path === descriptor.path)
      if (!snapshotEntry) throw new Error('Corrupted or missing snapshot')
      const snapshotKey = recordDigest({
        sha: snapshotEntry.sha,
        descriptor,
        segments: manifest.segments.map((seg) => [seg.path, seg.digest]),
      })
      if (!cache || !readCacheBytes || verifiedSnapshot !== snapshotKey) {
        const snapshot = JSON.parse(await readBlob(snapshotEntry.sha))
        if (
          recordDigest(snapshot) !== descriptor.snapshotDigest ||
          snapshot.eventCount !== descriptor.eventCount ||
          snapshot.revision !== descriptor.revision
        )
          throw new Error('Snapshot digest or metadata mismatch')
        const prefixState =
          descriptor.eventCount === events.length
            ? state
            : replay(events.slice(0, descriptor.eventCount))
        if (
          JSON.stringify(snapshot.state) !== JSON.stringify(prefixState) ||
          snapshot.revision !== prefixState?.revision
        )
          throw new Error('Snapshot state mismatch with replayed prefix')
        if (cache && readCacheBytes) verifiedSnapshot = snapshotKey
      }
    } else if (manifest?.segments.length) {
      throw new Error('Missing snapshot for sealed segments')
    }

    const result = {
      events,
      revision: state?.revision ?? null,
      sourceRevision: ref.object.sha,
      treeSha: commit.tree.sha,
      treeEntries: tree.tree,
      formatVersion,
      manifest,
    }

    if (cache && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(sourceRevision)) {
      const serialized = JSON.stringify(result)
      if (Buffer.byteLength(serialized) <= readCacheBytes) cached = { sourceRevision, serialized }
    }
    return result
  }

  return {
    durable: true,
    conditionalAdmission: 'single-parent-run-chain-v1',
    read,
    async append(event, expectedRevision) {
      requireDeliveryRecord(event, 'run-event')
      if (event.runId !== runId) throw new Error('Run identity mismatch')
      const current = await read()
      const prior = current.events.find((item) => item.id === event.id)
      if (prior) {
        if (prior.digest !== event.digest) throw new Error('Conflicting event')
        return current
      }
      if (current.revision !== expectedRevision)
        throw Object.assign(new Error('Source revision conflict'), {
          admissionOutcome: 'not-committed',
        })

      const allEvents = [...current.events, event]
      const proposedState = replay(allEvents)
      const reserve = proposedState?.delegationPolicy
        ? Math.max(0, proposedState.delegationPolicy.safetyReserve - proposedState.safetyUsed) *
          4096
        : 0

      // Reconstruct or initialize manifest
      let manifest = current.manifest
      let segments = manifest ? structuredClone(manifest.segments) : []
      let existingSegmentEventCount = segments.reduce((sum, s) => sum + s.eventCount, 0)
      let tailEvents = allEvents.slice(existingSegmentEventCount)

      const treeUpdates = []

      // Check if tail has reached segment boundary
      const tailBytes = Buffer.byteLength(JSON.stringify(tailEvents))
      if (tailEvents.length >= segmentSize || tailBytes >= segmentBytes) {
        // Seal current tail into a new immutable segment
        const segIndex = segments.length
        const segPath = `runs/${runId}-seg-${segIndex}.json`
        const segContent = JSON.stringify(tailEvents)
        if (Buffer.byteLength(segContent) > 1024 * 1024 - reserve)
          throw new Error('Run exceeds bounded record size')

        const segBlob = await write(`${prefix}/git/blobs`, {
          content: segContent,
          encoding: 'utf-8',
        })
        treeUpdates.push({ path: segPath, mode: '100644', type: 'blob', sha: segBlob.sha })

        const parentDigest = segments.length > 0 ? segments[segments.length - 1].digest : null
        const digest = hashSegment(tailEvents)
        const startRevision = segments.at(-1)?.endRevision ?? null
        const endState = proposedState

        segments.push({
          id: `seg-${segIndex}`,
          path: segPath,
          digest,
          parentDigest,
          eventCount: tailEvents.length,
          byteLength: Buffer.byteLength(segContent),
          startRevision,
          endRevision: endState?.revision ?? null,
        })

        // Snapshot at segment boundary
        const snapshotData = {
          revision: endState?.revision ?? null,
          state: endState,
          eventCount: allEvents.slice(0, existingSegmentEventCount + tailEvents.length).length,
        }
        const snapshotContent = JSON.stringify(snapshotData)
        const snapshotBlob = await write(`${prefix}/git/blobs`, {
          content: snapshotContent,
          encoding: 'utf-8',
        })
        treeUpdates.push({
          path: snapshotPath,
          mode: '100644',
          type: 'blob',
          sha: snapshotBlob.sha,
        })

        // Empty the tail
        tailEvents = []
        const emptyTailBlob = await write(`${prefix}/git/blobs`, {
          content: '[]',
          encoding: 'utf-8',
        })
        treeUpdates.push({ path: tailPath, mode: '100644', type: 'blob', sha: emptyTailBlob.sha })

        manifest = {
          schemaVersion: V2_SCHEMA_VERSION,
          format: SEGMENTED_FORMAT,
          runId,
          snapshot: {
            revision: snapshotData.revision,
            eventCount: snapshotData.eventCount,
            path: snapshotPath,
            snapshotDigest: recordDigest(snapshotData),
          },
          segments,
          tailPath,
          tailEventCount: 0,
        }
      } else {
        // Write active tail
        const tailContent = JSON.stringify(tailEvents)
        const tailBlob = await write(`${prefix}/git/blobs`, {
          content: tailContent,
          encoding: 'utf-8',
        })
        treeUpdates.push({ path: tailPath, mode: '100644', type: 'blob', sha: tailBlob.sha })

        manifest = {
          schemaVersion: V2_SCHEMA_VERSION,
          format: SEGMENTED_FORMAT,
          runId,
          snapshot: manifest?.snapshot ?? null,
          segments,
          tailPath,
          tailEventCount: tailEvents.length,
        }
      }

      // Write updated manifest
      const manifestContent = JSON.stringify(manifest, null, 2)
      const manifestBlob = await write(`${prefix}/git/blobs`, {
        content: manifestContent,
        encoding: 'utf-8',
      })
      treeUpdates.push({ path: manifestPath, mode: '100644', type: 'blob', sha: manifestBlob.sha })

      // Write fail-closed marker into legacy path to ensure old v1 binaries fail closed
      const v2Marker = JSON.stringify({
        schemaVersion: V2_SCHEMA_VERSION,
        format: SEGMENTED_FORMAT,
        runId,
        unsupportedMessage:
          'This run has been migrated to segmented v2 storage; upgrade AgentFlow to read.',
      })
      const markerBlob = await write(`${prefix}/git/blobs`, {
        content: v2Marker,
        encoding: 'utf-8',
      })
      treeUpdates.push({ path: legacyFilePath, mode: '100644', type: 'blob', sha: markerBlob.sha })

      if (!current.sourceRevision) {
        const setup = await planGitHubCoordination({ repo, branch, client })
        if (setupConfirm !== setup.digest)
          throw new Error('Explicit current coordination setup confirmation required')
      }

      const entryMap = new Map()
      if (current.treeEntries) {
        for (const entry of current.treeEntries) {
          entryMap.set(entry.path, entry)
        }
      }
      for (const update of treeUpdates) {
        entryMap.set(update.path, update)
      }
      const fullTree = Array.from(entryMap.values())

      const tree = await write(`${prefix}/git/trees`, {
        ...(current.treeSha ? { base_tree: current.treeSha } : {}),
        tree: fullTree,
      })
      const commit = await write(`${prefix}/git/commits`, {
        message: `Agentflow ${runId}: ${event.kind} [v2]`,
        tree: tree.sha,
        parents: current.sourceRevision ? [current.sourceRevision] : [],
      })

      try {
        if (current.sourceRevision)
          await write(
            `${prefix}/git/refs/heads/${branch}`,
            { sha: commit.sha, force: false },
            'PATCH',
          )
        else await write(`${prefix}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha })
      } catch (error) {
        const reconciled = await read()
        if (reconciled.events.some((item) => item.id === event.id && item.digest === event.digest))
          return reconciled
        if ([409, 422].includes(error.status)) error.admissionOutcome = 'not-committed'
        throw error
      }

      const confirmed = await read()
      if (!confirmed.events.some((item) => item.id === event.id && item.digest === event.digest))
        throw new Error('Coordination outcome unknown')
      return confirmed
    },
  }
}

export async function previewMigration({
  repo,
  runId,
  client,
  branch = 'agentflow-state',
  segmentSize = DEFAULT_SEGMENT_SIZE,
}) {
  const prefix = `/repos/${repo}`
  const ref = await client.request(`${prefix}/git/ref/heads/${branch}`)
  const commit = await client.request(`${prefix}/git/commits/${ref.object.sha}`)
  const tree = await client.request(`${prefix}/git/trees/${commit.tree.sha}?recursive=1`)

  const manifestEntry = tree.tree.find((item) => item.path === `runs/${runId}-manifest.json`)
  if (manifestEntry) {
    const current = await createSegmentedRunStore({
      repo,
      runId,
      client,
      branch,
      boundary: 'observe',
      readCacheBytes: 0,
    }).read({ cache: false })
    if (
      current.sourceRevision !== ref.object.sha ||
      current.formatVersion !== 2 ||
      !current.manifest
    )
      throw new Error('Migrated source changed during preview')
    return {
      alreadyMigrated: true,
      formatVersion: 2,
      runId,
      sourceRevision: current.sourceRevision,
      eventCount: current.events.length,
      segmentCount: current.manifest.segments.length,
      snapshotRevision: current.manifest.snapshot?.revision ?? null,
      verified: true,
    }
  }

  const legacyEntry = tree.tree.find((item) => item.path === `runs/${runId}.json`)
  if (!legacyEntry) throw new Error(`Run ${runId} not found`)

  const blob = await client.request(`${prefix}/git/blobs/${legacyEntry.sha}`)
  const events = JSON.parse(Buffer.from(blob.content, 'base64').toString('utf8'))
  if (!Array.isArray(events)) throw new Error('Legacy run is not a valid event array')

  const referenceState = reduceRun(events)

  // Partition into segments
  const segments = []
  let previousDigest = null
  for (let i = 0; i < events.length; i += segmentSize) {
    const chunk = events.slice(i, i + segmentSize)
    const digest = segmentDigest(chunk)
    const startState = i > 0 ? reduceRun(events.slice(0, i)) : null
    const endState = reduceRun(events.slice(0, i + chunk.length))
    segments.push({
      id: `seg-${segments.length}`,
      eventCount: chunk.length,
      digest,
      parentDigest: previousDigest,
      startRevision: startState?.revision ?? null,
      endRevision: endState?.revision ?? null,
    })
    previousDigest = digest
  }

  // Verify full replay of simulated segments matches reference reducer exactly
  const replayedEvents = []
  for (let i = 0; i < events.length; i += segmentSize) {
    replayedEvents.push(...events.slice(i, i + segmentSize))
  }
  const replayedState = reduceRun(replayedEvents)
  if (JSON.stringify(replayedState) !== JSON.stringify(referenceState))
    throw new Error('Migration replay mismatch with reference reducer')

  return sealDeliveryRecord('run-migration-preview', {
    runId,
    sourceRevision: ref.object.sha,
    eventCount: events.length,
    segmentCount: segments.length,
    referenceRevision: referenceState.revision,
    replayedRevision: replayedState.revision,
    verified: true,
    proposedSegments: segments,
  })
}

export async function migrateRunStore({
  repo,
  runId,
  client,
  branch = 'agentflow-state',
  boundary = 'external-action',
  segmentSize = DEFAULT_SEGMENT_SIZE,
  expectedSourceRevision,
}) {
  if (boundary !== 'external-action')
    throw new Error('Migration writes require external-action authority')
  const preview = await previewMigration({ repo, runId, client, branch, segmentSize })
  if (expectedSourceRevision !== undefined && preview.sourceRevision !== expectedSourceRevision)
    throw Object.assign(new Error('Migration source changed since approved preview'), {
      admissionOutcome: 'not-committed',
    })
  if (preview.alreadyMigrated) return preview

  const prefix = `/repos/${repo}`
  const ref = await client.request(`${prefix}/git/ref/heads/${branch}`)
  if (ref.object.sha !== preview.sourceRevision)
    throw new Error('Source revision changed before migration')

  const commit = await client.request(`${prefix}/git/commits/${ref.object.sha}`)
  const tree = await client.request(`${prefix}/git/trees/${commit.tree.sha}?recursive=1`)
  const legacyEntry = tree.tree.find((item) => item.path === `runs/${runId}.json`)
  if (!legacyEntry) throw new Error('Legacy run missing before migration')
  const blob = await client.request(`${prefix}/git/blobs/${legacyEntry.sha}`)
  const events = JSON.parse(Buffer.from(blob.content, 'base64').toString('utf8'))
  if (
    !Array.isArray(events) ||
    events.length !== preview.eventCount ||
    reduceRun(events)?.revision !== preview.referenceRevision
  )
    throw new Error('Migration source changed since preview')

  const treeUpdates = []
  const segments = []
  let previousDigest = null

  // Write segment blobs
  for (let i = 0; i < events.length; i += segmentSize) {
    const chunk = events.slice(i, i + segmentSize)
    const segIndex = segments.length
    const segPath = `runs/${runId}-seg-${segIndex}.json`
    const segContent = JSON.stringify(chunk)
    const segBlob = await client.request(`${prefix}/git/blobs`, {
      method: 'POST',
      body: { content: segContent, encoding: 'utf-8' },
    })
    treeUpdates.push({ path: segPath, mode: '100644', type: 'blob', sha: segBlob.sha })

    const digest = segmentDigest(chunk)
    const startState = i > 0 ? reduceRun(events.slice(0, i)) : null
    const endState = reduceRun(events.slice(0, i + chunk.length))

    segments.push({
      id: `seg-${segIndex}`,
      path: segPath,
      digest,
      parentDigest: previousDigest,
      eventCount: chunk.length,
      byteLength: Buffer.byteLength(segContent),
      startRevision: startState?.revision ?? null,
      endRevision: endState?.revision ?? null,
    })
    previousDigest = digest
  }

  // Snapshot at end of last segment
  const finalState = reduceRun(events)
  const snapshotData = {
    revision: finalState?.revision ?? null,
    state: finalState,
    eventCount: events.length,
  }
  const snapshotContent = JSON.stringify(snapshotData)
  const snapshotBlob = await client.request(`${prefix}/git/blobs`, {
    method: 'POST',
    body: { content: snapshotContent, encoding: 'utf-8' },
  })
  treeUpdates.push({
    path: `runs/${runId}-snapshot.json`,
    mode: '100644',
    type: 'blob',
    sha: snapshotBlob.sha,
  })

  // Empty tail
  const emptyTailBlob = await client.request(`${prefix}/git/blobs`, {
    method: 'POST',
    body: { content: '[]', encoding: 'utf-8' },
  })
  treeUpdates.push({
    path: `runs/${runId}-tail.json`,
    mode: '100644',
    type: 'blob',
    sha: emptyTailBlob.sha,
  })

  // Manifest
  const manifest = {
    schemaVersion: V2_SCHEMA_VERSION,
    format: SEGMENTED_FORMAT,
    runId,
    snapshot: {
      revision: snapshotData.revision,
      eventCount: snapshotData.eventCount,
      path: `runs/${runId}-snapshot.json`,
      snapshotDigest: recordDigest(snapshotData),
    },
    segments,
    tailPath: `runs/${runId}-tail.json`,
    tailEventCount: 0,
  }
  const manifestContent = JSON.stringify(manifest, null, 2)
  const manifestBlob = await client.request(`${prefix}/git/blobs`, {
    method: 'POST',
    body: { content: manifestContent, encoding: 'utf-8' },
  })
  treeUpdates.push({
    path: `runs/${runId}-manifest.json`,
    mode: '100644',
    type: 'blob',
    sha: manifestBlob.sha,
  })

  // Fail-closed marker in legacy file
  const v2Marker = JSON.stringify({
    schemaVersion: V2_SCHEMA_VERSION,
    format: SEGMENTED_FORMAT,
    runId,
    unsupportedMessage:
      'This run has been migrated to segmented v2 storage; upgrade AgentFlow to read.',
  })
  const markerBlob = await client.request(`${prefix}/git/blobs`, {
    method: 'POST',
    body: { content: v2Marker, encoding: 'utf-8' },
  })
  treeUpdates.push({
    path: `runs/${runId}.json`,
    mode: '100644',
    type: 'blob',
    sha: markerBlob.sha,
  })

  const entryMap = new Map()
  for (const entry of tree.tree) {
    entryMap.set(entry.path, entry)
  }
  for (const update of treeUpdates) {
    entryMap.set(update.path, update)
  }
  const fullTree = Array.from(entryMap.values())

  const newTree = await client.request(`${prefix}/git/trees`, {
    method: 'POST',
    body: {
      base_tree: commit.tree.sha,
      tree: fullTree,
    },
  })

  const newCommit = await client.request(`${prefix}/git/commits`, {
    method: 'POST',
    body: {
      message: `Agentflow ${runId}: migrate to segmented v2 storage`,
      tree: newTree.sha,
      parents: [ref.object.sha],
    },
  })

  let updateError = null
  try {
    await client.request(`${prefix}/git/refs/heads/${branch}`, {
      method: 'PATCH',
      body: { sha: newCommit.sha, force: false },
    })
  } catch (error) {
    updateError = error
  }

  // A successful API response and an uncertain response need the same source
  // confirmation. Never infer migration from a locally created commit alone.
  let confirmation
  try {
    confirmation = await client.request(`${prefix}/git/ref/heads/${branch}`)
  } catch (error) {
    throw Object.assign(
      new Error('Migration outcome unknown; source confirmation failed', { cause: error }),
      {
        admissionOutcome: 'unknown',
      },
    )
  }
  if (confirmation?.object?.sha !== newCommit.sha) {
    if (updateError && confirmation?.object?.sha === ref.object.sha)
      throw Object.assign(updateError, { admissionOutcome: 'not-committed' })
    throw Object.assign(
      new Error('Migration outcome unknown; source revision differs from candidate', {
        cause: updateError,
      }),
      {
        admissionOutcome: 'unknown',
      },
    )
  }
  const verified = await createSegmentedRunStore({
    repo,
    runId,
    client,
    branch,
    boundary: 'observe',
    readCacheBytes: 0,
  }).read({ cache: false })
  if (
    verified.sourceRevision !== newCommit.sha ||
    JSON.stringify(verified.events) !== JSON.stringify(events) ||
    JSON.stringify(reduceRun(verified.events)) !== JSON.stringify(finalState)
  )
    throw Object.assign(new Error('Migration outcome unknown; source replay mismatch'), {
      admissionOutcome: 'unknown',
    })

  return sealDeliveryRecord('run-migration-receipt', {
    runId,
    priorRevision: ref.object.sha,
    newRevision: newCommit.sha,
    eventCount: events.length,
    segmentCount: segments.length,
    finalRevision: finalState.revision,
    verified: true,
  })
}
