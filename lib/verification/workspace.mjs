import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { resolve, relative, isAbsolute, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createCandidateIdentity } from '../core/verification-observation.mjs'
import { emitObservation } from '../observability/observer.mjs'

export class WorktreeIngestionError extends Error {
  constructor(message, { code = 'WORKTREE_INGESTION_ERROR', details = null } = {}) {
    super(message)
    this.name = 'WorktreeIngestionError'
    this.code = code
    this.details = details
  }
}

export function containedPath(root, path, { allowMissing = false } = {}) {
  const base = resolve(root)
  const target = resolve(base, path)
  const rel = relative(base, target)
  if (!rel || rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel))
    throw new Error('Path must stay inside project')
  let current = base
  for (const part of ['', ...rel.split(sep)]) {
    current = part ? resolve(current, part) : current
    let info
    try {
      info = lstatSync(current)
    } catch (error) {
      if (allowMissing && error.code === 'ENOENT') continue
      throw error
    }
    if (info.isSymbolicLink()) throw new Error('Symlink or junction path is not permitted')
  }
  return target
}

export function fingerprintCandidate(root, definition, { observer } = {}) {
  if (!Array.isArray(definition.inputs) || !definition.inputs.length)
    throw new Error('Explicit candidate inputs are required')
  const inputs = {}
  for (const path of definition.inputs) {
    if (typeof path !== 'string' || path.replaceAll('\\', '/').split('/').includes('.git'))
      throw new Error('Invalid candidate input')
    const target = containedPath(root, path)
    if (!lstatSync(target).isFile()) throw new Error('Candidate input must be a regular file')
    const key = relative(resolve(root), target).replaceAll('\\', '/')
    if (Object.hasOwn(inputs, key)) throw new Error('Duplicate candidate input')
    const bytes = readFileSync(target)
    emitObservation(observer, {
      kind: 'file_read',
      bytes: bytes.length,
      files: 1,
      purpose: 'candidate',
    })
    inputs[key] = createHash('sha256').update(bytes).digest('hex')
  }
  return createCandidateIdentity({ inputs, context: definition.context ?? {} })
}

export function validateWorktreeGitExport(gitExport) {
  if (!gitExport || typeof gitExport !== 'object') {
    throw new WorktreeIngestionError('Git export metadata must be a non-null object', {
      code: 'INVALID_GIT_EXPORT',
    })
  }

  const commitSha = gitExport.commit_sha ?? gitExport.commitSha
  if (!commitSha || typeof commitSha !== 'string' || !/^[0-9a-fA-F]{40}$/.test(commitSha)) {
    throw new WorktreeIngestionError(
      'Git export commit SHA must be a 40-character hexadecimal string',
      {
        code: 'INVALID_COMMIT_SHA',
        details: { commitSha },
      },
    )
  }

  const branchRef = gitExport.branch_ref ?? gitExport.branchRef
  if (!branchRef || typeof branchRef !== 'string' || branchRef.trim() === '') {
    throw new WorktreeIngestionError('Git export branch reference must be a non-empty string', {
      code: 'INVALID_BRANCH_REF',
      details: { branchRef },
    })
  }

  const worktreePath = gitExport.worktree_path ?? gitExport.worktreePath ?? null
  const patchSha256 = gitExport.patch_sha256 ?? gitExport.patchSha256 ?? null

  return {
    commitSha: commitSha.toLowerCase(),
    branchRef: branchRef.trim(),
    worktreePath,
    patchSha256,
  }
}

export function ingestWorktreeCommit({
  root = process.cwd(),
  gitExport,
  gitExecutable = 'git',
  spawn = spawnSync,
  observer = null,
} = {}) {
  const normalizedExport = validateWorktreeGitExport(gitExport)
  const { commitSha, branchRef, worktreePath, patchSha256 } = normalizedExport

  // This observes local Git metadata only. It neither imports nor integrates a worktree.
  const inspectGit = (args, code) => {
    const result = spawn(gitExecutable, args, {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    })
    if (result.error || result.status !== 0 || typeof result.stdout !== 'string') {
      throw new WorktreeIngestionError('Git export metadata verification failed', { code })
    }
    return result.stdout
  }
  const objectType = inspectGit(['cat-file', '-t', commitSha], 'COMMIT_NOT_FOUND').trim()
  if (objectType !== 'commit')
    throw new WorktreeIngestionError('Exported object must be a commit', {
      code: 'INVALID_COMMIT_TYPE',
    })
  if (!branchRef.startsWith('refs/heads/') || /[\x00-\x20]/.test(branchRef))
    throw new WorktreeIngestionError('Exported branch must name refs/heads/', {
      code: 'INVALID_BRANCH_REF',
    })
  const branchCommit = inspectGit(
    ['rev-parse', '--verify', '--end-of-options', `${branchRef}^{commit}`],
    'BRANCH_NOT_FOUND',
  ).trim()
  if (branchCommit.toLowerCase() !== commitSha)
    throw new WorktreeIngestionError('Exported branch no longer identifies the commit', {
      code: 'BRANCH_COMMIT_MISMATCH',
    })
  const changedFiles = inspectGit(
    ['diff-tree', '--root', '--no-commit-id', '--name-only', '--no-renames', '-z', '-r', commitSha],
    'COMMIT_DIFF_FAILED',
  )
    .split('\0')
    .filter(Boolean)

  emitObservation(observer, {
    kind: 'meshloop_commit_inspected',
    commitSha,
    filesCount: changedFiles.length,
  })

  return {
    commitSha,
    branchRef,
    worktreePath,
    patchSha256,
    changedFiles,
    inspectedAt: new Date().toISOString(),
    verified: true,
    assurance: 'git-commit-metadata',
    integrated: false,
    artifactBytesVerified: false,
  }
}

export function evaluateTechnicalReceiptGate({ receipt } = {}) {
  if (!receipt || typeof receipt !== 'object') {
    throw new WorktreeIngestionError('Execution receipt is required for gate evaluation', {
      code: 'MISSING_RECEIPT',
    })
  }

  const technicalIdle = receipt.metadata?.technicalIdle
  const gitExport = receipt.metadata?.gitExport
  // Provider waiting state does not decide AgentFlow's delegation/review policy.
  const requiresHumanAcceptance = technicalIdle === 'AwaitingHumanAcceptance'

  return {
    technicalPassed: receipt.status === 'pass',
    sdlcAccepted: false, // Never auto-accept SDLC gate from technical receipt alone
    requiresHumanAcceptance,
    requiresSdlcAcceptance: true,
    gateClass: 'release-of-candidate',
    reason: requiresHumanAcceptance
      ? 'Provider is waiting for human acceptance; AgentFlow acceptance remains separate'
      : 'Evaluate AgentFlow acceptance under the run policy and delegation authority',
    gitExport: gitExport ? validateWorktreeGitExport(gitExport) : null,
  }
}
