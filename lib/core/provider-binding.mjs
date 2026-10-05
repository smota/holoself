import {
  EXECUTION_INTENTS,
  INTENT_EVIDENCE_LEVELS,
  INTENT_FIDELITIES,
  INTENT_IMPLEMENTATIONS,
} from './execution-intent.mjs'

export const PROVIDER_BINDING_VERSION = 1
export const PROVIDER_FACETS = [
  'inventory',
  'project-adapters',
  'execution',
  'workspace',
  'evidence',
  'lifecycle',
]
export const PROVIDER_AVAILABILITY = ['available', 'unavailable', 'unknown', 'configured', 'manual']

const FACET_OPERATIONS = {
  inventory: 'inventory',
  'project-adapters': 'projectAdapters',
  execution: 'execute',
  workspace: 'workspace',
  evidence: 'evidence',
  lifecycle: 'lifecycle',
}

function intentSupportMap(value = []) {
  return new Map(value.map((item) => [item.id, item]))
}

function validateIntentSupport(items, prefix, errors) {
  if (!Array.isArray(items)) {
    errors.push(`${prefix} must be an array`)
    return
  }
  const seen = new Set()
  for (const [index, item] of items.entries()) {
    const itemPrefix = `${prefix}[${index}]`
    if (!EXECUTION_INTENTS.includes(item?.id)) errors.push(`${itemPrefix}.id is unsupported`)
    if (seen.has(item?.id)) errors.push(`${itemPrefix}.id must be unique`)
    seen.add(item?.id)
    if (!INTENT_IMPLEMENTATIONS.includes(item?.implementation)) {
      errors.push(`${itemPrefix}.implementation is invalid`)
    }
    if (!INTENT_FIDELITIES.includes(item?.fidelity))
      errors.push(`${itemPrefix}.fidelity is invalid`)
    if (!INTENT_EVIDENCE_LEVELS.includes(item?.evidence))
      errors.push(`${itemPrefix}.evidence is invalid`)
    if (item?.limits !== undefined && (!item.limits || typeof item.limits !== 'object')) {
      errors.push(`${itemPrefix}.limits must be an object`)
    }
  }
}

export function validateProviderDescriptor(provider) {
  const errors = []
  if (provider?.version !== 1) errors.push('provider version must be 1')
  if (!provider?.id) errors.push('provider id is required')
  if (!provider?.providerVersion) errors.push('providerVersion is required')
  if (provider?.spiRange?.min !== 1 || provider?.spiRange?.max < 1) {
    errors.push('provider SPI range must include version 1')
  }
  if (!Array.isArray(provider?.facets)) errors.push('provider facets must be an array')
  for (const facet of provider?.facets ?? []) {
    if (!PROVIDER_FACETS.includes(facet)) errors.push(`unsupported provider facet: ${facet}`)
    const operation = FACET_OPERATIONS[facet]
    if (typeof provider?.operations?.[operation] !== 'function') {
      errors.push(`provider facet ${facet} requires operations.${operation}()`)
    }
  }
  validateIntentSupport(provider?.intentSupport, 'provider intentSupport', errors)
  if (provider?.facets?.includes('execution')) {
    if (!provider?.platform) errors.push('execution provider platform identity is required')
    for (const method of ['plan', 'execute', 'status', 'cancel', 'cleanup', 'receipt']) {
      if (typeof provider?.[method] !== 'function') {
        errors.push(`execution provider requires ${method}()`)
      }
    }
  }
  for (const field of ['targets', 'transports', 'osSupport']) {
    if (!Array.isArray(provider?.[field])) errors.push(`${field} must be an array`)
  }
  if (!provider?.trust?.source) errors.push('provider trust source is required')
  if (!provider?.compatibility?.agentflow) errors.push('provider compatibility is required')
  if (typeof provider?.inspect !== 'function') errors.push('provider inspect() is required')
  return { ok: errors.length === 0, errors }
}

function requirementsFrom(intent) {
  if (Array.isArray(intent?.execution?.requirements)) return intent.execution.requirements
  if (Array.isArray(intent?.requirements)) return intent.requirements
  return []
}

function facetsFrom(intent) {
  if (Array.isArray(intent?.execution?.requiredFacets)) return intent.execution.requiredFacets
  if (Array.isArray(intent?.requiredFacets)) return intent.requiredFacets
  return ['execution', 'evidence']
}

function resolveIntents(requirements, supportItems, fallback) {
  const support = intentSupportMap(supportItems)
  return requirements.map((requirement) => {
    const observed = support.get(requirement.id)
    const minimumFidelity = requirement.parameters?.minimumFidelity
    const found = minimumFidelity && observed?.fidelity !== minimumFidelity ? null : observed
    if (found) return { ...requirement, ...found, status: 'satisfied' }
    const allowedFallbacks = fallback?.modes ?? []
    const fallbackMode = allowedFallbacks.includes(requirement.fallback)
      ? requirement.fallback
      : (allowedFallbacks[0] ?? null)
    if (!requirement.required) {
      return { ...requirement, status: 'skipped', reason: 'optional intent is unavailable' }
    }
    if (fallback?.allowed && fallbackMode) {
      return {
        ...requirement,
        implementation: fallbackMode === 'manual' ? 'manual' : 'emulated',
        fidelity: 'degraded',
        evidence: 'contract-tested',
        status: 'degraded',
        fallback: fallbackMode,
        reason: `required intent is unavailable; using explicit ${fallbackMode} fallback`,
      }
    }
    return { ...requirement, status: 'blocked', reason: 'required intent is unavailable' }
  })
}

