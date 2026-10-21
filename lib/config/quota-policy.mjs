import { recordDigest } from '../core/record-digest.mjs'
import { loadAuthoritativeConfigs } from './authority.mjs'
import {
  defaultDistributionSelection,
  distributionRole,
  resolveDistribution,
  selectDistributionRoute,
} from './execution-distribution.mjs'

export const QUOTA_POLICY_VERSION = 1
export const ALLOWED_QUOTA_WINDOWS = Object.freeze(['weekly', 'five-hour'])
export const ALLOWED_OBSERVATION_SOURCES = Object.freeze([
  'provider-status-api',
  'provider-rate-limit-headers',
  'subscription-dashboard-snapshot',
  'cli-usage-probe',
  'operator-reported-snapshot',
])
export const ALLOWED_OBSERVATION_MODES = Object.freeze(['supported', 'approximate', 'unavailable'])
export const ALLOWED_CHECKPOINT_CADENCES = Object.freeze([
  'phase-boundary',
  'slice-boundary',
  'turn-boundary',
])

export const QUOTA_COVERAGE_DISCLOSURE = Object.freeze({
  defaultEnabled: false,
  grantsPublicationOrPushAuthority: false,
  rewritesSavedDistributionPolicy: false,
  treatsSameSubscriptionModelsAsIndependentQuota: false,
  parsesTranscriptOrContextTokensAsQuota: false,
  enforcedByCode: [
    'default-off-no-intervention',
    'weekly-and-five-hour-window-validation-and-simultaneous-worst-window-precedence',
    'supported-approximate-stale-unavailable-observation-classification',
    'shared-subscription-budget-accounting (models on same subscription share one quota pool)',
    'checkpoint-gate-cooldown-and-max-switches-anti-storm-guard (evaluated from supplied checkpoint and switch-history state)',
    'four-eyes-excluded-family-filtering-and-custody-metadata-passthrough',
  ],
  advisoryOrHostDependent: [
    'live-provider-quota-telemetry (depends on provider headers, CLI probes, or operator snapshots)',
    'host-phase-boundary-and-active-writer-fencing (host/adapter supplies atSafeCheckpoint, excludedFamilies, and switchHistory)',
    'git-commit-and-push-on-park (requires existing task/host publication authorization; quota policy grants none)',
    'prose-guidance-in-skills-and-culture (advisory guidance; runtime decisions come from evaluateSeatQuotaControl)',
  ],
  summary:
    'Quota control defaults off. When enabled, it evaluates supported or approximate weekly/five-hour remaining quota observations across seats, requires a safe checkpoint before switching to an approved distribution fallback on a distinct subscription budget, and parks with preserved ownership and custody when no eligible fallback exists. It never parses transcript prose or context tokens as quota and grants no new commit, push, or publication authority.',
})

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v)
const safeId = (v) =>
  typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:/@#-]{0,159}$/.test(v.trim())
const normalizeWorktreePath = (p) =>
  typeof p === 'string' && p.trim() ? p.trim().replace(/\\/g, '/') : null

export function defaultQuotaControlPolicy() {
  return {
    version: QUOTA_POLICY_VERSION,
    enabled: false,
    windows: ['weekly'],
    thresholdRemainingPct: 25,
    checkpointCadence: 'phase-boundary',
    maxObservationAgeMs: 300000,
    minSwitchCooldownMs: 300000,
    maxSwitchesPerIncident: 2,
    fallbackAction: 'approved-fallback-or-park',
    simultaneousWindowRule: 'most-restrictive',
  }
}

