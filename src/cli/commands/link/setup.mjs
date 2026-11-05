// holoself link setup subcommand (moved verbatim from runEcosystem).
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { stdin as input, stdout as output } from 'node:process'
import { activateProject, preflightActivation } from '../../../adapters.mjs'
import { bindingsPath, resolveBinding } from '../../../bindings.mjs'
import { loadLensRegistry } from '../../../lenses.mjs'
import { createLinkDirs, inspectLinkCollisions, linkPath, linkSchemaErrors, writeLink } from '../../../link/config.mjs'
import { ensureSelfId, isProjectKey, selfIdOf } from '../../../link/machine.mjs'
import { canonicalProjectPath, canonicalSpaceId, isRegistryProject, nextAllowedLenses, projectKeyHolders, readRegistry, withRegistryLock, writeRegistry } from '../../../link/registry.mjs'
import { lstat } from '../../../path-guard.mjs'
import { assertContainedPath, atomicWrite, pathExists, safeRealpath, slash } from '../../../shared/fs.mjs'
import { parseYaml } from '../../../shared/yaml.mjs'
import { applySpaceAction, planSpaceAction } from '../../../space-actions.mjs'
import { askConfirm, askValue, reportGrant, setupFindings, hookPlanSummary, mcpPlanSummary, printHookResults } from '../../link-helpers.mjs'

async function migrateLegacyMount(o, project) {
  const findings = setupFindings(project),
    request = {
      root: o.self,
      project,
      action: 'setup',
      lens: o.lens || findings.suggested_lens || 'general',
      explicitLens: o.lens,
      secondaryLenses: o.secondaryLenses,
      acceptSharedLenses: o.acceptSharedLenses,
      projectContext: o.projectContext,
      activate: o.activate,
      platforms: o.platforms,
      instructions: o.instructions,
      installSkill: o.installSkill,
      hooks: o.hooks,
      mcp: o.mcp,
      approveReadTools: o.approveReadTools,
      skillHome: o.skillHome,
      force: o.force,
      noActivate: o.noActivate
    },
    plan = planSpaceAction(request),
    metadata = join(plan.project, '.holoself'),
    mountDep = plan.dependencies.find(x => x.path === metadata)
  const preview = {
    mode: 'legacy-mount-migration',
    legacy: true,
    project: slash(plan.project),
    self: slash(plan.root),
    mount: slash(metadata),
    mount_target: slash(mountDep?.target || plan.root),
    default_lens: plan.configuration.link.default_lens,
    secondary_lenses: plan.configuration.link.secondary_lenses,
    plan_hash: plan.plan_hash,
    files: plan.files.map(item => ({ path: slash(item.path), operation: item.operation })),
    transient_files: plan.transient_files.map(slash),
    findings,
    ...(plan.activation
      ? {
          activation_plan: {
            canonical: plan.activation.canonical,
            adapters: plan.activation.adapters,
            skills: plan.activation.skills,
            global_skills: plan.activation.globalSkills,
            ...hookPlanSummary(plan.activation),
            ...mcpPlanSummary(plan.activation),
            writes: plan.activation.writes
          }
        }
      : {})
  }
  console.log(JSON.stringify(preview, null, 2))
  if (o.dryRun) {
    console.log('[dry-run] setup complete; no files deleted or relocated')
    return true
  }
  if (
    !(await askConfirm(
      o,
      `Migrate legacy mount ${metadata} -> ${plan.root} to a metadata link using ${plan.configuration.link.default_lens} lens?`
    ))
  ) {
    console.log('Cancelled.')
    return true
  }
  const applied = await applySpaceAction(request, plan.plan_hash, { afterConfigure: o.afterConfigure })
  if (applied.activation) {
    for (const item of applied.activation.results) console.log(` - ${item.id}: ${item.file} (${item.result})`)
    printHookResults(applied.activation)
  }
  console.log('[ok] setup complete; no files deleted or relocated')
  return true
}

