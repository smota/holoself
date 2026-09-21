import {
  existsSync, lstatSync, statSync, readFileSync, writeFileSync, mkdirSync,
  readdirSync, renameSync, unlinkSync
} from 'node:fs'
import { join, resolve, relative, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { BUILTIN_LENS_IDS } from './lenses.mjs'

const ALL_LENSES = BUILTIN_LENS_IDS
const HASH_RE = /^[0-9a-f]{64}$/

function hash(text) {
  return createHash('sha256').update(text).digest('hex')
}

function canonicalJson(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj)
  if (Array.isArray(obj)) return `[${obj.map(canonicalJson).join(',')}]`
  const sortedKeys = Object.keys(obj).sort()
  return `{${sortedKeys.map(k => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`
}

function slash(p) {
  return p.replaceAll('\\', '/')
}

export function computeMeetMetadata(meta, kind = 'self') {
  const result = { ...meta }
  const vis = meta.visibility || 'private'

  // read_scope
  if (!['shared', 'local', 'restricted'].includes(meta.read_scope)) {
    result.read_scope = vis === 'private' ? 'restricted' : 'shared'
  }

  // access_lenses
  if (!Array.isArray(meta.access_lenses) || !meta.access_lenses.length) {
    if (kind === 'self') {
      if (vis === 'private') {
        result.access_lenses = ['private']
      } else if (vis === 'linked-projects') {
        result.access_lenses = ['general', 'career', 'publishing', 'technical', 'leadership', 'interview', 'private']
      } else if (vis === 'career') {
        result.access_lenses = ['general', 'career', 'interview', 'private']
      } else if (vis === 'publishing' || vis === 'public-safe') {
        result.access_lenses = ['general', 'publishing', 'private']
      } else {
        result.access_lenses = ['general', 'private']
      }
    } else {
      if (vis === 'private') {
        result.access_lenses = ['private']
      } else if (vis === 'linked-projects') {
        result.access_lenses = ['general', 'technical']
      } else if (vis === 'public-safe') {
        result.access_lenses = ['general', 'publishing']
      } else {
        result.access_lenses = ['general']
      }
    }
  }

  // disclosure
  if (!meta.disclosure) {
    result.disclosure = meta.publication_allowed ? 'publish-approved' : 'internal-only'
  }

  // sensitivity
  if (!meta.sensitivity) {
    result.sensitivity = 'personal'
  }

  // document_role
  if (!meta.document_role) {
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

  const frontmatterContent = text.slice(3 + nl.length, endIdx)
  const bodyContent = text.slice(endIdx)

  const lines = frontmatterContent.split(/\r?\n/)
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
      lines[existingLineIdx] = `${match[1]}${key}: ${formattedVal}`
    } else {
      lines.push(`${key}: ${formattedVal}`)
    }
  }

  return `---${nl}${lines.join(nl)}${bodyContent}`
}

function evaluateAllowed(meta, lens, adapter, subjectKind) {
  const readScope = ['shared', 'local', 'restricted'].includes(meta.read_scope)
    ? meta.read_scope
    : (meta.visibility === 'private' ? 'restricted' : 'shared')

  // Phase 1
  if (readScope === 'restricted') {
    if (!(subjectKind === 'owner:direct' && lens === 'private')) {
      return false
    }
  }

  // Phase 2
  if (subjectKind === 'client:linked') {
    if (lens === 'private') return false
  }

  // Phase 3 & 4
  const accessLenses = Array.isArray(meta.access_lenses) && meta.access_lenses.length
    ? meta.access_lenses
    : (meta.visibility === 'private' ? ['private'] : (meta.visibility === 'career' ? ['general', 'career', 'interview', 'private'] : (meta.visibility === 'publishing' ? ['general', 'publishing', 'private'] : ALL_LENSES)))
  if (!accessLenses.includes(lens)) return false
  if (Array.isArray(meta.exclude_lenses) && meta.exclude_lenses.includes(lens)) return false

  // Phase 6
  const sensitivity = meta.sensitivity || ''
  if (sensitivity === 'restricted') {
    if (!(subjectKind === 'owner:direct' && lens === 'private')) return false
  }

  // Phase 7
  if (['public', 'obsidian-public', 'restricted-host'].includes(adapter)) {
    if (!meta.publication_allowed && meta.visibility !== 'public-safe') return false
  }

  return true
}

function evaluateAllowedV1(meta, lens, adapter, subjectKind) {
  if (subjectKind === 'client:linked' && lens === 'private') {
    return false
  }

  const accessLenses = Array.isArray(meta.access_lenses) && meta.access_lenses.length
    ? meta.access_lenses
    : (meta.visibility === 'private' ? ['private'] : (meta.visibility === 'career' ? ['general', 'career', 'interview', 'private'] : (meta.visibility === 'publishing' ? ['general', 'publishing', 'private'] : ALL_LENSES)))
  if (!accessLenses.includes(lens)) return false
  if (Array.isArray(meta.exclude_lenses) && meta.exclude_lenses.includes(lens)) return false

  const sensitivity = meta.sensitivity || ''
  if (sensitivity === 'restricted') {
    if (!(subjectKind === 'owner:direct' && lens === 'private')) return false
  }

  if (['public', 'obsidian-public', 'restricted-host'].includes(adapter)) {
    if (!meta.publication_allowed && meta.visibility !== 'public-safe') return false
  }

  return true
}

