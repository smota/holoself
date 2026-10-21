import { resolveDistribution } from './execution-distribution.mjs'
import { validateSteeringAgreementShape } from './steering-agreement.mjs'
import { validateQuotaControlPolicyShape } from './quota-policy.mjs'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { EXECUTION_TARGETS_BY_AGENT } from '../execution-targets.mjs'

export const CANONICAL_CONFIG_NAME = 'agentflow.config.json'

export const DOMAIN_CONFIG_FIELDS = [
  'authority',
  'principles',
  'vocabulary',
  'roles',
  'paths',
  'transitions',
  'labels',
  'release',
  'gateways',
  'actionPolicy',
  'extensionPolicy',
  'deliveryPolicy',
]

export const WORKFLOW_CONFIG_FIELDS = [
  'executionDistribution',
  'steering',
  'quotaControl',
  'ciCommands',
  'bounded',
  'branching',
  'integrationLifecycle',
  'routing',
  'collaboration',
  'executionTopology',
  'effortPolicy',
  'extensions',
  'providers',
  'sources',
  'adoption',
  'platformRegistry',
  'delivery',
]

export const PROJECTION_CONFIG_FIELDS = [
  'orchestration',
  'execution',
  'models',
  'harness',
  'adapters',
]

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function sorted(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  )
}

export function loadAuthoritativeConfigs(repoRoot = process.cwd()) {
  const root = resolve(repoRoot)
  const unifiedPath = resolve(root, CANONICAL_CONFIG_NAME)
  const projectDomainPath = resolve(root, 'sdlc.config.json')
  const defaultDomainPath = resolve(root, 'defaults', 'sdlc.config.json')
  const workflowPath = resolve(root, 'agent-workflow.config.json')

  if (existsSync(unifiedPath)) {
    const raw = readJson(unifiedPath)
    const domain = {}
    const workflow = {}
    for (const key of Object.keys(raw)) {
      if (DOMAIN_CONFIG_FIELDS.includes(key)) domain[key] = raw[key]
      else if (WORKFLOW_CONFIG_FIELDS.includes(key)) workflow[key] = raw[key]
    }
    if (raw.version) domain.version = raw.version

    return {
      isUnified: true,
      configPath: unifiedPath,
      unified: raw,
      domain,
      domainPath: unifiedPath,
      workflow,
      workflowPath: unifiedPath,
      orchestration: raw.orchestration ?? {},
      execution: raw.execution ?? {},
      models: raw.models ?? {},
      harness: raw.harness ?? {},
      adapters: raw.adapters ?? {},
    }
  }

  const domainPath = existsSync(projectDomainPath) ? projectDomainPath : defaultDomainPath
  const domain = existsSync(domainPath) ? readJson(domainPath) : {}
  const workflow = existsSync(workflowPath) ? readJson(workflowPath) : {}

  let orchestration =
    domain.orchestration ??
    workflow.orchestration ??
    domain.orchestrationModel ??
    workflow.orchestrationModel ??
    {}
  let execution =
    domain.execution ??
    workflow.execution ??
    domain.executionPolicy ??
    workflow.executionPolicy ??
    {}
  let models =
    domain.models ?? workflow.models ?? domain.modelCatalog ?? workflow.modelCatalog ?? {}
  let harness =
    domain.harness ??
    workflow.harness ??
    domain.harnessParameters ??
    workflow.harnessParameters ??
    {}
  let adapters = domain.adapters ?? workflow.adapters ?? {}

  const orchPath = resolve(root, '.agentflow', 'orchestration-model.json')
  if (Object.keys(orchestration).length === 0 && existsSync(orchPath)) {
    try {
      orchestration = readJson(orchPath)
    } catch {
      /* ignore */
    }
  }
  const execPath = resolve(root, '.agentflow', 'execution-policy.json')
  if (Object.keys(execution).length === 0 && existsSync(execPath)) {
    try {
      execution = readJson(execPath)
    } catch {
      /* ignore */
    }
  }
  const modPath = resolve(root, '.agentflow', 'model-catalog.json')
  if (Object.keys(models).length === 0 && existsSync(modPath)) {
    try {
      models = readJson(modPath)
    } catch {
      /* ignore */
    }
  }
  const harnPath = resolve(root, '.agentflow', 'harness-parameters.json')
  if (Object.keys(harness).length === 0 && existsSync(harnPath)) {
    try {
      harness = readJson(harnPath)
    } catch {
      /* ignore */
    }
  }

  return {
    isUnified: false,
    configPath: domainPath,
    domain,
    domainPath,
    workflow,
    workflowPath,
    orchestration,
    execution,
    models,
    harness,
    adapters,
  }
}

