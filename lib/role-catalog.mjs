import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateArtifactRefs } from './core/artifact-ref.mjs'
import { validateAcceptanceContract } from './core/role-collaboration.mjs'
import { recordDigest } from './core/record-digest.mjs'

const ROLE_ID = /^agentflow:[a-z0-9]+(?:-[a-z0-9]+)*$/
const METHOD_ID = /^[a-z0-9.-]+:method:[a-z0-9]+(?:-[a-z0-9]+)*$/
const BOUNDARIES = ['observe', 'propose', 'mutate-worktree', 'open-pr', 'external-action']
const REQUIRED_ROLE_HEADINGS = [
  'Purpose',
  'Scope',
  'Behavior',
  'Authority',
  'Completion',
  'Handoffs',
  'Extensions',
]

export function loadRoleCatalog(packageRoot = process.cwd()) {
  return JSON.parse(readFileSync(join(packageRoot, 'manifests', 'role-catalog.json'), 'utf8'))
}

export function loadMethodCatalog(packageRoot = process.cwd()) {
  return JSON.parse(readFileSync(join(packageRoot, 'manifests', 'method-catalog.json'), 'utf8'))
}

export function canonicalRoleIdentity(value, catalog) {
  const input = String(value ?? '')
    .trim()
    .toLowerCase()
  if (!input) return null
  const qualified = ROLE_ID.test(input) ? input : `${catalog.namespace}:${input}`
  return catalog.roles.some((role) => role.qualifiedName === qualified) ? qualified : null
}

export function roleByIdentity(value, catalog) {
  const identity = canonicalRoleIdentity(value, catalog)
  return identity ? catalog.roles.find((role) => role.qualifiedName === identity) : null
}

export function validateRoleCatalog({ packageRoot = process.cwd(), catalog, methodCatalog } = {}) {
  const findings = []
  try {
    catalog ??= loadRoleCatalog(packageRoot)
    methodCatalog ??= loadMethodCatalog(packageRoot)
  } catch (error) {
    return report([finding('blocker', 'role-catalog.read', error.message)])
  }

  if (catalog.version !== 1)
    findings.push(finding('blocker', 'role-catalog.version', 'version must be 1'))
  if (catalog.namespace !== 'agentflow')
    findings.push(finding('blocker', 'role-catalog.namespace', 'namespace must be agentflow'))
  if (!Array.isArray(catalog.roles) || !catalog.roles.length)
    findings.push(finding('blocker', 'role-catalog.roles', 'at least one role is required'))

  const identities = new Set()
  const slugs = new Set()
  const phases = new Set()
  const ownership = new Map()
  for (const role of catalog.roles ?? []) {
    if (!ROLE_ID.test(role.qualifiedName ?? ''))
      findings.push(
        finding('blocker', 'role.identity', `invalid role identity ${role.qualifiedName ?? ''}`),
      )
    if (role.qualifiedName !== `${catalog.namespace}:${role.slug}`)
      findings.push(
        finding('blocker', 'role.identity', `${role.slug} must use agentflow:${role.slug}`),
      )
    if (identities.has(role.qualifiedName))
      findings.push(finding('blocker', 'role.identity', `duplicate role ${role.qualifiedName}`))
    if (slugs.has(role.slug))
      findings.push(finding('blocker', 'role.slug', `duplicate slug ${role.slug}`))
    identities.add(role.qualifiedName)
    slugs.add(role.slug)

    if (role.kind === 'lifecycle') {
      if (!Number.isInteger(role.phase) || role.phase < 0)
        findings.push(
          finding('blocker', 'role.phase', `${role.qualifiedName} needs a non-negative phase`),
        )
      else if (phases.has(role.phase))
        findings.push(finding('blocker', 'role.phase', `duplicate lifecycle phase ${role.phase}`))
      else phases.add(role.phase)
    } else if (role.kind === 'sidecar') {
      if (role.phase !== null)
        findings.push(
          finding('high', 'role.phase', `${role.qualifiedName} sidecar phase must be null`),
        )
    } else findings.push(finding('blocker', 'role.kind', `invalid kind for ${role.qualifiedName}`))

    for (const area of role.owns ?? []) {
      if (ownership.has(area))
        findings.push(
          finding(
            'blocker',
            'role.ownership-overlap',
            `${area} is owned by ${ownership.get(area)} and ${role.qualifiedName}`,
          ),
        )
      ownership.set(area, role.qualifiedName)
    }
    for (const area of role.doesNotOwn ?? []) {
      if ((role.owns ?? []).includes(area))
        findings.push(
          finding(
            'blocker',
            'role.scope-conflict',
            `${role.qualifiedName} owns and excludes ${area}`,
          ),
        )
    }
    validateAuthority(role, findings)
    validateRolePackage(packageRoot, role, findings)
  }

  const lifecycleRoles = (catalog.roles ?? []).filter((role) => role.kind === 'lifecycle')
  if (lifecycleRoles.length !== 9)
    findings.push(
      finding(
        'blocker',
        'role.lifecycle-count',
        `expected 9 lifecycle roles, found ${lifecycleRoles.length}`,
      ),
    )
  if ([...phases].sort((a, b) => a - b).join(',') !== '0,1,2,3,4,5,6,7,8')
    findings.push(
      finding(
        'blocker',
        'role.phase-sequence',
        'lifecycle phases must be contiguous from 0 through 8',
      ),
    )

  const transitionKeys = new Set()
  for (const pair of catalog.transitions ?? []) {
    if (!Array.isArray(pair) || pair.length !== 2 || pair.some((role) => !identities.has(role))) {
      findings.push(
        finding('blocker', 'role.transition', `invalid transition ${JSON.stringify(pair)}`),
      )
      continue
    }
    const key = pair.join('->')
    if (transitionKeys.has(key))
      findings.push(finding('high', 'role.transition', `duplicate transition ${key}`))
    transitionKeys.add(key)
    const [from, to] = pair
    if (!roleByIdentity(from, catalog)?.sendsTo?.includes(to))
      findings.push(
        finding(
          'high',
          'role.handoff-contract',
          `${from} transition does not declare sendsTo ${to}`,
        ),
      )
    if (!roleByIdentity(to, catalog)?.acceptsFrom?.includes(from))
      findings.push(
        finding(
          'high',
          'role.handoff-contract',
          `${to} transition does not declare acceptsFrom ${from}`,
        ),
      )
  }

  const sidecarKeys = new Set()
  for (const link of catalog.sidecarLinks ?? []) {
    if (!identities.has(link.from) || !identities.has(link.to) || !link.artifact)
      findings.push(
        finding('blocker', 'role.sidecar-link', `invalid sidecar link ${JSON.stringify(link)}`),
      )
    sidecarKeys.add(`${link.from}->${link.to}`)
  }

  findings.push(...validateMethodCatalog({ catalog, methodCatalog }).findings)
  return report(findings, { catalog, methodCatalog, transitionKeys, sidecarKeys })
}

