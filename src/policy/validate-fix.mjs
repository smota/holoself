// Conservative privacy metadata repair plan and transactional apply for `holoself validate --fix`.
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { CONFIDENTIAL_SENSITIVITIES, VISIBILITIES } from '../annotations.mjs'
import { canonicalJson, canonicalSort } from '../catalog.mjs'
import { loadLensRegistry } from '../lenses.mjs'
import { safeMaintenancePath } from '../maintenance.mjs'
import { lstat } from '../path-guard.mjs'
import { atomicWrite, ensureDir, fileModeOr, hash as sha, slash } from '../shared/fs.mjs'
import { parseScalar, parseYaml } from '../shared/yaml.mjs'
import { POLICY_FILE_NAME, resolveDocumentPolicy } from './policy-defaults.mjs'
import { PRIVACY_FIELDS, canonicalPrivacyMetadataErrors, privacyMetadataErrors, privacyValueValid } from './privacy-fields.mjs'
import { SECRET_RE, secretFile } from './secrets.mjs'

export const REQUIRED_CANONICAL_PRIVACY_FIELDS = Object.freeze(['access_lenses', 'disclosure', 'sensitivity', 'document_role'])
export const CONSERVATIVE_PRIVACY_DEFAULTS = Object.freeze({
  access_lenses: Object.freeze(['private']),
  disclosure: 'internal-only',
  sensitivity: 'personal',
  document_role: 'content'
})
export const PUBLISH_APPROVED_SKIP_WARNING = 'would activate publish-approved; add the missing fields by hand or rerun with --allow-publish-approved'

const VF_CANONICAL_DIRS = Object.freeze(['profile', 'context', 'topics', 'history'])
const VF_LIFECYCLE_ONLY_ERRORS = new Set(['valid_from must not be after valid_until', 'superseded knowledge must name superseded_by'])

export function excludedIncompleteMetadataNotice(count) {
  return `${count} canonical documents are excluded from context because their privacy metadata is incomplete — run \`holoself validate --fix\``
}

export function countCatalogExcludedIncompleteMetadata(selfCatalog) {
  if (!selfCatalog || !Array.isArray(selfCatalog.ignored_sources)) return 0
  let count = 0
  for (const item of selfCatalog.ignored_sources) {
    const rawReason = typeof item?.reason === 'string' ? item.reason.trim() : ''
    if (!rawReason || rawReason === 'secret' || rawReason === 'unreadable: stat failure' || rawReason.includes(': unreadable')) continue
    if (rawReason === 'unsupported visibility') {
      count++
      continue
    }
    const prefix = item?.file ? `${item.file}: ` : ''
    const detail = prefix && rawReason.startsWith(prefix) ? rawReason.slice(prefix.length) : rawReason
    const parts = detail
      .split(';')
      .map(part => part.trim())
      .filter(Boolean)
    if (parts.length > 0 && parts.every(part => VF_LIFECYCLE_ONLY_ERRORS.has(part))) continue
    count++
  }
  return count
}

function vfLoadRootRegistry(root) {
  if (!root || !existsSync(root)) return null
  try {
    return loadLensRegistry(root)
  } catch {
    return null
  }
}

function vfFormatYamlScalarOrList(value) {
  if (Array.isArray(value)) return `[${value.join(', ')}]`
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  if (value && typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function vfFormatReasonValue(value) {
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

function vfSalvageValidPrivacyFields(raw, registry = null) {
  const salvaged = {}
  const lines = raw.split(/\r?\n/)
  let activeListKey = null
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    if (indent === 0) {
      activeListKey = null
      const match = trimmed.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/)
      if (!match) continue
      const key = match[1].trim()
      const scalar = match[2].trim()
      if (!scalar) {
        if (['access_lenses', 'exclude_lenses', 'task_include', 'task_exclude'].includes(key)) {
          salvaged[key] = []
          activeListKey = key
        }
        continue
      }
      try {
        const parsed = parseScalar(scalar)
        if (!PRIVACY_FIELDS.has(key) || privacyValueValid(key, parsed, registry)) {
          salvaged[key] = parsed
        }
      } catch {}
      continue
    }
    if (activeListKey) {
      const itemMatch = trimmed.match(/^-\s+(.+)$/)
      if (!itemMatch) continue
      try {
        const itemVal = parseScalar(itemMatch[1])
        salvaged[activeListKey].push(itemVal)
      } catch {}
    }
  }
  for (const key of Object.keys(salvaged)) {
    if (PRIVACY_FIELDS.has(key) && !privacyValueValid(key, salvaged[key], registry)) {
      delete salvaged[key]
    }
  }
  return salvaged
}

function vfSplitFrontmatter(text, registry = null) {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) {
    return {
      hasFrontmatter: false,
      closeFenceFound: true,
      rawFrontmatter: '',
      afterClose: text,
      docMetadata: {},
      parseError: null
    }
  }
  const openLen = text.startsWith('---\r\n') ? 5 : 4
  const end = text.indexOf('\n---', 4)
  if (end < 0) {
    const rawFrontmatter = text.slice(openLen).replace(/\r$/, '')
    return {
      hasFrontmatter: true,
      closeFenceFound: false,
      rawFrontmatter,
      afterClose: '\n',
      docMetadata: vfSalvageValidPrivacyFields(rawFrontmatter, registry),
      parseError: 'unclosed frontmatter'
    }
  }
  const rawFrontmatter = text.slice(openLen, Math.max(openLen, end)).replace(/\r$/, '')
  const afterClose = text.slice(end + 4)
  try {
    const parsed = parseYaml(rawFrontmatter)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        hasFrontmatter: true,
        closeFenceFound: true,
        rawFrontmatter,
        afterClose,
        docMetadata: vfSalvageValidPrivacyFields(rawFrontmatter, registry),
        parseError: 'frontmatter must be a YAML mapping'
      }
    }
    return {
      hasFrontmatter: true,
      closeFenceFound: true,
      rawFrontmatter,
      afterClose,
      docMetadata: { ...parsed },
      parseError: null
    }
  } catch (err) {
    return {
      hasFrontmatter: true,
      closeFenceFound: true,
      rawFrontmatter,
      afterClose,
      docMetadata: vfSalvageValidPrivacyFields(rawFrontmatter, registry),
      parseError: err.message
    }
  }
}

