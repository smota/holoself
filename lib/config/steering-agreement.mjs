import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { relative, resolve } from 'node:path'
import { withAdoptionLock } from '../adoption/operation-lock.mjs'
import { hasCurrentDigest, recordDigest } from '../core/record-digest.mjs'
import { containedPath } from '../verification/workspace.mjs'
import { loadAuthoritativeConfigs } from './authority.mjs'
import { distributionRole, resolveDistribution } from './execution-distribution.mjs'

export const STEERING_AGREEMENT_VERSION = 1

export const ALLOWED_QUOTA_POLICIES = Object.freeze([
  'park-and-checkpoint',
  'approved-fallback-only',
])

export const ALLOWED_REVIEW_AUTHORITY_MODES = Object.freeze([
  'human-gated-merge',
  'bounded-self-review-with-human-merge',
  'high-assurance-human-signoff',
])

export const ALLOWED_CHECKPOINT_MODES = Object.freeze([
  'phase-boundary',
  'slice-boundary',
  'manual-only',
])

export const STEERING_ENFORCEMENT_LIMITS = Object.freeze({
  conversationalConfirmationGrantsAuthority: false,
  bypassesSteeringBinding: false,
  bypassesMergeReadiness: false,
  fabricatesHostAuthentication: false,
  grantsPublicationOrMergePower: false,
  enforcedByCode: [
    'parameter-shape-and-conflict-validation',
    'distribution-profile-and-digest-verification',
    'confirmation-digest-and-config-preimage-check',
    'native-gate-separation (evaluateSteeringBinding / evaluateMergeReadiness remain independent)',
  ],
  advisoryOrHostDependent: [
    'live-endpoint-authentication (requires host verifyEndpoint callback)',
    'github-collaborator-and-human-review-receipts (requires GitHub/host source verification)',
    'prose-guidance-in-skills-and-culture (disclosed as guidance, not runtime enforcement)',
  ],
  summary:
    'Steering setup records operating preferences and resolved parameters only. It never authenticates a steering endpoint, never satisfies evaluateSteeringBinding or evaluateMergeReadiness, and never grants merge, unfreeze, or publication authority.',
})

const hash = (value) => createHash('sha256').update(value).digest('hex')
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const nonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0
const safeIdentifier = (v) =>
  typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:/@#-]{0,255}$/.test(v.trim())

function resolveConfigFile(root) {
  const file = containedPath(
    root,
    existsSync(resolve(root, 'agentflow.config.json'))
      ? 'agentflow.config.json'
      : 'agent-workflow.config.json',
  )
  const info = statSync(file)
  if (!info.isFile() || info.nlink !== 1) {
    throw new Error('Workflow configuration must be a regular unaliased file')
  }
  return file
}

function atomicWrite(file, bytes, mode = 0o600) {
  const staging = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(staging, bytes, { flag: 'wx', mode, flush: true })
    chmodSync(staging, mode)
    renameSync(staging, file)
  } finally {
    if (existsSync(staging)) unlinkSync(staging)
  }
}

