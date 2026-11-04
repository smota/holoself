// holoself link deactivate subcommand (moved verbatim from runEcosystem).
import { deactivateProject } from '../../../adapters.mjs'
import { askConfirm } from '../../link-helpers.mjs'

export async function linkDeactivate(o, sub, project) {
  const line = item => ` - ${item.adapter ? `${item.adapter}: ` : ''}${item.file || '(no files)'}: ${item.result}`,
    planned = deactivateProject(project, { dryRun: true, adapters: o.adapters })
  console.log(`Deactivation plan${o.adapters ? ` for ${o.adapters}` : ''}:`)
  for (const item of planned) console.log(line(item))
  if (o.dryRun || !(await askConfirm(o, 'Apply this deactivation plan? Link metadata is preserved.'))) return true
  const results = deactivateProject(project, { adapters: o.adapters })
  console.log('Applied:')
  for (const item of results) console.log(line(item))
  return true
}
