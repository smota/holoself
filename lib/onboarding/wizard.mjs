import readline from 'node:readline'
import { resolve } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { validateEnvironment, detectExecutionSubstrate } from '../environment.mjs'
import { createLocalOnboardingService } from './project-writer.mjs'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

const PROFILES = [
  {
    id: 'standard',
    num: '1',
    label: 'standard (default)',
    description: 'Recommended. Standard SDLC squad policies, adapters, and verification gates.',
  },
  {
    id: 'minimal',
    num: '2',
    label: 'minimal',
    description: 'Bare essentials (AGENTS.md, basic policies, minimal configs).',
  },
  {
    id: 'github',
    num: '3',
    label: 'github',
    description: 'Standard + full GitHub Actions workflows and issue templates.',
  },
  {
    id: 'cockpit',
    num: '4',
    label: 'cockpit',
    description: 'Standard + Cockpit Goal Command Center integration.',
  },
]

function resolveProfile(input, fallback = 'standard') {
  const trimmed = String(input ?? '')
    .trim()
    .toLowerCase()
  if (!trimmed) return fallback
  const byNum = PROFILES.find((p) => p.num === trimmed)
  if (byNum) return byNum.id
  const byId = PROFILES.find((p) => p.id === trimmed)
  if (byId) return byId.id
  return fallback
}

/**
 * Ask a question using readline interface or fallback to default if closed.
 */
function askQuestion(rl, query, defaultValue = '') {
  return new Promise((resolvePrompt) => {
    rl.question(query, (answer) => {
      const trimmed = answer.trim()
      resolvePrompt(trimmed.length > 0 ? trimmed : defaultValue)
    })
  })
}

/**
 * Interactive terminal onboarding stepper wizard.
 */
