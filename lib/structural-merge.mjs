import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

export const SETTINGS_HARNESSES = ['claude-code', 'agy', 'codex', 'pi']

export function loadSettingsManifest(packageRoot) {
  return JSON.parse(readFileSync(join(packageRoot, 'manifests', 'harness-settings.json'), 'utf8'))
}

export function validateSettingsManifest({ packageRoot, pluginManifests = [] } = {}) {
  const manifest = loadSettingsManifest(packageRoot)
  const findings = []
  if (manifest.version !== 1)
    findings.push(finding('blocker', 'settings.version', 'version must be 1'))
  for (const harness of SETTINGS_HARNESSES) {
    const spec = manifest.settings?.[harness]
    if (!spec) findings.push(finding('blocker', 'settings.harness', `missing ${harness}`))
    if (
      spec &&
      (!spec.path || !spec.merge || typeof spec.merge !== 'object' || Array.isArray(spec.merge))
    )
      findings.push(
        finding('blocker', 'settings.shape', `${harness} requires path and object merge`),
      )
    const plugin = pluginManifests.find((item) => item.harness === harness)
    if (plugin && !plugin.settings?.includes(spec?.path))
      findings.push(
        finding(
          'blocker',
          'settings.plugin-path-drift',
          `${harness} settings path ${spec?.path} missing from plugin manifest`,
        ),
      )
  }
  return {
    ok: findings.every((item) => !['blocker', 'high'].includes(item.severity)),
    findings,
    manifest,
  }
}

export function mergeHarnessSettings({
  packageRoot,
  targetDir,
  harness = 'all',
  write = false,
  pluginManifests = [],
  captureContent = false,
} = {}) {
  const validation = validateSettingsManifest({ packageRoot, pluginManifests })
  const manifest = validation.manifest
  const entries = []
  const captured = []
  const findings = [...validation.findings]
  const harnesses = resolveHarnesses(harness)
  for (const name of harnesses) {
    const spec = manifest.settings[name]
    if (!spec) continue
    const target = join(targetDir, spec.path)
    let current = {}
    let targetExists = existsSync(target)
    if (targetExists) {
      let linked = false
      try {
        linked = lstatSync(target).isSymbolicLink()
      } catch {
        linked = false
      }
      if (linked) {
        entries.push({
          harness: name,
          target,
          status: 'blocked-symlink',
          preservesExistingKeys: [],
        })
        continue
      }
      try {
        current = JSON.parse(readFileSync(target, 'utf8'))
      } catch {
        findings.push(finding('blocker', 'settings.json', `${spec.path} is not valid JSON`))
        entries.push({
          harness: name,
          target,
          status: 'blocked-json',
          preservesExistingKeys: [],
        })
        continue
      }
      if (!isPlainObject(current)) {
        findings.push(
          finding(
            'blocker',
            'settings.root-shape',
            `${spec.path} root must be a JSON object for structural merge; refusing to overwrite ${Array.isArray(current) ? 'array' : typeof current}`,
          ),
        )
        entries.push({
          harness: name,
          target,
          status: 'blocked-root-shape',
          preservesExistingKeys: [],
        })
        continue
      }
    }
    const merged = deepMerge(current, spec.merge)
    const body = `${JSON.stringify(merged, null, 2)}\n`
    const status =
      targetExists && readFileSync(target, 'utf8') === body
        ? 'unchanged'
        : targetExists
          ? 'merge-planned'
          : 'create-planned'
    entries.push({
      harness: name,
      target,
      status,
      backup: targetExists && status !== 'unchanged' ? `${target}.bak` : null,
      preservesExistingKeys: Object.keys(current).filter((key) => spec.merge[key] === undefined),
    })
    if (captureContent) captured.push({ target, content: body, status })
    if (write && status !== 'unchanged') {
      mkdirSync(dirname(target), { recursive: true })
      if (targetExists) copyFileSync(target, `${target}.bak`)
      writeFileSync(target, body)
    }
  }
  const ok = findings.every((item) => !['blocker', 'high'].includes(item.severity))
  const result = { ok, mode: write ? 'apply' : 'dry-run', entries, findings }
  if (captureContent) result.captured = captured
  return result
}

export function harnessSettingsStatus({
  packageRoot,
  targetDir,
  harness = 'all',
  pluginManifests = [],
} = {}) {
  const result = mergeHarnessSettings({
    packageRoot,
    targetDir,
    harness,
    write: false,
    pluginManifests,
  })
  return {
    ...result,
    stale: result.entries.filter(
      (entry) => !['unchanged', 'blocked-root-shape'].includes(entry.status),
    ),
  }
}

export function deepMerge(base, patch) {
  if (Array.isArray(base) && Array.isArray(patch)) return [...new Set([...base, ...patch])]
  if (isPlainObject(base) && isPlainObject(patch)) {
    const out = { ...base }
    for (const [key, value] of Object.entries(patch)) out[key] = deepMerge(out[key], value)
    return out
  }
  if (base === undefined) return clone(patch)
  if (Array.isArray(patch)) return [...new Set(patch)]
  if (isPlainObject(patch)) return deepMerge({}, patch)
  return patch
}

function clone(value) {
  if (Array.isArray(value)) return [...value]
  if (isPlainObject(value))
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]))
  return value
}

function finding(severity, code, message) {
  return { severity, code, message }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function resolveHarnesses(harness) {
  if (harness === 'all') return SETTINGS_HARNESSES
  return String(harness)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}
