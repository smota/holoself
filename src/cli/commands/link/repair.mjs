// holoself link repair subcommand: lens-binding migration, portable-link migration (docs/decisions/portable-links.md,
// section 7) and activation repair.
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { bindingsPath, hasPathBinding, resolveBinding } from '../../../bindings.mjs'
import { canonicalJson } from '../../../catalog.mjs'
import { loadLensRegistry, resolveLens } from '../../../lenses.mjs'
import { linkPath, linkProjectKeyTaken, readLink, renewLinkProjectKeyInPlace, writeLink } from '../../../link/config.mjs'
import { ensureSelfId, registerSelf, selfIdOf } from '../../../link/machine.mjs'
import { canonicalProjectPath, canonicalSpaceId, nextAllowedLenses, projectKeyReusedNotice, readRegistry, withRegistryLock, writeRegistry } from '../../../link/registry.mjs'
import { canonicalPath, samePath } from '../../../path-guard.mjs'
import { atomicWrite, slash } from '../../../shared/fs.mjs'
import { activateLinkedProject, askConfirm, repairSelection, reportGrant } from '../../link-helpers.mjs'

export async function linkRepair(o, sub, project) {
  let diagnostic = readLink(project, { tolerant: true, explicitSelf: o.self || null })
  if (diagnostic._schemaErrors.length) throw new Error(diagnostic._schemaErrors.join('; '))
  if (diagnostic._selfError) throw Object.assign(new Error(diagnostic._selfError.message), { code: diagnostic._selfError.code })
  if (o.self && !samePath(canonicalPath(resolve(o.self)), canonicalPath(diagnostic.path)))
    throw Object.assign(new Error('supplied self root does not match canonical link root'), { code: 'SELF_ROOT_NOT_CANONICAL' })
  // This project is a copy of another project attested earlier on this machine under the same project_key: give the copy
  // its own key (the original keeps it), which also resolves a PROJECT_KEY_CONFLICT. The copy inherits no binding.
  if (diagnostic.project_key && linkProjectKeyTaken(diagnostic.path, project)) {
    console.log(JSON.stringify({ project_key_renewal: { project: slash(project), reason: 'project_key already used by another project on this machine' } }, null, 2))
    if (o.dryRun) return true
    if (!(await askConfirm(o, 'Give this copied project its own project_key?'))) return true
    await withRegistryLock(diagnostic.path, () => {
      const previous = diagnostic.project_key,
        renewed = renewLinkProjectKeyInPlace(project),
        attestation = readRegistry(diagnostic.path)
      console.warn(projectKeyReusedNotice(previous, project))
      writeRegistry(
        diagnostic.path,
        links =>
          links.map(entry =>
            entry.project_id === canonicalSpaceId(project) || entry.project_path === canonicalProjectPath(project)
              ? { ...entry, project_key: renewed, updated_at: new Date().toISOString() }
              : entry
          ),
        attestation.registry_hash
      )
    })
    diagnostic = readLink(project, { tolerant: true, explicitSelf: o.self || null })
    if (!o.lens) {
      console.log(`[note] bind this project's lens with: holoself lens bind --root <self-root> --project <dir> --lens <id> --yes`)
      return true
    }
  }
  const rename = id => ({ career: 'professional', publishing: 'public-voice' })[id] || id
  const legacy = diagnostic._legacyBinding
    ? { default_lens: rename(diagnostic._legacyBinding.default_lens), secondary_lenses: diagnostic._legacyBinding.secondary_lenses.map(rename) }
    : null
  let current = null
  try {
    current = resolveBinding(diagnostic.path, project, { projectKey: diagnostic.project_key })
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
  const pathBinding = hasPathBinding(diagnostic.path, project),
    bindingMigration = Boolean(legacy || o.lens || !current),
    // Portable form: self_id and project_key in link.yaml, no machine path, binding keyed by project_key.
    portableMigration = !diagnostic.self_id || !diagnostic.project_key || Boolean(diagnostic._legacyPath) || pathBinding
  // The grant follows the one rule (nextAllowedLenses): only --lens is an explicit choice here. A binding or legacy
  // link.yaml field beyond this machine's grant is an add, and --yes alone never grants it.
  const attested =
      readRegistry(diagnostic.path).links.find(
        entry => entry.status === 'active' && (entry.project_id === canonicalSpaceId(project) || entry.project_path === canonicalProjectPath(project))
      ) || null,
    grantRequest = { lenses: [choice.default_lens, ...choice.secondary_lenses], explicit: Boolean(o.lens), accept: Boolean(o.acceptSharedLenses) },
    planned = attested ? nextAllowedLenses({ ...grantRequest, entry: attested }) : null,
    changesGrant = grant => canonicalJson(grant.allowed) !== canonicalJson(attested.allowed_lenses || [])
  if (planned) reportGrant(project, planned, 'repair')
  if (bindingMigration || portableMigration || (planned && changesGrant(planned))) {
    if (bindingMigration) console.log(JSON.stringify({ binding_migration: { project: slash(project), before: current, legacy, after: choice } }, null, 2))
    if (portableMigration)
      console.log(
        JSON.stringify(
          {
            portable_migration: {
              project: slash(project),
              self_id: selfIdOf(diagnostic.path) || 'new',
              project_key: diagnostic.project_key || 'new',
              registers_this_machine: true,
              drops_self_path: Boolean(diagnostic._legacyPath),
              rekeys_binding: pathBinding
            }
          },
          null,
          2
        )
      )
    if (o.dryRun) {
      if (!o.noActivate) await activateLinkedProject(o, project, diagnostic, 'Repair', repairSelection(project))
      return true
    }
    if (bindingMigration || portableMigration)
      if (!(await askConfirm(o, bindingMigration ? 'Migrate lens choice into self-side bindings?' : 'Migrate link to portable self_id and project_key?')))
        return true
    // Widening always has its own question, even when a migration question was asked.
    if (planned?.mode === 'existing' && planned.adds.length && o.acceptSharedLenses)
      if (!(await askConfirm(o, `Grant this machine's link the shared lenses ${planned.adds.join(', ')}?`))) grantRequest.accept = false
    const grant = attested ? nextAllowedLenses({ ...grantRequest, entry: attested }) : null
    const file = bindingsPath(diagnostic.path),
      before = existsSync(file) ? readFileSync(file) : null,
      linkBefore = readFileSync(linkPath(project))
    ensureSelfId(diagnostic.path)
    try {
      await withRegistryLock(diagnostic.path, () => {
        const attestation = readRegistry(diagnostic.path),
          pId = canonicalSpaceId(project),
          cPath = canonicalProjectPath(project)
        const written =
          bindingMigration || portableMigration
            ? writeLink(project, diagnostic.path, choice.default_lens, choice.secondary_lenses, diagnostic.project_context, diagnostic.binding_salt)
            : { project_key: diagnostic.project_key }
        writeRegistry(
          diagnostic.path,
          links =>
            links.map(entry =>
              entry.project_id === pId || entry.project_path === cPath
                ? {
                    ...entry,
                    ...(written.project_key ? { project_key: written.project_key } : {}),
                    ...(grant && entry.status === 'active' ? { allowed_lenses: grant.allowed } : {}),
                    updated_at: new Date().toISOString()
                  }
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
  } else if (!o.dryRun && diagnostic._selfSource !== 'map') registerSelf(diagnostic.path)
  if (!o.noActivate) await activateLinkedProject(o, project, readLink(project), 'Repair', repairSelection(project))
  return true
}
