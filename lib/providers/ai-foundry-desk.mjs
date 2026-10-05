import { inspectExecutable } from './local-cli.mjs'

export const AI_FOUNDRY_DESK_CONTRACT = {
  repository: 'https://github.com/smota/ai-foundry-desk',
  commit: 'd5cb4588c33d4fb2ed7fdf589e42782e64b741fb',
  version: '0.6.4',
  artifacts: [
    {
      path: 'README.md',
      sha256: '864458D96A28CC701A41E3BFF4F4DF5B10D10E396F16AA7E83EDF2C735D8C287',
      canonicalization: 'raw git blob bytes at pinned commit',
    },
    {
      path: 'docs/PROJECT-HARNESSES.md',
      sha256: '4BB30CDFEF7D4770122C1FD14C9714ACE5549477E5133D5FC91D901438BFBF23',
      canonicalization: 'raw git blob bytes at pinned commit',
    },
    {
      path: 'docs/CLI.md',
      sha256: '2C11655B5C660F17265543D078C5246791E9EB1947C459679322F8F3BDFDCFF4',
      canonicalization: 'raw git blob bytes at pinned commit',
    },
    {
      path: 'agent-manager/src/harness-contracts.ts',
      sha256: '106870F61DFE75177C6F5394192E091C83CDDCFF6D219609860C01CAC16A82ED',
      canonicalization: 'raw git blob bytes at pinned commit',
    },
    {
      path: 'agent-manager/src/contracts.ts',
      sha256: '4FD60AC6ECC9CCDC1E817265C285973AAE4E2DD3BAFB1077E7BDFD7D4541AA6A',
      canonicalization: 'raw git blob bytes at pinned commit',
    },
    {
      path: 'agent-manager/src/cli.ts',
      sha256: '1FD97816C4563B807AFB63D7935740EF30DE70C40B8EE33B9E02F8C55A4C57F7',
      canonicalization: 'raw git blob bytes at pinned commit',
    },
  ],
  facets: ['inventory', 'project-adapters', 'evidence'],
}

export function createAiFoundryDeskProvider(options = {}) {
  const command = (operation, request = {}) =>
    aiFoundryDeskHarnessCommand(operation, request.project, request.args)
  return {
    version: 1,
    id: 'ai-foundry-desk',
    providerVersion: AI_FOUNDRY_DESK_CONTRACT.version,
    spiRange: { min: 1, max: 1 },
    facets: [...AI_FOUNDRY_DESK_CONTRACT.facets],
    intentSupport: [],
    targets: [],
    transports: ['local-cli'],
    osSupport: ['win32', 'linux', 'darwin'],
    trust: {
      source: `${AI_FOUNDRY_DESK_CONTRACT.repository}@${AI_FOUNDRY_DESK_CONTRACT.commit}`,
      artifacts: AI_FOUNDRY_DESK_CONTRACT.artifacts,
    },
    compatibility: { agentflow: '^1', provider: AI_FOUNDRY_DESK_CONTRACT.version },
    operations: {
      inventory: (request) => command('audit', request),
      projectAdapters: (request) => command('plan', request),
      evidence: (request) => command('verify', request),
    },
    async inspect() {
      return {
        ...inspectExecutable({
          executable: 'afd',
          args: ['--version'],
          cwd: options.cwd,
          spawn: options.spawn,
        }),
        metadata: { contract: AI_FOUNDRY_DESK_CONTRACT },
      }
    },
  }
}

export function aiFoundryDeskHarnessCommand(operation, project, extraArgs = []) {
  const allowed = new Set(['audit', 'plan', 'stage', 'test', 'apply', 'verify', 'rollback'])
  if (!allowed.has(operation)) throw new Error(`unsupported AFD harness operation: ${operation}`)
  if (!project) throw new Error('project is required')
  return {
    executable: 'afd',
    args: ['harness', operation, project, ...(extraArgs ?? []), '--json'],
  }
}
