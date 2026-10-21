import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { loadAuthoritativeConfigs, validateConfigAuthority } from './authority.mjs'

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

export function sortRecursively(value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(sortRecursively)
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, sortRecursively(v)]),
  )
}

export function deterministicJson(value) {
  return `${JSON.stringify(sortRecursively(value), null, 2)}\n`
}

export function hashString(str) {
  return createHash('sha256').update(str).digest('hex')
}

export function computeProjections(config = {}) {
  const orchestration = {
    lifecycle: config.orchestration?.lifecycle ?? DEFAULT_ORCHESTRATION_MODEL.lifecycle,
    preCodeReview: {
      ...DEFAULT_ORCHESTRATION_MODEL.preCodeReview,
      ...(config.orchestration?.preCodeReview ?? {}),
    },
    concurrency: {
      ...DEFAULT_ORCHESTRATION_MODEL.concurrency,
      ...(config.orchestration?.concurrency ?? {}),
    },
  }

  const execution = {
    escalation: {
      ...DEFAULT_EXECUTION_POLICY.escalation,
      ...(config.execution?.escalation ?? {}),
    },
    fallbackCascade: {
      ...DEFAULT_EXECUTION_POLICY.fallbackCascade,
      ...(config.execution?.fallbackCascade ?? {}),
    },
  }

  const models = {
    tiers: {
      ...Object.fromEntries(
        Object.entries(DEFAULT_MODEL_CATALOG.tiers).map(([tier, defaults]) => [
          tier,
          { ...defaults, ...(config.models?.tiers?.[tier] ?? {}) },
        ]),
      ),
      ...Object.fromEntries(
        Object.entries(config.models?.tiers ?? {}).filter(
          ([tier]) => !Object.hasOwn(DEFAULT_MODEL_CATALOG.tiers, tier),
        ),
      ),
    },
    roleAssignments: {
      ...DEFAULT_MODEL_CATALOG.roleAssignments,
      ...(config.models?.roleAssignments ?? {}),
    },
  }

  const harness = {
    shellRunner: {
      ...DEFAULT_HARNESS_PARAMETERS.shellRunner,
      ...(config.harness?.shellRunner ?? {}),
    },
    limits: {
      ...DEFAULT_HARNESS_PARAMETERS.limits,
      ...(config.harness?.limits ?? {}),
    },
    scratchPath: config.harness?.scratchPath ?? DEFAULT_HARNESS_PARAMETERS.scratchPath,
  }

  const projections = {
    '.agentflow/orchestration-model.json': deterministicJson(orchestration),
    '.agentflow/execution-policy.json': deterministicJson(execution),
    '.agentflow/model-catalog.json': deterministicJson(models),
    '.agentflow/harness-parameters.json': deterministicJson(harness),
  }

  const openrig = config.adapters?.openrig
  if (openrig) {
    const wrapped = Object.hasOwn(openrig, 'executionPolicy') || Object.hasOwn(openrig, 'rig')
    const rig = wrapped ? openrig.rig : openrig
    if (rig !== undefined) projections['adapters/openrig/rig.yaml'] = deterministicJson(rig)
  }

  return projections
}

export function inspectConfigState(repoRoot = process.cwd()) {
  const root = resolve(repoRoot)
  const loaded = loadAuthoritativeConfigs(root)
  const validation = validateConfigAuthority(loaded)

  const configForProjections = loaded.isUnified
    ? loaded.unified
    : {
        orchestration: loaded.orchestration,
        execution: loaded.execution,
        models: loaded.models,
        harness: loaded.harness,
        adapters: loaded.adapters,
      }

  const projections = computeProjections(configForProjections)
  const fileStatuses = []

  let clean = true
  for (const [relativePath, desiredContent] of Object.entries(projections)) {
    const fullPath = resolve(root, relativePath)
    const desiredDigest = hashString(desiredContent)

    if (!existsSync(fullPath)) {
      clean = false
      fileStatuses.push({
        path: relativePath,
        status: 'missing',
        desiredDigest,
        observedDigest: null,
      })
    } else {
      const observedContent = readFileSync(fullPath, 'utf8')
      const observedDigest = hashString(observedContent)
      if (observedDigest === desiredDigest) {
        fileStatuses.push({
          path: relativePath,
          status: 'matched',
          desiredDigest,
          observedDigest,
        })
      } else {
        let isSemanticMatch = false
        try {
          const parsedObs = JSON.parse(observedContent)
          const parsedDes = JSON.parse(desiredContent)
          if (
            hashString(JSON.stringify(sortRecursively(parsedObs))) ===
            hashString(JSON.stringify(sortRecursively(parsedDes)))
          ) {
            isSemanticMatch = true
          }
        } catch {
          // not JSON or parse error
        }

        if (isSemanticMatch) {
          fileStatuses.push({
            path: relativePath,
            status: 'matched',
            desiredDigest,
            observedDigest,
          })
        } else {
          clean = false
          fileStatuses.push({
            path: relativePath,
            status: 'modified',
            desiredDigest,
            observedDigest,
          })
        }
      }
    }
  }

  const planSummary = {
    root,
    isUnified: loaded.isUnified,
    configPath: loaded.configPath,
    files: fileStatuses.map((f) => ({ path: f.path, status: f.status, digest: f.desiredDigest })),
  }
  const planDigest = hashString(JSON.stringify(sortRecursively(planSummary)))

  return {
    ok: validation.ok && clean,
    clean,
    desired: {
      isUnified: loaded.isUnified,
      configPath: loaded.configPath,
      planDigest,
    },
    observed: {
      fileCount: fileStatuses.length,
      matchCount: fileStatuses.filter((f) => f.status === 'matched').length,
      driftCount: fileStatuses.filter((f) => f.status !== 'matched').length,
    },
    files: fileStatuses,
    validation,
    projections,
  }
}

export function applyProjections(repoRoot = process.cwd(), { confirm, plan } = {}) {
  const root = resolve(repoRoot)
  const current = plan ?? inspectConfigState(root)

  if (!confirm || confirm !== current.desired.planDigest) {
    throw new Error('Projection confirmation or plan digest is invalid')
  }

  const writtenFiles = []
  const projections =
    current.projections ?? computeProjections(loadAuthoritativeConfigs(root).unified)

  for (const file of current.files) {
    if (file.status === 'matched') continue

    const fullPath = resolve(root, file.path)
    const parentDir = dirname(fullPath)
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true })
    }

    const content = projections[file.path]
    if (!content) continue

    const id = randomUUID()
    const staged = `${fullPath}.agentflow-${id}.tmp`
    const backup = `${fullPath}.agentflow-${id}.bak`

    writeFileSync(staged, content, 'utf8')
    if (existsSync(fullPath)) renameSync(fullPath, backup)

    try {
      renameSync(staged, fullPath)
      if (existsSync(backup)) unlinkSync(backup)
      writtenFiles.push(file.path)
    } catch (err) {
      if (existsSync(staged)) unlinkSync(staged)
      if (existsSync(backup) && !existsSync(fullPath)) renameSync(backup, fullPath)
      throw err
    }
  }

  return {
    ok: true,
    status: 'applied',
    planDigest: current.desired.planDigest,
    writtenFiles,
  }
}
