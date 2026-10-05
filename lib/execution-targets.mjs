// Deterministic execution-target vocabulary for routed agent CLIs.
//
// A registered runtime platform slug names *who* is being asked to work. It does not say *how*
// that work runs. This module keeps execution target, transport, provider, and delegation boundary
// separate from platform identity. See docs/execution-targets.md for the human-readable contract.

import { ROUTABLE_RUNTIME_PLATFORM_SLUGS } from './runtime-platforms.mjs'

// Compatibility export: these are registered platforms with built-in role-routing adapters, not
// the complete runtime platform registry.
export const AGENT_SLUGS = ROUTABLE_RUNTIME_PLATFORM_SLUGS

export const EXECUTION_TARGETS_BY_AGENT = {
  claude: ['claude-cli', 'anthropic-api'],
  agy: ['agy-cli', 'agy-session'],
  pi: ['pi-parent', 'pi-subagent', 'pi-session', 'pi-subagent-model'],
  codex: ['codex-cli', 'provider-api'],
  grok: ['grok-cli', 'xai-api'],
}

export const DEFAULT_EXECUTION_TARGET_BY_AGENT = {
  claude: 'claude-cli',
  agy: 'agy-cli',
  pi: 'pi-parent',
  codex: 'codex-cli',
  grok: 'grok-cli',
}

export const ALL_EXECUTION_TARGETS = [
  ...new Set(Object.values(EXECUTION_TARGETS_BY_AGENT).flat()),
  'human',
]

// PR evidence may describe an already-running desktop host. This is not a routable target:
// resolveExecutionTarget must not treat a desktop session as a CLI or provider launch.
export const EVIDENCE_ONLY_EXECUTION_TARGET_TRANSPORT = Object.freeze({
  'codex-desktop-session': 'desktop-runtime',
})
export const PR_MANIFEST_EXECUTION_TARGETS = [
  ...ALL_EXECUTION_TARGETS,
  ...Object.keys(EVIDENCE_ONLY_EXECUTION_TARGET_TRANSPORT),
]

export const TRANSPORTS = [
  'local-cli',
  'provider-api',
  'pi-subagent',
  'intercom-session',
  'orchestrated-worktree',
  'manual',
]
export const PR_MANIFEST_TRANSPORTS = [...TRANSPORTS, 'desktop-runtime']

export const DELEGATION_BOUNDARIES = [
  'current-session',
  'child-subagent',
  'separate-local-session',
  'child-worktree',
  'human-handoff',
]

export const EXECUTION_TARGET_TRANSPORT = {
  'claude-cli': 'local-cli',
  'anthropic-api': 'provider-api',
  'agy-cli': 'local-cli',
  'agy-session': 'orchestrated-worktree',
  'pi-parent': 'local-cli',
  'pi-subagent': 'pi-subagent',
  'pi-session': 'intercom-session',
  'pi-subagent-model': 'provider-api',
  'codex-cli': 'local-cli',
  'provider-api': 'provider-api',
  'grok-cli': 'local-cli',
  'xai-api': 'provider-api',
  human: 'manual',
}

// Default delegation boundary for each execution target. This is the boundary a launcher should
// record unless the actual launch mechanism differs (for example, a `claude-cli` run spawned by
// another agent into a fresh worktree is `child-worktree`, not `current-session`); see
// docs/execution-targets.md for the override rule.
export const EXECUTION_TARGET_DELEGATION_BOUNDARY = {
  'claude-cli': 'current-session',
  'anthropic-api': 'current-session',
  'agy-cli': 'current-session',
  'agy-session': 'child-worktree',
  'pi-parent': 'current-session',
  'pi-subagent': 'child-subagent',
  'pi-session': 'separate-local-session',
  'pi-subagent-model': 'child-subagent',
  'codex-cli': 'current-session',
  'provider-api': 'current-session',
  'grok-cli': 'current-session',
  'xai-api': 'current-session',
  human: 'human-handoff',
}

// Heuristic for "this looks like a model/provider identifier, not a bare agent-brand mention" —
// e.g. `anthropic/claude-sonnet-4`, `openai-codex/gpt-5.5`, `claude-sonnet-4-20250514`.
const PROVIDER_MODEL_PATTERN = /\/|^(claude|gpt|o\d|gemini|llama|mistral)[-.]/i

