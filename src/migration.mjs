import { existsSync, lstatSync, statSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { canonicalJson } from './catalog.mjs'
import { HASH_RE } from './catalog/schema.mjs'
import { buildCatalogSections, extractSectionAnnotations, privacySections } from './catalog/source.mjs'
import { CUSTOM_SENSITIVITY_CATEGORIES, DEFAULT_LENSES, DEFAULT_LENS_IDS, lensIdStructurallyValid, loadLensRegistry } from './lenses.mjs'
import { CLAIM_MARKER_RE, claimMarkerRewrites, stripClaimMarkers } from './markdown/claim-blocks.mjs'
import {
  allowedDocument,
  disclosure as runtimeDisclosure,
  filterClaimVisibility,
  filterFieldVisibility,
  legacyAccessLenses,
  privacyMetadata,
  publicationAllowed,
  PUBLICATION_ADAPTERS,
  visibility as legacyVisibility
} from './policy/access.mjs'
import { resolveDocumentPolicy } from './policy/policy-defaults.mjs'
import { canonicalPrivacyMetadataErrors, frontmatter, privacyMetadataErrors, restrictPrivacyMetadata } from './policy/privacy-fields.mjs'
import {
  catalogElementVisible,
  fieldAccessValid,
  fieldRuleNameValid,
  intersectRules,
  legacySubDocumentRule,
  normalizeFieldAccess,
  normalizeRule,
  ruleForRegistry
} from './policy/sub-document-rules.mjs'
import { atomicWrite, hash, slash } from './shared/fs.mjs'
import { redactRootPaths } from './shared/redact.mjs'

// Fields every migrated document carries explicitly (the four required canonical fields plus read_scope).
const MIGRATION_REQUIRED_FIELDS = Object.freeze(['access_lenses', 'disclosure', 'sensitivity', 'document_role', 'read_scope'])

export const MIGRATION_ACTIVATION_SKIP_WARNING =
  'would activate catalog-excluded document; review activations and re-run with --confirm-activation'

// The metadata the catalog serves a document with: its (already privacy-validated) frontmatter plus inherited
// _policy.yaml defaults, resolved exactly as buildCatalogSource does for canonical documents (including the
// legacy visibility/public_safe skip and fail-closed handling of invalid policy files). Non-canonical documents
// (docPath null) never inherit directory defaults.
function effectiveMigrationMetadata(meta, docPath, selfRoot, registry = null) {
  if (!docPath || !selfRoot) return meta
  return resolveDocumentPolicy(docPath, selfRoot, meta, registry).effectiveMetadata
}

function normalizeMigrationMetadata(input, registry = null, tolerant = true) {
  if (typeof input === 'string') {
    return frontmatter(input, { tolerant, registry }).metadata
  }
  if (!input || typeof input !== 'object') return {}
  const defined = {}
  for (const [k, v] of Object.entries(input)) {
    if (v !== undefined) defined[k] = Array.isArray(v) ? [...v] : v
  }
  const errors = privacyMetadataErrors(defined, registry)
  if (errors.length > 0) {
    if (!tolerant) throw new Error(errors.join('; '))
    return restrictPrivacyMetadata({ ...defined })
  }
  return defined
}

// Reuses the exact catalog exclusion check from src/catalog/source.mjs (strict frontmatter parsing,
// resolveDocumentPolicy inheritance for canonical documents, and canonicalPrivacyMetadataErrors).
function migrationInspectBefore(input, { registry = null, tolerant = true, selfRoot = null, docPath = null, sourceSpaceId = 'self' } = {}) {
  const policyDocPath = sourceSpaceId === 'self' && selfRoot && docPath ? docPath : null
  const effectiveMetadata = effectiveMigrationMetadata(normalizeMigrationMetadata(input, registry, tolerant), policyDocPath, selfRoot, registry)
  if (sourceSpaceId !== 'self') {
    return { catalogExcluded: false, exclusionErrors: [], effectiveMetadata }
  }
  if (typeof input === 'string') {
    let strictParsed
    try {
      strictParsed = frontmatter(input, { tolerant: false, registry })
    } catch (err) {
      return { catalogExcluded: true, exclusionErrors: [err.message], effectiveMetadata }
    }
    const strictEffective = effectiveMigrationMetadata(strictParsed.metadata, policyDocPath, selfRoot, registry)
    const exclusionErrors = canonicalPrivacyMetadataErrors(strictEffective, registry)
    return {
      catalogExcluded: exclusionErrors.length > 0,
      exclusionErrors,
      effectiveMetadata
    }
  }
  if (input && typeof input === 'object') {
    const defined = {}
    for (const [k, v] of Object.entries(input)) {
      if (v !== undefined) defined[k] = Array.isArray(v) ? [...v] : v
    }
    const rawErrors = privacyMetadataErrors(defined, registry)
    if (rawErrors.length > 0) {
      return { catalogExcluded: true, exclusionErrors: rawErrors, effectiveMetadata }
    }
    const resolvedEffective = effectiveMigrationMetadata(defined, policyDocPath, selfRoot, registry)
    const exclusionErrors = canonicalPrivacyMetadataErrors(resolvedEffective, registry)
    return {
      catalogExcluded: exclusionErrors.length > 0,
      exclusionErrors,
      effectiveMetadata
    }
  }
  const fallbackEffective = effectiveMigrationMetadata({}, policyDocPath, selfRoot, registry)
  const exclusionErrors = canonicalPrivacyMetadataErrors(fallbackEffective, registry)
  return {
    catalogExcluded: exclusionErrors.length > 0,
    exclusionErrors,
    effectiveMetadata
  }
}

// Deprecated frontmatter fields (docs/decisions/privacy-fields-and-legacy-mount.md). `migrate policy` removes them in
// the same edit that materializes their exact runtime meaning as target fields. `field_visibility` becomes
// `field_access`, and claim-marker `visibility=` becomes lens-vocabulary attributes (see subDocumentMigration).
export const DEPRECATED_DOCUMENT_FIELDS = Object.freeze(['visibility', 'public_safe', 'field_visibility'])

// The exact, non-widening target metadata for a document (decision record, section 2, "Mapping: document level").
// `meta` is the metadata the runtime serves (runtime-parsed, so invalid privacy values are already restricted). Every
// explicit, valid modern field is kept; only the gaps the legacy runtime filled implicitly are materialized, and the
// deprecated fields are dropped. The mapping is the same for self, project and contrib documents (`kind` is accepted
// for compatibility only).
export function computeMeetMetadata(meta, kind = 'self', registry = null) {
  void kind
  const raw = meta && typeof meta === 'object' ? meta : {}
  const defined = {}
  for (const [k, v] of Object.entries(raw)) {
    if (v !== undefined) defined[k] = Array.isArray(v) ? [...v] : v
  }
  if (privacyMetadataErrors(defined, registry).length > 0) restrictPrivacyMetadata(defined)

  const result = { ...defined }
  delete result.publication_allowed
  for (const key of DEPRECATED_DOCUMENT_FIELDS) delete result[key]

  // read_scope: the runtime default is restricted for visibility private, shared otherwise.
  if (!['shared', 'local', 'restricted'].includes(defined.read_scope)) result.read_scope = legacyVisibility(defined) === 'private' ? 'restricted' : 'shared'
  // access_lenses: the legacy lens set when missing (custom lenses excluded, as at runtime).
  if (!Array.isArray(defined.access_lenses)) result.access_lenses = legacyAccessLenses(defined)
  // A restricted read_scope or sensitivity admits only the direct owner under the private lens, whatever else is
  // listed, so non-private lenses are dropped (same decisions, and the result is canonically valid). When `private`
  // is not listed the document is already unreachable and its lenses are left as they are.
  if (
    (result.read_scope === 'restricted' || defined.sensitivity === 'restricted') &&
    result.access_lenses.includes('private') &&
    result.access_lenses.some(lens => lens !== 'private')
  )
    result.access_lenses = ['private']
  // disclosure: the runtime's effective value. `public_safe: false` overrides publish-approved with review-required;
  // an explicit internal-only is kept (a label-only narrowing, identical decisions).
  result.disclosure = defined.public_safe === false && defined.disclosure === 'internal-only' ? 'internal-only' : runtimeDisclosure(defined)
  // sensitivity and document_role: the runtime defaults (personal is ungated, like a missing value).
  if (!defined.sensitivity) result.sensitivity = 'personal'
  if (!defined.document_role) result.document_role = 'content'
  return result
}

// Target metadata for a catalog-excluded canonical document (an activation, reviewed with --confirm-activation). It is
// denied everywhere before migration, so the exact mapping has no runtime decision to preserve; the narrower #115
// rules apply instead: conflicting legacy or restricted metadata is fully restricted, and a missing `visibility`
// counts as `private`. The result is never wider than the exact mapping, and the deprecated fields are dropped.
export function computeActivationMetadata(meta, kind = 'self', registry = null) {
  const defined = {}
  for (const [k, v] of Object.entries(meta && typeof meta === 'object' ? meta : {})) if (v !== undefined) defined[k] = Array.isArray(v) ? [...v] : v
  if (
    privacyMetadataErrors(defined, registry).length > 0 ||
    (defined.visibility === 'public-safe' && defined.public_safe === false) ||
    ((defined.sensitivity === 'restricted' || defined.read_scope === 'restricted') &&
      Array.isArray(defined.access_lenses) &&
      defined.access_lenses.some(lens => lens !== 'private'))
  ) {
    const restricted = restrictPrivacyMetadata(defined)
    for (const key of DEPRECATED_DOCUMENT_FIELDS) delete restricted[key]
    delete restricted.publication_allowed
    return restricted
  }
  return computeMeetMetadata(defined.visibility === undefined ? { ...defined, visibility: 'private' } : defined, kind, registry)
}

// Frontmatter changes that migrate one document: every target field that differs from its own frontmatter (so
// inherited values are pinned explicitly) plus `null` (removal) for each deprecated field it carries.
export function migrationChanges(rawMeta, meetMeta) {
  const changes = {}
  for (const key of MIGRATION_REQUIRED_FIELDS)
    if (meetMeta[key] !== undefined && JSON.stringify(rawMeta[key]) !== JSON.stringify(meetMeta[key])) changes[key] = meetMeta[key]
  for (const key of DEPRECATED_DOCUMENT_FIELDS) if (Object.hasOwn(rawMeta, key)) changes[key] = null
  return changes
}

// The `field_access` that replaces a document's `field_visibility`, using the exact mapping table. A name carried by
// both fields gets the narrower of the two. A later name that differs only in case was never reachable (the deprecated
// field stops at the first match), so it is dropped rather than made live. Returns null with a warning when a rule has
// no valid written form; the deprecated field then stays, and keeps working until it is fixed by hand.
function fieldAccessFromLegacy(rawMeta, registry) {
  const legacy = rawMeta.field_visibility,
    existing = rawMeta.field_access
  if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) return { keep: true, warning: 'field_visibility is not a mapping of names to values; fix it by hand' }
  if (existing !== undefined && !fieldAccessValid(existing, registry)) return { keep: true, warning: 'invalid field_access; fix it by hand before field_visibility can be rewritten' }
  const merged = normalizeFieldAccess(existing),
    seen = new Set()
  for (const [name, value] of Object.entries(legacy)) {
    if (!fieldRuleNameValid(name)) return { keep: true, warning: `field_visibility name ${JSON.stringify(name)} cannot be written to field_access` }
    if (seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    let rule = ruleForRegistry(legacySubDocumentRule(value), registry)
    if (rule && Object.hasOwn(merged, name)) rule = intersectRules(rule, normalizeRule(merged[name]))
    if (!rule || rule.access_lenses?.length === 0) return { keep: true, warning: `field_visibility rule ${JSON.stringify(name)} admits no lens` }
    merged[name] = rule
  }
  return { fieldAccess: Object.keys(merged).length ? merged : null, warning: null }
}

// Field rules in frontmatter that does not parse cannot be read, so they cannot be mapped. Salvage keeps only part of
// them, and removing the field would lose the rest. Such a document stays as it is for a fix by hand.
function fieldRulesUnreadable(text, registry) {
  const close = text.indexOf('\n---', 3)
  if (!/^(?:field_visibility|field_access)\s*:/m.test(close < 0 ? text : text.slice(0, close))) return false
  try {
    frontmatter(text, { validatePrivacy: false, registry })
    return false
  } catch {
    return true
  }
}
// Frontmatter and marker changes for the sub-document rules of one document. Claim marker offsets are absolute.
function subDocumentMigration(text, rawMeta, body, { registry, target }) {
  const changes = {},
    warnings = []
  let keepFieldVisibility = false
  if (Object.hasOwn(rawMeta, 'field_visibility')) {
    const { fieldAccess, keep, warning } = fieldAccessFromLegacy(rawMeta, registry)
    if (warning) warnings.push(warning)
    if (keep) keepFieldVisibility = true
    else {
      if (fieldAccess) changes.field_access = fieldAccess
      changes.field_visibility = null
    }
  }
  const offset = text.length - body.length,
    { rewrites, skipped } = claimMarkerRewrites(body, { registry, target })
  if (rewrites.length) changes.claim_markers = rewrites.map(rewrite => ({ ...rewrite, start: rewrite.start + offset }))
  for (const item of skipped) warnings.push(`claim ${item.claim_id} left unchanged: ${item.reason}`)
  return { changes, warnings, keepFieldVisibility }
}

const YAML_SAFE_FIELD_NAME = /^[\p{L}\p{N}](?:[\p{L}\p{N} _.()/&+-]*[\p{L}\p{N}_.()/&+-])?$/u
function fieldAccessFrontmatterLines(fieldAccess) {
  const rules = normalizeFieldAccess(fieldAccess)
  if (!Object.keys(rules).every(name => YAML_SAFE_FIELD_NAME.test(name))) return [`field_access: ${JSON.stringify(rules)}`]
  const lines = ['field_access:']
  for (const [name, rule] of Object.entries(rules)) {
    lines.push(`  ${name}:`)
    if (rule.access_lenses) lines.push(`    access_lenses: [${rule.access_lenses.join(', ')}]`)
    lines.push(`    disclosure: ${rule.disclosure}`)
  }
  return lines
}

// The key line plus every more-indented line under it, including blank lines between them.
function frontmatterBlockEnd(lines, start) {
  let end = start + 1
  for (let i = start + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue
    if (lines[i].length === lines[i].trimStart().length) break
    end = i + 1
  }
  return end
}

// Edits only the lines of the changed keys. Every other line keeps its own bytes, including its line ending, and new
// lines use the ending of the opening delimiter.
export function applyFrontmatterModifications(text, changes) {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) {
    return text
  }
  const nl = text.startsWith('---\r\n') ? '\r\n' : '\n'
  const openLen = 3 + nl.length
  const closeIdx = text.indexOf('\n---', 3)
  if (closeIdx < 0) return text

  const lines = text.slice(openLen, closeIdx + 1).split(/(?<=\n)/).filter(Boolean)
  const lineEnding = line => line.match(/\r?\n$/)?.[0] ?? nl
  // field_access goes first so it can take the place of the field_visibility it replaces.
  const ordered = Object.entries(changes).sort(([a], [b]) => (b === 'field_access') - (a === 'field_access'))
  for (const [key, value] of ordered) {
    // Top-level keys only: never rewrite a nested key such as field_visibility.visibility.
    const keyRegex = new RegExp(`^${key}\\s*:`)
    const existingLineIdx = lines.findIndex(l => keyRegex.test(l))

    if (value === null) {
      // Removal: the key line and any more-indented continuation lines (block lists or nested mappings).
      if (existingLineIdx >= 0) lines.splice(existingLineIdx, frontmatterBlockEnd(lines, existingLineIdx) - existingLineIdx)
      continue
    }
    if (key === 'field_access') {
      const written = fieldAccessFrontmatterLines(value).map(line => line + nl)
      if (existingLineIdx >= 0) lines.splice(existingLineIdx, frontmatterBlockEnd(lines, existingLineIdx) - existingLineIdx, ...written)
      else {
        const replaced = lines.findIndex(l => /^field_visibility\s*:/.test(l))
        lines.splice(replaced >= 0 ? replaced : lines.length, 0, ...written)
      }
      continue
    }
    const formattedVal = Array.isArray(value) ? `[${value.join(', ')}]` : String(value)
    if (existingLineIdx >= 0) {
      let removeCount = 1
      while (existingLineIdx + removeCount < lines.length) {
        const nextLine = lines[existingLineIdx + removeCount]
        const trimmed = nextLine.trim()
        if (!trimmed || trimmed.startsWith('#')) break
        const nextIndent = nextLine.length - nextLine.trimStart().length
        if (nextIndent > 0 && trimmed.startsWith('-')) {
          removeCount++
        } else {
          break
        }
      }
      lines.splice(existingLineIdx, removeCount, `${key}: ${formattedVal}${lineEnding(lines[existingLineIdx])}`)
    } else {
      lines.push(`${key}: ${formattedVal}${nl}`)
    }
  }

  return text.slice(0, openLen) + lines.join('') + text.slice(closeIdx + 1)
}

