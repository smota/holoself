import { createAiFoundryDeskProvider } from './ai-foundry-desk.mjs'
import { builtInProviders } from './registry.mjs'

export function shippedProviders(options = {}) {
  const additionalProviders = [...(options.additionalProviders ?? [])]
  if (!additionalProviders.some((provider) => provider.id === 'ai-foundry-desk')) {
    additionalProviders.push(createAiFoundryDeskProvider(options.aiFoundryDesk))
  }
  return builtInProviders({ ...options, additionalProviders })
}
