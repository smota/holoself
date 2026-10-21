import {
  sealDeliveryRecord,
  requireDeliveryRecord,
  requireDigest,
  requireText,
} from './delivery-record.mjs'
export const ORACLE_PROOF_GROUPS = Object.freeze(['calibration', 'nativeBaseline', 'build'])
export function createOraclePackageRequest({
  state,
  sourceRevision,
  oracleDigest,
  proposal,
  stage,
}) {
  if (!proposal || !['pin', 'developer'].includes(stage))
    throw new Error('Oracle package proposal and valid stage required')
  requireDigest(oracleDigest, 'oracleDigest')
  requireDigest(proposal.manifestDigest, 'manifestDigest')
  return sealDeliveryRecord('oracle-package-request', {
    runId: state.runId,
    goalRef: state.goalRef,
    runRevision: state.revision,
    sourceRevision,
    generation: state.generation,
    revocationEpoch: state.revocationEpoch,
    candidateDigest: state.candidateDigest ?? null,
    oracleDigest,
    stage,
    proposal: structuredClone(proposal),
  })
}
export function requireOraclePackageRequest(request) {
  requireDeliveryRecord(request, 'oracle-package-request')
  for (const key of ['runId', 'goalRef', 'sourceRevision']) requireText(request[key], key)
  for (const key of ['runRevision', 'oracleDigest']) requireDigest(request[key], key)
  requireDigest(request.proposal?.manifestDigest, 'manifestDigest')
  if (request.candidateDigest !== null) requireDigest(request.candidateDigest, 'candidateDigest')
  if (
    !['pin', 'developer'].includes(request.stage) ||
    !Number.isSafeInteger(request.generation) ||
    request.generation < 0 ||
    !Number.isSafeInteger(request.revocationEpoch) ||
    request.revocationEpoch < 0
  )
    throw new Error('Invalid oracle package native binding')
  return request
}
export function requireOraclePackageReceipt(receipt, request) {
  requireOraclePackageRequest(request)
  requireDeliveryRecord(receipt, 'oracle-package-receipt')
  if (
    receipt.requestDigest !== request.digest ||
    receipt.oracleDigest !== request.oracleDigest ||
    receipt.manifestDigest !== request.proposal.manifestDigest ||
    receipt.candidateExecutionVerified !== false
  )
    throw new Error(
      'Oracle package receipt does not bind current request or falsely claims candidate execution',
    )
  requireDigest(receipt.packageCandidateDigest, 'packageCandidateDigest')
  requireText(receipt.runtimeCriterionId, 'runtimeCriterionId')
  if (!Array.isArray(receipt.artifactIdentities) || !receipt.artifactIdentities.length)
    throw new Error('Oracle artifact identities required')
  if (!Array.isArray(receipt.proofs) || receipt.proofs.length !== ORACLE_PROOF_GROUPS.length)
    throw new Error('Oracle package proof groups incomplete')
  const observations = new Set(),
    definitions = new Set(),
    criteria = new Set()
  for (const group of ORACLE_PROOF_GROUPS) {
    const proofs = receipt.proofs.filter((p) => p.group === group)
    if (proofs.length !== 1) throw new Error('Oracle package proof group missing or duplicated')
    const proof = proofs[0]
    requireText(proof.criterionId, 'proof criterionId')
    requireDigest(proof.observationDigest, 'proof observationDigest')
    requireDigest(proof.executionContextDigest, 'proof executionContextDigest')
    if (
      observations.has(proof.observationDigest) ||
      definitions.has(proof.resolution?.definitionDigest) ||
      criteria.has(proof.criterionId) ||
      proof.observationDigest !== proof.resolution?.observationDigest
    )
      throw new Error('Oracle proof groups reuse another group identity')
    observations.add(proof.observationDigest)
    definitions.add(proof.resolution?.definitionDigest)
    criteria.add(proof.criterionId)
    requireDeliveryRecord(proofs[0].resolution, 'verification-resolution')
    requireDigest(proof.resolution.definitionDigest, 'proof definitionDigest')
    if (
      proofs[0].resolution.status !== 'pass' ||
      proofs[0].resolution.candidateDigest !== receipt.packageCandidateDigest
    )
      throw new Error('Oracle package proof did not pass for current package')
  }
  return receipt
}

export function oraclePackageCandidate(policy, state) {
  return {
    ...policy.candidate,
    context: {
      ...policy.candidate?.context,
      oracleRun: {
        runId: state.runId,
        goalRef: state.goalRef,
        generation: state.generation,
        revocationEpoch: state.revocationEpoch,
      },
    },
  }
}
export function oraclePackageProofIdentity(receipt) {
  return {
    oracleDigest: receipt.oracleDigest,
    manifestDigest: receipt.manifestDigest,
    packageCandidateDigest: receipt.packageCandidateDigest,
    artifactIdentities: receipt.artifactIdentities,
    proofs: receipt.proofs.map((proof) => ({
      group: proof.group,
      criterionId: proof.criterionId,
      observationDigest: proof.observationDigest,
      definitionDigest: proof.resolution.definitionDigest,
      executionContextDigest: proof.executionContextDigest,
    })),
  }
}