// Applies a plan entry's changes: claim markers by offset, last first, then frontmatter. Only the bytes of those
// markers and keys change, and the plan's after_sha256 checks the result.
export function applyMigrationChanges(text, changes) {
  const { claim_markers: markers = [], ...fields } = changes
  let result = text
  for (const marker of [...markers].sort((a, b) => b.start - a.start)) {
    if (!result.startsWith(marker.before, marker.start)) throw new Error(`claim marker moved since planning: ${marker.claim_id}`)
    result = result.slice(0, marker.start) + marker.after + result.slice(marker.start + marker.before.length)
  }
  return applyFrontmatterModifications(result, fields)
}

function collectMigrationLenses(registry, beforeMeta, afterMeta) {
  const byId = new Map()
  for (const lens of DEFAULT_LENSES) {
    byId.set(lens.id, lens)
  }
  if (registry?.lenses) {
    for (const lens of registry.lenses) {
      if (lens && typeof lens.id === 'string') byId.set(lens.id, lens)
    }
  } else if (registry?.byId instanceof Map) {
    for (const [id, lens] of registry.byId.entries()) {
      byId.set(id, lens)
    }
  }
  for (const meta of [beforeMeta, afterMeta]) {
    for (const key of ['access_lenses', 'exclude_lenses']) {
      if (Array.isArray(meta?.[key])) {
        for (const id of meta[key]) {
          if (typeof id === 'string' && lensIdStructurallyValid(id) && !byId.has(id)) {
            byId.set(id, { id, sensitivity_access: [] })
          }
        }
      }
    }
  }
  return [...byId.values()]
}

