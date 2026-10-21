import { readFileSync, lstatSync, realpathSync, statSync, opendirSync } from 'node:fs'
import { join, resolve, delimiter, isAbsolute, relative, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { validateConfigAuthority } from '../config/authority.mjs'
import { normalizeSdlcConfig, validateSdlcConfigShape } from '../sdlc-state.mjs'
import { POSTURES } from '../sdlc-vocabulary.mjs'
import { inspectHarnessIntelligence } from '../config/harness-intelligence.mjs'
import { adapterStatus, HARNESS_TARGETS } from '../skill-adapters.mjs'
import { roleAdapterStatus, HARNESS_ROLE_TARGETS } from '../role-adapters.mjs'
import { pluginStatus } from '../plugin-manifests.mjs'
import { harnessSettingsStatus } from '../structural-merge.mjs'
import { validateAdoptionLock } from '../adoption/lock-validation.mjs'
import { LOCKFILE_NAME } from '../lockfile.mjs'
import { assessRuntimeEvidence } from '../onboarding/runtime-handoff.mjs'

export const MAX_FILE_SIZE = 10 * 1024 * 1024
export const MAX_AGGREGATE_SIZE = 64 * 1024 * 1024
export const MAX_ENTRIES = 2048
export const MAX_DETAILED_FINDINGS = 512
const sha256 = (content) => createHash('sha256').update(content).digest('hex')
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const hash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const contained = (root, target) => {
  const rel = relative(root, target)
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)
}
export function isSafePath(root, target) {
  return typeof target === 'string' && contained(resolve(root), resolve(root, target))
}
function safeRelativePath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    !isAbsolute(value) &&
    !/^[a-z]:/i.test(value) &&
    !/[\\\x00-\x1f]/.test(value) &&
    !value.split('/').some((part) => !part || part === '.' || part === '..') &&
    !value
      .split('/')
      .some((part) => /^(?:\.env(?:\..*)?|credentials?|auth\.json|.*\.(?:pem|key))$/i.test(part))
  )
}
function identity(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':')
}
// A cooperative, bounded project snapshot, not a host isolation/sandbox mechanism.
export function createReadScope() {
  return {
    bytes: 0,
    entries: 0,
    incomplete: false,
    snapshots: new Map(),
    directories: new Map(),
    absences: new Set(),
  }
}
function guardedPath(root, input) {
  const base = resolve(root)
  const full = resolve(base, input)
  if (!contained(base, full)) throw new Error('path-escapes-root')
  const rootStat = lstatSync(base)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('invalid-root')
  const realRoot = realpathSync(base)
  let current = base
  for (const part of relative(base, full).split(sep).filter(Boolean)) {
    current = join(current, part)
    const stat = lstatSync(current)
    // Reject even in-root symlinks: delegated legacy readers must never follow aliases.
    if (stat.isSymbolicLink()) throw new Error('symlink-escapes-root')
  }
  if (!contained(realRoot, realpathSync(full))) throw new Error('path-escapes-root')
  return full
}
export function safeReadFileUtf8(root, input, maxBytes = MAX_FILE_SIZE, scope = createReadScope()) {
  try {
    const rel = relative(resolve(root), resolve(root, input)).replaceAll('\\', '/')
    if (rel && !safeRelativePath(rel)) return { ok: false, error: 'excluded-input-path' }
    const full = guardedPath(root, input)
    const before = lstatSync(full)
    if (!before.isFile()) return { ok: false, error: 'not-a-file' }
    const cached = scope.snapshots.get(full)
    if (cached) {
      if (cached.identity !== identity(before)) {
        scope.incomplete = true
        return { ok: false, error: 'changed-during-read' }
      }
      return cached.result
    }
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 0 ||
      before.size > Math.min(maxBytes, MAX_FILE_SIZE)
    ) {
      scope.incomplete = true
      return { ok: false, error: 'exceeds-max-size' }
    }
    if (scope.entries >= MAX_ENTRIES || scope.bytes + before.size > MAX_AGGREGATE_SIZE) {
      scope.incomplete = true
      return { ok: false, error: 'inspection-budget-exhausted' }
    }
    scope.entries++
    scope.bytes += before.size
    const bytes = readFileSync(full)
    const after = lstatSync(guardedPath(root, input))
    if (identity(before) !== identity(after) || bytes.length !== before.size) {
      scope.incomplete = true
      return { ok: false, error: 'changed-during-read' }
    }
    const result = { ok: true, content: bytes.toString('utf8'), hash: sha256(bytes) }
    scope.snapshots.set(full, { identity: identity(after), result, root, input })
    return result
  } catch (error) {
    const known = ['path-escapes-root', 'symlink-escapes-root', 'invalid-root']
    if (error.code === 'ENOENT' && isSafePath(root, input)) scope.absences.add(resolve(root, input))
    return {
      ok: false,
      error:
        error.code === 'ENOENT'
          ? 'not-found'
          : known.includes(error.message)
            ? error.message
            : 'read-error',
    }
  }
}
export function hashFileSha256(filePath, maxBytes = MAX_FILE_SIZE) {
  const read = safeReadFileUtf8(resolve(filePath, '..'), filePath, maxBytes)
  return read.ok ? read.hash : null
}
function readJson(root, path, scope) {
  const read = safeReadFileUtf8(root, path, MAX_FILE_SIZE, scope)
  if (!read.ok) return read
  try {
    return { ...read, value: JSON.parse(read.content) }
  } catch {
    return { ok: false, error: 'invalid-json' }
  }
}
function observation(id, dimension, target, structural, reason, extras = {}) {
  return {
    id,
    dimension,
    target,
    structural,
    alignment: 'unknown',
    reason,
    proposedChange:
      structural === 'missing' || structural === 'invalid'
        ? 'Inspect and explicitly repair ' + target + '.'
        : null,
    preservedPaths: ['AGENTS.md', 'agent-workflow.config.json'],
    evidence: {},
    ...extras,
  }
}
function readFailure(id, dimension, target, read) {
  return observation(
    id,
    dimension,
    target,
    read.error === 'not-found'
      ? 'missing'
      : read.error.includes('budget') || read.error === 'changed-during-read'
        ? 'unknown'
        : 'invalid',
    target + ' could not be safely inspected.',
    { evidence: { error: read.error } },
  )
}
export function verifyReadScope(scope) {
  for (const [full, expected] of scope.directories) {
    try {
      if (identity(lstatSync(full)) !== expected) return false
    } catch {
      return false
    }
  }
  for (const full of scope.absences) {
    try {
      lstatSync(full)
      return false
    } catch (error) {
      if (error.code !== 'ENOENT') return false
    }
  }
  for (const [full, snapshot] of scope.snapshots) {
    try {
      if (identity(lstatSync(guardedPath(snapshot.root, snapshot.input))) !== snapshot.identity)
        return false
    } catch {
      return false
    }
  }
  return true
}