export async function bindProvider({ intent, providers = [], preferredProvider = null } = {}) {
  if (intent?.version !== 1) throw new Error('CollaborationIntent version 1 is required')
  const requiredFacets = facetsFrom(intent)
  const requirements = requirementsFrom(intent)
  const named = preferredProvider
    ? providers.find((provider) => provider.id === preferredProvider)
    : null
  if (preferredProvider && !named) {
    return blockedBinding(`explicit provider ${preferredProvider} is not registered`, [])
  }
  const ordered = named ? [named] : providers
  const attempts = []
  let degradedCandidate = null

  for (const provider of ordered) {
    if (provider.id === 'manual' && !preferredProvider) continue
    const descriptor = validateProviderDescriptor(provider)
    if (!descriptor.ok) {
      attempts.push({
        provider: provider?.id ?? 'unknown',
        availability: 'unavailable',
        reason: descriptor.errors.join('; '),
      })
      continue
    }
    const missingFacets = requiredFacets.filter((facet) => !provider.facets.includes(facet))
    if (missingFacets.length) {
      attempts.push({
        provider: provider.id,
        availability: 'unavailable',
        reason: `missing facets: ${missingFacets.join(', ')}`,
      })
      continue
    }
    const inspected = await provider.inspect()
    const support = inspected.intentSupport ?? provider.intentSupport
    const supportErrors = []
    validateIntentSupport(support, 'inspected intentSupport', supportErrors)
    if (supportErrors.length) {
      attempts.push({
        provider: provider.id,
        availability: 'unavailable',
        reason: supportErrors.join('; '),
      })
      continue
    }
    const intentResolutions = resolveIntents(requirements, support, intent.fallback)
    const blocked = intentResolutions.filter((item) => item.status === 'blocked')
    attempts.push({
      provider: provider.id,
      platform: inspected.platform ?? provider.platform ?? null,
      availability: inspected.availability,
      reason: inspected.reason,
      intentResolutions,
    })
    if (!['available', 'configured', 'manual'].includes(inspected.availability)) continue
    if (blocked.length) continue
    const degraded =
      provider.id === 'manual' ||
      intentResolutions.some(
        (item) =>
          item.status === 'degraded' || (item.status === 'satisfied' && item.fidelity !== 'full'),
      )
    const candidate = {
      version: PROVIDER_BINDING_VERSION,
      status: degraded ? 'degraded' : 'bound',
      provider: provider.id,
      platform: inspected.platform ?? provider.platform ?? null,
      facets: [...provider.facets],
      intentResolutions,
      executionTarget: inspected.executionTarget ?? null,
      transport: inspected.transport ?? null,
      delegationBoundary: inspected.delegationBoundary ?? null,
      availability: inspected.availability,
      degraded,
      reason: degraded ? 'provider bound with explicit semantic fallback' : inspected.reason,
      attempts,
      metadata: inspected.metadata ?? {},
    }
    if (degraded && !preferredProvider) {
      degradedCandidate ??= candidate
      continue
    }
    return finalizeBinding(candidate)
  }

  if (degradedCandidate) return finalizeBinding({ ...degradedCandidate, attempts })
  if (intent.fallback?.allowed && !preferredProvider) {
    const manual = providers.find((provider) => provider.id === 'manual')
    if (manual) return bindProvider({ intent, providers: [manual], preferredProvider: 'manual' })
  }
  return finalizeBinding(
    blockedBinding(
      preferredProvider
        ? `explicit provider ${preferredProvider} did not satisfy the intent; substitution is forbidden`
        : 'no provider satisfied the required facets and execution intents',
      attempts,
    ),
  )
}

// W8g D1 — validateProviderBinding used to have no caller anywhere in this repo's own product
// code (only lib/__tests__/modular-contracts.test.mjs exercised it as a contract-shape check).
// Its natural enforcement point is right here: the one place a ProviderBinding record is composed
// and handed back to a caller. This is a real, reachable gap it was already able to catch: a
// provider whose facets do not include 'execution' is never required to declare a `platform`
// (validateProviderDescriptor), so it can be accepted as 'bound'/'available' while
// `inspected.platform ?? provider.platform ?? null` resolves to null — a binding that claims to
// be bound to nothing. Before this, that malformed record was silently returned to the caller;
// now it is refused at the point it is created.
function finalizeBinding(binding) {
  const validation = validateProviderBinding(binding)
  if (!validation.ok) {
    throw new Error(`invalid provider binding: ${validation.errors.join('; ')}`)
  }
  return binding
}

function blockedBinding(reason, attempts) {
  return {
    version: PROVIDER_BINDING_VERSION,
    status: 'blocked',
    provider: null,
    platform: null,
    facets: [],
    intentResolutions: [],
    executionTarget: null,
    transport: null,
    delegationBoundary: null,
    availability: 'unavailable',
    degraded: false,
    reason,
    attempts,
    metadata: {},
  }
}

export function validateProviderBinding(binding) {
  const errors = []
  if (binding?.version !== PROVIDER_BINDING_VERSION) errors.push('version must be 1')
  if (!['bound', 'degraded', 'blocked'].includes(binding?.status)) errors.push('status is invalid')
  if (!PROVIDER_AVAILABILITY.includes(binding?.availability)) errors.push('availability is invalid')
  if (!Array.isArray(binding?.facets)) errors.push('facets must be an array')
  if (!Array.isArray(binding?.intentResolutions)) errors.push('intentResolutions must be an array')
  if (binding?.status === 'blocked' ? binding?.platform !== null : !binding?.platform) {
    errors.push('platform must identify the bound executor, or be null when blocked')
  }
  return { ok: errors.length === 0, errors }
}