function loadMigrationRegistry(selfRoot) {
  if (!selfRoot || !existsSync(selfRoot)) return null
  try {
    return loadLensRegistry(selfRoot)
  } catch {
    return null
  }
}

export const VERIFY_NON_AMPLIFICATION_ADAPTERS = Object.freeze(['generic', ...PUBLICATION_ADAPTERS])

function migrationActivationReach(afterMeta, { registry = null, sourceSpaceId = 'self', beforeMeta = null } = {}) {
  const lenses = collectMigrationLenses(registry, beforeMeta, afterMeta)
  const allLensIds = new Set(lenses.map(l => l.id))
  const accessibleSpaces = sourceSpaceId === 'self' ? ['self', 'contrib'] : ['self', 'contrib', sourceSpaceId]
  const subjects = [
    { kind: 'owner:direct', accessible_spaces: accessibleSpaces },
    { kind: 'client:linked', accessible_spaces: accessibleSpaces, effective_allowed_lenses: allLensIds },
    ...(sourceSpaceId !== 'self'
      ? [
          { kind: 'owner:direct', accessible_spaces: ['self', 'contrib'] },
          { kind: 'client:linked', accessible_spaces: ['self', 'contrib'], effective_allowed_lenses: allLensIds }
        ]
      : [])
  ]
  const adapters = verifyNonAmplification.adapters
  const tasks = [
    null,
    ...(Array.isArray(beforeMeta?.task_include) ? beforeMeta.task_include : []),
    ...(Array.isArray(afterMeta?.task_include) ? afterMeta.task_include : []),
    ...(Array.isArray(beforeMeta?.task_exclude) ? beforeMeta.task_exclude : []),
    ...(Array.isArray(afterMeta?.task_exclude) ? afterMeta.task_exclude : [])
  ]
  const reachedLenses = []
  const reachedAdapters = new Set()

  for (const lensObj of lenses) {
    const lens = lensObj.id
    const defaultSens = Array.isArray(lensObj.sensitivity_access) ? lensObj.sensitivity_access : []
    const resolutions = [
      { sensitivity_access: defaultSens },
      { sensitivity_access: [] },
      { sensitivity_access: CUSTOM_SENSITIVITY_CATEGORIES }
    ]
    let lensReached = false
    for (const a of adapters) {
      for (const s of subjects) {
        for (const res of resolutions) {
          for (const task of tasks) {
            if (allowedDocument(afterMeta, lens, a, task, res, s, sourceSpaceId).allowed) {
              lensReached = true
              reachedAdapters.add(a)
            }
          }
        }
      }
    }
    if (lensReached) reachedLenses.push(lens)
  }

  return {
    lenses: reachedLenses,
    adapters: adapters.filter(a => reachedAdapters.has(a)),
    publicationAllowed: publicationAllowed(afterMeta)
  }
}

