import { spawn as defaultSpawn, spawnSync } from 'node:child_process'
import { createProviderExecutionReceipt, providerDigest } from './provider-receipt.mjs'
import { emitObservation } from '../observability/observer.mjs'
import { createHash } from 'node:crypto'
import { openSync, closeSync, readSync, fstatSync, realpathSync } from 'node:fs'
import { resolve, relative, isAbsolute } from 'node:path'
import { killProcessTree } from '../qa/process-supervisor.mjs'
import { evaluateTechnicalReceiptGate, ingestWorktreeCommit } from '../verification/workspace.mjs'
import { safePath } from '../core/delegation-grant.mjs'
import { inspectExecutable } from './local-cli.mjs'

export const MESHLOOP_PROFILE_VERSION = 1
export const MAX_OUTPUT_FRAME_BYTES = 64 * 1024

const KNOWN_NOTICE_PREFIX =
  'Note: worktrees are kept. `run` does not merge onto your current branch.\n' +
  'Use `meshloop accept` then `meshloop resume`, and `meshloop integrate --into` to land.\n\n'

export class MeshloopAdapterError extends Error {
  constructor(message, { code = 'MESHLOOP_ADAPTER_ERROR', details = null } = {}) {
    super(message)
    this.name = 'MeshloopAdapterError'
    this.code = code
    this.details = details
  }
}

export function parseMeshloopOutput(stdout) {
  if (typeof stdout !== 'string') {
    throw new MeshloopAdapterError('Meshloop stdout must be a string', {
      code: 'INVALID_OUTPUT_TYPE',
    })
  }
  const byteLength = Buffer.byteLength(stdout)
  if (byteLength > MAX_OUTPUT_FRAME_BYTES) {
    throw new MeshloopAdapterError(
      `Meshloop output exceeds frame limit of ${MAX_OUTPUT_FRAME_BYTES} bytes`,
      {
        code: 'OUTPUT_FRAME_OVERSIZED',
        details: { byteLength },
      },
    )
  }

  const normalized = stdout.replace(/\r\n/g, '\n')
  let jsonString = normalized
  let framing = 'strict-json'

  if (normalized.startsWith(KNOWN_NOTICE_PREFIX)) {
    jsonString = normalized.slice(KNOWN_NOTICE_PREFIX.length)
    framing = 'known-notice-prefix'
  } else if (!normalized.trimStart().startsWith('{')) {
    throw new MeshloopAdapterError('Unrecognized output framing or invalid preamble', {
      code: 'UNQUALIFIED_OUTPUT_FRAMING',
    })
  }

  let parsed
  try {
    parsed = JSON.parse(jsonString)
  } catch (err) {
    throw new MeshloopAdapterError(`Malformed Meshloop JSON payload: ${err.message}`, {
      code: 'MALFORMED_OUTPUT_JSON',
    })
  }

  return {
    raw: parsed,
    framing,
    ok: parsed.ok === true,
    command: parsed.command,
    data: parsed.data ?? {},
  }
}

function checkedEnvelope(stdout, command, sessionId = null) {
  const parsed = parseMeshloopOutput(stdout)
  if (
    !parsed.ok ||
    parsed.command !== `meshloop:${command}` ||
    !parsed.data ||
    typeof parsed.data !== 'object' ||
    Array.isArray(parsed.data)
  ) {
    throw new MeshloopAdapterError('Invalid or unsuccessful Meshloop envelope', {
      code: 'INVALID_ENVELOPE',
    })
  }
  if (sessionId && parsed.data.session_id !== sessionId) {
    throw new MeshloopAdapterError('Meshloop session identity mismatch', {
      code: 'SESSION_MISMATCH',
    })
  }
  return parsed
}

