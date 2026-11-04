// holoself link repair subcommand (moved verbatim from runEcosystem).
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { bindingsPath, resolveBinding } from '../../../bindings.mjs'
import { canonicalJson } from '../../../catalog.mjs'
import { loadLensRegistry, resolveLens } from '../../../lenses.mjs'
import { linkPath, readLink, writeLink } from '../../../link/config.mjs'
import { canonicalProjectPath, canonicalSpaceId, readRegistry, withRegistryLock, writeRegistry } from '../../../link/registry.mjs'
import { atomicWrite, slash } from '../../../shared/fs.mjs'
import { activateLinkedProject, askConfirm, repairSelection } from '../../link-helpers.mjs'

export async function linkRepair(o, sub, project) {
  const diagnostic = readLink(project, { tolerant: true })
  if (diagnostic._schemaErrors.length) throw new Error(diagnostic._schemaErrors.join('; '))
  const rename = id => ({ career: 'professional', publishing: 'public-voice' })[id] || id
  const legacy = diagnostic._legacyBinding
    ? { default_lens: rename(diagnostic._legacyBinding.default_lens), secondary_lenses: diagnostic._legacyBinding.secondary_lenses.map(rename) }
    : null
  let current = null
  try {
    current = resolveBinding(diagnostic.path, project)
  } catch (error) {
    if (error.code !== 'LENS_BINDING_REQUIRED') throw error
  }
  const choice = o.lens ? { default_lens: o.lens, secondary_lenses: o.secondaryLenses || [] } : current || legacy
  if (!choice) throw new Error(diagnostic._bindingError)
  if (current && legacy && !o.lens && canonicalJson(current) !== canonicalJson(legacy))
    throw new Error('legacy lens choice conflicts with self binding; pass --lens and --secondary-lenses to choose explicitly')
  const registry = loadLensRegistry(diagnostic.path)
  resolveLens(registry, choice.default_lens)
  for (const id of choice.secondary_lenses) resolveLens(registry, id)
  if (legacy || o.lens || !current) {
    console.log(JSON.stringify({ binding_migration: { project: slash(project), before: current, legacy, after: choice } }, null, 2))
    if (o.dryRun) {
      if (!o.noActivate) await activateLinkedProject(o, project, diagnostic, 'Repair', repairSelection(project))
      return true
    }
    if (!(await askConfirm(o, 'Migrate lens choice into self-side bindings?'))) return true
    const file = bindingsPath(diagnostic.path),
      before = existsSync(file) ? readFileSync(file) : null,
      linkBefore = readFileSync(linkPath(project))
    try {
      await withRegistryLock(diagnostic.path, () => {
        const attestation = readRegistry(diagnostic.path),
          pId = canonicalSpaceId(project),
          cPath = canonicalProjectPath(project)
        writeLink(project, diagnostic.path, choice.default_lens, choice.secondary_lenses, diagnostic.project_context, diagnostic.binding_salt)
        writeRegistry(
          diagnostic.path,
          links =>
            links.map(entry =>
              entry.project_id === pId || entry.project_path === cPath
                ? { ...entry, allowed_lenses: [choice.default_lens, ...choice.secondary_lenses], updated_at: new Date().toISOString() }
                : entry
            ),
          attestation.registry_hash
        )
      })
    } catch (error) {
      atomicWrite(linkPath(project), linkBefore)
      if (before) atomicWrite(file, before)
      else if (existsSync(file)) rmSync(file)
      throw error
    }
  }
  if (!o.noActivate) await activateLinkedProject(o, project, readLink(project), 'Repair', repairSelection(project))
  return true
}