export function isKnownExecutionTarget(target) {
  return ALL_EXECUTION_TARGETS.includes(target)
}

export function describeExecutionTarget(target) {
  return {
    executionTarget: target,
    transport: EXECUTION_TARGET_TRANSPORT[target] ?? null,
    delegationBoundary: EXECUTION_TARGET_DELEGATION_BOUNDARY[target] ?? null,
  }
}

function fallbackProviderTarget(agentSlug) {
  const allowed = EXECUTION_TARGETS_BY_AGENT[agentSlug]
  return (
    allowed.find((target) =>
      ['anthropic-api', 'provider-api', 'pi-subagent-model'].includes(target),
    ) ?? null
  )
}

/**
 * Resolve what a request like "with claude", "claude-cli", or "anthropic/claude-sonnet-4"
 * deterministically means for a given agent slug, instead of letting it silently inherit the
 * caller's current model or provider.
 *
 * - An explicit, valid execution target is used as-is.
 * - A bare agent-brand mention resolves from `config.routing.agents.<slug>.defaultExecutionTarget`
 *   when set; a self-mention (the agent resolving its own bare name) falls back to the agent's
 *   built-in local-CLI default; any other bare mention with no configured default requires
 *   clarification instead of guessing.
 * - A model/provider identifier resolves to that agent's provider-backed execution target and is
 *   flagged as not being the local CLI.
 */
export function resolveExecutionTarget({ agentSlug, requested, currentAgent, config = {} } = {}) {
  if (!AGENT_SLUGS.includes(agentSlug)) {
    throw new Error(`agentSlug must be one of: ${AGENT_SLUGS.join(', ')}`)
  }

  const allowed = EXECUTION_TARGETS_BY_AGENT[agentSlug]
  const configuredDefault = config?.routing?.agents?.[agentSlug]?.defaultExecutionTarget ?? null
  const builtInDefault = DEFAULT_EXECUTION_TARGET_BY_AGENT[agentSlug]
  const normalized = (requested ?? '').trim()
  const bareMention =
    normalized === '' || normalized === agentSlug || normalized === `with ${agentSlug}`

  if (!bareMention && allowed.includes(normalized)) {
    return {
      ok: true,
      agentSlug,
      ...describeExecutionTarget(normalized),
      reason: 'explicit execution target requested',
      requiresClarification: false,
    }
  }

  if (!bareMention && isKnownExecutionTarget(normalized)) {
    return {
      ok: false,
      agentSlug,
      executionTarget: null,
      transport: null,
      delegationBoundary: null,
      reason: `execution target "${normalized}" does not belong to agent "${agentSlug}"; choose one of: ${allowed.join(', ')}`,
      requiresClarification: true,
    }
  }

  if (bareMention) {
    if (configuredDefault && allowed.includes(configuredDefault)) {
      return {
        ok: true,
        agentSlug,
        ...describeExecutionTarget(configuredDefault),
        reason: 'bare agent mention resolved from project config defaultExecutionTarget',
        requiresClarification: false,
      }
    }
    if (currentAgent === agentSlug) {
      return {
        ok: true,
        agentSlug,
        ...describeExecutionTarget(builtInDefault),
        reason: 'bare self-mention resolved to built-in local-CLI default',
        requiresClarification: false,
      }
    }
    return {
      ok: false,
      agentSlug,
      executionTarget: null,
      transport: null,
      delegationBoundary: null,
      reason: `ambiguous request "with ${agentSlug}" has no configured defaultExecutionTarget; resolve from project config or ask a clarifying question before launching work`,
      requiresClarification: true,
    }
  }

  if (PROVIDER_MODEL_PATTERN.test(normalized)) {
    const providerTarget = fallbackProviderTarget(agentSlug)
    if (providerTarget) {
      return {
        ok: true,
        agentSlug,
        ...describeExecutionTarget(providerTarget),
        reason: `model identifier "${normalized}" resolves to a provider-backed call, not the local ${agentSlug} CLI, unless the configured transport explicitly says otherwise`,
        requiresClarification: false,
        model: normalized,
      }
    }
  }

  return {
    ok: false,
    agentSlug,
    executionTarget: null,
    transport: null,
    delegationBoundary: null,
    reason: `unrecognized execution target "${normalized}" for agent "${agentSlug}"; ask a clarifying question before launching work`,
    requiresClarification: true,
  }
}
