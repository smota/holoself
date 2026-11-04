// holoself link skill command (moved verbatim from runEcosystem).
import { migrateProjectSkillsToGlobal } from '../../adapters.mjs'
import { readLink } from '../../link/config.mjs'
import { askConfirm, projectPath } from '../link-helpers.mjs'

export async function runLinkSkill(o, sub) {
  if (o.args?.[1] !== 'migrate-global') throw new Error('link skill requires migrate-global')
  const project = projectPath(o),
    link = readLink(project),
    preview = migrateProjectSkillsToGlobal(project, link, { ...o, dryRun: true })
  console.log(JSON.stringify({ migration_plan: preview }, null, 2))
  if (o.dryRun) return true
  if (!(await askConfirm(o, `Migrate Holoself project skills to validated user-level installations and remove managed project copies in ${project}?`)))
    return true
  console.log(JSON.stringify(migrateProjectSkillsToGlobal(project, link, o), null, 2))
  return true
}
