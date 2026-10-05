import {
  dispatchToHarness,
  MAX_ENGINEERING_RECEIPT_OUTPUT_BYTES,
  parseAndVerifyHarnessOutput,
  preflightHarnessCapability,
  validateDispatchContext,
} from './harness-dispatch.mjs'
import { validateExecutionReceipt } from '../core/execution-receipt.mjs'
import { hasCurrentDigest } from '../core/record-digest.mjs'
import { reduceRun } from '../core/run-state.mjs'
import { providerDigest } from './provider-receipt.mjs'

const sha256 = /^[a-f0-9]{64}$/

export function createSourceEngineeringReceiptResolver({ store } = {}) {
  if (!store || typeof store.read !== 'function' || store.durable !== true)
    throw new Error('Durable source store is required for engineering receipt resolution')
  return async (record, admission) => {
    const operation = admission?.operation
    if (
      !operation?.id ||
      record?.id !== operation.id ||
      record?.payloadDigest !== admission.operationDigest
    )
      return { verified: false, reason: 'Operation and admission mismatch' }
    let events
    try {
      const source = await store.read()
      events = source.events
      reduceRun(events)
    } catch {
      return { verified: false, reason: 'Source event chain unavailable or invalid' }
    }
    const matches = events.filter(
      (event) =>
        event.kind === 'checkpoint' &&
        event.payload?.kind === 'engineering-result' &&
        event.payload.operationId === operation.id,
    )
    if (matches.length !== 1)
      return { verified: false, reason: 'Expected one durable engineering receipt checkpoint' }
    const event = matches[0]
    if (!hasCurrentDigest(event)) return { verified: false, reason: 'Checkpoint digest invalid' }
    const { receipt, output } = event.payload
    const outputText = typeof output === 'string' ? output : JSON.stringify(output ?? null)
    if (Buffer.byteLength(outputText) > MAX_ENGINEERING_RECEIPT_OUTPUT_BYTES)
      return { verified: false, reason: 'Checkpoint output exceeds control budget' }
    if (
      !validateExecutionReceipt(receipt).ok ||
      providerDigest(output) !== receipt.digests.output ||
      receipt.metadata?.engineeringProfile?.operationId !== operation.id ||
      receipt.metadata.engineeringProfile.candidateDigest !== operation.candidateDigest ||
      receipt.metadata?.outcomeUnknown === true
    )
      return { verified: false, reason: 'Provider receipt invalid or stale' }
    if (receipt.status === 'pass') {
      try {
        const parsed = parseAndVerifyHarnessOutput(output?.stdout ?? output, {
          operationId: operation.id,
          candidateDigest: operation.candidateDigest,
          expectedArtifacts: operation.arguments?.expectedArtifacts ?? [],
        })
        if (parsed.status !== 'pass')
          return { verified: false, reason: 'Output is not terminal pass' }
      } catch {
        return { verified: false, reason: 'Output integrity or identity invalid' }
      }
    }
    return { verified: true, sourceRevision: event.digest, receipt, output }
  }
}

// The host owns durable admission and receipt lookup. This adapter owns only the
// technical process boundary and never turns a local dispatch return into authority.
export function createGovernedEngineeringAdapter({
  provider,
  executionTarget,
  requestedModel = null,
  requiredCapabilities = [],
  sourceEvidenceDisclosure = null,
  permissionBoundary = 'mutate-worktree',
  resolveReceipt,
} = {}) {
  if (!provider || !executionTarget) throw new Error('Engineering provider and target are required')
  if (typeof resolveReceipt !== 'function')
    throw new Error('Independent receipt resolver is required')

  const dispatchWith = async (operation, executionProvider = provider) => {
    if (
      operation?.action !== 'edit' ||
      !operation?.id ||
      !sha256.test(operation?.candidateDigest ?? '')
    )
      throw new Error('Edit operation with stable id and candidate digest is required')
    const args = operation.arguments ?? {}
    return dispatchToHarness({
      provider: executionProvider,
      executionTarget,
      requestedModel,
      requiredCapabilities: [...new Set(['file-edit', ...requiredCapabilities])],
      permissionBoundary,
      operationId: operation.id,
      candidateDigest: operation.candidateDigest,
      requestPayload: {
        ...(args.requestPayload ?? {}),
        allowedPaths: operation.paths ?? [],
        disclosure:
          sourceEvidenceDisclosure === 'bounded-output-and-artifacts'
            ? { authorized: true, scope: 'configured-source:bounded-output-and-artifacts' }
            : { authorized: false, scope: 'local-only' },
      },
      context: args.context ?? null,
      timeoutMs: args.timeoutMs ?? 60_000,
      expectedArtifacts: args.expectedArtifacts ?? [],
    })
  }

  const reconcile = async (record, admission) => {
    const operation = admission?.operation
    if (
      record?.id !== operation?.id ||
      record?.payloadDigest !== admission?.operationDigest ||
      !operation?.id ||
      !sha256.test(operation.candidateDigest ?? '') ||
      !sha256.test(admission?.operationDigest ?? '')
    )
      return { verified: false, reason: 'Operation or admission identity missing' }
    const resolved = await resolveReceipt(record, admission)
    if (!resolved?.verified || !sha256.test(resolved.sourceRevision ?? ''))
      return { verified: false, reason: 'No durable independently verified provider outcome' }
    const receipt = resolved.receipt
    if (
      receipt?.metadata?.engineeringProfile?.operationId !== operation.id ||
      receipt.metadata.engineeringProfile.candidateDigest !== operation.candidateDigest ||
      receipt.provider !== provider.id ||
      receipt.executionTarget !== executionTarget
    )
      return { verified: false, reason: 'Provider receipt identity mismatch' }
    if (receipt.metadata?.outcomeUnknown === true)
      return { verified: false, reason: 'Provider outcome remains unknown' }
    if (!['pass', 'failed', 'blocked', 'cancelled'].includes(receipt.status))
      return { verified: false, reason: 'Provider outcome is not terminal' }
    if (receipt.status === 'pass') {
      if (resolved.output === undefined)
        return { verified: false, reason: 'Terminal output unavailable' }
      let parsed
      try {
        parsed = parseAndVerifyHarnessOutput(resolved.output?.stdout ?? resolved.output, {
          operationId: operation.id,
          candidateDigest: operation.candidateDigest,
          expectedArtifacts: operation.arguments?.expectedArtifacts ?? [],
        })
      } catch {
        return {
          verified: false,
          reason: 'Terminal output failed integrity or identity verification',
        }
      }
      if (parsed.status !== 'pass')
        return { verified: false, reason: 'Terminal output did not pass' }
    }
    return {
      verified: true,
      state: receipt.status === 'pass' ? 'confirmed' : 'failed',
      operationId: operation.id,
      payloadDigest: admission.operationDigest,
      candidateDigest: operation.candidateDigest,
      sourceRevision: resolved.sourceRevision,
    }
  }

  return {
    dispatch: (operation) => dispatchWith(operation),
    observe: (operation) => {
      if (typeof provider.observe !== 'function')
        throw new Error('Provider observation unsupported')
      return dispatchWith(operation, {
        ...provider,
        execute: (plan, { confirm }) => provider.observe(plan, confirm),
      })
    },
    reconcile,
    async preflight(operation) {
      if (operation?.action !== 'edit') throw new Error('Engineering adapter accepts edit only')
      validateDispatchContext(operation.arguments?.context)
      return preflightHarnessCapability({
        provider,
        executionTarget,
        requestedModel,
        requiredCapabilities: [...new Set(['structured-result', ...requiredCapabilities])],
      })
    },
  }
}
