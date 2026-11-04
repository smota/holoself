// Managed instruction markers: locate, hash, inject and remove the Holoself block in project files.
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { LINK_END, LINK_START, instructionHash } from '../instructions.mjs'
import { atomicWrite, safeProjectFile } from './registry.mjs'

export function markerInfo(text, start = LINK_START, end = LINK_END) {
  const starts = []
  const ends = []
  let i = -1
  while ((i = text.indexOf(start, i + 1)) >= 0) starts.push(i)
  i = -1
  while ((i = text.indexOf(end, i + 1)) >= 0) ends.push(i)
  if (!starts.length && !ends.length) return { state: 'inactive' }
  if (starts.length !== 1 || ends.length !== 1 || ends[0] < starts[0]) return { state: 'malformed' }
  const finish = ends[0] + end.length
  return { state: 'active', start: starts[0], end: finish, block: text.slice(starts[0], finish) }
}
export function managedBlockHash(text) {
  const info = markerInfo(text)
  return info.state === 'active' ? instructionHash(info.block) : null
}
export function managedMarkerState(path) {
  if (!existsSync(path)) return 'missing'
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) return 'unsafe'
  return markerInfo(readFileSync(path, 'utf8')).state
}
export function nextMarkedContent(old, section) {
  const info = markerInfo(old)
  if (info.state === 'malformed') throw new Error('malformed Holoself markers')
  return info.state === 'active' ? old.slice(0, info.start) + section.trimEnd() + old.slice(info.end) : (old.trimEnd() ? old.trimEnd() + '\n\n' : '') + section
}
export function injectMarker(project, rel, section, dryRun = false) {
  const p = safeProjectFile(project, rel, 'instruction write'),
    state = managedMarkerState(p)
  if (state === 'unsafe' || state === 'malformed') throw new Error(`${p} has unsafe or malformed Holoself markers`)
  const existed = existsSync(p),
    old = existed ? readFileSync(p, 'utf8') : '',
    next = nextMarkedContent(old, section)
  if (!dryRun && next !== old) atomicWrite(p, next, { mode: 0o666 })
  return next === old ? 'unchanged' : state === 'active' ? 'updated' : existed ? 'appended' : 'created'
}
export function removeMarker(project, rel, dryRun = false) {
  const p = safeProjectFile(project, rel, 'instruction removal'),
    state = managedMarkerState(p)
  if (state === 'missing' || state === 'inactive') return 'unchanged'
  if (state !== 'active') throw new Error(`${p} has unsafe or malformed Holoself markers`)
  const old = readFileSync(p, 'utf8'),
    info = markerInfo(old),
    next = (old.slice(0, info.start) + old.slice(info.end)).replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
  if (!dryRun) atomicWrite(p, next, { mode: 0o666 })
  return 'removed'
}
