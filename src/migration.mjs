import { existsSync, lstatSync, statSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { canonicalJson } from './catalog.mjs'
import { HASH_RE } from './catalog/schema.mjs'
import { CUSTOM_SENSITIVITY_CATEGORIES, DEFAULT_LENSES, DEFAULT_LENS_IDS, lensIdStructurallyValid, loadLensRegistry } from './lenses.mjs'
import { allowedDocument, disclosure as runtimeDisclosure, legacyAccessLenses, publicationAllowed, PUBLICATION_ADAPTERS, visibility as legacyVisibility } from './policy/access.mjs'
import { resolveDocumentPolicy } from './policy/policy-defaults.mjs'
import { frontmatter, privacyMetadataErrors, restrictPrivacyMetadata } from './policy/privacy-fields.mjs'
import { atomicWrite, hash, slash } from './shared/fs.mjs'

// Fields every migrated document carries explicitly (the four required canonical fields plus read_scope).
const MIGRATION_REQUIRED_FIELDS = Object.freeze(['access_lenses', 'disclosure', 'sensitivity', 'document_role', 'read_scope'])

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

// Deprecated document-level fields (docs/decisions/privacy-fields-and-legacy-mount.md). `migrate policy` removes them
// in the same edit that materializes their exact runtime meaning as target fields. `field_visibility` and claim-marker
// `visibility=` stay until the runtime reads their replacements (`field_access`, lens-vocabulary claim markers).
export const DEPRECATED_DOCUMENT_FIELDS = Object.freeze(['visibility', 'public_safe'])

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

// Frontmatter changes that migrate one document: every target field that differs from its own frontmatter (so
// inherited values are pinned explicitly) plus `null` (removal) for each deprecated field it carries.
export function migrationChanges(rawMeta, meetMeta) {
  const changes = {}
  for (const key of MIGRATION_REQUIRED_FIELDS)
    if (meetMeta[key] !== undefined && JSON.stringify(rawMeta[key]) !== JSON.stringify(meetMeta[key])) changes[key] = meetMeta[key]
  for (const key of DEPRECATED_DOCUMENT_FIELDS) if (Object.hasOwn(rawMeta, key)) changes[key] = null
  return changes
}

export function applyFrontmatterModifications(text, changes) {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) {
    return text
  }
  const isCrlf = text.includes('\r\n')
  const nl = isCrlf ? '\r\n' : '\n'
  const endIdx = text.indexOf(`${nl}---`, 3)
  if (endIdx < 0) return text

  const openLen = 3 + nl.length
  const frontmatterContent = endIdx > openLen ? text.slice(openLen, endIdx) : ''
  const bodyContent = text.slice(endIdx)

  const lines = frontmatterContent ? frontmatterContent.split(/\r?\n/) : []
  for (const [key, value] of Object.entries(changes)) {
    // Top-level keys only: never rewrite a nested key such as field_visibility.visibility.
    const keyRegex = new RegExp(`^()${key}\\s*:`)
    const existingLineIdx = lines.findIndex(l => keyRegex.test(l))
    let formattedVal = ''
    if (Array.isArray(value)) {
      formattedVal = `[${value.join(', ')}]`
    } else {
      formattedVal = String(value)
    }

    if (value === null) {
      // Removal: the key line and any more-indented continuation lines (block lists or nested mappings).
      if (existingLineIdx < 0) continue
      let removeCount = 1
      while (existingLineIdx + removeCount < lines.length) {
        const nextLine = lines[existingLineIdx + removeCount]
        if (!nextLine.trim() || nextLine.length === nextLine.trimStart().length) break
        removeCount++
      }
      lines.splice(existingLineIdx, removeCount)
      continue
    }
    if (existingLineIdx >= 0) {
      const match = lines[existingLineIdx].match(keyRegex)
      const baseIndent = match[1].length
      let removeCount = 1
      while (existingLineIdx + removeCount < lines.length) {
        const nextLine = lines[existingLineIdx + removeCount]
        const trimmed = nextLine.trim()
        if (!trimmed || trimmed.startsWith('#')) break
        const nextIndent = nextLine.length - nextLine.trimStart().length
        if (nextIndent > baseIndent && trimmed.startsWith('-')) {
          removeCount++
        } else {
          break
        }
      }
      lines.splice(existingLineIdx, removeCount, `${match[1]}${key}: ${formattedVal}`)
    } else {
      lines.push(`${key}: ${formattedVal}`)
    }
  }

  return `---${nl}${lines.join(nl)}${bodyContent}`
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

export function verifyNonAmplification(beforeInput, afterInput, options = {}) {
  const registry = options.registry || (options.selfRoot ? loadMigrationRegistry(options.selfRoot) : null)
  const tolerant = options.tolerant ?? true
  const sourceSpaceId = options.sourceSpaceId || 'self'

  // With options.docPath (a canonical document under options.selfRoot), both sides are compared as the catalog would
  // serve them: frontmatter plus inherited _policy.yaml defaults. Without it, inputs are taken as already effective.
  const policyDocPath = sourceSpaceId === 'self' && options.selfRoot && options.docPath ? options.docPath : null
  const beforeMeta = effectiveMigrationMetadata(normalizeMigrationMetadata(beforeInput, registry, tolerant), policyDocPath, options.selfRoot, registry)
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
            const allowedBefore = allowedDocument(beforeMeta, lens, a, task, res, s, sourceSpaceId).allowed
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

  const pubBefore = publicationAllowed(beforeMeta)
  const pubAfter = publicationAllowed(afterMeta)
  if (pubAfter && !pubBefore) {
    return {
      valid: false,
      violation: 'Publication gate transited DENY -> ALLOW',
      coverageLoss
    }
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
  const entries = []
  const coverageLossSummary = {}
  let totalScanned = 0

  for (const item of filesToScan) {
    totalScanned++
    if (lstatSync(item.absPath).isSymbolicLink()) throw new Error(`symlink rejected: ${item.absPath}`)
    const text = readFileSync(item.absPath, 'utf8')
    if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) continue

    const rawParsed = frontmatter(text, { tolerant: true, validatePrivacy: false, registry })
    const rawMeta = rawParsed.metadata
    // Parse exactly as the catalog does (src/catalog/source.mjs), then layer inherited _policy.yaml defaults onto
    // canonical (self) documents, so BEFORE is the effective metadata the runtime actually serves from.
    const parsed = frontmatter(text, { tolerant: true, registry })
    const effectiveOf = meta => effectiveMigrationMetadata(meta, item.kind === 'self' ? item.absPath : null, selfRoot, registry)
    const resolvedPolicy = item.kind === 'self' ? resolveDocumentPolicy(item.absPath, selfRoot, parsed.metadata, registry) : null
    const beforeEffective = resolvedPolicy ? resolvedPolicy.effectiveMetadata : parsed.metadata
    const wasRestricted = parsed.warnings.some(w => w.includes('restricted')) || privacyMetadataErrors(rawMeta, registry).length > 0
    const governedByDirectoryPolicy = Boolean(
      resolvedPolicy &&
        !wasRestricted &&
        !Object.hasOwn(rawMeta, 'visibility') &&
        !Object.hasOwn(rawMeta, 'public_safe') &&
        !Object.hasOwn(rawMeta, 'access_lenses') &&
        Array.isArray(resolvedPolicy.policyDefaults.access_lenses) &&
        resolvedPolicy.policyDefaults.access_lenses.length > 0
    )
    const meetMeta = governedByDirectoryPolicy ? beforeEffective : computeMeetMetadata(beforeEffective, item.kind, registry)

    // Ungoverned documents are migrated to the exact target fields (all four required canonical fields plus
    // read_scope, so no required field is left to inheritance) and lose their deprecated fields in the same edit.
    const changes = governedByDirectoryPolicy ? {} : migrationChanges(rawMeta, meetMeta)

    const beforeSha256 = hash(text)
    const needsMigration = Object.keys(changes).length > 0
    let afterText = text
    let afterSha256 = beforeSha256
    let afterEffective = beforeEffective

    if (needsMigration) {
      afterText = applyFrontmatterModifications(text, changes)
      afterSha256 = hash(afterText)
      const afterParsed = frontmatter(afterText, { tolerant: true, registry })
      // AFTER is resolved with inheritance too: an edit that turns policy inheritance on (or off) is judged on the
      // metadata the catalog would really use.
      afterEffective = effectiveOf(afterParsed.metadata)

      const nonAmp = verifyNonAmplification(beforeEffective, afterEffective, {
        registry,
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

  const entriesDigestInput = entries.map(e => ({
    path: e.path,
    space_id: e.space_id,
    before_sha256: e.before_sha256,
    after_sha256: e.after_sha256,
    needs_migration: e.needs_migration,
    changes: e.changes
  }))
  const planId = hash(canonicalJson(entriesDigestInput))

  const plan = {
    schema_version: 1,
    plan_id: planId,
    generated_at: new Date().toISOString(),
    self_root: selfRoot,
    include_linked: Boolean(options.includeLinked),
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

  const entriesDigestInput = plan.entries.map(e => ({
    path: e.path,
    space_id: e.space_id,
    before_sha256: e.before_sha256,
    after_sha256: e.after_sha256,
    needs_migration: e.needs_migration,
    changes: e.changes
  }))
  const computedId = hash(canonicalJson(entriesDigestInput))
  if (computedId !== plan.plan_id) throw new Error('migration plan digest mismatch')

  const hasCoverageLoss = Object.keys(plan.summary.coverage_loss || {}).length > 0
  if (hasCoverageLoss && !options.confirmNarrowing) {
    const err = new Error('migration plan includes coverage loss (narrowing); review coverage report and re-run with --confirm-narrowing')
    err.code = 'NARROWING_CONFIRMATION_REQUIRED'
    throw err
  }

  const receiptEntries = []
  for (const entry of plan.entries) {
    if (!entry.needs_migration) continue
    let absPath = join(selfRoot, entry.path)
    if (entry.space_id !== 'self') {
      const regPath = join(selfRoot, '.holoself', 'links.json')
      const reg = JSON.parse(readFileSync(regPath, 'utf8'))
      const foundLink = reg.links.find(l => l.project_id === entry.space_id)
      if (!foundLink) throw new Error(`linked space ${entry.space_id} not found in links.json`)
      absPath = join(foundLink.project_path, entry.path)
    }

    if (lstatSync(absPath).isSymbolicLink()) throw new Error(`symlink detected at ${absPath}`)

    // Anti-TOCTOU
    const s0 = statSync(absPath)
    const currentText = readFileSync(absPath, 'utf8')
    const s1 = statSync(absPath)
    if (s0.mtimeMs !== s1.mtimeMs || hash(currentText) !== entry.before_sha256) {
      throw new Error(`TOCTOU violation: ${entry.path} modified concurrently. Migration aborted fail-closed.`)
    }

    const modifiedText = applyFrontmatterModifications(currentText, entry.changes)
    if (hash(modifiedText) !== entry.after_sha256) {
      throw new Error(`Digest mismatch after frontmatter modification for ${entry.path}`)
    }

    atomicWrite(absPath, modifiedText, 0o600)

    receiptEntries.push({
      path: entry.path,
      space_id: entry.space_id,
      before_sha256: entry.before_sha256,
      after_sha256: entry.after_sha256,
      before_text: entry.before_text || currentText,
      after_text: modifiedText,
      status: 'applied'
    })
  }

  const receipt = {
    schema_version: 1,
    receipt_id: plan.plan_id,
    plan_id: plan.plan_id,
    status: 'applied',
    applied_at: new Date().toISOString(),
    reverted_at: null,
    narrowing_confirmed: Boolean(options.confirmNarrowing),
    applied_entries_digest: hash(JSON.stringify(receiptEntries.map(e => [e.path, e.space_id, e.before_sha256, e.after_sha256]))),
    entries: receiptEntries
  }

  const receiptPath = join(migrationsDir, `receipt-${plan.plan_id}.json`)
  atomicWrite(receiptPath, JSON.stringify(receipt, null, 2) + '\n', 0o600)

  return receipt
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
    const currentText = readFileSync(absPath, 'utf8')
    if (hash(currentText) !== entry.after_sha256) {
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
    const currentText = readFileSync(absPath, 'utf8')
    if (hash(currentText) !== entry.after_sha256) {
      entry.status = 'skipped'
      skippedCount++
      continue
    }

    if (entry.before_text) {
      atomicWrite(absPath, entry.before_text, 0o600)
      entry.status = 'reverted'
      revertedCount++
    }
  }

  receipt.status = skippedCount > 0 ? (revertedCount > 0 ? 'partially-reverted' : 'applied') : 'reverted'
  receipt.reverted_at = new Date().toISOString()

  atomicWrite(receiptPath, JSON.stringify(receipt, null, 2) + '\n', 0o600)

  return receipt
}
