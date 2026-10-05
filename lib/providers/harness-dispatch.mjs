import { createHash } from 'node:crypto'
import { safePath } from '../core/delegation-grant.mjs'

export const ENGINEERING_PROFILE_VERSION = 1
export const MAX_CONTROL_CONTEXT_BYTES = 32 * 1024
export const MAX_ENGINEERING_RECEIPT_OUTPUT_BYTES = 32 * 1024
export const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024
const TERMINAL = new Set(['pass', 'failed', 'blocked', 'cancelled'])

export class HarnessContractError extends Error {
  constructor(message, { code = 'HARNESS_CONTRACT_ERROR', details = null } = {}) {
    super(message)
    this.name = 'HarnessContractError'
    this.code = code
    this.details = details
  }
}

function fail(message, code, details) {
  throw new HarnessContractError(message, { code, details })
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function qualifiedIntent(inspection, provider, id) {
  const candidates = inspection.intentSupport ?? provider.intentSupport ?? []
  const found = candidates.find((entry) => entry.id === id)
  if (
    !found ||
    !inspection.qualification?.capabilities?.includes(id) ||
    !['probed', 'contract-tested'].includes(found.evidence) ||
    !['full'].includes(found.fidelity) ||
    !['native', 'adapter', 'plugin', 'emulated'].includes(found.implementation)
  ) {
    fail(`Provider lacks qualified capability: ${id}`, 'MISSING_CAPABILITY', { capability: id })
  }
}

export async function preflightHarnessCapability({
  provider,
  requiredCapabilities = [],
  executionTarget,
  requestedModel = null,
  profileVersion = ENGINEERING_PROFILE_VERSION,
}) {
  if (!provider || typeof provider.plan !== 'function' || typeof provider.execute !== 'function')
    fail('Provider with plan and execute is required', 'INVALID_PROVIDER')
  if (profileVersion !== ENGINEERING_PROFILE_VERSION)
    fail('Unsupported engineering profile version', 'INCOMPATIBLE_PROFILE_VERSION')
  const inspection = typeof provider.inspect === 'function' ? await provider.inspect() : null
  if (!inspection || inspection.availability !== 'available')
    fail(
      `Provider unavailable: ${inspection?.reason ?? 'inspection absent'}`,
      'PROVIDER_UNAVAILABLE',
      inspection,
    )
  const targets =
    provider.targets ?? (inspection.executionTarget ? [inspection.executionTarget] : [])
  if (!executionTarget || !targets.includes(executionTarget))
    fail(`Provider does not support executionTarget: ${executionTarget}`, 'UNSUPPORTED_TARGET', {
      targets,
    })
  for (const cap of requiredCapabilities) qualifiedIntent(inspection, provider, cap)
  if (requestedModel !== null) {
    const models = inspection.qualification?.models ?? []
    if (!models.includes(requestedModel) || typeof provider.selectModel !== 'function')
      fail(`Provider cannot enforce model: ${requestedModel}`, 'UNSUPPORTED_MODEL')
  }
  return { ok: true, executionTarget, requestedModel, inspection }
}

export function validateDispatchContext(context) {
  if (context === undefined || context === null) return
  const serialized = typeof context === 'string' ? context : JSON.stringify(context)
  if (typeof serialized !== 'string') fail('Invalid control context', 'INVALID_CONTEXT')
  const byteLength = Buffer.byteLength(serialized)
  if (byteLength > MAX_CONTROL_CONTEXT_BYTES)
    fail(
      `Control context exceeds bounded limit of ${MAX_CONTROL_CONTEXT_BYTES} bytes (actual: ${byteLength} bytes)`,
      'CONTEXT_BUDGET_EXCEEDED',
      { actual: byteLength, max: MAX_CONTROL_CONTEXT_BYTES },
    )
}

function artifactBytes(artifact) {
  if (typeof artifact.content === 'string') return Buffer.from(artifact.content, 'utf8')
  if (
    typeof artifact.contentBase64 === 'string' &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(artifact.contentBase64)
  ) {
    const bytes = Buffer.from(artifact.contentBase64, 'base64')
    if (bytes.toString('base64') === artifact.contentBase64) return bytes
  }
  fail(`Artifact ${artifact.path} missing exact bytes`, 'MALFORMED_ARTIFACT')
}

export function parseAndVerifyHarnessOutput(
  rawOutput,
  { expectedArtifacts = [], operationId = null, candidateDigest = null } = {},
) {
  if (rawOutput === null || rawOutput === undefined || rawOutput === '')
    fail('Harness returned null or empty output', 'EMPTY_OUTPUT')
  let parsed = rawOutput
  if (typeof rawOutput === 'string') {
    if (rawOutput.includes('[truncated]')) fail('Harness output was truncated', 'OUTPUT_TRUNCATED')
    try {
      parsed = JSON.parse(rawOutput)
    } catch (error) {
      fail(`Malformed harness output JSON: ${error.message}`, 'MALFORMED_OUTPUT')
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    fail('Harness output must be an object', 'MALFORMED_OUTPUT')
  if (parsed.truncated === true) fail('Harness output was truncated', 'OUTPUT_TRUNCATED')
  if (parsed.ok === false || parsed.error || parsed.status === 'failed')
    return {
      status: 'failed',
      error: parsed.error ?? 'Execution failed',
      artifacts: [],
      raw: parsed,
    }
  if (!['pass', 'success', 'completed'].includes(parsed.status)) {
    if (['running', 'pending', 'idle', 'unknown'].includes(parsed.status))
      return {
        status: 'unknown',
        error: `Nonterminal harness status: ${parsed.status}`,
        artifacts: [],
        raw: parsed,
      }
    fail(`Missing or invalid terminal success status: ${parsed.status}`, 'INVALID_TERMINAL_STATUS')
  }
  if (parsed.ok !== undefined && parsed.ok !== true)
    fail('Harness did not affirm success', 'INVALID_TERMINAL_STATUS')
  if (operationId && parsed.operationId !== operationId)
    fail('Harness operation identity mismatch', 'OPERATION_MISMATCH')
  if (candidateDigest && parsed.candidateDigest !== candidateDigest)
    fail('Harness candidate identity mismatch', 'CANDIDATE_MISMATCH')
  if (!Array.isArray(parsed.artifacts))
    fail('Harness success requires artifacts array', 'MALFORMED_ARTIFACTS')
  const seen = new Set()
  const artifacts = parsed.artifacts.map((art) => {
    if (!art || !safePath(art.path) || seen.has(art.path))
      fail(`Invalid or unsafe artifact path: ${art?.path}`, 'INVALID_ARTIFACT_PATH')
    seen.add(art.path)
    const bytes = artifactBytes(art)
    if (bytes.length > MAX_ARTIFACT_BYTES)
      fail(`Artifact ${art.path} exceeds max size limit`, 'OVERSIZED_ARTIFACT')
    const digest = sha256(bytes)
    if (art.byteLength !== undefined && art.byteLength !== bytes.length)
      fail(`Artifact ${art.path} byte length mismatch`, 'ARTIFACT_LENGTH_MISMATCH')
    const claimed = art.sha256 ?? art.digest
    if (claimed !== undefined && claimed !== digest && claimed !== `sha256:${digest}`)
      fail(`Artifact ${art.path} digest mismatch`, 'ARTIFACT_DIGEST_MISMATCH')
    return {
      path: art.path,
      content: art.content,
      digest,
      sha256: digest,
      byteLength: bytes.length,
      type: art.type ?? 'file',
      verified: true,
    }
  })
  for (const expected of expectedArtifacts)
    if (!seen.has(expected))
      fail(
        `Required expected artifact missing from harness return: ${expected}`,
        'MISSING_EXPECTED_ARTIFACT',
      )
  return { status: 'pass', artifacts, metadata: parsed.metadata ?? {}, raw: parsed }
}

export async function dispatchToHarness({
  provider,
  executionTarget,
  requestedModel = null,
  requiredCapabilities = [],
  context = null,
  timeoutMs = 60_000,
  permissionBoundary = 'observe',
  requestPayload = {},
  expectedArtifacts = [],
  operationId = null,
  candidateDigest = null,
  profileVersion = ENGINEERING_PROFILE_VERSION,
}) {
  const { inspection } = await preflightHarnessCapability({
    provider,
    requiredCapabilities,
    executionTarget,
    requestedModel,
    profileVersion,
  })
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    fail('Positive finite deadline required', 'INVALID_DEADLINE')
  if (
    !['observe', 'propose', 'mutate-worktree', 'write', 'open-pr', 'external-action'].includes(
      permissionBoundary,
    )
  )
    fail('Unknown permission boundary', 'INVALID_BOUNDARY')
  if (
    requiredCapabilities.some((cap) => ['file-edit', 'commit', 'workspace-edit'].includes(cap)) &&
    ['observe', 'propose'].includes(permissionBoundary)
  )
    fail('Edit capability requested but permission boundary is observe-only', 'BOUNDARY_DENIED')
  validateDispatchContext(context)
  if ((operationId === null) !== (candidateDigest === null))
    fail('Operation and candidate must be bound together', 'INCOMPLETE_IDENTITY')
  if (
    operationId !== null &&
    (typeof operationId !== 'string' || !operationId || !/^[a-f0-9]{64}$/.test(candidateDigest))
  )
    fail('Invalid operation or candidate identity', 'INVALID_IDENTITY')
  const request = {
    ...requestPayload,
    model: requestedModel,
    timeoutMs,
    boundary: permissionBoundary,
    context,
    engineeringProfile: { version: profileVersion, operationId, candidateDigest },
  }
  const plan = await provider.plan(request)
  if (!plan || typeof plan !== 'object' || !plan.token)
    fail('Provider returned invalid plan', 'INVALID_PLAN')
  if (requestedModel !== null) {
    const selected = provider.selectModel(plan, requestedModel)
    if (selected !== requestedModel || plan.request?.model !== requestedModel)
      fail('Requested model was not bound to actual invocation', 'MODEL_NOT_BOUND')
  }
  let receipt
  try {
    receipt = await provider.execute(plan, { confirm: plan.token })
  } catch (error) {
    return {
      status: 'unknown',
      receipt: null,
      artifacts: [],
      operationId,
      candidateDigest,
      reason: `Harness execution outcome uncertain: ${error.message}`,
    }
  }
  if (receipt?.metadata?.outcomeUnknown === true)
    return {
      status: 'unknown',
      receipt,
      artifacts: [],
      operationId,
      candidateDigest,
      reason: 'Provider deadline or termination outcome unconfirmed',
    }
  if (!receipt || !TERMINAL.has(receipt.status))
    return {
      status: 'unknown',
      receipt,
      artifacts: [],
      operationId,
      candidateDigest,
      reason: 'Provider outcome is not terminal',
    }
  if (receipt.status !== 'pass')
    return {
      status: receipt.status,
      receipt,
      artifacts: [],
      operationId,
      candidateDigest,
      reason:
        receipt.metadata?.failureReason ??
        receipt.output?.stderr ??
        'Provider execution did not pass',
    }
  if (receipt.binding?.provider && receipt.binding.provider !== provider.id)
    fail('Provider receipt identity mismatch', 'PROVIDER_MISMATCH')
  if (receipt.binding?.executionTarget && receipt.binding.executionTarget !== executionTarget)
    fail('Provider target mismatch', 'TARGET_MISMATCH')
  if (
    operationId &&
    (receipt.metadata?.engineeringProfile?.operationId !== operationId ||
      receipt.metadata?.engineeringProfile?.candidateDigest !== candidateDigest)
  )
    fail(
      'Provider receipt is not bound to admitted operation and candidate',
      'RECEIPT_BINDING_MISMATCH',
    )
  const returnedOutput =
    typeof provider.readOutput === 'function'
      ? await provider.readOutput(plan, receipt)
      : receipt.output
  const stdout = returnedOutput?.stdout ?? returnedOutput
  const outputBytes = Buffer.byteLength(JSON.stringify(returnedOutput ?? null))
  if (outputBytes > MAX_ENGINEERING_RECEIPT_OUTPUT_BYTES)
    fail('Engineering result exceeds durable checkpoint output budget', 'OUTPUT_BUDGET_EXCEEDED')
  const parsed = parseAndVerifyHarnessOutput(stdout, {
    expectedArtifacts,
    operationId,
    candidateDigest,
  })
  if (parsed.status !== 'pass')
    return {
      status: parsed.status,
      receipt,
      artifacts: [],
      operationId,
      candidateDigest,
      reason: parsed.error,
    }
  return {
    status: 'pass',
    receipt,
    verifiedOutput: returnedOutput,
    artifacts: parsed.artifacts,
    metadata: parsed.metadata,
    operationId,
    candidateDigest,
    engineeringReceipt: {
      version: profileVersion,
      provider: provider.id,
      executionTarget,
      operationId,
      candidateDigest,
      status: 'pass',
      artifacts: parsed.artifacts.map(({ path, sha256, byteLength }) => ({
        path,
        sha256,
        byteLength,
      })),
      observedModel: receipt.actual?.model ?? null,
      qualification: inspection.qualification ?? null,
    },
  }
}
