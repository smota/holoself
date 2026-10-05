import { createLocalCliProvider, inspectFlagIntents } from './local-cli.mjs'

export function createGrokProvider(options = {}) {
  const prepareArgs = (args, request = {}) => {
    if (args.length !== 1 || typeof args[0] !== 'string' || args[0].length === 0) {
      throw new Error('Grok provider requires exactly one single-turn prompt')
    }
    const delegated = request.executionPlan?.intentResolutions?.some(
      (item) =>
        item.id === 'delegated-work' &&
        item.status === 'satisfied' &&
        item.fidelity === 'full' &&
        ['native', 'adapter', 'plugin'].includes(item.implementation),
    )
    return [
      '--permission-mode',
      'plan',
      '--disable-web-search',
      ...(!delegated ? ['--no-subagents'] : []),
      `--single=${args[0]}`,
    ]
  }
  return createLocalCliProvider({
    ...options,
    id: 'grok-cli',
    platform: 'grok',
    executable: 'grok',
    executionTarget: 'grok-cli',
    trustSource: 'Grok CLI local bundle',
    policy: { permissionMode: 'plan', web: false, subagents: 'intent-controlled' },
    prepareArgs,
    inspectIntentSupport: ({ executable, cwd, spawn, declared }) =>
      inspectFlagIntents({
        executable,
        cwd,
        spawn,
        declared,
        flags: {
          'plan-before-edit': '--no-plan',
          'delegated-work': '--no-subagents',
          'parallel-fanout': '--agents',
          'isolated-workspace': '--worktree',
          'structured-result': '--json-schema',
        },
      }),
  })
}
