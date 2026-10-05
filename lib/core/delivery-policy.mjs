import {
  sealDeliveryRecord,
  requireText,
  requireDigest,
  requireUnique,
} from './delivery-record.mjs'

export function resolveDeliveryPolicy(config = {}, budget = null) {
  const fixed = {
    contractVersion: 2,
    sourceAcknowledgmentRequired: true,
    unknownWriterBlocksRecovery: true,
    admissionBudgetRejectsUnknownUsage: true,
  }
  for (const [key, value] of Object.entries(fixed))
    if (config[key] !== undefined && config[key] !== value)
      throw new Error(`Unsupported delivery policy: ${key}`)
  const policy = {
    ...fixed,
    deterministicOrigins: ['collector-observed', 'external-resolved'],
    requiredJourneyCoverage: false,
    budgetMaxima: {},
    ...config,
  }
  if (
    !Array.isArray(policy.deterministicOrigins) ||
    !policy.deterministicOrigins.length ||
    policy.deterministicOrigins.some(
      (origin) => !['collector-observed', 'external-resolved'].includes(origin),
    )
  )
    throw new Error('Invalid deterministic origins policy')
  if (
    typeof policy.requiredJourneyCoverage !== 'boolean' ||
    !policy.budgetMaxima ||
    typeof policy.budgetMaxima !== 'object' ||
    Array.isArray(policy.budgetMaxima)
  )
    throw new Error('Invalid delivery policy')
  for (const [unit, maximum] of Object.entries(policy.budgetMaxima)) {
    if (!unit || !Number.isFinite(maximum) || maximum < 0) throw new Error('Invalid budget maximum')
    if (
      !budget ||
      budget.unit !== unit ||
      budget.level === 'advisory' ||
      !Number.isFinite(budget.limit) ||
      budget.limit > maximum
    )
      throw new Error('Operational budget does not enforce the domain maximum')
  }
  return policy
}

export function validateDeliveryContract(contract) {
  const errors = []
  try {
    if (contract?.version !== 2) throw new Error('Delivery acceptance requires contract version 2')
    requireText(contract.goalRevision, 'goalRevision')
    if (!Array.isArray(contract.criteria) || !contract.criteria.length)
      throw new Error('Acceptance criteria required')
    requireUnique(
      contract.criteria.map((c) => requireText(c.id, 'criterion id')),
      'criteria',
    )
    for (const c of contract.criteria) {
      requireDigest(c.definitionDigest, 'definitionDigest')
      requireUnique(c.assertions, 'assertions')
      if (!c.assertions.length || c.assertions.some((a) => typeof a !== 'string' || !a))
        throw new Error('Explicit assertions required')
      if (
        c.allowedOrigins &&
        (!c.allowedOrigins.length ||
          c.allowedOrigins.some((o) => !['collector-observed', 'external-resolved'].includes(o)))
      )
        throw new Error('Deterministic criteria require observed evidence')
      if (c.maxAgeMs !== undefined && (!Number.isFinite(c.maxAgeMs) || c.maxAgeMs < 0))
        throw new Error('Invalid evidence lifetime')
    }
  } catch (error) {
    errors.push(error.message)
  }
  return { ok: !errors.length, errors }
}

export function journeyCoverage({
  journeys = [],
  criteria = [],
  observations = [],
  candidateDigest,
  acceptedCandidateDigest = null,
  deployment = null,
}) {
  const ids = criteria.map((c) => c.id)
  requireUnique(ids, 'criteria')
  requireUnique(
    journeys.map((j) => requireText(j.id, 'journey id')),
    'journeys',
  )
  const rows = journeys.map((journey) => {
    if (!journey.criteria?.length) throw new Error('Journey requires criterion references')
    const missing = journey.criteria.filter(
      (id) =>
        !ids.includes(id) ||
        !observations.some(
          (o) =>
            o.criterionId === id &&
            o.candidateDigest === candidateDigest &&
            o.resolution?.status === 'pass',
        ),
    )
    return {
      id: journey.id,
      required: journey.required !== false,
      criteria: journey.criteria,
      missing,
      verified: missing.length === 0,
      accepted: missing.length === 0 && candidateDigest === acceptedCandidateDigest,
      deployed:
        missing.length === 0 &&
        deployment?.candidateDigest === candidateDigest &&
        deployment?.outcome === 'pass',
    }
  })
  return {
    version: 1,
    candidateDigest,
    rows,
    status: rows.some((r) => r.required && !r.verified) ? 'blocked' : 'pass',
  }
}

