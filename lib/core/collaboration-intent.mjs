import { createExecutionIntent, validateExecutionIntent } from './execution-intent.mjs'
import { unitIdentity } from './unit-identity.mjs'

export const COLLABORATION_INTENT_VERSION = 1

export const COLLABORATION_MODES = [
  'auto-minimal',
  'single-agent',
  'advisory',
  'sparring',
  'council',
  'parallel-discovery',
  'spike',
  'human-gated',
]

export const DEFAULT_COLLABORATION_POLICY = Object.freeze({
  sensitiveSurfaces: ['security', 'auth', 'data', 'infra', 'billing'],
  councilHelpers: [
    'risk-scout',
    'implementation-strategist',
    'testability-scout',
    'docs-impact-scout',
  ],
  discoveryHelpers: ['requirements-scout', 'architecture-scout'],
  maxDelegates: 3,
  maxDepth: 1,
  maxIterations: 3,
})

function list(value) {
  if (Array.isArray(value)) return value
  if (!value) return []
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

export function validateCollaborationPolicy(policy = {}) {
  const errors = []
  for (const field of [
    'sensitiveSurfaces',
    'councilHelpers',
    'discoveryHelpers',
    'fallbackModes',
  ]) {
    if (
      policy[field] !== undefined &&
      (!Array.isArray(policy[field]) ||
        policy[field].some((item) => typeof item !== 'string' || !item))
    ) {
      errors.push(`${field} must be an array of non-empty strings`)
    }
  }
  for (const field of ['maxDelegates', 'maxDepth', 'maxIterations']) {
    if (policy[field] !== undefined && (!Number.isInteger(policy[field]) || policy[field] < 1)) {
      errors.push(`${field} must be a positive integer`)
    }
  }
  if (
    Array.isArray(policy.fallbackModes) &&
    policy.fallbackModes.some((item) => !['sequential', 'manual'].includes(item))
  ) {
    errors.push('fallbackModes contains an unsupported fallback')
  }
  return { ok: errors.length === 0, errors }
}

export function selectCollaborationMode({
  requestedMode = 'auto-minimal',
  profile = 'standard',
  risk = 'medium',
  effort = 'medium',
  changeSurface = [],
  uncertainty = 'medium',
  broadDiscovery = false,
  isolatedSpike = false,
  policy = {},
} = {}) {
  const policyValidation = validateCollaborationPolicy(policy)
  if (!policyValidation.ok)
    throw new Error(`invalid collaboration policy: ${policyValidation.errors.join('; ')}`)
  if (!COLLABORATION_MODES.includes(requestedMode)) {
    throw new Error(`collaboration mode must be one of: ${COLLABORATION_MODES.join(', ')}`)
  }
  const surfaces = list(changeSurface)
  const sensitiveSurfaces = new Set([
    ...DEFAULT_COLLABORATION_POLICY.sensitiveSurfaces,
    ...(policy.sensitiveSurfaces ?? []),
  ])
  if (profile === 'high-assurance' || surfaces.some((item) => sensitiveSurfaces.has(item))) {
    return 'human-gated'
  }
  if (requestedMode !== 'auto-minimal') return requestedMode
  if (isolatedSpike) return 'spike'
  if (broadDiscovery || effort === 'high') return 'parallel-discovery'
  if (uncertainty === 'high' || risk === 'high') return 'council'
  if (profile === 'standard' || risk === 'medium' || uncertainty === 'medium') return 'advisory'
  return 'single-agent'
}

function rolesForMode(mode, policy = {}) {
  if (mode === 'advisory') return ['risk-scout']
  if (mode === 'sparring') return ['adversarial-reviewer']
  if (mode === 'council') {
    return policy.councilHelpers ?? DEFAULT_COLLABORATION_POLICY.councilHelpers
  }
  if (mode === 'parallel-discovery') {
    return policy.discoveryHelpers ?? DEFAULT_COLLABORATION_POLICY.discoveryHelpers
  }
  if (mode === 'spike') return ['spike-implementer']
  if (mode === 'human-gated') return ['human-reviewer']
  return []
}

function reasonForMode(mode) {
  const reasons = {
    'single-agent': 'low uncertainty and low coordination value; single-agent path is sufficient',
    advisory: 'standard or medium-risk work benefits from one focused read-only second opinion',
    sparring:
      'pre-implementation contract specification benefits from iterative adversarial verification before code',
    council: 'high uncertainty or risk warrants role-local scout perspectives before synthesis',
    'parallel-discovery': 'broad/high-effort scope warrants bounded read-only discovery fanout',
    spike: 'implementation uncertainty warrants an isolated experiment before integration',
    'human-gated': 'sensitive or high-assurance surface requires human authority',
  }
  return reasons[mode] ?? 'auto-minimal collaboration selection'
}

export function createCollaborationIntent(options = {}) {
  const changeSurface = list(options.changeSurface)
  const mode = selectCollaborationMode({ ...options, changeSurface })
  const policy = options.policy ?? {}
  const policyValidation = validateCollaborationPolicy(policy)
  if (!policyValidation.ok) {
    throw new Error(`invalid collaboration policy: ${policyValidation.errors.join('; ')}`)
  }
  const participantRoles = rolesForMode(mode, policy)
  const requirements = [
    { id: 'workflow-orchestration', required: true, fallback: 'sequential' },
    ...(mode === 'advisory' || mode === 'council' || mode === 'sparring'
      ? [{ id: 'delegated-work', required: true, fallback: 'sequential' }]
      : []),
    ...(mode === 'parallel-discovery'
      ? [
          { id: 'delegated-work', required: true, fallback: 'sequential' },
          { id: 'parallel-fanout', required: true, fallback: 'sequential' },
        ]
      : []),
    ...(mode === 'spike'
      ? [
          { id: 'delegated-work', required: true, parameters: { minimumFidelity: 'full' } },
          { id: 'isolated-workspace', required: true, parameters: { minimumFidelity: 'full' } },
        ]
      : []),
    ...(mode === 'human-gated' ? [{ id: 'structured-result', required: false }] : []),
  ]
  const controls = [
    'single-writer',
    'authority-may-only-narrow',
    ...(options.profile === 'high-assurance' ? ['review-independence', 'human-approval'] : []),
  ]
  const intent = {
    version: COLLABORATION_INTENT_VERSION,
    issueNumber: options.issueNumber ?? null,
    mode,
    reason: reasonForMode(mode),
    profile: options.profile ?? 'standard',
    risk: options.risk ?? 'medium',
    effort: options.effort ?? 'medium',
    uncertainty: options.uncertainty ?? 'medium',
    changeSurface,
    participantRoles,
    writerPolicy: 'single-writer',
    humanGate: mode === 'human-gated',
    synthesisRequired: participantRoles.length > 0,
    execution: createExecutionIntent({
      // W8c D1 — the ONE identity function, replacing the ad hoc issue-colon-number spelling this
      // module used to build inline. `repo` is optional here (most callers today have none to
      // give); unitIdentity degrades gracefully to an 'unscoped' namespace rather than throwing, so
      // this stays backward compatible.
      subject: options.issueNumber
        ? unitIdentity({ repo: options.repo, id: options.issueNumber })
        : null,
      requirements,
      controls,
      limits: {
        maxDelegates:
          options.maxDelegates ??
          policy.maxDelegates ??
          (mode === 'council' ? participantRoles.length : mode === 'parallel-discovery' ? 2 : 1),
        maxDepth: options.maxDepth ?? policy.maxDepth ?? DEFAULT_COLLABORATION_POLICY.maxDepth,
        maxIterations:
          options.maxIterations ??
          policy.maxIterations ??
          DEFAULT_COLLABORATION_POLICY.maxIterations,
      },
    }),
    fallback: {
      allowed: !['human-gated', 'spike'].includes(mode),
      modes:
        mode === 'single-agent' ? ['manual'] : (policy.fallbackModes ?? ['sequential', 'manual']),
    },
  }
  // W8g D1 — validateCollaborationIntent used to have no caller anywhere in this repo's own
  // product code (only lib/__tests__/modular-contracts.test.mjs exercised it as a contract-shape
  // check). Its natural enforcement point is right here: the one place a CollaborationIntent
  // record is composed. Every field above is built correctly by construction today, but this is
  // the guard that keeps it that way — a future edit to this function that breaks the contract
  // (an unsupported mode, a malformed execution block, ...) now fails loudly here, at creation
  // time, instead of silently propagating into bindProvider/planBoundExecution downstream.
  const validation = validateCollaborationIntent(intent)
  if (!validation.ok) {
    throw new Error(`invalid collaboration intent: ${validation.errors.join('; ')}`)
  }
  return intent
}

export function validateCollaborationIntent(intent) {
  const errors = []
  if (intent?.version !== COLLABORATION_INTENT_VERSION) errors.push('version must be 1')
  if (!COLLABORATION_MODES.includes(intent?.mode)) errors.push('mode is not supported')
  if (intent?.writerPolicy !== 'single-writer') errors.push('writerPolicy must be single-writer')
  if (!Array.isArray(intent?.participantRoles)) errors.push('participantRoles must be an array')
  const execution = validateExecutionIntent(intent?.execution)
  errors.push(...execution.errors.map((error) => `execution.${error}`))
  return { ok: errors.length === 0, errors }
}
