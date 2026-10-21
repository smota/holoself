import { inspectProject } from './project-reader.mjs'
import {
  planAdoption,
  applyAdoption,
  readAdoptionJournal,
  recoverAdoption,
  rollbackAdoption,
} from '../adoption/transaction.mjs'
import { planProjectAdoption } from '../init.mjs'
import { assessRuntimeEvidence } from './runtime-handoff.mjs'
import { buildReadinessReport } from './readiness-report.mjs'
import { createOnboardingService } from '../application/onboarding-service.mjs'

export {
  inspectProject,
  planAdoption,
  applyAdoption,
  recoverAdoption,
  rollbackAdoption,
  assessRuntimeEvidence,
}

export const inspect = inspectProject
export const planProject = planAdoption
export const applyProject = applyAdoption
export const recoverProject = recoverAdoption
export const rollbackProject = rollbackAdoption
export const assessRuntime = assessRuntimeEvidence

// The token an interrupted apply or undo needs before anything else may run on this project.
export function pendingRecoveryToken(targetDir) {
  try {
    return readAdoptionJournal(targetDir)?.recoveryToken ?? null
  } catch {
    return null
  }
}

export function localReadinessReport(input) {
  const recoveryToken = input?.inventory?.pendingJournal
    ? pendingRecoveryToken(input.targetDir)
    : null
  return buildReadinessReport({ ...input, recoveryToken })
}

// The local journey seeds what `init` seeds, keeps its transaction record in the project, and
// prints the readiness report at every step.
export function createLocalOnboardingService(overrides = {}) {
  return createOnboardingService({
    inspect: inspectProject,
    planProject: planProjectAdoption,
    applyProject: applyAdoption,
    recoverProject: recoverAdoption,
    assessRuntime: assessRuntimeEvidence,
    report: localReadinessReport,
    ...overrides,
  })
}