function lifecycle(data) {
  const byIdle = {
    GraphComplete: 'completed',
    AwaitingHumanAcceptance: 'awaiting_acceptance',
    WaitingOnLiveWorker: 'running',
    NoCapableCandidate: 'blocked',
    FailedTerminal: 'failed',
  }
  const states = [
    'completed',
    'awaiting_acceptance',
    'running',
    'blocked',
    'failed',
    'cancelled',
    'idle',
  ]
  if (data.status !== undefined && !states.includes(data.status)) return 'unknown'
  if (data.idle !== undefined && data.idle !== null && !byIdle[data.idle]) return 'unknown'
  const idleState = byIdle[data.idle]
  if (idleState && data.status && idleState !== data.status) return 'unknown'
  return idleState ?? data.status ?? 'unknown'
}

function verifyArtifacts(artifacts, cwd) {
  if (!Array.isArray(artifacts)) throw new Error('Returned artifacts must be an array')
  if (artifacts.length && !cwd) throw new Error('Artifact retrieval requires an explicit workspace')
  return artifacts.map((artifact) => {
    if (
      !artifact ||
      !safePath(artifact.path) ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? '') ||
      !Number.isSafeInteger(artifact.byteLength) ||
      artifact.byteLength < 0 ||
      artifact.byteLength > 16 * 1024 * 1024
    ) {
      throw new Error('Artifact requires a safe path, SHA-256 and bounded byteLength')
    }
    const root = realpathSync(cwd)
    const path = realpathSync(resolve(root, artifact.path))
    const rel = relative(root, path)
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Artifact escapes workspace')
    const fd = openSync(path, 'r')
    let bytes
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.size !== artifact.byteLength)
        throw new Error('Artifact byte length mismatch or not a file')
      const bounded = Buffer.alloc(artifact.byteLength + 1)
      let count = 0
      while (count < bounded.length) {
        const n = readSync(fd, bounded, count, bounded.length - count, null)
        if (!n) break
        count += n
      }
      bytes = bounded.subarray(0, count)
    } finally {
      closeSync(fd)
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (bytes.length !== artifact.byteLength || sha256 !== artifact.sha256)
      throw new Error('Artifact byte integrity mismatch')
    return {
      path: artifact.path,
      sha256,
      byteLength: bytes.length,
      verified: true,
      retrieval: 'workspace-file-bytes',
      source: 'provider-returned-descriptor',
    }
  })
}

