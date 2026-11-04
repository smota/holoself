// Filesystem helpers for the data-root commands (init, export, migrate): atomic writes, copies, backups.
import { existsSync, lstatSync, readFileSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWrite, ensureDir, pathExists } from '../shared/fs.mjs'
import { CONTEXT_FILES, PROFILE_FILES } from './templates.mjs'
export { atomicWrite, ensureDir, pathExists } from '../shared/fs.mjs'

let tempCounter = 0
// Shared with run() for export staging names; returns the counter value, then increments it.
export function nextTempCounter() {
  return tempCounter++
}
export function json(p, v) {
  atomicWrite(p, JSON.stringify(v, null, 2) + '\n')
}
export function copyTree(source, dest, force = false) {
  const stat = lstatSync(source)
  if (stat.isSymbolicLink()) throw new Error(`refusing symlink in source: ${source}`)
  if (stat.isDirectory()) {
    if (existsSync(dest) && lstatSync(dest).isSymbolicLink()) throw new Error(`refusing symlink destination: ${dest}`)
    ensureDir(dest)
    for (const entry of readdirSync(source, { withFileTypes: true })) copyTree(join(source, entry.name), join(dest, entry.name), force)
    return
  }
  if (!stat.isFile()) return
  if (existsSync(dest) && lstatSync(dest).isSymbolicLink()) throw new Error(`refusing symlink destination: ${dest}`)
  if (force || !existsSync(dest) || (lstatSync(dest).isFile() && Object.values({ ...PROFILE_FILES, ...CONTEXT_FILES }).includes(readFileSync(dest, 'utf8'))))
    atomicWrite(dest, readFileSync(source))
}
export function copyMarkdownTree(source, dest) {
  const stat = lstatSync(source)
  if (stat.isSymbolicLink()) throw new Error(`refusing symlink in source: ${source}`)
  if (stat.isDirectory()) {
    if (existsSync(dest) && lstatSync(dest).isSymbolicLink()) throw new Error(`refusing symlink destination: ${dest}`)
    ensureDir(dest)
    for (const entry of readdirSync(source, { withFileTypes: true })) copyMarkdownTree(join(source, entry.name), join(dest, entry.name))
    return
  }
  if (stat.isFile() && source.endsWith('.md')) {
    if (existsSync(dest) && lstatSync(dest).isSymbolicLink()) throw new Error(`refusing symlink destination: ${dest}`)
    atomicWrite(dest, readFileSync(source))
  }
}
export function isEcosystemMetadata(out) {
  if (!pathExists(out) || lstatSync(out).isSymbolicLink() || !lstatSync(out).isDirectory()) return false
  return pathExists(join(out, 'link.yaml')) || ['index', 'proposals', 'reports'].some(name => pathExists(join(out, name)))
}
export function backupExport(out, target) {
  if (!pathExists(out)) return null
  if (lstatSync(out).isSymbolicLink()) throw new Error(`${out} is a symlink; refusing to refresh it`)
  const stamp = `${Date.now()}-${process.pid}-${tempCounter++}`
  const backup = join(target, `.holoself-backup-${stamp}`)
  renameSync(out, backup)
  return backup
}