export function validateSteeringAgreementShape(agreement) {
  const errors = []
  if (!isObject(agreement)) {
    return { ok: false, errors: ['steering agreement must be an object'] }
  }
  const allowedTopKeys = [
    'version',
    'goalScope',
    'steeringOwner',
    'returnRoute',
    'executionDistribution',
    'reviewAndPublicationAuthority',
    'quotaPolicy',
    'checkpointsAndStopConditions',
    'authorityBoundary',
    'confirmedDigest',
  ]
  for (const key of Object.keys(agreement)) {
    if (!allowedTopKeys.includes(key)) {
      errors.push(`steering.${key} is unknown`)
    }
  }
  if (agreement.version !== undefined && agreement.version !== STEERING_AGREEMENT_VERSION) {
    errors.push(`steering.version must be ${STEERING_AGREEMENT_VERSION}`)
  }
  if (agreement.goalScope !== undefined && !safeIdentifier(agreement.goalScope)) {
    errors.push('steering.goalScope must be a non-empty identifier or URI')
  }
  if (agreement.steeringOwner !== undefined) {
    if (!safeIdentifier(agreement.steeringOwner)) {
      errors.push('steering.steeringOwner must be a valid steering identity')
    } else if (
      /^(?:dev[.-]|pm[.-]|orch[.-]|rev[.-]|builder|tester|qa|analyst|manager|architect|reviewer)/i.test(
        agreement.steeringOwner.trim(),
      )
    ) {
      errors.push(
        `steering.steeringOwner "${agreement.steeringOwner}" is an in-rig delivery/product seat; steering owner must be an external steering or human identity (e.g. steer.lead or human:<login>)`,
      )
    }
  }
  if (agreement.returnRoute !== undefined) {
    if (!safeIdentifier(agreement.returnRoute)) {
      errors.push('steering.returnRoute must be a valid route identifier')
    } else if (
      /^(?:dev[.-]build|builder|dev[.-]qa|qa|dev[.-]test|test[.-]eng|rev[.-]review|reviewer|pm[.-]analyst|analyst)/i.test(
        agreement.returnRoute.trim().split('@')[0],
      )
    ) {
      errors.push(
        `steering.returnRoute "${agreement.returnRoute}" cannot target an internal builder, tester, reviewer, or analyst seat`,
      )
    }
  }
  if (
    agreement.reviewAndPublicationAuthority !== undefined &&
    !ALLOWED_REVIEW_AUTHORITY_MODES.includes(agreement.reviewAndPublicationAuthority)
  ) {
    errors.push(
      `steering.reviewAndPublicationAuthority must be one of: ${ALLOWED_REVIEW_AUTHORITY_MODES.join(', ')}`,
    )
  }
  if (agreement.quotaPolicy !== undefined) {
    if (!isObject(agreement.quotaPolicy)) {
      errors.push('steering.quotaPolicy must be an object')
    } else {
      if (
        agreement.quotaPolicy.mode !== undefined &&
        !ALLOWED_QUOTA_POLICIES.includes(agreement.quotaPolicy.mode)
      ) {
        errors.push(
          `steering.quotaPolicy.mode must be one of: ${ALLOWED_QUOTA_POLICIES.join(', ')}`,
        )
      }
      if (
        agreement.quotaPolicy.autoMonitoring !== undefined &&
        typeof agreement.quotaPolicy.autoMonitoring !== 'boolean'
      ) {
        errors.push('steering.quotaPolicy.autoMonitoring must be a boolean')
      }
    }
  }
  if (agreement.checkpointsAndStopConditions !== undefined) {
    const cp = agreement.checkpointsAndStopConditions
    if (!isObject(cp)) {
      errors.push('steering.checkpointsAndStopConditions must be an object')
    } else {
      if (
        cp.checkpointBoundary !== undefined &&
        !ALLOWED_CHECKPOINT_MODES.includes(cp.checkpointBoundary)
      ) {
        errors.push(
          `steering.checkpointsAndStopConditions.checkpointBoundary must be one of: ${ALLOWED_CHECKPOINT_MODES.join(', ')}`,
        )
      }
      if (
        cp.maxReworkRounds !== undefined &&
        (!Number.isInteger(cp.maxReworkRounds) || cp.maxReworkRounds < 1 || cp.maxReworkRounds > 10)
      ) {
        errors.push(
          'steering.checkpointsAndStopConditions.maxReworkRounds must be an integer between 1 and 10',
        )
      }
      if (
        cp.supervisorStaleTimeoutMs !== undefined &&
        (!Number.isInteger(cp.supervisorStaleTimeoutMs) || cp.supervisorStaleTimeoutMs < 60000)
      ) {
        errors.push(
          'steering.checkpointsAndStopConditions.supervisorStaleTimeoutMs must be an integer >= 60000',
        )
      }
      if (cp.holdOnUnverifiedAuthority !== undefined && cp.holdOnUnverifiedAuthority !== true) {
        errors.push(
          'steering.checkpointsAndStopConditions.holdOnUnverifiedAuthority must be true (cannot disable authority hold via steering agreement)',
        )
      }
    }
  }
  if (agreement.authorityBoundary !== undefined) {
    const ab = agreement.authorityBoundary
    if (!isObject(ab)) {
      errors.push('steering.authorityBoundary must be an object')
    } else {
      const requiredFalseFlags = [
        'conversationalConfirmationGrantsAuthority',
        'bypassesSteeringBinding',
        'bypassesMergeReadiness',
        'fabricatesHostAuthentication',
        'grantsPublicationOrMergePower',
      ]
      for (const flag of requiredFalseFlags) {
        if (ab[flag] !== undefined && ab[flag] !== false) {
          errors.push(
            `steering.authorityBoundary.${flag} must be false (cannot grant authority via steering agreement)`,
          )
        }
      }
    }
  }
  if (
    agreement.confirmedDigest !== undefined &&
    (typeof agreement.confirmedDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(agreement.confirmedDigest))
  ) {
    errors.push('steering.confirmedDigest must be a 64-character hex sha256 digest')
  }
  return { ok: errors.length === 0, errors }
}

