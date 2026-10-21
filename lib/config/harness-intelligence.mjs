import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  DEFAULT_ORCHESTRATION_MODEL,
  DEFAULT_EXECUTION_POLICY,
  DEFAULT_MODEL_CATALOG,
  DEFAULT_HARNESS_PARAMETERS,
} from './harness-defaults.mjs'
export {
  DEFAULT_ORCHESTRATION_MODEL,
  DEFAULT_EXECUTION_POLICY,
  DEFAULT_MODEL_CATALOG,
  DEFAULT_HARNESS_PARAMETERS,
} from './harness-defaults.mjs'

import { loadAuthoritativeConfigs } from './authority.mjs'
import { computeProjections } from './projection.mjs'

export function loadHarnessIntelligence(targetDir = process.cwd()) {
  const loaded = loadAuthoritativeConfigs(targetDir)
  const projections = computeProjections({
    orchestration: loaded.orchestration,
    execution: loaded.execution,
    models: loaded.models,
    harness: loaded.harness,
  })
  return {
    orchestrationModel: JSON.parse(projections['.agentflow/orchestration-model.json']),
    executionPolicy: JSON.parse(projections['.agentflow/execution-policy.json']),
    modelCatalog: JSON.parse(projections['.agentflow/model-catalog.json']),
    harnessParameters: JSON.parse(projections['.agentflow/harness-parameters.json']),
  }
}

const SCAFFOLD_PILLARS = [
  { file: 'orchestration-model.json', data: DEFAULT_ORCHESTRATION_MODEL },
  { file: 'execution-policy.json', data: DEFAULT_EXECUTION_POLICY },
  { file: 'model-catalog.json', data: DEFAULT_MODEL_CATALOG },
  { file: 'harness-parameters.json', data: DEFAULT_HARNESS_PARAMETERS },
]

// The exact bytes a scaffold writes, keyed by project-relative path, so a preview can show them.
export function harnessScaffoldFiles() {
  return Object.fromEntries(
    SCAFFOLD_PILLARS.map(({ file, data }) => [
      `.agentflow/${file}`,
      `${JSON.stringify(data, null, 2)}\n`,
    ]),
  )
}

export function scaffoldHarnessIntelligence(targetDir = process.cwd(), { force = false } = {}) {
  const agentflowDir = join(targetDir, '.agentflow')
  if (!existsSync(agentflowDir)) {
    mkdirSync(agentflowDir, { recursive: true })
  }
  const created = []
  const existing = []
  for (const { file, data } of SCAFFOLD_PILLARS) {
    const fullPath = join(agentflowDir, file)
    if (!existsSync(fullPath) || force) {
      writeFileSync(fullPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
      created.push(file)
    } else {
      existing.push(file)
    }
  }
  return { agentflowDir, created, existing }
}

export function inspectHarnessIntelligence(targetDir = process.cwd()) {
  const agentflowDir = join(targetDir, '.agentflow')
  const pillars = [
    'orchestration-model.json',
    'execution-policy.json',
    'model-catalog.json',
    'harness-parameters.json',
  ]
  const status = {}
  let configuredCount = 0
  for (const pillar of pillars) {
    const fullPath = join(agentflowDir, pillar)
    const exists = existsSync(fullPath)
    if (exists) configuredCount += 1
    status[pillar] = {
      path: fullPath,
      exists,
    }
  }
  return {
    agentflowDir,
    configuredCount,
    totalPillars: pillars.length,
    status,
    loaded: loadHarnessIntelligence(targetDir),
  }
}
