// Context phase 1: caller identity (linked project or direct owner) and lens authority.
import { existsSync, lstatSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { loadLensRegistry, resolveLens } from '../lenses.mjs'
import { linkedLensAuthority } from '../link/attestation.mjs'
import { findLinkUpwards, isCanonicalSelf, linkPath, readLink } from '../link/config.mjs'
import { canonicalSpaceId } from '../link/registry.mjs'
import { assertContainedPath, pathExists, safeRealpath, slash } from '../shared/fs.mjs'

// Resolves who is asking: a linked project (explicit --project or found upwards from cwd) or the direct owner.
export function resolveCaller(o) {
  if (o.identity !== undefined) {
    const err = new Error('identity not accepted from caller')
    err.code = 'IDENTITY_NOT_ACCEPTED_FROM_CALLER'
    throw err
  }
  const surface = o.surface || (o.project ? 'cli-linked' : 'cli-direct')

  const cwd = process.cwd()
  let project = o.project ? resolve(o.project) : null
  let link = null
  let self = null
  let identity = null

  if (project) {
    const holoselfDir = join(project, '.holoself')
    if (existsSync(holoselfDir) && lstatSync(holoselfDir).isSymbolicLink()) {
      const err = new Error(`project uses a legacy filesystem junction mount: ${project}; run holoself link setup to migrate to a bounded link`)
      err.code = 'LEGACY_MOUNT_DETECTED'
      throw err
    }
    const candidateLink = linkPath(project)
    if (!pathExists(candidateLink)) {
      const shown = /\s/.test(project) ? JSON.stringify(project) : project
      const hint = isCanonicalSelf(project)
        ? `; ${project} is a canonical data root, not a linked project: run \`holoself context --root ${shown}\` from inside it, without --project`
        : ''
      const err = new Error(`project is not linked to any Holoself canonical root: ${project}${hint}`)
      err.code = 'LINK_REQUIRED'
      throw err
    }
    link = readLink(project)
    self = link.path
    if (!existsSync(self)) {
      const err = new Error(`self path not found: ${self}`)
      err.code = 'SELF_ROOT_MISSING'
      throw err
    }
    if (o.self || o.rootExplicit) {
      const callerSelf = resolve(o.self || o.root)
      const cmpCaller = process.platform === 'win32' ? slash(safeRealpath(callerSelf)).toLowerCase() : slash(safeRealpath(callerSelf))
      const cmpLink = process.platform === 'win32' ? slash(safeRealpath(link.path)).toLowerCase() : slash(safeRealpath(link.path))
      if (cmpCaller !== cmpLink) {
        const err = new Error('supplied self root does not match canonical link root')
        err.code = 'SELF_ROOT_NOT_CANONICAL'
        throw err
      }
    }
    identity = {
      kind: 'client:linked',
      project,
      self: link.path,
      allowedLenses: new Set([link.default_lens, ...(link.secondary_lenses || [])])
    }
  } else {
    // An explicit canonical root containing the caller owns this direct request,
    // even when that root lives below another project's link. Explicit project
    // selection was already resolved above and retains linked authority.
    let explicitOwnerRoot = false
    if (o.rootExplicit) {
      const candidate = resolve(o.self || o.root)
      if (isCanonicalSelf(candidate))
        try {
          assertContainedPath(candidate, cwd, 'caller working directory')
          explicitOwnerRoot = true
        } catch {}
    }
    const found = explicitOwnerRoot ? null : findLinkUpwards(cwd)
    if (found) {
      project = found.projectDir
      link = readLink(project)
      self = link.path
      if (!existsSync(self)) {
        const err = new Error(`self path not found: ${self}`)
        err.code = 'SELF_ROOT_MISSING'
        throw err
      }
      if (o.self || o.rootExplicit) {
        const callerSelf = resolve(o.self || o.root)
        const cmpCaller = process.platform === 'win32' ? slash(safeRealpath(callerSelf)).toLowerCase() : slash(safeRealpath(callerSelf))
        const cmpLink = process.platform === 'win32' ? slash(safeRealpath(link.path)).toLowerCase() : slash(safeRealpath(link.path))
        if (cmpCaller !== cmpLink) {
          const err = new Error('supplied self root does not match canonical link root')
          err.code = 'SELF_ROOT_NOT_CANONICAL'
          throw err
        }
      }
      identity = {
        kind: 'client:linked',
        project,
        self: link.path,
        allowedLenses: new Set([link.default_lens, ...(link.secondary_lenses || [])])
      }
    } else {
      if (surface === 'mcp' || surface === 'web') {
        const err = new Error('mcp and web surfaces require a linked project')
        err.code = 'LINK_REQUIRED'
        throw err
      }
      const envRoot = process.env.HOLOSELF_HOME || join(homedir(), '.holoself')
      const targetSelf = resolve(o.self || (o.rootExplicit ? o.root : null) || envRoot)
      try {
        assertContainedPath(targetSelf, cwd, 'caller working directory')
      } catch {
        const err = new Error('caller is outside canonical self root and has no link')
        err.code = 'LINK_REQUIRED'
        throw err
      }
      if (!isCanonicalSelf(targetSelf)) {
        const err = new Error(`self path lacks canonical profile/context layout: ${targetSelf}`)
        err.code = 'SELF_ROOT_NOT_CANONICAL'
        throw err
      }
      self = targetSelf
      project = cwd
      identity = {
        kind: 'owner:direct',
        project: null,
        self: targetSelf,
        allowedLenses: null
      }
    }
  }

  return { surface, project, link, self, identity }
}

// Checks the requested lens against the self registry (owner) or the attested link grant (linked client).
export function resolveLensAuthority(o, { project, link, self, identity }) {
  const registry = loadLensRegistry(self)
  const lens = o.lens || link?.default_lens || 'general'

  switch (identity.kind) {
    case 'owner:direct':
      if (!registry.byId.has(lens)) {
        const error = new Error(`unknown lens requested: ${lens}`)
        error.code = 'UNKNOWN_LENS'
        throw error
      }
      break
    case 'client:linked': {
      identity.allowedLenses = linkedLensAuthority(project, link, lens)
      break
    }
    default: {
      const error = new Error('unrecognized caller identity kind')
      error.code = 'UNRECOGNIZED_IDENTITY'
      throw error
    }
  }

  const resolution = resolveLens(registry, lens)
  if (resolution.id !== lens) {
    const error = new Error('lens resolution mismatch')
    error.code = 'LENS_RESOLUTION_MISMATCH'
    throw error
  }

  const subject = {
    kind: identity.kind,
    space_id: identity.kind === 'owner:direct' ? 'self' : canonicalSpaceId(project),
    accessible_spaces: identity.kind === 'owner:direct' ? ['self', 'contrib'] : [canonicalSpaceId(project)],
    effective_allowed_lenses: identity.allowedLenses
  }

  return { registry, lens, resolution, subject }
}
