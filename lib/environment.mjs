import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { recordDigest } from './core/record-digest.mjs'

const INSTALL_OPTIONS = {
  git: [
    'macOS: brew install git',
    'Windows: winget install --id Git.Git',
    'Docs: https://git-scm.com/downloads',
  ],
  node: ['Docs: https://nodejs.org/', 'Version manager: https://github.com/Schniz/fnm'],
  pnpm: ['Corepack: corepack enable pnpm', 'Docs: https://pnpm.io/installation'],
  gh: [
    'macOS: brew install gh',
    'Windows: winget install --id GitHub.cli',
    'Docs: https://cli.github.com/',
  ],
  omnigent: ['Docs: https://github.com/omnigent-ai/omnigent', 'Website: https://omnigent.ai'],
}

function readConfig(targetDir) {
  const path = join(targetDir, 'agent-workflow.config.json')
  if (!existsSync(path)) return {}
  return JSON.parse(readFileSync(path, 'utf8'))
}

function commandParts(command) {
  if (typeof command === 'object') return { bin: command.executable, args: command.args ?? [] }
  const parts = command.trim().split(/\s+/)
  return { bin: parts[0], args: parts.slice(1) }
}

function runCommand(command, runner) {
  const { bin, args } = commandParts(command)
  try {
    const stdout = runner(bin, args)
    const output = String(stdout).trim().split('\n')[0] ?? ''
    return { found: output.length > 0, output }
  } catch (error) {
    return { found: false, error: error.message }
  }
}

function defaultRunner(bin, args, options = {}) {
  return execFileSync(bin, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeout ?? 10000,
    cwd: options.cwd,
    maxBuffer: 65536,
    windowsHide: true,
  })
}

function tool(name, command, why, required, installOptions, runner) {
  const result = runCommand(command, runner)
  return {
    name,
    command,
    required,
    found: result.found,
    version: result.found ? result.output : null,
    why,
    installOptions,
  }
}

export function validateEnvironment(targetDir = process.cwd(), options = {}) {
  const runner = options.runner ?? defaultRunner
  const config = readConfig(targetDir)
  const routingAgents = config.routing?.agents ?? {}
  const configuredAgents = Object.entries(routingAgents)
    .filter(([, agent]) => agent?.enabled && agent?.availabilityProbe?.executable)
    .map(([slug, agent]) => ({
      slug,
      command: agent.availabilityProbe,
    }))

  const tools = [
    tool(
      'git',
      'git --version',
      'Required for branch, commit, and PR workflows.',
      true,
      INSTALL_OPTIONS.git,
      runner,
    ),
    tool(
      'node',
      'node --version',
      'Required for framework CLI, validators, hooks, and tests.',
      true,
      INSTALL_OPTIONS.node,
      runner,
    ),
    tool(
      'pnpm',
      'pnpm --version',
      'Required by this repository; adopting projects may use their own configured package manager.',
      false,
      INSTALL_OPTIONS.pnpm,
      runner,
    ),
    tool(
      'gh',
      'gh --version',
      'Needed for GitHub issue, PR, and release automation commands.',
      false,
      INSTALL_OPTIONS.gh,
      runner,
    ),
  ]

  for (const { slug, command } of configuredAgents) {
    tools.push(
      tool(
        slug,
        command,
        `Optional configured agent/runtime from agent-workflow.config.json routing.agents.${slug}.`,
        false,
        slug === 'omnigent'
          ? INSTALL_OPTIONS.omnigent
          : [`Install ${slug} using its official documentation.`],
        runner,
      ),
    )
  }

  const missingRequired = tools.filter((item) => item.required && !item.found)
  return {
    ok: missingRequired.length === 0,
    mutated: false,
    note: 'Version probes only. No installation commands were executed. Executable wrappers may have their own side effects; use --inspect for inspection without execution.',
    tools,
  }
}

export const PROBE_EFFECTS = [
  'observe',
  'project-write',
  'network-read',
  'provider-execution',
  'external-mutation',
]

export function resolveExecutable(executable, { cwd = process.cwd(), env = process.env } = {}) {
  if (typeof executable !== 'string' || !executable) return null
  // W8e / D2 — DEFECT FOUND AND FIXED. This used to try the bare, extension-less name FIRST on
  // win32 (`['', ...PATHEXT]`). Reproduced on a fresh repository: a Node install that ships a bare
  // POSIX shim file named exactly `npm` alongside `npm.cmd` (common — mise, nvm-windows, volta all
  // do this) made this function resolve to the shim, which Windows cannot execute directly
  // (spawnSync failed with ENOENT). cmd.exe's own PATH search tries PATHEXT extensions before an
  // extension-less match; trying them in that same order here is what actually finds the launcher
  // Windows can run.
  const extensions =
    process.platform === 'win32' ? [...(env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';'), ''] : ['']
  const directories =
    isAbsolute(executable) || /[\\/]/.test(executable)
      ? ['']
      : (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)
  for (const directory of directories)
    for (const extension of extensions) {
      const path = resolve(cwd, directory, executable + extension)
      try {
        if (statSync(path).isFile()) return path
      } catch {
        /* Not resolvable in this context. */
      }
    }
  return null
}