export function readProjectConfigs({ targetDir, scope = createReadScope() }) {
  const root = resolve(targetDir)
  const findings = []
  const workflow = readJson(root, 'agent-workflow.config.json', scope)
  let domain = readJson(root, 'sdlc.config.json', scope)
  let domainPath = 'sdlc.config.json'
  if (!domain.ok && domain.error === 'not-found') {
    const alternative = readJson(root, '.agentflow/sdlc.config.json', scope)
    if (alternative.ok || alternative.error !== 'not-found') {
      domain = alternative
      domainPath = '.agentflow/sdlc.config.json'
    }
  }
  if (!workflow.ok)
    findings.push(
      readFailure('config.workflow', 'project-configs', 'agent-workflow.config.json', workflow),
    )
  else {
    const valid =
      object(workflow.value) &&
      (workflow.value.posture === undefined || POSTURES.includes(workflow.value.posture))
    findings.push(
      observation(
        'config.workflow',
        'project-configs',
        'agent-workflow.config.json',
        valid ? 'valid' : 'invalid',
        valid
          ? 'Workflow configuration is structurally valid; confirmation is separate.'
          : 'Workflow configuration has an invalid shape or noncanonical posture.',
        {
          evidence: valid
            ? { posture: workflow.value.posture ?? null }
            : { error: 'invalid-workflow-shape' },
        },
      ),
    )
  }
  if (!domain.ok) findings.push(readFailure('config.sdlc', 'project-configs', domainPath, domain))
  else {
    let valid = false
    try {
      valid = object(domain.value) && validateSdlcConfigShape(normalizeSdlcConfig(domain.value)).ok
    } catch {
      /* invalid */
    }
    findings.push(
      observation(
        'config.sdlc',
        'project-configs',
        domainPath,
        valid ? 'valid' : 'invalid',
        valid
          ? 'SDLC configuration satisfies domain schema shape; no defaults establish confirmation.'
          : 'SDLC configuration shape is invalid.',
      ),
    )
  }
  if (workflow.ok && domain.ok && object(workflow.value) && object(domain.value)) {
    const authority = validateConfigAuthority({ domain: domain.value, workflow: workflow.value })
    findings.push(
      observation(
        'config.authority',
        'project-configs',
        domainPath,
        authority.ok ? 'valid' : 'invalid',
        authority.ok
          ? 'Configuration authority separation is valid.'
          : 'Configuration authority separation is invalid.',
        {
          evidence: {
            errorsCount: authority.errors.length,
            warningsCount: authority.warnings.length,
          },
        },
      ),
    )
  } else
    findings.push(
      observation(
        'config.authority',
        'project-configs',
        domainPath,
        'unknown',
        'Authority requires valid explicit domain and workflow inputs.',
      ),
    )

  const names = [
    'orchestration-model.json',
    'execution-policy.json',
    'model-catalog.json',
    'harness-parameters.json',
  ]
  let invalid = false
  for (const name of names) {
    const path = '.agentflow/' + name
    const read = readJson(root, path, scope)
    if (!read.ok) {
      findings.push(readFailure('config.pillar.' + name, 'project-configs', path, read))
      if (read.error !== 'not-found') invalid = true
    } else {
      const valid = object(read.value)
      invalid ||= !valid
      findings.push(
        observation(
          'config.pillar.' + name,
          'project-configs',
          path,
          valid ? 'valid' : 'invalid',
          valid
            ? 'Explicit pillar configuration is valid JSON object.'
            : 'Pillar must be a JSON object.',
        ),
      )
    }
  }
  if (!invalid) {
    try {
      // Owning helper accepts a path string and returns counts, not configured/expected arrays.
      const pillars = inspectHarnessIntelligence(root)
      if (!verifyReadScope(scope)) throw new Error('changed')
      findings.push(
        observation(
          'config.pillars',
          'project-configs',
          '.agentflow/',
          pillars.configuredCount === pillars.totalPillars ? 'valid' : 'missing',
          'Observed ' +
            pillars.configuredCount +
            ' of ' +
            pillars.totalPillars +
            ' explicit pillars.',
          {
            evidence: {
              configuredCount: pillars.configuredCount,
              totalPillars: pillars.totalPillars,
            },
          },
        ),
      )
    } catch {
      findings.push(
        observation(
          'config.pillars',
          'project-configs',
          '.agentflow/',
          'unknown',
          'Pillar snapshot could not be confirmed.',
        ),
      )
    }
  } else
    findings.push(
      observation(
        'config.pillars',
        'project-configs',
        '.agentflow/',
        'invalid',
        'One or more explicit pillars could not be safely validated.',
      ),
    )
  return findings
}
function checkedLock(root, scope) {
  const read = readJson(root, LOCKFILE_NAME, scope)
  if (!read.ok) return read
  if (!object(read.value) || !Array.isArray(read.value.entries))
    return { ok: false, error: 'invalid-lock' }
  if (read.value.entries.length > MAX_ENTRIES) {
    scope.incomplete = true
    return { ok: false, error: 'inspection-budget-exhausted' }
  }
  try {
    validateAdoptionLock(read.value)
    return read
  } catch {
    return { ok: false, error: 'invalid-lock' }
  }
}
export function readLockfile({ targetDir, scope = createReadScope() }) {
  const read = checkedLock(resolve(targetDir), scope)
  return [
    read.ok
      ? observation(
          'lock.presence',
          'lock-integrity',
          LOCKFILE_NAME,
          'valid',
          'Canonical adoption lock is structurally valid.',
          { evidence: { entriesCount: read.value.entries.length } },
        )
      : readFailure('lock.presence', 'lock-integrity', LOCKFILE_NAME, read),
  ]
}
function retainedReceipt(root, scope) {
  const journal = safeReadFileUtf8(root, '.agentflow-adoption-journal.json', MAX_FILE_SIZE, scope)
  if (!journal.ok) return null
  // Only acknowledged complete journals; incomplete tails cannot establish confirmation.
  if (!journal.content.endsWith('\n')) {
    scope.incomplete = true
    return null
  }
  try {
    const records = journal.content.trim().split(/\r?\n/)
    if (records.length > MAX_ENTRIES) {
      scope.incomplete = true
      return null
    }
    const values = records.map((line) => JSON.parse(line))
    const receiptPath =
      values.find((v) => v.type === 'receipt-ready')?.path ?? values[0]?.receiptPath
    // External default receipts require an explicit caller input; never read outside the project.
    if (!receiptPath || !isSafePath(root, receiptPath)) return null
    const read = readJson(root, receiptPath, scope)
    return read.ok ? read.value : null
  } catch {
    return null
  }
}
export function readBaselineAlignment({
  targetDir,
  baselineReceipt = null,
  scope = createReadScope(),
}) {
  const root = resolve(targetDir)
  const receipt = baselineReceipt ?? retainedReceipt(root, scope)
  const unknown = (reason, structural = 'unknown', evidence = {}) => [
    observation('baseline.receipt', 'lock-integrity', 'baseline', structural, reason, { evidence }),
  ]
  if (!receipt)
    return unknown('No applicable retained receipt is available; baseline alignment is unknown.')
  if (!object(receipt) || !Array.isArray(receipt.mutations) || receipt.mutations.length === 0)
    return unknown('Receipt has no valid tracked mutations.', 'invalid')
  const total = receipt.mutations.length
  if (total > MAX_ENTRIES) {
    scope.incomplete = true
    return unknown(
      'Receipt coverage exceeds the inspection bound; baseline alignment is unknown.',
      'unknown',
      { totalEntries: total, inspectedEntries: 0, uninspectedEntries: total },
    )
  }
  const { receiptToken, ...base } = receipt
  if (
    receipt.version !== 1 ||
    receipt.target !== root.replaceAll('\\', '/') ||
    !hash(receipt.planToken) ||
    !hash(receiptToken) ||
    sha256(JSON.stringify(base)) !== receiptToken ||
    !Array.isArray(receipt.changed) ||
    receipt.changed.length !== total ||
    receipt.changed.some((p, i) => p !== receipt.mutations[i]?.path)
  ) {
    return unknown(
      'Receipt seal, schema or target binding is invalid; no confirmed baseline match.',
      'invalid',
    )
  }
  const lock = checkedLock(root, scope)
  if (
    !lock.ok ||
    lock.value.planToken !== receipt.planToken ||
    lock.value.profile !== receipt.profile
  )
    return unknown('Receipt is not bound to a valid current adoption lock.')
  const lockMutation = receipt.mutations.find((m) => m?.path === LOCKFILE_NAME)
  if (!lockMutation || lockMutation.afterHash !== lock.hash)
    return unknown('Receipt does not confirm the current adoption lock bytes.')
  const entries = new Map(lock.value.entries.map((entry) => [entry.target, entry]))
  const seen = new Set()
  const findings = []
  let matched = 0
  let uncertain = false
  for (let i = 0; i < total; i++) {
    const mutation = receipt.mutations[i]
    const path = mutation?.path
    if (
      !object(mutation) ||
      !safeRelativePath(path) ||
      !hash(mutation.afterHash) ||
      seen.has(path)
    ) {
      uncertain = true
      findings.push(
        observation(
          'baseline.entry.' + i,
          'lock-integrity',
          'receipt-entry',
          'invalid',
          'Receipt mutation path, hash or uniqueness is invalid.',
        ),
      )
      continue
    }
    seen.add(path)
    const entry = entries.get(path)
    if (
      path !== LOCKFILE_NAME &&
      (!entry || entry.state !== 'managed' || entry.hash !== mutation.afterHash)
    ) {
      uncertain = true
      findings.push(
        observation(
          'baseline.entry.' + i,
          'lock-integrity',
          path,
          'unknown',
          'Receipt mutation is not confirmed by current managed lock ownership.',
        ),
      )
      continue
    }
    const read = safeReadFileUtf8(root, path, MAX_FILE_SIZE, scope)
    if (!read.ok) {
      const finding = readFailure('baseline.drift.' + path, 'lock-integrity', path, read)
      if (read.error === 'not-found') finding.alignment = 'differing'
      else uncertain = true
      findings.push(finding)
    } else if (read.hash !== mutation.afterHash) {
      findings.push(
        observation(
          'baseline.drift.' + path,
          'lock-integrity',
          path,
          'valid',
          'Current bytes differ from the confirmed baseline.',
          {
            alignment: 'differing',
            proposedChange:
              'Review and explicitly realign ' +
              path +
              '; preserve authored instructions and custom configuration.',
            evidence: { currentHash: read.hash, expectedHash: mutation.afterHash },
          },
        ),
      )
    } else matched++
  }
  findings.push(
    observation(
      'baseline.receipt',
      'lock-integrity',
      'baseline',
      uncertain ? 'unknown' : 'valid',
      uncertain
        ? 'Receipt inspection is incomplete or invalid; no confirmed baseline match.'
        : findings.length
          ? 'Confirmed baseline has observed differences.'
          : 'All tracked entries match the sealed receipt and current lock.',
      {
        alignment:
          uncertain || scope.incomplete ? 'unknown' : findings.length ? 'differing' : 'matched',
        preservedPaths: [...seen].slice(0, MAX_DETAILED_FINDINGS),
        evidence: {
          totalEntries: total,
          matchedEntries: matched,
          receiptToken,
          sealAuthority: 'content-integrity-not-actor-authentication',
        },
      },
    ),
  )
  return findings
}

