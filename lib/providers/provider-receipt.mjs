import { createHash } from 'node:crypto'
import { createExecutionReceipt } from '../core/execution-receipt.mjs'

export function providerDigest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function createProviderExecutionReceipt({
  provider,
  platform,
  intentSupport,
  executionTarget,
  transport,
  plan,
  request = {},
  status,
  startedAt,
  completedAt,
  output,
  observedModel = null,
  metadata = {},
}) {
  if (!platform) throw new Error('provider receipt platform identity is required')
  const requestedBoundary = request.boundaries?.requested ?? request.boundary ?? 'observe'
  const declaredBoundary = request.boundaries?.declared ?? requestedBoundary
  return createExecutionReceipt({
    subject: request.subject ?? `provider:${provider}`,
    intent: request.intent ?? { mode: 'single-agent' },
    binding: {
      provider,
      executionTarget,
      transport,
      delegationBoundary:
        request.executionPlan?.delegationBoundary ??
        request.delegationBoundary ??
        'current-session',
      degraded: request.executionPlan?.degraded ?? false,
    },
    status,
    startedAt,
    completedAt,
    requestDigest: providerDigest(request),
    planDigest: plan.token ?? providerDigest(plan),
    actual: {
      platform,
      target: executionTarget,
      transport,
      model: observedModel,
    },
    boundaries: {
      requested: requestedBoundary,
      effective: request.boundaries?.effective ?? null,
      enforced: request.boundaries?.enforced ?? null,
      observed: request.boundaries?.observed ?? null,
      declared: declaredBoundary,
    },
    revision: {
      source: request.revision ?? null,
      workspaceFingerprint: request.workspaceFingerprint ?? null,
    },
    writerLease: request.writerLease ?? { id: 'none', owner: provider, status: 'released' },
    timing: { timeoutMs: plan.timeoutMs ?? 0, cancelled: status === 'cancelled' },
    digests: {
      artifacts: providerDigest(request.artifacts ?? []),
      changes: providerDigest(request.changes ?? []),
      output: providerDigest(output ?? null),
    },
    executionIntentSource: {
      provider,
      declared: intentSupport.map((item) => item.id),
      resolutions: request.executionPlan?.intentResolutions ?? [],
    },
    cleanup: metadata.cleanup ?? { status: 'clean', actions: [] },
    disclosure: request.disclosure ?? { authorized: false, scope: 'local-only' },
    redaction: { applied: true, policy: 'digest-only-provider-output' },
    metadata,
  })
}