function resolutionFingerprint(declarations, targetDir, resolver) {
  return declarations.map((probe) => {
    const path = resolver(probe.executable, { cwd: targetDir })
    let file = null
    if (path) {
      try {
        const info = statSync(path)
        file = { size: info.size, modified: info.mtimeMs, changed: info.ctimeMs }
      } catch {
        /* A custom provider may expose resolution without a local file. */
      }
    }
    return { id: probe.id, pathDigest: recordDigest(path ?? null), file }
  })
}

// Inspection never runs the discovered executable, authenticates, or assumes publish permission.
export function inspectEnvironment(
  targetDir = process.cwd(),
  { resolver = resolveExecutable, context = {} } = {},
) {
  const config = readConfig(targetDir)
  const probes = config.delivery?.probes ?? []
  const declared = [
    { id: 'git', executable: 'git', required: true },
    { id: 'node', executable: 'node', required: true },
    ...probes,
  ]
  const ids = new Set()
  const capabilities = declared.map((probe) => {
    if (!probe.id || ids.has(probe.id)) throw new Error('Probe ids must be present and unique')
    ids.add(probe.id)
    const path = resolver(probe.executable, { cwd: targetDir })
    return {
      id: probe.id,
      required: probe.required === true,
      state:
        probe.required === false && !probe.executable
          ? 'not-required'
          : path
            ? 'unknown'
            : 'unavailable',
      executableResolved: Boolean(path),
      effect: probe.effect ?? 'observe',
      reason: path
        ? 'Executable located; capability has not been probed'
        : 'Executable not found in this context',
    }
  })
  const identity = recordDigest({
    targetDir: resolve(targetDir),
    probes,
    context,
    resolution: resolutionFingerprint(declared, targetDir, resolver),
  })
  return {
    version: 1,
    mode: 'inspect',
    contextDigest: identity,
    readiness: capabilities.some((p) => p.required && p.state === 'unavailable')
      ? 'blocked'
      : 'limited',
    mutated: false,
    capabilities,
  }
}

export async function probeEnvironment(
  targetDir,
  { profile, authorize, runner = defaultRunner, resolver = resolveExecutable, context = {} } = {},
) {
  const config = readConfig(targetDir)
  const probes = (config.delivery?.probes ?? []).filter((p) => p.profile === profile)
  if (!profile || !probes.length) throw new Error('A configured probe profile is required')
  if (typeof authorize !== 'function') throw new Error('Probe authorization callback required')
  const contextIdentity = (value) =>
    recordDigest({
      config: value,
      context,
      targetDir: resolve(targetDir),
      resolution: resolutionFingerprint(value.delivery?.probes ?? [], targetDir, resolver),
    })
  const before = contextIdentity(config)
  const capabilities = []
  for (const probe of probes) {
    if (
      !probe.id ||
      !probe.executable ||
      !Array.isArray(probe.args) ||
      probe.args.some((v) => typeof v !== 'string') ||
      !PROBE_EFFECTS.includes(probe.effect)
    )
      throw new Error('Probe requires id, executable, argument array and explicit effect')
    if ((await authorize({ probe, targetDir, context })) !== true) {
      capabilities.push({
        id: probe.id,
        required: probe.required === true,
        state: 'unknown',
        reason: 'Probe effect is not authorized',
      })
      continue
    }
    let state = 'unknown',
      reason = 'Probe returned no recognized capability evidence'
    try {
      const output = String(
        await runner(probe.executable, probe.args, {
          cwd: targetDir,
          timeout: probe.timeoutMs ?? 10000,
        }),
      )
      if (probe.expectedText && output.includes(probe.expectedText)) {
        state = 'available'
        reason = 'Expected probe response observed'
      }
    } catch {
      state = 'unavailable'
      reason = 'Probe failed in this context'
    }
    capabilities.push({
      id: probe.id,
      required: probe.required === true,
      effect: probe.effect,
      state,
      reason,
    })
  }
  if (before !== contextIdentity(readConfig(targetDir)))
    for (const item of capabilities) {
      item.state = 'unknown'
      item.reason = 'Configuration or executable resolution changed during probes; rerun'
    }
  return {
    version: 1,
    mode: 'probe',
    contextDigest: before,
    readiness: capabilities.some((p) => p.required && p.state !== 'available')
      ? 'blocked'
      : capabilities.some((p) => p.state !== 'available')
        ? 'limited'
        : 'runnable',
    capabilities,
  }
}
