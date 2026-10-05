import { reduceRun } from '../core/run-state.mjs'
import { requireDeliveryRecord, sealDeliveryRecord } from '../core/delivery-record.mjs'

export async function planGitHubCoordination({ repo, branch = 'agentflow-state', client }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[\w/-]+$/.test(branch))
    throw new Error('Invalid coordination destination')
  const repository = await client.request(`/repos/${repo}`)
  const baseline = await client.request(`/repos/${repo}/git/ref/heads/${repository.default_branch}`)
  const rulesets = await client.request(
    `/repos/${repo}/rulesets?includes_parents=true&per_page=100`,
  )
  const workflows = await client.request(`/repos/${repo}/actions/workflows?per_page=100`)
  if (
    !Array.isArray(rulesets) ||
    rulesets.length >= 100 ||
    !Array.isArray(workflows.workflows) ||
    workflows.total_count > 100
  )
    throw new Error('Coordination preflight is incomplete')
  return sealDeliveryRecord('coordination-setup-plan', {
    repo,
    branch,
    baseline: baseline.object.sha,
    defaultBranch: repository.default_branch,
    contentsPermission: repository.permissions?.push === true ? 'declared-available' : 'unknown',
    rulesets: rulesets.map(({ id, enforcement, source, updated_at }) => ({
      id,
      enforcement,
      source,
      updated_at,
    })),
    workflows: workflows.workflows.map(({ id, path, state, updated_at }) => ({
      id,
      path,
      state,
      updated_at,
    })),
    requiredReview: [
      'Inspect applicable repository rules',
      'Inspect workflows and external automation for coordination-ref effects',
      'Authorize contents writes to this exact branch',
    ],
    mutation: `Create state-only refs/heads/${branch}`,
  })
}

