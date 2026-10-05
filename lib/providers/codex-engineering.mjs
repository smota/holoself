import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  lstatSync,
  realpathSync,
  statSync,
  unlinkSync,
  rmdirSync,
} from 'node:fs'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { createProviderExecutionReceipt, providerDigest } from './provider-receipt.mjs'
import { safePath } from '../core/delegation-grant.mjs'

const VERSION = 1
const MAX_OUTPUT = 32 * 1024
const MAX_ARTIFACT = 10 * 1024 * 1024
const MAX_WORKSPACE_FILES = 20000
const MAX_WORKSPACE_BYTES = 512 * 1024 * 1024
const intentSupport = [
  {
    id: 'file-edit',
    implementation: 'adapter',
    fidelity: 'full',
    evidence: 'contract-tested',
    limits: { boundedOutputBytes: MAX_OUTPUT },
  },
  {
    id: 'structured-result',
    implementation: 'native',
    fidelity: 'full',
    evidence: 'probed',
    limits: {},
  },
]

function sha(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function resolveExecutable(executable, spawn) {
  if (executable) return executable
  if (process.platform !== 'win32') return 'codex'
  const found = spawn('where.exe', ['codex.exe'], {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: 5000,
  })
  const candidate = String(found.stdout ?? '')
    .split(/\r?\n/)
    .find((line) => line.toLowerCase().endsWith('codex.exe'))
  return found.status === 0 && candidate ? candidate : null
}

function receiptSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['status', 'operationId', 'candidateDigest', 'artifacts'],
    properties: {
      status: { type: 'string', enum: ['pass', 'failed'] },
      operationId: { type: 'string' },
      candidateDigest: { type: 'string' },
      artifacts: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['path'],
          properties: { path: { type: 'string' } },
        },
      },
    },
  }
}

function safeArtifact(root, path) {
  if (!safePath(path)) throw new Error('Unsafe returned artifact path')
  const rootReal = realpathSync(root)
  const target = realpathSync(resolve(rootReal, path))
  const rel = relative(rootReal, target)
  if (rel.startsWith('..') || isAbsolute(rel))
    throw new Error('Returned artifact escapes workspace')
  const stat = statSync(target)
  if (!stat.isFile() || stat.size > MAX_ARTIFACT)
    throw new Error('Returned artifact is not a bounded file')
  const bytes = readFileSync(target)
  return {
    path,
    contentBase64: bytes.toString('base64'),
    sha256: sha(bytes),
    byteLength: bytes.length,
  }
}

function hasLocalGitDirectory(root) {
  try {
    return lstatSync(join(root, '.git')).isDirectory()
  } catch {
    return false
  }
}

function workspaceSnapshot(root, excludedScratch) {
  const entries = new Map()
  let files = 0
  let bytes = 0
  const pending = [{ absolute: root, relative: '' }]
  while (pending.length) {
    const current = pending.pop()
    for (const item of readdirSync(current.absolute, { withFileTypes: true })) {
      const relativePath = current.relative ? `${current.relative}/${item.name}` : item.name
      const absolute = join(current.absolute, item.name)
      if (absolute === excludedScratch) continue
      const stat = lstatSync(absolute)
      if (++files > MAX_WORKSPACE_FILES)
        throw new Error('Workspace file count exceeds engineering bound')
      if (stat.isDirectory()) {
        entries.set(relativePath, 'directory')
        pending.push({ absolute, relative: relativePath })
      } else if (stat.isSymbolicLink()) {
        throw new Error('Workspace symlinks are unsupported for bounded engineering')
      } else if (stat.isFile()) {
        bytes += stat.size
        if (stat.size > MAX_ARTIFACT || bytes > MAX_WORKSPACE_BYTES)
          throw new Error('Workspace byte count exceeds engineering bound')
        entries.set(relativePath, `file:${sha(readFileSync(absolute))}`)
      } else throw new Error('Unsupported workspace entry type')
    }
  }
  return entries
}

function changedEntries(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])].filter(
    (path) => before.get(path) !== after.get(path),
  )
}

function withinDeclaredScope(path, allowed, directory) {
  return (
    allowed.includes(path) || (directory && allowed.some((entry) => entry.startsWith(`${path}/`)))
  )
}