export function validateConfigAuthority({
  domain = {},
  workflow = {},
  isUnified = false,
  unified,
  models,
  routing,
  adapters,
} = {}) {
  const errors = []
  const warnings = []

  if (!isUnified && !unified) {
    for (const field of DOMAIN_CONFIG_FIELDS) {
      if (Object.hasOwn(workflow, field)) {
        errors.push(
          `agent-workflow.config.json duplicates domain field ${field}; move it to sdlc.config.json`,
        )
      }
    }
    for (const field of WORKFLOW_CONFIG_FIELDS) {
      if (Object.hasOwn(domain, field)) {
        warnings.push(
          `sdlc.config.json contains operational field ${field}; agent-workflow.config.json is authoritative`,
        )
      }
    }
  }

  const distribution = unified?.executionDistribution ?? workflow.executionDistribution
  if (distribution !== undefined) {
    try {
      resolveDistribution(distribution)
    } catch (error) {
      errors.push(error.message)
    }
  }

  const steering = unified?.steering ?? workflow.steering
  if (steering !== undefined) {
    const steeringShape = validateSteeringAgreementShape(steering)
    if (!steeringShape.ok) {
      errors.push(...steeringShape.errors)
    }
  }

  const quotaControl = unified?.quotaControl ?? workflow.quotaControl
  if (quotaControl !== undefined) {
    const quotaShape = validateQuotaControlPolicyShape(quotaControl)
    if (!quotaShape.ok) {
      errors.push(...quotaShape.errors)
    }
  }

  const effectiveAdapters = adapters ?? unified?.adapters ?? domain.adapters ?? workflow.adapters
  const policy = effectiveAdapters?.openrig?.executionPolicy
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  if (
    object(policy) &&
    policy.activation !== undefined &&
    !['active', 'held'].includes(policy.activation)
  )
    errors.push('adapters.openrig.executionPolicy.activation must be active or held')
  if (policy !== undefined) {
    if (!object(policy)) errors.push('adapters.openrig.executionPolicy must be an object')
    else if (policy.seats !== undefined) {
      if (!object(policy.seats))
        errors.push('adapters.openrig.executionPolicy.seats must be an object')
      else
        for (const [seat, tuple] of Object.entries(policy.seats)) {
          const prefix = `adapters.openrig.executionPolicy.seats.${seat}`
          if (!object(tuple)) {
            errors.push(`${prefix} must be an object`)
            continue
          }
          const fields = [
            'runtime',
            'executionTarget',
            'providerRoute',
            'providerFamily',
            'platform',
            'model',
            'effort',
            'profile',
            'capabilityTier',
          ]
          for (const field of Object.keys(tuple))
            if (!fields.includes(field)) errors.push(`${prefix}.${field} is unknown`)
          for (const field of fields) {
            if (
              tuple[field] !== undefined &&
              (typeof tuple[field] !== 'string' || !tuple[field].trim())
            )
              errors.push(`${prefix}.${field} must be a non-empty string`)
          }
          if (
            tuple.runtime !== undefined &&
            !['pi', 'codex', 'claude-code'].includes(tuple.runtime)
          )
            errors.push(`${prefix}.runtime must be pi, codex, or claude-code`)
          if (
            tuple.effort !== undefined &&
            !['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(
              tuple.effort,
            )
          )
            errors.push(`${prefix}.effort is invalid`)
        }
    }
  }

  const effectiveModels = models ?? unified?.models ?? domain.models ?? workflow.models
  if (effectiveModels) {
    const tiers = effectiveModels.tiers
    const assignments = effectiveModels.roleAssignments
    if (tiers && assignments) {
      const tierKeys = Object.keys(tiers)
      for (const [role, assignedTier] of Object.entries(assignments)) {
        if (!tierKeys.includes(assignedTier)) {
          errors.push(
            `Role assignment for "${role}" references undefined model tier "${assignedTier}"`,
          )
        }
      }
    }
  }

  const effectiveRouting = routing ?? unified?.routing ?? workflow.routing ?? domain.routing
  if (effectiveRouting?.agents) {
    for (const [agentSlug, agentConf] of Object.entries(effectiveRouting.agents)) {
      if (agentConf?.defaultExecutionTarget) {
        const allowedTargets = EXECUTION_TARGETS_BY_AGENT[agentSlug]
        if (allowedTargets && !allowedTargets.includes(agentConf.defaultExecutionTarget)) {
          errors.push(
            `Agent "${agentSlug}" specifies invalid execution target "${agentConf.defaultExecutionTarget}"; allowed targets: ${allowedTargets.join(', ')}`,
          )
        }
      }
    }
  }

  if (effectiveRouting?.aliases) {
    const aliases = effectiveRouting.aliases
    for (const [alias, target] of Object.entries(aliases)) {
      if (alias === target) {
        errors.push(`Conflicting alias: "${alias}" maps to itself`)
      } else if (aliases[target] === alias) {
        errors.push(`Conflicting circular alias detected between "${alias}" and "${target}"`)
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings }
}

export function resolveConfigAuthority(repoRoot = process.cwd()) {
  const loaded = loadAuthoritativeConfigs(repoRoot)
  return { ...loaded, validation: validateConfigAuthority(loaded) }
}

export function planAuthorityMigration(repoRoot = process.cwd()) {
  const root = resolve(repoRoot)
  const loaded = loadAuthoritativeConfigs(root)
  const domain = { ...loaded.domain }
  const workflow = { ...loaded.workflow }
  const diagnostics = []
  for (const field of DOMAIN_CONFIG_FIELDS) {
    if (!Object.hasOwn(workflow, field)) continue
    if (!Object.hasOwn(domain, field)) domain[field] = workflow[field]
    diagnostics.push(
      Object.hasOwn(loaded.domain, field)
        ? `${field}: kept sdlc.config.json value and removed legacy workflow duplicate`
        : `${field}: moved legacy workflow value to sdlc.config.json`,
    )
    delete workflow[field]
  }
  for (const field of WORKFLOW_CONFIG_FIELDS) {
    if (!Object.hasOwn(domain, field)) continue
    if (!Object.hasOwn(workflow, field)) workflow[field] = domain[field]
    diagnostics.push(
      Object.hasOwn(loaded.workflow, field)
        ? `${field}: kept agent-workflow.config.json value and removed legacy domain duplicate`
        : `${field}: moved legacy domain value to agent-workflow.config.json`,
    )
    delete domain[field]
  }
  const targetDomainPath = resolve(root, 'sdlc.config.json')
  const base = {
    version: 1,
    root,
    targetDomainPath,
    workflowPath: loaded.workflowPath,
    before: { domain: sorted(loaded.domain), workflow: sorted(loaded.workflow) },
    after: { domain: sorted(domain), workflow: sorted(workflow) },
    diagnostics,
  }
  return { ...base, changed: digest(base.before) !== digest(base.after), token: digest(base) }
}

function replaceJson(path, value, backups) {
  const id = randomUUID()
  const staged = `${path}.agentflow-${id}.tmp`
  const backup = `${path}.agentflow-${id}.bak`
  writeFileSync(staged, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
  if (existsSync(path)) renameSync(path, backup)
  try {
    renameSync(staged, path)
    backups.push({ path, backup: existsSync(backup) ? backup : null })
  } catch (error) {
    if (existsSync(staged)) unlinkSync(staged)
    if (!existsSync(path) && existsSync(backup)) renameSync(backup, path)
    throw error
  }
}

export function applyAuthorityMigration(repoRoot, plan, { confirm } = {}) {
  const { token, changed, ...base } = plan ?? {}
  if (confirm !== token || digest(base) !== token) {
    throw new Error('Authority migration confirmation or plan digest is invalid')
  }
  const current = planAuthorityMigration(repoRoot)
  if (current.token !== token) throw new Error('Authority migration plan is stale')
  if (!changed) return { version: 1, status: 'unchanged', planToken: token }
  const backups = []
  try {
    replaceJson(plan.targetDomainPath, plan.after.domain, backups)
    replaceJson(plan.workflowPath, plan.after.workflow, backups)
    for (const item of backups) if (item.backup && existsSync(item.backup)) unlinkSync(item.backup)
  } catch (error) {
    for (const item of backups.reverse()) {
      if (existsSync(item.path)) unlinkSync(item.path)
      if (item.backup && existsSync(item.backup)) renameSync(item.backup, item.path)
    }
    throw error
  }
  return { version: 1, status: 'applied', planToken: token }
}

export function planAuthorityConsolidation(repoRoot = process.cwd()) {
  const root = resolve(repoRoot)
  const loaded = loadAuthoritativeConfigs(root)
  const targetPath = resolve(root, CANONICAL_CONFIG_NAME)

  const consolidated = {
    $schema: './schemas/agentflow-config.schema.json',
    version: 1,
  }

  for (const field of DOMAIN_CONFIG_FIELDS) {
    if (loaded.domain && Object.hasOwn(loaded.domain, field)) {
      consolidated[field] = loaded.domain[field]
    }
  }

  for (const field of WORKFLOW_CONFIG_FIELDS) {
    if (loaded.workflow && Object.hasOwn(loaded.workflow, field)) {
      consolidated[field] = loaded.workflow[field]
    }
  }

  if (loaded.orchestration && Object.keys(loaded.orchestration).length > 0) {
    consolidated.orchestration = loaded.orchestration
  }
  if (loaded.execution && Object.keys(loaded.execution).length > 0) {
    consolidated.execution = loaded.execution
  }
  if (loaded.models && Object.keys(loaded.models).length > 0) {
    consolidated.models = loaded.models
  }
  if (loaded.harness && Object.keys(loaded.harness).length > 0) {
    consolidated.harness = loaded.harness
  }
  if (loaded.adapters && Object.keys(loaded.adapters).length > 0) {
    consolidated.adapters = loaded.adapters
  }

  const existingUnified = existsSync(targetPath) ? readJson(targetPath) : null
  const base = {
    version: 1,
    root,
    targetPath,
    before: existingUnified ? sorted(existingUnified) : null,
    after: sorted(consolidated),
  }
  const changed = !base.before || digest(base.before) !== digest(base.after)

  return { ...base, changed, token: digest(base) }
}

export function applyAuthorityConsolidation(repoRoot, plan, { confirm } = {}) {
  const { token, changed, ...base } = plan ?? {}
  if (confirm !== token || digest(base) !== token) {
    throw new Error('Authority consolidation confirmation or plan digest is invalid')
  }
  const current = planAuthorityConsolidation(repoRoot)
  if (current.token !== token) throw new Error('Authority consolidation plan is stale')
  if (!changed) return { version: 1, status: 'unchanged', planToken: token }

  const backups = []
  try {
    replaceJson(plan.targetPath, plan.after, backups)
    for (const item of backups) {
      if (item.backup && existsSync(item.backup)) unlinkSync(item.backup)
    }
  } catch (error) {
    for (const item of backups.reverse()) {
      if (existsSync(item.path)) unlinkSync(item.path)
      if (item.backup && existsSync(item.backup)) renameSync(item.backup, item.path)
    }
    throw error
  }
  return { version: 1, status: 'applied', planToken: token, targetPath: plan.targetPath }
}