function vfBuildFrontmatterDiff(rel, oldLines, newLines) {
  const header = [`--- a/${rel}`, `+++ b/${rel}`, '@@ frontmatter @@']
  if (oldLines.length === 0) {
    return [...header, ...newLines.map(line => `+${line}`)].join('\n')
  }
  const bodyLines = []
  let i = 0
  let j = 0
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      bodyLines.push(` ${oldLines[i]}`)
      i++
      j++
      continue
    }
    const oldKey = i < oldLines.length ? oldLines[i].match(/^([a-zA-Z0-9_-]+):/)?.[1] : null
    const newKey = j < newLines.length ? newLines[j].match(/^([a-zA-Z0-9_-]+):/)?.[1] : null
    if (oldKey && newKey && oldKey === newKey) {
      bodyLines.push(`-${oldLines[i]}`)
      i++
      while (i < oldLines.length && /^\s+/.test(oldLines[i])) {
        bodyLines.push(`-${oldLines[i]}`)
        i++
      }
      bodyLines.push(`+${newLines[j]}`)
      j++
      while (j < newLines.length && /^\s+/.test(newLines[j])) {
        bodyLines.push(`+${newLines[j]}`)
        j++
      }
      continue
    }
    if (i < oldLines.length && (j >= newLines.length || !newLines.slice(j).includes(oldLines[i]))) {
      bodyLines.push(`-${oldLines[i]}`)
      i++
      continue
    }
    if (j < newLines.length) {
      bodyLines.push(`+${newLines[j]}`)
      j++
    }
  }
  return [...header, ...bodyLines].join('\n')
}

function vfUpdateFrontmatterText(rel, originalText, splitInfo, changes) {
  const orderedChangeKeys = [
    ...REQUIRED_CANONICAL_PRIVACY_FIELDS.filter(key => Object.hasOwn(changes, key)),
    ...Object.keys(changes)
      .filter(key => !REQUIRED_CANONICAL_PRIVACY_FIELDS.includes(key))
      .sort(canonicalSort)
  ]
  if (!splitInfo.hasFrontmatter) {
    const newInnerLines = orderedChangeKeys.map(key => `${key}: ${vfFormatYamlScalarOrList(changes[key])}`)
    const newBlockLines = ['---', ...newInnerLines, '---']
    const separator = originalText.length === 0 ? '\n' : '\n'
    const after = newBlockLines.join('\n') + separator + originalText
    const frontmatterDiff = vfBuildFrontmatterDiff(rel, [], newBlockLines)
    return { after, frontmatterDiff }
  }

  const oldRawLines = splitInfo.rawFrontmatter ? splitInfo.rawFrontmatter.split(/\r?\n/) : []
  const oldBlockLines = ['---', ...oldRawLines, ...(splitInfo.closeFenceFound ? ['---'] : [])]

  if (!splitInfo.closeFenceFound || splitInfo.parseError) {
    const merged = { ...splitInfo.docMetadata, ...changes }
    const mergedKeys = [
      ...Object.keys(splitInfo.docMetadata).filter(key => !orderedChangeKeys.includes(key)),
      ...orderedChangeKeys
    ]
    const newInnerLines = mergedKeys.map(key => `${key}: ${vfFormatYamlScalarOrList(merged[key])}`)
    const newBlockLines = ['---', ...newInnerLines, '---']
    const suffix = splitInfo.afterClose.startsWith('\n') || splitInfo.afterClose.startsWith('\r\n') ? splitInfo.afterClose : `\n${splitInfo.afterClose}`
    const after = newBlockLines.join('\n') + suffix
    const frontmatterDiff = vfBuildFrontmatterDiff(rel, oldBlockLines, newBlockLines)
    return { after, frontmatterDiff }
  }

  const replacedKeys = new Set()
  const newInnerLines = []
  let idx = 0
  while (idx < oldRawLines.length) {
    const line = oldRawLines[idx]
    const topMatch = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/)
    if (topMatch && Object.hasOwn(changes, topMatch[1])) {
      const key = topMatch[1]
      if (!replacedKeys.has(key)) {
        newInnerLines.push(`${key}: ${vfFormatYamlScalarOrList(changes[key])}`)
        replacedKeys.add(key)
      }
      idx++
      while (idx < oldRawLines.length && /^\s+/.test(oldRawLines[idx])) idx++
      continue
    }
    newInnerLines.push(line)
    idx++
  }
  for (const key of orderedChangeKeys) {
    if (!replacedKeys.has(key)) {
      newInnerLines.push(`${key}: ${vfFormatYamlScalarOrList(changes[key])}`)
      replacedKeys.add(key)
    }
  }
  const newBlockLines = ['---', ...newInnerLines, '---']
  const after = newBlockLines.join('\n') + splitInfo.afterClose
  const frontmatterDiff = vfBuildFrontmatterDiff(rel, oldBlockLines, newBlockLines)
  return { after, frontmatterDiff }
}

