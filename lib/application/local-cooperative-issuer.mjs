import { recordDigest } from '../core/record-digest.mjs'
import { grantRequestDigest, validateDelegationPolicy } from '../core/delegation-grant.mjs'

// An explicit local host decision, NOT authentication of a human. Shared-account
// malicious processes are outside this cooperative adapter's assurance boundary.
export function createLocalCooperativeIssuer({ policy, issuerId, approve }) {
  policy = structuredClone(policy)
  validateDelegationPolicy(policy)
  const issuer = policy.issuers.find((i) => i.id === issuerId)
  if (!issuer || typeof approve !== 'function')
    throw new Error('Configured issuer and approval surface required')
  return async (context) => {
    context = structuredClone(context)
    if (!['issue-grant', 'resolve-grant', 'revoke-grant'].includes(context.kind)) return false
    const decision = await approve(structuredClone(context))
    if (
      decision?.approved !== true ||
      typeof decision.decisionRef !== 'string' ||
      !decision.decisionRef.trim()
    )
      return false
    const origin = {
      issuerId,
      mode: issuer.mode,
      origin: issuer.origin,
      authorityRef: issuer.authorityRef,
      policyDigest: recordDigest(policy),
      decisionRef: decision.decisionRef,
    }
    if (context.kind === 'issue-grant')
      return {
        ...origin,
        type: 'delegation-issuance',
        requestDigest: grantRequestDigest(context.request),
      }
    return {
      ...origin,
      type: context.kind === 'resolve-grant' ? 'delegation-resolution' : 'delegation-revocation',
      grantId: context.grant.envelope.id,
      grantRevision: context.grant.revision,
      ...(context.operationDigest
        ? { operationDigest: context.operationDigest, delegate: context.operation.delegate }
        : {}),
    }
  }
}
