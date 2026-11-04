// holoself link activate subcommand (moved verbatim from runEcosystem).
import { readLink } from '../../../link/config.mjs'
import { activateLinkedProject } from '../../link-helpers.mjs'

export async function linkActivate(o, sub, project) {
  const link = readLink(project)
  await activateLinkedProject(o, project, link, 'Activate')
  return true
}