export function validateQuotaControlPolicyShape(policy) {
  const errors = []
  if (!isObject(policy)) {
    return { ok: false, errors: ['quotaControl must be an object'] }
  }
  const allowedKeys = [
    'version',
    'enabled',
    'windows',
    'thresholdRemainingPct',
    'windowThresholds',
    'checkpointCadence',
    'maxObservationAgeMs',
    'minSwitchCooldownMs',
    'maxSwitchesPerIncident',
    'fallbackAction',
    'simultaneousWindowRule',
  ]
  for (const key of Object.keys(policy)) {
    if (!allowedKeys.includes(key)) {
      errors.push(`quotaControl.${key} is unknown`)
    }
  }
  if (policy.version !== undefined && policy.version !== QUOTA_POLICY_VERSION) {
    errors.push(`quotaControl.version must be ${QUOTA_POLICY_VERSION}`)
  }
  if (policy.enabled !== undefined && typeof policy.enabled !== 'boolean') {
    errors.push('quotaControl.enabled must be a boolean')
  }
  if (policy.windows !== undefined) {
    if (
      !Array.isArray(policy.windows) ||
      policy.windows.length === 0 ||
      policy.windows.some((w) => !ALLOWED_QUOTA_WINDOWS.includes(w)) ||
      new Set(policy.windows).size !== policy.windows.length
    ) {
      errors.push(
        `quotaControl.windows must be a non-empty unique array of: ${ALLOWED_QUOTA_WINDOWS.join(', ')}`,
      )
    }
  }
  if (
    policy.thresholdRemainingPct !== undefined &&
    (!isFiniteNumber(policy.thresholdRemainingPct) ||
      policy.thresholdRemainingPct <= 0 ||
      policy.thresholdRemainingPct >= 100)
  ) {
    errors.push('quotaControl.thresholdRemainingPct must be a number between 0 and 100 (exclusive)')
  }
  if (policy.windowThresholds !== undefined) {
    if (!isObject(policy.windowThresholds)) {
      errors.push('quotaControl.windowThresholds must be an object')
    } else {
      for (const [win, val] of Object.entries(policy.windowThresholds)) {
        if (!ALLOWED_QUOTA_WINDOWS.includes(win)) {
          errors.push(`quotaControl.windowThresholds.${win} is not a supported window`)
        } else if (!isFiniteNumber(val) || val <= 0 || val >= 100) {
          errors.push(`quotaControl.windowThresholds.${win} must be a number between 0 and 100`)
        }
      }
    }
  }
  if (
    policy.checkpointCadence !== undefined &&
    !ALLOWED_CHECKPOINT_CADENCES.includes(policy.checkpointCadence)
  ) {
    errors.push(
      `quotaControl.checkpointCadence must be one of: ${ALLOWED_CHECKPOINT_CADENCES.join(', ')}`,
    )
  }
  if (
    policy.maxObservationAgeMs !== undefined &&
    (!Number.isInteger(policy.maxObservationAgeMs) ||
      policy.maxObservationAgeMs < 10000 ||
      policy.maxObservationAgeMs > 86400000)
  ) {
    errors.push('quotaControl.maxObservationAgeMs must be an integer between 10000 and 86400000')
  }
  if (
    policy.minSwitchCooldownMs !== undefined &&
    (!Number.isInteger(policy.minSwitchCooldownMs) || policy.minSwitchCooldownMs < 0)
  ) {
    errors.push('quotaControl.minSwitchCooldownMs must be a non-negative integer')
  }
  if (
    policy.maxSwitchesPerIncident !== undefined &&
    (!Number.isInteger(policy.maxSwitchesPerIncident) ||
      policy.maxSwitchesPerIncident < 1 ||
      policy.maxSwitchesPerIncident > 10)
  ) {
    errors.push('quotaControl.maxSwitchesPerIncident must be an integer between 1 and 10')
  }
  if (
    policy.fallbackAction !== undefined &&
    !['approved-fallback-or-park', 'park-only'].includes(policy.fallbackAction)
  ) {
    errors.push('quotaControl.fallbackAction must be approved-fallback-or-park or park-only')
  }
  if (
    policy.simultaneousWindowRule !== undefined &&
    policy.simultaneousWindowRule !== 'most-restrictive'
  ) {
    errors.push('quotaControl.simultaneousWindowRule must be most-restrictive')
  }
  return { ok: errors.length === 0, errors }
}

