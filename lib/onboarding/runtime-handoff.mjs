import { randomUUID } from 'node:crypto'
import {
  SCHEMA_VERSION,
  MAX_ARRAY_ITEMS,
  CAPABILITY_CLI,
  CAPABILITY_SKILLS,
  REQUIRED_CAPABILITIES,
  isBoundedString,
  normalizeComponent,
  evaluateRuntimePolicy,
} from '../core/onboarding-state.mjs'

export function buildRuntimeRequest({
  runtimeId,
  additionalRuntimes = [],
  sharedUpdate = false,
  requestId,
} = {}) {
  if (!isBoundedString(runtimeId)) {
    throw new TypeError('runtimeId is required and must be a bounded non-empty string')
  }
  if (!Array.isArray(additionalRuntimes)) {
    throw new TypeError('additionalRuntimes must be an array')
  }
  if (additionalRuntimes.length > MAX_ARRAY_ITEMS) {
    throw new RangeError(`additionalRuntimes exceeds maximum array bound of ${MAX_ARRAY_ITEMS}`)
  }
  for (const r of additionalRuntimes) {
    if (!isBoundedString(r)) {
      throw new TypeError('Each additionalRuntime must be a bounded non-empty string')
    }
  }
  if (typeof sharedUpdate !== 'boolean') {
    throw new TypeError('sharedUpdate must be a boolean')
  }

  let finalRequestId = requestId
  if (finalRequestId !== undefined && finalRequestId !== null) {
    if (!isBoundedString(finalRequestId)) {
      throw new TypeError('requestId must be a bounded non-empty string')
    }
  } else {
    finalRequestId = randomUUID()
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    requestId: finalRequestId,
    runtimeId: runtimeId.trim(),
    additionalRuntimes: additionalRuntimes.map((r) => r.trim()),
    sharedUpdate,
    assessUpdates: true,
    requiredCapabilities: [
      {
        id: CAPABILITY_CLI,
        kind: 'cli',
        description: 'AgentFlow CLI executable and core command interface',
      },
      {
        id: CAPABILITY_SKILLS,
        kind: 'skills',
        description: 'AgentFlow skills guidance and runtime catalog',
      },
    ],
    instructions: {
      installationAuthority: 'runtime',
      updateAssessmentRequired: true,
      policy:
        'Runtime controls installation methods, paths, and host discovery. AgentFlow does not execute host installation.',
    },
  }
}

export function assessRuntimeEvidence(request, evidence) {
  if (!request || typeof request !== 'object') {
    throw new TypeError('request must be an object')
  }
  if (request.schemaVersion !== SCHEMA_VERSION) {
    throw new TypeError(`request.schemaVersion must be ${SCHEMA_VERSION}`)
  }
  if (request.assessUpdates !== true) throw new TypeError('request.assessUpdates must be true')
  if (!isBoundedString(request.runtimeId)) {
    throw new TypeError('request.runtimeId must be a bounded non-empty string')
  }
  if (!isBoundedString(request.requestId)) {
    throw new TypeError('request.requestId must be a bounded non-empty string')
  }
  if (typeof request.sharedUpdate !== 'boolean') {
    throw new TypeError('request.sharedUpdate must be a boolean')
  }
  if (
    !Array.isArray(request.additionalRuntimes) ||
    request.additionalRuntimes.length > MAX_ARRAY_ITEMS
  ) {
    throw new RangeError(`request.additionalRuntimes must be an array <= ${MAX_ARRAY_ITEMS} items`)
  }
  if (!request.additionalRuntimes.every(isBoundedString))
    throw new TypeError('Invalid additional runtime identifiers')
  if (
    !Array.isArray(request.requiredCapabilities) ||
    request.requiredCapabilities.length !== REQUIRED_CAPABILITIES.length
  ) {
    throw new TypeError('request.requiredCapabilities is invalid or altered')
  }
  const reqIds = request.requiredCapabilities.map((c) => c && c.id).sort()
  const expectedIds = [...REQUIRED_CAPABILITIES].sort()
  if (reqIds.some((id, idx) => id !== expectedIds[idx])) {
    throw new TypeError('request.requiredCapabilities cannot be altered')
  }

  const errors = []
  const unknowns = []

  if (!evidence || typeof evidence !== 'object') {
    errors.push('Evidence must be a non-null object')
    return {
      schemaVersion: SCHEMA_VERSION,
      requestId: request.requestId,
      runtimeId: request.runtimeId,
      currentRuntime: request.runtimeId,
      runtimeReady: false,
      action: 'reconcile',
      components: [],
      proposals: [],
      unknowns: [
        { componentId: 'all', field: 'evidence', reason: 'Evidence is missing or not an object' },
      ],
      scope: {
        currentRuntime: request.runtimeId,
        additionalRuntimes: request.additionalRuntimes || [],
        sharedUpdate: Boolean(request.sharedUpdate),
      },
      errors,
    }
  }

  if (evidence.schemaVersion !== SCHEMA_VERSION) {
    errors.push(
      `Evidence schemaVersion must be ${SCHEMA_VERSION}; received ${evidence.schemaVersion}`,
    )
  }
  if (evidence.requestId !== request.requestId) {
    errors.push(
      `Evidence requestId "${evidence.requestId}" does not match request requestId "${request.requestId}"`,
    )
  }
  if (evidence.runtimeId !== request.runtimeId) {
    errors.push(
      `Evidence runtimeId "${evidence.runtimeId}" does not match request runtimeId "${request.runtimeId}"`,
    )
  }

  let normalizedComponents = []
  if (!Array.isArray(evidence.components)) {
    errors.push('Evidence components must be an array')
  } else if (evidence.components.length > MAX_ARRAY_ITEMS) {
    errors.push(`Evidence components length exceeds ${MAX_ARRAY_ITEMS}`)
  } else {
    const seenIds = new Set()
    for (const raw of evidence.components) {
      if (raw && typeof raw.id === 'string') {
        const id = raw.id.trim()
        if (seenIds.has(id)) {
          errors.push(`Duplicate capability id "${id}" is invalid`)
        }
        seenIds.add(id)
      }
    }
    normalizedComponents = evidence.components
      .map((c, idx) => normalizeComponent(c, idx, errors, unknowns))
      .filter(Boolean)
  }

  const evaluation = evaluateRuntimePolicy({
    request,
    normalizedComponents,
    errors,
    unknowns,
  })

  return {
    schemaVersion: SCHEMA_VERSION,
    requestId: request.requestId,
    runtimeId: request.runtimeId,
    currentRuntime: request.runtimeId,
    runtimeReady: evaluation.runtimeReady,
    action: evaluation.action,
    components: evaluation.components,
    proposals: evaluation.proposals,
    unknowns: evaluation.unknowns,
    scope: {
      currentRuntime: request.runtimeId,
      additionalRuntimes: request.additionalRuntimes || [],
      sharedUpdate: Boolean(request.sharedUpdate),
    },
    errors: evaluation.errors,
  }
}