function computeMigrationPlanDigest(entries, confirmActivation = false, activations = []) {
  const entriesDigestInput = entries.map(e => ({
    path: e.path,
    space_id: e.space_id,
    before_sha256: e.before_sha256,
    after_sha256: e.after_sha256,
    needs_migration: e.needs_migration,
    changes: e.changes
  }))
  if (!confirmActivation && (!Array.isArray(activations) || activations.length === 0)) {
    return hash(canonicalJson(entriesDigestInput))
  }
  const activationsDigestInput = (activations || []).map(a => ({
    path: a.path,
    space_id: a.space_id,
    before_sha256: a.before_sha256,
    after_sha256: a.after_sha256,
    lenses: a.lenses,
    adapters: a.adapters,
    publication_allowed: Boolean(a.publication_allowed),
    skipped: Boolean(a.skipped),
    changes: a.changes
  }))
  return hash(
    canonicalJson({
      confirm_activation: Boolean(confirmActivation),
      entries: entriesDigestInput,
      activations: activationsDigestInput
    })
  )
}

// Everything one document delivers to a lens and adapter below the document gate, through the runtime parser and
// filters: content lines (without marker comments, which a rewrite changes) and catalog sections, claims, tags and links.
function subDocumentOutputs(text, meta, lens, adapter, registry) {
  const { body } = frontmatter(text, { tolerant: true, validatePrivacy: false, registry }),
    policy = privacyMetadata(meta, registry),
    scratch = [],
    filtered = value =>
      filterFieldVisibility(filterClaimVisibility(value, lens, '', scratch, null, 'owner:direct', adapter, registry), meta, lens, '', scratch, null, 'owner:direct', adapter),
    outputs = new Map(),
    add = (kind, ...parts) => {
      const key = [kind, ...parts].join('\0')
      outputs.set(key, (outputs.get(key) || 0) + 1)
    }
  for (const line of stripClaimMarkers(filtered(body)).split(/\r?\n/)) if (line.trim()) add('content', line.trim())
  const raw = privacySections(body, policy, registry),
    annotations = extractSectionAnnotations(raw, policy),
    visible = list => list.filter(item => catalogElementVisible(item, lens, adapter))
  for (const section of visible(buildCatalogSections(raw))) add('sections', section.heading, filtered(section.snippet || ''))
  for (const claim of visible(annotations.claims)) add('claims', claim.text)
  for (const tag of visible(annotations.tags)) add('tags', tag.value)
  for (const link of visible(annotations.links)) add('links', link.value)
  return outputs
}

// A lens outside every registry, so a rule that would reach "any other lens" is always exercised.
const SUB_DOCUMENT_PROBE_LENS = 'custom-lens-probe'

// Compares sub-document delivery before and after across every lens and adapter. Reports the output kind, never text.
function compareSubDocuments(beforeText, afterText, beforeMeta, afterMeta, lenses, adapters, registry, coverageLoss) {
  const hasRules = (text, meta) => CLAIM_MARKER_RE.test(text) || Boolean(meta.field_visibility) || Boolean(meta.field_access)
  if (!hasRules(beforeText, beforeMeta) && !hasRules(afterText, afterMeta)) return null
  for (const lens of [...lenses.map(item => item.id), SUB_DOCUMENT_PROBE_LENS]) {
    for (const adapter of adapters) {
      const before = subDocumentOutputs(beforeText, beforeMeta, lens, adapter, registry),
        after = subDocumentOutputs(afterText, afterMeta, lens, adapter, registry)
      for (const [key, count] of after)
        if (count > (before.get(key) || 0)) return `Sub-document ${key.split('\0')[0]} cell (${lens}, ${adapter}) transited DENY -> ALLOW`
      if ([...before].some(([key, count]) => count > (after.get(key) || 0))) coverageLoss[lens] = (coverageLoss[lens] || 0) + 1
    }
  }
  return null
}

export function verifyNonAmplification(beforeInput, afterInput, options = {}) {
  const registry = options.registry || (options.selfRoot ? loadMigrationRegistry(options.selfRoot) : null)
  const tolerant = options.tolerant ?? true
  const sourceSpaceId = options.sourceSpaceId || 'self'

  // With options.docPath (a canonical document under options.selfRoot), both sides are compared as the catalog would
  // serve them: frontmatter plus inherited _policy.yaml defaults. Without it, inputs are taken as already effective.
  const policyDocPath = sourceSpaceId === 'self' && options.selfRoot && options.docPath ? options.docPath : null
  const beforeState = migrationInspectBefore(beforeInput, {
    registry,
    tolerant,
    selfRoot: options.selfRoot,
    docPath: options.docPath,
    sourceSpaceId
  })
  const beforeExcluded = beforeState.catalogExcluded && !options.confirmActivation
  const beforeMeta = beforeState.effectiveMetadata
  const afterMeta = effectiveMigrationMetadata(normalizeMigrationMetadata(afterInput, registry, tolerant), policyDocPath, options.selfRoot, registry)

  const lenses = collectMigrationLenses(registry, beforeMeta, afterMeta)
  const allLensIds = new Set(lenses.map(l => l.id))
  const accessibleSpaces = sourceSpaceId === 'self' ? ['self', 'contrib'] : ['self', 'contrib', sourceSpaceId]
  const subjects = [
    { kind: 'owner:direct', accessible_spaces: accessibleSpaces },
    { kind: 'client:linked', accessible_spaces: accessibleSpaces, effective_allowed_lenses: allLensIds },
    ...(sourceSpaceId !== 'self'
      ? [
          { kind: 'owner:direct', accessible_spaces: ['self', 'contrib'] },
          { kind: 'client:linked', accessible_spaces: ['self', 'contrib'], effective_allowed_lenses: allLensIds }
        ]
      : [])
  ]
  const adapters = verifyNonAmplification.adapters
  const tasks = [
    null,
    ...(Array.isArray(beforeMeta.task_include) ? beforeMeta.task_include : []),
    ...(Array.isArray(afterMeta.task_include) ? afterMeta.task_include : []),
    ...(Array.isArray(beforeMeta.task_exclude) ? beforeMeta.task_exclude : []),
    ...(Array.isArray(afterMeta.task_exclude) ? afterMeta.task_exclude : [])
  ]
  const coverageLoss = {}

  for (const lensObj of lenses) {
    const lens = lensObj.id
    const defaultSens = Array.isArray(lensObj.sensitivity_access) ? lensObj.sensitivity_access : []
    const resolutions = [
      { sensitivity_access: defaultSens },
      { sensitivity_access: [] },
      { sensitivity_access: CUSTOM_SENSITIVITY_CATEGORIES }
    ]

    for (const a of adapters) {
      let narrowedForAdapter = false
      for (const s of subjects) {
        for (const res of resolutions) {
          for (const task of tasks) {
            const allowedBefore = beforeExcluded ? false : allowedDocument(beforeMeta, lens, a, task, res, s, sourceSpaceId).allowed
            const allowedAfter = allowedDocument(afterMeta, lens, a, task, res, s, sourceSpaceId).allowed

            // Non-amplification: allowedAfter => allowedBefore
            if (allowedAfter && !allowedBefore) {
              return {
                valid: false,
                violation: `Cell (${lens}, ${s.kind}, ${a}) transited DENY -> ALLOW`,
                coverageLoss
              }
            }

            if (allowedBefore && !allowedAfter && s.kind === 'owner:direct') {
              narrowedForAdapter = true
            }
          }
        }
      }
      if (narrowedForAdapter) {
        coverageLoss[lens] = (coverageLoss[lens] || 0) + 1
      }
    }
  }

  const pubBefore = beforeExcluded ? false : publicationAllowed(beforeMeta)
  const pubAfter = publicationAllowed(afterMeta)
  if (pubAfter && !pubBefore) {
    return {
      valid: false,
      violation: 'Publication gate transited DENY -> ALLOW',
      coverageLoss
    }
  }

  // Sub-document rules are compared when the document text is available. Metadata-only callers have no body to compare.
  const beforeText = options.beforeText ?? (typeof beforeInput === 'string' ? beforeInput : null),
    afterText = options.afterText ?? (typeof afterInput === 'string' ? afterInput : null)
  if (beforeText !== null && afterText !== null && !beforeExcluded) {
    const violation = compareSubDocuments(beforeText, afterText, beforeMeta, afterMeta, lenses, adapters, registry, coverageLoss)
    if (violation) return { valid: false, violation, coverageLoss }
  }

  return { valid: true, violation: null, coverageLoss }
}
verifyNonAmplification.adapters = VERIFY_NON_AMPLIFICATION_ADAPTERS