// One isolated state-only branch, serialized by non-force fast-forward updates.
export function createGitHubRunStore({
  repo,
  runId,
  client,
  branch = 'agentflow-state',
  boundary,
  setupConfirm,
  readCacheBytes = 2 * 1024 * 1024,
}) {
  if (
    !Number.isSafeInteger(readCacheBytes) ||
    readCacheBytes < 0 ||
    readCacheBytes > 2 * 1024 * 1024
  )
    throw new Error('Invalid immutable read cache capacity')
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(repo ?? '') ||
    !/^[\w-]{1,100}$/.test(runId ?? '') ||
    !/^[\w/-]+$/.test(branch)
  )
    throw new Error('Invalid GitHub run store identity')
  const prefix = `/repos/${repo}`
  const refPath = `${prefix}/git/ref/heads/${branch}`
  const filePath = `runs/${runId}.json`
  const request = (...args) => client.request(...args)
  // One validated snapshot, never a mutable ref cache. Serialized bytes bound retained
  // payload (not total process RSS) and prevent callers from mutating cached events.
  let cached = null
  const write = (path, body, method = 'POST') => {
    if (boundary !== 'external-action')
      throw new Error('Coordination writes require external-action authority')
    return request(path, { method, body })
  }
  async function read({ cache = true } = {}) {
    let ref
    try {
      ref = await request(refPath)
    } catch (error) {
      cached = null
      if (error.status === 404) return { events: [], revision: null, sourceRevision: null }
      throw error
    }
    const sourceRevision = ref?.object?.sha
    if (typeof sourceRevision !== 'string' || !sourceRevision) {
      cached = null
      throw new Error('Missing coordination revision')
    }
    if (!cache) cached = null
    if (cached?.sourceRevision !== sourceRevision) cached = null
    if (cache && cached) return JSON.parse(cached.serialized)
    const commit = await request(`${prefix}/git/commits/${ref.object.sha}`)
    const tree = await request(`${prefix}/git/trees/${commit.tree.sha}?recursive=1`)
    if (tree.truncated) throw new Error('Coordination tree truncated')
    if (
      !Array.isArray(tree.tree) ||
      tree.tree.some(
        (entry) =>
          !(entry.path === 'runs' && entry.type === 'tree' && entry.mode === '040000') &&
          !(
            entry.type === 'blob' &&
            entry.mode === '100644' &&
            /^runs\/[\w-]+\.json$/.test(entry.path)
          ),
      )
    )
      throw new Error('Coordination branch contains unmanaged data')
    const entry = tree.tree.find((item) => item.path === filePath)
    let events = []
    if (entry) {
      const blob = await request(`${prefix}/git/blobs/${entry.sha}`)
      if (blob.encoding !== 'base64' || blob.size > 1024 * 1024)
        throw new Error('Invalid or oversized run record')
      events = JSON.parse(Buffer.from(blob.content.replaceAll('\n', ''), 'base64').toString('utf8'))
    }
    const state = reduceRun(events)
    if (state && state.runId !== runId) throw new Error('Stored run identity mismatch')
    const result = {
      events,
      revision: state?.revision ?? null,
      sourceRevision: ref.object.sha,
      treeSha: commit.tree.sha,
    }
    // Unknown identities and failed validation never become reusable observations.
    if (cache && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(sourceRevision)) {
      const serialized = JSON.stringify(result)
      if (Buffer.byteLength(serialized) <= readCacheBytes) cached = { sourceRevision, serialized }
    }
    return result
  }
  return {
    durable: true,
    conditionalAdmission: 'single-parent-run-chain-v1',
    read,
    async append(event, expectedRevision) {
      requireDeliveryRecord(event, 'run-event')
      if (event.runId !== runId) throw new Error('Run identity mismatch')
      const current = await read()
      const prior = current.events.find((item) => item.id === event.id)
      if (prior) {
        if (prior.digest !== event.digest) throw new Error('Conflicting event')
        return current
      }
      if (current.revision !== expectedRevision)
        throw Object.assign(new Error('Source revision conflict'), {
          admissionOutcome: 'not-committed',
        })
      const events = [...current.events, event]
      const proposedState = reduceRun(events)
      const content = JSON.stringify(events)
      // Reserve source capacity for every remaining bounded safety checkpoint.
      // The reducer caps its payload at 2 KiB; 4 KiB includes the event envelope.
      const reserve = proposedState?.delegationPolicy
        ? Math.max(0, proposedState.delegationPolicy.safetyReserve - proposedState.safetyUsed) *
          4096
        : 0
      if (Buffer.byteLength(content) > 1024 * 1024 - reserve)
        throw new Error('Run exceeds bounded record size')
      if (!current.sourceRevision) {
        const setup = await planGitHubCoordination({ repo, branch, client })
        if (setupConfirm !== setup.digest)
          throw new Error('Explicit current coordination setup confirmation required')
      }
      const blob = await write(`${prefix}/git/blobs`, { content, encoding: 'utf-8' })
      const tree = await write(`${prefix}/git/trees`, {
        ...(current.treeSha ? { base_tree: current.treeSha } : {}),
        tree: [{ path: filePath, mode: '100644', type: 'blob', sha: blob.sha }],
      })
      const commit = await write(`${prefix}/git/commits`, {
        message: `Agentflow ${runId}: ${event.kind}`,
        tree: tree.sha,
        parents: current.sourceRevision ? [current.sourceRevision] : [],
      })
      try {
        if (current.sourceRevision)
          await write(
            `${prefix}/git/refs/heads/${branch}`,
            { sha: commit.sha, force: false },
            'PATCH',
          )
        else await write(`${prefix}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha })
      } catch (error) {
        // Never retry a possibly successful write. Read back the event identity first.
        const reconciled = await read({ cache: false })
        if (reconciled.events.some((item) => item.id === event.id && item.digest === event.digest))
          return reconciled
        if ([409, 422].includes(error.status)) error.admissionOutcome = 'not-committed'
        throw error
      }
      const confirmed = await read({ cache: false })
      if (!confirmed.events.some((item) => item.id === event.id && item.digest === event.digest))
        throw new Error('Coordination outcome unknown')
      return confirmed
    },
  }
}