export function createCodexEngineeringProvider({
  cwd,
  model,
  executable,
  writeQualified = false,
  spawn = spawnSync,
} = {}) {
  if (!cwd || !model || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(model))
    throw new Error('Codex engineering requires an explicit workspace and model')
  const root = realpathSync(cwd)
  const binary = resolveExecutable(executable, spawn)
  let lastReceipt = null
  let lastOutput = null
  const inspect = async () => {
    if (!binary || (process.platform === 'win32' && /\.(cmd|bat)$/i.test(binary)))
      return { availability: 'unavailable', reason: 'Native Codex executable required on Windows' }
    const version = spawn(binary, ['--version'], {
      cwd: root,
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: 10000,
    })
    const help = spawn(binary, ['exec', '--help'], {
      cwd: root,
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: 10000,
    })
    const text = `${help.stdout ?? ''}\n${help.stderr ?? ''}`
    const available =
      version.status === 0 &&
      help.status === 0 &&
      [
        '--model',
        '--sandbox',
        '--output-schema',
        '--output-last-message',
        '--ephemeral',
        '--ignore-user-config',
      ].every((flag) => text.includes(flag))
    const writeAvailable = writeQualified && hasLocalGitDirectory(root)
    return {
      availability: available ? 'available' : 'unavailable',
      reason: available
        ? 'Required Codex exec flags observed'
        : 'Required Codex exec flags unavailable',
      executionTarget: 'codex-cli',
      intentSupport: available ? intentSupport : [],
      qualification: {
        capabilities: available
          ? [...(writeAvailable ? ['file-edit'] : []), 'structured-result']
          : [],
        models: available ? [model] : [],
        liveModelQualified: false,
        liveEditQualified: writeAvailable,
        version: String(version.stdout ?? '').trim() || null,
      },
    }
  }
  const plan = (request = {}) => {
    if (request.model !== model) throw new Error('Configured Codex model mismatch')
    if (!['observe', 'propose', 'write', 'mutate-worktree'].includes(request.boundary))
      throw new Error('Codex engineering boundary unsupported')
    const profile = request.engineeringProfile
    if (!profile?.operationId || !/^[a-f0-9]{64}$/.test(profile.candidateDigest ?? ''))
      throw new Error('Codex engineering operation and candidate required')
    const prompt = request.prompt ?? request.task
    if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > 16 * 1024)
      throw new Error('Bounded engineering prompt required')
    const allowedPaths = request.allowedPaths ?? []
    if (
      !Array.isArray(allowedPaths) ||
      allowedPaths.some((path) => !safePath(path)) ||
      (!['observe', 'propose'].includes(request.boundary) && !allowedPaths.length)
    )
      throw new Error('Explicit safe operation paths required for edit')
    const sandbox = ['observe', 'propose'].includes(request.boundary)
      ? 'read-only'
      : 'workspace-write'
    if (sandbox === 'workspace-write' && !hasLocalGitDirectory(root))
      throw new Error(
        'Write qualification requires a local Git directory; linked worktrees are unsupported',
      )
    const base = {
      version: VERSION,
      provider: 'codex-engineering-cli',
      platform: 'codex',
      cwd: root,
      model,
      sandbox,
      invocation: [
        'exec',
        '--ephemeral',
        '--ignore-user-config',
        '--model',
        model,
        '--sandbox',
        sandbox,
      ],
      prompt,
      allowedPaths,
      request,
      timeoutMs: request.timeoutMs ?? 60000,
    }
    return { ...base, token: providerDigest(base) }
  }
  const execute = (executionPlan, { confirm } = {}) => {
    const { token, ...base } = executionPlan ?? {}
    if (
      confirm !== token ||
      providerDigest(base) !== token ||
      base.provider !== 'codex-engineering-cli' ||
      base.cwd !== root ||
      base.model !== model ||
      JSON.stringify(base.allowedPaths) !== JSON.stringify(base.request?.allowedPaths) ||
      !['read-only', 'workspace-write'].includes(base.sandbox) ||
      JSON.stringify(base.invocation) !==
        JSON.stringify([
          'exec',
          '--ephemeral',
          '--ignore-user-config',
          '--model',
          model,
          '--sandbox',
          base.sandbox,
        ]) ||
      base.sandbox !==
        (['observe', 'propose'].includes(base.request?.boundary) ? 'read-only' : 'workspace-write')
    )
      throw new Error('Codex engineering plan confirmation invalid')
    const scratchRoot = join(root, '.agent-runs', 'engineering')
    mkdirSync(scratchRoot, { recursive: true })
    const scratch = mkdtempSync(join(scratchRoot, 'codex-'))
    const schemaPath = join(scratch, 'result.schema.json')
    const resultPath = join(scratch, 'result.json')
    const startedAt = new Date().toISOString()
    try {
      const before = workspaceSnapshot(root, scratch)
      writeFileSync(schemaPath, JSON.stringify(receiptSchema()), { flag: 'wx' })
      const profile = executionPlan.request.engineeringProfile
      const prompt = `${executionPlan.prompt}\nReturn only the required structured result. operationId=${profile.operationId}; candidateDigest=${profile.candidateDigest}. List only paths you actually changed. Do not claim AgentFlow acceptance.`
      const args = [
        ...executionPlan.invocation,
        '--output-schema',
        schemaPath,
        '--output-last-message',
        resultPath,
        '--cd',
        root,
        prompt,
      ]
      const result = spawn(binary, args, {
        cwd: root,
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
        timeout: executionPlan.timeoutMs,
        maxBuffer: 256 * 1024,
      })
      const after = workspaceSnapshot(root, scratch)
      const changed = changedEntries(before, after)
      const outOfScope = changed.filter(
        (path) =>
          !withinDeclaredScope(path, executionPlan.allowedPaths, after.get(path) === 'directory'),
      )
      let status = 'failed'
      let failureReason = result.error
        ? String(result.error.code ?? 'CLI_EXECUTION_ERROR')
        : result.status === 0
          ? null
          : `CLI_EXIT_${result.status}`
      let outcomeUnknown = result.error?.code === 'ETIMEDOUT' || outOfScope.length > 0
      let output = { stdout: '', stderr: '' }
      if (outOfScope.length) failureReason = 'OUT_OF_SCOPE_WORKSPACE_EFFECT'
      if (!result.error && result.status === 0 && !outOfScope.length) {
        try {
          const raw = readFileSync(resultPath)
          if (raw.length > MAX_OUTPUT) throw new Error('Structured result exceeds output budget')
          const parsed = JSON.parse(raw.toString('utf8'))
          if (
            parsed.operationId !== profile.operationId ||
            parsed.candidateDigest !== profile.candidateDigest ||
            !['pass', 'failed'].includes(parsed.status) ||
            !Array.isArray(parsed.artifacts)
          )
            throw new Error('Structured result identity or status invalid')
          const changedFiles = changed.filter((path) => after.get(path)?.startsWith('file:'))
          const reported = parsed.artifacts.map((item) => item.path)
          if (
            parsed.status === 'pass' &&
            (new Set(reported).size !== reported.length ||
              reported.length !== changedFiles.length ||
              reported.some((path) => !changedFiles.includes(path)) ||
              changed.some((path) => !after.has(path)))
          )
            throw new Error('Structured artifacts do not match actual workspace changes')
          const artifacts =
            parsed.status === 'pass' ? changedFiles.map((path) => safeArtifact(root, path)) : []
          const neutral = {
            status: parsed.status,
            operationId: profile.operationId,
            candidateDigest: profile.candidateDigest,
            artifacts,
          }
          const stdout = JSON.stringify(neutral)
          if (Buffer.byteLength(stdout) > MAX_OUTPUT)
            throw new Error('Verified result exceeds output budget')
          output = { stdout, stderr: '' }
          status = parsed.status
        } catch {
          failureReason = 'STRUCTURED_RESULT_INVALID'
        }
      }
      if (changed.length && status !== 'pass') outcomeUnknown = true
      lastOutput = output
      lastReceipt = createProviderExecutionReceipt({
        provider: 'codex-engineering-cli',
        platform: 'codex',
        intentSupport,
        executionTarget: 'codex-cli',
        transport: 'local-cli',
        plan: executionPlan,
        request: executionPlan.request,
        status,
        startedAt,
        completedAt: new Date().toISOString(),
        output,
        metadata: {
          engineeringProfile: profile,
          exitCode: result.status,
          outcomeUnknown,
          failureReason,
          modelSelection: { requested: model, invocationBound: true, serverObserved: false },
          cleanup: { status: 'not-required', actions: [] },
        },
      })
      return lastReceipt
    } finally {
      for (const path of [schemaPath, resultPath]) {
        try {
          unlinkSync(path)
        } catch {
          /* absent */
        }
      }
      try {
        rmdirSync(scratch)
      } catch {
        /* preserve unexpected scratch content */
      }
    }
  }
  return {
    version: VERSION,
    id: 'codex-engineering-cli',
    platform: 'codex',
    targets: ['codex-cli'],
    intentSupport,
    plan,
    execute,
    inspect,
    selectModel: (executionPlan, selected) =>
      selected === model &&
      executionPlan.invocation?.[3] === '--model' &&
      executionPlan.invocation?.[4] === model
        ? model
        : null,
    readOutput: (executionPlan, receipt) =>
      receipt === lastReceipt && executionPlan.token === receipt.planDigest ? lastOutput : null,
    status: () => (lastReceipt ? { status: lastReceipt.status } : { status: 'idle' }),
    cancel: () => ({ status: 'unsupported', reason: 'Synchronous Codex CLI invocation' }),
    receipt: () => lastReceipt,
  }
}
