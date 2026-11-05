// Project-local proposal store: validation, persistence, preview and state transitions.
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { VISIBILITIES } from '../annotations.mjs'
import { canonicalSort } from '../catalog.mjs'
import { loadLensRegistry } from '../lenses.mjs'
import { createLinkDirs, readLink } from '../link/config.mjs'
import { CLAIM_ID_RE, CLAIM_MARKER_RE, formatClaimMarker, normalize, parseClaimBlocks, proposalClaimId, replaceClaimBlocks } from '../markdown/claim-blocks.mjs'
import { PRIVATE_RULE, describeRule, legacySubDocumentRule, ruleForRegistry } from '../policy/sub-document-rules.mjs'
import { claims } from '../markdown/text.mjs'
import { canonicalPath, samePath } from '../path-guard.mjs'
import { assertContainedPath, atomicWrite, ensureDir, hash, slash } from '../shared/fs.mjs'
import { parseYaml, yamlObject } from '../shared/yaml.mjs'

export const PROPOSAL_TYPES = [
  'new_fact',
  'fact_update',
  'fact_correction',
  'new_story',
  'new_preference',
  'preference_update',
  'new_decision',
  'privacy_warning',
  'conflict_resolution'
]
export const PROPOSAL_STATES = ['pending', 'approved', 'rejected', 'deferred', 'superseded']
export const PROPOSAL_OPERATIONS = ['append_claim', 'replace_claim', 'supersede_claim', 'retire_claim']
// Per-operation change fields beyond change_id, target, operation and proposal_type; unknown keys are rejected.
const CHANGE_FIELDS = {
  append_claim: { required: ['claim', 'evidence', 'confidence', 'visibility'], optional: [] },
  replace_claim: { required: ['claim_id', 'claim', 'evidence', 'confidence'], optional: ['visibility'] },
  supersede_claim: { required: ['claim_id', 'claim', 'evidence', 'confidence'], optional: ['visibility'] },
  retire_claim: { required: ['claim_id', 'reason', 'evidence'], optional: [] }
}
const DEFAULT_PROPOSAL_TYPE = { append_claim: 'new_fact', replace_claim: 'fact_correction', supersede_claim: 'fact_update', retire_claim: 'fact_update' }
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export const UUID_PREFIX_RE = /^[0-9a-f-]{8,36}$/i
export const CHANGE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const COMMIT_TIME_RESERVED = /@@holoself-commit-time/i
export function proposalDir(project) {
  return assertContainedPath(project, join(project, '.holoself', 'proposals'), 'proposal directory')
}
export function proposalFile(project, id) {
  if (!UUID_RE.test(id)) throw new Error(`invalid proposal id: ${id}`)
  return join(proposalDir(project), `${id}.yaml`)
}
export function proposalText(p) {
  return yamlObject(p)
}
export function proposalChanges(p) {
  return Array.isArray(p.changes)
    ? p.changes
    : [
        {
          change_id: 'claim',
          target: p.target,
          operation: 'append_claim',
          proposal_type: p.proposal_type,
          claim: p.claim,
          evidence: p.evidence,
          confidence: p.confidence,
          visibility: p.visibility
        }
      ]
}
// `inbox: true` validates a client inbox record (<self>/proposals/inbox/): it carries an `origin` instead of a source
// project, so the two record shapes can never be read from each other's store.
export function validateProposal(p, { inbox = false } = {}) {
  if (inbox) return validateInboxProposal(p)
  const errors = [],
    v2 = p?.schema_version === 2,
    requiredStrings = v2
      ? ['proposal_id', 'source_project', 'status', 'created_at']
      : ['proposal_id', 'source_project', 'target', 'proposal_type', 'claim', 'evidence', 'confidence', 'visibility', 'status', 'created_at'],
    allowedKeys = new Set([
      'schema_version',
      'title',
      'proposal_id',
      'source_project',
      'source_project_path',
      'source_files',
      'target',
      'proposal_type',
      'claim',
      'evidence',
      'confidence',
      'visibility',
      'status',
      'created_at',
      'reviewed_at',
      'provenance',
      'changes',
      '_path'
    ])
  if (!p || Array.isArray(p) || typeof p !== 'object') return ['proposal must be a mapping']
  for (const key of Object.keys(p)) if (!allowedKeys.has(key)) errors.push(`unknown proposal field: ${key}`)
  for (const key of requiredStrings) if (typeof p[key] !== 'string' || !p[key].trim()) errors.push(`proposal ${key} must be a non-empty string`)
  if (typeof p.proposal_id === 'string' && !UUID_RE.test(p.proposal_id)) errors.push('proposal_id must be a UUID')
  const terminal = PROPOSAL_STATES.includes(p.status) && p.status !== 'pending'
  if (v2) {
    if (typeof p.title !== 'string' || !p.title.trim()) errors.push('proposal title must be a non-empty string')
    if (!Array.isArray(p.changes) || !p.changes.length) errors.push('proposal changes must be a non-empty array')
    const ids = new Set()
    for (const change of p.changes || []) {
      if (!change || Array.isArray(change) || typeof change !== 'object') {
        errors.push('proposal change must be a mapping')
        continue
      }
      for (const key of ['change_id', 'target', 'operation'])
        if (typeof change[key] !== 'string' || !change[key].trim()) errors.push(`proposal change ${key} must be a non-empty string`)
      if (typeof change.change_id === 'string' && !CHANGE_ID_RE.test(change.change_id))
        errors.push('proposal change_id must match ^[a-z0-9][a-z0-9_-]{0,63}$')
      if (ids.has(change.change_id)) errors.push(`duplicate change_id: ${change.change_id}`)
      ids.add(change.change_id)
      const fields = CHANGE_FIELDS[change.operation]
      if (!fields) {
        errors.push(`unsupported proposal operation: ${change.operation}`)
        continue
      }
      const allowedChangeKeys = new Set(['change_id', 'target', 'operation', 'proposal_type', ...fields.required, ...fields.optional])
      for (const key of Object.keys(change)) if (!allowedChangeKeys.has(key)) errors.push(`unknown ${change.operation} field: ${key}`)
      if (
        isAbsolute(change.target || '') ||
        slash(change.target || '')
          .split('/')
          .includes('..') ||
        !String(change.target || '')
          .toLowerCase()
          .endsWith('.md')
      )
        errors.push(`proposal change target must be a contained relative Markdown path: ${change.change_id}`)
      if (!PROPOSAL_TYPES.includes(change.proposal_type)) errors.push(`invalid proposal_type: ${change.proposal_type}`)
      if (
        (fields.required.includes('visibility') || change.visibility !== undefined) &&
        !VISIBILITIES.includes(change.visibility) &&
        !(terminal && ['career', 'publishing'].includes(change.visibility))
      )
        errors.push(`invalid proposal visibility: ${change.visibility}`)
      for (const key of fields.required.filter(key => key !== 'visibility'))
        if (typeof change[key] !== 'string' || !change[key].trim()) errors.push(`proposal change ${key} must be a non-empty string`)
      if (change.claim_id !== undefined && (typeof change.claim_id !== 'string' || !CLAIM_ID_RE.test(change.claim_id)))
        errors.push(`proposal change claim_id must be a lowercase UUID: ${change.change_id}`)
      if (typeof change.reason === 'string' && /[\r\n]/.test(change.reason)) errors.push(`proposal change reason must be a single line: ${change.change_id}`)
    }
  }
  if (
    !terminal &&
    typeof p.target === 'string' &&
    (isAbsolute(p.target) || slash(p.target).split('/').includes('..') || !p.target.toLowerCase().endsWith('.md'))
  )
    errors.push('proposal target must be a contained relative Markdown path')
  if (!v2 && !PROPOSAL_TYPES.includes(p.proposal_type)) errors.push(`invalid proposal_type: ${p.proposal_type}`)
  if (!PROPOSAL_STATES.includes(p.status)) errors.push(`invalid proposal status: ${p.status}`)
  if (!v2 && !VISIBILITIES.includes(p.visibility) && !(terminal && ['career', 'publishing'].includes(p.visibility)))
    errors.push(`invalid proposal visibility: ${p.visibility}`)
  if (typeof p.created_at === 'string' && Number.isNaN(Date.parse(p.created_at))) errors.push('proposal created_at must be an ISO date-time')
  if (p.reviewed_at !== undefined && (typeof p.reviewed_at !== 'string' || Number.isNaN(Date.parse(p.reviewed_at))))
    errors.push('proposal reviewed_at must be an ISO date-time')
  if (p.source_project_path !== undefined && typeof p.source_project_path !== 'string') errors.push('proposal source_project_path must be a string')
  for (const key of ['source_files', 'provenance'])
    if (!Array.isArray(p[key]) || !p[key].length || p[key].some(x => typeof x !== 'string' || !x.trim()))
      errors.push(`proposal ${key} must be a non-empty string array`)
  if (!terminal && Array.isArray(p.source_files) && p.source_files.some(x => isAbsolute(x) || slash(x).split('/').includes('..')))
    errors.push('proposal source_files must be contained relative paths')
  const textFields = [
    p.claim,
    p.evidence,
    p.confidence,
    ...proposalChanges(p).flatMap(x => [x.change_id, x.claim, x.evidence, x.confidence, x.reason]),
    ...(Array.isArray(p.provenance) ? p.provenance : [])
  ]
  if (textFields.some(x => typeof x === 'string' && (CLAIM_MARKER_RE.test(x) || COMMIT_TIME_RESERVED.test(x))))
    errors.push('proposal text contains reserved claim markers')
  return errors
}
export const INBOX_EVIDENCE_MAX = 4000
const INBOX_KEYS = new Set(['schema_version', 'title', 'proposal_id', 'origin', 'status', 'created_at', 'reviewed_at', 'provenance', 'changes', '_path'])
// Inbox records: schema 2, append_claim changes only, required evidence (1-4,000 characters), provenance exactly
// `client:<client_id>`, and no source project or source files (there is no project to cite).
export function validateInboxProposal(p) {
  if (!p || Array.isArray(p) || typeof p !== 'object') return ['proposal must be a mapping']
  const errors = []
  for (const key of Object.keys(p)) if (!INBOX_KEYS.has(key)) errors.push(`unknown inbox proposal field: ${key}`)
  if (p.schema_version !== 2) errors.push('inbox proposal schema_version must be 2')
  const origin = p.origin
  if (!origin || Array.isArray(origin) || typeof origin !== 'object' || origin.kind !== 'client' || typeof origin.client_id !== 'string' || !UUID_RE.test(origin.client_id))
    errors.push('inbox proposal origin must be { kind: client, client_id: <uuid> }')
  else {
    for (const key of Object.keys(origin)) if (!['kind', 'client_id'].includes(key)) errors.push(`unknown inbox proposal origin field: ${key}`)
    if (!Array.isArray(p.provenance) || p.provenance.length !== 1 || p.provenance[0] !== `client:${origin.client_id}`)
      errors.push('inbox proposal provenance must be exactly client:<client_id>')
  }
  const shaped = { ...p, source_project: 'client-inbox', source_files: ['inbox'] }
  delete shaped.origin
  for (const error of validateProposal(shaped)) errors.push(error)
  for (const change of Array.isArray(p.changes) ? p.changes : []) {
    if (change?.operation !== 'append_claim') errors.push('inbox proposals may only append claims')
    if (typeof change?.evidence !== 'string' || !change.evidence.trim() || change.evidence.length > INBOX_EVIDENCE_MAX)
      errors.push(`inbox proposal evidence must be 1-${INBOX_EVIDENCE_MAX} characters`)
  }
  return errors
}
export function readProposal(path, { inbox = false } = {}) {
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) throw new Error(`proposal is not a regular file: ${path}`)
  let p
  try {
    p = parseYaml(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`malformed proposal ${path}: ${error.message}`)
  }
  // 'auto' (self-root archives only) picks the validator from the record: archived inbox records carry an origin.
  if (inbox === 'auto') inbox = Boolean(p && typeof p === 'object' && !Array.isArray(p) && Object.hasOwn(p, 'origin'))
  const errors = validateProposal(p, { inbox })
  if (errors.length) throw new Error(`invalid proposal ${path}: ${errors.join('; ')}`)
  if (basename(path, '.yaml') !== p.proposal_id) throw new Error(`proposal filename does not match proposal_id: ${path}`)
  p._path = path
  if (inbox) Object.defineProperty(p, '_inbox', { value: true, enumerable: false })
  return p
}
export function listProposalData(project) {
  return scanProposalStore(project).managed
}
export function inboxDir(self) {
  return assertContainedPath(self, join(resolve(self), 'proposals', 'inbox'), 'proposal inbox')
}
export function scanProposalStore(project, { inboxSelf = null } = {}) {
  const inbox = Boolean(inboxSelf),
    dir = inbox ? inboxDir(inboxSelf) : proposalDir(project),
    prefix = inbox ? 'proposals/inbox' : '.holoself/proposals'
  if (!existsSync(dir)) return { managed: [], diagnostics: [] }
  if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) throw new Error(`proposal directory is unsafe: ${dir}`)
  const managed = [],
    diagnostics = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => canonicalSort(a.name, b.name))) {
    const rel = `${prefix}/${entry.name}`,
      path = join(dir, entry.name)
    if (entry.isDirectory()) {
      diagnostics.push({ path: rel, code: 'UNMANAGED_PROPOSAL_DIRECTORY', severity: 'warning', suggested_action: 'review-manually' })
      continue
    }
    if (entry.isSymbolicLink() || !entry.isFile()) {
      diagnostics.push({ path: rel, code: 'UNSAFE_PROPOSAL_ENTRY', severity: 'error', suggested_action: 'review-manually' })
      continue
    }
    if (!entry.name.endsWith('.yaml')) {
      diagnostics.push({ path: rel, code: 'UNMANAGED_PROPOSAL_FORMAT', severity: 'warning', suggested_action: 'adopt-or-preserve' })
      continue
    }
    try {
      managed.push(readProposal(path, { inbox }))
    } catch (error) {
      diagnostics.push({
        path: rel,
        code: 'INVALID_PROPOSAL',
        severity: 'error',
        suggested_action: 'repair-or-preserve',
        detail: error.message.replace(path, rel)
      })
    }
  }
  return { managed, diagnostics }
}
export function findProposal(project, id, { inboxSelf = null } = {}) {
  if (typeof id !== 'string' || !UUID_PREFIX_RE.test(id) || id.includes('..') || id.includes('/') || id.includes('\\'))
    throw new Error(`invalid proposal id: ${id}`)
  const scan = scanProposalStore(project, { inboxSelf }),
    matches = scan.managed.filter(p => p.proposal_id === id || p.proposal_id.startsWith(id))
  if (!matches.length) {
    const invalid = scan.diagnostics.find(item => basename(item.path, '.yaml').startsWith(id))
    if (invalid) throw new Error(invalid.detail || `${invalid.code}: ${invalid.path}`)
    throw new Error(`proposal not found: ${id}`)
  }
  if (matches.length > 1) throw new Error(`ambiguous proposal id: ${id}`)
  return matches[0]
}
export function proposalProjectErrors(p, project) {
  const errors = [],
    canonProject = canonicalPath(project)
  if (!samePath(p.source_project, basename(project)) && !samePath(p.source_project, basename(canonProject)))
    errors.push('proposal source_project does not match linked project')
  if (p.source_project_path && !samePath(canonicalPath(p.source_project_path), canonProject))
    errors.push('proposal source_project_path does not match linked project')
  for (const source of p.source_files || []) {
    try {
      const path = assertContainedPath(project, resolve(project, source), 'proposal source file')
      if (!existsSync(path) || !lstatSync(path).isFile()) errors.push(`proposal source file not found: ${source}`)
    } catch (error) {
      errors.push(error.message)
    }
  }
  return errors
}
export function saveProposal(p, path = p._path) {
  const errors = validateProposal(p, { inbox: p._inbox === true })
  if (errors.length) throw new Error(`invalid proposal: ${errors.join('; ')}`)
  const clean = { ...p }
  delete clean._path
  atomicWrite(path, proposalText(clean))
}
function claimError(message, code) {
  return Object.assign(new Error(message), { code })
}
// One stored change from caller input: operation-specific fields only, with the documented defaults.
function proposalChange(input, sourceFiles, changeId) {
  const operation = input.operation || 'append_claim'
  if (!PROPOSAL_OPERATIONS.includes(operation)) throw claimError(`unsupported proposal operation: ${operation}`, 'INVALID_ARGUMENT')
  if (operation !== 'append_claim' && !input.evidence) throw claimError(`${operation} requires evidence`, 'INVALID_ARGUMENT')
  const change = {
    change_id: changeId,
    target: input.target || 'context/claims.md',
    operation,
    proposal_type: input.proposal_type || DEFAULT_PROPOSAL_TYPE[operation]
  }
  if (operation !== 'append_claim') change.claim_id = input.claim_id
  if (operation === 'retire_claim') change.reason = input.reason
  else change.claim = input.claim
  change.evidence = input.evidence || `Source project files: ${sourceFiles.join(', ')}`
  if (operation !== 'retire_claim') change.confidence = input.confidence || 'unverified'
  if (operation === 'append_claim') change.visibility = input.visibility || 'private'
  else if (operation !== 'retire_claim' && input.visibility) change.visibility = input.visibility
  for (const key of ['claim', 'reason', 'claim_id'])
    if (change[key] === undefined && CHANGE_FIELDS[operation].required.includes(key)) throw claimError(`${operation} requires ${key}`, 'INVALID_ARGUMENT')
  if (operation === 'retire_claim' && (input.claim || input.confidence || input.visibility))
    throw claimError('retire_claim accepts reason and evidence, not claim, confidence or visibility', 'INVALID_ARGUMENT')
  if (operation !== 'retire_claim' && input.reason) throw claimError(`${operation} does not accept reason`, 'INVALID_ARGUMENT')
  if (operation === 'append_claim' && input.claim_id) throw claimError('append_claim does not accept claim_id', 'INVALID_ARGUMENT')
  return change
}
// `view` (MCP only) narrows every claim check to what the caller's link can read; see planProposalChanges.
export function createProposal(project, input, { view = null } = {}) {
  const link = readLink(project)
  if (link.proposals !== 'enabled') throw new Error('proposals are not enabled for link')
  const sourceFiles = input.source_files || []
  if (!sourceFiles.length) throw new Error('proposal requires at least one source file')
  for (const source of sourceFiles) {
    const path = assertContainedPath(project, resolve(project, source), 'proposal source file')
    if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) throw new Error(`source file not found or unsafe: ${source}`)
  }
  const inputs = Array.isArray(input.changes) && input.changes.length ? input.changes : [input],
    p = {
      schema_version: 2,
      proposal_id: randomUUID(),
      title: `Review reusable context from ${basename(project)}`,
      source_project: basename(project),
      source_project_path: slash(project),
      source_files: sourceFiles,
      status: 'pending',
      created_at: new Date().toISOString(),
      provenance: sourceFiles.map(x => `${basename(project)}:${x}`),
      changes: inputs.map((item, i) => proposalChange(item, sourceFiles, item.change_id || (inputs.length === 1 ? 'claim' : `change-${i + 1}`)))
    }
  const errors = validateProposal(p)
  if (errors.length) throw claimError(errors.join('; '), 'INVALID_ARGUMENT')
  // Refuse early when a targeted claim is missing, ambiguous or no longer current, exactly as preview would.
  planProposalChanges(p, link.path, view)
  createLinkDirs(project, { preserveReadme: true })
  saveProposal(p, proposalFile(project, p.proposal_id))
  return p
}
// Placeholder for the approval time, unique per proposal so user text can never collide with it.
export function commitTimeToken(p) {
  return `@@holoself-commit-time-${hash(p.proposal_id).slice(0, 16)}@@`
}
// Current claim lines of a document, ignoring superseded/retired history, blocks the view cannot see, and optionally
// the block being rewritten (by offset in the full text, or by claim id in delivered text).
function currentClaimLines(text, { skip = null, keep = () => true } = {}) {
  return claims(
    replaceClaimBlocks(text, block => (block.start === skip?.start || block.status !== 'current' || !keep(block) ? '' : block.raw), { failClosed: false })
  )
}
// A body names a visibility only when one word states it: a lens list is the owner's and stays in the marker.
function claimBody(p, change, visibility) {
  const named = visibility && !visibility.includes('=') ? `- Visibility: ${visibility}\n` : ''
  return (
    `## Approved proposal ${p.proposal_id}/${change.change_id}\n\n${change.claim}\n\n` +
    `- Evidence: ${change.evidence}\n- Confidence: ${change.confidence}\n${named}` +
    `- Provenance: ${p.provenance.join('; ')}\n- Approved: ${commitTimeToken(p)}\n`
  )
}
function targetedClaim(text, rel, change, view, registry) {
  // Under an MCP view, blocks the caller cannot read behave as absent, so errors never reveal hidden claims.
  const found = parseClaimBlocks(text, rel, { registry }).filter(block => block.claim_id === change.claim_id && (!view || view.visible(rel, block)))
  if (!found.length) throw claimError(`claim not found in ${rel}: ${change.claim_id} (${change.change_id})`, 'CLAIM_NOT_FOUND')
  if (found.length > 1) throw claimError(`claim id is ambiguous in ${rel}: ${change.claim_id} (${change.change_id})`, 'CLAIM_AMBIGUOUS')
  const block = found[0]
  if (block.malformed) throw claimError(`claim marker is malformed: ${change.claim_id} (${change.change_id})`, 'CLAIM_MALFORMED')
  if (block.status !== 'current') throw claimError(`claim is already ${block.status}: ${change.claim_id} (${change.change_id})`, 'CLAIM_NOT_CURRENT')
  return block
}
function refuseDuplicate(text, rel, change, view, skip = null) {
  const lines = view
    ? view.delivered(rel).flatMap(content => currentClaimLines(content, { keep: block => !skip || block.claim_id !== skip.claim_id }))
    : currentClaimLines(text, { skip })
  if (lines.some(x => normalize(x) === normalize(change.claim)))
    throw claimError(`proposal duplicates an existing canonical claim: ${change.change_id}`, 'DUPLICATE_CLAIM')
}
const diffLines = (removed, added) => [...removed.map(x => x.split('\n').map(line => `-${line}`).join('\n')), ...added.map(x => x.split('\n').map(line => `+${line}`).join('\n'))].join('\n')
// Applies one change to the current text of its target. The approval time stays a placeholder until approval commits.
// Proposals keep their `visibility` field, so archived records stay readable; what lands in the document is the lens
// vocabulary (decision record, "Mapping: claim and field level"), limited to the lenses this self defines.
export function applyClaimChange(text, rel, change, p, view = null, registry = null) {
  const close = '<!-- /holoself-claim -->',
    time = commitTimeToken(p),
    writable = rule => ruleForRegistry(rule, registry) || PRIVATE_RULE
  if (change.operation === 'append_claim') {
    refuseDuplicate(text, rel, change, view)
    const claimId = proposalClaimId(p.proposal_id, change.change_id),
      block = `\n\n${formatClaimMarker(writable(legacySubDocumentRule(change.visibility)), { id: claimId })}\n${claimBody(p, change, change.visibility)}${close}\n`
    return { after: text.trimEnd() + block, claim_id: claimId, before_block: null, after_block: block.trim(), preview: block.trim(), visibility_change: null }
  }
  const old = targetedClaim(text, rel, change, view, registry),
    splice = replacement => text.slice(0, old.start) + replacement + text.slice(old.end),
    attrs = { ...old.attrs, id: old.claim_id },
    oldRule = ruleForRegistry(old.rule, registry)
  // No lens reads this claim, and that has no written form. Any marker written here would be wider, so it is refused.
  if (!oldRule || oldRule.access_lenses?.length === 0)
    throw claimError(`claim rule admits no lens; fix its marker by hand: ${change.claim_id} (${change.change_id})`, 'CLAIM_RULE_UNWRITABLE')
  const rule = change.visibility ? writable(legacySubDocumentRule(change.visibility)) : oldRule,
    // Under a view the marker read here is the delivered one, which keeps no lens list, so its name would be wrong.
    visibility = change.visibility || (view ? null : describeRule(old.rule)),
    visibilityChange = !change.visibility || change.visibility === describeRule(old.rule) ? null : { from: describeRule(old.rule), to: change.visibility }
  if (change.operation === 'replace_claim') {
    if (normalize(old.text) === normalize(change.claim)) throw claimError(`replacement wording matches the existing claim: ${change.change_id}`, 'CLAIM_UNCHANGED')
    refuseDuplicate(text, rel, change, view, old)
    const block = `${formatClaimMarker(rule, { id: old.claim_id, supersedes: old.attrs.supersedes })}\n${claimBody(p, change, visibility)}${close}`
    return { after: splice(block), claim_id: old.claim_id, before_block: old.raw, after_block: block, preview: diffLines([old.raw], [block]), visibility_change: visibilityChange }
  }
  if (change.operation === 'supersede_claim') {
    if (normalize(old.text) === normalize(change.claim)) throw claimError(`superseding wording matches the existing claim: ${change.change_id}`, 'CLAIM_UNCHANGED')
    refuseDuplicate(text, rel, change, view, old)
    const claimId = proposalClaimId(p.proposal_id, change.change_id),
      marked = `${formatClaimMarker(oldRule, { ...attrs, status: 'superseded', superseded_by: claimId, superseded_at: time })}${old.body}${close}`,
      block = `${formatClaimMarker(rule, { id: claimId, supersedes: old.claim_id })}\n${claimBody(p, change, visibility)}${close}`
    return {
      after: `${splice(marked).trimEnd()}\n\n${block}\n`,
      claim_id: claimId,
      before_block: old.raw,
      after_block: `${marked}\n\n${block}`,
      preview: diffLines([old.raw], [marked, '', block]),
      visibility_change: visibilityChange
    }
  }
  const marked =
    `${formatClaimMarker(oldRule, { ...attrs, status: 'historical', retired_at: time })}${old.body.trimEnd()}\n` +
    `- Retired: ${time} by proposal ${p.proposal_id}/${change.change_id}\n- Retirement reason: ${change.reason}\n` +
    `- Retirement evidence: ${change.evidence}\n- Retirement provenance: ${p.provenance.join('; ')}\n${close}`
  return { after: splice(marked), claim_id: old.claim_id, before_block: old.raw, after_block: marked, preview: diffLines([old.raw], [marked]), visibility_change: null }
}
export function emptyTarget(self) {
  return `---\naccess_lenses: [${loadLensRegistry(self)
    .lenses.map(lens => lens.id)
    .join(', ')}]\ndisclosure: review-required\nsensitivity: personal\ndocument_role: evidence\n---\n`
}
// The self's lenses for writing and reading claim markers; null when they cannot be loaded (markers still validate).
export function claimLensRegistry(root) {
  try {
    return loadLensRegistry(root)
  } catch {
    return null
  }
}
// Applies every change in order, grouping by target so several changes to one file compose deterministically.
// Each preview entry hashes the file as that change found and left it, so hashes chain across changes to one file.
// With an MCP `view`, claim lookups and duplicate checks see only what the link's lenses deliver; approval always
// re-plans without a view, so the full checks still run before anything is written.
export function planProposalChanges(p, self, view = null) {
  const root = canonicalPath(self),
    grouped = new Map(),
    previews = [],
    steps = [],
    time = commitTimeToken(p),
    shown = text => (text === null ? null : text.replaceAll(time, '<commit-time>')),
    registry = claimLensRegistry(root)
  for (const change of proposalChanges(p)) {
    const target = safeTarget(root, change.target),
      rel = slash(relative(root, target)),
      state = grouped.get(target),
      existed = state?.existed ?? existsSync(target),
      before = state?.before ?? (existed ? readFileSync(target, 'utf8') : emptyTarget(root)),
      current = state?.after ?? before
    if (!state && before.includes(time)) throw claimError(`target already contains this proposal's reserved placeholder: ${rel}`, 'INVALID_TARGET')
    const operation = change.operation || 'append_claim',
      applied = applyClaimChange(current, rel, { ...change, operation }, p, view, registry),
      viewCurrent = state?.viewAfter ?? view?.baseText?.(rel, change) ?? null
    // A caller with a view reads only what it was delivered. Without delivered text there is nothing it may be shown.
    if (view && viewCurrent === null && operation !== 'append_claim') throw claimError(`claim not found in ${rel}: ${change.claim_id} (${change.change_id})`, 'CLAIM_NOT_FOUND')
    const viewApplied = viewCurrent === null ? null : applyClaimChange(viewCurrent, rel, { ...change, operation }, p, view, registry),
      viewAfter = viewApplied?.after ?? null,
      shownChange = viewApplied ?? applied,
      visibilityChange = view && applied.visibility_change ? { from: 'not shown', to: applied.visibility_change.to } : applied.visibility_change
    grouped.set(target, { target, before, after: applied.after, existed, viewAfter })
    steps.push({ before: current, after: applied.after })
    previews.push({
      change_id: change.change_id,
      operation,
      target: rel,
      claim_id: applied.claim_id,
      evidence: change.evidence,
      visibility_change: visibilityChange,
      before_sha256: hash(viewCurrent ?? (view ? '' : current)),
      after_sha256: hash(viewAfter ?? (view ? shownChange.after_block : applied.after)),
      before_block: shown(shownChange.before_block),
      after_block: shown(shownChange.after_block),
      preview: shown(shownChange.preview)
    })
  }
  return { grouped, previews, steps, commit_time_token: time }
}
export function proposalPreviewData(project, id, { view = null } = {}) {
  const p = findProposal(project, id)
  if (p.status !== 'pending') throw new Error(`proposal is ${p.status}, expected pending`)
  const projectErrors = proposalProjectErrors(p, project)
  if (projectErrors.length) throw new Error(`proposal provenance validation failed: ${projectErrors.join('; ')}`)
  const link = readLink(project),
    { grouped, previews, steps, commit_time_token } = planProposalChanges(p, link.path, view)
  return { proposal: p, link, grouped, steps, commit_time_token, changes: previews, preview_hash: hash(JSON.stringify(previews)) }
}
export function stateProposal(project, p, state, details = {}) {
  return stateProposalInSelf(readLink(project).path, p, state, details)
}
// Archives a reviewed proposal (project or inbox) under <self>/proposals/<state>/ with its receipt.
export function stateProposalInSelf(self, p, state, details = {}) {
  if (!UUID_RE.test(p.proposal_id)) throw new Error('proposal_id must be a UUID')
  const dir = assertContainedPath(self, join(self, 'proposals', state), 'proposal archive'),
    archive = assertContainedPath(self, join(dir, `${p.proposal_id}.yaml`), 'proposal archive'),
    receiptDir = assertContainedPath(self, join(self, 'proposals', 'receipts'), 'proposal receipts'),
    receipt = assertContainedPath(self, join(receiptDir, `${p.proposal_id}-${state}.json`), 'proposal receipt')
  if (existsSync(archive) || existsSync(receipt)) throw new Error(`proposal archive or receipt collision: ${archive}`)
  const original = { status: p.status, reviewed_at: p.reviewed_at },
    proposalSha = hash(proposalText(Object.fromEntries(Object.entries(p).filter(([k]) => k !== '_path'))))
  p.status = state
  p.reviewed_at = new Date().toISOString()
  ensureDir(dir)
  ensureDir(receiptDir)
  try {
    writeFileSync(archive, proposalText(Object.fromEntries(Object.entries(p).filter(([k]) => k !== '_path'))), { encoding: 'utf8', flag: 'wx' })
    writeFileSync(
      receipt,
      JSON.stringify(
        { schema_version: 1, proposal_id: p.proposal_id, decision: state, reviewed_at: p.reviewed_at, proposal_sha256: proposalSha, ...details },
        null,
        2
      ) + '\n',
      { encoding: 'utf8', flag: 'wx' }
    )
    saveProposal(p)
  } catch (error) {
    rmSync(archive, { force: true })
    rmSync(receipt, { force: true })
    p.status = original.status
    if (original.reviewed_at === undefined) delete p.reviewed_at
    else p.reviewed_at = original.reviewed_at
    throw error
  }
}
export function safeTarget(self, target) {
  const root = canonicalPath(self),
    path = assertContainedPath(root, resolve(root, target), 'proposal target'),
    rel = slash(relative(root, path)),
    top = rel.split('/')[0]
  if (!['profile', 'context', 'reference', 'contribs', 'topics'].includes(top) || !path.toLowerCase().endsWith('.md'))
    throw new Error('proposal target must be Markdown under profile, context, reference, contribs, or topics')
  return path
}