export function validateMethodCatalog({ catalog, methodCatalog }) {
  const findings = []
  if (methodCatalog.version !== 1)
    findings.push(finding('blocker', 'method-catalog.version', 'version must be 1'))
  const methods = new Set()
  for (const method of methodCatalog.methods ?? []) {
    if (!METHOD_ID.test(method.id ?? ''))
      findings.push(
        finding('blocker', 'method.identity', `invalid method identity ${method.id ?? ''}`),
      )
    if (methods.has(method.id))
      findings.push(finding('blocker', 'method.identity', `duplicate method ${method.id}`))
    methods.add(method.id)
    if (!roleByIdentity(method.role, catalog))
      findings.push(
        finding('blocker', 'method.role', `${method.id} targets unknown role ${method.role}`),
      )
    for (const [name, parameter] of Object.entries(method.parameters ?? {})) {
      const error = validateParameter(name, parameter.default, parameter)
      if (error)
        findings.push(finding('blocker', 'method.parameter-default', `${method.id}: ${error}`))
    }
    for (const forbidden of ['owns', 'transitions', 'authority', 'completionCriteria']) {
      if (method.adds?.[forbidden] !== undefined)
        findings.push(
          finding('blocker', 'method.invariant', `${method.id} cannot add ${forbidden}`),
        )
    }
  }
  return report(findings, { methodCatalog })
}

export function validateRoleMethodConfig({
  config = {},
  packageRoot = process.cwd(),
  catalog = loadRoleCatalog(packageRoot),
  methodCatalog = loadMethodCatalog(packageRoot),
} = {}) {
  const findings = []
  if (config.roleMethods === undefined) return report(findings)
  const bindings = config.roleMethods?.bindings ?? config.roleMethods
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) {
    return report([
      finding(
        'blocker',
        'role-methods.config',
        'roleMethods must be an object or contain an object-valued bindings field',
      ),
    ])
  }
  for (const [role, roleBindings] of Object.entries(bindings)) {
    if (!Array.isArray(roleBindings)) {
      findings.push(
        finding(
          'blocker',
          'role-methods.binding',
          `roleMethods binding for ${role} must be an array`,
        ),
      )
      continue
    }
    try {
      resolveRoleContract({
        role,
        config: { roleMethods: { bindings: { [role]: roleBindings } } },
        packageRoot,
        catalog,
        methodCatalog,
      })
    } catch (error) {
      findings.push(finding('blocker', 'role-methods.binding', `${role}: ${error.message}`))
    }
  }
  return report(findings)
}

