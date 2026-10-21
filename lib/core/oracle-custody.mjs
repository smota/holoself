import {
  sealDeliveryRecord,
  requireDeliveryRecord,
  requireDigest,
  requireText,
} from './delivery-record.mjs'
import { validateArtifactRef } from './artifact-ref.mjs'
import { describeRuntimePlatform } from '../runtime-platforms.mjs'

const MODES = ['historical-author', 'prospective-assignment']
function requireRef(ref, name) {
  if (!validateArtifactRef(ref).ok || !ref.revision || !/^[a-f0-9]{64}$/.test(ref.digest ?? ''))
    throw new Error(`Oracle custody ${name} requires a versioned ArtifactRef with digest`)
}
export function requireOracleCustodyRequest(request) {
  requireDeliveryRecord(request, 'oracle-custody-request')
  for (const field of ['runId', 'goalRef', 'sourceRevision', 'identity'])
    requireText(request[field], field)
  for (const field of ['runRevision', 'oracleDigest']) requireDigest(request[field], field)
  for (const field of ['generation', 'revocationEpoch'])
    if (!Number.isSafeInteger(request[field]) || request[field] < 0)
      throw new Error(`Oracle custody ${field} must retain a non-negative native counter`)
  if (!MODES.includes(request.mode))
    throw new Error(
      'Oracle custody mode must distinguish historical author from prospective assignment',
    )
  if (request.candidateDigest !== null) requireDigest(request.candidateDigest, 'candidateDigest')
  requireRef(request.assignmentRef, 'assignmentRef')
  requireRef(request.manifestRef, 'manifestRef')
  if (request.assignmentRef.authority !== 'authoritative')
    throw new Error('Oracle custody assignment must identify its authoritative source')
  if (!request.evidenceRefs?.length) throw new Error('Oracle custody requires evidence references')
  for (const ref of request.evidenceRefs) requireRef(ref, 'evidenceRef')
  if (!describeRuntimePlatform(request.provenance?.platform))
    throw new Error('Oracle custody requires registered execution provenance')
  requireText(request.provenance?.executor, 'provenance.executor')
  return request
}
export function createOracleCustodyRequest({ state, sourceRevision, proposal }) {
  if (
    !state?.oracleDigest ||
    !state.oraclePin ||
    state.oraclePin.oracleDigest !== state.oracleDigest
  )
    throw new Error('Existing exact oracle pin digest required for custody')
  if (proposal.oracleDigest !== state.oracleDigest)
    throw new Error('Oracle custody proposal digest differs from existing pin')
  return requireOracleCustodyRequest(
    sealDeliveryRecord('oracle-custody-request', {
      runId: state.runId,
      goalRef: state.goalRef,
      runRevision: state.revision,
      sourceRevision,
      generation: state.generation,
      revocationEpoch: state.revocationEpoch,
      candidateDigest: state.candidateDigest ?? null,
      oracleDigest: state.oracleDigest,
      mode: proposal.mode,
      identity: proposal.identity,
      assignmentRef: structuredClone(proposal.assignmentRef),
      manifestRef: structuredClone(proposal.manifestRef),
      evidenceRefs: structuredClone(proposal.evidenceRefs),
      provenance: structuredClone(proposal.provenance),
    }),
  )
}
export function createOracleCustodyReceipt({ request, verifier, verifiedAt }) {
  requireOracleCustodyRequest(request)
  requireText(verifier, 'verifier')
  if (!Number.isFinite(Date.parse(verifiedAt)))
    throw new Error('Oracle custody verification instant required')
  return sealDeliveryRecord('oracle-custody-receipt', {
    requestDigest: request.digest,
    runId: request.runId,
    goalRef: request.goalRef,
    runRevision: request.runRevision,
    sourceRevision: request.sourceRevision,
    generation: request.generation,
    revocationEpoch: request.revocationEpoch,
    oracleDigest: request.oracleDigest,
    candidateDigest: request.candidateDigest,
    mode: request.mode,
    identity: request.identity,
    authorIdentity: request.mode === 'historical-author' ? request.identity : null,
    assigneeIdentity: request.mode === 'prospective-assignment' ? request.identity : null,
    assignmentRef: structuredClone(request.assignmentRef),
    manifestRef: structuredClone(request.manifestRef),
    evidenceRefs: structuredClone(request.evidenceRefs),
    provenance: structuredClone(request.provenance),
    verifier,
    verifiedAt,
  })
}
export function requireOracleCustodyReceipt(receipt, request) {
  requireOracleCustodyRequest(request)
  requireDeliveryRecord(receipt, 'oracle-custody-receipt')
  const expected = createOracleCustodyReceipt({
    request,
    verifier: receipt.verifier,
    verifiedAt: receipt.verifiedAt,
  })
  if (expected.digest !== receipt.digest)
    throw new Error('Oracle custody receipt does not bind exact source request')
  return receipt
}
