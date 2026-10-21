import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs'
import { dirname, isAbsolute, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rollbackAdoption } from '../adoption/transaction.mjs'
import { createLocalOnboardingService, localReadinessReport } from './project-writer.mjs'
import { stopReasonFor } from './readiness-report.mjs'
import { buildRuntimeRequest } from './runtime-handoff.mjs'
import { runOnboardingWizard } from './wizard.mjs'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MiB

export function readBoundedJsonFile(filePath, label = 'file') {
  const resolved = resolve(filePath)
  if (!existsSync(resolved)) {
    throw new Error(`File not found: ${filePath}`)
  }
  const stat = statSync(resolved)
  if (stat.size > MAX_FILE_SIZE) {
    throw new RangeError(`${label} exceeds maximum allowed size of 10 MiB (${stat.size} bytes)`)
  }
  const content = readFileSync(resolved, 'utf8')
  try {
    return JSON.parse(content)
  } catch (err) {
    throw new Error(`Failed to parse ${label} from ${filePath}: ${err.message}`)
  }
}

function getFlag(args, name, fallback) {
  const index = args.indexOf(name)
  if (index === -1) return fallback
  return args[index + 1] ?? fallback
}

function getSubcommand(args) {
  const flagsWithValue = new Set([
    '--target',
    '--profile',
    '--runtime-request',
    '--runtime-evidence',
    '--choices',
    '--plan',
    '--confirm',
    '--runtime',
    '--additional-runtimes',
    '--changes',
    '--receipt',
    '--journey',
  ])
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (flagsWithValue.has(arg)) {
      i += 1
      continue
    }
    if (!arg.startsWith('--')) {
      return arg
    }
  }
  return null
}

const USAGE =
  'Usage: agentflow-sdlc onboarding <wizard|inspect|plan|apply|verify|undo|recover|refine|runtime-request> [--target <dir>] [--profile <id>] [--runtime-request <file>] [--runtime-evidence <file>] [--choices <file>] [--changes <file>] [--plan <file>] [--receipt <file>] [--confirm <digest>] [--json] [--yes]\n'

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function readOptional(rest, flag, label) {
  const path = getFlag(rest, flag, null)
  return path ? readBoundedJsonFile(path, label) : null
}

// The readiness report after a step: the project as it is now, plus how the step ended. If even
// inspecting the project fails, the report still prints with what is known.
function reportAfter(service, context) {
  try {
    return service.verify({ packageRoot, ...context }).report
  } catch (error) {
    return localReadinessReport({
      ...context,
      planBlockers: [error.message],
      stop: context.stop ?? { reason: stopReasonFor(error), detail: error.message },
    })
  }
}

function stopped(service, stage, error, context) {
  process.stderr.write(`${error.message}\n`)
  const stop = { reason: stopReasonFor(error, stage), detail: error.message }
  print({ error: error.message, report: reportAfter(service, { ...context, stage, stop }) })
  return 1
}

export function handleOnboarding(rest, targetDir) {
  const subcommand = getSubcommand(rest)
  const service = createLocalOnboardingService()
  try {
    return dispatch(subcommand, rest, targetDir, service)
  } catch (error) {
    if (!['plan', 'apply', 'verify', 'undo', 'recover', 'refine'].includes(subcommand)) throw error
    const journey = subcommand === 'refine' ? 'refinement' : getFlag(rest, '--journey', 'adoption')
    return stopped(service, subcommand === 'refine' ? 'plan' : subcommand, error, {
      targetDir,
      journey,
    })
  }
}

// The preview the flags describe: adoption by default, refinement when --changes names settings.
function previewFrom(rest, targetDir, service) {
  const changes = readOptional(rest, '--changes', 'changes')
  if (changes !== null && (typeof changes !== 'object' || Array.isArray(changes)))
    throw new Error('--changes must name a JSON object of configuration settings')
  const refining = changes !== null || getSubcommand(rest) === 'refine'
  return service.plan({
    packageRoot,
    targetDir,
    profile: getFlag(rest, '--profile', 'standard'),
    runtimeRequest: readOptional(rest, '--runtime-request', 'runtime-request'),
    runtimeEvidence: readOptional(rest, '--runtime-evidence', 'runtime-evidence'),
    choices: refining
      ? { config: changes ?? {} }
      : (readOptional(rest, '--choices', 'choices') ?? {}),
    journey: refining ? 'refinement' : 'adoption',
  })
}

