import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

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
  'ciCommands',
  'bounded',
  'branching',
  'integrationLifecycle',
  'routing',
  'extensions',
  'providers',
  'sources',
  'adoption',
  'platformRegistry',
  'delivery',
]

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function sorted(value) {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  )
}

export function loadAuthoritativeConfigs(repoRoot = process.cwd()) {
  const projectDomainPath = resolve(repoRoot, 'sdlc.config.json')
  const defaultDomainPath = resolve(repoRoot, 'defaults', 'sdlc.config.json')
  const workflowPath = resolve(repoRoot, 'agent-workflow.config.json')
  const domainPath = existsSync(projectDomainPath) ? projectDomainPath : defaultDomainPath
  return {
    domain: existsSync(domainPath) ? readJson(domainPath) : {},
    domainPath,
    workflow: existsSync(workflowPath) ? readJson(workflowPath) : {},
    workflowPath,
  }
}

export function validateConfigAuthority({ domain = {}, workflow = {} } = {}) {
  const errors = []
  const warnings = []
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
