import { resolve } from 'node:path'
import { loadAuthoritativeConfigs } from '../config/authority.mjs'
import { createFileRunStore } from '../sources/run-store.mjs'
import { createGitHubRunStore } from '../sources/github-run-store.mjs'
import { createSegmentedRunStore } from '../sources/segmented-run-store.mjs'
import { recordDigest } from '../core/record-digest.mjs'
import { reduceRun } from '../core/run-state.mjs'

// Configuration and store selection shared by the operational CLI and read-only
// recovery/preflight. This module never discovers credentials or starts a run.
export function readRunConfiguration(root = process.cwd()) {
  const loaded = loadAuthoritativeConfigs(root)
  const executionAdapter = loaded.isUnified ? loaded.unified : loaded.workflow
  const config = executionAdapter.delivery
  if (!config?.source || !config.candidate)
    throw new Error('Configure delivery.source and delivery.candidate first')
  if (!['github', 'local-preview'].includes(config.source.kind))
    throw new Error('Unsupported run source')
  if (config.source.format !== undefined && !['v1', 'segmented-v2'].includes(config.source.format))
    throw new Error('Unsupported source format')
  return { executionAdapter, config, configPath: loaded.workflowPath, isUnified: loaded.isUnified }
}

// Mutation callers must continue through createRunService authorization and CAS.
// This factory changes neither setup authority nor the existing source protocol.
export function createConfiguredRunStore({
  root = process.cwd(),
  runId,
  source,
  client,
  boundary = 'observe',
  setupConfirm,
} = {}) {
  if (!source || !['github', 'local-preview'].includes(source.kind))
    throw new Error('Unsupported run source')
  if (source.format !== undefined && !['v1', 'segmented-v2'].includes(source.format))
    throw new Error('Unsupported source format')
  if (source.kind === 'local-preview') return createFileRunStore({ root: resolve(root), runId })
  if (!client || typeof client.request !== 'function')
    throw new Error('Configured GitHub source requires an injected client')
  const factory = source.format === 'segmented-v2' ? createSegmentedRunStore : createGitHubRunStore
  return factory({ ...source, runId, client, boundary, setupConfirm })
}

export async function loadConfiguredRunSource({ root = process.cwd(), runId, client } = {}) {
  const { config, configPath, isUnified } = readRunConfiguration(root)
  const underlying = createConfiguredRunStore({
    root,
    runId,
    source: config.source,
    client,
    boundary: 'observe',
  })
  const configRevision = recordDigest(config.source)
  const snapshot = await underlying.read({ cache: false })
  if (recordDigest(readRunConfiguration(root).config.source) !== configRevision)
    throw new Error('Configured source changed during observation')
  const state = reduceRun(snapshot.events)
  if (state && state.runId !== runId) throw new Error('Stored run identity mismatch')
  const github = config.source.kind === 'github'
  const source = {
    kind: config.source.kind,
    runId,
    format: config.source.format ?? 'v1',
    durable: underlying.durable === true,
    ...(github
      ? { repo: config.source.repo, branch: config.source.branch ?? 'agentflow-state' }
      : {}),
    path: github
      ? `runs/${runId}${config.source.format === 'segmented-v2' ? '-manifest' : ''}.json`
      : `.agent-runs/runs/${runId}/events.json`,
  }
  return {
    configRevision,
    status: state ? 'observed' : 'missing-run',
    configPath,
    isUnified,
    source,
    store: Object.freeze({
      durable: underlying.durable,
      read: (options) => underlying.read(options),
    }),
    state,
    revision: snapshot.revision,
    sourceRevision: snapshot.sourceRevision ?? null,
    native: state
      ? {
          protocol: 'run-v1',
          runId: state.runId,
          goalRef: state.goalRef,
          runRevision: snapshot.revision,
          sourceRevision: snapshot.sourceRevision ?? snapshot.revision,
          generation: state.generation,
          revocationEpoch: state.revocationEpoch,
          owner: state.owner,
          oracleDigest: state.oracleDigest,
          oraclePin: state.oraclePin,
          oracleCustody: state.oracleCustody ?? null,
        }
      : null,
    // Generation zero is valid in the native protocol. It is NOT bridge epoch one.
    // A digest pin's pinnedBefore field is NOT the oracle author's identity.
    bridge: { epoch: null, minimumEpoch: null, fencingToken: null, oracleOwner: null },
    gaps: state
      ? [
          'bridge-authority-unbound',
          ...(state.oracleCustody?.author?.mode === 'historical-author'
            ? []
            : ['oracle-custody-unbound']),
        ]
      : ['missing-run'],
  }
}
