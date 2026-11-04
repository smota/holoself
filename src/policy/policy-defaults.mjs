// Directory-level privacy policy defaults (_policy.yaml): validation, discovery and inheritance resolution.
import { existsSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { CONFIDENTIAL_SENSITIVITIES } from '../annotations.mjs'
import { canonicalSort, readSourceWithStat } from '../catalog.mjs'
import { linkBelow, locateBelow, lstat } from '../path-guard.mjs'
import { hash, slash } from '../shared/fs.mjs'
import { parseYaml } from '../shared/yaml.mjs'
import { PRIVACY_FIELDS, privacyValueValid } from './privacy-fields.mjs'

export const POLICY_FILE_NAME = '_policy.yaml'
export const CANONICAL_POLICY_DIRS = Object.freeze(['profile', 'context', 'history', 'topics', 'reference'])
export const POLICY_DEFAULT_FIELDS = new Set([
  'access_lenses',
  'exclude_lenses',
  'disclosure',
  'sensitivity',
  'document_role',
  'read_scope',
  'task_include',
  'task_exclude',
  'confidence',
  'knowledge_status',
  'temporal_scope'
])

export function validatePolicyDefaultsObject(rawObj, registry = null) {
  if (!rawObj || typeof rawObj !== 'object' || Array.isArray(rawObj)) {
    return ['policy defaults must be a YAML mapping']
  }
  const keys = Object.keys(rawObj)
  if (keys.length === 0) {
    return ['policy defaults mapping must not be empty']
  }
  const errors = []
  for (const key of keys) {
    if (!POLICY_DEFAULT_FIELDS.has(key)) {
      errors.push(`unknown policy default key ${key}`)
      continue
    }
    const val = rawObj[key]
    if (key === 'knowledge_status' && val === 'superseded') {
      errors.push('invalid knowledge_status value superseded in policy defaults')
      continue
    }
    if (key === 'exclude_lenses' && Array.isArray(val) && new Set(val).size !== val.length) {
      errors.push('invalid exclude_lenses value: duplicate lens ids')
      continue
    }
    if (!privacyValueValid(key, val, registry)) {
      const formatted = typeof val === 'string' ? val : JSON.stringify(val)
      errors.push(`invalid ${key} value ${formatted}`)
    }
  }
  if (
    (rawObj.sensitivity === 'restricted' || rawObj.read_scope === 'restricted') &&
    Array.isArray(rawObj.access_lenses) &&
    rawObj.access_lenses.some(lens => lens !== 'private')
  ) {
    errors.push('restricted sensitivity or read_scope cannot grant access_lenses beyond private')
  }
  if (rawObj.disclosure === 'publish-approved' && CONFIDENTIAL_SENSITIVITIES.includes(rawObj.sensitivity)) {
    errors.push(`publish-approved disclosure cannot be combined with ${rawObj.sensitivity} sensitivity`)
  }
  if (rawObj.disclosure === 'publish-approved' && rawObj.read_scope === 'restricted') {
    errors.push('publish-approved disclosure cannot be combined with restricted read_scope')
  }
  return errors
}

export function readPolicyFile(policyPath, selfRoot, registry = null) {
  const baseRoot = resolve(selfRoot)
  const normPolicy = typeof policyPath === 'string' ? policyPath.replaceAll('\\', '/') : String(policyPath)
  const absPolicy = resolve(baseRoot, normPolicy)
  const located = locateBelow(baseRoot, absPolicy)
  if (!located) {
    return {
      valid: false,
      file: POLICY_FILE_NAME,
      error: `${POLICY_FILE_NAME}: policy file outside self root`,
      stat: null,
      sha256: null
    }
  }
  const rel = located.parts.join('/')
  const st = lstat(absPolicy)
  const link = linkBelow(baseRoot, absPolicy)
  if (link !== null || st?.isSymbolicLink()) {
    return {
      valid: false,
      file: rel,
      error: `${rel}: policy file must not be a symlink`,
      stat: null,
      sha256: null
    }
  }
  if (!st) return null
  if (!st.isFile()) {
    return {
      valid: false,
      file: rel,
      error: `${rel}: policy file must be a regular file`,
      stat: null,
      sha256: null
    }
  }
  let read = null
  try {
    read = readSourceWithStat(absPolicy)
  } catch {
    read = null
  }
  if (!read) {
    return {
      valid: false,
      file: rel,
      error: `${rel}: unreadable policy file`,
      stat: null,
      sha256: null
    }
  }
  const fileHash = hash(read.text)
  let parsed
  try {
    parsed = parseYaml(read.text)
  } catch (err) {
    return {
      valid: false,
      file: rel,
      error: `${rel}: malformed policy YAML (${err.message})`,
      stat: read.stat,
      sha256: fileHash
    }
  }
  const fieldErrors = validatePolicyDefaultsObject(parsed, registry)
  if (fieldErrors.length > 0) {
    return {
      valid: false,
      file: rel,
      error: `${rel}: ${fieldErrors.join('; ')}`,
      stat: read.stat,
      sha256: fileHash
    }
  }
  const defaults = {}
  for (const key of Object.keys(parsed)) {
    defaults[key] = Array.isArray(parsed[key]) ? [...parsed[key]] : parsed[key]
  }
  return {
    valid: true,
    file: rel,
    defaults,
    stat: read.stat,
    sha256: fileHash
  }
}

export function discoverPolicyFiles(selfRoot, registry = null) {
  if (!selfRoot || !existsSync(selfRoot)) return []
  const baseRoot = resolve(selfRoot)
  const results = []
  const describePolicyEntry = fullPath => {
    const res = readPolicyFile(fullPath, baseRoot, registry)
    const rel = slash(relative(baseRoot, fullPath))
    const stat = res?.stat || null
    return {
      file: res?.file || rel,
      valid: Boolean(res?.valid),
      error: res?.error || null,
      defaults: res?.defaults || null,
      size: stat ? stat.size : 0,
      modified_ms: stat ? stat.modified_ms : 0,
      mtime_ns: res?.valid && stat ? stat.mtime_ns : '0',
      ino: stat ? stat.ino : '0',
      dev: stat ? stat.dev : '0',
      sha256: res?.sha256 || '0'.repeat(64)
    }
  }
  const rootPolicy = join(baseRoot, POLICY_FILE_NAME)
  if (lstat(rootPolicy) !== null) {
    results.push(describePolicyEntry(rootPolicy))
  }
  for (const dirName of CANONICAL_POLICY_DIRS) {
    const topDir = join(baseRoot, dirName)
    const topStat = lstat(topDir)
    if (!topStat || topStat.isSymbolicLink() || !topStat.isDirectory()) continue
    const walkDir = currentDir => {
      let entries = []
      try {
        entries = readdirSync(currentDir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const full = join(currentDir, entry.name)
        if (entry.name === POLICY_FILE_NAME) {
          results.push(describePolicyEntry(full))
          continue
        }
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) walkDir(full)
      }
    }
    walkDir(topDir)
  }
  return results.sort((a, b) => canonicalSort(a.file, b.file))
}

export function resolveDocumentPolicy(docFile, selfRoot, docMetadata = {}, registry = null) {
  const frontmatterOnlySources = meta => {
    const src = {}
    if (meta && typeof meta === 'object') {
      for (const key of Object.keys(meta).sort(canonicalSort)) {
        if (PRIVACY_FIELDS.has(key) && meta[key] !== undefined && meta[key] !== null) {
          src[key] = 'frontmatter'
        }
      }
    }
    return src
  }
  if (!selfRoot || !docFile) {
    return {
      effectiveMetadata: { ...(docMetadata || {}) },
      policyDefaults: {},
      policySources: frontmatterOnlySources(docMetadata),
      policyErrors: []
    }
  }
  const baseRoot = resolve(selfRoot)
  const normDoc = typeof docFile === 'string' ? docFile.replaceAll('\\', '/') : String(docFile)
  const absDoc = resolve(baseRoot, normDoc)
  const located = locateBelow(baseRoot, absDoc)
  if (!located || located.parts.length < 2 || !CANONICAL_POLICY_DIRS.includes(located.parts[0])) {
    return {
      effectiveMetadata: { ...(docMetadata || {}) },
      policyDefaults: {},
      policySources: frontmatterOnlySources(docMetadata),
      policyErrors: []
    }
  }

  const chainResults = []
  for (let i = 0; i < located.parts.length; i++) {
    const dirParts = located.parts.slice(0, i)
    const dirAbs = dirParts.length ? join(located.base, ...dirParts) : located.base
    const dirLink = dirParts.length ? linkBelow(located.base, dirAbs) : null
    if (dirLink !== null) {
      const relLink = slash(relative(located.base, dirLink))
      return {
        effectiveMetadata: { ...(docMetadata || {}) },
        policyDefaults: {},
        policySources: frontmatterOnlySources(docMetadata),
        policyErrors: [`${relLink}: directory path must not contain a symlink`]
      }
    }
    const candidatePath = join(dirAbs, POLICY_FILE_NAME)
    if (lstat(candidatePath) !== null) {
      const res = readPolicyFile(candidatePath, located.base, registry)
      if (res) chainResults.push(res)
    }
  }

  const invalid = chainResults.filter(r => !r.valid)
  if (invalid.length > 0) {
    return {
      effectiveMetadata: { ...(docMetadata || {}) },
      policyDefaults: {},
      policySources: frontmatterOnlySources(docMetadata),
      policyErrors: invalid.map(r => r.error)
    }
  }

  const policyDefaults = {}
  const inheritedSources = {}
  for (const res of chainResults) {
    for (const [key, val] of Object.entries(res.defaults)) {
      policyDefaults[key] = Array.isArray(val) ? [...val] : val
      inheritedSources[key] = `policy:${res.file}`
    }
  }

  if (chainResults.length > 1) {
    const mergedErrors = validatePolicyDefaultsObject(policyDefaults, registry)
    if (mergedErrors.length > 0) {
      const innermost = chainResults.at(-1).file
      return {
        effectiveMetadata: { ...(docMetadata || {}) },
        policyDefaults: {},
        policySources: frontmatterOnlySources(docMetadata),
        policyErrors: [`${innermost}: ${mergedErrors.join('; ')}`]
      }
    }
  }

  const effectiveMetadata = {}
  const rawSources = {}
  for (const [key, val] of Object.entries(policyDefaults)) {
    effectiveMetadata[key] = Array.isArray(val) ? [...val] : val
    rawSources[key] = inheritedSources[key]
  }
  if (docMetadata && typeof docMetadata === 'object') {
    for (const [key, val] of Object.entries(docMetadata)) {
      if (val === undefined || val === null) continue
      effectiveMetadata[key] = Array.isArray(val) ? [...val] : val
      if (PRIVACY_FIELDS.has(key)) {
        rawSources[key] = 'frontmatter'
      }
    }
  }

  const policySources = {}
  for (const key of Object.keys(rawSources).sort(canonicalSort)) {
    policySources[key] = rawSources[key]
  }

  return {
    effectiveMetadata,
    policyDefaults,
    policySources,
    policyErrors: []
  }
}