function vfComputeDocumentFix(absPath, baseRoot, registry) {
  const rel = slash(relative(baseRoot, absPath))
  const text = readFileSync(absPath, 'utf8')
  if (secretFile(absPath, baseRoot) || SECRET_RE.test(text)) return null

  const splitInfo = vfSplitFrontmatter(text, registry)
  const { docMetadata, parseError } = splitInfo
  if (['secret', 'credential', 'credentials'].includes(docMetadata.sensitivity)) return null

  const resolvedPolicy = resolveDocumentPolicy(absPath, baseRoot, docMetadata, registry)
  const effectiveMetadata = resolvedPolicy.effectiveMetadata
  if (['secret', 'credential', 'credentials'].includes(effectiveMetadata.sensitivity)) return null

  const docErrors = privacyMetadataErrors(docMetadata, registry)
  const effectiveErrors = canonicalPrivacyMetadataErrors(effectiveMetadata, registry).filter(err => !VF_LIFECYCLE_ONLY_ERRORS.has(err))
  const legacyVisErrors =
    effectiveMetadata.visibility !== undefined && !VISIBILITIES.includes(effectiveMetadata.visibility)
      ? [`invalid visibility ${effectiveMetadata.visibility}`]
      : []
  const publishConflictErrors = []
  if (effectiveMetadata.disclosure === 'publish-approved' && CONFIDENTIAL_SENSITIVITIES.includes(effectiveMetadata.sensitivity)) {
    publishConflictErrors.push(`publish-approved disclosure cannot be combined with ${effectiveMetadata.sensitivity} sensitivity`)
  }
  if (effectiveMetadata.disclosure === 'publish-approved' && effectiveMetadata.read_scope === 'restricted') {
    publishConflictErrors.push('publish-approved disclosure cannot be combined with restricted read_scope')
  }

  const allErrors = [...new Set([...(parseError ? [parseError] : []), ...docErrors, ...effectiveErrors, ...legacyVisErrors, ...publishConflictErrors])]
  if (allErrors.length === 0) return null

  const missingFields = []
  const invalidFields = []
  const keptFields = []
  const changes = {}

  if (parseError) {
    invalidFields.push({
      field: 'frontmatter',
      before: splitInfo.rawFrontmatter,
      after: 'repaired YAML frontmatter',
      reason: `${parseError}; replaced invalid frontmatter syntax while keeping valid fields`
    })
  }

  // Optional fields that are present in docMetadata and invalid must be replaced conservatively so validation passes.
  if (Object.hasOwn(docMetadata, 'read_scope') && docMetadata.read_scope !== undefined && docMetadata.read_scope !== null) {
    if (!privacyValueValid('read_scope', docMetadata.read_scope, registry)) {
      invalidFields.push({
        field: 'read_scope',
        before: docMetadata.read_scope,
        after: 'restricted',
        reason: `invalid read_scope value ${vfFormatReasonValue(docMetadata.read_scope)}; replaced with conservative restricted`
      })
      changes.read_scope = 'restricted'
    }
  }
  if (Object.hasOwn(docMetadata, 'visibility') && docMetadata.visibility !== undefined && docMetadata.visibility !== null) {
    if (!privacyValueValid('visibility', docMetadata.visibility, registry)) {
      invalidFields.push({
        field: 'visibility',
        before: docMetadata.visibility,
        after: 'private',
        reason: `invalid visibility ${vfFormatReasonValue(docMetadata.visibility)}; replaced with conservative private`
      })
      changes.visibility = 'private'
    } else if (docMetadata.visibility === 'public-safe' && docMetadata.public_safe === false) {
      invalidFields.push({
        field: 'visibility',
        before: docMetadata.visibility,
        after: 'private',
        reason: 'conflicting legacy privacy metadata: visibility public-safe with public_safe false; replaced with conservative private'
      })
      changes.visibility = 'private'
    }
  }
  if (Object.hasOwn(docMetadata, 'public_safe') && docMetadata.public_safe !== undefined && docMetadata.public_safe !== null) {
    if (!privacyValueValid('public_safe', docMetadata.public_safe, registry)) {
      invalidFields.push({
        field: 'public_safe',
        before: docMetadata.public_safe,
        after: false,
        reason: `invalid public_safe value ${vfFormatReasonValue(docMetadata.public_safe)}; replaced with conservative false`
      })
      changes.public_safe = false
    }
  }
  if (Object.hasOwn(docMetadata, 'exclude_lenses') && docMetadata.exclude_lenses !== undefined && docMetadata.exclude_lenses !== null) {
    if (!privacyValueValid('exclude_lenses', docMetadata.exclude_lenses, registry)) {
      const validSubset = Array.isArray(docMetadata.exclude_lenses)
        ? [...new Set(docMetadata.exclude_lenses.filter(item => typeof item === 'string' && (registry ? registry.byId.has(item) : true)))]
        : []
      invalidFields.push({
        field: 'exclude_lenses',
        before: docMetadata.exclude_lenses,
        after: validSubset,
        reason: `invalid exclude_lenses value ${vfFormatReasonValue(docMetadata.exclude_lenses)}; replaced with conservative ${vfFormatYamlScalarOrList(validSubset)}`
      })
      changes.exclude_lenses = validSubset
    }
  }
  if (Object.hasOwn(docMetadata, 'knowledge_status') && docMetadata.knowledge_status !== undefined && docMetadata.knowledge_status !== null) {
    if (!privacyValueValid('knowledge_status', docMetadata.knowledge_status, registry)) {
      invalidFields.push({
        field: 'knowledge_status',
        before: docMetadata.knowledge_status,
        after: 'current',
        reason: `invalid knowledge_status value ${vfFormatReasonValue(docMetadata.knowledge_status)}; replaced with conservative current`
      })
      changes.knowledge_status = 'current'
    }
  }
  if (Object.hasOwn(docMetadata, 'temporal_scope') && docMetadata.temporal_scope !== undefined && docMetadata.temporal_scope !== null) {
    if (!privacyValueValid('temporal_scope', docMetadata.temporal_scope, registry)) {
      invalidFields.push({
        field: 'temporal_scope',
        before: docMetadata.temporal_scope,
        after: 'current',
        reason: `invalid temporal_scope value ${vfFormatReasonValue(docMetadata.temporal_scope)}; replaced with conservative current`
      })
      changes.temporal_scope = 'current'
    }
  }

  // 1. sensitivity: keep existing valid value (never widen) or propose 'personal'
  let finalSensitivity = 'personal'
  if (Object.hasOwn(docMetadata, 'sensitivity') && docMetadata.sensitivity !== undefined && docMetadata.sensitivity !== null) {
    if (privacyValueValid('sensitivity', docMetadata.sensitivity, registry)) {
      keptFields.push('sensitivity')
      finalSensitivity = docMetadata.sensitivity
    } else {
      invalidFields.push({
        field: 'sensitivity',
        before: docMetadata.sensitivity,
        after: CONSERVATIVE_PRIVACY_DEFAULTS.sensitivity,
        reason: `invalid sensitivity value ${vfFormatReasonValue(docMetadata.sensitivity)}; replaced with conservative ${CONSERVATIVE_PRIVACY_DEFAULTS.sensitivity}`
      })
      changes.sensitivity = CONSERVATIVE_PRIVACY_DEFAULTS.sensitivity
      finalSensitivity = CONSERVATIVE_PRIVACY_DEFAULTS.sensitivity
    }
  } else if (Object.hasOwn(effectiveMetadata, 'sensitivity') && privacyValueValid('sensitivity', effectiveMetadata.sensitivity, registry)) {
    keptFields.push('sensitivity')
    finalSensitivity = effectiveMetadata.sensitivity
  } else {
    missingFields.push('sensitivity')
    changes.sensitivity = CONSERVATIVE_PRIVACY_DEFAULTS.sensitivity
    finalSensitivity = CONSERVATIVE_PRIVACY_DEFAULTS.sensitivity
  }

  const finalReadScope = changes.read_scope ?? effectiveMetadata.read_scope ?? null

  // 2. access_lenses: keep existing valid value (unless violating restricted sensitivity/read_scope) or propose ['private']
  if (Object.hasOwn(docMetadata, 'access_lenses') && docMetadata.access_lenses !== undefined && docMetadata.access_lenses !== null) {
    if (privacyValueValid('access_lenses', docMetadata.access_lenses, registry)) {
      if ((finalSensitivity === 'restricted' || finalReadScope === 'restricted') && docMetadata.access_lenses.some(lens => lens !== 'private')) {
        invalidFields.push({
          field: 'access_lenses',
          before: docMetadata.access_lenses,
          after: [...CONSERVATIVE_PRIVACY_DEFAULTS.access_lenses],
          reason: 'restricted sensitivity or read_scope cannot grant access_lenses beyond private; replaced with conservative [private]'
        })
        changes.access_lenses = [...CONSERVATIVE_PRIVACY_DEFAULTS.access_lenses]
      } else {
        keptFields.push('access_lenses')
      }
    } else {
      invalidFields.push({
        field: 'access_lenses',
        before: docMetadata.access_lenses,
        after: [...CONSERVATIVE_PRIVACY_DEFAULTS.access_lenses],
        reason: `invalid access_lenses value ${vfFormatReasonValue(docMetadata.access_lenses)}; replaced with conservative [private]`
      })
      changes.access_lenses = [...CONSERVATIVE_PRIVACY_DEFAULTS.access_lenses]
    }
  } else if (
    Object.hasOwn(effectiveMetadata, 'access_lenses') &&
    privacyValueValid('access_lenses', effectiveMetadata.access_lenses, registry) &&
    !((finalSensitivity === 'restricted' || finalReadScope === 'restricted') && effectiveMetadata.access_lenses.some(lens => lens !== 'private'))
  ) {
    keptFields.push('access_lenses')
  } else if (
    Object.hasOwn(effectiveMetadata, 'access_lenses') &&
    (finalSensitivity === 'restricted' || finalReadScope === 'restricted') &&
    Array.isArray(effectiveMetadata.access_lenses) &&
    effectiveMetadata.access_lenses.some(lens => lens !== 'private')
  ) {
    invalidFields.push({
      field: 'access_lenses',
      before: effectiveMetadata.access_lenses,
      after: [...CONSERVATIVE_PRIVACY_DEFAULTS.access_lenses],
      reason: 'restricted sensitivity or read_scope cannot grant access_lenses beyond private; replaced with conservative [private]'
    })
    changes.access_lenses = [...CONSERVATIVE_PRIVACY_DEFAULTS.access_lenses]
  } else {
    missingFields.push('access_lenses')
    changes.access_lenses = [...CONSERVATIVE_PRIVACY_DEFAULTS.access_lenses]
  }

  // 3. disclosure: keep existing valid value (unless publish-approved with confidential/restricted) or propose 'internal-only'
  if (Object.hasOwn(docMetadata, 'disclosure') && docMetadata.disclosure !== undefined && docMetadata.disclosure !== null) {
    if (privacyValueValid('disclosure', docMetadata.disclosure, registry)) {
      if (docMetadata.disclosure === 'publish-approved' && (CONFIDENTIAL_SENSITIVITIES.includes(finalSensitivity) || finalReadScope === 'restricted')) {
        invalidFields.push({
          field: 'disclosure',
          before: docMetadata.disclosure,
          after: CONSERVATIVE_PRIVACY_DEFAULTS.disclosure,
          reason: `publish-approved disclosure cannot be combined with ${finalSensitivity || 'restricted'}; replaced with conservative ${CONSERVATIVE_PRIVACY_DEFAULTS.disclosure}`
        })
        changes.disclosure = CONSERVATIVE_PRIVACY_DEFAULTS.disclosure
      } else {
        keptFields.push('disclosure')
      }
    } else {
      invalidFields.push({
        field: 'disclosure',
        before: docMetadata.disclosure,
        after: CONSERVATIVE_PRIVACY_DEFAULTS.disclosure,
        reason: `invalid disclosure value ${vfFormatReasonValue(docMetadata.disclosure)}; replaced with conservative ${CONSERVATIVE_PRIVACY_DEFAULTS.disclosure}`
      })
      changes.disclosure = CONSERVATIVE_PRIVACY_DEFAULTS.disclosure
    }
  } else if (
    Object.hasOwn(effectiveMetadata, 'disclosure') &&
    privacyValueValid('disclosure', effectiveMetadata.disclosure, registry) &&
    !(effectiveMetadata.disclosure === 'publish-approved' && (CONFIDENTIAL_SENSITIVITIES.includes(finalSensitivity) || finalReadScope === 'restricted'))
  ) {
    keptFields.push('disclosure')
  } else {
    missingFields.push('disclosure')
    changes.disclosure = CONSERVATIVE_PRIVACY_DEFAULTS.disclosure
  }

  // 4. document_role: keep existing valid value or propose 'content'
  if (Object.hasOwn(docMetadata, 'document_role') && docMetadata.document_role !== undefined && docMetadata.document_role !== null) {
    if (privacyValueValid('document_role', docMetadata.document_role, registry)) {
      keptFields.push('document_role')
    } else {
      invalidFields.push({
        field: 'document_role',
        before: docMetadata.document_role,
        after: CONSERVATIVE_PRIVACY_DEFAULTS.document_role,
        reason: `invalid document_role value ${vfFormatReasonValue(docMetadata.document_role)}; replaced with conservative ${CONSERVATIVE_PRIVACY_DEFAULTS.document_role}`
      })
      changes.document_role = CONSERVATIVE_PRIVACY_DEFAULTS.document_role
    }
  } else if (Object.hasOwn(effectiveMetadata, 'document_role') && privacyValueValid('document_role', effectiveMetadata.document_role, registry)) {
    keptFields.push('document_role')
  } else {
    missingFields.push('document_role')
    changes.document_role = CONSERVATIVE_PRIVACY_DEFAULTS.document_role
  }

  const orderedMissing = REQUIRED_CANONICAL_PRIVACY_FIELDS.filter(field => missingFields.includes(field))
  const orderedKept = REQUIRED_CANONICAL_PRIVACY_FIELDS.filter(field => keptFields.includes(field))
  const orderedChanges = {}
  for (const field of REQUIRED_CANONICAL_PRIVACY_FIELDS) {
    if (Object.hasOwn(changes, field)) {
      orderedChanges[field] = Array.isArray(changes[field]) ? [...changes[field]] : changes[field]
    }
  }
  for (const field of Object.keys(changes).sort(canonicalSort)) {
    if (!Object.hasOwn(orderedChanges, field)) {
      orderedChanges[field] = Array.isArray(changes[field]) ? [...changes[field]] : changes[field]
    }
  }

  const proposedMetadata = {}
  for (const field of REQUIRED_CANONICAL_PRIVACY_FIELDS) {
    const val = Object.hasOwn(orderedChanges, field) ? orderedChanges[field] : effectiveMetadata[field] ?? docMetadata[field]
    proposedMetadata[field] = Array.isArray(val) ? [...val] : val
  }

  const { after, frontmatterDiff } = vfUpdateFrontmatterText(rel, text, splitInfo, orderedChanges)
  const hasLegacyOptOut =
    (docMetadata.visibility !== undefined && docMetadata.visibility !== null) ||
    (docMetadata.public_safe !== undefined && docMetadata.public_safe !== null)

  const keptVisibilityPublicSafe = docMetadata.visibility === 'public-safe' && !Object.hasOwn(orderedChanges, 'visibility')
  const keptPublicSafeTrue = docMetadata.public_safe === true && !Object.hasOwn(orderedChanges, 'public_safe')
  const wouldActivatePublishApproved =
    (orderedKept.includes('disclosure') && proposedMetadata.disclosure === 'publish-approved') ||
    keptVisibilityPublicSafe ||
    keptPublicSafeTrue

  const reasons = [
    ...orderedKept.map(field => `kept valid ${field}: ${vfFormatYamlScalarOrList(proposedMetadata[field])}`),
    ...(keptVisibilityPublicSafe ? ['kept valid visibility: public-safe'] : []),
    ...(keptPublicSafeTrue ? ['kept valid public_safe: true'] : []),
    ...orderedMissing.map(field => `missing ${field} -> ${vfFormatYamlScalarOrList(orderedChanges[field])}`),
    ...invalidFields.map(item => item.reason)
  ]

  const directory = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
  return {
    path: rel,
    directory,
    before: text,
    after,
    before_sha256: sha(text),
    after_sha256: sha(after),
    missing_fields: orderedMissing,
    invalid_fields: invalidFields,
    kept_fields: orderedKept,
    changes: orderedChanges,
    proposed_metadata: proposedMetadata,
    reasons,
    frontmatter_diff: frontmatterDiff,
    frontmatter_error: parseError,
    has_legacy_visibility: Boolean(hasLegacyOptOut),
    would_activate_publish_approved: Boolean(wouldActivatePublishApproved),
    validation_errors: allErrors
  }
}