export function computeSteeringParametersDigest(parameters) {
  const ab = parameters.authorityBoundary ?? {}
  const canonical = {
    version: STEERING_AGREEMENT_VERSION,
    goalScope: parameters.goalScope ?? null,
    steeringOwner: parameters.steeringOwner ?? null,
    returnRoute: parameters.returnRoute ?? null,
    executionDistribution: parameters.executionDistribution
      ? {
          profile: parameters.executionDistribution.profile,
          profileDigest: parameters.executionDistribution.profileDigest,
          selectionDigest: parameters.executionDistribution.selectionDigest,
          steerLeadRoute: parameters.executionDistribution.steerLeadRoute,
        }
      : null,
    reviewAndPublicationAuthority: parameters.reviewAndPublicationAuthority ?? null,
    quotaPolicy: parameters.quotaPolicy ?? null,
    checkpointsAndStopConditions: parameters.checkpointsAndStopConditions ?? null,
    authorityBoundary: {
      conversationalConfirmationGrantsAuthority:
        ab.conversationalConfirmationGrantsAuthority ?? false,
      bypassesSteeringBinding: ab.bypassesSteeringBinding ?? false,
      bypassesMergeReadiness: ab.bypassesMergeReadiness ?? false,
      fabricatesHostAuthentication: ab.fabricatesHostAuthentication ?? false,
      grantsPublicationOrMergePower: ab.grantsPublicationOrMergePower ?? false,
    },
  }
  return recordDigest(canonical)
}