export function validateMigrationPlanSchema(plan) {
  const errors = []
  if (!plan || typeof plan !== 'object') return { valid: false, errors: ['plan must be an object'] }
  if (plan.schema_version !== 1) errors.push('schema_version must be 1')
  if (typeof plan.plan_id !== 'string' || !HASH_RE.test(plan.plan_id)) errors.push('plan_id must be a 64-hex string')
  if (typeof plan.generated_at !== 'string') errors.push('generated_at must be string')
  if (typeof plan.self_root !== 'string') errors.push('self_root must be string')
  if (typeof plan.include_linked !== 'boolean') errors.push('include_linked must be boolean')
  if (!Array.isArray(plan.entries)) errors.push('entries must be an array')
  if (plan.activations !== undefined && !Array.isArray(plan.activations)) errors.push('activations must be an array')
  if (plan.confirm_activation !== undefined && typeof plan.confirm_activation !== 'boolean') errors.push('confirm_activation must be boolean')
  if (!plan.summary || typeof plan.summary !== 'object') errors.push('summary must be an object')
  return { valid: errors.length === 0, errors }
}

export function validateMigrationReceiptSchema(receipt) {
  const errors = []
  if (!receipt || typeof receipt !== 'object') return { valid: false, errors: ['receipt must be an object'] }
  if (receipt.schema_version !== 1) errors.push('schema_version must be 1')
  if (typeof receipt.receipt_id !== 'string' || !HASH_RE.test(receipt.receipt_id)) errors.push('receipt_id must be a 64-hex string')
  if (typeof receipt.plan_id !== 'string' || !HASH_RE.test(receipt.plan_id)) errors.push('plan_id must be a 64-hex string')
  if (!['applied', 'reverted', 'partially-reverted'].includes(receipt.status)) errors.push('status must be applied, reverted, or partially-reverted')
  if (typeof receipt.applied_at !== 'string') errors.push('applied_at must be string')
  if (!Array.isArray(receipt.entries)) errors.push('entries must be an array')
  return { valid: errors.length === 0, errors }
}

