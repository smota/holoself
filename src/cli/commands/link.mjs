// holoself link lifecycle commands: one module per subcommand under ./link/.
import { projectPath } from '../link-helpers.mjs'

import { linkAdd } from './link/add.mjs'
import { linkSetup } from './link/setup.mjs'
import { linkApprove } from './link/approve.mjs'
import { linkBackfill } from './link/backfill.mjs'
import { linkPrune } from './link/prune.mjs'
import { linkStatus } from './link/status.mjs'
import { linkRemove } from './link/remove.mjs'
import { linkActivate } from './link/activate.mjs'
import { linkRepair } from './link/repair.mjs'
import { linkDeactivate } from './link/deactivate.mjs'
import { linkDoctor } from './link/doctor.mjs'

// Subcommands in their original evaluation order. A handler that completes without returning falls
// through to the next match and then to linkSetup, exactly as the former if-chain did.
export const LINK_SUBCOMMANDS = [
  { name: 'add', run: linkAdd },
  { name: 'setup', run: linkSetup },
  { name: 'approve', run: linkApprove },
  { name: 'backfill', run: linkBackfill },
  { name: 'prune', run: linkPrune },
  { name: 'status', run: linkStatus },
  { name: 'remove', run: linkRemove },
  { name: 'activate', run: linkActivate },
  { name: 'repair', run: linkRepair },
  { name: 'deactivate', run: linkDeactivate },
  { name: 'doctor', run: linkDoctor }
]

export async function runLink(o, sub) {
  const project = sub === 'backfill' && o.all && !o.project && !o.target ? null : projectPath(o)
  for (const { name, run } of LINK_SUBCOMMANDS) {
    if (sub !== name) continue
    const result = await run(o, sub, project)
    if (result !== undefined) return result
  }
  // Unreachable: every subcommand handler returns true.
  return linkSetup(o, sub, project)
}
