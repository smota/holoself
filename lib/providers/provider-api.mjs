import { createProviderExecutionReceipt, providerDigest } from './provider-receipt.mjs'

export function createProviderApiProvider({
  id,
  platform,
  executionTarget,
  invoke,
  cleanup: cleanupImpl,
  providerVersion = '1.0.0',
  trustSource = 'explicit project configuration',
  intentSupport = [
    {
      id: 'plan-before-edit',
      implementation: 'emulated',
      fidelity: 'full',
      evidence: 'contract-tested',
      limits: {},
    },
    {
      id: 'workflow-orchestration',
      implementation: 'emulated',
      fidelity: 'full',
      evidence: 'contract-tested',
      limits: {},
    },
    {
      id: 'bounded-loop',
      implementation: 'emulated',
      fidelity: 'full',
      evidence: 'contract-tested',
      limits: { maxIterationsRequired: true },
    },
    {
      id: 'structured-result',
      implementation: 'adapter',
      fidelity: 'partial',
      evidence: 'self-declared',
      limits: {},
    },
  ],
} = {}) {
  if (!platform) throw new Error('provider API platform identity is required')
  let lastReceipt = null
  let executionStatus = 'idle'
  let activeExecution = null
  const failureCleanup = async (reason) => {
    if (!cleanupImpl) {
      return { status: 'partial', actions: ['provider-api-cleanup-not-configured'] }
    }
    try {
      await cleanupImpl({ reason })
      return { status: 'clean', actions: ['provider-api-cleanup'] }
    } catch {
      return { status: 'failed', actions: ['provider-api-cleanup-failed'] }
    }
  }
  const plan = (request = {}) => {
    const timeoutMs = request.timeoutMs ?? 120_000
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0) {
      throw new Error('provider API timeoutMs must be a non-negative integer')
    }
    const base = { version: 1, provider: id, request, timeoutMs }
    return { ...base, token: providerDigest(base) }
  }
  const execute = async (executionPlan, { confirm } = {}) => {
    if (!invoke) throw new Error(`${id} is unsupported until an API invoker is configured`)
    const { token, ...base } = executionPlan ?? {}
    if (executionPlan?.provider !== id || confirm !== token || providerDigest(base) !== token) {
      throw new Error('provider API confirmation or plan digest is invalid')
    }
    const startedAt = new Date().toISOString()
    const controller = new AbortController()
    let rejectControl
    let timedOut = false
    let cancellationRequested = false
    let invocationSettled = false
    let invocationOutcome = null
    const executionId = Symbol('provider-api-execution')
    const control = new Promise((_, reject) => {
      rejectControl = reject
    })
    const invocation = Promise.resolve()
      .then(() => invoke(executionPlan.request, { signal: controller.signal }))
      .then(
        (output) => {
          invocationSettled = true
          invocationOutcome = 'resolved'
          return output
        },
        (error) => {
          invocationSettled = true
          invocationOutcome = 'rejected'
          throw error
        },
      )
    invocation
      .finally(() => {
        if (activeExecution?.id === executionId) {
          activeExecution = null
          if (executionStatus === 'timeout-pending') executionStatus = 'late-settled'
        }
      })
      .catch(() => {})
    activeExecution = {
      id: executionId,
      requestCancellation() {
        cancellationRequested = true
        executionStatus = 'cancellation-requested'
        controller.abort(
          new DOMException('provider API execution cancellation requested', 'AbortError'),
        )
      },
    }
    executionStatus = 'running'
    const timeout = setTimeout(() => {
      timedOut = true
      const error = new Error(`provider API execution timed out after ${executionPlan.timeoutMs}ms`)
      error.name = 'TimeoutError'
      controller.abort(error)
      rejectControl(error)
    }, executionPlan.timeoutMs)
    try {
      const output = await Promise.race([invocation, control])
      if (cancellationRequested) {
        const error = new Error('provider API invoker completed after cancellation was requested')
        error.name = 'AbortError'
        throw error
      }
      executionStatus = 'completed'
      lastReceipt = createProviderExecutionReceipt({
        provider: id,
        platform,
        intentSupport,
        executionTarget,
        transport: 'provider-api',
        plan: executionPlan,
        request: executionPlan.request,
        status: 'pass',
        startedAt,
        completedAt: new Date().toISOString(),
        output,
        metadata: { cleanup: { status: 'not-required', actions: [] } },
      })
      return lastReceipt
    } catch (error) {
      const cancellationObserved = cancellationRequested && invocationOutcome === 'rejected'
      const executionMayContinue = timedOut && !invocationSettled
      executionStatus = cancellationObserved
        ? 'cancelled'
        : executionMayContinue
          ? 'timeout-pending'
          : 'failed'
      const cleanup = await failureCleanup(
        timedOut ? 'timeout' : cancellationRequested ? 'cancellation' : 'failure',
      )
      lastReceipt = createProviderExecutionReceipt({
        provider: id,
        platform,
        intentSupport,
        executionTarget,
        transport: 'provider-api',
        plan: executionPlan,
        request: executionPlan.request,
        status: cancellationObserved ? 'cancelled' : 'failed',
        startedAt,
        completedAt: new Date().toISOString(),
        output: { errorName: error?.name ?? 'Error', timedOut, cancellationObserved },
        metadata: {
          failure: {
            errorName: error?.name ?? 'Error',
            timedOut,
            cancellationRequested,
            cancellationObserved,
            executionMayContinue,
          },
          cleanup,
        },
      })
      const failure = error instanceof Error ? error : new Error(String(error))
      failure.receipt = lastReceipt
      throw failure
    } finally {
      clearTimeout(timeout)
      if (invocationSettled && activeExecution?.id === executionId) activeExecution = null
    }
  }
  return {
    version: 1,
    id,
    platform,
    providerVersion,
    spiRange: { min: 1, max: 1 },
    facets: ['execution', 'evidence'],
    intentSupport,
    targets: [executionTarget],
    transports: ['provider-api'],
    osSupport: ['any'],
    trust: { source: trustSource },
    compatibility: { agentflow: '^1' },
    operations: { execute, evidence: () => lastReceipt },
    plan,
    execute,
    status: () => ({ status: executionStatus }),
    cancel: () => {
      if (!activeExecution) return { status: 'not-running' }
      activeExecution.requestCancellation()
      return { status: 'cancellation-requested' }
    },
    cleanup: async (...args) => {
      if (!cleanupImpl)
        return { status: 'unsupported', reason: 'provider API cleanup is not configured' }
      try {
        const result = await cleanupImpl(...args)
        if (lastReceipt)
          lastReceipt.cleanup = { status: 'clean', actions: ['provider-api-cleanup'] }
        return result
      } catch (error) {
        if (lastReceipt)
          lastReceipt.cleanup = { status: 'failed', actions: ['provider-api-cleanup-failed'] }
        throw error
      }
    },
    receipt: () => lastReceipt,
    async inspect() {
      return invoke
        ? {
            availability: 'configured',
            platform,
            executionTarget,
            transport: 'provider-api',
            delegationBoundary: 'separate-local-session',
            reason: `${id} API invoker is explicitly configured`,
            intentSupport,
          }
        : {
            availability: 'unavailable',
            reason: `${id} API invoker is not configured`,
            intentSupport,
          }
    },
  }
}