export function resolveQuotaControlPolicy(configOrRoot = process.cwd(), overrides = {}) {
  let workflow = {}
  if (typeof configOrRoot === 'string') {
    const loaded = loadAuthoritativeConfigs(configOrRoot)
    workflow = loaded.isUnified ? loaded.unified : loaded.workflow
  } else if (isObject(configOrRoot)) {
    workflow = configOrRoot
  }
  const saved = isObject(workflow?.quotaControl) ? workflow.quotaControl : {}
  const steeringQuota = isObject(workflow?.steering?.quotaPolicy)
    ? workflow.steering.quotaPolicy
    : {}

  const base = defaultQuotaControlPolicy()
  const merged = {
    ...base,
    ...(steeringQuota.mode === 'park-and-checkpoint' ? { fallbackAction: 'park-only' } : {}),
    ...saved,
    ...overrides,
  }
  const shape = validateQuotaControlPolicyShape(merged)
  if (!shape.ok) {
    throw new Error(`Invalid quota control policy: ${shape.errors.join('; ')}`)
  }
  return {
    ...merged,
    policyDigest: recordDigest(merged),
  }
}

/**
 * Classifies a single quota observation. Never parses transcript text or context token counts.
 */
export function classifyQuotaObservation(
  observation = {},
  {
    nowMs = Date.now(),
    maxObservationAgeMs = 300000,
    thresholdRemainingPct = 25,
    windowThresholds = {},
  } = {},
) {
  if (!isObject(observation) || !isFiniteNumber(nowMs)) {
    return {
      valid: false,
      classification: 'unavailable',
      health: 'unknown',
      reason: 'malformed-observation',
    }
  }
  // Explicitly reject context-window or transcript-token confusion
  if (
    observation.kind === 'context-tokens' ||
    observation.kind === 'transcript-text' ||
    observation.source === 'transcript' ||
    observation.source === 'context-window'
  ) {
    return {
      valid: false,
      classification: 'unavailable',
      health: 'unknown',
      reason: 'context-or-transcript-usage-is-not-provider-quota',
    }
  }

  const subscription =
    typeof observation.subscription === 'string' ? observation.subscription.trim() : ''
  const window = typeof observation.window === 'string' ? observation.window.trim() : ''
  const source = typeof observation.source === 'string' ? observation.source.trim() : ''
  const mode = observation.mode ?? 'supported'

  if (!subscription || !ALLOWED_QUOTA_WINDOWS.includes(window)) {
    return {
      valid: false,
      subscription: subscription || null,
      window: window || null,
      classification: 'unavailable',
      health: 'unknown',
      reason: 'missing-subscription-or-unsupported-window',
    }
  }

  if (!ALLOWED_OBSERVATION_SOURCES.includes(source) || !ALLOWED_OBSERVATION_MODES.includes(mode)) {
    return {
      valid: false,
      subscription,
      window,
      classification: 'unavailable',
      health: 'unknown',
      reason: 'unsupported-observation-source-or-mode',
    }
  }

  const observedAt = isFiniteNumber(observation.observedAt)
    ? observation.observedAt
    : typeof observation.observedAt === 'string'
      ? Date.parse(observation.observedAt)
      : NaN

  if (!isFiniteNumber(observedAt) || observedAt > nowMs) {
    return {
      valid: false,
      subscription,
      window,
      source,
      classification: 'unavailable',
      health: 'unknown',
      reason: 'missing-or-future-timestamp',
    }
  }

  const ageMs = nowMs - observedAt
  if (ageMs > maxObservationAgeMs) {
    return {
      valid: true,
      subscription,
      window,
      source,
      observedAt,
      ageMs,
      classification: 'stale',
      health: 'unknown',
      reason: 'observation-exceeds-max-age',
    }
  }

  const resetAtRaw = observation.resetAt
  const resetAt = isFiniteNumber(resetAtRaw)
    ? resetAtRaw
    : typeof resetAtRaw === 'string'
      ? Date.parse(resetAtRaw)
      : null
  const evidencedResetAt = isFiniteNumber(resetAt) && resetAt > nowMs ? resetAt : null

  if (mode === 'unavailable' || observation.status === 'unavailable') {
    return {
      valid: true,
      subscription,
      window,
      source,
      observedAt,
      ageMs,
      remainingPct: isFiniteNumber(observation.remainingPct) ? observation.remainingPct : null,
      resetAt: evidencedResetAt,
      classification: 'unavailable',
      health: 'unavailable',
      reason: 'provider-reported-unavailable',
    }
  }

  const remainingPct = observation.remainingPct
  if (!isFiniteNumber(remainingPct) || remainingPct < 0 || remainingPct > 100) {
    return {
      valid: false,
      subscription,
      window,
      source,
      observedAt,
      ageMs,
      classification: 'unavailable',
      health: 'unknown',
      reason: 'invalid-or-missing-remaining-percentage',
    }
  }

  const effectiveThreshold = isFiniteNumber(windowThresholds?.[window])
    ? windowThresholds[window]
    : thresholdRemainingPct

  const thresholdCrossed = remainingPct < effectiveThreshold
  const exhausted = remainingPct <= 0

  return {
    valid: true,
    subscription,
    window,
    source,
    observedAt,
    ageMs,
    remainingPct,
    thresholdRemainingPct: effectiveThreshold,
    thresholdCrossed,
    exhausted,
    resetAt: evidencedResetAt,
    classification: mode === 'approximate' ? 'approximate' : 'supported',
    health: thresholdCrossed ? 'threshold-crossed' : 'healthy',
    reason: exhausted
      ? 'quota-exhausted'
      : thresholdCrossed
        ? 'below-remaining-threshold'
        : 'within-quota-budget',
  }
}