export function excludedCanonicalDocuments(root, registry = null) {
  if (!root || !existsSync(root)) return []
  const baseRoot = resolve(root)
  const resolvedRegistry = registry || vfLoadRootRegistry(baseRoot)
  const candidateFiles = []
  for (const top of VF_CANONICAL_DIRS) {
    const topDir = join(baseRoot, top)
    if (!existsSync(topDir)) continue
    safeMaintenancePath(baseRoot, `${top}/.probe`)
    const walk = dir => {
      let entries = []
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const full = join(dir, entry.name)
        const rel = slash(relative(baseRoot, full))
        if (entry.isSymbolicLink()) throw new Error(`unsafe validate --fix entry: ${rel}`)
        if (entry.isDirectory()) walk(full)
        else if (entry.isFile() && entry.name.endsWith('.md')) candidateFiles.push(full)
      }
    }
    walk(topDir)
  }
  candidateFiles.sort((a, b) => canonicalSort(slash(relative(baseRoot, a)), slash(relative(baseRoot, b))))
  const excluded = []
  for (const absPath of candidateFiles) {
    const fix = vfComputeDocumentFix(absPath, baseRoot, resolvedRegistry)
    if (fix) excluded.push(fix)
  }
  return excluded
}

function vfBuildPolicySuggestions(baseRoot, excludedDocs, skippedPublishApprovedDocs = []) {
  const byDir = new Map()
  for (const doc of excludedDocs) {
    if (!doc.directory) continue
    if (!byDir.has(doc.directory)) byDir.set(doc.directory, [])
    byDir.get(doc.directory).push(doc)
  }

  const policySuggestions = []
  const skippedPolicyFiles = []

  const sortedDirs = [...byDir.keys()].sort(canonicalSort)
  for (const dir of sortedDirs) {
    // Do not suggest a directory _policy.yaml if it would sit above a skipped publish-approved document and silently activate it.
    if (skippedPublishApprovedDocs.some(doc => doc.directory === dir || doc.directory.startsWith(`${dir}/`))) continue

    const docsInDir = byDir.get(dir)
    const eligibleDocs = docsInDir.filter(
      doc => doc.missing_fields.length > 0 && doc.invalid_fields.length === 0 && !doc.frontmatter_error && !doc.has_legacy_visibility
    )
    if (eligibleDocs.length < 2) continue

    const fieldCounts = new Map()
    for (const doc of eligibleDocs) {
      for (const field of doc.missing_fields) {
        fieldCounts.set(field, (fieldCounts.get(field) || 0) + 1)
      }
    }
    const sharedMissingFields = REQUIRED_CANONICAL_PRIVACY_FIELDS.filter(field => (fieldCounts.get(field) || 0) >= 2)
    if (sharedMissingFields.length === 0) continue

    const coveredDocs = eligibleDocs.filter(doc => doc.missing_fields.some(field => sharedMissingFields.includes(field)))
    if (coveredDocs.length < 2) continue

    const unionMissingFields = REQUIRED_CANONICAL_PRIVACY_FIELDS.filter(field => coveredDocs.some(doc => doc.missing_fields.includes(field)))
    const policyRel = `${dir}/${POLICY_FILE_NAME}`
    const policyAbs = join(baseRoot, policyRel)
    const existingStat = lstat(policyAbs)

    if (existingStat !== null) {
      const existingText = existingStat.isFile() && !existingStat.isSymbolicLink() ? readFileSync(policyAbs, 'utf8') : null
      skippedPolicyFiles.push({
        directory: dir,
        path: policyRel,
        already_exists: true,
        before_sha256: existingText === null ? null : sha(existingText),
        reason: 'existing _policy.yaml is never overwritten',
        covered_files: coveredDocs.map(doc => doc.path),
        missing_fields: unionMissingFields
      })
      continue
    }

    const proposedDefaults = {}
    for (const field of unionMissingFields) {
      proposedDefaults[field] = Array.isArray(CONSERVATIVE_PRIVACY_DEFAULTS[field])
        ? [...CONSERVATIVE_PRIVACY_DEFAULTS[field]]
        : CONSERVATIVE_PRIVACY_DEFAULTS[field]
    }
    const yamlLines = unionMissingFields.map(field => `${field}: ${vfFormatYamlScalarOrList(proposedDefaults[field])}`)
    const afterText = yamlLines.join('\n') + '\n'
    const diffText = ['--- /dev/null', `+++ b/${policyRel}`, '@@ _policy.yaml @@', ...yamlLines.map(line => `+${line}`)].join('\n')

    policySuggestions.push({
      directory: dir,
      path: policyRel,
      already_exists: false,
      covered_files: coveredDocs.map(doc => doc.path),
      missing_fields: unionMissingFields,
      shared_missing_fields: sharedMissingFields,
      proposed_defaults: proposedDefaults,
      before_sha256: null,
      after: afterText,
      after_sha256: sha(afterText),
      diff: diffText
    })
  }

  return { policySuggestions, skippedPolicyFiles }
}

