// holoself link backfill subcommand (moved verbatim from runEcosystem).
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
import { canonicalProjectPath, canonicalSpaceId, nextAllowedLenses, projectKeyReusedNotice, readRegistry, withRegistryLock, writeRegistry } from '../../../link/registry.mjs'
import { assertContainedPath, safeRealpath, slash } from '../../../shared/fs.mjs'
import { reportGrant } from '../../link-helpers.mjs'

export async function linkBackfill(o, sub, project) {
  let selfRoot = o.self || o.root
  if (!selfRoot) {
    const envRoot = process.env.HOLOSELF_HOME || join(homedir(), '.holoself')
    if (isCanonicalSelf(process.cwd())) selfRoot = process.cwd()
    else if (isCanonicalSelf(envRoot)) selfRoot = envRoot
  }
  if (!selfRoot || !existsSync(selfRoot) || !isCanonicalSelf(selfRoot)) {
    throw new Error('link backfill requires a valid canonical self root (specify with --self or run from self root)')
  }
  selfRoot = slash(safeRealpath(resolve(selfRoot)))
  const projectsToProcess = []
  if (project) {
    projectsToProcess.push(project)
  } else if (o.all) {
    const reg = readRegistry(selfRoot)
    for (const l of reg.links) {
      if (l.project_path && !projectsToProcess.includes(l.project_path)) projectsToProcess.push(l.project_path)
    }
  } else {
    throw new Error('link backfill requires --project <dir> or --all')
  }
  let processedCount = 0
  await withRegistryLock(selfRoot, () => {
    const currentReg = readRegistry(selfRoot)
    const nowIso = new Date().toISOString()
    writeRegistry(
      selfRoot,
      links => {
        for (const proj of projectsToProcess) {
          const canonicalProj = canonicalProjectPath(proj)
          const pId = canonicalSpaceId(proj)
          const lPath = linkPath(proj)
          if (!existsSync(lPath)) continue
          // Backfill never reactivates a revoked link; only naming lenses for one project does.
          const known = links.find(l => l.project_id === pId || l.project_path === canonicalProj)
          if (known?.status === 'revoked' && (!project || !o.lenses?.length)) {
            console.log(`[note] skipped revoked link: ${proj}; run 'holoself link approve --project <dir>' to reactivate it`)
            continue
          }
          assertContainedPath(proj, lPath, 'project link file')
          if (lstatSync(lPath).isSymbolicLink()) throw new Error(`symlink detected at ${lPath}`)
          let linkObj
          try {
            linkObj = readLink(proj, { tolerant: true, explicitSelf: selfRoot })
          } catch (error) {
            // A portable link naming a different self is never attested (or rewritten) here.
            if (error.code === 'SELF_ROOT_NOT_CANONICAL') continue
            throw error
          }
          // Only after the self check: a copied folder carrying another project's project_key gets its own key and
          // inherits nothing.
          const renewedKey = linkProjectKeyTaken(selfRoot, proj, links)
          if (renewedKey) {
            const previous = linkProjectKey(proj)
            renewLinkProjectKeyInPlace(proj)
            console.warn(projectKeyReusedNotice(previous, proj))
            linkObj = readLink(proj, { tolerant: true, explicitSelf: selfRoot })
          }
          let salt = renewedKey ? null : linkObj.binding_salt
          if (!salt || typeof salt !== 'string' || salt.length !== 32) {
            salt = randomBytes(16).toString('hex')
            updateLinkBindingSaltInPlace(proj, salt)
          }
          const idx = links.findIndex(l => l.project_id === pId || l.project_path === canonicalProj)
          const explicit = Boolean(o.lenses && o.lenses.length),
            lenses = explicit ? o.lenses : renewedKey ? ['general'] : [linkObj.default_lens, ...(linkObj.secondary_lenses || [])],
            grant = nextAllowedLenses({ entry: idx >= 0 ? links[idx] : null, lenses, explicit, accept: Boolean(o.acceptSharedLenses) })
          reportGrant(proj, grant, 'backfill')
          const entry = {
            project_id: pId,
            project_path: canonicalProj,
            ...(linkObj.project_key ? { project_key: linkObj.project_key } : {}),
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
          processedCount++
        }
        return links
      },
      currentReg.registry_hash
    )
  })
  console.log(`[ok] backfilled ${processedCount} project link(s)`)
  return true
}