export function resolveRoleContract({
  role,
  config = {},
  packageRoot = process.cwd(),
  catalog = loadRoleCatalog(packageRoot),
  methodCatalog = loadMethodCatalog(packageRoot),
} = {}) {
  const base = roleByIdentity(role, catalog)
  if (!base) throw new Error(`Unknown role: ${role ?? ''}`)
  const bindings = bindingsFor(base, config)
  const effective = structuredClone(base)
  const appliedMethods = []
  const evidenceFields = []
  for (const binding of bindings) {
    const methodId = typeof binding === 'string' ? binding : binding.method
    const parameters = typeof binding === 'string' ? {} : (binding.parameters ?? {})
    const method = methodCatalog.methods.find((item) => item.id === methodId)
    if (!method) throw new Error(`Unknown method: ${methodId}`)
    if (method.role !== base.qualifiedName)
      throw new Error(`${methodId} applies to ${method.role}, not ${base.qualifiedName}`)
    const resolvedParameters = resolveParameters(method, parameters)
    effective.inputs = unique([...effective.inputs, ...(method.adds.inputs ?? [])])
    effective.outputs = unique([...effective.outputs, ...(method.adds.outputs ?? [])])
    effective.behavior.steps = unique([
      ...effective.behavior.steps,
      ...(method.adds.behaviorSteps ?? []),
    ])
    evidenceFields.push(...(method.adds.evidenceFields ?? []))
    appliedMethods.push({ id: method.id, parameters: resolvedParameters })
  }
  return {
    version: 1,
    role: effective,
    appliedMethods,
    evidenceFields: unique(evidenceFields),
    invariants: catalog.invariants,
  }
}

export function roleHandoffDigest(handoff) {
  return recordDigest(handoff)
}

export function createRoleHandoff(value) {
  const handoff = { version: 1, ...structuredClone(value), digest: '' }
  handoff.digest = roleHandoffDigest(handoff)
  return handoff
}

export function validateRoleHandoff({
  handoff,
  packageRoot = process.cwd(),
  catalog = loadRoleCatalog(packageRoot),
  config = {},
} = {}) {
  const findings = []
  if (handoff?.version !== 1)
    findings.push(finding('blocker', 'handoff.version', 'version must be 1'))
  for (const field of ['id', 'subject', 'rolePassId', 'profile', 'expectedAction']) {
    if (typeof handoff?.[field] !== 'string' || !handoff[field].trim())
      findings.push(finding('blocker', `handoff.${field}`, `${field} is required`))
  }
  const from = canonicalRoleIdentity(handoff?.fromRole, catalog)
  const to = canonicalRoleIdentity(handoff?.toRole, catalog)
  if (!from) findings.push(finding('blocker', 'handoff.from-role', 'fromRole is unknown'))
  if (!to) findings.push(finding('blocker', 'handoff.to-role', 'toRole is unknown'))
  const key = from && to ? `${from}->${to}` : ''
  const allowed = (catalog.transitions ?? []).some((pair) => pair.join('->') === key)
  const sidecar = (catalog.sidecarLinks ?? []).some((link) => `${link.from}->${link.to}` === key)
  if (from && to && !allowed && !sidecar)
    findings.push(finding('blocker', 'handoff.transition', `${key} is not an allowed handoff`))
  if (!['issued', 'superseded'].includes(handoff?.state))
    findings.push(finding('blocker', 'handoff.state', `invalid state ${handoff?.state ?? ''}`))
  for (const field of [
    'inputRefs',
    'outputRefs',
    'validationRefs',
    'acceptanceCriteria',
    'openQuestions',
    'methodPlays',
  ]) {
    if (!Array.isArray(handoff?.[field]))
      findings.push(finding('blocker', `handoff.${field}`, `${field} must be an array`))
  }
  for (const field of ['inputRefs', 'outputRefs', 'validationRefs']) {
    const refs = validateArtifactRefs(Array.isArray(handoff?.[field]) ? handoff[field] : [], config)
    for (const error of refs.errors) {
      findings.push(finding('blocker', `handoff.${field}`, error))
    }
    for (const warning of refs.warnings) {
      findings.push(finding('medium', `handoff.${field}`, warning))
    }
  }
  if (!BOUNDARIES.includes(handoff?.actionBoundary))
    findings.push(finding('blocker', 'handoff.action-boundary', 'actionBoundary is invalid'))
  const sender = from && roleByIdentity(from, catalog)
  if (
    sender &&
    BOUNDARIES.indexOf(handoff.actionBoundary) >
      BOUNDARIES.indexOf(sender.authority.maximumBoundary)
  )
    findings.push(
      finding('blocker', 'handoff.authority', 'handoff exceeds the sender maximum authority'),
    )
  if (!(handoff?.acceptanceCriteria ?? []).length)
    findings.push(finding('blocker', 'handoff.acceptance', 'acceptanceCriteria cannot be empty'))
  const contract = validateAcceptanceContract(handoff?.acceptanceContract)
  for (const error of contract.errors) {
    findings.push(finding('blocker', 'handoff.acceptance-contract', error))
  }
  if (handoff?.acceptanceContract?.ownerRole !== from) {
    findings.push(
      finding('blocker', 'handoff.acceptance-owner', 'acceptance owner must be the sending role'),
    )
  }
  if (handoff?.acceptanceContract?.deliveryRole !== to) {
    findings.push(
      finding('blocker', 'handoff.delivery-role', 'delivery role must be the receiving role'),
    )
  }
  if (!handoff?.provenance || typeof handoff.provenance !== 'object')
    findings.push(finding('blocker', 'handoff.provenance', 'provenance is required'))
  else
    for (const field of ['platform', 'executor', 'transport', 'delegationBoundary']) {
      if (typeof handoff.provenance[field] !== 'string' || !handoff.provenance[field].trim())
        findings.push(finding('blocker', `handoff.provenance.${field}`, `${field} is required`))
    }
  if (
    !/^[a-f0-9]{64}$/.test(handoff?.digest ?? '') ||
    roleHandoffDigest(handoff) !== handoff.digest
  )
    findings.push(finding('blocker', 'handoff.digest', 'handoff digest is missing or stale'))
  return report(findings, { handoff })
}

