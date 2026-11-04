// User-level (global) public skill installations: inspection, status and transactional install.
import { existsSync, lstatSync, readFileSync, rmSync } from 'node:fs'
import { hash as contentHash } from '../shared/fs.mjs'
import { inspectSkillFile } from '../skill-paths.mjs'
import { markerInfo } from './markers.mjs'
import {
  PUBLIC_SKILL,
  PUBLIC_SKILL_RAW,
  SKILL_BODY,
  SKILL_END,
  SKILL_START,
  atomicWrite,
  safeUserSkillFile,
  skillHome,
  slash,
  userSkillTargets
} from './registry.mjs'
export { hash as contentHash } from '../shared/fs.mjs'

export function normalizedSkill(text) {
  return text.replaceAll('\r\n', '\n').trim()
}
export function inspectGlobalSkillPath(target, options = {}) {
  const location = inspectSkillFile(skillHome(options), target.file, { allowDirectoryLink: true }),
    remediation = location.external
      ? 'Update or undeploy this skill through its deployment manager; Holoself will not write through the link'
      : location.status === 'missing'
        ? 'Install the current public Holoself skill globally'
        : 'Review the unsafe skill path and restore regular ancestors; filesystem permissions remain enforced'
  const detail = { external: location.external, readOnly: location.external, linkPath: location.linkPath, reason: location.reason || null, remediation }
  if (location.status !== 'regular')
    return { ...detail, status: location.status === 'external-link' ? 'unsafe' : location.status, kind: location.status, installed: false, contentHash: null }
  let text
  try {
    text = readFileSync(location.resolvedPath, 'utf8')
  } catch (error) {
    return { ...detail, status: 'unreadable', kind: 'unreadable', installed: false, contentHash: null, reason: error.message }
  }
  const hash = contentHash(text)
  if (location.external) {
    const current = text.replaceAll('\r\n', '\n') === PUBLIC_SKILL
    return {
      ...detail,
      status: current ? 'full-public-skill-current' : 'external-content-mismatch',
      kind: current ? 'full-public-skill' : 'unknown',
      installed: current,
      contentHash: hash
    }
  }
  const state = skillState(location.resolvedPath)
  if (normalizedSkill(text) === normalizedSkill(PUBLIC_SKILL))
    return { ...detail, status: 'full-public-skill-current', kind: 'full-public-skill', installed: true, contentHash: hash, remediation: null }
  if (state === 'active' && text.includes(SKILL_BODY))
    return { ...detail, status: 'full-public-skill-compatible', kind: 'full-public-skill', installed: true, contentHash: hash, remediation: null }
  if (state === 'malformed') return { ...detail, status: 'malformed', kind: 'malformed', installed: false, contentHash: hash }
  if (state === 'active') return { ...detail, status: 'legacy-shim', kind: 'legacy-shim', installed: false, contentHash: hash }
  return {
    ...detail,
    status: 'unmanaged-collision',
    kind: 'unknown',
    installed: false,
    contentHash: hash,
    remediation: 'Review the existing skill before replacement; unmanaged regular files require --force --yes'
  }
}
export function globalSkillStatus(options = {}) {
  const targets = userSkillTargets(options.platforms || [], options)
  return {
    scope: 'user',
    home: slash(skillHome(options)),
    installations: targets.map(target => ({ ...target, path: slash(target.path), ...inspectGlobalSkillPath(target, options) }))
  }
}
export function snapshotAbsolute(paths) {
  return paths.map(path => ({ path, exists: existsSync(path), content: existsSync(path) && lstatSync(path).isFile() ? readFileSync(path) : null }))
}
export function rollbackAbsolute(snapshots) {
  for (const item of snapshots.reverse()) {
    try {
      if (item.exists && item.content !== null) atomicWrite(item.path, item.content)
      else if (!item.exists && existsSync(item.path)) rmSync(item.path, { force: true })
    } catch {}
  }
}
export function installGlobalSkills(options = {}) {
  const status = globalSkillStatus(options),
    collisions = status.installations.filter(x => !['missing', 'full-public-skill-current', 'full-public-skill-compatible'].includes(x.status))
  const externalCollisions = collisions.filter(item => item.external || ['unsafe', 'unreadable'].includes(item.status))
  if (externalCollisions.length && !options.dryRun)
    throw new Error(`global skill paths require deployment-manager repair: ${externalCollisions.map(item => `${item.path}: ${item.remediation}`).join('; ')}`)
  if (collisions.length && !options.force && !options.dryRun)
    throw new Error(`global skill installation collision: ${collisions.map(x => `${x.path}: ${x.status}`).join('; ')}; review and use --force --yes to replace`)
  const canonicalHash = contentHash(PUBLIC_SKILL_RAW),
    plan = {
      scope: 'user',
      home: status.home,
      installations: status.installations.map(x => ({
        id: x.id,
        file: x.file,
        path: x.path,
        from: x.status,
        action: x.external
          ? x.installed
            ? 'unchanged'
            : 'blocked'
          : ['unsafe', 'unreadable'].includes(x.status)
            ? 'blocked'
            : x.status === 'full-public-skill-current' && x.contentHash === canonicalHash
              ? 'unchanged'
              : 'write',
        readOnly: x.readOnly,
        remediation: x.remediation
      }))
    }
  if (options.dryRun) return plan
  const blocked = plan.installations.filter(x => x.action === 'blocked')
  if (blocked.length) throw new Error(`global skill paths require deployment-manager repair: ${blocked.map(x => `${x.path}: ${x.remediation}`).join('; ')}`)
  const writes = plan.installations.filter(x => x.action === 'write'),
    snapshots = snapshotAbsolute(writes.map(x => safeUserSkillFile(skillHome(options), x.file, 'global skill write')))
  try {
    for (const item of writes) atomicWrite(safeUserSkillFile(skillHome(options), item.file, 'global skill write'), PUBLIC_SKILL_RAW)
    return { ...plan, installations: plan.installations.map(x => ({ ...x, result: x.action === 'write' ? 'installed' : 'unchanged' })) }
  } catch (error) {
    rollbackAbsolute(snapshots)
    throw error
  }
}
export function skillState(path) {
  if (!existsSync(path)) return 'missing'
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) return 'unsafe'
  const text = readFileSync(path, 'utf8')
  if (normalizedSkill(text) === normalizedSkill(PUBLIC_SKILL)) return 'public'
  return markerInfo(text, SKILL_START, SKILL_END).state
}