export function planPolicyMigration(selfRoot, options = {}) {
  const migrationsDir = join(selfRoot, '.holoself', 'migrations')
  if (!options.dryRun && !existsSync(migrationsDir)) mkdirSync(migrationsDir, { recursive: true })

  const filesToScan = []
  // Discover self files
  for (const folder of ['profile', 'context', 'history', 'topics']) {
    const d = join(selfRoot, folder)
    if (!existsSync(d)) continue
    const walk = dir => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name)
        if (e.isSymbolicLink()) throw new Error(`symlink forbidden in self root: ${full}`)
        if (e.isDirectory()) walk(full)
        else if (e.isFile() && e.name.endsWith('.md')) {
          filesToScan.push({ absPath: full, relPath: slash(relative(selfRoot, full)), spaceId: 'self', kind: 'self' })
        }
      }
    }
    walk(d)
  }

  // If includeLinked:
  if (options.includeLinked) {
    const regPath = join(selfRoot, '.holoself', 'links.json')
    if (existsSync(regPath)) {
      try {
        const reg = JSON.parse(readFileSync(regPath, 'utf8'))
        for (const l of reg.links || []) {
          if (l.status === 'active' && l.project_path && existsSync(l.project_path)) {
            const pPath = l.project_path
            const walkProj = dir => {
              for (const e of readdirSync(dir, { withFileTypes: true })) {
                const full = join(dir, e.name)
                if (e.isSymbolicLink()) throw new Error(`symlink forbidden in linked project: ${full}`)
                if (e.isDirectory()) {
                  if (['node_modules', '.git', '.holoself'].includes(e.name)) continue
                  walkProj(full)
                } else if (e.isFile() && e.name.endsWith('.md')) {
                  filesToScan.push({ absPath: full, relPath: slash(relative(pPath, full)), spaceId: l.project_id, kind: 'project' })
                }
              }
            }
            walkProj(pPath)
          }
        }
      } catch {}
    }
  }

  const registry = options.registry || loadMigrationRegistry(selfRoot)
  const confirmActivation = Boolean(options.confirmActivation)
  const entries = []
  const activations = []
  const warnings = []
  const coverageLossSummary = {}
  let totalScanned = 0

  for (const item of filesToScan) {
    totalScanned++
    if (lstatSync(item.absPath).isSymbolicLink()) throw new Error(`symlink rejected: ${item.absPath}`)
    const bytes = readFileSync(item.absPath),
      text = bytes.toString('utf8')
    // Text that is not valid UTF-8 would be rewritten with replacement characters, so the file stays out of the plan.
    if (!Buffer.from(text, 'utf8').equals(bytes)) {
      warnings.push(`${item.relPath}: not valid UTF-8; left out of the migration, convert it by hand`)
      continue
    }
    if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) {
      // No frontmatter to migrate, but the runtime still reads its claim markers.
      const { changes, warnings: markerWarnings } = subDocumentMigration(text, {}, text, { registry, target: item.relPath })
      warnings.push(...markerWarnings.map(warning => `${item.relPath}: ${warning}`))
      if (!changes.claim_markers) continue
      const afterText = applyMigrationChanges(text, changes)
      const nonAmp = verifyNonAmplification(text, afterText, {
        registry,
        selfRoot,
        docPath: item.kind === 'self' ? item.absPath : null,
        sourceSpaceId: item.spaceId,
        confirmActivation: true
      })
      if (!nonAmp.valid) {
        const err = new Error(`Non-amplification gate failed for ${item.relPath}: ${nonAmp.violation}`)
        err.code = 'NON_AMPLIFICATION_VIOLATION'
        throw err
      }
      for (const [lens, count] of Object.entries(nonAmp.coverageLoss)) coverageLossSummary[lens] = (coverageLossSummary[lens] || 0) + count
      entries.push({
        path: item.relPath,
        space_id: item.spaceId,
        before_sha256: hash(text),
        after_sha256: hash(afterText),
        needs_migration: true,
        changes,
        before_metadata: {},
        after_metadata: {},
        before_text: text,
        after_text: afterText
      })
      continue
    }

    if (fieldRulesUnreadable(text, registry)) {
      warnings.push(`${item.relPath}: frontmatter does not parse and carries field_visibility or field_access; left out of the migration, fix it by hand`)
      continue
    }

    const beforeState = migrationInspectBefore(text, {
      registry,
      tolerant: true,
      selfRoot,
      docPath: item.kind === 'self' ? item.absPath : null,
      sourceSpaceId: item.spaceId
    })
    const rawParsed = frontmatter(text, { tolerant: true, validatePrivacy: false, registry })
    const rawMeta = rawParsed.metadata
    // Parse exactly as the catalog does (src/catalog/source.mjs), then layer inherited _policy.yaml defaults onto
    // canonical (self) documents, so BEFORE is the effective metadata the runtime actually serves from.
    const parsed = frontmatter(text, { tolerant: true, registry })
    const effectiveOf = meta => effectiveMigrationMetadata(meta, item.kind === 'self' ? item.absPath : null, selfRoot, registry)
    const resolvedPolicy = item.kind === 'self' ? resolveDocumentPolicy(item.absPath, selfRoot, parsed.metadata, registry) : null
    const beforeEffective = resolvedPolicy ? resolvedPolicy.effectiveMetadata : parsed.metadata
    const wasRestricted =
      parsed.warnings.some(w => w.includes('restricted')) ||
      privacyMetadataErrors(rawMeta, registry).length > 0 ||
      (rawMeta.visibility === 'public-safe' && rawMeta.public_safe === false) ||
      ((rawMeta.sensitivity === 'restricted' || rawMeta.read_scope === 'restricted') &&
        Array.isArray(rawMeta.access_lenses) &&
        rawMeta.access_lenses.some(lens => lens !== 'private'))
    const governedByDirectoryPolicy = Boolean(
      resolvedPolicy &&
        !wasRestricted &&
        !beforeState.catalogExcluded &&
        !Object.hasOwn(rawMeta, 'visibility') &&
        !Object.hasOwn(rawMeta, 'public_safe') &&
        !Object.hasOwn(rawMeta, 'access_lenses') &&
        Array.isArray(resolvedPolicy.policyDefaults.access_lenses) &&
        resolvedPolicy.policyDefaults.access_lenses.length > 0
    )
    const meetMeta = governedByDirectoryPolicy
      ? beforeEffective
      : beforeState.catalogExcluded
        ? computeActivationMetadata(beforeEffective, item.kind, registry)
        : computeMeetMetadata(beforeEffective, item.kind, registry)

    // Ungoverned documents are migrated to the exact target fields (all four required canonical fields plus
    // read_scope, so no required field is left to inheritance) and lose their deprecated fields in the same edit.
    // Catalog-excluded documents get the same changes but go through the activation review below.
    const proposedChanges = governedByDirectoryPolicy ? {} : migrationChanges(rawMeta, meetMeta)
    // Field rules and claim markers are rewritten in the same edit, whatever governs the document's own fields.
    const subDocument = subDocumentMigration(text, rawMeta, parsed.body, { registry, target: item.relPath })
    Object.assign(proposedChanges, subDocument.changes)
    if (subDocument.keepFieldVisibility) delete proposedChanges.field_visibility
    warnings.push(...subDocument.warnings.map(warning => `${item.relPath}: ${warning}`))

    const beforeSha256 = hash(text)

    // Catalog-excluded documents are denied everywhere before migration: migrating them to valid canonical metadata
    // would newly expose them ('activations'). They are skipped by default with a warning and applied only with
    // --confirm-activation.
    if (beforeState.catalogExcluded && Object.keys(proposedChanges).length > 0) {
      const proposedAfterText = applyMigrationChanges(text, proposedChanges)
      const proposedAfterSha256 = hash(proposedAfterText)
      const proposedAfterParsed = frontmatter(proposedAfterText, { tolerant: true, registry })
      const proposedAfterEffective = effectiveOf(proposedAfterParsed.metadata)

      const baselineNonAmp = verifyNonAmplification(beforeEffective, proposedAfterEffective, {
        registry,
        sourceSpaceId: item.spaceId,
        confirmActivation: true,
        beforeText: text,
        afterText: proposedAfterText
      })
      if (!baselineNonAmp.valid) {
        const err = new Error(`Non-amplification gate failed for ${item.relPath}: ${baselineNonAmp.violation}`)
        err.code = 'NON_AMPLIFICATION_VIOLATION'
        throw err
      }

      const reach = migrationActivationReach(proposedAfterEffective, {
        registry,
        sourceSpaceId: item.spaceId,
        beforeMeta: beforeEffective
      })
      const warningMsg = `${item.relPath}: ${MIGRATION_ACTIVATION_SKIP_WARNING} (lenses: ${reach.lenses.join(', ') || 'none'}; adapters: ${reach.adapters.join(', ') || 'none'})`

      activations.push({
        path: item.relPath,
        space_id: item.spaceId,
        before_sha256: beforeSha256,
        after_sha256: proposedAfterSha256,
        lenses: reach.lenses,
        adapters: reach.adapters,
        publication_allowed: reach.publicationAllowed,
        exclusion_errors: beforeState.exclusionErrors,
        changes: proposedChanges,
        before_text: text,
        after_text: proposedAfterText,
        skipped: !confirmActivation,
        ...(confirmActivation ? {} : { warning: warningMsg })
      })

      if (!confirmActivation) {
        warnings.push(warningMsg)
        entries.push({
          path: item.relPath,
          space_id: item.spaceId,
          before_sha256: beforeSha256,
          after_sha256: beforeSha256,
          needs_migration: false,
          activation_skipped: true,
          changes: {},
          before_metadata: beforeEffective,
          after_metadata: beforeEffective,
          before_text: text,
          after_text: text
        })
        continue
      }

      for (const [lens, count] of Object.entries(baselineNonAmp.coverageLoss)) {
        coverageLossSummary[lens] = (coverageLossSummary[lens] || 0) + count
      }

      entries.push({
        path: item.relPath,
        space_id: item.spaceId,
        before_sha256: beforeSha256,
        after_sha256: proposedAfterSha256,
        needs_migration: true,
        activated: true,
        changes: proposedChanges,
        before_metadata: beforeEffective,
        after_metadata: proposedAfterEffective,
        before_text: text,
        after_text: proposedAfterText
      })
      continue
    }

    const changes = proposedChanges
    const needsMigration = Object.keys(changes).length > 0
    let afterText = text
    let afterSha256 = beforeSha256
    let afterEffective = beforeEffective

    if (needsMigration) {
      afterText = applyMigrationChanges(text, changes)
      afterSha256 = hash(afterText)
      const afterParsed = frontmatter(afterText, { tolerant: true, registry })
      // AFTER is resolved with inheritance too: an edit that turns policy inheritance on (or off) is judged on the
      // metadata the catalog would really use.
      afterEffective = effectiveOf(afterParsed.metadata)

      const nonAmp = verifyNonAmplification(text, afterText, {
        registry,
        selfRoot,
        docPath: item.kind === 'self' ? item.absPath : null,
        sourceSpaceId: item.spaceId
      })
      if (!nonAmp.valid) {
        const err = new Error(`Non-amplification gate failed for ${item.relPath}: ${nonAmp.violation}`)
        err.code = 'NON_AMPLIFICATION_VIOLATION'
        throw err
      }

      for (const [lens, count] of Object.entries(nonAmp.coverageLoss)) {
        coverageLossSummary[lens] = (coverageLossSummary[lens] || 0) + count
      }
    }

    entries.push({
      path: item.relPath,
      space_id: item.spaceId,
      before_sha256: beforeSha256,
      after_sha256: afterSha256,
      needs_migration: needsMigration,
      changes,
      before_metadata: beforeEffective,
      after_metadata: needsMigration ? afterEffective : meetMeta,
      before_text: text,
      after_text: afterText
    })
  }

  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  activations.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  const planId = computeMigrationPlanDigest(entries, confirmActivation, activations)

  const plan = {
    schema_version: 1,
    plan_id: planId,
    generated_at: new Date().toISOString(),
    self_root: selfRoot,
    include_linked: Boolean(options.includeLinked),
    confirm_activation: confirmActivation,
    activations,
    warnings,
    entries,
    summary: {
      total_scanned: totalScanned,
      modified_files: entries.filter(e => e.needs_migration).length,
      unmodified_files: entries.filter(e => !e.needs_migration).length,
      coverage_loss: coverageLossSummary,
      non_amplification_verified: true
    }
  }

  const planPath = join(migrationsDir, `plan-${planId}.json`)
  if (!options.dryRun) writeFileSync(planPath, JSON.stringify(plan, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })

  return plan
}

