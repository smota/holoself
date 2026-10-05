import { spawnSync } from 'node:child_process'
import { createProviderExecutionReceipt, providerDigest } from './provider-receipt.mjs'
import { emitObservation } from '../observability/observer.mjs'

function digest(value) {
  return providerDigest(value)
}

function safeEnvironment(source = process.env) {
  const allowed = [
    'PATH',
    'Path',
    'HOME',
    'USERPROFILE',
    'TMP',
    'TEMP',
    'SystemRoot',
    'ComSpec',
    'PATHEXT',
  ]
  return Object.fromEntries(allowed.filter((key) => source[key]).map((key) => [key, source[key]]))
}

export function inspectExecutable({ executable, args = ['--version'], cwd, spawn = spawnSync }) {
  if (!executable || /[;&|<>]/.test(executable)) {
    return { availability: 'unavailable', reason: 'executable must be a bare command or path' }
  }
  const result = spawn(executable, args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: 10_000,
    env: safeEnvironment(),
  })
  if (result.error || result.status !== 0) {
    return {
      availability: 'unavailable',
      reason: result.error?.message ?? `probe exited ${result.status}`,
    }
  }
  return {
    availability: 'available',
    reason: `${executable} responded to a non-shell version probe`,
    metadata: { version: String(result.stdout || result.stderr || '').trim() || null },
  }
}

export function inspectFlagIntents({
  executable,
  cwd,
  spawn = spawnSync,
  declared = [],
  flags = {},
}) {
  const result = spawn(executable, ['--help'], {
    cwd,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: 10_000,
    env: safeEnvironment(),
  })
  if (result.error || result.status !== 0) return declared
  const output = String(result.stdout || result.stderr || '')
  const support = new Map(declared.map((item) => [item.id, item]))
  for (const [id, markers] of Object.entries(flags)) {
    if ((Array.isArray(markers) ? markers : [markers]).every((marker) => output.includes(marker))) {
      support.set(id, {
        id,
        implementation: 'native',
        fidelity: 'full',
        evidence: 'probed',
        limits: {},
      })
    }
  }
  return [...support.values()]
}

export function createLocalCliProvider({
  id,
  platform,
  executable,
  executionTarget,
  transport = 'local-cli',
  delegationBoundary = 'current-session',
  intentSupport = [
    {
      id: 'plan-before-edit',
      implementation: 'emulated',
      fidelity: 'full',
      evidence: 'contract-tested',
      limits: {},
    },
    {
      id: 'workflow-orchestration',
      implementation: 'emulated',
      fidelity: 'full',
      evidence: 'contract-tested',
      limits: {},
    },
    {
      id: 'bounded-loop',
      implementation: 'emulated',
      fidelity: 'full',
      evidence: 'contract-tested',
      limits: { maxIterationsRequired: true },
    },
  ],
  providerVersion = '1.0.0',
  osSupport = ['win32', 'linux', 'darwin'],
  trustSource = 'project configuration',
  compatibility = '^1',
  policy = {},
  prepareArgs = (value) => value,
  modelFlag = null,
  qualifiedModels = [],
  qualifiedCapabilities = [],
  inspectIntentSupport,
  args = ['--version'],
  cwd,
  spawn,
  observer,
} = {}) {
  if (!platform) throw new Error('local CLI provider platform identity is required')
  let lastReceipt = null
  let lastOutput = null
  const plan = (request = {}) => {
    const base = {
      version: 1,
      provider: id,
      platform,
      executable,
      args: [
        ...(request.model && modelFlag ? [modelFlag, request.model] : []),
        ...prepareArgs(Array.isArray(request.args) ? request.args : [], request),
      ],
      cwd: request.cwd ?? cwd ?? null,
      timeoutMs: request.timeoutMs ?? 120_000,
      policy,
      request,
    }
    return { ...base, token: digest(base) }
  }
  const execute = (executionPlan, { confirm } = {}) => {
    const { token, ...base } = executionPlan ?? {}
    if (executionPlan?.provider !== id || confirm !== token || digest(base) !== token) {
      throw new Error('provider execution confirmation or plan digest is invalid')
    }
    const startedAt = new Date().toISOString()
    const started = performance.now()
    emitObservation(observer, { kind: 'execution_attempt', state: 'started', operationId: token })
    const result = (spawn ?? spawnSync)(executable, executionPlan.args, {
      cwd: executionPlan.cwd ?? undefined,
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: executionPlan.timeoutMs,
      maxBuffer: 1024 * 1024,
      env: safeEnvironment(),
    })
    lastOutput = { stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
    lastReceipt = createProviderExecutionReceipt({
      provider: id,
      platform,
      intentSupport,
      executionTarget,
      transport,
      plan: executionPlan,
      request: executionPlan.request,
      status: result.error ? 'failed' : result.status === 0 ? 'pass' : 'failed',
      startedAt,
      completedAt: new Date().toISOString(),
      output: lastOutput,
      metadata: {
        exitCode: result.status,
        outcomeUnknown: result.error?.code === 'ETIMEDOUT',
        engineeringProfile: executionPlan.request?.engineeringProfile ?? null,
        cleanup: { status: 'not-required', actions: [] },
      },
    })
    emitObservation(observer, {
      kind: 'execution_attempt',
      state: lastReceipt.status === 'pass' ? 'completed' : 'failed',
      operationId: token,
      duration: performance.now() - started,
    })
    return lastReceipt
  }
  const operations = {
    execute,
    evidence: () => lastReceipt,
  }
  return {
    version: 1,
    id,
    platform,
    providerVersion,
    spiRange: { min: 1, max: 1 },
    facets: ['execution', 'evidence'],
    intentSupport,
    targets: executionTarget ? [executionTarget] : [],
    transports: transport ? [transport] : [],
    osSupport,
    trust: { source: trustSource },
    compatibility: { agentflow: compatibility },
    policy,
    operations,
    plan,
    selectModel: modelFlag
      ? (executionPlan, model) =>
          executionPlan.args?.[0] === modelFlag && executionPlan.args?.[1] === model ? model : null
      : undefined,
    execute,
    status: () => (lastReceipt ? { status: lastReceipt.status } : { status: 'idle' }),
    cancel: () => ({ status: 'unsupported', reason: 'local CLI execution is synchronous' }),
    cleanup: () => ({ status: 'clean', resources: [] }),
    receipt: operations.evidence,
    readOutput: (executionPlan, receipt) =>
      receipt === lastReceipt && executionPlan?.token === lastReceipt?.planDigest
        ? lastOutput
        : null,
    async inspect() {
      const executableResult = inspectExecutable({ executable, args, cwd, spawn })
      const observedSupport =
        executableResult.availability === 'available' && inspectIntentSupport
          ? await inspectIntentSupport({ executable, cwd, spawn, declared: intentSupport })
          : intentSupport
      return {
        ...executableResult,
        executionTarget,
        platform,
        transport,
        delegationBoundary,
        intentSupport: observedSupport,
        qualification: {
          models: executableResult.availability === 'available' ? qualifiedModels : [],
          capabilities: executableResult.availability === 'available' ? qualifiedCapabilities : [],
        },
      }
    },
  }
}
