import { bindProvider } from './core/provider-binding.mjs'
import {
  COLLABORATION_MODES,
  createCollaborationIntent,
  selectCollaborationMode,
} from './core/collaboration-intent.mjs'
import { shippedProviders } from './providers/catalog.mjs'
import { loadProjectConfig } from './role-routing.mjs'

export { COLLABORATION_MODES, selectCollaborationMode }

export const PERMISSIONS = ['read-only', 'writer', 'test-runner', 'reviewer', 'human-gate']

export function planBoundExecution({ provider, collaborationPlan, request = {} } = {}) {
  const binding = collaborationPlan?.binding
  if (!binding || binding.status === 'blocked' || binding.provider !== provider?.id) {
    throw new Error('execution requires the selected, non-blocked provider binding')
  }
  return provider.plan({
    ...request,
    intent: collaborationPlan.intent,
    executionPlan: binding,
  })
}

function list(value) {
  if (Array.isArray(value)) return value
  if (!value) return []
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function helper(role, extra = {}) {
  return { role, permissions: 'read-only', ...extra }
}

function helpersForIntent(intent) {
  return intent.participantRoles.map((role) => {
    if (intent.mode === 'spike') return helper(role, { permissions: 'writer' })
    if (intent.mode === 'sparring')
      return helper(role, { permissions: 'read-only', enforceSparringView: true })
    if (intent.mode === 'human-gated') return helper(role, { permissions: 'human-gate' })
    if (intent.mode === 'parallel-discovery') return helper(role, { maxFiles: 40 })
    return helper(role)
  })
}

function environmentForMode(mode, binding) {
  if (mode === 'spike') return 'worktree'
  if (mode === 'human-gated') return 'human-handoff'
  if (binding.transport === 'manual') return 'human-handoff'
  const delegated = binding.intentResolutions?.find((item) => item.id === 'delegated-work')
  if (
    delegated?.status !== 'satisfied' ||
    delegated.implementation === 'manual' ||
    delegated.fidelity === 'degraded'
  ) {
    return 'current-session'
  }
  return 'forked-context'
}

function reasonForMode(mode, { profile, risk, effort, uncertainty, changeSurface }) {
  if (mode === 'single-agent') return 'low uncertainty and low coordination value'
  if (mode === 'advisory')
    return 'standard or medium-risk work benefits from a focused second opinion'
  if (mode === 'sparring')
    return 'pre-implementation contract specification benefits from iterative adversarial verification'
  if (mode === 'council') return 'high uncertainty or risk warrants role-local perspectives'
  if (mode === 'parallel-discovery')
    return 'broad scope warrants bounded read-only discovery fanout'
  if (mode === 'spike') return 'implementation uncertainty warrants an isolated experiment'
  if (mode === 'human-gated') return 'sensitive or high-assurance work requires human authority'
  return `auto-minimal evaluated profile=${profile}, risk=${risk}, effort=${effort}, uncertainty=${uncertainty}, surfaces=${list(changeSurface).join(',') || 'none'}`
}

export async function resolveCollaborationPlan({
  issueNumber = null,
  requestedMode = null,
  profile = 'standard',
  risk = 'medium',
  effort = 'medium',
  changeSurface = [],
  uncertainty = 'medium',
  broadDiscovery = false,
  isolatedSpike = false,
  preferredProvider = null,
  providers = shippedProviders(),
  maxDelegates,
  maxDepth,
  maxIterations,
  config = loadProjectConfig(),
} = {}) {
  const policy = config.collaboration ?? {}
  const intent = createCollaborationIntent({
    issueNumber,
    requestedMode: requestedMode ?? policy.defaultMode ?? 'auto-minimal',
    profile,
    risk,
    effort,
    changeSurface,
    uncertainty,
    broadDiscovery,
    isolatedSpike,
    maxDelegates,
    maxDepth,
    maxIterations,
    policy,
  })
  const mode = intent.mode
  const effectiveProvider = mode === 'human-gated' ? 'manual' : preferredProvider
  const binding = await bindProvider({ intent, providers, preferredProvider: effectiveProvider })
  const helpers = helpersForIntent(intent)
  const plan = {
    version: 1,
    issueNumber,
    intent,
    collaborationMode: mode,
    reason: reasonForMode(mode, { profile, risk, effort, uncertainty, changeSurface }),
    binding,
    executionStrategy: binding.degraded ? 'fallback' : 'provider-native-or-adapter',
    environment: environmentForMode(mode, binding),
    helpers,
    writer: mode === 'spike' ? 'isolated-worktree-helper' : 'parent',
    humanGate: mode === 'human-gated',
    synthesisRequired: helpers.length > 0,
  }

  const errors = []
  if (binding.status === 'blocked') errors.push(binding.reason)
  const sharedWriters = helpers.filter((item) => item.permissions === 'writer' && mode !== 'spike')
  if (sharedWriters.length > 0)
    errors.push('shared-worktree helpers must not receive writer permission')
  if (mode === 'spike' && plan.environment !== 'worktree') {
    errors.push('spike mode requires isolated-workspace support')
  }
  return { ok: errors.length === 0, errors, plan }
}
