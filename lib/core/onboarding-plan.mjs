import { recordDigest, hasCurrentDigest } from './record-digest.mjs'

export { recordDigest, hasCurrentDigest }

const WRITES = ['create', 'update', 'seed']

function previewOf(actions, projectPlan) {
  const create = []
  const change = []
  const remove = []
  const untouched = []
  for (const item of actions) {
    if (item.action === 'identical' || item.action === 'preserve') {
      untouched.push(item.target)
    } else if (item.action === 'remove') {
      remove.push(item.target)
    } else if (WRITES.includes(item.action)) {
      ;(item.beforeHash === null ? create : change).push(item.target)
    }
  }
  if (create.length || change.length) {
    const lockPath = 'agent-framework-lock.json'
    ;(projectPlan?.priorLockHash ? change : create).push(lockPath)
    if (projectPlan?.storage?.mode === 'project') {
      if (projectPlan.storage.ignoreContentBase64 !== null)
        (projectPlan.storage.ignoreBeforeHash ? change : create).push('.gitignore')
      if (!projectPlan.storage.transactionsIgnorePresent)
        create.push('.agentflow/transactions/.gitignore')
      create.push(
        '.agentflow/transactions/<transaction-id>/manifest.json',
        '.agentflow/transactions/<transaction-id>/receipt.json',
      )
    }
  }
  return {
    create: [...new Set(create)].sort(),
    change: [...new Set(change)].sort(),
    remove: [...new Set(remove)].sort(),
    untouched: [...new Set(untouched)].sort(),
  }
}

export function buildOnboardingPlan({
  inventory,
  runtime,
  projectPlan,
  choices = {},
  runtimeRequest,
  packageRoot,
  journey = 'adoption',
  report = null,
} = {}) {
  if (choices?.recoverUnknown !== undefined && typeof choices.recoverUnknown !== 'boolean') {
    throw new TypeError('recoverUnknown must be a boolean')
  }
  if (choices?.migrateLegacy !== undefined && typeof choices.migrateLegacy !== 'boolean') {
    throw new TypeError('migrateLegacy must be a boolean')
  }

  const options = {
    resolutions: choices?.resolutions ? { ...choices.resolutions } : {},
    config: choices?.config ? { ...choices.config } : {},
    migrateLegacy: Boolean(choices?.migrateLegacy),
    recoverUnknown: Boolean(choices?.recoverUnknown),
    ...(choices?.harness === false ? { harness: false } : {}),
    ...(choices?.deferUpdate ? { deferUpdate: true } : {}),
  }

  const missingChoices = []
  const blockers = []
  if (!projectPlan) blockers.push('Project transaction could not be planned; inspect diagnostics')

  if (inventory?.pendingJournal) {
    blockers.push('Pending journal requires recovery before onboarding')
  }
  if (inventory?.config?.status === 'invalid') {
    blockers.push('Config file is invalid or malformed')
  }

  if (inventory?.lock?.format === 'unknown') {
    if (!options.recoverUnknown) {
      missingChoices.push('recoverUnknown')
      blockers.push('Lockfile format is unknown or malformed')
    } else if (!projectPlan) {
      blockers.push('Lockfile format is unknown or malformed')
    }
  }

  if (inventory?.classification === 'legacy') {
    if (!options.migrateLegacy) {
      missingChoices.push('migrateLegacy')
      blockers.push('Legacy lockfile requires explicit migrateLegacy choice')
    }
  }

  const projectActions = projectPlan?.actions ? [...projectPlan.actions] : []
  const conflictTargets = new Set()

  if (Array.isArray(projectPlan?.conflicts)) {
    for (const target of projectPlan.conflicts) {
      conflictTargets.add(target)
    }
  }
  for (const action of projectActions) {
    if (action.action === 'conflict') {
      conflictTargets.add(action.target)
    }
  }

  for (const target of conflictTargets) {
    const resolution = options.resolutions[target]
    if (resolution !== 'preserve' && resolution !== 'replace') {
      missingChoices.push(`resolution:${target}`)
      blockers.push(`Unresolved project conflict for ${target}`)
    }
  }

  const hasLockBlocker = blockers.some((b) => b.includes('Lockfile'))
  const hasConfigBlocker = blockers.some((b) => b.includes('Config'))
  const lockRecovered = Boolean(
    options.recoverUnknown && projectPlan && inventory?.lock?.format === 'unknown',
  )

  if (
    inventory?.classification === 'unknown' &&
    !hasLockBlocker &&
    !hasConfigBlocker &&
    !lockRecovered
  ) {
    blockers.push('Project inventory classification is unknown')
  }

  const writes = projectActions.filter((a) => ['create', 'update', 'seed'].includes(a.action))
  if (options.deferUpdate && writes.some((a) => a.ownership === 'managed')) {
    blockers.push('Framework update deferred by choice; nothing is written until it is taken')
  }

  // Refinement changes only an adopted project's configuration. Anything else is adoption work.
  if (journey === 'refinement') {
    if (!Object.keys(options.config).length) {
      blockers.push('Refinement needs at least one setting to change')
    }
    if (inventory?.lock?.format !== 'v2' || inventory?.config?.status !== 'valid') {
      blockers.push('Refinement needs an adopted project with a valid configuration')
    }
    const other = writes.filter(
      (a) => !(a.target === 'agent-workflow.config.json' && a.ownership === 'seed-once'),
    )
    if (other.length) {
      blockers.push(
        `Refinement changes only the configuration; ${other.length} framework file(s) need the adoption journey first`,
      )
    }
  }

  missingChoices.sort()
  blockers.sort()

  const isProjectReady =
    blockers.length === 0 &&
    missingChoices.length === 0 &&
    Boolean(projectPlan && !projectPlan.blocked) &&
    !projectActions.some((a) => ['create', 'update', 'seed'].includes(a.action))

  const sharedRequests = Array.isArray(runtime?.proposals) ? [...runtime.proposals] : []

  const effectiveRuntimeRequest =
    runtimeRequest ??
    runtime?.request ??
    (runtime?.requestId ? { requestId: runtime.requestId, runtimeId: runtime.runtimeId } : null)

  const planPayload = {
    schemaVersion: 1,
    operation: 'onboarding',
    journey,
    target: inventory?.target ?? projectPlan?.target ?? null,
    rootIdentity: inventory?.rootIdentity ?? null,
    inventoryDigest: inventory ? recordDigest(inventory) : null,
    runtimeDigest: runtime ? recordDigest(runtime) : null,
    options,
    runtimeRequest: effectiveRuntimeRequest,
    changes: projectActions,
    sharedRequests,
    missingChoices,
    blockers,
    diagnostics: inventory?.diagnostics ?? [],
    readyToApply:
      blockers.length === 0 &&
      missingChoices.length === 0 &&
      Boolean(projectPlan && !projectPlan.blocked),
    readiness: {
      runtime: Boolean(runtime?.runtimeReady),
      project: isProjectReady,
      governedChange: false,
    },
    governedChangeExplanation: 'Needs issue contract and actual verification',
    projectPlan: projectPlan ?? null,
    packageRoot: packageRoot ?? null,
  }
  planPayload.preview = previewOf(projectActions, projectPlan)
  if (report) {
    planPayload.report = report({ ...planPayload, inventory, runtime, choices: options })
  }

  const digest = recordDigest(planPayload)

  return {
    ...planPayload,
    digest,
  }
}