export function verifyNonAmplification(beforeMeta, afterMeta) {
  const subjects = ['owner:direct', 'client:linked']
  const adapters = ['generic', 'public']
  const coverageLoss = {}

  for (const lens of ALL_LENSES) {
    for (const s of subjects) {
      for (const a of adapters) {
        const allowedBefore = evaluateAllowedV1(beforeMeta, lens, a, s)
        const allowedAfter = evaluateAllowed(afterMeta, lens, a, s)

        // Non-amplification: allowedAfter => allowedBefore
        if (allowedAfter && !allowedBefore) {
          return {
            valid: false,
            violation: `Cell (${lens}, ${s}, ${a}) transited DENY -> ALLOW`,
            coverageLoss
          }
        }

        if (allowedBefore && !allowedAfter && s === 'owner:direct') {
          coverageLoss[lens] = (coverageLoss[lens] || 0) + 1
        }
      }
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

function parseSimpleFrontmatter(text) {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return { metadata: {}, body: text }
  const nl = text.includes('\r\n') ? '\r\n' : '\n'
  const endIdx = text.indexOf(`${nl}---`, 3)
  if (endIdx < 0) return { metadata: {}, body: text }
  const raw = text.slice(3 + nl.length, endIdx)
  const body = text.slice(endIdx + 3 + nl.length).replace(/^\r?\n/, '')
  const metadata = {}
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const colonIdx = trimmed.indexOf(':')
    if (colonIdx < 0) continue
    const key = trimmed.slice(0, colonIdx).trim()
    let valStr = trimmed.slice(colonIdx + 1).trim()
    if (valStr.startsWith('[') && valStr.endsWith(']')) {
      metadata[key] = valStr.slice(1, -1).split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
    } else {
      valStr = valStr.replace(/^['"]|['"]$/g, '')
      if (valStr === 'true') metadata[key] = true
      else if (valStr === 'false') metadata[key] = false
      else metadata[key] = valStr
    }
  }
  return { metadata, body }
}

function atomicWriteFile(target, content, mode = 0o600) {
  const dir = dirname(target)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`
  try {
    writeFileSync(tmp, content, { encoding: 'utf8', mode })
    renameSync(tmp, target)
  } finally {
    if (existsSync(tmp)) {
      try { unlinkSync(tmp) } catch {}
    }
  }
}

export function planPolicyMigration(selfRoot, options = {}) {
  const migrationsDir = join(selfRoot, '.holoself', 'migrations')
  if (!existsSync(migrationsDir)) mkdirSync(migrationsDir, { recursive: true })

  const filesToScan = []
  // Discover self files
  for (const folder of ['profile', 'context', 'history', 'topics']) {
    const d = join(selfRoot, folder)
    if (!existsSync(d)) continue
    const walk = (dir) => {
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
            const walkProj = (dir) => {
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

  const entries = []
  const coverageLossSummary = {}
  let totalScanned = 0

  for (const item of filesToScan) {
    totalScanned++
    if (lstatSync(item.absPath).isSymbolicLink()) throw new Error(`symlink rejected: ${item.absPath}`)
    const text = readFileSync(item.absPath, 'utf8')
    if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) continue

    const parsed = parseSimpleFrontmatter(text)
    const meetMeta = computeMeetMetadata(parsed.metadata, item.kind)

    const changes = {}
    if (parsed.metadata.read_scope !== meetMeta.read_scope) changes.read_scope = meetMeta.read_scope
    const beforeAccess = Array.isArray(parsed.metadata.access_lenses) ? parsed.metadata.access_lenses : []
    if (JSON.stringify(beforeAccess) !== JSON.stringify(meetMeta.access_lenses)) {
      changes.access_lenses = meetMeta.access_lenses
    }

    const beforeSha256 = hash(text)
    const needsMigration = Object.keys(changes).length > 0
    let afterText = text
    let afterSha256 = beforeSha256

    if (needsMigration) {
      afterText = applyFrontmatterModifications(text, changes)
      afterSha256 = hash(afterText)

      const nonAmp = verifyNonAmplification(parsed.metadata, meetMeta)
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
  writeFileSync(planPath, JSON.stringify(plan, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })

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

    atomicWriteFile(absPath, modifiedText, 0o600)

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
  atomicWriteFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', 0o600)

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
      atomicWriteFile(absPath, entry.before_text, 0o600)
      entry.status = 'reverted'
      revertedCount++
    }
  }

  receipt.status = skippedCount > 0 ? (revertedCount > 0 ? 'partially-reverted' : 'applied') : 'reverted'
  receipt.reverted_at = new Date().toISOString()

  atomicWriteFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', 0o600)

  return receipt
}