/**
 * Evaluates simultaneous configured windows (weekly and/or five-hour) per subscription.
 * Under 'most-restrictive', if ANY configured window crosses its threshold or is unavailable/stale,
 * that subscription is not healthy for new/continued work past a checkpoint.
 */
export function evaluateSubscriptionQuotaPools({
  observations = [],
  policy = defaultQuotaControlPolicy(),
  nowMs = Date.now(),
} = {}) {
  const classified = Array.isArray(observations)
    ? observations.map((obs) =>
        classifyQuotaObservation(obs, {
          nowMs,
          maxObservationAgeMs: policy.maxObservationAgeMs,
          thresholdRemainingPct: policy.thresholdRemainingPct,
          windowThresholds: policy.windowThresholds,
        }),
      )
    : []

  const bySubscription = new Map()
  for (const item of classified) {
    if (!item.subscription) continue
    if (!bySubscription.has(item.subscription)) {
      bySubscription.set(item.subscription, [])
    }
    bySubscription.get(item.subscription).push(item)
  }

  const pools = {}
  for (const [subscription, items] of bySubscription.entries()) {
    // Filter to configured policy windows
    const relevant = items.filter((i) => policy.windows.includes(i.window))
    if (relevant.length === 0) {
      pools[subscription] = {
        subscription,
        status: 'unknown',
        reason: 'no-observation-for-configured-windows',
        windows: {},
        lowestRemainingPct: null,
        resetAt: null,
      }
      continue
    }

    // Deduplicate per window: if multiple observations exist for the same (subscription, window), pick the newest valid one, or mark ambiguous if identical timestamps conflict
    const windowMap = {}
    const missingWindows = []
    let ambiguous = false
    for (const win of policy.windows) {
      const winItems = relevant.filter((i) => i.window === win)
      if (winItems.length === 0) {
        missingWindows.push(win)
        continue
      }
      winItems.sort((a, b) => (b.observedAt ?? 0) - (a.observedAt ?? 0))
      if (
        winItems.length > 1 &&
        winItems[0].observedAt === winItems[1].observedAt &&
        winItems[0].remainingPct !== winItems[1].remainingPct
      ) {
        ambiguous = true
      }
      windowMap[win] = winItems[0]
    }

    if (ambiguous) {
      pools[subscription] = {
        subscription,
        status: 'unknown',
        reason: 'conflicting-simultaneous-window-observations',
        windows: windowMap,
        missingWindows,
        lowestRemainingPct: null,
        resetAt: null,
      }
      continue
    }

    const winValues = Object.values(windowMap)
    const anyThresholdCrossed = winValues.some((w) => w.health === 'threshold-crossed')
    const anyProviderUnavailable = winValues.some((w) => w.health === 'unavailable')
    const anyInvalidOrFuture = winValues.some((w) => w.valid === false)
    const anyStale = winValues.some((w) => w.classification === 'stale')
    const hasMissingConfiguredWindow = missingWindows.length > 0
    const allHealthy =
      !hasMissingConfiguredWindow &&
      winValues.length === policy.windows.length &&
      winValues.every(
        (w) =>
          w.valid === true &&
          (w.classification === 'supported' || w.classification === 'approximate') &&
          w.health === 'healthy',
      )

    const pctList = winValues
      .map((w) => w.remainingPct)
      .filter((v) => typeof v === 'number' && Number.isFinite(v))
    const lowestRemainingPct = pctList.length > 0 ? Math.min(...pctList) : null

    const resetCandidates = winValues
      .map((w) => w.resetAt)
      .filter((v) => typeof v === 'number' && Number.isFinite(v))
    const resetAt = resetCandidates.length > 0 ? Math.max(...resetCandidates) : null

    let status = 'unknown'
    let reason = 'observation-incomplete'
    if (anyThresholdCrossed) {
      status = 'threshold-crossed'
      reason = 'configured-window-below-threshold'
    } else if (anyProviderUnavailable) {
      status = 'unavailable'
      reason = 'configured-window-unavailable'
    } else if (anyInvalidOrFuture) {
      status = 'unknown'
      reason = 'configured-window-invalid-or-unverified'
    } else if (anyStale) {
      status = 'stale'
      reason = 'configured-window-stale-or-unverified'
    } else if (hasMissingConfiguredWindow) {
      status = 'unknown'
      reason = 'missing-observation-for-configured-window'
    } else if (allHealthy) {
      status = 'healthy'
      reason = 'all-observed-windows-healthy'
    }

    pools[subscription] = {
      subscription,
      status,
      reason,
      windows: windowMap,
      missingWindows,
      lowestRemainingPct,
      resetAt,
      observedAt: Math.min(...winValues.map((w) => w.observedAt ?? nowMs)),
    }
  }

  return { classified, pools }
}