export async function runOnboardingWizard({
  targetDir = process.cwd(),
  options = {},
  io = {},
  service = createLocalOnboardingService(),
} = {}) {
  const stdin = io.input ?? process.stdin
  const stdout = io.output ?? process.stdout
  const write = (msg = '') => stdout.write(`${msg}\n`)

  const isInteractive = Boolean(stdin.isTTY || io.interactive)
  const autoConfirm = Boolean(options.yes || options.defaults)

  write('============================================================')
  write(' AgentFlow SDLC Onboarding Wizard')
  write(' Move faster. Keep the work understandable.')
  write('============================================================\n')

  let resolvedTarget = resolve(targetDir)
  let selectedProfile = options.profile ? resolveProfile(options.profile) : 'standard'
  let configureHarness = options.harness !== false

  // If non-interactive and no auto-confirm, run with provided options or abort gracefully
  if (!isInteractive && !autoConfirm) {
    write('Non-interactive environment detected. Using provided flags/defaults.')
  }

  let rl = null
  if (!io.ask && (isInteractive || io.input)) {
    rl = readline.createInterface({ input: stdin, output: stdout })
  }
  const ask = io.ask ?? (rl ? (query, def) => askQuestion(rl, query, def) : async (_, def) => def)

  try {
    // Step 1: Target directory
    if (isInteractive && !autoConfirm) {
      const answerTarget = await ask(`Target directory [${resolvedTarget}]: `, resolvedTarget)
      resolvedTarget = resolve(answerTarget)
    }

    if (!existsSync(resolvedTarget)) {
      write(`Creating directory: ${resolvedTarget}`)
      mkdirSync(resolvedTarget, { recursive: true })
    }

    // Step 2: Environment Readiness Probe
    write('\n--- Step 1: Environment Readiness Probe ---')
    const envReport = validateEnvironment(resolvedTarget)
    const substrateReport = detectExecutionSubstrate(resolvedTarget)
    for (const tool of envReport.tools) {
      if (tool.found) {
        write(`  [✓] ${tool.name}: found (${tool.version})`)
      } else {
        const mark = tool.required ? '[✗]' : '[-]'
        write(`  ${mark} ${tool.name}: missing (${tool.required ? 'Required' : 'Optional'})`)
        if (tool.required) {
          write(`      Why: ${tool.why}`)
          if (tool.installOptions?.length) {
            write('      Install options:')
            for (const opt of tool.installOptions) write(`        - ${opt}`)
          }
        }
      }
    }
    write(
      `  [i] Recommended Substrate: ${substrateReport.recommendedSubstrateTier} (CLIs: ${substrateReport.availableClis.join(', ') || 'none'}, OpenRig: ${substrateReport.openrigAvailable ? 'available' : 'not installed'})`,
    )

    const missingRequired = envReport.tools.filter((t) => t.required && !t.found)
    if (missingRequired.length > 0) {
      write('\nWarning: Required tools are missing from the host environment.')
      if (isInteractive && !autoConfirm) {
        const proceed = await ask('Continue anyway? [y/N]: ', 'n')
        if (!['y', 'yes'].includes(proceed.toLowerCase())) {
          write('Onboarding stopped. Please install required tools and rerun.')
          return { ok: false, status: 'aborted', reason: 'Missing required tools', envReport }
        }
      } else if (!autoConfirm) {
        write('Aborted due to missing required tools in non-interactive mode.')
        return { ok: false, status: 'aborted', reason: 'Missing required tools', envReport }
      }
    }

    // Step 3: Composition Profile Selection
    write('\n--- Step 2: Composition Profile ---')
    for (const p of PROFILES) {
      write(`  ${p.num}) ${p.label.padEnd(20)} - ${p.description}`)
    }

    if (isInteractive && !autoConfirm) {
      const answerProfile = await ask('\nSelect profile [1-4 or name] (default: standard): ', '1')
      selectedProfile = resolveProfile(answerProfile)
    }
    write(`Selected profile: ${selectedProfile}`)

    // Step 4: Agent Harness Configuration
    write('\n--- Step 3: Harness Configuration ---')
    if (isInteractive && !autoConfirm) {
      const answerHarness = await ask(
        'Configure agent harnesses (Claude Code, Antigravity, Pi, Codex)? [Y/n]: ',
        'y',
      )
      configureHarness = !['n', 'no'].includes(answerHarness.toLowerCase())
    }
    write(`Agent harnesses: ${configureHarness ? 'Enabled' : 'Disabled'}`)

    // Step 5: Plan Scaffolding
    write('\n--- Step 4: Scaffolding Plan Preview ---')
    const plan = service.plan({
      packageRoot,
      targetDir: resolvedTarget,
      profile: selectedProfile,
      choices: { harness: configureHarness },
    })

    if (!plan.readyToApply) {
      write('Adoption plan is not ready to apply:')
      for (const diag of plan.diagnostics || []) write(`  - ${diag}`)
      for (const blocker of plan.planBlockers || []) write(`  - ${blocker}`)
      return { ok: false, status: 'blocked', plan }
    }

    write(`Plan Digest: ${plan.digest}`)
    write(`Total operations: ${plan.changes?.length ?? 0}`)
    for (const change of plan.changes ?? []) {
      write(`  [${change.action}] ${change.target || change.path}`)
    }

    // Step 6: Confirmation Gate
    write('\n--- Step 5: Confirmation Gate ---')
    let confirmed = autoConfirm
    if (!autoConfirm && isInteractive) {
      const answerConfirm = await ask(`Apply these changes to ${resolvedTarget}? [y/N]: `, 'n')
      confirmed = ['y', 'yes'].includes(answerConfirm.toLowerCase())
    } else if (!autoConfirm && !isInteractive) {
      write('Confirmation required. Run with --yes or in an interactive terminal.')
      return { ok: false, status: 'unconfirmed', plan }
    }

    if (!confirmed) {
      write('Onboarding cancelled. No files were written.')
      return { ok: true, status: 'cancelled', plan }
    }

    // Step 7: Apply
    write('\nApplying changes...')
    const receipt = service.apply(plan, {
      confirm: plan.digest,
      targetDir: resolvedTarget,
      packageRoot,
    })

    write('\n============================================================')
    write(`✓ AgentFlow successfully initialized in ${resolvedTarget}!`)
    write('============================================================')
    if (receipt.receiptToken) {
      write(`Receipt Token: ${receipt.receiptToken}`)
    }
    write('\nNext steps:')
    write('  - Inspect project health: agentflow-sdlc doctor')
    write('  - Review scaffolded files in AGENTS.md and docs/')
    if (receipt.recoveryToken || receipt.receiptToken) {
      write(
        `  - To undo this adoption: agentflow-sdlc onboarding undo --confirm ${receipt.recoveryToken || receipt.receiptToken}`,
      )
    }

    return { ok: true, status: 'applied', plan, receipt }
  } finally {
    if (rl) rl.close()
  }
}
