import { existsSync, lstatSync, statSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { DISCLOSURES } from './annotations.mjs'
import { canonicalJson } from './catalog.mjs'
import { HASH_RE } from './catalog/schema.mjs'
import { CUSTOM_SENSITIVITY_CATEGORIES, DEFAULT_LENSES, DEFAULT_LENS_IDS, lensIdStructurallyValid, loadLensRegistry } from './lenses.mjs'
import { allowedDocument, publicationAllowed } from './policy/access.mjs'
import { frontmatter, privacyMetadataErrors, restrictPrivacyMetadata } from './policy/privacy-fields.mjs'
import { atomicWrite, hash, slash } from './shared/fs.mjs'

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

export function computeMeetMetadata(meta, kind = 'self', registry = null) {
  const raw = meta && typeof meta === 'object' ? meta : {}
  const defined = {}
  for (const [k, v] of Object.entries(raw)) {
    if (v !== undefined) defined[k] = Array.isArray(v) ? [...v] : v
  }

  const errors = privacyMetadataErrors(defined, registry)
  if (errors.length > 0) {
    return restrictPrivacyMetadata({ ...defined })
  }

  const result = { ...defined }
  const vis = defined.visibility || 'private'

  // read_scope
  if (!['shared', 'local', 'restricted'].includes(defined.read_scope)) {
    result.read_scope = vis === 'private' ? 'restricted' : 'shared'
  }

  // access_lenses
  if (!Array.isArray(defined.access_lenses)) {
    if (kind === 'self') {
      if (vis === 'private') {
        result.access_lenses = ['private']
      } else if (vis === 'linked-projects') {
        result.access_lenses = ['general', 'professional', 'public-voice', 'technical', 'leadership', 'interview', 'private']
      } else if (vis === 'professional') {
        result.access_lenses = ['general', 'professional', 'interview', 'private']
      } else if (vis === 'public-voice' || vis === 'public-safe') {
        result.access_lenses = ['general', 'public-voice', 'private']
      } else {
        result.access_lenses = ['general', 'private']
      }
    } else {
      if (vis === 'private') {
        result.access_lenses = ['private']
      } else if (vis === 'linked-projects') {
        result.access_lenses = ['general', 'technical']
      } else if (vis === 'public-safe') {
        result.access_lenses = ['general', 'public-voice']
      } else {
        result.access_lenses = ['general']
      }
    }
  }

  // disclosure
  if (defined.public_safe === false) {
    result.disclosure = defined.disclosure === 'internal-only' ? 'internal-only' : 'review-required'
  } else if (!DISCLOSURES.includes(defined.disclosure)) {
    result.disclosure =
      defined.public_safe === true || vis === 'public-safe' || defined.publication_allowed ? 'publish-approved' : 'internal-only'
  }

  // sensitivity
  if (!defined.sensitivity) {
    result.sensitivity = 'personal'
  }

  // document_role
  if (!defined.document_role) {
    result.document_role = 'content'
  }

  return result
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
    const keyRegex = new RegExp(`^(\\s*)${key}\\s*:`, 'i')
    const existingLineIdx = lines.findIndex(l => keyRegex.test(l))
    let formattedVal = ''
    if (Array.isArray(value)) {
      formattedVal = `[${value.join(', ')}]`
    } else {
      formattedVal = String(value)
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

export function verifyNonAmplification(beforeInput, afterInput, options = {}) {
  const registry = options.registry || (options.selfRoot ? loadMigrationRegistry(options.selfRoot) : null)
  const tolerant = options.tolerant ?? true
  const sourceSpaceId = options.sourceSpaceId || 'self'

  const beforeMeta = normalizeMigrationMetadata(beforeInput, registry, tolerant)
  const afterMeta = normalizeMigrationMetadata(afterInput, registry, tolerant)

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
  const adapters = ['generic', 'public', 'obsidian-public', 'restricted-host']
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
    const parsed = frontmatter(text, { tolerant: true, registry })
    const wasRestricted = parsed.warnings.some(w => w.includes('restricted')) || privacyMetadataErrors(rawMeta, registry).length > 0
    const meetMeta = computeMeetMetadata(parsed.metadata, item.kind, registry)

    const changes = {}
    if (rawMeta.read_scope !== meetMeta.read_scope) changes.read_scope = meetMeta.read_scope
    const beforeAccess = Array.isArray(rawMeta.access_lenses) ? rawMeta.access_lenses : null
    if (!beforeAccess || JSON.stringify(beforeAccess) !== JSON.stringify(meetMeta.access_lenses)) {
      changes.access_lenses = meetMeta.access_lenses
    }
    if (wasRestricted) {
      if (rawMeta.visibility !== undefined && rawMeta.visibility !== meetMeta.visibility) changes.visibility = meetMeta.visibility
      if (rawMeta.disclosure !== undefined && rawMeta.disclosure !== meetMeta.disclosure) changes.disclosure = meetMeta.disclosure
      if (rawMeta.public_safe !== undefined && rawMeta.public_safe !== meetMeta.public_safe) changes.public_safe = meetMeta.public_safe
      if (rawMeta.sensitivity !== undefined && rawMeta.sensitivity !== meetMeta.sensitivity) changes.sensitivity = meetMeta.sensitivity
      if (rawMeta.document_role !== undefined && rawMeta.document_role !== meetMeta.document_role) changes.document_role = meetMeta.document_role
    }

    const beforeSha256 = hash(text)
    const needsMigration = Object.keys(changes).length > 0
    let afterText = text
    let afterSha256 = beforeSha256

    if (needsMigration) {
      afterText = applyFrontmatterModifications(text, changes)
      afterSha256 = hash(afterText)
      const afterParsed = frontmatter(afterText, { tolerant: true, registry })

      const nonAmp = verifyNonAmplification(parsed.metadata, afterParsed.metadata, {
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
      before_metadata: parsed.metadata,
      after_metadata: meetMeta,
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