/**
 * Evaluates quota control for a specific seat (or all seats) under the project's pinned
 * executionDistribution and quotaControl policy.
 */
export function evaluateSeatQuotaControl({
  seat = 'dev.build',
  currentOption = null,
  policy: rawPolicy = defaultQuotaControlPolicy(),
  selection = defaultDistributionSelection(),
  observations = [],
  atSafeCheckpoint = true,
  excludedFamilies = [],
  switchHistory = { switchCount: 0, lastSwitchAt: null, activeWriterRunning: false },
  preserveState = {
    owner: null,
    taskId: null,
    worktree: null,
    oracleCustodyDigest: null,
    artifactDigests: null,
  },
  nowMs = Date.now(),
} = {}) {
  const { policyDigest: _ignoredDigest, ...policyInput } = isObject(rawPolicy) ? rawPolicy : {}
  const shape = validateQuotaControlPolicyShape(policyInput)
  if (!shape.ok) {
    throw new Error(`Invalid quotaControl policy: ${shape.errors.join('; ')}`)
  }
  const policy = { ...defaultQuotaControlPolicy(), ...policyInput }
  const profile = resolveDistribution(selection)
  const resolvedRole = distributionRole(profile, seat)
  const activeOption = currentOption ?? resolvedRole.options[0]

  // AC1: Disabled policy performs no quota-driven intervention.
  if (policy.enabled !== true) {
    return {
      ok: true,
      enabled: false,
      intervention: 'none',
      status: 'QUOTA_CONTROL_DISABLED',
      seat: resolvedRole.seat,
      currentOption: activeOption,
      selectedOption: activeOption,
      checkpointRequired: false,
      coverageDisclosure: QUOTA_COVERAGE_DISCLOSURE,
      effects: [],
    }
  }

  const { classified, pools } = evaluateSubscriptionQuotaPools({
    observations,
    policy,
    nowMs,
  })

  const currentSub = activeOption.subscription
  const currentPool = pools[currentSub] ?? {
    subscription: currentSub,
    status: 'unknown',
    reason: 'no-observation-for-active-subscription',
    windows: {},
    lowestRemainingPct: null,
    resetAt: null,
  }

  // If current subscription is healthy above threshold, continue without intervention
  if (currentPool.status === 'healthy') {
    return {
      ok: true,
      enabled: true,
      intervention: 'none',
      status: 'QUOTA_HEALTHY_CONTINUE',
      seat: resolvedRole.seat,
      currentOption: activeOption,
      selectedOption: activeOption,
      currentSubscriptionPool: currentPool,
      pools,
      observations: classified,
      checkpointRequired: false,
      coverageDisclosure: QUOTA_COVERAGE_DISCLOSURE,
      effects: [],
    }
  }

  // If observation is unknown or stale, do NOT treat as healthy quota, and do NOT trigger a blind switch;
  // report unknown/stale observation status explicitly.
  if (currentPool.status === 'unknown' || currentPool.status === 'stale') {
    return {
      ok: false,
      enabled: true,
      intervention: 'hold-unverified-quota',
      status:
        currentPool.status === 'stale'
          ? 'QUOTA_OBSERVATION_STALE'
          : 'QUOTA_OBSERVATION_UNAVAILABLE',
      seat: resolvedRole.seat,
      currentOption: activeOption,
      selectedOption: null,
      currentSubscriptionPool: currentPool,
      pools,
      observations: classified,
      checkpointRequired: true,
      obligation: {
        owner: safeId(preserveState?.owner) ? preserveState.owner : resolvedRole.seat,
        action: 'refresh-supported-quota-observation-or-park',
        nextCheckAt: nowMs + Math.min(policy.maxObservationAgeMs, 300000),
      },
      preserved: {
        seat: resolvedRole.seat,
        owner: preserveState?.owner ?? resolvedRole.seat,
        taskId: preserveState?.taskId ?? null,
        worktree: normalizeWorktreePath(preserveState?.worktree),
        oracleCustodyDigest: preserveState?.oracleCustodyDigest ?? null,
        artifactDigests: preserveState?.artifactDigests ?? null,
      },
      coverageDisclosure: QUOTA_COVERAGE_DISCLOSURE,
      effects: [],
    }
  }

  // Current subscription crossed threshold or is unavailable!
  // Check if we are at a safe checkpoint boundary first.
  if (!atSafeCheckpoint) {
    return {
      ok: false,
      enabled: true,
      intervention: 'reach-safe-checkpoint',
      status: 'QUOTA_THRESHOLD_REACH_CHECKPOINT',
      seat: resolvedRole.seat,
      currentOption: activeOption,
      selectedOption: null,
      currentSubscriptionPool: currentPool,
      checkpointCadence: policy.checkpointCadence,
      checkpointRequired: true,
      preserved: {
        seat: resolvedRole.seat,
        owner: preserveState?.owner ?? resolvedRole.seat,
        taskId: preserveState?.taskId ?? null,
        worktree: normalizeWorktreePath(preserveState?.worktree),
        oracleCustodyDigest: preserveState?.oracleCustodyDigest ?? null,
        artifactDigests: preserveState?.artifactDigests ?? null,
      },
      coverageDisclosure: QUOTA_COVERAGE_DISCLOSURE,
      effects: [],
    }
  }

  // Guard against concurrent active writers or retry/switch storms
  if (switchHistory?.activeWriterRunning === true) {
    return {
      ok: false,
      enabled: true,
      intervention: 'park-and-checkpoint',
      status: 'QUOTA_CONCURRENT_WRITER_HOLD',
      reason: 'prior-writer-still-active-cannot-switch',
      seat: resolvedRole.seat,
      currentOption: activeOption,
      selectedOption: null,
      currentSubscriptionPool: currentPool,
      preserved: {
        seat: resolvedRole.seat,
        owner: preserveState?.owner ?? resolvedRole.seat,
        taskId: preserveState?.taskId ?? null,
        worktree: normalizeWorktreePath(preserveState?.worktree),
        oracleCustodyDigest: preserveState?.oracleCustodyDigest ?? null,
        artifactDigests: preserveState?.artifactDigests ?? null,
      },
      obligation: {
        owner: safeId(preserveState?.owner) ? preserveState.owner : 'steer.lead',
        action: 'fence-prior-writer-before-quota-fallback',
        nextCheckAt: currentPool.resetAt ?? nowMs + 300000,
      },
      publicationAuthorityGranted: false,
      coverageDisclosure: QUOTA_COVERAGE_DISCLOSURE,
      effects: [],
    }
  }

  const switchCount = Number.isInteger(switchHistory?.switchCount) ? switchHistory.switchCount : 0
  const lastSwitchAt = isFiniteNumber(switchHistory?.lastSwitchAt)
    ? switchHistory.lastSwitchAt
    : null
  const inCooldown =
    lastSwitchAt !== null &&
    nowMs - lastSwitchAt >= 0 &&
    nowMs - lastSwitchAt < policy.minSwitchCooldownMs

  if (
    policy.fallbackAction === 'park-only' ||
    switchCount >= policy.maxSwitchesPerIncident ||
    inCooldown
  ) {
    const parkReason =
      policy.fallbackAction === 'park-only'
        ? 'policy-configured-for-park-only'
        : inCooldown
          ? 'switch-cooldown-active-avoiding-retry-storm'
          : 'max-switches-per-incident-exhausted'
    const status =
      policy.fallbackAction === 'park-only'
        ? 'QUOTA_PARKED_AT_CHECKPOINT'
        : inCooldown
          ? 'QUOTA_SWITCH_COOLDOWN_HOLD'
          : 'QUOTA_MAX_SWITCHES_EXCEEDED_PARK'
    return {
      ok: false,
      enabled: true,
      intervention: 'park-and-checkpoint',
      status,
      reason: parkReason,
      seat: resolvedRole.seat,
      currentOption: activeOption,
      selectedOption: null,
      currentSubscriptionPool: currentPool,
      preserved: {
        seat: resolvedRole.seat,
        owner: preserveState?.owner ?? resolvedRole.seat,
        taskId: preserveState?.taskId ?? null,
        worktree: normalizeWorktreePath(preserveState?.worktree),
        oracleCustodyDigest: preserveState?.oracleCustodyDigest ?? null,
        artifactDigests: preserveState?.artifactDigests ?? null,
      },
      obligation: {
        owner: safeId(preserveState?.owner) ? preserveState.owner : 'steer.lead',
        action: 'wrap-up-update-records-and-park-until-reset-or-decision',
        nextCheckAt: currentPool.resetAt ?? nowMs + 900000,
        evidencedResetAt: currentPool.resetAt ?? null,
      },
      publicationAuthorityGranted: false,
      coverageDisclosure: QUOTA_COVERAGE_DISCLOSURE,
      effects: [],
    }
  }

  // Build availability records for selectDistributionRoute:
  // Critically, models on the same shared subscription budget (currentSub) CANNOT be selected
  // as an independent quota fallback!
  const effectiveMaxAgeMs = policy.maxObservationAgeMs
  const availability = Object.values(pools).map((pool) => {
    const obsAt = isFiniteNumber(pool.observedAt) ? pool.observedAt : nowMs
    return {
      subscription: pool.subscription,
      status:
        pool.subscription === currentSub
          ? 'unavailable'
          : pool.status === 'healthy'
            ? 'healthy'
            : 'unavailable',
      observedAt: obsAt,
      expiresAt: Math.max(nowMs + 1, obsAt + effectiveMaxAgeMs),
    }
  })

  const routeProposal = selectDistributionRoute({
    selection,
    role: resolvedRole.seat,
    availability,
    excludedFamilies,
    now: nowMs,
    maxAgeMs: effectiveMaxAgeMs,
  })

  if (
    routeProposal.status === 'eligible-proposal' &&
    routeProposal.selected &&
    routeProposal.selected.subscription !== currentSub
  ) {
    return {
      ok: true,
      enabled: true,
      intervention: 'checkpoint-and-fallback',
      status: 'QUOTA_FALLBACK_PROPOSED',
      seat: resolvedRole.seat,
      currentOption: activeOption,
      selectedOption: routeProposal.selected,
      fallbackIndex: routeProposal.fallbackIndex,
      selectionDigest: routeProposal.selectionDigest,
      currentSubscriptionPool: currentPool,
      targetSubscriptionPool: pools[routeProposal.selected.subscription],
      checkpointRequired: true,
      checkpointCadence: policy.checkpointCadence,
      preserved: {
        seat: resolvedRole.seat,
        owner: preserveState?.owner ?? resolvedRole.seat,
        taskId: preserveState?.taskId ?? null,
        worktree: normalizeWorktreePath(preserveState?.worktree),
        oracleCustodyDigest: preserveState?.oracleCustodyDigest ?? null,
        artifactDigests: preserveState?.artifactDigests ?? null,
        reviewerIndependenceExcludedFamilies: [...excludedFamilies],
      },
      savedPolicyModified: false,
      publicationAuthorityGranted: false,
      coverageDisclosure: QUOTA_COVERAGE_DISCLOSURE,
      effects: [],
    }
  }

  // No eligible fallback on a distinct healthy subscription budget -> park cleanly at checkpoint
  return {
    ok: false,
    enabled: true,
    intervention: 'park-and-checkpoint',
    status: 'QUOTA_PARKED_NO_ELIGIBLE_FALLBACK',
    reason: 'no-eligible-fallback-on-distinct-healthy-subscription',
    seat: resolvedRole.seat,
    currentOption: activeOption,
    selectedOption: null,
    currentSubscriptionPool: currentPool,
    fallbackReasons: routeProposal.reasons ?? [],
    checkpointRequired: true,
    preserved: {
      seat: resolvedRole.seat,
      owner: preserveState?.owner ?? resolvedRole.seat,
      taskId: preserveState?.taskId ?? null,
      worktree: normalizeWorktreePath(preserveState?.worktree),
      oracleCustodyDigest: preserveState?.oracleCustodyDigest ?? null,
      artifactDigests: preserveState?.artifactDigests ?? null,
      reviewerIndependenceExcludedFamilies: [...excludedFamilies],
    },
    obligation: {
      owner: safeId(preserveState?.owner) ? preserveState.owner : 'steer.lead',
      action: 'wrap-up-update-records-and-park-until-reset-or-decision',
      nextCheckAt: currentPool.resetAt ?? nowMs + 900000,
      evidencedResetAt: currentPool.resetAt ?? null,
    },
    savedPolicyModified: false,
    publicationAuthorityGranted: false,
    coverageDisclosure: QUOTA_COVERAGE_DISCLOSURE,
    effects: [],
  }
}
