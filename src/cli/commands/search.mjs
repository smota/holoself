// holoself search command (moved verbatim from runEcosystem).
import { readIndex, searchIndex } from '../../catalog/index.mjs'
import { loadLensRegistry, resolveLens } from '../../lenses.mjs'
import { linkedLensAuthority } from '../../link/attestation.mjs'
import { readLink } from '../../link/config.mjs'
import { projectPath } from '../link-helpers.mjs'

export async function runSearch(o, sub) {
  const query = o.args.join(' ')
  if (!query) throw new Error('search requires a query')
  const project = projectPath(o),
    link = readLink(project),
    registry = loadLensRegistry(link.path),
    lens = o.lens || link.default_lens || 'general',
    resolution = resolveLens(registry, lens)
  const allowedLenses = linkedLensAuthority(project, link, lens)
  const index = readIndex(project, true, false, { federated: Boolean(o.federated), spaces: o.spaces, lens })
  let results = searchIndex(index, query, lens, registry, resolution, o.temporal || 'current', {
    federated: Boolean(o.federated),
    spaces: o.spaces,
    effective_allowed_lenses: allowedLenses
  })
  console.log(JSON.stringify({ query, federated: Boolean(o.federated), results }, null, 2))
  return true
}
