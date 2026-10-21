import { createGrokProvider } from './grok.mjs'
import { createLocalCliProvider, inspectFlagIntents } from './local-cli.mjs'
import { createManualProvider } from './manual.mjs'
import { createProviderApiProvider } from './provider-api.mjs'
import { createCodexEngineeringProvider } from './codex-engineering.mjs'

export function builtInProviders(options = {}) {
  return [
    createLocalCliProvider({
      id: 'claude-cli',
      platform: 'claude',
      executable: 'claude',
      executionTarget: 'claude-cli',
      inspectIntentSupport: ({ executable, cwd, spawn, declared }) =>
        inspectFlagIntents({
          executable,
          cwd,
          spawn,
          declared,
          flags: {
            'plan-before-edit': '--permission-mode',
            'delegated-work': '--agents',
            'parallel-fanout': '--agents',
            'isolated-workspace': '--worktree',
            'background-execution': '--background',
            'structured-result': '--json-schema',
          },
        }),
      ...options.claude,
    }),
    createLocalCliProvider({
      id: 'codex-cli',
      platform: 'codex',
      executable: 'codex',
      executionTarget: 'codex-cli',
      modelFlag: '--model',
      ...options.codex,
    }),
    createLocalCliProvider({
      id: 'agy-cli',
      platform: 'agy',
      executable: 'agy',
      executionTarget: 'agy-cli',
      ...options.agy,
    }),
    createGrokProvider(options.grok),
    createProviderApiProvider({
      id: 'xai-api',
      platform: 'grok',
      executionTarget: 'xai-api',
      invoke: options.xai?.invoke,
      trustSource: 'explicit xAI API project configuration',
    }),
    createManualProvider(),
    ...(options.codexEngineering ? [createCodexEngineeringProvider(options.codexEngineering)] : []),
    ...(options.additionalProviders ?? []),
  ]
}

// Pi is a runtime platform and a harness adapter, not a provider. OpenRig is the execution layer
// that runs Pi seats. See docs/glossary.md.
const REMOVED_PROVIDERS = {
  'pi-cli':
    'Provider pi-cli was removed: Pi is a runtime platform and a harness adapter, not a provider. Use the OpenRig execution layer to run Pi seats, or configure another provider',
}

export function removedProviderMessage(id) {
  return Object.hasOwn(REMOVED_PROVIDERS, id) ? REMOVED_PROVIDERS[id] : null
}

export function providerById(id, providers = builtInProviders()) {
  return providers.find((provider) => provider.id === id) ?? null
}

export function resolveConfiguredEngineeringProvider(config, options = {}) {
  const selected = config?.delivery?.engineeringProvider
  if (!selected) return null
  const id = typeof selected === 'string' ? selected : selected.id
  if (!id) throw new Error('Configured engineering provider id is required')
  const removed = removedProviderMessage(id)
  if (removed) throw new Error(removed)
  const provider = providerById(
    id,
    builtInProviders({
      ...options,
      codexEngineering:
        id === 'codex-engineering-cli'
          ? {
              cwd: options.cwd,
              model: selected.requestedModel,
              ...(options.codexEngineering ?? {}),
            }
          : options.codexEngineering,
    }),
  )
  if (!provider) throw new Error(`Configured engineering provider unavailable: ${id}`)
  const executionTarget =
    typeof selected === 'string' ? provider.targets?.[0] : selected.executionTarget
  if (!executionTarget) throw new Error('Configured engineering execution target is required')
  return {
    provider,
    executionTarget,
    requestedModel: typeof selected === 'string' ? null : (selected.requestedModel ?? null),
    requiredCapabilities: typeof selected === 'string' ? [] : (selected.requiredCapabilities ?? []),
    sourceEvidenceDisclosure:
      typeof selected === 'string' ? null : (selected.sourceEvidenceDisclosure ?? null),
    permissionBoundary:
      typeof selected === 'string'
        ? 'mutate-worktree'
        : (selected.permissionBoundary ?? 'mutate-worktree'),
  }
}
