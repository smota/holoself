// holoself skill command (moved verbatim from runEcosystem).
import { globalSkillStatus, installGlobalSkills } from '../../adapters.mjs'
import { askConfirm } from '../link-helpers.mjs'

export async function runSkill(o, sub) {
  if (o.scope && o.scope !== 'user') throw new Error('skill --scope currently supports only user')
  if (sub === 'status') {
    console.log(JSON.stringify(globalSkillStatus(o), null, 2))
    return true
  }
  if (sub === 'install') {
    const preview = installGlobalSkills({ ...o, dryRun: true })
    console.log(JSON.stringify({ installation_plan: preview }, null, 2))
    if (o.dryRun) return true
    if (!(await askConfirm(o, `Install the full public Holoself skill for the user at: ${preview.installations.map(x => x.path).join(', ')}?`))) return true
    console.log(JSON.stringify(installGlobalSkills(o), null, 2))
    return true
  }
  throw new Error('skill requires status or install')
}