function vfRootId(baseRoot) {
  const norm = slash(resolve(baseRoot)).normalize('NFC')
  const canonical = process.platform === 'win32' ? norm.toLowerCase() : norm
  return sha(`validate-fix-root\0${canonical}`)
}

function vfComputePlanDigest(planObj) {
  const clean = { ...planObj }
  delete clean.digest
  delete clean.alternate_digest
  return sha(canonicalJson(clean))
}

function vfPlanCachePath(baseRoot, digest) {
  return join(baseRoot, '.holoself', 'runtime', 'validate-fix-plans', `${digest}.json`)
}

export function buildValidateFixPlan(root, { withPolicyFiles = false, allowPublishApproved = false, cachePlan = true } = {}) {
  const baseRoot = resolve(root)
  const excludedDocs = excludedCanonicalDocuments(baseRoot)
  const skippedPublishApprovedDocs = allowPublishApproved ? [] : excludedDocs.filter(doc => doc.would_activate_publish_approved)
  const activeDocs = allowPublishApproved ? excludedDocs : excludedDocs.filter(doc => !doc.would_activate_publish_approved)
  const { policySuggestions, skippedPolicyFiles } = vfBuildPolicySuggestions(baseRoot, activeDocs, skippedPublishApprovedDocs)

  const suggestionByCoveredFile = new Map()
  for (const suggestion of policySuggestions) {
    for (const filePath of suggestion.covered_files) {
      suggestionByCoveredFile.set(filePath, suggestion.path)
    }
  }

  const files = activeDocs.map(doc => ({
    path: doc.path,
    directory: doc.directory,
    before_sha256: doc.before_sha256,
    after_sha256: doc.after_sha256,
    missing_fields: doc.missing_fields,
    invalid_fields: doc.invalid_fields,
    kept_fields: doc.kept_fields,
    changes: doc.changes,
    proposed_metadata: doc.proposed_metadata,
    reasons: doc.reasons,
    frontmatter_diff: doc.frontmatter_diff,
    covered_by_policy_suggestion: suggestionByCoveredFile.get(doc.path) || null
  }))

  const skippedPublishApproved = skippedPublishApprovedDocs.map(doc => ({
    path: doc.path,
    directory: doc.directory,
    before_sha256: doc.before_sha256,
    missing_fields: doc.missing_fields,
    invalid_fields: doc.invalid_fields,
    kept_fields: doc.kept_fields,
    warning: PUBLISH_APPROVED_SKIP_WARNING,
    reason: `${doc.path}: ${PUBLISH_APPROVED_SKIP_WARNING}`
  }))
  const warnings = skippedPublishApprovedDocs.map(doc => `${doc.path}: ${PUBLISH_APPROVED_SKIP_WARNING}`)

  const preconditionsMap = new Map()
  for (const doc of excludedDocs) {
    preconditionsMap.set(doc.path, { path: doc.path, before_sha256: doc.before_sha256 })
  }
  for (const suggestion of policySuggestions) {
    preconditionsMap.set(suggestion.path, { path: suggestion.path, before_sha256: null })
  }
  for (const skipped of skippedPolicyFiles) {
    preconditionsMap.set(skipped.path, { path: skipped.path, before_sha256: skipped.before_sha256 })
  }
  const preconditions = [...preconditionsMap.values()].sort((a, b) => canonicalSort(a.path, b.path))

  const buildOps = usePolicyFiles => {
    const ops = []
    if (usePolicyFiles) {
      for (const suggestion of policySuggestions) {
        ops.push({
          operation: 'transform',
          kind: 'policy-file',
          path: suggestion.path,
          before: null,
          after: suggestion.after,
          before_sha256: null,
          after_sha256: suggestion.after_sha256,
          missing_fields: suggestion.missing_fields,
          invalid_fields: [],
          kept_fields: [],
          covered_files: suggestion.covered_files,
          frontmatter_diff: suggestion.diff,
          reason: `create conservative ${suggestion.path} for ${suggestion.covered_files.length} files`
        })
      }
    }
    for (const doc of activeDocs) {
      if (usePolicyFiles && suggestionByCoveredFile.has(doc.path)) continue
      ops.push({
        operation: 'transform',
        kind: 'frontmatter',
        path: doc.path,
        before: doc.before,
        after: doc.after,
        before_sha256: doc.before_sha256,
        after_sha256: doc.after_sha256,
        missing_fields: doc.missing_fields,
        invalid_fields: doc.invalid_fields,
        kept_fields: doc.kept_fields,
        frontmatter_diff: doc.frontmatter_diff,
        reason: doc.reasons.join('; ')
      })
    }
    return ops.sort((a, b) => canonicalSort(a.path, b.path))
  }

  const operations = buildOps(Boolean(withPolicyFiles))
  const body = {
    schema_version: 1,
    kind: 'validate-fix',
    root_id: vfRootId(baseRoot),
    mode: withPolicyFiles ? 'with-policy-files' : 'frontmatter',
    with_policy_files: Boolean(withPolicyFiles),
    allow_publish_approved: Boolean(allowPublishApproved),
    excluded_count: excludedDocs.length,
    files,
    skipped_publish_approved: skippedPublishApproved,
    warnings,
    policy_suggestions: policySuggestions,
    skipped_policy_files: skippedPolicyFiles,
    preconditions,
    operations
  }
  const digest = vfComputePlanDigest(body)
  const plan = { ...body, digest }

  if (cachePlan && existsSync(baseRoot)) {
    try {
      const cacheDir = join(baseRoot, '.holoself', 'runtime', 'validate-fix-plans')
      ensureDir(cacheDir)
      atomicWrite(vfPlanCachePath(baseRoot, digest), JSON.stringify(plan, null, 2) + '\n', { mode: 0o600, exactMode: true })
      const altBody = {
        ...body,
        mode: !withPolicyFiles ? 'with-policy-files' : 'frontmatter',
        with_policy_files: !withPolicyFiles,
        operations: buildOps(!withPolicyFiles)
      }
      const altDigest = vfComputePlanDigest(altBody)
      const altPlan = { ...altBody, digest: altDigest }
      atomicWrite(vfPlanCachePath(baseRoot, altDigest), JSON.stringify(altPlan, null, 2) + '\n', { mode: 0o600, exactMode: true })
    } catch {}
  }

  return plan
}

