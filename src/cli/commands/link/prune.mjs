// holoself link prune subcommand (moved verbatim from runEcosystem).
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { isCanonicalSelf, linkPath } from '../../../link/config.mjs'
import { readRegistry, withRegistryLock, writeRegistry } from '../../../link/registry.mjs'
import { safeRealpath, slash } from '../../../shared/fs.mjs'

export async function linkPrune(o, sub, project) {
  let selfRoot = o.self || o.root
  if (!selfRoot) {
    const envRoot = process.env.HOLOSELF_HOME || join(homedir(), '.holoself')
    if (isCanonicalSelf(process.cwd())) selfRoot = process.cwd()
    else if (isCanonicalSelf(envRoot)) selfRoot = envRoot
  }
  if (!selfRoot || !existsSync(selfRoot) || !isCanonicalSelf(selfRoot)) {
    throw new Error('link prune requires a valid canonical self root (specify with --self or run from self root)')
  }
  selfRoot = slash(safeRealpath(resolve(selfRoot)))
  let prunedCount = 0
  await withRegistryLock(selfRoot, () => {
    const currentReg = readRegistry(selfRoot)
    writeRegistry(
      selfRoot,
      links => {
        const kept = []
        for (const l of links) {
          const pPath = l.project_path
          if (pPath && existsSync(pPath) && existsSync(linkPath(pPath))) {
            kept.push(l)
          } else {
            prunedCount++
          }
        }
        return kept
      },
      currentReg.registry_hash
    )
  })
  console.log(`[ok] pruned ${prunedCount} orphaned link entry/entries from registry`)
  return true
}
