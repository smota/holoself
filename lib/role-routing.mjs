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
