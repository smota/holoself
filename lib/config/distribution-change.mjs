import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  statSync,
  unlinkSync,
  chmodSync,
} from 'node:fs'
import { resolve, relative } from 'node:path'
import { withAdoptionLock } from '../adoption/operation-lock.mjs'
import { containedPath } from '../verification/workspace.mjs'
import { recordDigest, hasCurrentDigest } from '../core/record-digest.mjs'
import { defaultDistributionSelection, resolveDistribution } from './execution-distribution.mjs'
const hash = (value) => createHash('sha256').update(value).digest('hex')
function configuration(root) {
  const file = containedPath(
    root,
    existsSync(resolve(root, 'agentflow.config.json'))
      ? 'agentflow.config.json'
      : 'agent-workflow.config.json',
  )
  const info = statSync(file)
  if (!info.isFile() || info.nlink !== 1)
    throw new Error('Policy config must be a regular unaliased file')
  return file
}
function afterConfig(config, selection) {
  const after = structuredClone(config)
  after.executionDistribution = selection
  const policy = after.adapters?.openrig?.executionPolicy
  if (policy) {
    delete policy.seats
    delete policy.preset
  }
  return after
}
export function planDistributionChange(root, selection = defaultDistributionSelection()) {
  root = resolve(root)
  const profile = resolveDistribution(selection),
    file = configuration(root),
    bytes = readFileSync(file)
  const config = JSON.parse(bytes)
  if (!config || typeof config !== 'object' || Array.isArray(config))
    throw new Error('Workflow configuration must be an object')
  const next = Buffer.from(JSON.stringify(afterConfig(config, selection), null, 2) + '\n')
  const plan = {
    version: 1,
    type: 'distribution-policy-change',
    root,
    rootIdentity: { dev: statSync(root).dev, ino: statSync(root).ino },
    configFile: relative(root, file),
    beforeHash: hash(bytes),
    afterHash: hash(next),
    before: config.executionDistribution ?? null,
    replacesLegacySeatPolicy: Boolean(config.adapters?.openrig?.executionPolicy?.seats),
    legacyPreset: config.adapters?.openrig?.executionPolicy?.preset ?? null,
    legacySeats: Object.fromEntries(
      Object.entries(config.adapters?.openrig?.executionPolicy?.seats ?? {}).map(
        ([seat, tuple]) => [
          seat,
          Object.fromEntries(
            [
              'runtime',
              'executionTarget',
              'providerRoute',
              'providerFamily',
              'platform',
              'model',
              'effort',
              'profile',
              'capabilityTier',
            ]
              .filter((k) => typeof tuple?.[k] === 'string')
              .map((k) => [k, tuple[k]]),
          ),
        ],
      ),
    ),
    after: selection,
    roles: profile.roles,
    effects: [],
  }
  return { ...plan, digest: recordDigest(plan) }
}
function atomicWrite(file, bytes, mode = 0o600) {
  const staging = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(staging, bytes, { flag: 'wx', mode, flush: true })
    chmodSync(staging, mode)
    renameSync(staging, file)
  } finally {
    if (existsSync(staging)) unlinkSync(staging)
  }
}
export function applyDistributionChange(root, plan, confirm) {
  root = resolve(root)
  if (!hasCurrentDigest(plan) || confirm !== plan.digest || plan.root !== root)
    throw new Error('Exact current policy-change confirmation required')
  return withAdoptionLock(root, () => {
    const fresh = planDistributionChange(root, plan.after)
    if (fresh.digest !== plan.digest) throw new Error('Policy/config changed; replan required')
    const file = configuration(root),
      before = readFileSync(file),
      next = Buffer.from(
        JSON.stringify(afterConfig(JSON.parse(before), plan.after), null, 2) + '\n',
      )
    const dir = containedPath(root, '.agent-runs', { allowMissing: true })
    mkdirSync(dir, { recursive: true })
    const journal = containedPath(root, `.agent-runs/distribution-${randomUUID()}.json`, {
      allowMissing: true,
    })
    const receipt = {
      version: 1,
      type: 'distribution-policy-receipt',
      root,
      configFile: plan.configFile,
      planDigest: plan.digest,
      beforeHash: hash(before),
      afterHash: hash(next),
      beforeBase64: before.toString('base64'),
      mode: statSync(file).mode & 0o777,
      status: 'prepared',
    }
    atomicWrite(
      journal,
      JSON.stringify({ ...receipt, digest: recordDigest(receipt) }, null, 2) + '\n',
    )
    if (hash(readFileSync(file)) !== plan.beforeHash)
      throw new Error('Config drift before replacement')
    atomicWrite(file, next, receipt.mode)
    if (hash(readFileSync(file)) !== receipt.afterHash)
      throw new Error('Policy readback mismatch; inspect receipt')
    receipt.status = 'applied'
    atomicWrite(
      journal,
      JSON.stringify({ ...receipt, digest: recordDigest(receipt) }, null, 2) + '\n',
    )
    return {
      status: 'applied',
      selection: plan.after,
      receipt: relative(root, journal),
      planDigest: plan.digest,
      installedRigs: 'not-mutated',
      runtimeSelection: 'not-mutated',
    }
  })
}
export function undoDistributionChange(root, receiptPath, confirm) {
  root = resolve(root)
  return withAdoptionLock(root, () => {
    const journal = containedPath(root, receiptPath),
      receipt = JSON.parse(readFileSync(journal, 'utf8'))
    if (
      !hasCurrentDigest(receipt) ||
      receipt.type !== 'distribution-policy-receipt' ||
      !Number.isInteger(receipt.mode) ||
      receipt.mode < 0 ||
      receipt.mode > 0o777 ||
      confirm !== receipt.digest ||
      !['applied', 'prepared'].includes(receipt.status) ||
      receipt.root !== root
    )
      throw new Error('Exact rollback receipt confirmation required')
    const file = configuration(root)
    if (
      relative(root, file) !== receipt.configFile ||
      hash(readFileSync(file)) !== receipt.afterHash
    )
      throw new Error('Policy changed after apply; rollback refused')
    const before = Buffer.from(receipt.beforeBase64, 'base64')
    if (hash(before) !== receipt.beforeHash) throw new Error('Corrupt rollback preimage')
    atomicWrite(file, before, receipt.mode)
    receipt.status = 'rolled-back'
    atomicWrite(
      journal,
      JSON.stringify({ ...receipt, digest: recordDigest(receipt) }, null, 2) + '\n',
    )
    return { status: 'rolled-back', installedRigs: 'not-mutated', runtimeSelection: 'not-mutated' }
  })
}
