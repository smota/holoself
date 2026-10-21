import { selectDistributionRoute } from '../../lib/config/execution-distribution.mjs'
import {
  evaluateSeatQuotaControl,
  resolveQuotaControlPolicy,
  classifyQuotaObservation,
  QUOTA_COVERAGE_DISCLOSURE,
} from '../../lib/config/quota-policy.mjs'
export {
  evaluateSeatQuotaControl,
  resolveQuotaControlPolicy,
  classifyQuotaObservation,
  QUOTA_COVERAGE_DISCLOSURE,
}
import {
  CAPABILITY_TIER_RANK,
  validateFourEyesIndependence,
} from '../../lib/core/execution-receipt.mjs'

import {
  DEFAULT_PLATFORM_CHAINS,
  DEFAULT_TIER_MODEL_MATRIX,
  SEAT_DEFAULT_TIER,
  effectiveTierModels,
} from '../../lib/config/execution-defaults.mjs'
export {
  DEFAULT_PLATFORM_CHAINS,
  DEFAULT_TIER_MODEL_MATRIX,
  SEAT_DEFAULT_TIER,
  FRONTIER_2026_MODELS,
} from '../../lib/config/execution-defaults.mjs'

export function resolveTwoLevelFallback({
  seat,
  capabilityTier = null,
  healthyPlatforms = null,
  atPhaseBoundary = true,
  currentPlatform = null,
  platformChains = DEFAULT_PLATFORM_CHAINS,
  tierMatrix = null,
  config = {},
  bundleConfig = {},
  availability = [],
  excludedFamilies = [],
  now = Date.now(),
} = {}) {
  if (
    !atPhaseBoundary &&
    currentPlatform &&
    healthyPlatforms &&
    !healthyPlatforms.includes(currentPlatform)
  ) {
    throw new Error(
      'MID_PHASE_PLATFORM_SWITCH_DENIED: platform fallback switches are only allowed at phase boundaries',
    )
  }

  const selection = config.executionDistribution ?? bundleConfig.distribution
  if (selection) {
    if (!atPhaseBoundary) {
      return { ok: false, status: 'DISTRIBUTION_PHASE_BOUNDARY_REQUIRED', effects: [] }
    }
    const proposal = selectDistributionRoute({
      selection,
      role: seat,
      availability,
      excludedFamilies,
      now,
    })
    return {
      ...proposal,
      ok: false,
      proposalOnly: true,
      desiredExecution: proposal.selected,
      status: proposal.selected
        ? 'DISTRIBUTION_PROPOSAL_REQUIRES_ADMISSION'
        : 'DISTRIBUTION_AVAILABILITY_UNKNOWN',
    }
  }

  const tier = capabilityTier ?? SEAT_DEFAULT_TIER[seat] ?? 'balanced'
  const chain = platformChains[seat] ?? ['codex:openai-codex', 'claude-code:anthropic']

  const candidateList = !atPhaseBoundary && currentPlatform ? [currentPlatform] : chain

  const tierEntry = tierMatrix
    ? tierMatrix[tier]
    : effectiveTierModels(tier, { config, bundleConfig })
  if (!tierEntry) {
    return { ok: false, status: 'NO_HEALTHY_PLATFORM', seat, capabilityTier: tier }
  }

  const isHealthy = (p) => Array.isArray(healthyPlatforms) && healthyPlatforms.includes(p)

  const selectedPlatform = candidateList.find(
    (platform) => isHealthy(platform) && Boolean(tierEntry[platform]),
  )

  if (!selectedPlatform) {
    return { ok: false, status: 'NO_HEALTHY_PLATFORM', seat, capabilityTier: tier }
  }

  const platformMeta = tierEntry[selectedPlatform]
  const fallbackIndex = chain.indexOf(selectedPlatform)

  return {
    ok: true,
    status: 'RESOLVED',
    seat,
    capabilityTier: tier,
    platform: selectedPlatform,
    ...platformMeta,
    fallbackIndex,
  }
}

export function resolveFourEyesReviewerTarget({
  builderReceipt,
  healthyPlatforms = null,
  reviewerTier = null,
  platformChains = DEFAULT_PLATFORM_CHAINS,
  tierMatrix = DEFAULT_TIER_MODEL_MATRIX,
  config = {},
  bundleConfig = {},
} = {}) {
  if (config.executionDistribution ?? bundleConfig.distribution) {
    return {
      ok: false,
      status: 'DISTRIBUTION_REVIEW_ADMISSION_REQUIRED',
      reason:
        'Pinned distribution review requires observed independent execution and tier evidence',
      effects: [],
    }
  }
  const builderTier = builderReceipt?.metadata?.capabilityTier ?? 'balanced'
  const minRank = Math.max(
    CAPABILITY_TIER_RANK[builderTier] ?? 1,
    CAPABILITY_TIER_RANK[reviewerTier ?? 'deep-reasoning'] ?? 2,
  )
  const effectiveReviewerTier = minRank >= 3 ? 'architect-lead' : 'deep-reasoning'

  const chain = platformChains['rev.review'] ?? [
    'pi:antigravity',
    'claude-code:anthropic',
    'codex:openai-codex',
  ]

  const isHealthy = (p) => Array.isArray(healthyPlatforms) && healthyPlatforms.includes(p)

  const candidatePlatforms = chain.filter((p) => isHealthy(p))

  const tierEntry = tierMatrix?.[effectiveReviewerTier]
  if (tierEntry) {
    for (const platform of candidatePlatforms) {
      const entry = tierEntry[platform]
      if (!entry) continue

      const reviewerReceipt = {
        actual: {
          platform: entry.providerFamily,
          model: entry.model,
          providerFamily: entry.providerFamily,
        },
        metadata: {
          capabilityTier: effectiveReviewerTier,
        },
      }

      const fourEyes = validateFourEyesIndependence(builderReceipt, reviewerReceipt)
      if (fourEyes.ok) {
        return {
          ok: true,
          status: 'FOUR_EYES_RESOLVED',
          seat: 'rev.review',
          capabilityTier: effectiveReviewerTier,
          platform,
          ...entry,
          builderFamily: fourEyes.builderFamily,
          reviewerFamily: fourEyes.reviewerFamily,
        }
      }
    }
  }

  return {
    ok: false,
    status: 'FOUR_EYES_UNAVAILABLE',
    reason: 'No healthy independent provider family meets the builder tier floor',
  }
}

export function enforceEffortDegradationGuard({
  seat = 'dev.build',
  requestedEffort = 'medium',
  phase = 4,
  rung = 'P1',
  isPersistentLoop = true,
  isOneShotBurst = false,
} = {}) {
  const highAllowedByPhase =
    isOneShotBurst ||
    rung === 'P3' ||
    rung === 'P4' ||
    ((phase === 2 || phase === 6) && rung !== 'P0' && !isPersistentLoop)

  if (requestedEffort === 'high' && isPersistentLoop && !highAllowedByPhase) {
    return {
      seat,
      requestedEffort,
      effectiveEffort: seat === 'dev.qa' || seat === 'eval.tester' ? 'low' : 'medium',
      clamped: true,
      reason: 'effort-degradation-guard: high effort clamped on persistent execution loops',
    }
  }

  return {
    seat,
    requestedEffort,
    effectiveEffort: requestedEffort,
    clamped: false,
    reason: 'within-effort-envelope',
  }
}
