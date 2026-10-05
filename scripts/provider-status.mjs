#!/usr/bin/env node
import { bindProvider } from '../lib/core/provider-binding.mjs'
import { createCollaborationIntent } from '../lib/core/collaboration-intent.mjs'
import { shippedProviders } from '../lib/providers/catalog.mjs'
import { providerById } from '../lib/providers/registry.mjs'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(name)
  return index === -1 ? fallback : (args[index + 1] ?? fallback)
}
const positional = args.filter((item, index) => {
  if (index > 0 && ['--target', '--provider', '--mode', '--profile'].includes(args[index - 1])) {
    return false
  }
  return !item.startsWith('--')
})
const [command, id] = positional
const providers = shippedProviders()

async function main() {
  if (command === 'list') {
    process.stdout.write(
      `${JSON.stringify(
        providers.map(
          ({
            id: providerId,
            version,
            providerVersion,
            spiRange,
            intentSupport,
            facets,
            targets,
            transports,
            osSupport,
            trust,
            compatibility,
            policy,
          }) => ({
            id: providerId,
            version,
            providerVersion,
            spiRange,
            intentSupport,
            facets,
            targets,
            transports,
            osSupport,
            trust,
            compatibility,
            ...(policy ? { policy } : {}),
          }),
        ),
        null,
        2,
      )}\n`,
    )
    return 0
  }

  if (command === 'inspect') {
    const provider = providerById(id, providers)
    if (!provider) throw new Error(`Unknown provider: ${id}`)
    process.stdout.write(
      `${JSON.stringify(
        {
          id: provider.id,
          version: provider.version,
          providerVersion: provider.providerVersion,
          spiRange: provider.spiRange,
          intentSupport: provider.intentSupport,
          facets: provider.facets,
          targets: provider.targets,
          transports: provider.transports,
          osSupport: provider.osSupport,
          trust: provider.trust,
          compatibility: provider.compatibility,
          ...(provider.policy ? { policy: provider.policy } : {}),
          ...(await provider.inspect()),
        },
        null,
        2,
      )}\n`,
    )
    return 0
  }

  if (command === 'bind') {
    const preferredProvider = flag('--provider', null)
    const intent = createCollaborationIntent({
      requestedMode: flag('--mode', 'single-agent'),
      profile: flag('--profile', 'standard'),
    })
    const binding = await bindProvider({ intent, providers, preferredProvider })
    process.stdout.write(`${JSON.stringify({ intent, binding }, null, 2)}\n`)
    return binding.status === 'blocked' ? 1 : 0
  }

  process.stderr.write(
    'Usage: agentflow-sdlc providers <list|inspect <id>|bind [--provider <id>] [--mode <mode>] [--profile <profile>]> --json\n',
  )
  return 2
}

process.exitCode = await main()
