// holoself link setup subcommand (moved verbatim from runEcosystem).
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { stdin as input, stdout as output } from 'node:process'
import { activateProject, preflightActivation } from '../../../adapters.mjs'
import { bindingsPath } from '../../../bindings.mjs'
import { loadLensRegistry } from '../../../lenses.mjs'
import { createLinkDirs, inspectLinkCollisions, linkPath, linkSchemaErrors, writeLink } from '../../../link/config.mjs'
import { canonicalProjectPath, canonicalSpaceId, readRegistry, withRegistryLock, writeRegistry } from '../../../link/registry.mjs'
import { atomicWrite, pathExists, safeRealpath, slash } from '../../../shared/fs.mjs'
import { askConfirm, askValue, setupFindings } from '../../link-helpers.mjs'

export async function linkSetup(o, sub, project) {
  const findings = setupFindings(project)
  console.log(JSON.stringify(findings, null, 2))
  let self = o.self
  if (!self && input.isTTY && output.isTTY) {
    const answer = await askValue('Canonical self path')
    if (answer) self = resolve(answer)
  }
  if (!self) {
    if (o.yes) throw new Error('link setup requires --self <path> before confirmation')
    console.log('No changes made. Re-run with --self <path> --yes to create link.')
    return true
  }
  const selfRoot = slash(safeRealpath(resolve(self)))
  if (!existsSync(join(selfRoot, 'profile')) || !existsSync(join(selfRoot, 'context')))
    throw new Error(`self path lacks profile/context layout: ${resolve(self)}`)
  const setupRegistry = loadLensRegistry(selfRoot)
  const chosenDefaultLens = o.lens || findings.suggested_lens
  const chosenSecondary = o.secondaryLenses || []
  const desired = {
    path: selfRoot,
    access: 'read',
    proposals: 'enabled',
    index: 'local',
    default_lens: chosenDefaultLens,
    secondary_lenses: chosenSecondary
  }
  const desiredErrors = linkSchemaErrors(desired, setupRegistry)
  if (desiredErrors.length) throw new Error(desiredErrors.join('; '))
  const collisions = inspectLinkCollisions(project)
  if (collisions.length && !o.force) throw new Error(`existing Holoself metadata collision: ${collisions.join(', ')}; use --force with explicit confirmation`)
  if (!o.noActivate) {
    const { plan } = preflightActivation(project, {
      activate: o.activate || 'auto',
      platforms: o.platforms || [],
      instructions: o.instructions,
      installSkill: o.installSkill || 'auto',
      skillHome: o.skillHome,
      dryRun: o.dryRun,
      force: o.force
    })
    console.log(
      JSON.stringify(
        { activation_plan: { canonical: plan.canonical, adapters: plan.adapters, skills: plan.skills, global_skills: plan.globalSkills, writes: plan.writes } },
        null,
        2
      )
    )
  }
  if (
    !(await askConfirm(
      o,
      `${collisions.length ? 'Replace link configuration while preserving existing README and artifacts' : 'Create and activate link'} ` +
        `using ${self} and ${chosenDefaultLens} lens?`
    ))
  ) {
    console.log('Cancelled.')
    return true
  }
  if (o.dryRun) {
    console.log('[dry-run] setup complete; no files deleted or relocated')
    return true
  }
  const canonicalProj = canonicalProjectPath(project)
  const pId = canonicalSpaceId(project)
  const allowedLenses = [chosenDefaultLens, ...chosenSecondary].filter(l => l !== 'private')
  let existingReg = readRegistry(selfRoot)
  let prevEntrySnapshot = existingReg.links.find(l => l.project_id === pId || l.project_path === canonicalProj) || null
  let resolvedBindingSalt = null
  if (prevEntrySnapshot && typeof prevEntrySnapshot.binding_salt === 'string' && prevEntrySnapshot.binding_salt.length === 32 && !o.force) {
    resolvedBindingSalt = prevEntrySnapshot.binding_salt
  } else {
    resolvedBindingSalt = randomBytes(16).toString('hex')
  }
  const existingLink = pathExists(linkPath(project)) ? readFileSync(linkPath(project)) : null
  const bindingFile = bindingsPath(selfRoot),
    previousBindings = existsSync(bindingFile) ? readFileSync(bindingFile) : null
  let link
  try {
    createLinkDirs(project, { preserveReadme: o.force })
    link = writeLink(project, selfRoot, chosenDefaultLens, chosenSecondary, o.projectContext || {}, resolvedBindingSalt)
    await withRegistryLock(selfRoot, () => {
      const currentReg = readRegistry(selfRoot)
      const nowIso = new Date().toISOString()
      writeRegistry(
        selfRoot,
        links => {
          const idx = links.findIndex(l => l.project_id === pId || l.project_path === canonicalProj)
          const entry = {
            project_id: pId,
            project_path: canonicalProj,
            binding_salt: resolvedBindingSalt,
            allowed_lenses: allowedLenses,
            status: 'active',
            attested_by: 'owner:direct',
            created_at: idx >= 0 ? links[idx].created_at : nowIso,
            updated_at: nowIso,
            revoked_at: null
          }
          if (idx >= 0) links[idx] = entry
          else links.push(entry)
          return links
        },
        currentReg.registry_hash
      )
    })
    if (!o.noActivate) {
      const result = activateProject(project, link, {
        activate: o.activate || 'auto',
        platforms: o.platforms || [],
        instructions: o.instructions,
        installSkill: o.installSkill || 'auto',
        skillHome: o.skillHome,
        dryRun: o.dryRun,
        force: o.force
      })
      for (const item of result.results) console.log(` - ${item.id}: ${item.file} (${item.result})`)
    }
    console.log('[ok] setup complete; no files deleted or relocated')
  } catch (error) {
    if (previousBindings) atomicWrite(bindingFile, previousBindings)
    else if (existsSync(bindingFile)) rmSync(bindingFile)
    if (existingLink) atomicWrite(linkPath(project), existingLink)
    else if (pathExists(linkPath(project))) rmSync(linkPath(project), { force: true })
    try {
      await withRegistryLock(selfRoot, () => {
        const currentReg = readRegistry(selfRoot)
        writeRegistry(
          selfRoot,
          links => {
            const idx = links.findIndex(l => l.project_id === pId || l.project_path === canonicalProj)
            if (idx >= 0) {
              if (prevEntrySnapshot === null) links.splice(idx, 1)
              else links[idx] = prevEntrySnapshot
            }
            return links
          },
          currentReg.registry_hash
        )
      })
    } catch {}
    throw error
  }
  return true
}
