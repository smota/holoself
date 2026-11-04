// Table-driven dispatcher for the linked-ecosystem CLI commands (formerly the runEcosystem if-chain).

import { runInstructions } from './commands/instructions.mjs'
import { runSkill } from './commands/skill.mjs'
import { runLens } from './commands/lens.mjs'
import { runLinkSkill } from './commands/link-skill.mjs'
import { runMigratePolicy } from './commands/migrate-policy.mjs'
import { runLink } from './commands/link.mjs'
import { runContext } from './commands/context.mjs'
import { runAnalyze } from './commands/analyze.mjs'
import { runPropose } from './commands/propose.mjs'
import { runProposals } from './commands/proposals.mjs'
import { runIndex } from './commands/index.mjs'
import { runLedger } from './commands/ledger.mjs'
import { runSearch } from './commands/search.mjs'

// Entries are tried in the original order; an entry matches its command and, when listed, one of
// its subcommands. A handler returns true when it handled the command; a handler that completes
// without returning (undefined) falls through to later entries, and when nothing handles the
// command runEcosystem returns false, as before.
export const COMMANDS = [
  { command: 'instructions', run: runInstructions },
  { command: 'skill', run: runSkill },
  { command: 'lens', run: runLens },
  { command: 'link', subcommands: ['skill'], run: runLinkSkill },
  { command: 'migrate', subcommands: ['policy'], run: runMigratePolicy },
  {
    command: 'link',
    subcommands: ['add', 'status', 'remove', 'setup', 'activate', 'deactivate', 'repair', 'doctor', 'approve', 'backfill', 'prune'],
    run: runLink
  },
  { command: 'context', run: runContext },
  { command: 'analyze', run: runAnalyze },
  { command: 'propose', run: runPropose },
  { command: 'proposals', run: runProposals },
  { command: 'index', run: runIndex },
  { command: 'ledger', run: runLedger },
  { command: 'search', run: runSearch }
]

export async function runEcosystem(o) {
  const sub = o.args?.[0]
  for (const { command, subcommands, run } of COMMANDS) {
    if (o.command !== command || (subcommands && !subcommands.includes(sub))) continue
    const result = await run(o, sub)
    if (result !== undefined) return result
  }
  return false
}
