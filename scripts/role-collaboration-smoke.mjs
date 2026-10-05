#!/usr/bin/env node
import { resolveCollaborationPlan } from '../lib/collaboration-plan.mjs'
import {
  createAcceptanceContract,
  createAcceptanceDecision,
  createCouncilAdvice,
  createCouncilRequest,
  createCouncilSynthesis,
  createDeliveryReceipt,
  selectCouncilSeats,
  verifyRoleDelivery,
} from '../lib/core/role-collaboration.mjs'
import { createLocalCliProvider } from '../lib/providers/local-cli.mjs'
import { createRoleHandoff, validateRoleHandoff } from '../lib/role-catalog.mjs'

const candidateDigest = 'a'.repeat(64)
const evidenceRef = {
  kind: 'validation',
  system: 'local',
  uri: '.agent-runs/role-collaboration-smoke.json',
  authority: 'working-copy',
  relationship: 'verifies',
  digest: 'c'.repeat(64),
}

const provider = createLocalCliProvider({
  id: 'smoke-provider',
  platform: 'codex',
  executable: 'smoke-provider',
  executionTarget: 'codex-cli',
  intentSupport: [
    {
      id: 'workflow-orchestration',
      implementation: 'adapter',
      fidelity: 'full',
      evidence: 'contract-tested',
      limits: {},
    },
    {
      id: 'delegated-work',
      implementation: 'native',
      fidelity: 'full',
      evidence: 'probed',
      limits: { maxDelegates: 4 },
    },
  ],
  spawn: () => ({ status: 0, stdout: 'smoke-provider 1.0.0', stderr: '' }),
})

const planResult = await resolveCollaborationPlan({
  requestedMode: 'council',
  preferredProvider: provider.id,
  providers: [provider],
  config: { collaboration: { maxDelegates: 4, maxDepth: 1, maxIterations: 2 } },
})
if (!planResult.ok || planResult.plan.binding.status !== 'bound') {
  throw new Error(`provider plan failed: ${planResult.errors.join('; ')}`)
}

const ownerRole = 'agentflow:implementation-planner'
const deliveryRole = 'agentflow:developer'
const seats = selectCouncilSeats({ ownerRole })
const contract = createAcceptanceContract({
  id: 'smoke-contract',
  subject: 'smoke:role-collaboration',
  ownerRole,
  deliveryRole,
  collaborationClass: 'council',
  candidateDigest,
  criteria: [
    {
      id: 'tests-pass',
      description: 'focused tests pass for the candidate digest',
      verification: 'deterministic',
      required: true,
    },
    {
      id: 'intent-preserved',
      description: 'implementation preserves the accepted design intent',
      verification: 'semantic',
      required: true,
    },
  ],
  councilPolicy: { required: true, seats, decisionOwner: ownerRole },
})
const handoff = createRoleHandoff({
  id: 'smoke-handoff',
  subject: contract.subject,
  state: 'issued',
  fromRole: ownerRole,
  toRole: deliveryRole,
  rolePassId: 'smoke-planning-pass',
  profile: 'standard',
  actionBoundary: 'propose',
  inputRefs: [evidenceRef],
  outputRefs: [evidenceRef],
  validationRefs: [evidenceRef],
  expectedAction: 'implement the accepted design',
  acceptanceCriteria: ['tests pass', 'design intent preserved'],
  acceptanceContract: contract,
  openQuestions: [],
  methodPlays: [],
  provenance: {
    platform: 'codex',
    executor: 'codex-cli',
    transport: 'local-cli',
    delegationBoundary: 'current-session',
  },
})
if (!validateRoleHandoff({ handoff }).ok) throw new Error('smoke handoff is invalid')
const delivery = createDeliveryReceipt({
  id: 'smoke-delivery',
  handoffDigest: handoff.digest,
  contractDigest: contract.digest,
  producerRole: deliveryRole,
  candidateDigest,
  criteriaResults: [
    { criterionId: 'tests-pass', status: 'pass', evidenceRefs: [evidenceRef] },
    { criterionId: 'intent-preserved', status: 'pass', evidenceRefs: [evidenceRef] },
  ],
  evidenceRefs: [evidenceRef],
  provenance: { platform: 'codex', executor: 'codex-cli', transport: 'local-cli' },
})
const request = createCouncilRequest({
  id: 'smoke-council',
  subject: contract.subject,
  ownerRole,
  question: 'Does the delivery satisfy the cross-role contract?',
  evidenceDigest: delivery.digest,
  seats,
})
const advice = seats.map((seat, index) =>
  createCouncilAdvice({
    id: `smoke-advice-${index}`,
    requestDigest: request.digest,
    role: seat.role,
    position: 'accept',
    evidenceRefs: [evidenceRef],
    confidence: 'high',
  }),
)
const synthesis = createCouncilSynthesis({
  id: 'smoke-synthesis',
  requestDigest: request.digest,
  ownerRole,
  adviceDigests: advice.map((item) => item.digest),
  decision: 'accept after owner semantic review',
})
const report = verifyRoleDelivery({
  handoff,
  contract,
  delivery,
  councilRequest: request,
  councilAdvice: advice,
  councilSynthesis: synthesis,
})
if (report.status !== 'semantic-review-required') {
  throw new Error(`unexpected deterministic verification status: ${report.status}`)
}
const decision = createAcceptanceDecision({
  id: 'smoke-decision',
  handoff,
  contract,
  delivery,
  councilRequest: request,
  councilAdvice: advice,
  councilSynthesis: synthesis,
  handoffDigest: handoff.digest,
  contractDigest: contract.digest,
  deliveryDigest: delivery.digest,
  decidedByRole: ownerRole,
  state: 'accepted',
  deterministicReport: report,
  semanticFindings: [
    {
      criterionId: 'intent-preserved',
      status: 'pass',
      reason: 'the candidate preserves the accepted design constraints',
    },
  ],
  councilSynthesisDigest: synthesis.digest,
  provenance: { platform: 'codex', executor: 'codex-cli' },
})

console.log(
  JSON.stringify(
    {
      ok: true,
      collaborationMode: planResult.plan.collaborationMode,
      provider: planResult.plan.binding.provider,
      providerStatus: planResult.plan.binding.status,
      deterministicStatus: report.status,
      decision: decision.state,
      decisionOwner: decision.decidedByRole,
    },
    null,
    2,
  ),
)