function validateAuthority(role, findings) {
  const current = BOUNDARIES.indexOf(role.authority?.defaultBoundary)
  const maximum = BOUNDARIES.indexOf(role.authority?.maximumBoundary)
  if (current < 0 || maximum < 0 || current > maximum)
    findings.push(
      finding('blocker', 'role.authority', `${role.qualifiedName} has invalid authority bounds`),
    )
  if (
    maximum <= BOUNDARIES.indexOf('observe') &&
    !(role.authority?.mutationScopes ?? []).includes('none')
  )
    findings.push(
      finding(
        'high',
        'role.authority',
        `${role.qualifiedName} is read-only but has mutation scopes`,
      ),
    )
}

function validateRolePackage(packageRoot, role, findings) {
  if (role.source !== `roles/${role.slug}`)
    findings.push(
      finding('high', 'role.source', `${role.qualifiedName} source must be roles/${role.slug}`),
    )
  const roleFile = join(packageRoot, role.source ?? '', 'ROLE.md')
  if (!existsSync(roleFile)) {
    findings.push(finding('blocker', 'role.package', `missing ${role.source}/ROLE.md`))
    return
  }
  const text = readFileSync(roleFile, 'utf8')
  if (!text.includes(`Qualified identity: \`${role.qualifiedName}\``))
    findings.push(
      finding(
        'high',
        'role.package-identity',
        `${role.source}/ROLE.md lacks its qualified identity`,
      ),
    )
  for (const heading of REQUIRED_ROLE_HEADINGS) {
    if (!new RegExp(`^## ${heading}$`, 'm').test(text))
      findings.push(
        finding('high', 'role.package-style', `${role.source}/ROLE.md is missing ## ${heading}`),
      )
  }
}

function bindingsFor(role, config) {
  const bindings = config.roleMethods?.bindings ?? config.roleMethods ?? {}
  return bindings[role.qualifiedName] ?? bindings[role.slug] ?? []
}

function resolveParameters(method, supplied) {
  for (const key of Object.keys(supplied)) {
    if (!method.parameters[key]) throw new Error(`${method.id} does not define parameter ${key}`)
  }
  const result = {}
  for (const [name, definition] of Object.entries(method.parameters ?? {})) {
    const value = supplied[name] ?? definition.default
    const error = validateParameter(name, value, definition)
    if (error) throw new Error(`${method.id}: ${error}`)
    result[name] = value
  }
  return result
}

function validateParameter(name, value, definition) {
  if (definition.type === 'integer' && !Number.isInteger(value)) return `${name} must be an integer`
  if (definition.type === 'number' && typeof value !== 'number') return `${name} must be a number`
  if (definition.type === 'string' && typeof value !== 'string') return `${name} must be a string`
  if (definition.type === 'boolean' && typeof value !== 'boolean')
    return `${name} must be a boolean`
  if (definition.enum && !definition.enum.includes(value))
    return `${name} must be one of ${definition.enum.join(', ')}`
  if (definition.minimum !== undefined && value < definition.minimum)
    return `${name} must be at least ${definition.minimum}`
  return null
}

function unique(values) {
  return [...new Set(values)]
}

function finding(severity, code, message) {
  return { severity, code, message }
}

function report(findings, extra = {}) {
  return {
    ok: findings.every((item) => !['blocker', 'high'].includes(item.severity)),
    findings,
    ...extra,
  }
}
