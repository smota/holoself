import { buildOnboardingPlan, recordDigest, hasCurrentDigest } from '../core/onboarding-plan.mjs'

export function createOnboardingService({
  inspect,
  planProject,
  applyProject,
  recoverProject,
  assessRuntime,
} = {}) {
  if (!inspect || typeof inspect !== 'function') {
    throw new TypeError('inspect port is required')
  }
  if (!planProject || typeof planProject !== 'function') {
    throw new TypeError('planProject port is required')
  }
  if (!applyProject || typeof applyProject !== 'function') {
    throw new TypeError('applyProject port is required')
  }
  if (!recoverProject || typeof recoverProject !== 'function') {
    throw new TypeError('recoverProject port is required')
  }

  const service = {
    inspect(input) {
      const {
        packageRoot,
        targetDir,
        profile = 'standard',
        runtimeRequest,
        runtimeEvidence,
      } = input ?? {}

      const inventory = inspect(packageRoot, targetDir, { profile })
      let runtime = null
      if (runtimeRequest && runtimeEvidence) {
        runtime = assessRuntime(runtimeRequest, runtimeEvidence)
      }
      return { inventory, runtime }
    },

    plan(input) {
      const {
        packageRoot,
        targetDir,
        profile = 'standard',
        runtimeRequest,
        runtimeEvidence,
        choices = {},
      } = input ?? {}

      if (choices?.recoverUnknown !== undefined && typeof choices.recoverUnknown !== 'boolean') {
        throw new TypeError('recoverUnknown must be a boolean')
      }
      if (choices?.migrateLegacy !== undefined && typeof choices.migrateLegacy !== 'boolean') {
        throw new TypeError('migrateLegacy must be a boolean')
      }

      const inventory = inspect(packageRoot, targetDir, { profile })
      let runtime = null
      if (runtimeRequest && runtimeEvidence) {
        runtime = assessRuntime(runtimeRequest, runtimeEvidence)
      }

      let projectPlan = null
      const diagnostics = [...(inventory?.diagnostics || [])]

      const planOptions = {
        profile,
        resolutions: choices?.resolutions ?? {},
        seedValues:
          choices?.config && Object.keys(choices.config).length
            ? { 'agent-workflow.config.json': choices.config }
            : undefined,
        migrateLegacy: Boolean(choices?.migrateLegacy),
        recoverUnknown: Boolean(choices?.recoverUnknown),
      }

      try {
        projectPlan = planProject(packageRoot, targetDir, planOptions)
      } catch (err) {
        diagnostics.push(err.message)
      }

      const effectiveInventory = inventory ? { ...inventory, diagnostics } : { diagnostics }

      return buildOnboardingPlan({
        inventory: effectiveInventory,
        runtime,
        projectPlan,
        choices,
        runtimeRequest,
        packageRoot,
      })
    },

    apply(plan, applyOptions = {}) {
      const { confirm, runtimeEvidence, ...restOptions } = applyOptions

      if (!plan || !hasCurrentDigest(plan)) {
        throw new Error('Invalid or corrupted plan: digest check failed')
      }

      if (confirm !== plan.digest) {
        throw new Error(`Confirmation token mismatch: expected ${plan.digest}, received ${confirm}`)
      }

      if (plan.blockers && plan.blockers.length > 0) {
        throw new Error(`Cannot apply plan with blockers: ${plan.blockers.join('; ')}`)
      }

      if (plan.missingChoices && plan.missingChoices.length > 0) {
        throw new Error(`Cannot apply plan with missing choices: ${plan.missingChoices.join('; ')}`)
      }

      if (plan.projectPlan?.blocked) {
        throw new Error('Cannot apply blocked project plan')
      }

      const targetDir = restOptions.targetDir ?? plan.target
      const packageRoot = restOptions.packageRoot ?? plan.packageRoot

      if (!targetDir) {
        throw new Error('targetDir is required to apply onboarding plan')
      }
      if (!packageRoot) {
        throw new Error('packageRoot is required to apply onboarding plan')
      }

      const profile = plan.projectPlan?.profile ?? restOptions.profile ?? 'standard'
      const freshInventory = inspect(packageRoot, targetDir, { profile })

      if (
        plan.rootIdentity &&
        freshInventory?.rootIdentity &&
        (plan.rootIdentity.dev !== freshInventory.rootIdentity.dev ||
          plan.rootIdentity.ino !== freshInventory.rootIdentity.ino)
      ) {
        throw new Error('Target root identity drifted; replan required')
      }

      const freshInventoryDigest = freshInventory ? recordDigest(freshInventory) : null
      if (plan.inventoryDigest && freshInventoryDigest !== plan.inventoryDigest) {
        throw new Error('Project inventory drifted since plan creation; replan required')
      }

      const effectiveEvidence = runtimeEvidence ?? restOptions.runtimeEvidence
      let freshRuntime = null
      if (plan.runtimeRequest && effectiveEvidence) {
        freshRuntime = assessRuntime(plan.runtimeRequest, effectiveEvidence)
        const freshRuntimeDigest = freshRuntime ? recordDigest(freshRuntime) : null
        if (plan.runtimeDigest && freshRuntimeDigest !== plan.runtimeDigest) {
          throw new Error('Runtime evidence drifted since plan creation; replan required')
        }
      } else if (plan.runtimeDigest) {
        throw new Error('Runtime evidence is missing or drifted; replan required')
      }

      const planOptions = {
        profile,
        resolutions: plan.options?.resolutions,
        seedValues:
          plan.options?.config && Object.keys(plan.options.config).length
            ? { 'agent-workflow.config.json': plan.options.config }
            : undefined,
        migrateLegacy: plan.options?.migrateLegacy,
        recoverUnknown: plan.options?.recoverUnknown,
      }

      const freshProjectPlan = planProject(packageRoot, targetDir, planOptions)
      const freshOnboardingPlan = buildOnboardingPlan({
        inventory: freshInventory,
        runtime: freshRuntime,
        projectPlan: freshProjectPlan,
        choices: plan.options,
        runtimeRequest: plan.runtimeRequest,
        packageRoot,
      })

      if (freshOnboardingPlan.digest !== plan.digest) {
        throw new Error('Onboarding plan content drifted from fresh recomputation; replan required')
      }

      const projectConfirm = plan.projectPlan?.token ?? confirm
      return applyProject(packageRoot, targetDir, plan.projectPlan, {
        confirm: projectConfirm,
        ...restOptions,
      })
    },

    verify(input) {
      const {
        packageRoot,
        targetDir,
        profile = 'standard',
        runtimeRequest,
        runtimeEvidence,
        choices = {},
      } = input ?? {}

      if (choices?.recoverUnknown !== undefined && typeof choices.recoverUnknown !== 'boolean') {
        throw new TypeError('recoverUnknown must be a boolean')
      }
      if (choices?.migrateLegacy !== undefined && typeof choices.migrateLegacy !== 'boolean') {
        throw new TypeError('migrateLegacy must be a boolean')
      }

      const inventory = inspect(packageRoot, targetDir, { profile })
      let runtime = null
      if (runtimeRequest && runtimeEvidence) {
        runtime = assessRuntime(runtimeRequest, runtimeEvidence)
      }

      let projectPlan = null
      let planError = null

      try {
        projectPlan = planProject(packageRoot, targetDir, {
          profile,
          resolutions: choices?.resolutions,
          seedValues: choices?.config
            ? { 'agent-workflow.config.json': choices.config }
            : undefined,
          migrateLegacy: Boolean(choices?.migrateLegacy),
          recoverUnknown: Boolean(choices?.recoverUnknown),
        })
      } catch (err) {
        planError = err
      }

      const diagnostics = [...(inventory?.diagnostics || [])]
      if (planError) {
        diagnostics.push(planError.message)
      }
      const effectiveInventory = inventory ? { ...inventory, diagnostics } : { diagnostics }

      const hasPendingJournal = Boolean(inventory?.pendingJournal)
      const hasConflicts = Boolean(
        projectPlan?.blocked || (projectPlan?.conflicts && projectPlan.conflicts.length > 0),
      )
      const hasPendingMutations = projectPlan?.actions
        ? projectPlan.actions.some((a) => ['create', 'update', 'seed'].includes(a.action))
        : true

      const projectReady = Boolean(
        inventory?.lock?.format === 'v2' &&
        !hasPendingJournal &&
        !planError &&
        projectPlan &&
        !hasConflicts &&
        !hasPendingMutations &&
        inventory?.classification !== 'conflicting' &&
        inventory?.classification !== 'unknown',
      )

      return {
        projectReady,
        runtimeReady: Boolean(runtime?.runtimeReady),
        governedChangeReady: false,
        explanation: 'Needs issue contract and actual verification',
        inventory: effectiveInventory,
        runtime,
        projectPlan,
        planError: planError?.message ?? null,
      }
    },

    recover(input, options = {}) {
      const { targetDir } = input ?? {}
      if (!targetDir) {
        throw new Error('targetDir is required for recovery')
      }

      const recovery = recoverProject(targetDir, { confirm: options?.confirm })
      const freshPlan = service.plan(input)

      return {
        recovery,
        plan: freshPlan,
      }
    },
  }

  return service
}
