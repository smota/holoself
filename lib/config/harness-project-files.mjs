import { existsSync } from 'node:fs'
import { relative } from 'node:path'
import { buildPluginManifests } from '../plugin-manifests.mjs'
import { syncRoleAdapters } from '../role-adapters.mjs'
import { hasSymlinkAlongPath, syncSkillAdapters } from '../skill-adapters.mjs'
import { mergeHarnessSettings } from '../structural-merge.mjs'

const SKILL_TREE_PREFIXES = ['.agents/skills/', '.claude/skills/', '.pi/skills/']

// Generated harness bytes that adoption must preview and apply. Skill adapter trees are included
// only when a regular file is already on disk: fresh and linked checkouts keep skills runtime-managed.
export function collectHarnessAdapterFiles({ packageRoot, targetDir, harness = 'all' } = {}) {
  const files = {}
  const put = (target, content) => {
    if (typeof content !== 'string' || typeof target !== 'string') return
    if (hasSymlinkAlongPath(targetDir, target)) return
    const relPath = relative(targetDir, target).replaceAll('\\', '/')
    if (!relPath || relPath.startsWith('../') || relPath === '..') return
    files[relPath] = { content, mode: 'sync' }
  }

  const roles = syncRoleAdapters({
    packageRoot,
    targetDir,
    harness,
    write: false,
    captureContent: true,
  })
  for (const item of roles.captured ?? []) put(item.target, item.content)

  const skills = syncSkillAdapters({
    packageRoot,
    targetDir,
    harness,
    write: false,
    captureContent: true,
  })
  for (const item of skills.captured ?? []) {
    const relPath = relative(targetDir, item.target).replaceAll('\\', '/')
    if (
      SKILL_TREE_PREFIXES.some((prefix) => relPath.startsWith(prefix)) &&
      !existsSync(item.target)
    )
      continue
    put(item.target, item.content)
  }

  const plugins = buildPluginManifests({
    packageRoot,
    targetDir,
    harness,
    write: false,
    captureContent: true,
  })
  for (const item of plugins.captured ?? []) put(item.target, item.content)

  const settings = mergeHarnessSettings({
    packageRoot,
    targetDir,
    harness,
    write: false,
    captureContent: true,
  })
  for (const item of settings.captured ?? []) {
    if (
      item.status === 'blocked-root-shape' ||
      item.status === 'blocked-symlink' ||
      item.status === 'blocked-json'
    )
      continue
    put(item.target, item.content)
  }
  return files
}
