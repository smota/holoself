// holoself link approve subcommand (moved verbatim from runEcosystem).
import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  isCanonicalSelf,
  linkPath,
  linkProjectKey,
  linkProjectKeyTaken,
  readLink,
  renewLinkProjectKeyInPlace,
  updateLinkBindingSaltInPlace
} from '../../../link/config.mjs'
import { registerSelf } from '../../../link/machine.mjs'
import { canonicalProjectPath, canonicalSpaceId, nextAllowedLenses, projectKeyReusedNotice, readRegistry, withRegistryLock, writeRegistry } from '../../../link/registry.mjs'
import { assertContainedPath, safeRealpath, slash } from '../../../shared/fs.mjs'
import { reportGrant } from '../../link-helpers.mjs'

export async function linkApprove(o, sub, project) {
  if (!project) throw new Error('link approve requires --project <dir>')
  const canonicalProj = canonicalProjectPath(project)
  const pId = canonicalSpaceId(project)
  let selfRoot = o.self || o.root
  if (!selfRoot) {
    const lPath = linkPath(project)
    if (existsSync(lPath)) {
      try {
        const l = readLink(project, { tolerant: true })
        selfRoot = l.path
      } catch {}
    }
  }
  if (!selfRoot) {
    const envRoot = process.env.HOLOSELF_HOME || join(homedir(), '.holoself')
    if (isCanonicalSelf(process.cwd())) selfRoot = process.cwd()
    else if (isCanonicalSelf(envRoot)) selfRoot = envRoot
  }
  if (!selfRoot || !existsSync(selfRoot) || !isCanonicalSelf(selfRoot)) {
    throw new Error('link approve requires a valid canonical self root (specify with --self or run from self root)')
  }
  selfRoot = slash(safeRealpath(resolve(selfRoot)))
  const lPath = linkPath(project)
  const hasLink = existsSync(lPath)
  let linkObj = null,
    renewedKey = false
  const revokeMode = Boolean(o.revoke)
  if (hasLink) {
    assertContainedPath(project, lPath, 'project link file')
    if (lstatSync(lPath).isSymbolicLink()) throw new Error(`symlink detected at ${lPath}`)
    const read = () => {
      try {
        // A portable link is approved only by the self it names (its self_id); revocation needs no match.
        return readLink(project, { tolerant: true, explicitSelf: revokeMode ? null : selfRoot })
      } catch (e) {
        if (e.code === 'SELF_ROOT_NOT_CANONICAL') throw Object.assign(new Error(`project link names a different self than ${selfRoot}; refusing to approve`), { code: e.code })
        throw new Error(`cannot read project link at ${lPath}: ${e.message}`)
      }
    }
    linkObj = read()
    // Only after the self check: a copied folder carrying another project's project_key gets its own key and inherits
    // nothing.
    if (!revokeMode && linkProjectKeyTaken(selfRoot, project)) {
      const previous = linkProjectKey(project)
      renewLinkProjectKeyInPlace(project)
      renewedKey = true
      console.warn(projectKeyReusedNotice(previous, project))
      console.warn(`[note] bind its lens with: holoself lens bind --root <self-root> --project <dir> --lens <id> --yes`)
      linkObj = read()
    }
  }
  // Approval records this machine's checkout of the self (adding a self_id to it when missing).
  if (!revokeMode) registerSelf(selfRoot)
  await withRegistryLock(selfRoot, () => {
    const currentReg = readRegistry(selfRoot)
    const nowIso = new Date().toISOString()
    writeRegistry(
      selfRoot,
      links => {
        const idx = links.findIndex(l => l.project_id === pId || l.project_path === canonicalProj)
        if (revokeMode) {
          if (idx >= 0) {
            links[idx] = {
              ...links[idx],
              status: 'revoked',
              revoked_at: nowIso,
              updated_at: nowIso
            }
          } else {
            links.push({
              project_id: pId,
              project_path: canonicalProj,
              binding_salt: randomBytes(16).toString('hex'),
              allowed_lenses: [],
              status: 'revoked',
              attested_by: 'owner:direct',
              created_at: nowIso,
              updated_at: nowIso,
              revoked_at: nowIso
            })
          }
          return links
        }
        const explicit = Boolean(o.lenses && o.lenses.length),
          lenses = explicit ? o.lenses : linkObj && !renewedKey ? [linkObj.default_lens, ...(linkObj.secondary_lenses || [])] : ['general'],
          grant = nextAllowedLenses({ entry: idx >= 0 ? links[idx] : null, lenses, explicit, accept: Boolean(o.acceptSharedLenses) })
        reportGrant(project, grant, 'approve')
        let salt = null
        if (idx >= 0 && typeof links[idx].binding_salt === 'string' && links[idx].binding_salt.length === 32) {
          salt = links[idx].binding_salt
        } else if (linkObj && !renewedKey && typeof linkObj.binding_salt === 'string' && linkObj.binding_salt.length === 32) {
          salt = linkObj.binding_salt
        } else {
          salt = randomBytes(16).toString('hex')
        }
        if (hasLink) {
          updateLinkBindingSaltInPlace(project, salt)
        }
        const entry = {
          project_id: pId,
          project_path: canonicalProj,
          ...(linkObj?.project_key ? { project_key: linkObj.project_key } : {}),
          binding_salt: salt,
          allowed_lenses: grant.allowed,
          status: 'active',
          attested_by: 'owner:direct',
          created_at: idx >= 0 ? links[idx].created_at : nowIso,
          updated_at: nowIso,
          revoked_at: null
        }
        if (idx >= 0) links[idx] = entry
        else links.push(entry)
        return links
      },
      currentReg.registry_hash
    )
  })
  console.log(`[ok] ${revokeMode ? 'revoked' : 'approved'} link for ${project}`)
  return true
}
