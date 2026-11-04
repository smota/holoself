// holoself instructions command (moved verbatim from runEcosystem).
import { HARVEST_PROMPT_NAME, HARVEST_PROMPT_VERSION, auditInstructions, bootstrapText, harvestPromptText, readRuntime } from '../../adapters.mjs'
import { readLink } from '../../link/config.mjs'
import { slash } from '../../shared/fs.mjs'
import { projectPath } from '../link-helpers.mjs'

export async function runInstructions(o, sub) {
  const project = projectPath(o),
    action = sub || 'audit'
  if (action === 'render' && o.harvest) {
    if (o.project || o.target) readLink(project)
    const content = harvestPromptText(o.focus !== undefined ? { focus: o.focus } : {})
    console.log(o.json ? JSON.stringify({ schema_version: HARVEST_PROMPT_VERSION, prompt: HARVEST_PROMPT_NAME, content }, null, 2) : content)
    return true
  }
  const link = readLink(project)
  if (action === 'render') {
    const content = bootstrapText(link)
    console.log(o.json ? JSON.stringify({ schema_version: 1, project: slash(project), adapter: o.adapter || 'generic', content }, null, 2) : content.trimEnd())
    return true
  }
  if (action !== 'audit') throw new Error('instructions requires render or audit')
  const result = auditInstructions(project, link, readRuntime(project))
  console.log(JSON.stringify(result, null, 2))
  if (result.status !== 'valid') process.exitCode = 1
  return true
}
