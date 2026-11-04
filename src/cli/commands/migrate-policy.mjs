// holoself migrate policy command (moved verbatim from runEcosystem).
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isCanonicalSelf } from '../../link/config.mjs'
import { applyPolicyMigration, planPolicyMigration, revertPolicyMigration } from '../../migration.mjs'
import { safeRealpath, slash } from '../../shared/fs.mjs'

export async function runMigratePolicy(o, sub) {
  const selfRoot = slash(safeRealpath(resolve(o.self || o.root)))
  if (!existsSync(selfRoot) || !isCanonicalSelf(selfRoot)) {
    throw new Error(`migrate policy requires a valid canonical self root: ${selfRoot}`)
  }
  if (o.apply) {
    const receipt = applyPolicyMigration(selfRoot, o.apply, { confirmNarrowing: o.confirmNarrowing })
    console.log(
      JSON.stringify(
        {
          status: 'applied',
          receipt_id: receipt.receipt_id,
          applied_at: receipt.applied_at,
          entries: receipt.entries.length,
          narrowing_confirmed: receipt.narrowing_confirmed
        },
        null,
        2
      )
    )
    return true
  }
  if (o.revert) {
    const receipt = revertPolicyMigration(selfRoot, o.revert, { allowPartial: o.allowPartial })
    console.log(
      JSON.stringify({ status: receipt.status, receipt_id: receipt.receipt_id, reverted_at: receipt.reverted_at, entries: receipt.entries.length }, null, 2)
    )
    return true
  }
  const plan = planPolicyMigration(selfRoot, { includeLinked: o.includeLinked, dryRun: Boolean(o.dryRun) })
  console.log(
    JSON.stringify(
      {
        status: 'planned',
        plan_id: plan.plan_id,
        generated_at: plan.generated_at,
        self_root: plan.self_root,
        include_linked: plan.include_linked,
        summary: plan.summary,
        plan_file: o.dryRun ? null : slash(join(selfRoot, '.holoself', 'migrations', `plan-${plan.plan_id}.json`))
      },
      null,
      2
    )
  )
  return true
}