export function inspectSteeringAgreement(targetDir = process.cwd(), overrides = {}) {
  const root = resolve(targetDir)
  const loaded = loadAuthoritativeConfigs(root)
  const workflow = loaded.isUnified ? loaded.unified : loaded.workflow
  const domain = loaded.domain ?? {}
  const savedAgreement = isObject(workflow?.steering) ? structuredClone(workflow.steering) : null

  const conflicts = []
  const missingParameters = []
  const questions = []

  // Validate saved agreement shape if present
  if (savedAgreement) {
    const shape = validateSteeringAgreementShape(savedAgreement)
    if (!shape.ok) {
      for (const err of shape.errors) {
        conflicts.push({ parameter: 'steering', reason: err })
      }
    }
  }

  // Validate overrides shape if supplied
  if (Object.keys(overrides).length > 0) {
    const candidateShape = validateSteeringAgreementShape(overrides)
    if (!candidateShape.ok) {
      for (const err of candidateShape.errors) {
        conflicts.push({ parameter: 'overrides', reason: err })
      }
    }
  }

  // 1. Resolve executionDistribution & steer.lead route
  let distributionInfo = null
  const distSelection = workflow?.executionDistribution
  if (!distSelection) {
    missingParameters.push('executionDistribution')
    questions.push({
      parameter: 'executionDistribution',
      status: 'missing',
      prompt:
        'No pinned executionDistribution found in workflow configuration. Run `agentflow-sdlc distribution plan` and confirm a profile before starting steering.',
      suggestedCommand: 'agentflow-sdlc distribution plan --json',
    })
  } else {
    try {
      const resolvedDist = resolveDistribution(distSelection)
      const steerRole = distributionRole(resolvedDist, 'steer.lead')
      distributionInfo = {
        profile: resolvedDist.id,
        profileDigest: resolvedDist.profileDigest,
        selectionDigest: resolvedDist.selectionDigest,
        steerLeadRoute: {
          default: steerRole.options[0],
          fallbacks: steerRole.options.slice(1),
        },
      }
      if (
        savedAgreement?.executionDistribution?.selectionDigest &&
        savedAgreement.executionDistribution.selectionDigest !== resolvedDist.selectionDigest
      ) {
        conflicts.push({
          parameter: 'executionDistribution',
          reason:
            'Pinned executionDistribution changed since the steering agreement was last confirmed.',
        })
      }
    } catch (err) {
      conflicts.push({
        parameter: 'executionDistribution',
        reason: err.message,
      })
      questions.push({
        parameter: 'executionDistribution',
        status: 'conflict',
        prompt: `Pinned executionDistribution is invalid (${err.message}). Resolve distribution policy before steering.`,
      })
    }
  }

  // 2. Resolve goalScope
  const defaultGoalScope =
    overrides.goalScope ??
    savedAgreement?.goalScope ??
    workflow?.delivery?.candidate?.context?.workstream ??
    workflow?.delivery?.source?.repo ??
    null
  if (!nonEmptyString(defaultGoalScope)) {
    missingParameters.push('goalScope')
    questions.push({
      parameter: 'goalScope',
      status: 'missing',
      prompt: 'Which goal URI, workstream, or repository scope should steering govern?',
      example: 'goal-534 or owner/repo',
    })
  }

  // 3. Resolve steeringOwner
  const resolvedOwner = overrides.steeringOwner ?? savedAgreement?.steeringOwner ?? 'steer.lead'
  if (!safeIdentifier(resolvedOwner)) {
    missingParameters.push('steeringOwner')
    questions.push({
      parameter: 'steeringOwner',
      status: 'missing',
      prompt:
        'Which external steering identity owns supervisory decisions (e.g. steer.lead or human:<login>)?',
      options: ['steer.lead', 'human:operator'],
    })
  }

  // 4. Resolve returnRoute
  const resolvedReturnRoute = overrides.returnRoute ?? savedAgreement?.returnRoute ?? 'pm.manager'
  if (!safeIdentifier(resolvedReturnRoute)) {
    missingParameters.push('returnRoute')
    questions.push({
      parameter: 'returnRoute',
      status: 'missing',
      prompt:
        'Which authorized entry seat should receive framed steering briefs or return packets?',
      options: ['pm.manager', 'orch.arch', 'human'],
    })
  }

  // 5. Resolve reviewAndPublicationAuthority
  const domainRequiresHuman =
    domain?.actionPolicy?.externalActionRequiresHumanApproval !== false &&
    domain?.paths?.standard?.requiresHumanApproval !== false
  const defaultReviewAuthority = domainRequiresHuman
    ? 'human-gated-merge'
    : 'bounded-self-review-with-human-merge'
  const resolvedReviewAuthority =
    overrides.reviewAndPublicationAuthority ??
    savedAgreement?.reviewAndPublicationAuthority ??
    defaultReviewAuthority

  if (
    domainRequiresHuman &&
    resolvedReviewAuthority !== 'human-gated-merge' &&
    resolvedReviewAuthority !== 'high-assurance-human-signoff'
  ) {
    conflicts.push({
      parameter: 'reviewAndPublicationAuthority',
      reason:
        'Domain configuration requires human approval for external/standard actions; steering agreement cannot weaken merge authority.',
    })
  }

  // 6. Resolve quotaPolicy (default-off automatic switching, explicit park/fallback)
  const resolvedQuotaPolicy = {
    mode: overrides.quotaPolicy?.mode ?? savedAgreement?.quotaPolicy?.mode ?? 'park-and-checkpoint',
    autoMonitoring:
      overrides.quotaPolicy?.autoMonitoring ?? savedAgreement?.quotaPolicy?.autoMonitoring ?? false,
  }

  // 7. Resolve checkpointsAndStopConditions
  const configMaxRework =
    Number.isInteger(workflow?.collaboration?.maxReworkRounds) &&
    workflow.collaboration.maxReworkRounds > 0
      ? workflow.collaboration.maxReworkRounds
      : 2
  const resolvedCheckpoints = {
    checkpointBoundary:
      overrides.checkpointsAndStopConditions?.checkpointBoundary ??
      savedAgreement?.checkpointsAndStopConditions?.checkpointBoundary ??
      'phase-boundary',
    maxReworkRounds:
      overrides.checkpointsAndStopConditions?.maxReworkRounds ??
      savedAgreement?.checkpointsAndStopConditions?.maxReworkRounds ??
      configMaxRework,
    supervisorStaleTimeoutMs:
      overrides.checkpointsAndStopConditions?.supervisorStaleTimeoutMs ??
      savedAgreement?.checkpointsAndStopConditions?.supervisorStaleTimeoutMs ??
      1800000,
    holdOnUnverifiedAuthority: true,
  }

  if (
    overrides.checkpointsAndStopConditions?.holdOnUnverifiedAuthority === false ||
    savedAgreement?.checkpointsAndStopConditions?.holdOnUnverifiedAuthority === false
  ) {
    conflicts.push({
      parameter: 'checkpointsAndStopConditions.holdOnUnverifiedAuthority',
      reason: 'holdOnUnverifiedAuthority cannot be disabled by steering configuration.',
    })
  }

  const effectiveParameters = {
    version: STEERING_AGREEMENT_VERSION,
    goalScope: defaultGoalScope,
    steeringOwner: resolvedOwner,
    returnRoute: resolvedReturnRoute,
    executionDistribution: distributionInfo,
    reviewAndPublicationAuthority: resolvedReviewAuthority,
    quotaPolicy: resolvedQuotaPolicy,
    checkpointsAndStopConditions: resolvedCheckpoints,
    authorityBoundary:
      overrides.authorityBoundary ??
      savedAgreement?.authorityBoundary ??
      STEERING_ENFORCEMENT_LIMITS,
  }

  const candidateDigest = computeSteeringParametersDigest(effectiveParameters)
  const alreadyConfirmed =
    Boolean(savedAgreement?.confirmedDigest) &&
    savedAgreement.confirmedDigest === candidateDigest &&
    missingParameters.length === 0 &&
    conflicts.length === 0

  if (!alreadyConfirmed && missingParameters.length === 0 && conflicts.length === 0) {
    questions.push({
      parameter: 'confirmation',
      status: savedAgreement ? 'changed-or-unconfirmed' : 'unconfirmed',
      prompt:
        'Confirm the resolved steering operating agreement (including presented defaults for owner, returnRoute, reviewAndPublicationAuthority, quotaPolicy, and checkpoints) with `agentflow-sdlc steer setup --plan --json > .agent-runs/steer-plan.json` and `agentflow-sdlc steer setup --apply --plan-file .agent-runs/steer-plan.json --confirm <digest>`.',
      candidateDigest,
    })
  }

  const status =
    conflicts.length > 0
      ? 'conflict'
      : missingParameters.length > 0
        ? 'missing-parameters'
        : alreadyConfirmed
          ? 'confirmed'
          : 'confirmation-required'

  return {
    ok: status === 'confirmed',
    status,
    alreadyConfirmed,
    reusedConfirmedAgreement: alreadyConfirmed,
    candidateDigest,
    confirmedDigest: savedAgreement?.confirmedDigest ?? null,
    missingParameters,
    conflicts,
    questions,
    agreement: {
      ...effectiveParameters,
      authorityBoundary: STEERING_ENFORCEMENT_LIMITS,
      confirmedDigest: alreadyConfirmed ? savedAgreement.confirmedDigest : null,
    },
    enforcementLimits: STEERING_ENFORCEMENT_LIMITS,
    effects: [],
  }
}

