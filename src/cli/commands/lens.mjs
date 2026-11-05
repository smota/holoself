// holoself lens command (moved verbatim from runEcosystem).
import { existsSync, lstatSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { bindingProjects, bindingsPath, readBindings, writeBinding } from '../../bindings.mjs'
import { linkProjectKey, linkProjectKeyTaken, projectKeyTakenError } from '../../link/config.mjs'
import { isProjectKey } from '../../link/machine.mjs'
import { loadLensRegistry, resolveLens } from '../../lenses.mjs'
import { canonicalProjectPath, canonicalSpaceId, readRegistry, withRegistryLock, writeRegistry } from '../../link/registry.mjs'
import { atomicWrite, slash } from '../../shared/fs.mjs'
import { askConfirm } from '../link-helpers.mjs'

export async function runLens(o, sub) {
  const root = resolve(o.root)
  if (!existsSync(root) || lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) throw new Error(`invalid self root: ${root}`)
  const registry = loadLensRegistry(root)
  if (sub === 'bindings') {
    console.log(JSON.stringify(describeBindings(root), null, 2))
    return true
  }
  if (sub === 'bind' || sub === 'unbind') {
    if (!o.project) throw new Error(`lens ${sub} requires --project <absolute path>`)
    const choice = sub === 'unbind' ? null : { default_lens: o.lens || 'general', secondary_lenses: o.secondaryLenses || [] },
      before = readBindings(root)
    if (o.bindingHash !== undefined && o.bindingHash !== before.hash) throw new Error('lens bindings changed on disk')
    // The binding is shared by every project with this key; a copied folder must get its own key first.
    if (linkProjectKeyTaken(root, o.project)) throw projectKeyTakenError(o.project)
    if (choice) {
      resolveLens(registry, choice.default_lens)
      for (const id of choice.secondary_lenses) resolveLens(registry, id)
    }
    console.log(JSON.stringify({ project: slash(o.project), binding: choice }, null, 2))
    if (o.dryRun) return true
    if (!(await askConfirm(o, `${sub === 'unbind' ? 'Remove' : 'Save'} self-side lens binding?`))) return true
    const file = bindingsPath(root),
      snapshot = existsSync(file) ? readFileSync(file) : null
    try {
      await withRegistryLock(root, () => {
        const attestation = readRegistry(root),
          pId = canonicalSpaceId(o.project),
          cPath = canonicalProjectPath(o.project)
        writeBinding(root, o.project, choice, { expectedHash: before.hash, projectKey: linkProjectKey(o.project) })
        writeRegistry(
          root,
          links =>
            links.map(entry =>
              entry.project_id === pId || entry.project_path === cPath
                ? { ...entry, allowed_lenses: choice ? [choice.default_lens, ...choice.secondary_lenses] : [], updated_at: new Date().toISOString() }
                : entry
            ),
          attestation.registry_hash
        )
      })
    } catch (error) {
      if (snapshot) atomicWrite(file, snapshot)
      else if (existsSync(file)) rmSync(file)
      throw error
    }
    console.log(JSON.stringify(describeBindings(root), null, 2))
    return true
  }
  if (sub === 'list') {
    console.log(
      JSON.stringify(
        {
          root: slash(root),
          registry_path: slash(registry.registry_path),
          registry_hash: registry.registry_hash,
          lenses: registry.lenses.map(lens => ({ ...lens, sensitivity_access: [...lens.sensitivity_access] }))
        },
        null,
        2
      )
    )
    return true
  }
  if (sub === 'show') {
    const id = o.args?.[1]
    if (!id) throw new Error('lens show requires <id>')
    const lens = resolveLens(registry, id)
    console.log(
      JSON.stringify({ root: slash(root), registry_hash: registry.registry_hash, lens: { ...lens, sensitivity_access: [...lens.sensitivity_access] } }, null, 2)
    )
    return true
  }
  if (sub === 'validate') {
    console.log(
      JSON.stringify(
        {
          status: 'valid',
          root: slash(root),
          registry_path: slash(registry.registry_path),
          registry_hash: registry.registry_hash,
          definitions: registry.lenses.length
        },
        null,
        2
      )
    )
    return true
  }
  throw new Error('lens requires list, show, or validate')
}

// The bindings file, plus (only when project_key entries exist) the project path each key maps to on this machine
// through the attestation registry; null for a key attested only on another machine.
function describeBindings(root) {
  const store = readBindings(root)
  let links = []
  try {
    links = readRegistry(root).links
  } catch {}
  const keyed = bindingProjects(store.bindings, links).filter(item => isProjectKey(item.key))
  return keyed.length ? { ...store, projects: Object.fromEntries(keyed.map(item => [item.key, item.project])) } : store
}
