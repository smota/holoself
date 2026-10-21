import { resolveDistribution, distributionRole } from './config/execution-distribution.mjs'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  AGENT_SLUGS,
  DEFAULT_EXECUTION_TARGET_BY_AGENT,
  EXECUTION_TARGETS_BY_AGENT,
  describeExecutionTarget,
} from './execution-targets.mjs'
import { runtimePlatformRegistry } from './runtime-platforms.mjs'
import { CORE_ROLES, canonicalRole as canonicalWorkflowRole } from './sdlc-vocabulary.mjs'

export const SUPPORTED_AGENT_SLUGS = AGENT_SLUGS

export const WORKFLOW_ROLES = CORE_ROLES.map((role) => role.slug)

const DEFAULT_CONFIG_PATH = 'agent-workflow.config.json'

export function loadProjectConfig(repoRoot = process.cwd(), configPath = DEFAULT_CONFIG_PATH) {
  const fullPath = resolve(repoRoot, configPath)
  if (!existsSync(fullPath)) return {}
  return JSON.parse(readFileSync(fullPath, 'utf8'))
}

function unique(values) {
  return [...new Set(values)]
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeAgentConfig(agentConfig, slug) {
  return {
    enabled: agentConfig?.enabled !== false,
    availabilityProbe: agentConfig?.availabilityProbe ?? null,
    callWorkflowDoc: agentConfig?.callWorkflowDoc ?? null,
    defaultExecutionTarget:
      agentConfig?.defaultExecutionTarget ?? DEFAULT_EXECUTION_TARGET_BY_AGENT[slug] ?? null,
  }
}

export function validateRoutingConfig(config, { repoRoot = process.cwd(), checkDocs = true } = {}) {
  const errors = []
  const warnings = []
  const routing = config.routing

  try {
    runtimePlatformRegistry(config)
  } catch (error) {
    errors.push(error.message)
  }

  if (routing === undefined) {
    return {
      ok: errors.length === 0,
      errors,
      warnings: ['routing config missing; defaulting to single-agent mode'],
    }
  }

  if (!isPlainObject(routing)) {
    return { ok: false, errors: ['routing must be an object'], warnings }
  }

  if (
    routing.defaultMode !== undefined &&
    !['single-agent', 'optional-multi-agent'].includes(routing.defaultMode)
  ) {
    errors.push('routing.defaultMode must be "single-agent" or "optional-multi-agent"')
  }

  const agents = routing.agents ?? {}
  if (!isPlainObject(agents)) {
    errors.push('routing.agents must be an object when present')
  } else {
    for (const [slug, agent] of Object.entries(agents)) {
      if (!SUPPORTED_AGENT_SLUGS.includes(slug)) {
        errors.push(`unsupported agent slug in routing.agents: ${slug}`)
        continue
      }
      if (!isPlainObject(agent)) {
        errors.push(`routing.agents.${slug} must be an object`)
        continue
      }
      if (agent.enabled !== undefined && typeof agent.enabled !== 'boolean') {
        errors.push(`routing.agents.${slug}.enabled must be boolean when present`)
      }
      if (agent.availabilityCommand !== undefined) {
        errors.push(
          `routing.agents.${slug}.availabilityCommand is unsupported; use availabilityProbe`,
        )
      }
      if (agent.availabilityProbe !== undefined) {
        if (!isPlainObject(agent.availabilityProbe)) {
          errors.push(`routing.agents.${slug}.availabilityProbe must be an object when present`)
        } else {
          if (
            typeof agent.availabilityProbe.executable !== 'string' ||
            !agent.availabilityProbe.executable ||
            /[;&|<>]/.test(agent.availabilityProbe.executable)
          ) {
            errors.push(
              `routing.agents.${slug}.availabilityProbe.executable must be a bare command or path`,
            )
          }
          if (
            agent.availabilityProbe.args !== undefined &&
            (!Array.isArray(agent.availabilityProbe.args) ||
              agent.availabilityProbe.args.some((item) => typeof item !== 'string'))
          ) {
            errors.push(`routing.agents.${slug}.availabilityProbe.args must be an array of strings`)
          }
        }
      }
      if (agent.callWorkflowDoc !== undefined) {
        if (typeof agent.callWorkflowDoc !== 'string') {
          errors.push(`routing.agents.${slug}.callWorkflowDoc must be a string when present`)
        } else if (
          checkDocs &&
          agent.enabled !== false &&
          !existsSync(resolve(repoRoot, agent.callWorkflowDoc))
        ) {
          errors.push(
            `routing.agents.${slug}.callWorkflowDoc does not exist: ${agent.callWorkflowDoc}`,
          )
        }
      }
      if (agent.defaultExecutionTarget !== undefined) {
        const allowedTargets = EXECUTION_TARGETS_BY_AGENT[slug] ?? []
        if (typeof agent.defaultExecutionTarget !== 'string') {
          errors.push(`routing.agents.${slug}.defaultExecutionTarget must be a string when present`)
        } else if (!allowedTargets.includes(agent.defaultExecutionTarget)) {
          errors.push(
            `routing.agents.${slug}.defaultExecutionTarget must be one of: ${allowedTargets.join(', ')}`,
          )
        }
      }
    }
  }

  const roles = routing.roles ?? {}
  if (!isPlainObject(roles)) {
    errors.push('routing.roles must be an object when present')
  } else {
    for (const [role, route] of Object.entries(roles)) {
      const canonical = canonicalWorkflowRole(role)
      if (!canonical || !WORKFLOW_ROLES.includes(canonical))
        errors.push(`unknown role configured: ${role}`)
      if (!isPlainObject(route)) {
        errors.push(`routing.roles.${role} must be an object`)
        continue
      }
      if (!route.owner || typeof route.owner !== 'string') {
        errors.push(`routing.roles.${role}.owner is required and must be a string`)
      } else if (!SUPPORTED_AGENT_SLUGS.includes(route.owner)) {
        errors.push(`routing.roles.${role}.owner has unsupported agent slug: ${route.owner}`)
      }
      if (route.fallbacks === undefined) {
        errors.push(`routing.roles.${role}.fallbacks is required and must be an array`)
      } else if (!Array.isArray(route.fallbacks)) {
        errors.push(`routing.roles.${role}.fallbacks must be an array`)
      } else {
        for (const fallback of route.fallbacks) {
          if (typeof fallback !== 'string' || !SUPPORTED_AGENT_SLUGS.includes(fallback)) {
            errors.push(
              `routing.roles.${role}.fallbacks contains unsupported agent slug: ${fallback}`,
            )
          }
        }
        if (route.owner && route.fallbacks.includes(route.owner)) {
          errors.push(`routing.roles.${role}.fallbacks must not repeat owner ${route.owner}`)
        }
        if (unique(route.fallbacks).length !== route.fallbacks.length) {
          errors.push(`routing.roles.${role}.fallbacks must not contain duplicates`)
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings }
}

function probeAvailable(probe, repoRoot) {
  if (!probe) return true
  const result = spawnSync(probe.executable, probe.args ?? ['--version'], {
    cwd: repoRoot,
    stdio: 'ignore',
    shell: false,
    windowsHide: true,
    timeout: 10_000,
  })
  return !result.error && result.status === 0
}

export function resolveRoleRoute({
  role,
  currentAgent,
  config = {},
  repoRoot = process.cwd(),
  checkAvailability = true,
} = {}) {
  if (!role) throw new Error('role is required')
  if (!currentAgent) throw new Error('currentAgent is required')
  if (!SUPPORTED_AGENT_SLUGS.includes(currentAgent)) {
    throw new Error(`currentAgent must be one of: ${SUPPORTED_AGENT_SLUGS.join(', ')}`)
  }

  const canonicalRole = canonicalWorkflowRole(role, config)
  if (!canonicalRole) throw new Error(`Unknown workflow role: ${role}`)
  const validation = validateRoutingConfig(config, { repoRoot })
  if (!validation.ok) {
    return {
      ok: false,
      role: canonicalRole,
      mode: 'blocked',
      selectedAgent: null,
      currentAgent,
      launcher: currentAgent,
      executor: null,
      executionTarget: null,
      transport: null,
      delegationBoundary: null,
      owner: null,
      fallbacksTried: [],
      reason: `invalid routing config: ${validation.errors.join('; ')}`,
      handoverDoc: null,
      requiresHandoverComment: true,
      validation,
    }
  }

  const routing = config.routing
  if (config.executionDistribution) {
    const profile = resolveDistribution(config.executionDistribution)
    const resolved = distributionRole(profile, canonicalRole)
    const desired = resolved.options[0],
      candidate = desired.client
    const agentConfig = normalizeAgentConfig(routing?.agents?.[candidate], candidate)
    const present =
      agentConfig.enabled &&
      (!checkAvailability || probeAvailable(agentConfig.availabilityProbe, repoRoot))
    return {
      ok: present,
      role: canonicalRole,
      mode: present
        ? candidate === currentAgent
          ? 'single-agent'
          : 'optional-multi-agent'
        : 'blocked',
      selectedAgent: present ? candidate : null,
      currentAgent,
      launcher: currentAgent,
      executor: present ? desired.executionTarget : null,
      executionTarget: present ? desired.executionTarget : null,
      ...(present
        ? describeExecutionTarget(desired.executionTarget)
        : { transport: null, delegationBoundary: null }),
      owner: candidate,
      desiredExecution: desired,
      actualExecution: 'unknown',
      fallbackOptions: resolved.options.slice(1),
      fallbacksTried: [],
      reason: present
        ? 'pinned distribution default; provider availability and actual execution unverified'
        : 'distribution client disabled or unavailable; inspect approved subscription fallback options',
      handoverDoc: agentConfig.callWorkflowDoc,
      requiresHandoverComment: true,
      validation,
    }
  }
  const configuredRoute = routing?.roles?.[canonicalRole]
  if (!routing || !configuredRoute) {
    const currentAgentConfig = normalizeAgentConfig(routing?.agents?.[currentAgent], currentAgent)
    const executionTarget = currentAgentConfig.defaultExecutionTarget
    return {
      ok: true,
      role: canonicalRole,
      mode: 'single-agent',
      selectedAgent: currentAgent,
      currentAgent,
      launcher: currentAgent,
      executor: executionTarget,
      ...describeExecutionTarget(executionTarget),
      owner: currentAgent,
      fallbacksTried: [],
      reason: routing
        ? 'role not configured; defaulting to current executor'
        : 'routing config missing; defaulting to current executor',
      handoverDoc: null,
      requiresHandoverComment: true,
      validation,
    }
  }

  const agents = routing.agents ?? {}
  const candidates = [configuredRoute.owner, ...(configuredRoute.fallbacks ?? [])]
  const fallbacksTried = []

  for (const candidate of candidates) {
    const agentConfig = normalizeAgentConfig(agents[candidate], candidate)
    if (!agentConfig.enabled) {
      fallbacksTried.push({ agent: candidate, available: false, reason: 'disabled' })
      continue
    }
    const available = !checkAvailability || probeAvailable(agentConfig.availabilityProbe, repoRoot)
    if (!available) {
      fallbacksTried.push({
        agent: candidate,
        available: false,
        reason: 'availability probe failed',
      })
      continue
    }
    const usedFallback = candidate !== configuredRoute.owner
    return {
      ok: true,
      role: canonicalRole,
      mode: candidate === currentAgent ? 'single-agent' : 'optional-multi-agent',
      selectedAgent: candidate,
      currentAgent,
      launcher: currentAgent,
      executor: agentConfig.defaultExecutionTarget,
      ...describeExecutionTarget(agentConfig.defaultExecutionTarget),
      owner: configuredRoute.owner,
      fallbacksTried,
      reason: usedFallback
        ? 'configured owner unavailable; fallback selected'
        : 'configured owner available',
      handoverDoc: agentConfig.callWorkflowDoc,
      requiresHandoverComment: true,
      validation,
    }
  }

  return {
    ok: false,
    role: canonicalRole,
    mode: 'blocked',
    selectedAgent: null,
    currentAgent,
    launcher: currentAgent,
    executor: null,
    executionTarget: null,
    transport: null,
    delegationBoundary: null,
    owner: configuredRoute.owner,
    fallbacksTried,
    reason: 'no configured owner or fallback agent is available',
    handoverDoc: null,
    requiresHandoverComment: true,
    validation,
  }
}

export const EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high'])

const LOW_EFFORT_ROLES = new Set(['tester', 'qa-expert', 'fixture-builder', 'pr-readiness'])

export function resolveEffortCalibration({
  role,
  rung = 'P1',
  requestedEffort = null,
  contextTokens = 0,
  isCleanSubagent = false,
  effortPolicy = {},
} = {}) {
  const canonical = role ? (canonicalWorkflowRole(role) ?? role) : 'developer'
  const highEffortMaxContextTokens = effortPolicy.highEffortMaxContextTokens ?? 40000
  const enforceCleanSubagent = effortPolicy.enforceCleanSubagentForHighEffort !== false
  const defaultLoopEffort = effortPolicy.defaultLoopEffort ?? 'medium'
  const subagentSearchEffort = effortPolicy.subagentSearchEffort ?? 'low'

  if (rung === 'P0' || LOW_EFFORT_ROLES.has(canonical)) {
    return {
      role: canonical,
      rung,
      effort: requestedEffort === 'medium' ? 'medium' : subagentSearchEffort,
      degradationGuardTriggered: requestedEffort === 'high',
      maxSafeContextTokens: 120000,
      recommendedAction:
        requestedEffort === 'high'
          ? 'clamped-to-low-or-medium-for-verification-and-p0'
          : 'direct-execution',
    }
  }

  const wantsHighEffort = requestedEffort === 'high'
  if (wantsHighEffort) {
    const cleanEnough =
      (!enforceCleanSubagent || isCleanSubagent) && contextTokens <= highEffortMaxContextTokens
    if (cleanEnough) {
      return {
        role: canonical,
        rung,
        effort: 'high',
        degradationGuardTriggered: false,
        maxSafeContextTokens: highEffortMaxContextTokens,
        recommendedAction: 'isolated-clean-subagent-execution',
      }
    }
    return {
      role: canonical,
      rung,
      effort: defaultLoopEffort,
      degradationGuardTriggered: true,
      maxSafeContextTokens: highEffortMaxContextTokens,
      recommendedAction: 'spawn-clean-l2-subagent',
      reason: isCleanSubagent
        ? `contextTokens (${contextTokens}) exceeds highEffortMaxContextTokens (${highEffortMaxContextTokens})`
        : 'high effort is restricted to clean-context L2 child subagents (<40k tokens)',
    }
  }

  if (contextTokens > 100000 && defaultLoopEffort === 'medium') {
    return {
      role: canonical,
      rung,
      effort: 'low',
      degradationGuardTriggered: true,
      maxSafeContextTokens: 100000,
      recommendedAction: 'compact-or-delegate-to-subagent',
      reason: `contextTokens (${contextTokens}) exceeds 100k medium-effort loop ceiling`,
    }
  }

  return {
    role: canonical,
    rung,
    effort:
      requestedEffort && EFFORT_LEVELS.includes(requestedEffort)
        ? requestedEffort
        : defaultLoopEffort,
    degradationGuardTriggered: false,
    maxSafeContextTokens: 100000,
    recommendedAction: 'direct-execution',
  }
}

export function resolveCompositePhaseWindow({
  rung = 'P1',
  oracleDigestPinned = false,
  compositeBuilderMaxRung = 'P1',
  touchesHighConsequence = false,
} = {}) {
  const allowedRungs = compositeBuilderMaxRung === 'P0' ? ['P0'] : ['P0', 'P1']
  const compositeAllowed =
    Boolean(oracleDigestPinned) && !touchesHighConsequence && allowedRungs.includes(rung)

  if (compositeAllowed) {
    return {
      compositeAllowed: true,
      rung,
      phases: [3, 4, 5],
      requiresSeparateQaSeat: false,
      localQaSubagentEffort: 'low',
      nextExternalHandoverPhase: 6,
      reason: 'oracle-pinned-p0-p1-composite-pass',
    }
  }

  return {
    compositeAllowed: false,
    rung,
    phases: [3, 4],
    requiresSeparateQaSeat: true,
    localQaSubagentEffort: 'low',
    nextExternalHandoverPhase: 5,
    reason: !oracleDigestPinned
      ? 'oracle-digest-not-pinned'
      : touchesHighConsequence
        ? 'high-consequence-requires-independent-qa-seat'
        : `rung-${rung}-requires-independent-qa-seat`,
  }
}