// Legacy status helpers reopen files. Preflight ONLY their declared source/target trees,
// rejecting aliases/nonregular files, and verify the snapshots after the read-only call.
function guardSkillHarnessTree(root, harnessRelPath, pkg, catalogSkillMap, scope) {
  let full
  try {
    full = guardedPath(root, harnessRelPath)
  } catch (error) {
    if (error.code === 'ENOENT') {
      scope.absences.add(resolve(root, harnessRelPath))
      return
    }
    throw error
  }
  const stat = lstatSync(full)
  if (!stat.isDirectory()) throw new Error('unsafe-helper-input')
  if (scope.directories.has(full)) {
    if (scope.directories.get(full) !== identity(stat)) throw new Error('changed-helper-input')
    return
  }
  scope.directories.set(full, identity(stat))
  const dir = opendirSync(full)
  try {
    for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
      if (++scope.entries > MAX_ENTRIES) {
        scope.incomplete = true
        throw new Error('inspection-budget-exhausted')
      }
      const childFull = join(full, entry.name)
      const childStat = lstatSync(childFull)
      if (!catalogSkillMap.has(entry.name)) {
        scope.directories.set(childFull, identity(childStat))
        continue
      }
      if (childStat.isSymbolicLink()) {
        scope.directories.set(childFull, identity(childStat))
        const realChild = realpathSync(childFull)
        const canonicalDir = join(pkg, catalogSkillMap.get(entry.name).source)
        const realCanonical = realpathSync(canonicalDir)
        if (realChild !== realCanonical) {
          const childSkillMd = join(realChild, 'SKILL.md')
          const canonicalSkillMd = join(realCanonical, 'SKILL.md')
          if (readFileSync(childSkillMd, 'utf8') !== readFileSync(canonicalSkillMd, 'utf8')) {
            throw new Error('symlink-escapes-root')
          }
        }
      } else {
        guardTree(root, join(harnessRelPath, entry.name), scope)
      }
    }
  } finally {
    dir.closeSync()
  }
}
function guardTree(root, path, scope) {
  let full
  try {
    full = guardedPath(root, path)
  } catch (error) {
    if (error.code === 'ENOENT') {
      scope.absences.add(resolve(root, path))
      return
    }
    throw error
  }
  const stat = lstatSync(full)
  if (stat.isFile()) {
    const read = safeReadFileUtf8(root, path, MAX_FILE_SIZE, scope)
    if (!read.ok) throw new Error('unsafe-helper-input')
    return
  }
  if (!stat.isDirectory()) throw new Error('unsafe-helper-input')
  if (scope.directories.has(full)) {
    if (scope.directories.get(full) !== identity(stat)) throw new Error('changed-helper-input')
    return
  }
  scope.directories.set(full, identity(stat))
  const dir = opendirSync(full)
  try {
    for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
      if (++scope.entries > MAX_ENTRIES) {
        scope.incomplete = true
        throw new Error('inspection-budget-exhausted')
      }
      guardTree(root, join(path, entry.name), scope)
    }
  } finally {
    dir.closeSync()
  }
}
export function readAdapterBindings({
  packageRoot,
  targetDir,
  harnesses = ['all'],
  scope = createReadScope(),
}) {
  const root = resolve(targetDir)
  const pkg = resolve(packageRoot ?? targetDir)
  const selected =
    Array.isArray(harnesses) && harnesses.length <= 4
      ? [...new Set(harnesses.includes('all') ? Object.keys(HARNESS_TARGETS) : harnesses)]
      : []
  if (!selected.length || selected.some((h) => !Object.hasOwn(HARNESS_TARGETS, h)))
    return [
      observation(
        'adapters.scope',
        'adapter-bindings',
        'adapters',
        'unknown',
        'Selected harness scope is invalid or unavailable.',
      ),
    ]
  const findings = []
  try {
    for (const path of [
      'manifests/skill-catalog.json',
      'manifests/role-catalog.json',
      'manifests/method-catalog.json',
      'manifests/harness-settings.json',
    ])
      guardTree(pkg, path, scope)
    const skills = readJson(pkg, 'manifests/skill-catalog.json', scope)
    const roles = readJson(pkg, 'manifests/role-catalog.json', scope)
    const settings = readJson(pkg, 'manifests/harness-settings.json', scope)
    if (
      !skills.ok ||
      !roles.ok ||
      !settings.ok ||
      !Array.isArray(skills.value.skills) ||
      !Array.isArray(roles.value.roles) ||
      skills.value.skills.length + roles.value.roles.length > MAX_ENTRIES
    )
      throw new Error('invalid-catalog')
    if (skills.value.namespace !== 'agentflow' || roles.value.namespace !== 'agentflow')
      throw new Error('invalid-catalog')
    for (const item of [...skills.value.skills, ...roles.value.roles]) {
      if (
        !safeRelativePath(item.source) ||
        !/^agentflow[-:][a-z0-9-]+$/.test(item.qualifiedName) ||
        (item.slug !== undefined && !/^[a-z0-9-]+$/.test(item.slug))
      )
        throw new Error('invalid-catalog')
      guardTree(pkg, item.source, scope)
    }
    const catalogSkillMap = new Map(skills.value.skills.map((item) => [item.qualifiedName, item]))
    for (const h of selected) {
      guardTree(pkg, 'adapters/' + h + '/manifest.json', scope)
      guardSkillHarnessTree(root, HARNESS_TARGETS[h], pkg, catalogSkillMap, scope)
      for (const path of [
        HARNESS_ROLE_TARGETS[h],
        '.agentflow/role-catalog.json',
        '.agentflow/method-catalog.json',
        (h === 'claude-code' ? '.claude' : '.' + h) + '/agentflow-sdlc.plugin.json',
      ])
        guardTree(root, path, scope)
      if (h === 'claude-code' || h === 'pi')
        guardTree(root, (h === 'pi' ? '.pi' : '.claude') + '/commands', scope)
      const setting = settings.value.settings?.[h]?.path
      if (!safeRelativePath(setting)) throw new Error('invalid-settings-path')
      guardTree(root, setting, scope)
      const results = [
        adapterStatus({ packageRoot: pkg, targetDir: root, harness: h }),
        roleAdapterStatus({ packageRoot: pkg, targetDir: root, harness: h }),
        pluginStatus({ packageRoot: pkg, targetDir: root, harness: h }),
        harnessSettingsStatus({ packageRoot: pkg, targetDir: root, harness: h }),
      ]
      if (!verifyReadScope(scope)) throw new Error('changed-helper-input')
      const stale = results.reduce((n, result) => n + result.stale.length, 0)
      const valid = results.every((result) => result.ok)
      findings.push(
        observation(
          'adapters.' + h,
          'adapter-bindings',
          h,
          valid ? 'valid' : 'invalid',
          valid
            ? stale
              ? 'Selected harness has missing or stale generated bindings.'
              : 'Selected harness bindings match package projections.'
            : 'Selected harness binding validation failed.',
          {
            alignment: valid ? (stale ? 'differing' : 'matched') : 'unknown',
            proposedChange: stale
              ? 'Explicitly synchronize framework-owned bindings for ' +
                h +
                '; preserve authored/custom settings.'
              : null,
            evidence: { harness: h, staleCount: stale, sharedSkillTarget: HARNESS_TARGETS[h] },
          },
        ),
      )
    }
  } catch {
    findings.push(
      observation(
        'adapters.scope',
        'adapter-bindings',
        'adapters',
        'unknown',
        'Selected adapter scope could not be safely and completely inspected.',
        { evidence: { selectedHarnesses: selected, incomplete: true } },
      ),
    )
  }
  return findings
}
export function readRuntimeReachability({ runtimeRequest = null, runtimeEvidence = null }) {
  const findings = []
  const pathDirs = (process.env.PATH || '').split(delimiter).filter(Boolean).slice(0, MAX_ENTRIES)
  for (const name of ['git', 'node', 'pnpm', 'gh']) {
    let located = false
    for (const dir of pathDirs) {
      try {
        const stat = statSync(join(dir, process.platform === 'win32' ? name + '.exe' : name))
        if (stat.isFile() && (process.platform === 'win32' || stat.mode & 0o111)) {
          located = true
          break
        }
      } catch {
        /* absent; no execution */
      }
    }
    findings.push(
      observation(
        'runtime.tool.' + name,
        'runtime-reachability',
        name,
        located ? 'valid' : 'missing',
        located
          ? 'Executable is present; live reachability and authentication remain unknown (not probed).'
          : 'Executable is not located in the bounded PATH scope.',
        { evidence: { located, liveReachability: 'unknown' } },
      ),
    )
  }
  if (runtimeRequest || runtimeEvidence) {
    let assessment = null
    try {
      assessment = assessRuntimeEvidence(runtimeRequest, runtimeEvidence)
    } catch {
      /* invalid input */
    }
    // The runtime dialect has no freshness/context authentication contract. Even schema-valid
    // observations are reported as supplied evidence, never certified live reachability.
    findings.push(
      observation(
        'runtime.request.validation',
        'runtime-reachability',
        'runtime-request',
        'unknown',
        assessment && assessment.errors.length === 0
          ? 'Supplied runtime evidence is schema-scoped; source, freshness and live reachability are unverified.'
          : 'Runtime request or evidence is invalid, missing or mismatched; reachability is unknown.',
        {
          evidence: {
            schemaScoped: Boolean(assessment && assessment.errors.length === 0),
            liveReachability: 'unknown',
          },
        },
      ),
    )
  }
  return findings
}