function buildConfigWithSteering(config, inspection) {
  const after = structuredClone(config)
  after.steering = {
    version: STEERING_AGREEMENT_VERSION,
    goalScope: inspection.agreement.goalScope,
    steeringOwner: inspection.agreement.steeringOwner,
    returnRoute: inspection.agreement.returnRoute,
    executionDistribution: inspection.agreement.executionDistribution,
    reviewAndPublicationAuthority: inspection.agreement.reviewAndPublicationAuthority,
    quotaPolicy: inspection.agreement.quotaPolicy,
    checkpointsAndStopConditions: inspection.agreement.checkpointsAndStopConditions,
    authorityBoundary: {
      conversationalConfirmationGrantsAuthority: false,
      bypassesSteeringBinding: false,
      bypassesMergeReadiness: false,
      fabricatesHostAuthentication: false,
      grantsPublicationOrMergePower: false,
    },
    confirmedDigest: inspection.candidateDigest,
  }
  return after
}

export function planSteeringAgreement(targetDir = process.cwd(), overrides = {}) {
  const root = resolve(targetDir)
  const inspection = inspectSteeringAgreement(root, overrides)
  if (inspection.conflicts.length > 0) {
    throw new Error(
      `Steering agreement has conflicts: ${inspection.conflicts.map((c) => `${c.parameter}: ${c.reason}`).join('; ')}`,
    )
  }
  if (inspection.missingParameters.length > 0) {
    throw new Error(
      `Steering agreement is missing required parameters: ${inspection.missingParameters.join(', ')}`,
    )
  }
  const file = resolveConfigFile(root)
  const bytes = readFileSync(file)
  const config = JSON.parse(bytes)
  if (!isObject(config)) {
    throw new Error('Workflow configuration must be an object')
  }
  const afterObj = buildConfigWithSteering(config, inspection)
  const next = Buffer.from(JSON.stringify(afterObj, null, 2) + '\n')
  const plan = {
    version: 1,
    type: 'steering-agreement-plan',
    root,
    configFile: relative(root, file).replace(/\\/g, '/'),
    beforeHash: hash(bytes),
    afterHash: hash(next),
    before: config.steering ?? null,
    after: afterObj.steering,
    candidateDigest: inspection.candidateDigest,
    alreadyConfirmed: inspection.alreadyConfirmed,
    enforcementLimits: STEERING_ENFORCEMENT_LIMITS,
    effects: [],
  }
  return { ...plan, digest: recordDigest(plan) }
}

