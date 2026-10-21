import { resolve } from 'node:path'
import {
  readProjectConfigs,
  readLockfile,
  readBaselineAlignment,
  readAdapterBindings,
  readRuntimeReachability,
  MAX_DETAILED_FINDINGS,
  createReadScope,
  verifyReadScope,
} from './doctor-readers.mjs'

export function inspectDoctor({
  packageRoot,
  targetDir = process.cwd(),
  harnesses = ['all'],
  baselineReceipt = null,
  runtimeRequest = null,
  runtimeEvidence = null,
} = {}) {
  const root = resolve(targetDir)
  const pkgRoot = packageRoot ? resolve(packageRoot) : root

  const scope = createReadScope()
  const configFindings = readProjectConfigs({ targetDir: root, scope })
  const lockFindings = readLockfile({ targetDir: root, scope })
  const baselineFindings = readBaselineAlignment({ targetDir: root, baselineReceipt, scope })
  const adapterFindings = readAdapterBindings({
    packageRoot: pkgRoot,
    targetDir: root,
    harnesses,
    scope,
  })
  const runtimeFindings = readRuntimeReachability({ runtimeRequest, runtimeEvidence })

  const allFindings = [
    ...configFindings,
    ...lockFindings,
    ...baselineFindings,
    ...adapterFindings,
    ...runtimeFindings,
  ]

  if (!verifyReadScope(scope)) {
    scope.incomplete = true
    for (const finding of allFindings) {
      if (finding.alignment === 'matched') {
        finding.alignment = 'unknown'
        finding.reason = 'Snapshot changed during inspection; alignment is unknown.'
      }
    }
  }

  const counts = {
    valid: 0,
    missing: 0,
    invalid: 0,
    differing: 0,
    matched: 0,
    unknown: 0,
  }

  const proposedChanges = []
  const preservedPaths = []

  for (const f of allFindings) {
    if (counts[f.structural] !== undefined) counts[f.structural]++
    if (counts[f.alignment] !== undefined) counts[f.alignment]++
    if (f.proposedChange) proposedChanges.push(f.proposedChange)
    if (f.preservedPaths && Array.isArray(f.preservedPaths)) {
      preservedPaths.push(...f.preservedPaths)
    }
  }

  const totalFindings = allFindings.length
  const cap = (items) => items.slice(0, MAX_DETAILED_FINDINGS)
  const changes = [...new Set(proposedChanges)]
  const preserved = [...new Set(preservedPaths)]
  const capped =
    totalFindings > MAX_DETAILED_FINDINGS ||
    changes.length > MAX_DETAILED_FINDINGS ||
    preserved.length > MAX_DETAILED_FINDINGS
  const findings = cap(allFindings)
  const incomplete = scope.incomplete || capped
  if (incomplete) counts.unknown++

  const hasDefects = counts.missing > 0 || counts.invalid > 0 || counts.differing > 0
  const hasUnknown = counts.unknown > 0

  let status = 'ok'
  let exitCode = 0
  if (hasDefects) {
    status = 'defect'
    exitCode = 1
  } else if (hasUnknown) {
    status = 'unknown'
    exitCode = 2
  }

  return {
    schemaVersion: 1,
    targetDir: root,
    timestamp: new Date().toISOString(),
    ok: exitCode === 0,
    summary: {
      status,
      exitCode,
      counts,
      totalFindings,
      capped,
      incomplete,
      omittedFindings: totalFindings - findings.length,
      omittedByDimension: {
        'project-configs': Math.max(0, configFindings.length - MAX_DETAILED_FINDINGS),
        'adapter-bindings': Math.max(0, adapterFindings.length - MAX_DETAILED_FINDINGS),
        'lock-integrity': Math.max(
          0,
          lockFindings.length + baselineFindings.length - MAX_DETAILED_FINDINGS,
        ),
        'runtime-reachability': Math.max(0, runtimeFindings.length - MAX_DETAILED_FINDINGS),
      },
      inspectedFiles: scope.snapshots.size,
      inspectedBytes: scope.bytes,
    },
    dimensions: {
      'project-configs': cap(configFindings),
      'adapter-bindings': cap(adapterFindings),
      'lock-integrity': cap([...lockFindings, ...baselineFindings]),
      'runtime-reachability': cap(runtimeFindings),
    },
    findings,
    remediation: {
      proposedChanges: cap(changes),
      preservedPaths: cap(preserved),
      totalProposedChanges: changes.length,
      totalPreservedPaths: preserved.length,
      omittedProposedChanges: Math.max(0, changes.length - MAX_DETAILED_FINDINGS),
      omittedPreservedPaths: Math.max(0, preserved.length - MAX_DETAILED_FINDINGS),
    },
  }
}

export { formatDoctorJson, formatDoctorPlain } from './doctor-report.mjs'
