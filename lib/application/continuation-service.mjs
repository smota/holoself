import { createHash } from 'node:crypto'
import { recordDigest } from '../core/record-digest.mjs'
import { requireDeliveryRecord, sealDeliveryRecord } from '../core/delivery-record.mjs'
import { RUN_ROLES, reduceRun } from '../core/run-state.mjs'

export const CONTINUATION_SCHEMA_VERSION = 1
export const MAX_PACKET_BYTES = 32 * 1024

function pendingOperations(state) {
  return Object.values(state.operations ?? {})
    .filter((op) => !['confirmed', 'failed'].includes(op.state))
    .map((op) => ({ id: op.id, kind: op.kind, state: op.state, payloadDigest: op.payloadDigest }))
}

function openRework(state) {
  return Object.values(state.openRework ?? {}).map((item) => ({
    id: item.id,
    criteria: item.criteria,
  }))
}

function primaryGrant(state) {
  const grant = Object.values(state.grants ?? {}).find((item) => item.status === 'active')
  return grant
    ? {
        id: grant.envelope.id,
        revision: grant.revision,
        digest: recordDigest({ envelope: grant.envelope }),
        expiry: grant.envelope.binding.expiry,
      }
    : null
}

function sameSummary(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function validateArtifactReferences(artifacts) {
  if (!Array.isArray(artifacts)) throw new Error('Invalid artifact references')
  for (const art of artifacts) {
    if (
      !art ||
      typeof art.id !== 'string' ||
      !art.id.trim() ||
      typeof art.path !== 'string' ||
      !art.path.trim() ||
      typeof art.digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(art.digest) ||
      !Number.isSafeInteger(art.byteLength) ||
      art.byteLength < 0
    )
      throw new Error('Invalid artifact reference')
  }
}

export function createContinuationBundle({
  state,
  runRevision,
  branch,
  commitSha,
  nextSlice,
  artifacts = [],
  storeDigest = null,
}) {
  if (!state || !state.runId) throw new Error('Valid run state required')
  if (typeof branch !== 'string' || !branch.trim()) throw new Error('Invalid branch reference')
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(commitSha ?? ''))
    throw new Error('Invalid commit SHA')
  if (typeof nextSlice !== 'string' || !nextSlice.trim())
    throw new Error('Next runnable slice required')

  validateArtifactReferences(artifacts)
  const verifiedArtifacts = artifacts.map((art) => {
    return {
      id: art.id,
      digest: art.digest,
      path: art.path,
      byteLength: art.byteLength,
      contentType: art.contentType ?? 'application/octet-stream',
    }
  })

  const packet = {
    schemaVersion: CONTINUATION_SCHEMA_VERSION,
    kind: 'continuation-packet',
    runId: state.runId,
    branch,
    commitSha,
    runRevision,
    storeDigest,
    writer: {
      owner: state.owner,
      generation: state.generation,
    },
    grant: primaryGrant(state),
    policyDigest: state.delegationPolicy ? recordDigest(state.delegationPolicy) : null,
    phase: state.phase,
    role: RUN_ROLES[state.phase] ?? null,
    nextSlice,
    candidateDigest: state.candidateDigest ?? null,
    pendingOperations: pendingOperations(state),
    openRework: openRework(state),
    artifacts: verifiedArtifacts,
  }

  const sealedPacket = sealDeliveryRecord('continuation-packet', packet)
  const serialized = JSON.stringify(sealedPacket)
  if (Buffer.byteLength(serialized) > MAX_PACKET_BYTES)
    throw new Error(`Continuation packet exceeds ${MAX_PACKET_BYTES} bytes limit`)

  return sealedPacket
}

