// holoself link remove subcommand (moved verbatim from runEcosystem).
import { existsSync, lstatSync, readFileSync, rmSync } from 'node:fs'
import { deactivateProject } from '../../../adapters.mjs'
import { hasPathBinding, writeBinding } from '../../../bindings.mjs'
import { isCanonicalSelf, linkPath } from '../../../link/config.mjs'
import { linkSelfReference, resolveLinkedSelf } from '../../../link/self-resolution.mjs'
import { canonicalProjectPath, canonicalSpaceId, readRegistry, registryFilePath, withRegistryLock, writeRegistry } from '../../../link/registry.mjs'
import { pathExists } from '../../../shared/fs.mjs'
import { redactRootPaths } from '../../../shared/redact.mjs'
import { parseYaml } from '../../../shared/yaml.mjs'
import { askConfirm } from '../../link-helpers.mjs'

// Revoke the matching registry entry, or on dry-run only report what would be revoked (no lock, no write).
async function revokeSovereignLink(o, project, selfRoot, pId, canonicalProj) {
  const matches = l => l.project_id === pId || l.project_path === canonicalProj
  if (o.dryRun) {
    const entry = readRegistry(selfRoot).links.find(matches)
    if (entry && entry.status !== 'revoked') console.log(`[dry-run] would revoke sovereign link for ${project}`)
    return
  }
  await withRegistryLock(selfRoot, () => {
    const currentReg = readRegistry(selfRoot)
    const nowIso = new Date().toISOString()
    writeRegistry(
      selfRoot,
      links => {
        const idx = links.findIndex(matches)
        if (idx >= 0) links[idx] = { ...links[idx], status: 'revoked', revoked_at: nowIso, updated_at: nowIso }
        return links
      },
      currentReg.registry_hash
    )
  })
}

export async function linkRemove(o, sub, project) {
  const path = linkPath(project)
  const canonicalProj = canonicalProjectPath(project)
  const pId = canonicalSpaceId(project)
  if (!pathExists(path)) {
    console.log('[ok] no link configuration found')
    let selfRoot = o.self || o.root
    if (selfRoot) {
      const cSelf = canonicalProjectPath(selfRoot)
      if (existsSync(cSelf) && isCanonicalSelf(cSelf)) {
        const regPath = registryFilePath(cSelf)
        if (existsSync(regPath)) await revokeSovereignLink(o, project, cSelf, pId, canonicalProj)
      }
    }
    return true
  }
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) throw new Error(`${path} is not a regular link configuration; refusing to remove`)
  if (!(await askConfirm(o, `Remove managed activation and link configuration ${path}?`))) {
    console.log('Cancelled.')
    return true
  }
  let parsedRaw = null
  try {
    parsedRaw = parseYaml(readFileSync(path, 'utf8'))
  } catch (e) {
    throw new Error(`cannot parse link at ${path}: ${e.message}`)
  }
  const reference = linkSelfReference(parsedRaw)
  let selfRoot = o.self || parsedRaw?.self_context?.path || (o.rootExplicit ? o.root : null)
  if (reference.selfId) {
    // A portable link resolves its self like every other reader; an explicit self naming another self is refused.
    try {
      selfRoot = resolveLinkedSelf({ project, ...reference, explicitSelf: o.self || (o.rootExplicit ? o.root : null) }).path
    } catch (error) {
      if (error.code === 'SELF_ROOT_NOT_CANONICAL') throw error
      selfRoot = null
    }
  }
  let selfReachable = false
  if (selfRoot) {
    try {
      const cSelf = canonicalProjectPath(selfRoot)
      if (existsSync(cSelf) && !lstatSync(cSelf).isSymbolicLink() && isCanonicalSelf(cSelf)) {
        selfRoot = cSelf
        const regPath = registryFilePath(selfRoot)
        if (existsSync(regPath) && !lstatSync(regPath).isSymbolicLink()) selfReachable = true
      }
    } catch {}
  }
  if (!selfReachable && !o.force) {
    const err = new Error(`sovereign self at ${selfRoot || '(unspecified)'} is unreachable or invalid; refusing removal without sovereign revocation`)
    err.code = 'SOVEREIGN_SELF_UNREACHABLE'
    throw err
  }
  // Local activation is removed first, but a refused deactivation never blocks revocation: the registry, binding and
  // link.yaml are always revoked/removed below, so the hook and every other surface stop resolving context.
  try {
    for (const item of deactivateProject(project, { dryRun: o.dryRun }).filter(x => x.result === 'unremovable'))
      console.warn(`Warning: ${item.file}: ${redactRootPaths(item.message, [project, selfRoot])}`)
  } catch (error) {
    console.warn(
      `Warning: local activation was not fully removed (${redactRootPaths(error.message, [project, selfRoot])}); ` +
        `the link is still revoked. Fix the file and run 'holoself link deactivate --project <dir> --yes' to clean up.`
    )
  }
  if (!selfReachable) {
    console.warn(
      `Warning: sovereign self at ${selfRoot || '(unspecified)'} is unreachable or invalid; local link configuration and adapters removed, ` +
        `but sovereign registry was NOT updated. Run 'holoself link approve --project <dir> --revoke' from self root to complete sovereign revocation.`
    )
  } else await revokeSovereignLink(o, project, selfRoot, pId, canonicalProj)
  // A project_key binding is shared with this project's other machines through the synced self, so removing the link
  // here keeps it; only a legacy path-keyed entry (this machine's own) is removed.
  const keptBinding = 'lens binding kept for other machines; run \'holoself lens unbind\' to remove it everywhere'
  if (o.dryRun) {
    console.log(`[dry-run] would remove ${path}; indexes, reports, and proposals preserved`)
    if (reference.projectKey) console.log(`[dry-run] ${keptBinding}`)
    return true
  }
  if (selfReachable) {
    if (!reference.projectKey) writeBinding(selfRoot, project, null)
    else if (hasPathBinding(selfRoot, project)) writeBinding(selfRoot, project, null)
  }
  rmSync(path)
  console.log(`[ok] removed ${path}; indexes, reports, and proposals preserved`)
  if (reference.projectKey) console.log(`[ok] ${keptBinding}`)
  return true
}
