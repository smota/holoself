// Legacy data-root migration (holoself migrate --from): plan, apply, manifest and report.
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { VERSION } from '../version.mjs'
import { atomicWrite } from './files.mjs'
import { CONTEXT_FILES, PROFILE_FILES, metadata } from './templates.mjs'

export const MIGRATION_ROOTS = new Set(['profile', 'context', 'topics', 'reference', 'me'])
export const SENSITIVE_ROOTS = new Set(['reference', 'me'])
export const GENERATED_ROOTS = new Set(['exports'])
export const MIGRATED_CANONICAL_METADATA = metadata(['private'], 'internal-only', 'restricted', 'content')
export function migrationRelative(root, file) {
  return relative(root, file).replaceAll('\\', '/')
}
export function migratedCanonicalMarkdown(relativePath) {
  return /^(?:profile|context|topics)\/.+\.md$/i.test(relativePath)
}
export function migrationContent(item, destination) {
  const content = readFileSync(item.path, 'utf8').replace(/^\uFEFF/, '')
  return migratedCanonicalMarkdown(destination) && !content.startsWith('---\n') && !content.startsWith('---\r\n')
    ? MIGRATED_CANONICAL_METADATA + content
    : content
}
export function migrationFiles(root, prefix = '', output = []) {
  if (!existsSync(root)) return output
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      const rel = prefix ? `${prefix}/${migrationRelative(root, path)}` : migrationRelative(root, path)
      if (entry.isSymbolicLink()) throw new Error(`refusing symlink in source: ${path}`)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) output.push({ path, relative: rel })
    }
  }
  walk(root)
  return output
}
export function migrationPlan(source, target, sourceInput, force = false) {
  const detected = migrationFiles(source)
  // A full PersonalOS checkout stores topics beside personal/; include it without
  // treating package or repository files as private data.
  if (sourceInput !== source && existsSync(join(sourceInput, 'topics'))) {
    for (const item of migrationFiles(join(sourceInput, 'topics'))) {
      item.relative = `topics/${item.relative}`
      detected.push(item)
    }
  }
  const report = {
    sourceRoot: source,
    sourceInput,
    targetRoot: target,
    dryRun: false,
    detectedFiles: detected.map(x => x.relative).sort(),
    destinationMappings: [],
    copied: [],
    preserved: [],
    conflicts: [],
    skipped: [],
    sensitive: [],
    generated: [],
    tagged: [],
    _detected: detected
  }
  for (const item of detected) {
    const top = item.relative.split('/')[0]
    if (SENSITIVE_ROOTS.has(top)) report.sensitive.push(item.relative)
    if (GENERATED_ROOTS.has(top) || item.relative === 'config.json' || item.relative === 'migration-manifest.json') {
      report.generated.push(item.relative)
      report.skipped.push(item.relative)
      continue
    }
    if (!MIGRATION_ROOTS.has(top)) {
      report.skipped.push(item.relative)
      continue
    }
    const destination = item.relative
    report.destinationMappings.push({ source: item.relative, destination })
    const dest = join(target, destination)
    if (!existsSync(dest)) {
      report.copied.push(destination)
      continue
    }
    const destStat = lstatSync(dest)
    if (destStat.isSymbolicLink()) throw new Error(`refusing symlink destination: ${dest}`)
    if (force || (destStat.isFile() && Object.values({ ...PROFILE_FILES, ...CONTEXT_FILES }).includes(readFileSync(dest, 'utf8'))))
      report.copied.push(destination)
    else {
      report.preserved.push(destination)
      report.conflicts.push(destination)
    }
  }
  report.tagged = report.destinationMappings
    .filter(mapping => report.copied.includes(mapping.destination))
    .filter(mapping => {
      const item = detected.find(candidate => candidate.relative === mapping.source),
        content = readFileSync(item.path, 'utf8').replace(/^\uFEFF/, '')
      return migratedCanonicalMarkdown(mapping.destination) && !content.startsWith('---\n') && !content.startsWith('---\r\n')
    })
    .map(mapping => mapping.destination)
  report.detectedFiles.sort()
  report.destinationMappings.sort((a, b) => a.destination.localeCompare(b.destination))
  for (const key of ['copied', 'preserved', 'conflicts', 'skipped', 'sensitive', 'generated', 'tagged']) report[key].sort()
  report.detectedCount = report.detectedFiles.length
  report.summary = {
    detected: report.detectedCount,
    mapped: report.destinationMappings.length,
    copied: report.copied.length,
    preserved: report.preserved.length,
    conflicts: report.conflicts.length,
    skipped: report.skipped.length,
    sensitive: report.sensitive.length,
    generated: report.generated.length,
    tagged: report.tagged.length
  }
  report.files = {
    detected: report.detectedFiles,
    copied: report.copied,
    preserved: report.preserved,
    conflicts: report.conflicts,
    skipped: report.skipped,
    sensitive: report.sensitive,
    generated: report.generated,
    tagged: report.tagged
  }
  return { report, detected }
}
export function applyMigration(plan, target) {
  for (const mapping of plan.destinationMappings) {
    if (!plan.copied.includes(mapping.destination)) continue
    const item = plan._detected.find(x => x.relative === mapping.source)
    const dest = join(target, mapping.destination)
    atomicWrite(dest, migrationContent(item, mapping.destination))
  }
}
export function migrationManifest(report) {
  const { dryRun: _, _detected: __, ...manifestReport } = report
  return {
    schemaVersion: 1,
    tool: 'holoself',
    toolVersion: VERSION,
    timestamp: new Date().toISOString(),
    source: report.sourceRoot,
    target: report.targetRoot,
    ...manifestReport
  }
}
export function assertMigrationTarget(source, target) {
  const from = resolve(source),
    to = resolve(target)
  if (to === from || to.startsWith(`${from}${'\\'}`) || to.startsWith(`${from}/`))
    throw new Error('migration target must not be inside source; source must remain unchanged')
}
export function assertDestinationParents(target, destination) {
  let current = dirname(join(target, destination))
  const boundary = resolve(target)
  while (resolve(current).startsWith(boundary) && resolve(current) !== boundary) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`refusing symlink destination: ${current}`)
    current = dirname(current)
  }
}
export function printMigrationReport(report, manifestPath = null) {
  console.log(`[${report.dryRun ? 'dry-run' : 'ok'}] migration report`)
  console.log(`source root: ${report.sourceRoot}`)
  console.log(`target root: ${report.targetRoot}`)
  console.log(`detected files: ${report.detectedCount}`)
  for (const mapping of report.destinationMappings) console.log(`mapping: ${mapping.source} -> ${mapping.destination}`)
  for (const key of ['copied', 'preserved', 'conflicts', 'skipped', 'sensitive', 'generated', 'tagged'])
    console.log(`${key}: ${report[key].length}${report[key].length ? ` (${report[key].join(', ')})` : ''}`)
  console.log(`summary: ${JSON.stringify(report.summary)}`)
  if (manifestPath) console.log(`manifest: ${manifestPath}`)
}
