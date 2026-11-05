// holoself link add subcommand (moved verbatim from runEcosystem).
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { activateProject, preflightActivation } from '../../../adapters.mjs'
import { bindingsPath } from '../../../bindings.mjs'
import { loadLensRegistry } from '../../../lenses.mjs'
import { DEFAULT_PROJECT_EXCLUDES, createLinkDirs, inspectLinkCollisions, linkPath, linkSchemaErrors, writeLink } from '../../../link/config.mjs'
import { ensureSelfId } from '../../../link/machine.mjs'
import { canonicalProjectPath, canonicalSpaceId, isRegistryProject, nextAllowedLenses, readRegistry, withRegistryLock, writeRegistry } from '../../../link/registry.mjs'
import { atomicWrite, pathExists, safeRealpath, slash } from '../../../shared/fs.mjs'
import { askConfirm, hookPlanSummary, mcpPlanSummary, printHookResults, reportGrant } from '../../link-helpers.mjs'

export async function linkAdd(o, sub, project) {
  if (!o.self) throw new Error('link add requires --self <path>')
  if (!existsSync(project)) throw new Error(`project not found: ${project}`)
  const selfRoot = slash(safeRealpath(resolve(o.self)))
  if (!existsSync(selfRoot)) throw new Error(`self path not found: ${resolve(o.self)}`)
  if (!existsSync(join(selfRoot, 'profile')) || !existsSync(join(selfRoot, 'context')))
    throw new Error(`self path lacks profile/context layout: ${resolve(o.self)}`)
  const desired = {
    path: selfRoot,
    access: 'read',
    proposals: 'enabled',
    index: 'local',
    default_lens: o.lens || 'general',
    secondary_lenses: o.secondaryLenses || []
  }
  const desiredErrors = linkSchemaErrors(desired, loadLensRegistry(selfRoot))
  if (desiredErrors.length) throw new Error(desiredErrors.join('; '))
  const collisions = inspectLinkCollisions(project)
  if (collisions.length) {
    if (!o.force)
      throw new Error(
        `existing Holoself metadata collision: ${collisions.join(', ')}; ` +
          `use --force with explicit confirmation to preserve README and replace link configuration`
      )
    if (!(await askConfirm(o, `Replace link configuration while preserving existing project metadata (${collisions.join(', ')})?`))) return true
  }
  if (!o.noActivate) {
    const { plan } = preflightActivation(project, {
      activate: o.activate || 'auto',
      platforms: o.platforms || [],
      instructions: o.instructions,
      installSkill: o.installSkill || 'auto',
      hooks: o.hooks,
      mcp: o.mcp,
      approveReadTools: o.approveReadTools,
      skillHome: o.skillHome,
      dryRun: o.dryRun,
      force: o.force
    })
    console.log(
      JSON.stringify(
        {
          activation_plan: {
            canonical: plan.canonical,
            adapters: plan.adapters.map(x => ({
              id: x.id,
              file: x.file,
              support: x.support,
              delivery: x.delivery,
              discovery: x.discovery,
              tested_product: x.tested_product,
              tested_version: x.tested_version,
              evidence: x.evidence,
              last_verified: x.last_verified,
              detected: x.detected
            })),
            skills: plan.skills,
            global_skills: plan.globalSkills,
            ...hookPlanSummary(plan), ...mcpPlanSummary(plan),
            writes: plan.writes
          }
        },
        null,
        2
      )
    )
    if (!(await askConfirm(o, `Create link and modify bounded managed files: ${plan.writes.join(', ')}?`))) return true
  }
  const canonicalProj = canonicalProjectPath(project)
  const pId = canonicalSpaceId(project)
  const grantRequest = {
      lenses: [desired.default_lens, ...desired.secondary_lenses],
      named: [o.lens, ...(o.secondaryLenses || [])].filter(Boolean),
      explicit: Boolean(o.lens && o.secondaryLenses),
      accept: Boolean(o.acceptSharedLenses)
    },
    plannedGrant = nextAllowedLenses({ ...grantRequest, entry: readRegistry(selfRoot).links.find(l => isRegistryProject(l, project)) || null })
  reportGrant(project, plannedGrant, 'add')
  if (o.dryRun) {
    const link = {
      ...desired,
      project_context: { include: o.projectContext?.include || [], exclude: [...DEFAULT_PROJECT_EXCLUDES, ...(o.projectContext?.exclude || [])] }
    }
    console.log(`[dry-run] linked ${project} -> ${link.path}`)
    return true
  }
  // Widening an existing grant always has its own question.
  if (plannedGrant.pending.length && o.acceptSharedLenses)
    if (!(await askConfirm(o, `Grant this machine's link the shared lenses ${plannedGrant.pending.join(', ')}?`))) grantRequest.accept = false
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
  ensureSelfId(selfRoot)
  try {
    createLinkDirs(project, { preserveReadme: o.force })
    link = writeLink(project, selfRoot, desired.default_lens, desired.secondary_lenses, o.projectContext || {}, resolvedBindingSalt)
    await withRegistryLock(selfRoot, () => {
      const currentReg = readRegistry(selfRoot)
      const nowIso = new Date().toISOString()
      writeRegistry(
        selfRoot,
        links => {
          const idx = links.findIndex(l => l.project_id === pId || l.project_path === canonicalProj)
          const grant = nextAllowedLenses({ ...grantRequest, entry: idx >= 0 ? links[idx] : null })
          const entry = {
            project_id: pId,
            project_path: canonicalProj,
            ...(link.project_key ? { project_key: link.project_key } : {}),
            binding_salt: resolvedBindingSalt,
            allowed_lenses: grant.allowed,
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
    console.log(`[ok] linked ${project} -> ${link.path}`)
    if (!o.noActivate) {
      const result = activateProject(project, link, {
        activate: o.activate || 'auto',
        platforms: o.platforms || [],
        instructions: o.instructions,
        installSkill: o.installSkill || 'auto',
        hooks: o.hooks,
        mcp: o.mcp,
        approveReadTools: o.approveReadTools,
        skillHome: o.skillHome,
        dryRun: o.dryRun,
        force: o.force
      })
      for (const item of result.results) console.log(` - ${item.id}: ${item.file} (${item.result})`)
      printHookResults(result)
    }
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
