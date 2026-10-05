import {
  sealDeliveryRecord,
  requireDeliveryRecord,
  requireDigest,
  requireText,
} from './delivery-record.mjs'
import { recordDigest } from './record-digest.mjs'
import { runtimePlatformRegistry } from '../runtime-platforms.mjs'

const instant = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value))

export function createIntentConsentRequest({ state, planDigest, scope, platformConfig = {} }) {
  if (!state?.contract || !state.contractSourceRevision || state.phase !== 0)
    throw new Error('Frozen phase-zero intent required')
  requireDigest(planDigest, 'planDigest')
  if (
    !scope ||
    !Array.isArray(scope.checks) ||
    !scope.checks.length ||
    !Array.isArray(scope.destinations) ||
    !scope.destinations.length ||
    !scope.businessBoundary ||
    !Object.hasOwn(scope, 'budget') ||
    !Object.hasOwn(scope, 'expiry')
  )
    throw new Error('Complete host intent scope required')
  return sealDeliveryRecord('intent-consent-request', {
    gateClass: 'adequacy-of-intent',
    runId: state.runId,
    runRevision: state.revision,
    generation: state.generation,
    goalRef: state.goalRef,
    goalRevision: requireText(state.contract.goalRevision, 'goalRevision'),
    contractSourceRevision: state.contractSourceRevision,
    contractDigest: recordDigest(state.contract),
    planDigest,
    profile: state.profile,
    observerRuntimes: runtimePlatformRegistry(platformConfig)
      .platforms.filter(({ kind }) => kind !== 'human')
      .map(({ slug }) => slug),
    scope: structuredClone(scope),
  })
}

export function createHostIntentConsent({
  request,
  decision,
  observerRuntime,
  sessionDigest,
  turnDigest,
  evidenceDigest,
  decisionRef,
  observedAt,
  expiresAt,
}) {
  requireDeliveryRecord(request, 'intent-consent-request')
  return sealDeliveryRecord('host-intent-consent', {
    requestDigest: request.digest,
    gateClass: request.gateClass,
    runId: request.runId,
    decision,
    assurance: 'agent-observed-local-cooperative',
    observerRuntime,
    sessionDigest,
    turnDigest,
    evidenceDigest,
    decisionRef,
    observedAt,
    expiresAt,
  })
}

export function verifyHostIntentConsent(request, consent, now = new Date().toISOString()) {
  requireDeliveryRecord(request, 'intent-consent-request')
  requireDeliveryRecord(consent, 'host-intent-consent')
  if (
    consent.decision !== 'agree' ||
    consent.requestDigest !== request.digest ||
    consent.gateClass !== 'adequacy-of-intent' ||
    consent.runId !== request.runId ||
    consent.assurance !== 'agent-observed-local-cooperative' ||
    !Array.isArray(request.observerRuntimes) ||
    !request.observerRuntimes.includes(consent.observerRuntime) ||
    !/^[a-f0-9]{64}$/.test(consent.sessionDigest ?? '') ||
    !/^[a-f0-9]{64}$/.test(consent.turnDigest ?? '') ||
    !/^[a-f0-9]{64}$/.test(consent.evidenceDigest ?? '') ||
    !/^[a-f0-9]{64}$/.test(consent.decisionRef ?? '') ||
    !instant(consent.observedAt) ||
    !instant(consent.expiresAt) ||
    Date.parse(consent.observedAt) >= Date.parse(consent.expiresAt) ||
    Date.parse(consent.observedAt) > Date.parse(now) ||
    Date.parse(consent.expiresAt) <= Date.parse(now)
  )
    throw new Error('Host intent consent is absent, stale or mismatched')
  return consent
}
