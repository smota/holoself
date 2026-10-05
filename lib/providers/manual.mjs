import { createProviderExecutionReceipt, providerDigest } from './provider-receipt.mjs'
import { EXECUTION_INTENTS } from '../core/execution-intent.mjs'

const intentSupport = EXECUTION_INTENTS.map((id) => ({
  id,
  implementation: 'manual',
  fidelity: 'degraded',
  evidence: 'self-declared',
  limits: {},
}))

export function createManualProvider() {
  let lastReceipt = null
  const plan = (request = {}) => {
    const base = { version: 1, provider: 'manual', request, timeoutMs: 0 }
    return { ...base, token: providerDigest(base) }
  }
  const execute = async (executionPlan, { confirm } = {}) => {
    const { token, ...base } = executionPlan ?? {}
    if (confirm !== token || providerDigest(base) !== token) {
      throw new Error('manual provider confirmation or plan digest is invalid')
    }
    const now = new Date().toISOString()
    lastReceipt = createProviderExecutionReceipt({
      provider: 'manual',
      platform: 'human',
      intentSupport,
      executionTarget: 'human',
      transport: 'manual',
      plan: executionPlan,
      request: executionPlan.request,
      status: 'blocked',
      startedAt: now,
      completedAt: now,
      output: { reason: 'explicit human handoff required' },
      metadata: { cleanup: { status: 'not-required', actions: [] } },
    })
    return lastReceipt
  }
  return {
    version: 1,
    id: 'manual',
    platform: 'human',
    providerVersion: '1.0.0',
    spiRange: { min: 1, max: 1 },
    facets: ['execution', 'evidence'],
    intentSupport,
    targets: ['human'],
    transports: ['manual'],
    osSupport: ['any'],
    trust: { source: 'explicit human authority' },
    compatibility: { agentflow: '^1' },
    operations: { execute, evidence: () => lastReceipt },
    plan,
    execute,
    status: () => ({ status: 'manual' }),
    cancel: () => ({ status: 'unsupported' }),
    cleanup: () => ({ status: 'clean', resources: [] }),
    receipt: () => lastReceipt,
    async inspect() {
      return {
        availability: 'manual',
        platform: 'human',
        executionTarget: 'human',
        transport: 'manual',
        delegationBoundary: 'human-handoff',
        reason: 'manual execution is always available as an explicit human handoff',
        intentSupport,
      }
    },
  }
}