export async function runProcess(spawnFn, executable, args, options = {}) {
  const timeout = Number.isFinite(options.timeout) && options.timeout > 0 ? options.timeout : 30_000
  const limit = MAX_OUTPUT_FRAME_BYTES
  let child
  try {
    child = spawnFn(executable, args, {
      ...options,
      timeout: undefined,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
    })
  } catch (error) {
    return { status: 1, stdout: '', stderr: error.message, error }
  }
  const bounded = (result) => {
    const stdout = String(result?.stdout ?? '')
    const stderr = String(result?.stderr ?? '')
    if (Buffer.byteLength(stdout) > limit || Buffer.byteLength(stderr) > limit) {
      return {
        status: 1,
        stdout: '',
        stderr: 'Process output limit exceeded',
        error: new Error('OUTPUT_FRAME_OVERSIZED'),
      }
    }
    return { status: result?.status ?? result?.exitCode ?? 1, stdout, stderr, error: result?.error }
  }
  if (child && typeof child.then === 'function') {
    let timer
    try {
      return await Promise.race([
        child
          .then(bounded)
          .catch((error) => ({ status: 1, stdout: '', stderr: error.message, error })),
        new Promise((resolve) => {
          timer = setTimeout(
            () =>
              resolve({
                status: 1,
                stdout: '',
                stderr: 'Process deadline exceeded; outcome unknown',
                error: new Error('PROCESS_TIMEOUT'),
                terminationConfirmed: false,
              }),
            timeout,
          )
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  if (!child || typeof child.on !== 'function') return bounded(child)
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let error = null
    let settled = false
    let escalation
    let settlement
    const finish = (code, closed = false) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(escalation)
      clearTimeout(settlement)
      child.stdout?.destroy?.()
      child.stderr?.destroy?.()
      child.unref?.()
      resolve({
        status: error ? 1 : (code ?? 1),
        stdout,
        stderr,
        error,
        terminationConfirmed: closed,
      })
    }
    const terminate = (force) => {
      if (child.pid) void killProcessTree(child.pid, { force }).catch(() => {})
      try {
        child.kill(force ? 'SIGKILL' : 'SIGTERM')
      } catch {
        /* outcome stays unknown until close */
      }
    }
    const abort = (reason) => {
      if (error || settled) return
      error = new Error(reason)
      terminate(false)
      if (settled) return
      escalation = setTimeout(() => terminate(true), 100)
      settlement = setTimeout(() => finish(1), 250)
    }
    const timer = setTimeout(() => abort('PROCESS_TIMEOUT'), timeout)
    const collect = (stream, chunk) => {
      if (error || settled) return
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      const previous = stream === 'stdout' ? stdout : stderr
      if (Buffer.byteLength(previous) + Buffer.byteLength(text) > limit)
        return abort('OUTPUT_FRAME_OVERSIZED')
      if (stream === 'stdout') stdout += text
      else stderr += text
    }
    child.stdout?.setEncoding?.('utf8')
    child.stderr?.setEncoding?.('utf8')
    child.stdout?.on('data', (chunk) => collect('stdout', chunk))
    child.stderr?.on('data', (chunk) => collect('stderr', chunk))
    child.on('error', (err) => {
      error = err
      finish(1)
    })
    child.on('close', (code) => finish(code, true))
  })
}

export function createMeshloopProvider({
  id = 'meshloop',
  platform = 'meshloop',
  executable = 'meshloop',
  executionTarget = 'meshloop-cli',
  transport = 'local-cli',
  delegationBoundary = 'separate-process',
  intentSupport = [],
  qualifiedCapabilities = [],
  gitSpawn = spawnSync,
  providerVersion = '1.0.0',
  profileVersion = MESHLOOP_PROFILE_VERSION,
  osSupport = ['win32', 'linux', 'darwin'],
  trustSource = 'optional Meshloop adapter configuration',
  spawn = defaultSpawn,
  observer = null,
} = {}) {
  let lastReceipt = null
  const activeSessions = new Map()

  const inspect = async ({ cwd } = {}) => {
    // For fast synchronous metadata inspection, probe executable version
    const probe = inspectExecutable({
      executable,
      args: ['--version'],
      cwd,
      spawn: spawn === defaultSpawn ? spawnSync : spawn,
    })
    return {
      ...probe,
      id,
      platform,
      executionTarget,
      transport,
      delegationBoundary,
      intentSupport,
      qualification: { capabilities: qualifiedCapabilities, liveBinaryQualified: false },
      profileVersion,
    }
  }

  const plan = (request = {}) => {
    // Fencing: destructive operations (--restart / --reset) are prohibited as continuation
    if (
      request.restart === true ||
      request.reset === true ||
      request.flags?.includes('--restart') ||
      request.flags?.includes('--reset')
    ) {
      throw new MeshloopAdapterError(
        'Destructive operations (--restart / --reset) are prohibited as continuation; evidence preservation required',
        { code: 'DESTRUCTIVE_CONTINUATION_PROHIBITED' },
      )
    }

    if (request.profileVersion && request.profileVersion !== profileVersion) {
      throw new MeshloopAdapterError(
        `Incompatible profile version: requested ${request.profileVersion}, provider supports ${profileVersion}`,
        {
          code: 'INCOMPATIBLE_PROFILE_VERSION',
          details: { requested: request.profileVersion, supported: profileVersion },
        },
      )
    }

    if (
      (request.detach === true || request.flags?.includes('--detach')) &&
      !qualifiedCapabilities.includes('detached-lifecycle-v1')
    ) {
      throw new MeshloopAdapterError(
        'Detached lifecycle is not qualified for this configured binary',
        { code: 'UNQUALIFIED_CAPABILITY' },
      )
    }
    const args = ['run', '--json']
    if (request.detach === true || request.flags?.includes('--detach')) {
      args.push('--detach')
    }
    if (request.planFile) {
      args.push('--plan', request.planFile)
    }
    if (request.acceptPlan) {
      args.push('--accept-plan')
    }
    if (request.configFile) {
      args.push('--config', request.configFile)
    }
    if (request.worktreeBase) {
      args.push('--worktree-base', request.worktreeBase)
    }
    if (request.dbFile) {
      args.push('--db', request.dbFile)
    }
    if (request.fixtureOnly) {
      args.push('--fixture-only')
    }

    const base = {
      version: 1,
      provider: id,
      platform,
      executable,
      args,
      cwd: resolve(request.cwd ?? process.cwd()),
      timeoutMs: request.timeoutMs ?? 30_000,
      profileVersion,
      request,
    }

    return { ...base, token: providerDigest(base) }
  }

  const execute = async (executionPlan, { confirm } = {}) => {
    const { token, ...base } = executionPlan ?? {}
    if (executionPlan?.provider !== id || confirm !== token || providerDigest(base) !== token) {
      throw new MeshloopAdapterError('Meshloop execution confirmation or plan digest is invalid', {
        code: 'INVALID_EXECUTION_CONFIRMATION',
      })
    }

    const startedAt = new Date().toISOString()
    const started = performance.now()
    emitObservation(observer, {
      kind: 'meshloop_execution_attempt',
      state: 'started',
      operationId: token,
    })

    const result = await runProcess(spawn, executable, executionPlan.args, {
      cwd: executionPlan.cwd ?? undefined,
      timeout: executionPlan.timeoutMs,
      maxBuffer: MAX_OUTPUT_FRAME_BYTES * 2,
    })

    let parsedOutput = null
    let status = 'failed'
    const isDetached = executionPlan.args?.includes('--detach')
    let sessionId = null

    let lifecycleStatus = 'unknown'
    let failureReason = result.error?.message ?? null
    let verifiedArtifacts = []
    let verifiedCommit = null
    if (!result.error && result.status === 0) {
      try {
        parsedOutput = checkedEnvelope(result.stdout ?? '', 'run')
        lifecycleStatus = lifecycle(parsedOutput.data)
        sessionId = parsedOutput.data.session_id ?? parsedOutput.data.graph_id ?? null
        if (isDetached && !sessionId) throw new Error('Detached run has no session identity')
        if (sessionId)
          activeSessions.set(sessionId, { startedAt, plan: executionPlan, status: lifecycleStatus })
        status = ['completed', 'awaiting_acceptance'].includes(lifecycleStatus)
          ? 'pass'
          : lifecycleStatus === 'cancelled'
            ? 'cancelled'
            : ['running', 'blocked', 'idle'].includes(lifecycleStatus)
              ? 'blocked'
              : 'failed'
        if (status === 'pass') {
          verifiedArtifacts = verifyArtifacts(parsedOutput.data.artifacts ?? [], executionPlan.cwd)
          if (parsedOutput.data.git_export) {
            if (!executionPlan.cwd)
              throw new Error('Git export verification requires an explicit workspace')
            verifiedCommit = ingestWorktreeCommit({
              root: executionPlan.cwd,
              gitExport: parsedOutput.data.git_export,
              spawn: gitSpawn,
              observer,
            })
          }
        }
        if (status === 'failed')
          failureReason = `Unsuccessful or unknown lifecycle: ${lifecycleStatus}`
      } catch (err) {
        status = 'failed'
        failureReason = err.message
      }
    }

    const rawMetrics = parsedOutput?.data?.metrics ?? parsedOutput?.data?.execution_metrics ?? {}
    const astReductionRatio =
      typeof rawMetrics.ast_token_reduction_ratio === 'number'
        ? rawMetrics.ast_token_reduction_ratio
        : typeof rawMetrics.astReductionRatio === 'number'
          ? rawMetrics.astReductionRatio
          : null
    const lyapunovIterations =
      typeof rawMetrics.lyapunov_iterations === 'number'
        ? rawMetrics.lyapunov_iterations
        : typeof rawMetrics.lyapunovIterations === 'number'
          ? rawMetrics.lyapunovIterations
          : null
    const orphanProcessCount =
      typeof rawMetrics.orphan_process_count === 'number'
        ? rawMetrics.orphan_process_count
        : typeof rawMetrics.orphanProcessCount === 'number'
          ? rawMetrics.orphanProcessCount
          : 0
    const worktreeLockWaitMs =
      typeof rawMetrics.worktree_lock_wait_ms === 'number'
        ? rawMetrics.worktree_lock_wait_ms
        : typeof rawMetrics.worktreeLockWaitMs === 'number'
          ? rawMetrics.worktreeLockWaitMs
          : null

    const engineeringMetrics =
      astReductionRatio !== null || lyapunovIterations !== null
        ? {
            astReductionRatio,
            lyapunovIterations: lyapunovIterations ?? 0,
            orphanProcessCount,
            worktreeLockWaitMs,
          }
        : null

    lastReceipt = createProviderExecutionReceipt({
      provider: id,
      platform,
      intentSupport,
      executionTarget,
      transport,
      plan: executionPlan,
      request: executionPlan.request,
      status,
      startedAt,
      completedAt: new Date().toISOString(),
      output: {
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        parsed: parsedOutput,
      },
      metadata: {
        technicalGate: evaluateTechnicalReceiptGate({
          receipt: {
            status,
            metadata: {
              technicalIdle: parsedOutput?.data?.idle ?? null,
              gitExport: verifiedCommit ? parsedOutput.data.git_export : null,
            },
          },
        }),
        exitCode: result.status,
        lifecycleStatus,
        failureReason,
        verifiedArtifacts,
        verifiedCommit,
        qualification: { liveBinaryQualified: false, capabilities: qualifiedCapabilities },
        cleanup: {
          status:
            result.terminationConfirmed === false || lifecycleStatus === 'running'
              ? 'partial'
              : 'not-required',
          actions: [],
        },
        framing: parsedOutput?.framing ?? 'unknown',
        technicalIdle: parsedOutput?.data?.idle ?? null,
        sessionId,
        detached: Boolean(isDetached && sessionId),
        gitExport: verifiedCommit ? parsedOutput.data.git_export : null,
        engineeringMetrics,
        engineeringProfile: {
          id,
          version: profileVersion,
          bindingRevision: 1,
        },
      },
    })

    emitObservation(observer, {
      kind: 'meshloop_execution_attempt',
      state: status === 'pass' ? 'completed' : status === 'blocked' ? 'blocked' : 'failed',
      operationId: token,
      duration: performance.now() - started,
    })

    if (engineeringMetrics) {
      emitObservation(observer, {
        kind: 'meshloop_engineering_metrics',
        operationId: token,
        astReductionRatio: engineeringMetrics.astReductionRatio,
        lyapunovIterations: engineeringMetrics.lyapunovIterations,
        orphanProcessCount: engineeringMetrics.orphanProcessCount,
        worktreeLockWaitMs: engineeringMetrics.worktreeLockWaitMs,
        duration: performance.now() - started,
      })
    }

    return lastReceipt
  }

  const lifecycleCommand = (verb, sessionId, query) => {
    const storedPlan = activeSessions.get(sessionId)?.plan
    if (!storedPlan && !query.cwd) return null
    const original = storedPlan?.request ?? {}
    const args = [verb, '--session-id', sessionId, '--json']
    for (const [key, flag] of [
      ['configFile', '--config'],
      ['dbFile', '--db'],
      ['worktreeBase', '--worktree-base'],
    ]) {
      const value = storedPlan ? original[key] : query[key]
      if (value) args.push(flag, value)
    }
    return { args, cwd: storedPlan ? storedPlan.cwd : query.cwd }
  }

  const status = async (query = {}) => {
    const targetSessionId = query?.sessionId ?? lastReceipt?.metadata?.sessionId
    if (targetSessionId) {
      const context = lifecycleCommand('inspect', targetSessionId, query)
      if (!context)
        return {
          status: 'unknown',
          sessionId: targetSessionId,
          reason: 'Explicit workspace context required for unknown session',
        }
      const inspectArgs = context.args
      const result = await runProcess(spawn, executable, inspectArgs, {
        cwd: context.cwd ?? undefined,
        timeout: 10_000,
      })
      if (!result.error && result.status === 0) {
        try {
          const parsed = checkedEnvelope(result.stdout ?? '', 'inspect', targetSessionId)
          const remoteStatus = lifecycle(parsed.data)
          if (activeSessions.has(targetSessionId)) {
            activeSessions.get(targetSessionId).status = remoteStatus
          }
          return {
            status: remoteStatus,
            sessionId: targetSessionId,
            idle: parsed.data?.idle ?? null,
            data: parsed.data,
          }
        } catch {
          return {
            status: 'unknown',
            sessionId: targetSessionId,
            reason: 'Failed to parse inspect output',
          }
        }
      }
      if (!result.error) {
        try {
          const absent = parseMeshloopOutput(result.stdout)
          if (
            absent.raw.ok === false &&
            absent.command === 'meshloop:inspect' &&
            absent.raw.error === `MissingGraph(${JSON.stringify(targetSessionId)})`
          )
            return { status: 'absent', sessionId: targetSessionId }
        } catch {
          /* Ambiguous failures remain unknown. */
        }
      }
      return {
        status: 'unknown',
        sessionId: targetSessionId,
        reason: result.stderr || 'Inspect command failed',
      }
    }
    return lastReceipt ? { status: lastReceipt.status } : { status: 'idle' }
  }

  const cancel = async (query = {}) => {
    const targetSessionId = query?.sessionId ?? lastReceipt?.metadata?.sessionId
    if (targetSessionId) {
      const context = lifecycleCommand('cancel', targetSessionId, query)
      if (!context)
        return {
          status: 'unknown',
          sessionId: targetSessionId,
          reason: 'Explicit workspace context required for unknown session',
        }
      const cancelArgs = context.args
      const result = await runProcess(spawn, executable, cancelArgs, {
        cwd: context.cwd ?? undefined,
        timeout: 10_000,
      })
      if (!result.error && result.status === 0) {
        try {
          const parsed = checkedEnvelope(result.stdout ?? '', 'cancel', targetSessionId)
          if (lifecycle(parsed.data) !== 'cancelled') throw new Error('Cancellation not confirmed')
        } catch (error) {
          return { status: 'unknown', sessionId: targetSessionId, reason: error.message }
        }
        if (activeSessions.has(targetSessionId)) {
          activeSessions.get(targetSessionId).status = 'cancelled'
        }
        return {
          status: 'cancelled',
          sessionId: targetSessionId,
          ok: true,
        }
      }
      return {
        status: 'failed',
        sessionId: targetSessionId,
        reason: result.stderr || 'Cancel command failed',
      }
    }
    return {
      status: 'unsupported',
      reason: 'No session id provided to cancel detached Meshloop execution',
    }
  }

  const cleanup = async (query = {}) => {
    const targetSessionId = query?.sessionId ?? lastReceipt?.metadata?.sessionId
    if (targetSessionId && activeSessions.has(targetSessionId)) {
      activeSessions.delete(targetSessionId)
    }
    return {
      status: 'not-required',
      resources: [],
      reason: 'Local tracking released; remote resource cleanup is not verified',
    }
  }

  return {
    version: 1,
    id,
    platform,
    providerVersion,
    profileVersion,
    targets: [executionTarget],
    transports: [transport],
    intentSupport,
    osSupport,
    trust: { source: trustSource },
    inspect,
    plan,
    execute,
    status,
    cancel,
    cleanup,
    receipt: () => lastReceipt,
  }
}
