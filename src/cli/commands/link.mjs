// holoself link lifecycle commands: one module per subcommand under ./link/.
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { stdin as input, stdout as output } from 'node:process'
import { activateProject, preflightActivation } from '../../adapters.mjs'
import { loadLensRegistry, resolveLens } from '../../lenses.mjs'
import { DEFAULT_PROJECT_EXCLUDES, createLinkDirs, inspectLinkCollisions, writeLink } from '../../link/config.mjs'
import { askConfirm, askValue, projectPath, setupFindings, hookPlanSummary, mcpPlanSummary, printHookResults } from '../link-helpers.mjs'

import { linkAdd } from './link/add.mjs'
import { linkSetup } from './link/setup.mjs'
import { linkApprove } from './link/approve.mjs'
import { linkBackfill } from './link/backfill.mjs'
import { linkPrune } from './link/prune.mjs'
import { linkStatus } from './link/status.mjs'
import { linkRemove } from './link/remove.mjs'
import { linkActivate } from './link/activate.mjs'
import { linkRepair } from './link/repair.mjs'
import { linkDeactivate } from './link/deactivate.mjs'
import { linkDoctor } from './link/doctor.mjs'

// Subcommands in their original evaluation order. A handler that completes without returning falls
// through to the next match and then to the legacy setup tail, exactly as the former if-chain did.
export const LINK_SUBCOMMANDS = [
  { name: 'add', run: linkAdd },
  { name: 'setup', run: linkSetup },
  { name: 'approve', run: linkApprove },
  { name: 'backfill', run: linkBackfill },
  { name: 'prune', run: linkPrune },
  { name: 'status', run: linkStatus },
  { name: 'remove', run: linkRemove },
  { name: 'activate', run: linkActivate },
  { name: 'repair', run: linkRepair },
  { name: 'deactivate', run: linkDeactivate },
  { name: 'doctor', run: linkDoctor }
]

export async function runLink(o, sub) {
  const project = sub === 'backfill' && o.all && !o.project && !o.target ? null : projectPath(o)
  for (const { name, run } of LINK_SUBCOMMANDS) {
    if (sub !== name) continue
    const result = await run(o, sub, project)
    if (result !== undefined) return result
  }
  return linkSetupTail(o, sub, project)
}

// Former trailing statement of the link branch, reached only when no subcommand returned.
async function linkSetupTail(o, sub, project) {
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
  if (!existsSync(join(self, 'profile')) || !existsSync(join(self, 'context'))) throw new Error(`self path lacks profile/context layout: ${resolve(self)}`)
  const setupRegistry = loadLensRegistry(resolve(self))
  resolveLens(setupRegistry, o.lens || findings.suggested_lens)
  for (const lens of o.secondaryLenses || []) resolveLens(setupRegistry, lens)
  const collisions = inspectLinkCollisions(project)
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
        `using ${self} and ${o.lens || findings.suggested_lens} lens?`
    ))
  ) {
    console.log('Cancelled.')
    return true
  }
  let link
  if (o.dryRun)
    link = {
      path: resolve(self),
      access: 'read',
      proposals: 'enabled',
      index: 'local',
      default_lens: o.lens || findings.suggested_lens,
      secondary_lenses: o.secondaryLenses || [],
      project_context: { include: o.projectContext?.include || [], exclude: [...DEFAULT_PROJECT_EXCLUDES, ...(o.projectContext?.exclude || [])] }
    }
  else {
    createLinkDirs(project, { preserveReadme: o.force })
    link = writeLink(project, self, o.lens || findings.suggested_lens, o.secondaryLenses || [], o.projectContext || {})
  }
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
  console.log(`${o.dryRun ? '[dry-run] ' : '[ok] '}setup complete; no files deleted or relocated`)
  return true
}
