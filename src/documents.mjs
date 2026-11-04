import { existsSync, lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { validateAnnotationMetadata } from './annotations.mjs'
import { loadLensRegistry } from './lenses.mjs'
import { assertNoLinkBelow } from './path-guard.mjs'
import { resolveDocumentPolicy } from './policy/policy-defaults.mjs'
import { frontmatter } from './policy/privacy-fields.mjs'
import { atomicWrite, hash, slash } from './shared/fs.mjs'

function loadRootRegistry(root) {
  try {
    return existsSync(join(resolve(root), 'lenses')) ? loadLensRegistry(root) : null
  } catch {
    return null
  }
}

const ROOTS = new Set(['profile', 'context', 'topics', 'reference', 'me', 'contribs', 'history'])
export const ANNOTATION_FIELDS = {
  schema_version: 'number',
  access_lenses: 'array',
  disclosure: 'string',
  sensitivity: 'string',
  document_role: 'string',
  confidence: 'string',
  visibility: 'string',
  public_safe: 'boolean',
  knowledge_status: 'string',
  temporal_scope: 'string',
  valid_from: 'string',
  valid_until: 'string',
  review_after: 'string',
  supersedes: 'array',
  superseded_by: 'string'
}
function formatValue(value) {
  if (Array.isArray(value)) return `[${value.join(', ')}]`
  if (typeof value === 'boolean') return String(value)
  return String(value)
}
export function parseAnnotatedMarkdown(content) {
  const normalized = content.replaceAll('\r\n', '\n'),
    parsed = frontmatter(normalized, { tolerant: true, validatePrivacy: false }),
    rawLines = parsed.hasFrontmatter && parsed.raw ? parsed.raw.split('\n') : [],
    body = parsed.body,
    metadata = {},
    unknown = []
  for (const [key, expectedType] of Object.entries(ANNOTATION_FIELDS)) {
    if (!Object.hasOwn(parsed.metadata, key) || parsed.metadata[key] === null || parsed.metadata[key] === undefined) continue
    const val = parsed.metadata[key]
    if (expectedType === 'array') metadata[key] = Array.isArray(val) ? val.map(item => String(item).trim()).filter(Boolean) : [String(val).trim()].filter(Boolean)
    else if (expectedType === 'boolean') metadata[key] = typeof val === 'boolean' ? val : val === 'true' ? true : val === 'false' ? false : val
    else if (expectedType === 'number') metadata[key] = typeof val === 'number' ? val : Number(val)
    else metadata[key] = typeof val === 'string' ? val : String(val)
  }
  let skippingKnownBlock = false
  for (const line of rawLines) {
    const found = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/)
    if (found) {
      if (Object.hasOwn(ANNOTATION_FIELDS, found[1])) {
        skippingKnownBlock = found[2].trim() === ''
        if (skippingKnownBlock && !Object.hasOwn(metadata, found[1])) metadata[found[1]] = ANNOTATION_FIELDS[found[1]] === 'array' ? [] : ''
      } else {
        skippingKnownBlock = false
        unknown.push(line)
      }
    } else if (!skippingKnownBlock || (!/^\s+/.test(line) && line.trim())) {
      unknown.push(line)
    }
  }
  const markers = [...body.matchAll(/<!--\s*(\/?)os-section(?::\s*([a-zA-Z0-9_-]+))?\s*-->/g)],
    segments = []
  if (!markers.length) segments.push({ annotation: null, marker: null, content: body })
  else {
    if (markers[0].index > 0) segments.push({ annotation: null, marker: null, content: body.slice(0, markers[0].index) })
    for (let index = 0; index < markers.length; index++) {
      const marker = markers[index],
        nextIndex = markers[index + 1]?.index ?? body.length
      segments.push({
        annotation: marker[1] ? `end:${marker[2] || ''}` : marker[2],
        marker: marker[0],
        content: body.slice(marker.index + marker[0].length, nextIndex)
      })
    }
  }
  return { metadata, unknownMetadata: unknown, segments }
}
function serializeAnnotated(original, metadata, segments, { knownLenses = [], policyDefaults = {} } = {}) {
  const parsed = parseAnnotatedMarkdown(original),
    merged = { ...parsed.metadata, ...metadata }
  for (const [key, value] of Object.entries(merged)) if (value === null) delete merged[key]
  if (!Number.isInteger(merged.schema_version) || merged.schema_version < 1) throw new Error('schema_version must be a positive integer')
  const hasLegacyVis =
    (merged.visibility !== undefined && merged.visibility !== null) || (merged.public_safe !== undefined && merged.public_safe !== null)
  const effectiveForValidation = hasLegacyVis ? { ...merged } : { ...policyDefaults, ...merged }
  const policy = validateAnnotationMetadata(effectiveForValidation, knownLenses, { allowLegacy: true })
  if (!policy.valid) throw new Error(policy.errors.join(' '))
  const known = Object.keys(ANNOTATION_FIELDS)
      .filter(key => merged[key] !== undefined)
      .map(key => `${key}: ${formatValue(merged[key])}`),
    frontmatter = ['---', ...known, ...parsed.unknownMetadata, '---', ''].join('\n')
  if (
    !Array.isArray(segments) ||
    segments.some(segment => !segment || typeof segment.content !== 'string' || (segment.annotation !== null && typeof segment.annotation !== 'string'))
  )
    throw new Error('annotated sections are invalid')
  const originalMarkers = parsed.segments.map(segment => segment.marker).filter(Boolean),
    nextMarkers = segments.map(segment => segment.marker).filter(Boolean)
  if (JSON.stringify(originalMarkers) !== JSON.stringify(nextMarkers))
    throw new Error('section annotations cannot be added, removed, or reordered in the content editor')
  const body = segments.map(segment => `${segment.marker || ''}${segment.content}`).join('')
  return frontmatter + body
}
function safe(root, name, { missing = false } = {}) {
  if (typeof name !== 'string' || !name.endsWith('.md')) throw new Error('document path must be a Markdown file')
  const base = resolve(root),
    path = resolve(base, name),
    rel = relative(base, path)
  if (
    !rel ||
    rel.startsWith('..' + sep) ||
    rel === '..' ||
    !ROOTS.has(rel.split(sep)[0]) ||
    (rel.split(sep)[0] === 'contribs' && rel.split(sep)[1] !== 'local')
  )
    throw new Error('document path escapes editable knowledge')
  assertNoLinkBelow(base, path, () => new Error('document path contains a symlink'))
  if (!missing && (!existsSync(path) || !lstatSync(path).isFile())) throw new Error('document not found')
  return { path, relative: slash(rel) }
}
export function listDocuments(root) {
  const out = []
  const registry = loadRootRegistry(root)
  for (const top of ['profile', 'context', 'topics', 'reference', 'me', 'contribs/local', 'history']) {
    const base = join(resolve(root), top)
    if (!existsSync(base)) continue
    const walk = dir => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isSymbolicLink()) continue
        if (e.isDirectory()) walk(p)
        else if (e.isFile() && e.name.endsWith('.md')) {
          const text = readFileSync(p, 'utf8'),
            s = lstatSync(p),
            metadata = parseAnnotatedMarkdown(text).metadata,
            resolved = resolveDocumentPolicy(p, root, metadata, registry),
            effective = resolved.effectiveMetadata
          out.push({
            path: slash(relative(resolve(root), p)),
            bytes: s.size,
            modified_at: s.mtime.toISOString(),
            hash: hash(text),
            knowledge_status: effective.knowledge_status || 'current',
            temporal_scope: effective.temporal_scope || 'current',
            review_after: effective.review_after || null,
            policy_sources: resolved.policySources
          })
        }
      }
    }
    walk(base)
  }
  return out.sort((a, b) => a.path.localeCompare(b.path))
}
export function readDocument(root, name) {
  const item = safe(root, name)
  const content = readFileSync(item.path, 'utf8')
  const annotations = parseAnnotatedMarkdown(content)
  const registry = loadRootRegistry(root)
  const resolved = resolveDocumentPolicy(item.path, root, annotations.metadata, registry)
  return {
    ...item,
    content,
    annotations,
    effective_policy: resolved.effectiveMetadata,
    policy_defaults: resolved.policyDefaults,
    policy_sources: resolved.policySources,
    hash: hash(content)
  }
}
export async function saveAnnotatedDocument(root, name, { metadata, segments, expectedHash }, { validate, knownLenses = [] } = {}) {
  const item = safe(root, name),
    original = readFileSync(item.path, 'utf8'),
    registry = loadRootRegistry(root),
    resolved = resolveDocumentPolicy(item.path, root, {}, registry),
    content = serializeAnnotated(original, metadata, segments, { knownLenses, policyDefaults: resolved.policyDefaults })
  return saveDocument(root, name, content, expectedHash, { validate })
}
export async function saveDocument(root, name, content, expectedHash, { validate } = {}) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > 2 * 1024 * 1024) throw new Error('document must be text no larger than 2 MiB')
  const item = safe(root, name, { missing: true }),
    existed = existsSync(item.path),
    before = existed ? readFileSync(item.path) : null,
    current = existed ? hash(before) : 'missing'
  if (expectedHash !== current) {
    const e = new Error('document changed on disk')
    e.code = 'STALE_DOCUMENT'
    e.current_hash = current
    throw e
  }
  try {
    atomicWrite(item.path, content, { mode: 0o666 })
    if (validate) await validate()
  } catch (error) {
    if (existed) {
      atomicWrite(item.path, before, { mode: 0o666 })
    } else rmSync(item.path, { force: true })
    const wrapped = new Error(`document validation failed; original content restored: ${error.message}`)
    wrapped.code = 'DOCUMENT_INVALID'
    throw wrapped
  }
  return { ...item, hash: hash(content), bytes: Buffer.byteLength(content) }
}
