export const EXECUTION_INTENT_VERSION = 1

export const EXECUTION_INTENTS = [
  'plan-before-edit',
  'delegated-work',
  'parallel-fanout',
  'isolated-workspace',
  'background-execution',
  'structured-result',
  'bounded-loop',
  'workflow-orchestration',
]

export const TOOL_PERMISSIONS = ['read', 'shell', 'edit', 'network', 'external-write', 'deploy']

export const CONTROL_REQUIREMENTS = [
  'sandbox',
  'branch-protection',
  'human-approval',
  'credential-isolation',
  'network-policy',
  'single-writer',
  'review-independence',
  'authority-may-only-narrow',
]

export const INTENT_IMPLEMENTATIONS = ['native', 'plugin', 'adapter', 'emulated', 'manual']
export const INTENT_FIDELITIES = ['full', 'partial', 'degraded']
export const INTENT_EVIDENCE_LEVELS = ['probed', 'contract-tested', 'self-declared']
export const INTENT_STATUSES = ['satisfied', 'degraded', 'skipped', 'blocked']

function list(value) {
  return Array.isArray(value) ? value : value ? [value] : []
}

export function normalizeIntentRequirement(value) {
  const requirement = typeof value === 'string' ? { id: value } : { ...value }
  return {
    id: requirement.id,
    required: requirement.required !== false,
    fallback: requirement.fallback ?? null,
    parameters: requirement.parameters ?? {},
  }
}

export function createExecutionIntent({
  subject = null,
  requirements = [],
  controls = ['single-writer', 'authority-may-only-narrow'],
  requiredFacets = ['execution', 'evidence'],
  limits = {},
} = {}) {
  return {
    version: EXECUTION_INTENT_VERSION,
    subject,
    requirements: requirements.map(normalizeIntentRequirement),
    controls: [...new Set(controls)],
    requiredFacets: [...new Set(requiredFacets)],
    limits: { ...limits },
  }
}

export function validateExecutionIntent(intent) {
  const errors = []
  if (intent?.version !== EXECUTION_INTENT_VERSION) errors.push('version must be 1')
  if (!Array.isArray(intent?.requirements)) errors.push('requirements must be an array')
  const seen = new Set()
  for (const [index, requirement] of (intent?.requirements ?? []).entries()) {
    const prefix = `requirements[${index}]`
    if (!EXECUTION_INTENTS.includes(requirement?.id)) {
      errors.push(`${prefix}.id is unsupported: ${requirement?.id ?? ''}`)
    }
    if (seen.has(requirement?.id)) errors.push(`${prefix}.id must be unique`)
    seen.add(requirement?.id)
    if (typeof requirement?.required !== 'boolean')
      errors.push(`${prefix}.required must be boolean`)
    if (!requirement?.parameters || typeof requirement.parameters !== 'object') {
      errors.push(`${prefix}.parameters must be an object`)
    }
  }
  if (!Array.isArray(intent?.controls)) errors.push('controls must be an array')
  for (const control of intent?.controls ?? []) {
    if (!CONTROL_REQUIREMENTS.includes(control)) errors.push(`unsupported control: ${control}`)
  }
  if (!Array.isArray(intent?.requiredFacets)) errors.push('requiredFacets must be an array')
  return { ok: errors.length === 0, errors }
}

export function validateRequirementNamespaces(requirements = {}) {
  const errors = []
  const fields = [
    ['requiredExecutionIntents', EXECUTION_INTENTS],
    ['requiredToolPermissions', TOOL_PERMISSIONS],
    ['controlRequirements', CONTROL_REQUIREMENTS],
  ]
  for (const [field, allowed] of fields) {
    const values = list(requirements[field])
    if (!Array.isArray(values)) {
      errors.push(`${field} must be an array`)
      continue
    }
    for (const value of values) {
      if (!allowed.includes(value)) errors.push(`${field} contains unsupported value: ${value}`)
    }
  }
  return { ok: errors.length === 0, errors, warnings: [] }
}

export function validateExecutionIntentEvidence(evidence = {}) {
  const errors = []
  const used = Array.isArray(evidence.executionIntentsUsed) ? evidence.executionIntentsUsed : []
  if (!Array.isArray(evidence.executionIntentsUsed)) {
    errors.push('executionIntentsUsed must be an array')
  }
  for (const [index, item] of used.entries()) {
    const prefix = `executionIntentsUsed[${index}]`
    if (!EXECUTION_INTENTS.includes(item?.id)) errors.push(`${prefix}.id is unsupported`)
    if (!INTENT_STATUSES.includes(item?.status)) errors.push(`${prefix}.status is invalid`)
    if (item?.implementation && !INTENT_IMPLEMENTATIONS.includes(item.implementation)) {
      errors.push(`${prefix}.implementation is invalid`)
    }
    if (item?.fidelity && !INTENT_FIDELITIES.includes(item.fidelity)) {
      errors.push(`${prefix}.fidelity is invalid`)
    }
    if (item?.evidence && !INTENT_EVIDENCE_LEVELS.includes(item.evidence)) {
      errors.push(`${prefix}.evidence is invalid`)
    }
    if (item?.id === 'bounded-loop') {
      if (!Number.isInteger(item?.parameters?.maxIterations) || item.parameters.maxIterations < 1) {
        errors.push(`${prefix} bounded-loop must record maxIterations >= 1`)
      }
      if (
        !Array.isArray(item?.parameters?.stopConditions) ||
        !item.parameters.stopConditions.length
      ) {
        errors.push(`${prefix} bounded-loop must record stopConditions`)
      }
    }
    if (item?.id === 'plan-before-edit' && item?.required && !item?.artifact) {
      errors.push(`${prefix} required plan-before-edit must record an artifact`)
    }
  }
  return { ok: errors.length === 0, errors }
}
