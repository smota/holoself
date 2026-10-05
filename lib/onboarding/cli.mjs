import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLocalOnboardingService } from './project-writer.mjs'
import { buildRuntimeRequest } from './runtime-handoff.mjs'

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

export function handleOnboarding(rest, targetDir) {
  const subcommand = getSubcommand(rest)

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
    const service = createLocalOnboardingService()
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
    const service = createLocalOnboardingService()
    const plan = service.plan({
      packageRoot,
      targetDir,
      profile,
      runtimeRequest,
      runtimeEvidence,
      choices,
    })
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
    return plan.readyToApply ? 0 : 1
  }

  if (subcommand === 'apply') {
    const planPath = getFlag(rest, '--plan', null)
    const confirm = getFlag(rest, '--confirm', null)
    if (!planPath || !confirm) {
      process.stderr.write(
        'Usage: agentflow-sdlc onboarding apply --plan <file> --confirm <digest> [--runtime-evidence <file>] [--target <dir>]\n',
      )
      return 2
    }
    const eviPath = getFlag(rest, '--runtime-evidence', null)
    const runtimeEvidence = eviPath ? readBoundedJsonFile(eviPath, 'runtime-evidence') : null
    const plan = readBoundedJsonFile(planPath, 'plan')
    const service = createLocalOnboardingService()
    const receipt = service.apply(plan, {
      confirm,
      runtimeEvidence,
      targetDir,
      packageRoot,
    })
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`)
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
    const service = createLocalOnboardingService()
    const report = service.verify({
      packageRoot,
      targetDir,
      profile,
      runtimeRequest,
      runtimeEvidence,
      choices,
    })
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return report.projectReady ? 0 : 1
  }

  if (subcommand === 'recover') {
    const confirm = getFlag(rest, '--confirm', null)
    if (!confirm) {
      process.stderr.write(
        'Usage: agentflow-sdlc onboarding recover --confirm <recovery-token> [--target <dir>]\n',
      )
      return 2
    }
    const service = createLocalOnboardingService()
    const result = service.recover({ targetDir, packageRoot }, { confirm })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return 0
  }

  process.stderr.write(
    'Usage: agentflow-sdlc onboarding <inspect|plan|apply|verify|recover|runtime-request> [--target <dir>] [--profile <id>] [--runtime-request <file>] [--runtime-evidence <file>] [--choices <file>] [--plan <file>] [--confirm <digest>] [--json]\n',
  )
  return 2
}
