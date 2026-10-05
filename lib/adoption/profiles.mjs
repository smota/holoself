import { existsSync, readFileSync } from 'node:fs'
import { dirname, extname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PRODUCT_PAYLOAD = JSON.parse(
  readFileSync(new URL('../../manifests/product-payload.json', import.meta.url), 'utf8'),
)
const PRODUCT_FILES = PRODUCT_PAYLOAD.entries
  .filter((entry) => entry.ownership === 'managed')
  .map((entry) => entry.source)
const SEED_ONCE_FILES = PRODUCT_PAYLOAD.entries
  .filter((entry) => entry.ownership === 'seed-once')
  .map((entry) => ({ from: entry.source, to: entry.target }))

export const COMPOSITION_PROFILES = JSON.parse(
  readFileSync(new URL('../../manifests/composition-profiles.json', import.meta.url), 'utf8'),
)

const packageRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const slash = (value) => value.replaceAll('\\', '/')

function dependencyPath(from, specifier, { allowBareRelative = false } = {}) {
  if (!specifier.startsWith('.') && !allowBareRelative) return null
  if (specifier.includes('://') || specifier.startsWith('#')) return null
  const candidate = resolve(dirname(resolve(packageRoot, from)), specifier.split('#', 1)[0])
  const options = extname(candidate) ? [candidate] : [`${candidate}.mjs`, `${candidate}.json`]
  const match = options.find((path) => existsSync(path))
  if (!match) return null
  const path = slash(relative(packageRoot, match))
  return path.startsWith('../') ? null : path
}

function directDependencies(path) {
  const absolute = resolve(packageRoot, path)
  if (path.endsWith('.mjs')) {
    const source = readFileSync(absolute, 'utf8')
    const specifiers = [
      ...source.matchAll(/(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g),
      ...source.matchAll(/import\s+['"]([^'"]+)['"]/g),
    ].map((match) => match[1])
    return specifiers.map((specifier) => dependencyPath(path, specifier)).filter(Boolean)
  }
  if (path.endsWith('.json')) {
    const refs = []
    const visit = (value) => {
      if (Array.isArray(value)) value.forEach(visit)
      else if (value && typeof value === 'object') {
        if (typeof value.$ref === 'string') refs.push(value.$ref)
        Object.values(value).forEach(visit)
      }
    }
    visit(JSON.parse(readFileSync(absolute, 'utf8')))
    return refs
      .map((specifier) => dependencyPath(path, specifier, { allowBareRelative: true }))
      .filter(Boolean)
  }
  return []
}

function dependencyClosed(files) {
  const selected = new Set(files)
  const pending = [...selected]
  while (pending.length) {
    for (const dependency of directDependencies(pending.pop())) {
      if (selected.has(dependency)) continue
      selected.add(dependency)
      pending.push(dependency)
    }
  }
  return [...selected].sort()
}

export function resolveCompositionProfile(profile = COMPOSITION_PROFILES.defaultProfile) {
  const definition = COMPOSITION_PROFILES.profiles[profile]
  if (!definition) {
    throw new Error(
      `Unknown install profile ${profile}; choose one of: ${Object.keys(COMPOSITION_PROFILES.profiles).join(', ')}`,
    )
  }
  const resolving = new Set()
  const filesFor = (id) => {
    if (resolving.has(id)) throw new Error(`Composition profile cycle at ${id}`)
    const current = COMPOSITION_PROFILES.profiles[id]
    if (!current) throw new Error(`Composition profile ${id} extends an unknown profile`)
    resolving.add(id)
    const base = current.extends ? filesFor(current.extends) : []
    const prefixed = (current.includePrefixes ?? []).flatMap((prefix) =>
      PRODUCT_FILES.filter((path) => path.startsWith(prefix)),
    )
    const excluded = new Set(current.exclude ?? [])
    const result = [...new Set([...base, ...(current.files ?? []), ...prefixed])]
      .filter((path) => !excluded.has(path))
      .sort()
    resolving.delete(id)
    return result
  }
  return {
    id: profile,
    description: definition.description,
    managedFiles: dependencyClosed(filesFor(profile)),
    seedOnceFiles: definition.seedOnce === false ? [] : SEED_ONCE_FILES,
  }
}