function vfWriteExactFile(path, text, createdDirs, explicitMode = null) {
  let dir = dirname(path)
  const missing = []
  while (!existsSync(dir)) {
    missing.push(dir)
    dir = dirname(dir)
  }
  mkdirSync(dirname(path), { recursive: true })
  createdDirs.push(...missing.reverse())
  if (text === null) {
    if (existsSync(path)) rmSync(path)
    return
  }
  const mode = explicitMode ?? fileModeOr(path, 0o600)
  atomicWrite(path, text, { mode, exactMode: true })
}

function vfPlanChangedError(message) {
  const err = new Error(`PLAN_CHANGED: ${message}`)
  err.code = 'PLAN_CHANGED'
  return err
}

function vfInvalidDigestError(message = 'validate --fix plan digest mismatch') {
  const err = new Error(message)
  err.code = 'INVALID_DIGEST'
  return err
}

export function applyValidateFixPlan(
  root,
  planOrNull = null,
  { expectedDigest, withPolicyFiles = false, allowPublishApproved = false, validate, afterWrite } = {}
) {
  const baseRoot = resolve(root)
  if (typeof expectedDigest !== 'string' || !/^[0-9a-f]{64}$/i.test(expectedDigest.trim())) {
    throw vfInvalidDigestError()
  }
  const normalizedDigest = expectedDigest.trim().toLowerCase()
  const receiptRel = `.holoself/validate-fix-receipts/${normalizedDigest}.json`
  const receiptPath = safeMaintenancePath(baseRoot, receiptRel)

  if (existsSync(receiptPath)) {
    const existingReceipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
    if (existingReceipt.plan_digest !== normalizedDigest || !Array.isArray(existingReceipt.operations)) {
      throw new Error('validate --fix replay state differs from receipt')
    }
    for (const op of existingReceipt.operations) {
      const abs = safeMaintenancePath(baseRoot, op.path)
      const current = existsSync(abs) ? readFileSync(abs, 'utf8') : null
      const currentSha = current === null ? null : sha(current)
      if (currentSha !== op.after_sha256) {
        throw new Error('validate --fix replay state differs from receipt')
      }
    }
    return { ...existingReceipt, receipt_path: slash(receiptPath), replayed: true }
  }

  let plan = planOrNull
  if (plan) {
    const computed = vfComputePlanDigest(plan)
    if (plan.digest !== normalizedDigest || computed !== normalizedDigest) {
      throw vfInvalidDigestError()
    }
  } else {
    const cachedFile = vfPlanCachePath(baseRoot, normalizedDigest)
    if (existsSync(cachedFile)) {
      const loaded = JSON.parse(readFileSync(cachedFile, 'utf8'))
      if (vfComputePlanDigest(loaded) === normalizedDigest && loaded.digest === normalizedDigest) {
        plan = loaded
      }
    }
    if (!plan) {
      for (const allowPub of [Boolean(allowPublishApproved), !allowPublishApproved]) {
        const currentPlan = buildValidateFixPlan(baseRoot, { withPolicyFiles, allowPublishApproved: allowPub, cachePlan: false })
        const altPlan = buildValidateFixPlan(baseRoot, { withPolicyFiles: !withPolicyFiles, allowPublishApproved: allowPub, cachePlan: false })
        if (currentPlan.digest === normalizedDigest) {
          plan = currentPlan
          break
        }
        if (altPlan.digest === normalizedDigest) {
          plan = altPlan
          break
        }
      }
      if (!plan) throw vfInvalidDigestError()
    }
  }

  if (
    plan.schema_version !== 1 ||
    plan.kind !== 'validate-fix' ||
    plan.root_id !== vfRootId(baseRoot) ||
    !Array.isArray(plan.operations)
  ) {
    throw new Error('invalid validate --fix plan')
  }

  // If the user generated a default plan and passed --with-policy-files at apply time, switch to policy-file operations
  // while preserving the exact preconditions from when the plan was created.
  let operationsToApply = plan.operations
  let effectiveWithPolicy = Boolean(plan.with_policy_files)
  if (withPolicyFiles && !plan.with_policy_files && Array.isArray(plan.policy_suggestions)) {
    effectiveWithPolicy = true
    const coveredSet = new Set()
    const convertedOps = []
    for (const suggestion of plan.policy_suggestions) {
      if (suggestion.already_exists) continue
      for (const filePath of suggestion.covered_files || []) coveredSet.add(filePath)
      convertedOps.push({
        operation: 'transform',
        kind: 'policy-file',
        path: suggestion.path,
        before: null,
        after: suggestion.after,
        before_sha256: null,
        after_sha256: suggestion.after_sha256,
        missing_fields: suggestion.missing_fields,
        invalid_fields: [],
        kept_fields: [],
        covered_files: suggestion.covered_files,
        frontmatter_diff: suggestion.diff,
        reason: `create conservative ${suggestion.path} for ${(suggestion.covered_files || []).length} files`
      })
    }
    for (const op of plan.operations) {
      if (coveredSet.has(op.path)) continue
      convertedOps.push(op)
    }
    operationsToApply = convertedOps.sort((a, b) => canonicalSort(a.path, b.path))
  }

  // Verify preconditions before touching any file.
  for (const pre of plan.preconditions || []) {
    const abs = safeMaintenancePath(baseRoot, pre.path)
    const st = lstat(abs)
    if (st?.isSymbolicLink()) throw vfPlanChangedError(`symlink detected at ${pre.path}`)
    const current = st && st.isFile() ? readFileSync(abs, 'utf8') : null
    const currentSha = current === null ? null : sha(current)
    if (currentSha !== pre.before_sha256) {
      throw vfPlanChangedError(`file ${pre.path} changed since planning`)
    }
  }

  const targets = new Set()
  const ops = []
  for (const op of operationsToApply) {
    if (op.operation !== 'transform') throw new Error(`unsupported validate --fix operation: ${op.operation}`)
    const isPolicyOp = op.kind === 'policy-file' || op.path.endsWith(`/${POLICY_FILE_NAME}`) || op.path === POLICY_FILE_NAME
    if (isPolicyOp) {
      if (!/^(?:profile|context|topics|history)(?:\/[^/]+)*\/_policy\.yaml$/.test(op.path)) {
        throw new Error(`protected validate --fix policy target: ${op.path}`)
      }
      if (op.before !== null || op.before_sha256 !== null) {
        throw new Error(`refusing to overwrite existing policy file: ${op.path}`)
      }
    } else if (!/^(?:profile|context|topics|history)\/.*\.md$/.test(op.path)) {
      throw new Error(`protected validate --fix target: ${op.path}`)
    }
    const abs = safeMaintenancePath(baseRoot, op.path)
    const key = process.platform === 'win32' ? op.path.toLowerCase() : op.path
    if ([...targets].some(target => target === key || target.startsWith(key + '/') || key.startsWith(target + '/'))) {
      throw new Error('duplicate or overlapping validate --fix target')
    }
    targets.add(key)
    if (op.before !== null && typeof op.before !== 'string') throw new Error('invalid validate --fix before text')
    if (typeof op.after !== 'string') throw new Error('invalid validate --fix after text')
    if (op.before_sha256 !== (op.before === null ? null : sha(op.before)) || op.after_sha256 !== sha(op.after)) {
      throw new Error('validate --fix content hash mismatch')
    }
    if (isPolicyOp && lstat(abs) !== null) {
      throw vfPlanChangedError(`existing ${op.path} is never overwritten`)
    }
    const current = existsSync(abs) && lstatSync(abs).isFile() ? readFileSync(abs, 'utf8') : null
    if (current !== op.before) {
      throw vfPlanChangedError(`file ${op.path} changed since planning`)
    }
    ops.push({ ...op, isPolicyOp, absolute: abs })
  }

  // Ensure no additional canonical files became excluded since the plan was built.
  const currentExcluded = excludedCanonicalDocuments(baseRoot)
  const plannedFilePaths = new Set([
    ...(plan.files || []).map(f => f.path),
    ...(plan.skipped_publish_approved || []).map(f => f.path)
  ])
  for (const doc of currentExcluded) {
    if (!plannedFilePaths.has(doc.path) && !targets.has(process.platform === 'win32' ? doc.path.toLowerCase() : doc.path)) {
      throw vfPlanChangedError(`unplanned excluded file ${doc.path} appeared since planning`)
    }
  }

  const lock = safeMaintenancePath(baseRoot, '.holoself/links.json.lock')
  const createdDirs = []
  mkdirSync(dirname(lock), { recursive: true })
  try {
    writeFileSync(lock, String(process.pid), { flag: 'wx' })
  } catch {
    throw new Error('validate --fix authority is busy')
  }

  const applied = []
  let receiptCreated = false
  try {
    for (const op of ops) {
      safeMaintenancePath(baseRoot, op.path)
      if (op.isPolicyOp && lstat(op.absolute) !== null) {
        throw vfPlanChangedError(`existing ${op.path} is never overwritten`)
      }
      const current = existsSync(op.absolute) && lstatSync(op.absolute).isFile() ? readFileSync(op.absolute, 'utf8') : null
      if (current !== op.before) {
        throw vfPlanChangedError(`file ${op.path} changed since planning`)
      }
      const beforeMode = fileModeOr(op.absolute, 0o600)
      vfWriteExactFile(op.absolute, op.after, createdDirs, beforeMode)
      applied.push({ ...op, beforeMode })
      afterWrite?.(op)
    }
    validate?.()

    const receipt = {
      schema_version: 1,
      status: 'applied',
      kind: 'validate-fix',
      mode: effectiveWithPolicy ? 'with-policy-files' : 'frontmatter',
      with_policy_files: effectiveWithPolicy,
      allow_publish_approved: Boolean(plan.allow_publish_approved),
      plan_digest: normalizedDigest,
      applied_at: new Date().toISOString(),
      operations: ops.map(({ path, kind, before_sha256, after_sha256, reason }) => ({
        path,
        kind: kind || 'frontmatter',
        before_sha256,
        after_sha256,
        reason
      })),
      skipped_publish_approved: plan.skipped_publish_approved || [],
      skipped_policy_files: plan.skipped_policy_files || []
    }
    safeMaintenancePath(baseRoot, receiptRel)
    const receiptDir = dirname(receiptPath)
    if (!existsSync(receiptDir)) {
      mkdirSync(receiptDir, { recursive: true })
      createdDirs.push(receiptDir)
    }
    const fd = openSync(receiptPath, 'wx', 0o600)
    receiptCreated = true
    try {
      writeFileSync(fd, JSON.stringify(receipt, null, 2) + '\n')
    } finally {
      closeSync(fd)
    }
    return { ...receipt, receipt_path: slash(receiptPath), replayed: false }
  } catch (error) {
    for (const op of applied.reverse()) {
      try {
        safeMaintenancePath(baseRoot, op.path)
        vfWriteExactFile(op.absolute, op.before, [], op.beforeMode)
      } catch {}
    }
    if (receiptCreated) {
      try {
        safeMaintenancePath(baseRoot, receiptRel)
        rmSync(receiptPath)
      } catch {}
    }
    if (existsSync(lock)) rmSync(lock)
    for (const dir of createdDirs.reverse()) {
      try {
        rmdirSync(dir)
      } catch {}
    }
    throw error
  } finally {
    if (existsSync(lock)) rmSync(lock)
  }
}