function dispatch(subcommand, rest, targetDir, service) {
  if (subcommand === 'wizard') {
    const profile = getFlag(rest, '--profile', null)
    const yes = rest.includes('--yes') || rest.includes('-y')
    const defaults = rest.includes('--defaults')
    return runOnboardingWizard({
      targetDir,
      options: { profile, yes, defaults },
      service,
    }).then((res) => (res.ok ? 0 : 1))
  }

  if (subcommand === 'runtime-request') {
    const runtimeId = getFlag(rest, '--runtime', 'current')
    const additionalRuntimesRaw = getFlag(rest, '--additional-runtimes', '')
    const additionalRuntimes = additionalRuntimesRaw
      ? additionalRuntimesRaw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : []
    const sharedUpdate = rest.includes('--shared-update')
    const request = buildRuntimeRequest({ runtimeId, additionalRuntimes, sharedUpdate })
    process.stdout.write(`${JSON.stringify(request, null, 2)}\n`)
    return 0
  }

  if (subcommand === 'inspect') {
    const profile = getFlag(rest, '--profile', 'standard')
    const reqPath = getFlag(rest, '--runtime-request', null)
    const eviPath = getFlag(rest, '--runtime-evidence', null)
    const runtimeRequest = reqPath ? readBoundedJsonFile(reqPath, 'runtime-request') : null
    const runtimeEvidence = eviPath ? readBoundedJsonFile(eviPath, 'runtime-evidence') : null
    const result = service.inspect({
      packageRoot,
      targetDir,
      profile,
      runtimeRequest,
      runtimeEvidence,
    })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return 0
  }

  if (subcommand === 'plan') {
    const profile = getFlag(rest, '--profile', 'standard')
    const reqPath = getFlag(rest, '--runtime-request', null)
    const eviPath = getFlag(rest, '--runtime-evidence', null)
    const choicesPath = getFlag(rest, '--choices', null)
    const runtimeRequest = reqPath ? readBoundedJsonFile(reqPath, 'runtime-request') : null
    const runtimeEvidence = eviPath ? readBoundedJsonFile(eviPath, 'runtime-evidence') : null
    const choices = choicesPath ? readBoundedJsonFile(choicesPath, 'choices') : {}
    const plan = service.plan({
      packageRoot,
      targetDir,
      profile,
      runtimeRequest,
      runtimeEvidence,
      choices,
    })
    print(plan)
    return plan.readyToApply ? 0 : 1
  }

  // Refinement: a later small change to an adopted project's configuration, previewed the same
  // way. It changes only the project; it never installs or syncs another agent's harness.
  if (subcommand === 'refine') {
    const plan = previewFrom(rest, targetDir, service)
    print(plan)
    return plan.readyToApply ? 0 : 1
  }

  if (subcommand === 'apply') {
    const planPath = getFlag(rest, '--plan', null)
    const runtimeEvidence = readOptional(rest, '--runtime-evidence', 'runtime-evidence')
    // Without a saved plan file, apply previews again from the same flags. The confirmation must
    // match that fresh preview's digest, so it still binds exactly what the person saw.
    const plan = planPath
      ? readBoundedJsonFile(planPath, 'plan')
      : previewFrom(rest, targetDir, service)
    const context = {
      targetDir,
      journey: plan.journey ?? 'adoption',
      profile: plan.projectPlan?.profile ?? 'standard',
      runtimeRequest: plan.runtimeRequest?.requiredCapabilities ? plan.runtimeRequest : null,
      runtimeEvidence,
      choices: plan.options ?? {},
    }
    const confirm = getFlag(rest, '--confirm', null)
    // A preview that cannot be applied stops here for the reason its own report gives.
    if (!plan.readyToApply && plan.report) {
      process.stderr.write(`${plan.blockers[0] ?? 'The preview cannot be applied'}\n`)
      const report = { ...plan.report, stage: 'apply' }
      print({ report: { ...report, choices: { ...report.choices, confirmed: false } } })
      return 1
    }
    // A confirmation for an earlier preview of the same flags no longer matches the project.
    if (confirm && !planPath && confirm !== plan.digest) {
      const error = new Error(
        'The confirmed preview is stale; preview again and confirm the new digest',
      )
      return stopped(service, 'apply', error, { ...context, confirmed: false })
    }
    // No confirmation is a declined preview: nothing is written, and the report says so.
    if (!confirm) {
      const error = new Error('The preview was not confirmed; nothing was written')
      process.stderr.write(`${error.message}\n`)
      const stop = { reason: 'declined', detail: error.message }
      print({
        report: reportAfter(service, { ...context, stage: 'apply', stop, confirmed: false }),
      })
      return 1
    }
    let receipt
    try {
      receipt = service.apply(plan, { confirm, runtimeEvidence, targetDir, packageRoot })
    } catch (error) {
      return stopped(service, 'apply', error, { ...context, confirmed: false })
    }
    const report = reportAfter(service, { ...context, stage: 'apply', confirmed: true, receipt })
    print({ ...receipt, report })
    return 0
  }

  if (subcommand === 'verify') {
    const profile = getFlag(rest, '--profile', 'standard')
    const reqPath = getFlag(rest, '--runtime-request', null)
    const eviPath = getFlag(rest, '--runtime-evidence', null)
    const choicesPath = getFlag(rest, '--choices', null)
    const runtimeRequest = reqPath ? readBoundedJsonFile(reqPath, 'runtime-request') : null
    const runtimeEvidence = eviPath ? readBoundedJsonFile(eviPath, 'runtime-evidence') : null
    const choices = choicesPath ? readBoundedJsonFile(choicesPath, 'choices') : {}
    const result = service.verify({
      packageRoot,
      targetDir,
      profile,
      runtimeRequest,
      runtimeEvidence,
      choices,
      journey: getFlag(rest, '--journey', 'adoption'),
    })
    print(result)
    return result.projectReady ? 0 : 1
  }

  // Discovers the most recent transaction receipt from .agentflow/transactions/
  function discoverLatestReceipt(targetDir) {
    const txRoot = resolve(targetDir, '.agentflow/transactions')
    if (!existsSync(txRoot)) return null
    let entries = []
    try {
      entries = readdirSync(txRoot, { withFileTypes: true })
    } catch {
      return null
    }
    const txDirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
      .reverse()

    for (const dir of txDirs) {
      const candidate = join(txRoot, dir, 'receipt.json')
      if (existsSync(candidate)) return candidate
    }
    return null
  }

  // Undo restores the exact bytes the apply replaced, from the receipt the apply printed.
  if (subcommand === 'undo') {
    let receiptPath = getFlag(rest, '--receipt', null)
    if (!receiptPath) {
      receiptPath = discoverLatestReceipt(targetDir)
    }
    const confirm = getFlag(rest, '--confirm', null)
    if (!receiptPath) {
      process.stderr.write(
        'Usage: agentflow-sdlc onboarding undo --receipt <file> --confirm <receipt-token> [--target <dir>]\nNo transaction receipt found in target directory.\n',
      )
      return 2
    }
    const resolved = isAbsolute(receiptPath) ? receiptPath : resolve(targetDir, receiptPath)
    const receipt = readBoundedJsonFile(resolved, 'receipt')
    if (!confirm) {
      process.stderr.write(
        `Previewing undo for transaction ${receipt.receiptToken?.slice(0, 16) ?? ''}...\nRe-run with --confirm ${receipt.receiptToken} to apply rollback.\n`,
      )
      print({
        readyToUndo: true,
        receiptToken: receipt.receiptToken,
        target: targetDir,
        mutations:
          receipt.mutations?.map((m) => ({
            path: m.path,
            action: m.beforeContentBase64 === null ? 'remove' : 'restore',
          })) ?? [],
      })
      return 1
    }
    const journey = getFlag(rest, '--journey', 'adoption')
    let undone
    try {
      undone = rollbackAdoption(targetDir, receipt, { confirm })
    } catch (error) {
      return stopped(service, 'undo', error, { targetDir, journey })
    }
    print({ ...undone, report: reportAfter(service, { targetDir, journey, stage: 'undo' }) })
    return 0
  }

  if (subcommand === 'recover') {
    const confirm = getFlag(rest, '--confirm', null)
    if (!confirm) {
      process.stderr.write(
        'Usage: agentflow-sdlc onboarding recover --confirm <recovery-token> [--target <dir>]\n',
      )
      return 2
    }
    const result = service.recover({ targetDir, packageRoot }, { confirm })
    print({ ...result, report: reportAfter(service, { targetDir, stage: 'recover' }) })
    return 0
  }

  process.stderr.write(USAGE)
  return 2
}
