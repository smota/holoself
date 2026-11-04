// Workbench configuration boundary. The caller supplies validated canonical paths and
// holds the registry lock over its complete transaction, including recovery.
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readBindings } from '../bindings.mjs'
import { loadLensRegistry } from '../lenses.mjs'
import { pathExists } from '../shared/fs.mjs'
import { parseYaml } from '../shared/yaml.mjs'
import {
  DEFAULT_PROJECT_EXCLUDES,
  createLinkDirs,
  inspectLinkCollisions,
  linkPath,
  linkSchemaErrors,
  projectContextErrors,
  readLink,
  writeLink
} from './config.mjs'
import { canonicalProjectPath, canonicalSpaceId, readRegistry, withRegistryLock, writeRegistry } from './registry.mjs'
export function spaceLinkConfiguration(project, self, { lens = 'general', metadataAbsent = false } = {}) {
  const existing = !metadataAbsent && pathExists(linkPath(project)) ? readLink(project, { tolerant: true }) : null
  if (!metadataAbsent) inspectLinkCollisions(project)
  const registry = loadLensRegistry(self),
    binding = readBindings(self, { registry }).bindings[canonicalProjectPath(project)]
  const desired = {
    path: self,
    access: 'read',
    proposals: 'enabled',
    index: 'local',
    default_lens: binding?.default_lens || existing?.default_lens || lens,
    secondary_lenses: binding?.secondary_lenses || existing?.secondary_lenses || [],
    project_context: existing
      ? parseYaml(readFileSync(linkPath(project), 'utf8')).project_context || {}
      : { include: [], exclude: DEFAULT_PROJECT_EXCLUDES, assert_include: [], assert_exclude: [] }
  }
  const { project_context, ...selfContext } = desired
  const errors = [...linkSchemaErrors(selfContext, registry), ...projectContextErrors(project_context)]
  if (errors.length) throw new Error(errors.join('; '))
  const sovereign = readRegistry(self),
    entry = sovereign.links.find(x => x.project_id === canonicalSpaceId(project) || x.project_path === canonicalProjectPath(project))
  return {
    link: desired,
    registry_hash: sovereign.registry_hash,
    lens_registry_hash: registry.registry_hash,
    binding_salt: entry?.binding_salt || existing?.binding_salt || null
  }
}
export function readSpaceLink(project) {
  return readLink(project)
}
export const withSpaceConfigurationLock = (self, fn) => withRegistryLock(self, fn)
export function configureSpaceLink(project, self, configuration) {
  const { link } = configuration,
    salt = configuration.binding_salt || randomBytes(16).toString('hex'),
    now = new Date().toISOString()
  createLinkDirs(project, { preserveReadme: true, purgeLegacy: false })
  const written = writeLink(project, self, link.default_lens, link.secondary_lenses, link.project_context, salt)
  writeRegistry(
    self,
    links => {
      const project_id = canonicalSpaceId(project),
        project_path = canonicalProjectPath(project),
        index = links.findIndex(x => x.project_id === project_id || x.project_path === project_path),
        entry = {
          project_id,
          project_path,
          binding_salt: salt,
          allowed_lenses: [link.default_lens, ...link.secondary_lenses],
          status: 'active',
          attested_by: 'owner:direct',
          created_at: index >= 0 ? links[index].created_at : now,
          updated_at: now,
          revoked_at: null
        }
      if (index >= 0) links[index] = entry
      else links.push(entry)
      return links
    },
    configuration.registry_hash
  )
  return written
}
