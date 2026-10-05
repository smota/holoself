import { readFileSync } from 'node:fs'

const PLATFORM_SLUG_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const PLATFORM_KINDS = new Set(['agent-runtime', 'harness', 'human'])

export const BUILT_IN_RUNTIME_PLATFORM_REGISTRY = JSON.parse(
  readFileSync(new URL('../manifests/runtime-platforms.json', import.meta.url), 'utf8'),
)

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function validateRuntimePlatformRegistry(registry) {
  const errors = []

  if (!isPlainObject(registry)) {
    return { ok: false, errors: ['runtime platform registry must be an object'] }
  }
  if (registry.version !== 1) {
    errors.push('runtime platform registry version must be 1')
  }
  if (!Array.isArray(registry.platforms) || registry.platforms.length === 0) {
    errors.push('runtime platform registry platforms must be a non-empty array')
    return { ok: false, errors }
  }

  const slugs = new Set()
  for (const [index, platform] of registry.platforms.entries()) {
    const location = `runtime platform registry platforms[${index}]`
    if (!isPlainObject(platform)) {
      errors.push(`${location} must be an object`)
      continue
    }
    if (typeof platform.slug !== 'string' || !PLATFORM_SLUG_PATTERN.test(platform.slug)) {
      errors.push(`${location}.slug must match ${PLATFORM_SLUG_PATTERN}`)
    } else if (slugs.has(platform.slug)) {
      errors.push(`${location}.slug duplicates registered platform: ${platform.slug}`)
    } else {
      slugs.add(platform.slug)
    }
    if (typeof platform.displayName !== 'string' || platform.displayName.trim() === '') {
      errors.push(`${location}.displayName must be a non-empty string`)
    }
    if (!PLATFORM_KINDS.has(platform.kind)) {
      errors.push(`${location}.kind must be agent-runtime, harness, or human`)
    }
    if (typeof platform.routable !== 'boolean') {
      errors.push(`${location}.routable must be boolean`)
    }
  }

  return { ok: errors.length === 0, errors }
}

export function runtimePlatformRegistry(config = {}) {
  const additions = config?.platformRegistry?.additionalPlatforms ?? []
  if (!Array.isArray(additions)) {
    throw new Error(
      'invalid runtime platform registry: platformRegistry.additionalPlatforms must be an array',
    )
  }
  const routableAddition = additions.find(({ routable } = {}) => routable === true)
  if (routableAddition) {
    throw new Error(
      `invalid runtime platform registry: project platform ${routableAddition.slug ?? '<missing slug>'} must set routable to false; routing adapters remain framework-defined`,
    )
  }
  const registry = {
    version: BUILT_IN_RUNTIME_PLATFORM_REGISTRY.version,
    platforms: [...BUILT_IN_RUNTIME_PLATFORM_REGISTRY.platforms, ...additions],
  }
  const validation = validateRuntimePlatformRegistry(registry)
  if (!validation.ok) {
    throw new Error(`invalid runtime platform registry: ${validation.errors.join('; ')}`)
  }
  return registry
}

export function runtimePlatformSlugs(config = {}) {
  return runtimePlatformRegistry(config).platforms.map(({ slug }) => slug)
}

export function routableRuntimePlatformSlugs(config = {}) {
  return runtimePlatformRegistry(config)
    .platforms.filter(({ routable }) => routable)
    .map(({ slug }) => slug)
}

export function isRegisteredRuntimePlatform(slug, config = {}) {
  return runtimePlatformSlugs(config).includes(slug)
}

export function describeRuntimePlatform(slug, config = {}) {
  return (
    runtimePlatformRegistry(config).platforms.find((platform) => platform.slug === slug) ?? null
  )
}

export const RUNTIME_PLATFORM_SLUGS = runtimePlatformSlugs()
export const ROUTABLE_RUNTIME_PLATFORM_SLUGS = routableRuntimePlatformSlugs()