// Provider counters retain their original units. A reset starts a new measurement epoch.
export function normalizeUsage(measurements) {
  const seen = new Map(),
    latest = new Map(),
    totals = {}
  const unknown = []
  for (const m of measurements) {
    requireText(m.id, 'measurement id')
    requireText(m.provider, 'provider')
    requireText(m.epoch, 'measurement epoch')
    const key = `${m.provider}:${m.id}`
    const serialized = JSON.stringify(m)
    if (seen.has(key)) {
      if (seen.get(key) !== serialized) throw new Error('Conflicting usage measurement')
      continue
    }
    seen.set(key, serialized)
    if (!m.counters || m.available !== true) {
      unknown.push(key)
      continue
    }
    for (const [unit, value] of Object.entries(m.counters)) {
      if (!Number.isFinite(value) || value < 0) throw new Error('Invalid usage counter')
      const scope = `${m.provider}:${m.epoch}:${unit}`
      const previous = latest.get(scope) ?? 0
      if (m.mode === 'cumulative' && value < previous)
        throw new Error('Counter reset requires a new epoch')
      if (!['cumulative', 'delta'].includes(m.mode)) throw new Error('Invalid usage mode')
      const delta = m.mode === 'cumulative' ? value - previous : value
      totals[`${m.provider}:${unit}`] = (totals[`${m.provider}:${unit}`] ?? 0) + delta
      latest.set(scope, value)
    }
  }
  return { version: 1, totals, unknown, measurementCount: seen.size }
}

export function budgetAdmission({ budget, used, estimatedNext, providerCanStop = false }) {
  if (
    !['advisory', 'admission-enforced', 'provider-enforced'].includes(budget?.level) ||
    !Number.isFinite(budget.limit) ||
    budget.limit < 0
  )
    throw new Error('Invalid budget')
  const known =
    Number.isFinite(used) && used >= 0 && Number.isFinite(estimatedNext) && estimatedNext >= 0
  const exceeded = known ? used + estimatedNext > budget.limit : null
  const enforceable = budget.level !== 'provider-enforced' || providerCanStop
  const admitted = budget.level === 'advisory' || (known && !exceeded && enforceable)
  return {
    version: 1,
    admitted,
    exceeded,
    known,
    enforceable,
    level: budget.level,
    nextAction: admitted ? 'continue' : 'safe-stop-reconcile-checkpoint',
    reason: !known
      ? 'Usage or next-attempt bound unknown'
      : !enforceable
        ? 'Provider cannot enforce cancellation'
        : exceeded
          ? 'Budget exhausted'
          : 'Within budget',
  }
}

export function resolveLifecycle({ candidateDigest, observations = [], required = [] }) {
  const kinds = ['merge', 'checks', 'tag', 'release', 'deployment', 'rollback']
  const results = required.map(({ kind, target, maxAgeMs, exercised = false, channel = 'any' }) => {
    if (!kinds.includes(kind)) throw new Error('Invalid lifecycle kind')
    if (
      !['any', 'stable', 'prerelease'].includes(channel) ||
      (kind !== 'release' && channel !== 'any')
    )
      throw new Error('Invalid lifecycle release channel')
    if (maxAgeMs !== undefined && (!Number.isFinite(maxAgeMs) || maxAgeMs < 0))
      throw new Error('Invalid lifecycle evidence lifetime')
    const candidates = observations.filter(
      (o) => o.kind === kind && o.target === target && o.candidateDigest === candidateDigest,
    )
    // Conflicting observations remain visible; a later pass must not erase an unresolved failed deployment.
    const valid = candidates.filter(
      (o) =>
        o.sourceVerified === true &&
        o.outcome === 'pass' &&
        (channel === 'any' || o.prerelease === (channel === 'prerelease')) &&
        (!exercised || o.exercised === true) &&
        Number.isFinite(o.ageMs) &&
        o.ageMs >= 0 &&
        (maxAgeMs === undefined || o.ageMs <= maxAgeMs),
    )
    const pass = valid.length > 0 && !candidates.some((o) => o.unresolved === true)
    return {
      kind,
      target,
      channel,
      status: pass ? 'pass' : 'blocked',
      observationIds: valid.map((o) => o.id),
    }
  })
  return sealDeliveryRecord('lifecycle-resolution', {
    candidateDigest,
    results,
    status: results.every((r) => r.status === 'pass') ? 'pass' : 'blocked',
  })
}
