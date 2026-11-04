// Registry attestation of a project link and the lenses it is granted.
import { canonicalProjectPath, canonicalSpaceId, readRegistry } from './registry.mjs'

export function linkedLensAuthority(project, link, lens) {
  const entry = readRegistry(link.path).links.find(
    entry => entry.project_id === canonicalSpaceId(project) || entry.project_path === canonicalProjectPath(project)
  )
  if (!entry || entry.status !== 'active' || !link.binding_salt || entry.binding_salt !== link.binding_salt) {
    const error = new Error(
      `Link not attested in self registry or binding_salt mismatch: ${project}. Run holoself link approve --project <dir> from self root to activate.`
    )
    error.code = 'LENS_NOT_GRANTED'
    throw error
  }
  const allowed = new Set([link.default_lens, ...link.secondary_lenses].filter(id => id !== 'private' && (entry.allowed_lenses || []).includes(id)))
  if (!allowed.has(lens)) {
    const error = new Error(`unknown lens or lens is not granted by this project link: ${lens}`)
    error.code = 'LENS_NOT_GRANTED'
    throw error
  }
  return allowed
}