// What a plan rewrites below document level, for the dry-run report.
export function subDocumentRewrites(plan) {
  return plan.entries
    .concat(plan.activations || [])
    .filter(entry => entry.changes?.field_access || entry.changes?.claim_markers)
    .map(entry => ({
      path: entry.path,
      space_id: entry.space_id,
      ...(entry.changes.field_access ? { field_access: entry.changes.field_access } : {}),
      ...(entry.changes.claim_markers ? { claim_markers: entry.changes.claim_markers.map(({ claim_id, before, after }) => ({ claim_id, before, after })) } : {})
    }))
}

function ruleText(rule) {
  const lenses = rule.access_lenses ? `access_lenses: [${rule.access_lenses.join(', ')}], ` : ''
  return `{ ${lenses}disclosure: ${rule.disclosure} }`
}
function fileMappings(entry) {
  const { changes } = entry,
    meta = frontmatter(entry.before_text, { tolerant: true, validatePrivacy: false }).metadata,
    mappings = [],
    legacy = ['visibility', 'public_safe'].filter(key => changes[key] === null)
  if (legacy.length)
    mappings.push({
      field: legacy.join(', '),
      from: legacy.map(key => `${key}: ${meta[key]}`).join(', '),
      to: MIGRATION_REQUIRED_FIELDS.filter(key => changes[key] !== undefined)
        .map(key => `${key}: ${Array.isArray(changes[key]) ? `[${changes[key].join(', ')}]` : changes[key]}`)
        .join(', ') || 'kept explicit fields'
    })
  const fieldVisibility = meta.field_visibility && typeof meta.field_visibility === 'object' ? meta.field_visibility : {}
  for (const [name, rule] of Object.entries(changes.field_access || {}))
    if (Object.hasOwn(fieldVisibility, name))
      mappings.push({ field: `field_visibility.${name}`, from: String(fieldVisibility[name]), to: `field_access.${name}: ${ruleText(rule)}` })
  for (const marker of changes.claim_markers || []) mappings.push({ field: `claim ${marker.claim_id}`, from: marker.before, to: marker.after })
  return mappings
}
// The exact mapping for every document carrying deprecated fields, taken from a dry-run plan so that `validate --fix`
// reports what `migrate policy` would write. It reads and writes nothing else.
export function deprecatedFieldMappings(selfRoot, options = {}) {
  const handoff = 'holoself migrate policy --dry-run'
  let plan
  try {
    plan = planPolicyMigration(selfRoot, { ...options, dryRun: true })
  } catch (error) {
    return { files: [], warnings: [], handoff, error: redactRootPaths(error.message, [selfRoot]) }
  }
  const files = plan.entries
    .map(entry => plan.activations.find(item => entry.activation_skipped && item.path === entry.path && item.space_id === entry.space_id) || entry)
    .filter(entry => Object.keys(entry.changes).length)
    .map(entry => ({ path: entry.path, space_id: entry.space_id, needs_activation: Boolean(entry.skipped), mappings: fileMappings(entry) }))
    .filter(file => file.mappings.length)
  return { files, warnings: plan.warnings, handoff }
}
export function formatDeprecatedFieldMappings(report) {
  if (!report.files.length && !report.warnings?.length) return ''
  const lines = ['Deprecated privacy fields (validate --fix does not migrate these; it only repairs invalid values, narrowing only):']
  for (const file of report.files) {
    lines.push(`  File: ${file.path}${file.needs_activation ? ' (needs --confirm-activation)' : ''}`)
    for (const mapping of file.mappings) lines.push(`    - ${mapping.field}: ${mapping.from} -> ${mapping.to}`)
  }
  for (const warning of report.warnings || []) lines.push(`  [warn] ${warning}`)
  lines.push(`Next: ${report.handoff}`)
  return lines.join('\n')
}