export async function linkSetup(o, sub, project) {
  if (lstat(join(project, '.holoself'))?.isSymbolicLink()) return migrateLegacyMount(o, project)
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
  // Another machine already linked this project to this same self (a synced portable link.yaml naming this self's
  // self_id): setup joins it on this machine, keeping its project_key, binding_salt and lens binding unless --force.
  // A key that another project on this machine already holds (a copied folder) is not joined: writeLink gives this
  // project a new key, and nothing of the other project (binding, salt) is inherited.
  const joined = o.force ? null : portableLinkFor(project, selfRoot)
  let joinedBinding = null
  if (joined && !joined.taken)
    try {
      joinedBinding = resolveBinding(selfRoot, project, { registry: setupRegistry, projectKey: joined.projectKey })
    } catch {}
  const chosenDefaultLens = o.lens || joinedBinding?.default_lens || findings.suggested_lens
  const chosenSecondary = o.secondaryLenses || (o.lens ? null : joinedBinding?.secondary_lenses) || []
  // Inherited lenses are always shown before confirmation; explicit --lens/--secondary-lenses win over them.
  const joinNotice =
    joinedBinding && !o.lens ? `joining existing project ${joined.projectKey}: lenses ${[chosenDefaultLens, ...chosenSecondary].join(', ')}` : null
  if (joinNotice) console.log(joinNotice)
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
  const grantRequest = {
      lenses: [chosenDefaultLens, ...chosenSecondary],
      named: [o.lens, ...(o.secondaryLenses || [])].filter(Boolean),
      explicit: Boolean(o.lens && o.secondaryLenses),
      accept: Boolean(o.acceptSharedLenses)
    },
    sameProject = l => isRegistryProject(l, project),
    plannedGrant = nextAllowedLenses({ ...grantRequest, entry: readRegistry(selfRoot).links.find(sameProject) || null })
  reportGrant(project, plannedGrant, 'setup')
  const collisions = inspectLinkCollisions(project).filter(path => !(joined && path === linkPath(project)))
  if (collisions.length && !o.force) throw new Error(`existing Holoself metadata collision: ${collisions.join(', ')}; use --force with explicit confirmation`)
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
        { activation_plan: { canonical: plan.canonical, adapters: plan.adapters, skills: plan.skills, global_skills: plan.globalSkills, ...hookPlanSummary(plan), ...mcpPlanSummary(plan), writes: plan.writes } },
        null,
        2
      )
    )
  }
  if (
    !(await askConfirm(
      o,
      `${collisions.length ? 'Replace link configuration while preserving existing README and artifacts' : 'Create and activate link'} ` +
        `using ${self} and ${chosenDefaultLens} lens${joinNotice ? ` (${joinNotice})` : ''}?`
    ))
  ) {
    console.log('Cancelled.')
    return true
  }
  if (o.dryRun) {
    console.log('[dry-run] setup complete; no files deleted or relocated')
    return true
  }
  // Widening an existing grant always has its own question.
  if (plannedGrant.pending.length && o.acceptSharedLenses)
    if (!(await askConfirm(o, `Grant this machine's link the shared lenses ${plannedGrant.pending.join(', ')}?`))) grantRequest.accept = false
  const canonicalProj = canonicalProjectPath(project)
  const pId = canonicalSpaceId(project)
  let existingReg = readRegistry(selfRoot)
  let prevEntrySnapshot = existingReg.links.find(l => l.project_id === pId || l.project_path === canonicalProj) || null
  let resolvedBindingSalt = null
  if (prevEntrySnapshot && typeof prevEntrySnapshot.binding_salt === 'string' && prevEntrySnapshot.binding_salt.length === 32 && !o.force) {
    resolvedBindingSalt = prevEntrySnapshot.binding_salt
  } else if (joined?.bindingSalt && !joined.taken) {
    resolvedBindingSalt = joined.bindingSalt
  } else {
    resolvedBindingSalt = randomBytes(16).toString('hex')
  }
  const existingLink = pathExists(linkPath(project)) ? readFileSync(linkPath(project)) : null
  const bindingFile = bindingsPath(selfRoot),
    previousBindings = existsSync(bindingFile) ? readFileSync(bindingFile) : null
  let link
  ensureSelfId(selfRoot)
  try {
    createLinkDirs(project, { preserveReadme: o.force || Boolean(joined) })
    link = writeLink(project, selfRoot, chosenDefaultLens, chosenSecondary, o.projectContext || joined?.projectContext || {}, resolvedBindingSalt)
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

// The synced portable link already in the project when it names this self, else null.
function portableLinkFor(project, selfRoot) {
  const path = linkPath(project),
    info = lstat(path)
  if (!info || info.isSymbolicLink() || !info.isFile()) return null
  let parsed
  try {
    parsed = parseYaml(readFileSync(assertContainedPath(project, path, 'link configuration'), 'utf8'))
  } catch {
    return null
  }
  const selfId = selfIdOf(selfRoot)
  if (!selfId || parsed?.self_context?.self_id !== selfId || !isProjectKey(parsed?.project_key)) return null
  const salt = parsed.self_context.binding_salt
  const projectContext = parsed.project_context && typeof parsed.project_context === 'object' && !Array.isArray(parsed.project_context) ? parsed.project_context : null
  return {
    projectKey: parsed.project_key,
    bindingSalt: typeof salt === 'string' && /^[0-9a-f]{32}$/.test(salt) ? salt : null,
    projectContext,
    taken: projectKeyHolders(readRegistry(selfRoot).links, parsed.project_key, project).length > 0
  }
}