export function formatValidateFixPlanText(plan, { outputPath = null } = {}) {
  const lines = []
  if (plan.excluded_count === 0) {
    lines.push('0 canonical documents are excluded from context for incomplete privacy metadata.')
    lines.push(`Plan digest: ${plan.digest}`)
    if (outputPath) lines.push(`Plan written to: ${outputPath}`)
    return lines.join('\n')
  }

  lines.push(excludedIncompleteMetadataNotice(plan.excluded_count))
  lines.push(`Mode: ${plan.with_policy_files ? 'directory _policy.yaml where available (--with-policy-files)' : 'per-file frontmatter (default)'}`)
  lines.push('')

  if (Array.isArray(plan.warnings) && plan.warnings.length > 0) {
    for (const warning of plan.warnings) {
      lines.push(`[warn] ${warning}`)
    }
    lines.push('')
  }

  for (const file of plan.files) {
    lines.push(`File: ${file.path} (before sha256: ${file.before_sha256})`)
    for (const reason of file.reasons) {
      lines.push(`  - ${reason}`)
    }
    if (file.covered_by_policy_suggestion) {
      lines.push(`  - alternative: covered by directory suggestion ${file.covered_by_policy_suggestion}`)
    }
    lines.push(file.frontmatter_diff)
    lines.push('')
  }

  if (plan.policy_suggestions.length > 0) {
    lines.push('Alternative directory _policy.yaml suggestions (pass --with-policy-files to apply these instead of covered per-file frontmatter):')
    for (const suggestion of plan.policy_suggestions) {
      lines.push(`  Directory: ${suggestion.directory} -> ${suggestion.path} (covers: ${suggestion.covered_files.join(', ')})`)
      lines.push(suggestion.diff)
    }
    lines.push('')
  }

  if (plan.skipped_policy_files.length > 0) {
    lines.push('Existing _policy.yaml files (never overwritten):')
    for (const skipped of plan.skipped_policy_files) {
      lines.push(`  - ${skipped.path}: ${skipped.reason} (files fall back to per-file frontmatter: ${skipped.covered_files.join(', ')})`)
    }
    lines.push('')
  }

  if (outputPath) lines.push(`Plan written to: ${outputPath}`)
  lines.push(`Plan digest: ${plan.digest}`)
  const flagParts = ['--fix', '--apply']
  if (plan.with_policy_files) flagParts.push('--with-policy-files')
  if (plan.allow_publish_approved) flagParts.push('--allow-publish-approved')
  lines.push(`Apply: holoself validate ${flagParts.join(' ')} --digest ${plan.digest} --yes`)
  return lines.join('\n')
}
