import { readFileSync, lstatSync } from 'node:fs'
import { createHash } from 'node:crypto'
import Ajv2020 from 'ajv/dist/2020.js'
import { containedPath, fingerprintCandidate, computeOracleDigest } from './workspace.mjs'
import { resolveObservation } from './observation-resolver.mjs'
import { verifyObservation } from '../core/verification-observation.mjs'
import { sealDeliveryRecord, requireText } from '../core/delivery-record.mjs'
import {
  requireOraclePackageRequest,
  requireOraclePackageReceipt,
  ORACLE_PROOF_GROUPS,
  oraclePackageCandidate,
} from '../core/oracle-package.mjs'
const LIMIT = 512 * 1024 * 1024 // Same executable identity ceiling as the process collector.
const JSON_LIMIT = 1024 * 1024 // Same report ceiling as the process collector.
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
function readJson(root, path) {
  const target = containedPath(root, path)
  if (lstatSync(target).size > JSON_LIMIT)
    throw new Error('Oracle package JSON report exceeds size limit')
  return JSON.parse(readFileSync(target, 'utf8'))
}
// This verifies source-configured, collector-observed proofs and file identities.
// It does not certify the domain semantics of the pinned checker or source contract.
export function resolveOraclePackage({ root, config, request }) {
  requireOraclePackageRequest(request)
  const policy = config.oracleAssurance
  if (!policy?.manifest || !policy.candidate?.inputs?.length)
    throw new Error('Source-configured oracle package manifest and inputs required')
  const manifestPath = containedPath(root, policy.manifest)
  if (lstatSync(manifestPath).size > JSON_LIMIT)
    throw new Error('Oracle package manifest exceeds size limit')
  const manifestBytes = readFileSync(manifestPath)
  if (hash(manifestBytes) !== request.proposal.manifestDigest)
    throw new Error('Oracle package manifest changed')
  const manifest = JSON.parse(manifestBytes)
  if (!Array.isArray(manifest.artifacts) || !manifest.artifacts.length)
    throw new Error('Oracle package artifact identities required')
  const limit = policy.maxArtifactBytes ?? LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > LIMIT)
    throw new Error('Oracle artifact policy must not exceed collector size ceiling')
  const seen = new Set(),
    roles = new Set()
  for (const artifact of manifest.artifacts) {
    const target = containedPath(root, artifact.path)
    const stat = lstatSync(target)
    if (!stat.isFile() || stat.size > limit || stat.size !== artifact.sizeBytes)
      throw new Error('Oracle artifact size invalid or changed')
    if (
      seen.has(artifact.path) ||
      !policy.candidate.inputs.includes(artifact.path) ||
      !Array.isArray(artifact.roles)
    )
      throw new Error('Oracle artifact coverage invalid')
    seen.add(artifact.path)
    for (const role of artifact.roles) roles.add(role)
    if (hash(readFileSync(target)) !== artifact.digest)
      throw new Error('Oracle artifact identity changed')
  }
  for (const role of [
    'source',
    'build',
    'dependency',
    'executable',
    'native-fixture',
    'expectation',
    'negative-control',
  ])
    if (!roles.has(role)) throw new Error(`Oracle artifact role ${role} missing`)
  for (const role of ['source', 'build', 'dependency', 'executable']) {
    const paths = policy.identities?.[role]
    if (
      !Array.isArray(paths) ||
      !paths.length ||
      !paths.every((path) =>
        manifest.artifacts.some(
          (artifact) => artifact.path === path && artifact.roles.includes(role),
        ),
      )
    )
      throw new Error(`Source-configured oracle ${role} identities incomplete`)
  }
  if (!policy.candidate.inputs.includes(policy.manifest))
    throw new Error('Oracle manifest must be a package candidate input')
  if (
    manifest.baselineInput === manifest.expectedInput ||
    !seen.has(manifest.baselineInput) ||
    !seen.has(manifest.expectedInput)
  )
    throw new Error('Oracle native baseline must not compare expected with itself')
  const baselineIdentity = manifest.artifacts.find((a) => a.path === manifest.baselineInput)
  const expectedIdentity = manifest.artifacts.find((a) => a.path === manifest.expectedInput)
  if (
    !policy.baselineInput ||
    !policy.expectedInput ||
    policy.baselineInput !== manifest.baselineInput ||
    policy.expectedInput !== manifest.expectedInput ||
    !baselineIdentity.roles.includes('native-fixture') ||
    !expectedIdentity.roles.includes('expectation') ||
    baselineIdentity.digest === expectedIdentity.digest
  )
    throw new Error(
      'Oracle native baseline identities require independent source-bound roles and content',
    )
  if (computeOracleDigest({ packageRoot: root }) !== request.oracleDigest)
    throw new Error('Oracle digest changed')
  const candidateDefinition = oraclePackageCandidate(policy, request)
  const candidate = fingerprintCandidate(root, candidateDefinition)
  const calibration = policy.proofs?.calibration
  const calibrationCheck = config.checks?.[calibration?.check]
  if (!Array.isArray(policy.requiredControls) || !policy.requiredControls.length)
    throw new Error('Source-required calibration control map missing')
  for (const control of policy.requiredControls) {
    const mapped = manifest.controlMap?.[control]
    if (
      !mapped ||
      mapped.assertion !== (policy.controlAssertions?.[control] ?? control) ||
      !calibrationCheck?.assertions?.includes(mapped.assertion) ||
      !manifest.artifacts.some(
        (artifact) =>
          artifact.path === mapped.artifact && artifact.roles.includes('negative-control'),
      )
    )
      throw new Error(`Oracle calibration control ${control} missing`)
  }
  requireText(policy.runtimeCriterionId, 'runtimeCriterionId')
  if (manifest.runtimeCriterionId !== policy.runtimeCriterionId)
    throw new Error('Oracle runtime criterion changed')
  const proofs = [],
    usedCriteria = new Set()
  for (const group of ORACLE_PROOF_GROUPS) {
    const proof = policy.proofs?.[group],
      check = config.checks?.[proof?.check]
    if (
      !check ||
      !proof.requiredAssertions?.length ||
      check.format === 'exit-code' ||
      check.criterionId === policy.runtimeCriterionId ||
      usedCriteria.has(check.criterionId)
    )
      throw new Error(
        'Oracle proof requires distinct source-configured assertions and structured execution',
      )
    usedCriteria.add(check.criterionId)
    if (!proof.requiredAssertions.every((id) => check.assertions.includes(id)))
      throw new Error('Oracle source assertion requirements incomplete')
    const ref = request.proposal.observationRefs?.[group]
    if (
      typeof ref !== 'string' ||
      !/^\.agent-runs\/verification\/[a-f0-9-]{36}\/observation\.json$/.test(ref)
    )
      throw new Error('Oracle proof observation must resolve to collector storage')
    const observation = readJson(root, ref)
    const resolved = resolveObservation({
      root,
      config: { candidate: candidateDefinition, checks: config.checks },
      observation,
    })
    if (resolved.check?.criterionId !== check.criterionId)
      throw new Error('Oracle proof belongs to a different configured group')
    const resolution = verifyObservation({
      observation: resolved.observation,
      candidateDigest: candidate.digest,
      definitionDigest: resolved.definitionDigest,
      requiredAssertions: [...new Set([...check.assertions, ...proof.requiredAssertions])],
      sourceVerified: resolved.verified,
      allowedOrigins: ['collector-observed'],
    })
    if (resolution.status !== 'pass')
      throw new Error(`Oracle ${group} proof failed: ${resolution.errors.join('; ')}`)
    if (
      !Array.isArray(check.args) ||
      !proof.entrypoint ||
      !manifest.artifacts.some(
        (a) => a.path === proof.entrypoint && a.roles.includes('executable'),
      ) ||
      !(
        check.executable === proof.entrypoint ||
        check.args[proof.entrypointArg ?? 0] === proof.entrypoint
      )
    )
      throw new Error('Source-configured oracle executable entrypoint is not covered')
    for (const arg of check.args) {
      if (/\.(?:mjs|cjs|js|py|sh|exe)$/i.test(arg) && !seen.has(arg))
        throw new Error('Executed oracle script argument is not covered by artifact identities')
    }
    if (group === 'nativeBaseline') {
      const reportRef = ref.replace(/observation\.json$/, 'report.json')
      const reportPath = containedPath(root, reportRef)
      if (lstatSync(reportPath).size > JSON_LIMIT)
        throw new Error('Oracle report exceeds size limit')
      const reportBytes = readFileSync(reportPath)
      if (!observation.reportDigest || hash(reportBytes) !== observation.reportDigest)
        throw new Error('Native baseline observed report identity changed')
      const report = JSON.parse(reportBytes.toString('utf8'))
      const baselineArtifact = manifest.artifacts.find((a) => a.path === manifest.baselineInput),
        expectedArtifact = manifest.artifacts.find((a) => a.path === manifest.expectedInput)
      if (
        report.invocationId !== observation.invocationId ||
        report.witnesses?.baselineInputDigest !== baselineArtifact.digest ||
        report.witnesses?.expectedInputDigest !== expectedArtifact.digest
      )
        throw new Error('Native baseline witnesses belong to other inputs or invocation')
      if (!policy.requiredWitnesses?.length || !policy.witnessSchema)
        throw new Error('Source native baseline witness schema required')
      const validate = new Ajv2020({ strict: false, validateFormats: false }).compile(
        policy.witnessSchema,
      )
      if (
        !validate(report.witnesses) ||
        !policy.requiredWitnesses.every((key) => Object.hasOwn(report.witnesses ?? {}, key))
      )
        throw new Error('Native baseline schema, row census or payload witness incomplete')
    }
    proofs.push({
      group,
      criterionId: check.criterionId,
      resolution,
      observationDigest: observation.digest,
      executionContextDigest: observation.executionContextDigest,
    })
  }
  const receipt = sealDeliveryRecord('oracle-package-receipt', {
    requestDigest: request.digest,
    oracleDigest: request.oracleDigest,
    manifestDigest: request.proposal.manifestDigest,
    packageCandidateDigest: candidate.digest,
    artifactIdentities: manifest.artifacts,
    proofs,
    runtimeCriterionId: policy.runtimeCriterionId,
    candidateExecutionVerified: false,
  })
  return { verified: true, receipt: requireOraclePackageReceipt(receipt, request) }
}