export function applySteeringAgreement(targetDir = process.cwd(), plan, confirm) {
  const root = resolve(targetDir)
  if (
    !isObject(plan) ||
    plan.type !== 'steering-agreement-plan' ||
    !hasCurrentDigest(plan) ||
    confirm !== plan.digest ||
    plan.root !== root
  ) {
    throw new Error('Exact current steering-agreement plan confirmation required')
  }
  const shape = validateSteeringAgreementShape(plan.after)
  if (!shape.ok) {
    throw new Error(`Invalid steering agreement in plan: ${shape.errors.join('; ')}`)
  }
  const ab = plan.after?.authorityBoundary
  if (
    !isObject(ab) ||
    ab.conversationalConfirmationGrantsAuthority !== false ||
    ab.bypassesSteeringBinding !== false ||
    ab.bypassesMergeReadiness !== false ||
    ab.fabricatesHostAuthentication !== false ||
    ab.grantsPublicationOrMergePower !== false
  ) {
    throw new Error(
      'Steering agreement plan violates authority boundary: all authorityBoundary flags must be explicitly false',
    )
  }
  const expectedCandidateDigest = computeSteeringParametersDigest(plan.after)
  if (
    plan.after.confirmedDigest !== expectedCandidateDigest ||
    plan.candidateDigest !== expectedCandidateDigest
  ) {
    throw new Error('Steering agreement plan confirmedDigest mismatch')
  }
  const checkInspect = inspectSteeringAgreement(root, {
    goalScope: plan.after.goalScope,
    steeringOwner: plan.after.steeringOwner,
    returnRoute: plan.after.returnRoute,
    reviewAndPublicationAuthority: plan.after.reviewAndPublicationAuthority,
    quotaPolicy: plan.after.quotaPolicy,
    checkpointsAndStopConditions: plan.after.checkpointsAndStopConditions,
    authorityBoundary: plan.after.authorityBoundary,
  })
  if (checkInspect.conflicts.length > 0 || checkInspect.missingParameters.length > 0) {
    throw new Error(
      `Steering agreement plan conflicts with current project configuration: ${checkInspect.conflicts.map((c) => c.reason).join('; ')}`,
    )
  }
  return withAdoptionLock(root, () => {
    const file = resolveConfigFile(root)
    const before = readFileSync(file)
    if (hash(before) !== plan.beforeHash) {
      throw new Error('Configuration changed since steering plan was created; replan required')
    }
    const config = JSON.parse(before)
    const nextConfig = structuredClone(config)
    nextConfig.steering = structuredClone(plan.after)
    const next = Buffer.from(JSON.stringify(nextConfig, null, 2) + '\n')
    if (hash(next) !== plan.afterHash) {
      throw new Error('Steering agreement plan afterHash mismatch; replan required')
    }

    const dir = containedPath(root, '.agent-runs', { allowMissing: true })
    mkdirSync(dir, { recursive: true })
    const journal = containedPath(root, `.agent-runs/steering-agreement-${randomUUID()}.json`, {
      allowMissing: true,
    })
    const receipt = {
      version: 1,
      type: 'steering-agreement-receipt',
      root,
      configFile: plan.configFile,
      planDigest: plan.digest,
      confirmedDigest: plan.after.confirmedDigest,
      beforeHash: hash(before),
      afterHash: hash(next),
      beforeBase64: before.toString('base64'),
      mode: statSync(file).mode & 0o777,
      status: 'prepared',
    }
    atomicWrite(
      journal,
      JSON.stringify({ ...receipt, digest: recordDigest(receipt) }, null, 2) + '\n',
    )
    if (hash(readFileSync(file)) !== plan.beforeHash) {
      throw new Error('Config drift before replacement')
    }
    atomicWrite(file, next, receipt.mode)
    if (hash(readFileSync(file)) !== receipt.afterHash) {
      throw new Error('Steering agreement readback mismatch; inspect receipt')
    }
    receipt.status = 'applied'
    atomicWrite(
      journal,
      JSON.stringify({ ...receipt, digest: recordDigest(receipt) }, null, 2) + '\n',
    )
    return {
      ok: true,
      status: 'applied',
      agreement: plan.after,
      confirmedDigest: plan.after.confirmedDigest,
      planDigest: plan.digest,
      receipt: relative(root, journal).replace(/\\/g, '/'),
      enforcementLimits: STEERING_ENFORCEMENT_LIMITS,
      nativeAuthorityGranted: false,
    }
  })
}