export function applyPolicyMigration(selfRoot, planInput, options = {}) {
  const migrationsDir = join(selfRoot, '.holoself', 'migrations')
  let plan = null
  if (typeof planInput === 'object' && planInput !== null) {
    plan = planInput
  } else {
    let target = planInput
    if (!existsSync(target)) {
      target = join(migrationsDir, `plan-${planInput}.json`)
    }
    if (!existsSync(target)) throw new Error(`migration plan file not found: ${planInput}`)
    plan = JSON.parse(readFileSync(target, 'utf8'))
  }

  const val = validateMigrationPlanSchema(plan)
  if (!val.valid) throw new Error(`migration plan schema invalid: ${val.errors.join('; ')}`)

  const computedId = computeMigrationPlanDigest(plan.entries, Boolean(plan.confirm_activation), plan.activations || [])
  if (computedId !== plan.plan_id) throw new Error('migration plan digest mismatch')

  const hasCoverageLoss = Object.keys(plan.summary.coverage_loss || {}).length > 0
  if (hasCoverageLoss && !options.confirmNarrowing) {
    const err = new Error('migration plan includes coverage loss (narrowing); review coverage report and re-run with --confirm-narrowing')
    err.code = 'NARROWING_CONFIRMATION_REQUIRED'
    throw err
  }

  const activationConfirmed = Boolean(options.confirmActivation || plan.confirm_activation)
  const activationsByKey = new Map(
    (plan.activations || []).map(a => [`${a.space_id}:${a.path}`, a])
  )

  // Every entry is checked before the first write, so a stale plan changes nothing.
  const pending = []
  for (const entry of plan.entries) {
    let effectiveEntry = entry
    if (!entry.needs_migration && entry.activation_skipped && activationConfirmed) {
      const act = activationsByKey.get(`${entry.space_id}:${entry.path}`)
      if (act) {
        effectiveEntry = {
          ...entry,
          needs_migration: true,
          activated: true,
          changes: act.changes,
          after_sha256: act.after_sha256,
          before_text: act.before_text || entry.before_text,
          after_text: act.after_text
        }
      }
    }
    if (!effectiveEntry.needs_migration) continue
    if (effectiveEntry.activated && !activationConfirmed) continue

    let absPath = join(selfRoot, effectiveEntry.path)
    if (effectiveEntry.space_id !== 'self') {
      const regPath = join(selfRoot, '.holoself', 'links.json')
      const reg = JSON.parse(readFileSync(regPath, 'utf8'))
      const foundLink = reg.links.find(l => l.project_id === effectiveEntry.space_id)
      if (!foundLink) throw new Error(`linked space ${effectiveEntry.space_id} not found in links.json`)
      absPath = join(foundLink.project_path, effectiveEntry.path)
    }

    if (lstatSync(absPath).isSymbolicLink()) throw new Error(`symlink detected at ${absPath}`)

    // Anti-TOCTOU, on bytes: two files can decode to the same text.
    const s0 = statSync(absPath)
    const before = readFileSync(absPath)
    const s1 = statSync(absPath)
    if (s0.mtimeMs !== s1.mtimeMs || hash(before) !== effectiveEntry.before_sha256) {
      throw new Error(`TOCTOU violation: ${effectiveEntry.path} modified concurrently. Migration aborted fail-closed.`)
    }

    const modifiedText = applyMigrationChanges(before.toString('utf8'), effectiveEntry.changes)
    if (hash(modifiedText) !== effectiveEntry.after_sha256) {
      throw new Error(`Digest mismatch after frontmatter modification for ${effectiveEntry.path}`)
    }
    pending.push({ entry: effectiveEntry, absPath, before, modifiedText })
  }

  const written = []
  try {
    for (const item of pending) {
      if (!readFileSync(item.absPath).equals(item.before)) throw new Error(`TOCTOU violation: ${item.entry.path} modified concurrently.`)
      atomicWrite(item.absPath, item.modifiedText, 0o600)
      written.push(item)
    }
    const receiptEntries = pending.map(({ entry, before, modifiedText }) => ({
      path: entry.path,
      space_id: entry.space_id,
      before_sha256: entry.before_sha256,
      after_sha256: entry.after_sha256,
      before_base64: before.toString('base64'),
      after_text: modifiedText,
      status: 'applied',
      ...(entry.activated ? { activated: true } : {})
    }))
    const receipt = {
      schema_version: 1,
      receipt_id: plan.plan_id,
      plan_id: plan.plan_id,
      status: 'applied',
      applied_at: new Date().toISOString(),
      reverted_at: null,
      narrowing_confirmed: Boolean(options.confirmNarrowing),
      activation_confirmed: activationConfirmed,
      applied_entries_digest: hash(JSON.stringify(receiptEntries.map(e => [e.path, e.space_id, e.before_sha256, e.after_sha256]))),
      entries: receiptEntries
    }
    atomicWrite(join(migrationsDir, `receipt-${plan.plan_id}.json`), JSON.stringify(receipt, null, 2) + '\n', 0o600)
    return receipt
  } catch (error) {
    const unrestored = []
    for (const item of written.reverse()) {
      try {
        atomicWrite(item.absPath, item.before, 0o600)
      } catch {
        unrestored.push(item.entry.path)
      }
    }
    if (unrestored.length) throw new Error(`migration failed and these files could not be restored: ${unrestored.join(', ')}. Cause: ${error.message}`, { cause: error })
    throw new Error(`migration failed and was rolled back; no file changed. Cause: ${error.message}`, { cause: error })
  }
}

export function revertPolicyMigration(selfRoot, receiptInput, options = {}) {
  const migrationsDir = join(selfRoot, '.holoself', 'migrations')
  let receipt = null
  let receiptPath = null
  if (typeof receiptInput === 'object' && receiptInput !== null) {
    receipt = receiptInput
    receiptPath = join(migrationsDir, `receipt-${receipt.receipt_id}.json`)
  } else {
    receiptPath = receiptInput
    if (!existsSync(receiptPath)) {
      receiptPath = join(migrationsDir, `receipt-${receiptInput}.json`)
    }
    if (!existsSync(receiptPath)) throw new Error(`migration receipt file not found: ${receiptInput}`)
    receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
  }

  const val = validateMigrationReceiptSchema(receipt)
  if (!val.valid) throw new Error(`migration receipt schema invalid: ${val.errors.join('; ')}`)

  if (receipt.applied_entries_digest) {
    const computedDigest = hash(JSON.stringify(receipt.entries.map(e => [e.path, e.space_id, e.before_sha256, e.after_sha256])))
    if (computedDigest !== receipt.applied_entries_digest) {
      throw new Error(`Migration receipt integrity failure: entries have been tampered or corrupted`)
    }
  }

  let anyModified = false
  for (const entry of receipt.entries) {
    if (entry.status !== 'applied') continue
    let absPath = join(selfRoot, entry.path)
    if (entry.space_id !== 'self') {
      const regPath = join(selfRoot, '.holoself', 'links.json')
      const reg = JSON.parse(readFileSync(regPath, 'utf8'))
      const foundLink = reg.links.find(l => l.project_id === entry.space_id)
      if (!foundLink) throw new Error(`linked space ${entry.space_id} not found in links.json`)
      absPath = join(foundLink.project_path, entry.path)
    }
    if (hash(readFileSync(absPath)) !== entry.after_sha256) {
      anyModified = true
      if (!options.allowPartial) {
        throw new Error(`File ${entry.path} was modified after migration. Revert aborted. Use --allow-partial to revert unmodified files.`)
      }
    }
  }

  let revertedCount = 0
  let skippedCount = 0
  for (const entry of receipt.entries) {
    if (entry.status !== 'applied') continue
    let absPath = join(selfRoot, entry.path)
    if (entry.space_id !== 'self') {
      const regPath = join(selfRoot, '.holoself', 'links.json')
      const reg = JSON.parse(readFileSync(regPath, 'utf8'))
      const foundLink = reg.links.find(l => l.project_id === entry.space_id)
      absPath = join(foundLink.project_path, entry.path)
    }
    if (hash(readFileSync(absPath)) !== entry.after_sha256) {
      entry.status = 'skipped'
      skippedCount++
      continue
    }

    // Receipts written before 0.12.0 keep the prior content as text.
    const prior = entry.before_base64 === undefined ? entry.before_text : Buffer.from(entry.before_base64, 'base64')
    if (prior) {
      atomicWrite(absPath, prior, 0o600)
      entry.status = 'reverted'
      revertedCount++
    }
  }

  receipt.status = skippedCount > 0 ? (revertedCount > 0 ? 'partially-reverted' : 'applied') : 'reverted'
  receipt.reverted_at = new Date().toISOString()

  atomicWrite(receiptPath, JSON.stringify(receipt, null, 2) + '\n', 0o600)

  return receipt
}
