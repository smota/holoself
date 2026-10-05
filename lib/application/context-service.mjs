import { projectRunContext } from '../core/run-state.mjs'
import { recordDigest } from '../core/record-digest.mjs'

export const MAX_CONTROL_CONTEXT_BYTES = 32 * 1024
export const MAX_POLICY_INDEX_BYTES = 8 * 1024

const bytes = (value) => Buffer.byteLength(JSON.stringify(value))

function boundedJson(value, name) {
  let serialized
  try {
    serialized = JSON.stringify(value)
  } catch {
    throw new Error(`${name} must be finite JSON`)
  }
  if (serialized === undefined) throw new Error(`${name} must be finite JSON`)
  const copy = JSON.parse(serialized)
  if (JSON.stringify(copy) !== serialized) throw new Error(`${name} must be finite JSON`)
  return copy
}

function measure(packet) {
  // The byte count includes its own decimal representation.
  let measured = 0
  for (let attempt = 0; attempt < 5; attempt++) {
    const next = bytes({ ...packet, bytes: measured })
    if (next === measured) return measured
    measured = next
  }
  return bytes({ ...packet, bytes: measured })
}

function makePacket(dynamic, common, commonDigest, reuse, policyBytes) {
  const packet = {
    ...dynamic,
    commonDigest,
    ...(reuse ? { commonRef: { digest: commonDigest } } : { common }),
    repeatedBytesAvoided: reuse
      ? Math.max(0, bytes({ common }) - bytes({ commonRef: { digest: commonDigest } }))
      : 0,
    policyBytes,
  }
  return { ...packet, bytes: measure(packet) }
}

export function buildRunContext({ state, policyIndex = null, knownCommonDigest = null }) {
  const projected = projectRunContext(state)
  const policy = policyIndex === null ? null : boundedJson(policyIndex, 'Policy index')
  const policyBytes = policy === null ? 0 : bytes(policy)
  if (policyBytes > MAX_POLICY_INDEX_BYTES) throw new Error('Policy index exceeds 8 KiB capacity')
  const common = {
    contract: projected.contract,
    authorityReferences: projected.authorityReferences,
    roleReference: projected.roleReference,
    policyIndex: policy,
  }
  const commonDigest = recordDigest(common)
  const { contract, authorityReferences, roleReference, ...dynamic } = projected
  const inline = makePacket(dynamic, common, commonDigest, false, policyBytes)
  if (inline.bytes > MAX_CONTROL_CONTEXT_BYTES)
    throw new Error('Complete control context exceeds 32 KiB capacity')
  const reused = knownCommonDigest === commonDigest
  const packet = reused ? makePacket(dynamic, common, commonDigest, true, policyBytes) : inline
  if (packet.bytes > MAX_CONTROL_CONTEXT_BYTES)
    throw new Error('Control context exceeds 32 KiB capacity')
  return packet
}

export function materializeRunContext({ context, cachedCommon }) {
  if (context?.version !== 1 || !/^[a-f0-9]{64}$/.test(context.commonDigest ?? ''))
    throw new Error('Invalid control context')
  const common = context.common ?? cachedCommon
  if (
    !common ||
    recordDigest(common) !== context.commonDigest ||
    (context.commonRef && context.commonRef.digest !== context.commonDigest)
  )
    throw new Error('Missing or stale common context cache')
  if (context.common && context.commonRef)
    throw new Error('Ambiguous common context representation')
  const policyBytes = common.policyIndex === null ? 0 : bytes(common.policyIndex)
  if (policyBytes > MAX_POLICY_INDEX_BYTES) throw new Error('Policy index exceeds 8 KiB capacity')
  const {
    common: inlineCommon,
    commonDigest,
    commonRef,
    repeatedBytesAvoided,
    policyBytes: reportedPolicyBytes,
    bytes: reportedBytes,
    ...dynamic
  } = context
  if (
    reportedPolicyBytes !== policyBytes ||
    reportedBytes !== bytes(context) ||
    reportedBytes > MAX_CONTROL_CONTEXT_BYTES
  )
    throw new Error('Control context byte accounting mismatch')
  return { ...dynamic, ...structuredClone(common) }
}
