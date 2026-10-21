import { builtInProviders } from './registry.mjs'

export function shippedProviders(options = {}) {
  return builtInProviders(options)
}
