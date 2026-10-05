import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createMeshloopProvider } from './meshloop-provider.mjs'
import { createProviderExecutionReceipt, providerDigest } from './provider-receipt.mjs'
import { safePath } from '../core/delegation-grant.mjs'
import { ingestWorktreeCommit } from '../verification/workspace.mjs'

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
export const meshloopGraphId = (identity, nodes, configSha256) =>
  `af-${sha(JSON.stringify({ identity, nodes, configSha256 })).slice(0, 40)}`
const intents = [
  {
    id: 'structured-result',
    implementation: 'adapter',
    fidelity: 'full',
    evidence: 'contract-tested',
    limits: {},
  },
  {
    id: 'file-edit',
    implementation: 'adapter',
    fidelity: 'full',
    evidence: 'contract-tested',
    limits: {},
  },
]

// Narrow CLI translation. Meshloop owns execution; this adapter owns evidence binding.
// It never reads Meshloop's database, applies a commit, or grants SDLC acceptance.
export function createMeshloopEngineeringProvider({
  cwd,
  executable,
  binarySha256,
  configFile,
  dbFile,
  worktreeBase,
  spawn,
  gitSpawn = spawnSync,
} = {}) {
  if (
    !cwd ||
    !executable ||
    !/^[a-f0-9]{64}$/.test(binarySha256 ?? '') ||
    !configFile ||
    !dbFile ||
    !worktreeBase
  )
    throw new Error(
      'Meshloop requires explicit workspace, pinned binary, config, database and worktree paths',
    )
  const root = resolve(cwd)
  const paths = {
    configFile: resolve(configFile),
    dbFile: resolve(dbFile),
    worktreeBase: resolve(worktreeBase),
  }
  let lastOutput = null
  const raw = createMeshloopProvider({ executable, spawn, gitSpawn })
  const git = (args) => {
    const result = gitSpawn('git', args, {
      cwd: root,
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 32768,
    })
    if (result.error || result.status !== 0)
      throw new Error('Meshloop result Git verification failed')
    return Buffer.from(result.stdout)
  }
  const assertBinary = () => {
    if (sha(readFileSync(executable)) !== binarySha256)
      throw new Error('Meshloop binary changed; requalify configuration')
  }
  const inspect = async () => {
    assertBinary()
    const probe = await raw.inspect({ cwd: root })
    return {
      ...probe,
      intentSupport: intents,
      qualification: {
        capabilities: probe.availability === 'available' ? ['file-edit', 'structured-result'] : [],
        liveBinaryQualified: false,
        binarySha256,
      },
    }
  }
  const plan = (request) => {
    assertBinary()
    if (request.model != null)
      throw new Error('Model selection belongs to the configured Meshloop runtime')
    if (request.boundary !== 'mutate-worktree')
      throw new Error('Meshloop integration supports mutate-worktree only')
    if (
      !request.engineeringProfile?.operationId ||
      !/^[a-f0-9]{64}$/.test(request.engineeringProfile.candidateDigest ?? '')
    )
      throw new Error('Operation and candidate identity required')
    if (
      !Array.isArray(request.allowedPaths) ||
      !request.allowedPaths.length ||
      !request.allowedPaths.every(safePath)
    )
      throw new Error('Explicit safe output paths required')
    const planFile = resolve(root, request.planFile ?? '')
    const planBytes = readFileSync(planFile)
    if (planBytes.length > 32768) throw new Error('Meshloop plan exceeds control budget')
    const parsedPlan = JSON.parse(planBytes)
    const graphId = parsedPlan.graph_id
    if (
      graphId !==
      meshloopGraphId(
        request.engineeringProfile,
        parsedPlan.nodes,
        sha(readFileSync(paths.configFile)),
      )
    )
      throw new Error('Meshloop graph must bind operation, candidate, nodes and runtime config')
    if (typeof graphId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(graphId))
      throw new Error('Explicit safe graph identity required')
    const base = {
      provider: 'meshloop-engineering-cli',
      cwd: root,
      request: structuredClone(request),
      graphId,
      baseCommit: git(['rev-parse', 'HEAD']).toString().trim(),
      planFile,
      planSha256: sha(planBytes),
      configSha256: sha(readFileSync(paths.configFile)),
      timeoutMs: request.timeoutMs ?? 60000,
      meshPlan: raw.plan({
        cwd: root,
        planFile,
        acceptPlan: true,
        ...paths,
        timeoutMs: request.timeoutMs ?? 60000,
      }),
    }
    return { ...base, token: providerDigest(base) }
  }
  const validate = (value, confirm) => {
    const { token, ...base } = value ?? {}
    if (
      !token ||
      confirm !== token ||
      providerDigest(base) !== token ||
      base.provider !== 'meshloop-engineering-cli' ||
      base.cwd !== root
    )
      throw new Error('Invalid Meshloop engineering plan confirmation')
    assertBinary()
    if (
      sha(readFileSync(base.planFile)) !== base.planSha256 ||
      sha(readFileSync(paths.configFile)) !== base.configSha256
    )
      throw new Error('Meshloop plan/config changed; replan')
    if (git(['rev-parse', 'HEAD']).toString().trim() !== base.baseCommit)
      throw new Error('Workspace candidate changed')
  }
  const translate = (value, data, state, startedAt) => {
    const identity = value.request.engineeringProfile
    if ((data?.graph_id ?? data?.session_id) !== value.graphId)
      throw new Error('Meshloop graph identity mismatch')
    let status = 'blocked'
    let artifacts = []
    const known = ['completed', 'awaiting_acceptance', 'failed', 'cancelled', 'blocked']
    const outcomeUnknown = !known.includes(state)
    if (state === 'completed') {
      const inspected = ingestWorktreeCommit({ root, gitExport: data.git_export, spawn: gitSpawn })
      const commit = inspected.commitSha
      git(['merge-base', '--is-ancestor', value.baseCommit, commit])
      const changed = git(['diff', '--name-only', '--no-renames', '-z', value.baseCommit, commit])
        .toString()
        .split('\0')
        .filter(Boolean)
      if (!changed.length) throw new Error('Meshloop produced no changed artifact')
      artifacts = changed.map((path) => {
        if (!safePath(path) || !value.request.allowedPaths.includes(path))
          throw new Error('Meshloop output outside authorized paths')
        const entry = git(['ls-tree', commit, '--', path]).toString()
        if (!/^100(644|755) blob /.test(entry))
          throw new Error('Only regular file outputs are supported')
        const bytes = git(['show', `${commit}:${path}`])
        return {
          path,
          contentBase64: bytes.toString('base64'),
          sha256: sha(bytes),
          byteLength: bytes.length,
        }
      })
      status = 'pass'
    } else if (state === 'failed') status = 'failed'
    else if (state === 'cancelled') status = 'cancelled'
    const output = {
      status,
      operationId: identity.operationId,
      candidateDigest: identity.candidateDigest,
      artifacts,
    }
    if (Buffer.byteLength(JSON.stringify(output)) > 32768)
      throw new Error('Meshloop result exceeds control budget')
    lastOutput = output
    return createProviderExecutionReceipt({
      provider: 'meshloop-engineering-cli',
      platform: 'meshloop',
      executionTarget: 'meshloop-cli',
      transport: 'local-cli',
      intentSupport: intents,
      plan: value,
      request: value.request,
      status,
      startedAt,
      completedAt: new Date().toISOString(),
      output,
      metadata: {
        engineeringProfile: identity,
        outcomeUnknown,
        sessionId: value.graphId,
        technicalState: state,
        integrated: false,
        sdlcAccepted: false,
      },
    })
  }
  const observe = async (value, confirm) => {
    validate(value, confirm)
    const result = await raw.status({ sessionId: value.graphId, cwd: root, ...paths })
    if (!result.data) return { status: 'unknown', sessionId: value.graphId, reason: result.reason }
    return translate(value, result.data, result.status, new Date().toISOString())
  }
  return {
    id: 'meshloop-engineering-cli',
    targets: ['meshloop-cli'],
    intentSupport: intents,
    inspect,
    plan,
    async execute(value, { confirm } = {}) {
      validate(value, confirm)
      // Never dispatch over an already visible graph. Existing work is observed only.
      const existing = await raw.status({ sessionId: value.graphId, cwd: root, ...paths })
      if (existing.data)
        return translate(value, existing.data, existing.status, new Date().toISOString())
      if (existing.status !== 'absent')
        throw new Error('Meshloop existence is unknown; dispatch refused')
      const receipt = await raw.execute(value.meshPlan, { confirm: value.meshPlan.token })
      const data = receipt.metadata.sessionId
        ? { graph_id: receipt.metadata.sessionId, git_export: receipt.metadata.gitExport }
        : null
      if (!data) throw new Error('Meshloop outcome unknown; inspect before any retry')
      return translate(
        value,
        data,
        receipt.metadata.lifecycleStatus,
        receipt.startedAt ?? new Date().toISOString(),
      )
    },
    readOutput(value, receipt) {
      validate(value, value.token)
      if (!lastOutput || providerDigest(lastOutput) !== receipt.digests.output)
        throw new Error('Observe the bound execution again to retrieve its verified result')
      return structuredClone(lastOutput)
    },
    observe,
    status: (query) => raw.status({ ...query, cwd: root, ...paths }),
    cancel: (query) => raw.cancel({ ...query, cwd: root, ...paths }),
  }
}
