import { inspectProject } from './project-reader.mjs'
import {
  planAdoption,
  applyAdoption,
  recoverAdoption,
  rollbackAdoption,
} from '../adoption/transaction.mjs'
import { assessRuntimeEvidence } from './runtime-handoff.mjs'
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

export function createLocalOnboardingService(overrides = {}) {
  return createOnboardingService({
    inspect: inspectProject,
    planProject: planAdoption,
    applyProject: applyAdoption,
    recoverProject: recoverAdoption,
    assessRuntime: assessRuntimeEvidence,
    ...overrides,
  })
}
