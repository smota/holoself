// Project-local proposal store: validation, persistence, preview and state transitions.
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { VISIBILITIES } from '../annotations.mjs'
import { canonicalSort } from '../catalog.mjs'
import { loadLensRegistry } from '../lenses.mjs'
import { createLinkDirs, readLink } from '../link/config.mjs'
import { claims } from '../markdown/text.mjs'
import { canonicalPath, samePath } from '../path-guard.mjs'
import { assertContainedPath, atomicWrite, ensureDir, hash, slash } from '../shared/fs.mjs'
import { parseYaml, yamlObject } from '../shared/yaml.mjs'
import { normalize } from './analysis.mjs'

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
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export const UUID_PREFIX_RE = /^[0-9a-f-]{8,36}$/i
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
export function validateProposal(p) {
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
      if (ids.has(change.change_id)) errors.push(`duplicate change_id: ${change.change_id}`)
      ids.add(change.change_id)
      if (change.operation !== 'append_claim') errors.push(`unsupported proposal operation: ${change.operation}`)
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
      if (!VISIBILITIES.includes(change.visibility) && !(terminal && ['career', 'publishing'].includes(change.visibility)))
        errors.push(`invalid proposal visibility: ${change.visibility}`)
      for (const key of ['claim', 'evidence', 'confidence'])
        if (typeof change[key] !== 'string' || !change[key].trim()) errors.push(`proposal change ${key} must be a non-empty string`)
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
    ...proposalChanges(p).flatMap(x => [x.claim, x.evidence, x.confidence]),
    ...(Array.isArray(p.provenance) ? p.provenance : [])
  ]
  if (textFields.some(x => typeof x === 'string' && /<!--\s*\/?holoself-claim/i.test(x))) errors.push('proposal text contains reserved claim markers')
  return errors
}
export function readProposal(path) {
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) throw new Error(`proposal is not a regular file: ${path}`)
  let p
  try {
    p = parseYaml(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`malformed proposal ${path}: ${error.message}`)
  }
  const errors = validateProposal(p)
  if (errors.length) throw new Error(`invalid proposal ${path}: ${errors.join('; ')}`)
  if (basename(path, '.yaml') !== p.proposal_id) throw new Error(`proposal filename does not match proposal_id: ${path}`)
  p._path = path
  return p
}
export function listProposalData(project) {
  return scanProposalStore(project).managed
}
export function scanProposalStore(project) {
  const dir = proposalDir(project)
  if (!existsSync(dir)) return { managed: [], diagnostics: [] }
  if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) throw new Error(`proposal directory is unsafe: ${dir}`)
  const managed = [],
    diagnostics = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => canonicalSort(a.name, b.name))) {
    const rel = `.holoself/proposals/${entry.name}`,
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
      managed.push(readProposal(path))
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
export function findProposal(project, id) {
  if (typeof id !== 'string' || !UUID_PREFIX_RE.test(id) || id.includes('..') || id.includes('/') || id.includes('\\'))
    throw new Error(`invalid proposal id: ${id}`)
  const scan = scanProposalStore(project),
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
  const errors = []
  if (p.source_project !== basename(project)) errors.push('proposal source_project does not match linked project')
  if (p.source_project_path && !samePath(canonicalPath(p.source_project_path), canonicalPath(project)))
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
  const errors = validateProposal(p)
  if (errors.length) throw new Error(`invalid proposal: ${errors.join('; ')}`)
  const clean = { ...p }
  delete clean._path
  atomicWrite(path, proposalText(clean))
}
export function createProposal(project, input) {
  const link = readLink(project)
  if (link.proposals !== 'enabled') throw new Error('proposals are not enabled for link')
  const sourceFiles = input.source_files || []
  if (!sourceFiles.length) throw new Error('proposal requires at least one source file')
  for (const source of sourceFiles) {
    const path = assertContainedPath(project, resolve(project, source), 'proposal source file')
    if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) throw new Error(`source file not found or unsafe: ${source}`)
  }
  const p = {
    schema_version: 2,
    proposal_id: randomUUID(),
    title: `Review reusable context from ${basename(project)}`,
    source_project: basename(project),
    source_project_path: slash(project),
    source_files: sourceFiles,
    status: 'pending',
    created_at: new Date().toISOString(),
    provenance: sourceFiles.map(x => `${basename(project)}:${x}`),
    changes: [
      {
        change_id: 'claim',
        target: input.target || 'context/claims.md',
        operation: 'append_claim',
        proposal_type: input.proposal_type || 'new_fact',
        claim: input.claim,
        evidence: input.evidence || `Source project files: ${sourceFiles.join(', ')}`,
        confidence: input.confidence || 'unverified',
        visibility: input.visibility || 'private'
      }
    ]
  }
  const errors = validateProposal(p)
  if (errors.length) throw new Error(errors.join('; '))
  createLinkDirs(project, { preserveReadme: true })
  saveProposal(p, proposalFile(project, p.proposal_id))
  return p
}
export function proposalPreviewData(project, id) {
  const p = findProposal(project, id)
  if (p.status !== 'pending') throw new Error(`proposal is ${p.status}, expected pending`)
  const projectErrors = proposalProjectErrors(p, project)
  if (projectErrors.length) throw new Error(`proposal provenance validation failed: ${projectErrors.join('; ')}`)
  const link = readLink(project),
    grouped = new Map(),
    approvedAt = '<commit-time>',
    previews = []
  for (const change of proposalChanges(p)) {
    const target = safeTarget(link.path, change.target),
      before =
        grouped.get(target)?.before ??
        (existsSync(target)
          ? readFileSync(target, 'utf8')
          : `---\naccess_lenses: [${loadLensRegistry(link.path)
              .lenses.map(lens => lens.id)
              .join(', ')}]\ndisclosure: review-required\nsensitivity: personal\ndocument_role: evidence\n---\n`)
    if (claims(before).some(x => normalize(x) === normalize(change.claim)))
      throw new Error(`proposal duplicates an existing canonical claim: ${change.change_id}`)
    const block =
        `\n\n<!-- holoself-claim visibility=${change.visibility} -->\n## Approved proposal ${p.proposal_id}/${change.change_id}\n\n${change.claim}\n\n` +
        `- Evidence: ${change.evidence}\n- Confidence: ${change.confidence}\n- Visibility: ${change.visibility}\n` +
        `- Provenance: ${p.provenance.join('; ')}\n- Approved: ${approvedAt}\n<!-- /holoself-claim -->\n`,
      current = grouped.get(target)?.after ?? before,
      after = current.trimEnd() + block
    grouped.set(target, { target, before, after, existed: grouped.get(target)?.existed ?? existsSync(target) })
    previews.push({
      change_id: change.change_id,
      target: slash(relative(link.path, target)),
      before_sha256: hash(before),
      after_sha256: hash(after),
      preview: block.trim()
    })
  }
  return { proposal: p, link, grouped, changes: previews, preview_hash: hash(JSON.stringify(previews)) }
}
export function stateProposal(project, p, state, details = {}) {
  if (!UUID_RE.test(p.proposal_id)) throw new Error('proposal_id must be a UUID')
  const self = readLink(project).path,
    dir = assertContainedPath(self, join(self, 'proposals', state), 'proposal archive'),
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
  const root = resolve(self),
    path = assertContainedPath(root, resolve(root, target), 'proposal target'),
    rel = slash(relative(root, path)),
    top = rel.split('/')[0]
  if (!['profile', 'context', 'reference', 'contribs', 'topics'].includes(top) || !path.toLowerCase().endsWith('.md'))
    throw new Error('proposal target must be Markdown under profile, context, reference, contribs, or topics')
  return path
}
