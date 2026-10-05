import { createHash } from 'node:crypto'

export const SOURCE_ADAPTER_VERSION = 1
export const SOURCE_CAPABILITIES = [
  'read-artifacts',
  'read-lifecycle',
  'mutate-comments',
  'mutate-artifacts',
  'mutate-lifecycle',
]

export function validateSourceAdapter(adapter) {
  const errors = []
  if (adapter?.version !== SOURCE_ADAPTER_VERSION) errors.push('source adapter version must be 1')
  if (!adapter?.id) errors.push('source adapter id is required')
  if (!Array.isArray(adapter?.capabilities))
    errors.push('source adapter capabilities must be an array')
  for (const capability of adapter?.capabilities ?? []) {
    if (!SOURCE_CAPABILITIES.includes(capability))
      errors.push(`unsupported source capability: ${capability}`)
  }
  if (typeof adapter?.readArtifact !== 'function') errors.push('readArtifact() is required')
  if (adapter?.capabilities?.some((item) => item.startsWith('mutate-'))) {
    for (const method of ['previewMutation', 'applyMutation', 'flushReceipt']) {
      if (typeof adapter?.[method] !== 'function')
        errors.push(`${method}() is required for mutation`)
    }
  }
  return { ok: errors.length === 0, errors }
}

export function requireSourceMutation(adapter, capability, boundary) {
  if (!adapter.capabilities.includes(capability)) {
    throw new Error(`source adapter ${adapter.id} does not provide ${capability}`)
  }
  if (!['open-pr', 'external-action'].includes(boundary?.effective)) {
    throw new Error(`${capability} requires an open-pr or external-action boundary`)
  }
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function createSourceMutationPlan({
  adapter,
  scope,
  capability,
  operation,
  parameters,
  actionBoundary,
  expectedRevision,
  idempotencyKey,
}) {
  requireSourceMutation(adapter, capability, actionBoundary)
  if (!operation || !idempotencyKey) throw new Error('operation and idempotencyKey are required')
  if (!expectedRevision) throw new Error('source mutation preview requires an expected revision')
  const base = {
    version: 1,
    adapter: adapter.id,
    scope,
    capability,
    operation,
    parameters,
    actionBoundary,
    expectedRevision,
    idempotencyKey,
  }
  return { ...base, token: digest(base) }
}

export function validateSourceMutationPlan(plan, adapter, confirm) {
  if (plan?.version !== 1 || plan?.adapter !== adapter.id) {
    throw new Error('source mutation plan does not match the adapter')
  }
  const { token, ...base } = plan
  if (confirm !== token || digest(base) !== token) {
    throw new Error('source mutation confirmation or plan digest is invalid')
  }
  requireSourceMutation(adapter, plan.capability, plan.actionBoundary)
}

export function createSourceMutationReceipt(plan, result, observedRevision) {
  const base = {
    version: 1,
    adapter: plan.adapter,
    scope: plan.scope,
    operation: plan.operation,
    planToken: plan.token,
    idempotencyKey: plan.idempotencyKey,
    expectedRevision: plan.expectedRevision,
    observedRevision,
    result,
    status: 'applied',
  }
  return { ...base, receiptToken: digest(base) }
}

export function sourceMutationIdempotencyKey(operation, parameters) {
  return digest({ operation, parameters })
}