export async function reconstructContinuation({
  bundle,
  store,
  observeWriter,
  resolveArtifact,
  resolveWorkspace,
  strictWorkspace = false,
  clock = () => new Date().toISOString(),
}) {
  requireDeliveryRecord(bundle, 'continuation-packet')
  if (bundle.schemaVersion !== CONTINUATION_SCHEMA_VERSION)
    throw new Error(`Unsupported continuation schemaVersion: ${bundle.schemaVersion}`)

  const serialized = JSON.stringify(bundle)
  if (Buffer.byteLength(serialized) > MAX_PACKET_BYTES)
    throw new Error('Continuation packet exceeds bounded capacity')
  validateArtifactReferences(bundle.artifacts)

  // 1. Authoritative Store Check
  const snapshot = await store.read()
  const state = strictWorkspace
    ? reduceRun(snapshot.events)
    : (snapshot.state ?? reduceRun(snapshot.events))
  if (!state || state.runId !== bundle.runId)
    throw new Error(`Authoritative run ${bundle.runId} not found`)

  const effectiveRevision = snapshot.revision ?? state.revision
  if (effectiveRevision !== bundle.runRevision)
    throw new Error(
      `Authoritative run revision mismatch: expected ${bundle.runRevision}, observed ${effectiveRevision}`,
    )

  if (state.revision !== effectiveRevision)
    throw new Error('Authoritative state and run revision disagree')
  if (
    bundle.phase !== state.phase ||
    bundle.role !== (RUN_ROLES[state.phase] ?? null) ||
    bundle.candidateDigest !== (state.candidateDigest ?? null) ||
    bundle.policyDigest !==
      (state.delegationPolicy ? recordDigest(state.delegationPolicy) : null) ||
    !sameSummary(bundle.pendingOperations, pendingOperations(state)) ||
    !sameSummary(bundle.openRework, openRework(state)) ||
    !sameSummary(bundle.grant, primaryGrant(state))
  )
    throw new Error('Continuation summary differs from authoritative run state')
  if (strictWorkspace && (!bundle.storeDigest || bundle.storeDigest !== snapshot.sourceRevision))
    throw new Error('Continuation source identity differs from authoritative store')

  // 2. Writer Generation and Liveness Verification
  if (state.generation !== bundle.writer.generation || state.owner !== bundle.writer.owner)
    throw new Error('Writer identity or generation mismatch with authoritative ledger')

  if (typeof observeWriter !== 'function')
    throw new Error('Authoritative writer liveness observer required')

  const writerLiveness = await observeWriter(state)
  if (writerLiveness?.stopped !== true)
    throw new Error('Previous writer liveness unknown or active; continuation refused')

  // 3. Delegation Grant Freshness & Expiry Verification
  if (bundle.grant) {
    const authoritativeGrant = state.grants?.[bundle.grant.id]
    if (!authoritativeGrant)
      throw new Error(`Referenced grant ${bundle.grant.id} missing from authoritative state`)
    if (authoritativeGrant.status !== 'active')
      throw new Error(`Referenced grant ${bundle.grant.id} is revoked`)
    if (recordDigest({ envelope: authoritativeGrant.envelope }) !== bundle.grant.digest)
      throw new Error(`Referenced grant ${bundle.grant.id} tampered or digest mismatch`)
    if (Date.parse(authoritativeGrant.envelope.binding.expiry) <= Date.parse(clock()))
      throw new Error(`Referenced grant ${bundle.grant.id} has expired`)
  }

  if (strictWorkspace) {
    if (typeof resolveWorkspace !== 'function')
      throw new Error('Verified workspace resolver required for strict continuation')
    const workspace = await resolveWorkspace({
      runId: state.runId,
      branch: bundle.branch,
      commitSha: bundle.commitSha,
    })
    if (
      workspace?.verified !== true ||
      workspace.runId !== state.runId ||
      workspace.branch !== bundle.branch ||
      workspace.commitSha !== bundle.commitSha ||
      workspace.candidateDigest !== (state.candidateDigest ?? null) ||
      workspace.storeDigest !== snapshot.sourceRevision
    )
      throw new Error('Workspace identity or candidate differs from authoritative run')
  }

  // 4. Bounded Artifact Integrity Verification
  if (typeof resolveArtifact !== 'function')
    throw new Error('Artifact resolver required for portable continuation')

  const verifiedArtifacts = []
  for (const artRef of bundle.artifacts) {
    const resolved = await resolveArtifact(artRef)
    if (
      !resolved ||
      !(typeof resolved.content === 'string' || resolved.content instanceof Uint8Array)
    )
      throw new Error(`Corrupted or missing continuation artifact: ${artRef.id}`)
    const bytes =
      typeof resolved.content === 'string'
        ? Buffer.from(resolved.content, 'utf8')
        : resolved.content
    if (bytes.byteLength !== artRef.byteLength)
      throw new Error(`Artifact byte length mismatch for ${artRef.id}`)
    const computedDigest = createHash('sha256').update(bytes).digest('hex')
    if (computedDigest !== artRef.digest)
      throw new Error(
        `Artifact digest mismatch for ${artRef.id}: expected ${artRef.digest}, observed ${computedDigest}`,
      )
    verifiedArtifacts.push({
      ...artRef,
      resolvedContent: resolved.content,
    })
  }

  return sealDeliveryRecord('continuation-reconstruction', {
    runId: state.runId,
    verified: true,
    runRevision: effectiveRevision,
    priorWriter: { ...bundle.writer },
    nextGeneration: state.generation + 1,
    phase: state.phase,
    role: RUN_ROLES[state.phase],
    nextSlice: strictWorkspace ? null : bundle.nextSlice,
    candidateDigest: state.candidateDigest,
    pendingOperations: pendingOperations(state),
    openRework: openRework(state),
    verifiedArtifactCount: verifiedArtifacts.length,
    activeGrantId: bundle.grant?.id ?? null,
  })
}
