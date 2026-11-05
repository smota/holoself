import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { recordDigest } from '../core/record-digest.mjs'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

const MIN_LEVEL = 2
const MAX_LEVEL = 3

export const OPENRIG_REGIONS = Object.freeze([
  'identity',
  'ontology',
  'terrain',
  'actors',
  'laws',
  'history',
  'state',
  'affordances',
])

export const CORE_REGIONS = Object.freeze(['identity', 'terrain', 'laws', 'affordances'])

export const COVERAGE_DIMENSIONS = Object.freeze([
  'product',
  'topology',
  'context',
  'skill',
  'queue/custody',
  'source/worktree',
  'proof/review',
  'lifecycle/release',
  'continuity/recovery',
  'host-boundary',
])

export const ALLOWED_ATOM_KEYS = Object.freeze([
  'id',
  'address',
  'taxonomy',
  'regions',
  'situations',
  'purpose',
  'runtime',
  'order',
  'priority',
  'requires',
  'profile_only',
  'probe',
])

export const DEFAULT_SCAN_FILES = Object.freeze([
  'AGENTS.md',
  'README.md',
  '.agentflow/PRODUCT.md',
  'docs/PRODUCT_SPECIFICATION.md',
  'docs/stack-conventions.md',
])

export class AddressResolutionError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AddressResolutionError'
  }
}

export function resolveContainedPath(targetDir, relPath) {
  if (typeof targetDir !== 'string' || !targetDir.trim()) {
    throw new Error('Invalid targetDir for path containment check')
  }
  if (typeof relPath !== 'string' || !relPath.trim()) {
    throw new Error('Unsafe path rejected: path must be a non-empty string')
  }
  if (relPath.includes('\0') || relPath.includes('\\') || /^[a-zA-Z]:/.test(relPath)) {
    throw new Error(`Unsafe path rejected: invalid characters or drive prefix in "${relPath}"`)
  }
  if (isAbsolute(relPath) || relPath.startsWith('/')) {
    throw new Error(`Unsafe path rejected: absolute path "${relPath}" is not allowed`)
  }

  const normalizedRel = relPath.replaceAll('\\', '/')
  const segments = normalizedRel.split('/')
  if (segments.some((seg) => !seg || seg === '.' || seg === '..')) {
    throw new Error(`Unsafe path rejected: traversal segment in "${relPath}"`)
  }

  const base = resolve(targetDir)
  if (existsSync(base)) {
    const baseStat = lstatSync(base)
    if (baseStat.isSymbolicLink() || !baseStat.isDirectory()) {
      throw new Error(`Unsafe targetDir rejected: "${base}" must be a real directory`)
    }
  }

  const fullPath = resolve(base, normalizedRel)
  const relFromBase = relative(base, fullPath)
  if (
    !relFromBase ||
    relFromBase === '..' ||
    relFromBase.startsWith(`..${sep}`) ||
    isAbsolute(relFromBase)
  ) {
    throw new Error(`Unsafe path rejected: "${relPath}" escapes target directory`)
  }

  let current = base
  for (const part of segments) {
    current = join(current, part)
    if (existsSync(current)) {
      const stat = lstatSync(current)
      if (stat.isSymbolicLink()) {
        throw new Error(`Unsafe path rejected: symlink segment detected at "${relPath}"`)
      }
    }
  }

  if (existsSync(fullPath) && existsSync(base)) {
    const realBase = realpathSync(base)
    const realFull = realpathSync(fullPath)
    const realRel = relative(realBase, realFull)
    if (realRel === '..' || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) {
      throw new Error(`Unsafe path rejected: realpath of "${relPath}" escapes target directory`)
    }
  }

  return fullPath
}

export function slugifyHeader(title) {
  return String(title)
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function parseAddress(address) {
  if (typeof address !== 'string' || !address.trim()) {
    throw new AddressResolutionError(`address '${address}' must be a non-empty string`)
  }
  const hashCount = (address.match(/#/g) ?? []).length
  if (hashCount > 1) {
    throw new AddressResolutionError(`address '${address}' must contain at most one '#' separator`)
  }

  const [ref, headerPart] = hashCount === 1 ? address.split('#') : [address, undefined]
  if (!ref) throw new AddressResolutionError(`address '${address}' has no file before '#'`)
  if (headerPart === undefined) return { ref, headerPath: [] }

  const headerPath = headerPart.split('/')
  if (headerPath.some((segment) => segment.length === 0)) {
    throw new AddressResolutionError(`address '${address}' has an empty header segment`)
  }
  if (headerPath.length > MAX_LEVEL - MIN_LEVEL + 1) {
    throw new AddressResolutionError(
      `address '${address}' is too deep; addresses target H2 and H3 only`,
    )
  }
  return { ref, headerPath }
}

function scanHeaders(lines) {
  const hits = []
  let fence = null

  for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
    const line = lines[lineNumber]
    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/)
    if (fenceMatch) {
      const marker = fenceMatch[1][0]
      const length = fenceMatch[1].length
      if (!fence) fence = { marker, length }
      else if (
        fence.marker === marker &&
        length >= fence.length &&
        /^[ \t\r]*$/.test(line.slice(fenceMatch[0].length))
      ) {
        fence = null
      }
      continue
    }
    if (fence) continue

    const heading = line.match(/^(#{1,6})\s+(.*\S)\s*$/)
    if (heading) hits.push({ level: heading[1].length, title: heading[2], line: lineNumber })
  }
  return hits
}

export function parseMarkdownSections(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n')
  const headers = scanHeaders(lines)
  const sections = []
  let currentH2 = null

  for (let index = 0; index < headers.length; index++) {
    const heading = headers[index]
    if (heading.level < MIN_LEVEL || heading.level > MAX_LEVEL) {
      if (heading.level < MIN_LEVEL) currentH2 = null
      continue
    }

    const slug = slugifyHeader(heading.title)
    if (heading.level === 2) currentH2 = slug
    const headerPath =
      heading.level === 2 ? [slug] : currentH2 !== null ? [currentH2, slug] : [slug]
    const fullEnd =
      headers.slice(index + 1).find((next) => next.level <= heading.level)?.line ?? lines.length
    const ownEnd = headers[index + 1]?.line ?? lines.length

    sections.push({
      level: heading.level,
      title: heading.title,
      headerPath,
      headerLine: heading.line,
      text: lines.slice(heading.line, fullEnd).join('\n'),
      ownText: lines.slice(heading.line, ownEnd).join('\n'),
    })
  }
  return sections
}

export function resolveAddress(text, headerPath) {
  if (headerPath.length === 0) {
    throw new AddressResolutionError('a bare file resolves without section lookup')
  }

  const sections = parseMarkdownSections(text)
  const wanted = headerPath.join('/')
  const hits = sections.filter((section) => section.headerPath.join('/') === wanted)
  if (hits.length > 1) {
    throw new AddressResolutionError(
      `address '#${wanted}' is AMBIGUOUS: ${hits.length} sections match at lines ${hits.map((hit) => hit.headerLine + 1).join(', ')}`,
    )
  }
  if (hits.length === 1) return hits[0]

  const parentPath = headerPath.slice(0, -1).join('/')
  const candidates = sections
    .filter((section) => section.headerPath.slice(0, -1).join('/') === parentPath)
    .map((section) => section.headerPath.join('/'))
  throw new AddressResolutionError(
    `address '#${wanted}' matches no header. ` +
      (candidates.length > 0
        ? `Addressable sections under '${parentPath || '(top)'}': ${candidates.join(', ')}.`
        : `Addressable sections: ${sections.map((section) => section.headerPath.join('/')).join(', ') || '(none)'}.`),
  )
}

export function normalizeSectionText(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .trim()
    .replace(/\s+/g, ' ')
}

export function hashSectionText(text) {
  return createHash('sha256').update(normalizeSectionText(text)).digest('hex')
}

export function estimateTokens(text) {
  const raw = String(text ?? '')
  if (!raw.trim()) return 0
  const words = raw.trim().split(/\s+/).filter(Boolean).length
  const wordEstimate = Math.ceil(words * 1.3)
  const byteEstimate = Math.ceil(Buffer.byteLength(raw, 'utf8') / 4)
  return Math.max(wordEstimate, byteEstimate)
}

export function levenshteinDistance(a, b) {
  const left = String(a ?? '')
  const right = String(b ?? '')
  if (left === right) return 0
  if (left.length === 0) return right.length
  if (right.length === 0) return left.length

  const prev = Array.from({ length: right.length + 1 }, (_, idx) => idx)
  const curr = new Array(right.length + 1)

  for (let i = 0; i < left.length; i++) {
    curr[0] = i + 1
    for (let j = 0; j < right.length; j++) {
      const cost = left[i] === right[j] ? 0 : 1
      curr[j + 1] = Math.min(curr[j] + 1, prev[j + 1] + 1, prev[j] + cost)
    }
    for (let j = 0; j <= right.length; j++) prev[j] = curr[j]
  }
  return prev[right.length]
}

export function findClosestSlug(targetSlug, candidateSlugs = []) {
  const target = String(targetSlug ?? '').trim()
  if (!target || !Array.isArray(candidateSlugs) || candidateSlugs.length === 0) return null

  const targetTokens = new Set(target.split(/[-/]+/).filter(Boolean))
  let bestSlug = null
  let bestScore = Number.POSITIVE_INFINITY

  for (const rawCandidate of candidateSlugs) {
    const candidate = String(rawCandidate ?? '').trim()
    if (!candidate) continue
    const dist = levenshteinDistance(target, candidate)
    const candidateTokens = candidate.split(/[-/]+/).filter(Boolean)
    let sharedTokens = 0
    for (const token of candidateTokens) {
      if (targetTokens.has(token)) sharedTokens += 1
    }
    // Reward shared slug tokens while ordering by edit distance
    const score = dist - sharedTokens * 2
    if (score < bestScore) {
      bestScore = score
      bestSlug = candidate
    }
  }
  return bestSlug
}

const REGION_KEYWORDS = {
  identity: [
    'identity',
    'mission',
    'vision',
    'overview',
    'operating model',
    'operating-model',
    'purpose',
    'product',
    'about',
    'introduction',
    'what is',
    'repository policy',
  ],
  ontology: [
    'ontology',
    'vocabulary',
    'glossary',
    'concept',
    'taxonomy',
    'definition',
    'domain model',
    'schema',
    'guiding principle',
    'primitive',
    'terminology',
  ],
  terrain: [
    'terrain',
    'architecture',
    'directory',
    'structure',
    'layout',
    'path',
    'ownership',
    'boundary',
    'boundaries',
    'module',
    'package',
    'stack',
    'worktree',
    'repository',
    'codebase',
  ],
  actors: [
    'actor',
    'actors',
    'role',
    'roles',
    'seat',
    'seats',
    'agent',
    'agents',
    'persona',
    'squad',
    'team',
    'steering',
    'builder',
    'reviewer',
    'two-plane',
    'two plane',
    'maintainer',
  ],
  laws: [
    'law',
    'laws',
    'rule',
    'rules',
    'invariant',
    'policy',
    'governance',
    'constraint',
    'security',
    'safety',
    'review',
    'gate',
    'standard',
    'branch discipline',
    'must',
    'forbidden',
    'compliance',
    'workflow phase',
  ],
  history: [
    'history',
    'changelog',
    'migration',
    'lineage',
    'decision',
    'adr',
    'evolution',
    'retrospective',
    'ledger',
    'prior',
  ],
  state: [
    'state',
    'status',
    'lifecycle',
    'phase',
    'configuration',
    'config',
    'lock',
    'durable',
    'evidence',
    'board',
    'distribution',
  ],
  affordances: [
    'affordance',
    'affordances',
    'cli',
    'command',
    'commands',
    'tool',
    'tooling',
    'validation',
    'validator',
    'test',
    'testing',
    'verification',
    'build',
    'run',
    'usage',
    'script',
    'execution target',
    'skill',
  ],
}

const DIMENSION_KEYWORDS = {
  product: [
    'product',
    'mission',
    'vision',
    'customer',
    'user',
    'goal',
    'specification',
    'overview',
    'feature',
  ],
  topology: [
    'topology',
    'plane',
    'two-plane',
    'seat',
    'role',
    'squad',
    'rig',
    'multi-agent',
    'delegation',
    'actor',
  ],
  context: [
    'context',
    'world',
    'prime',
    'markdown',
    'pointer',
    'manifest',
    'reading order',
    'knowledge',
  ],
  skill: ['skill', 'skills', 'adapter', 'capability', 'method', 'plugin', 'instruction'],
  'queue/custody': [
    'queue',
    'custody',
    'handoff',
    'dispatch',
    'inbox',
    'lease',
    'lock',
    'ownership',
    'oracle',
  ],
  'source/worktree': [
    'source',
    'worktree',
    'branch',
    'git',
    'directory',
    'path',
    'repository',
    'stack',
    'layout',
  ],
  'proof/review': [
    'proof',
    'review',
    'test',
    'verification',
    'qa',
    'audit',
    'gate',
    'oracle',
    'evidence',
    'validation',
    'validator',
    'safety',
  ],
  'lifecycle/release': [
    'lifecycle',
    'release',
    'version',
    'phase',
    'workflow',
    'issue',
    'pr',
    'governance',
    'publish',
  ],
  'continuity/recovery': [
    'continuity',
    'recovery',
    'restore',
    'compaction',
    'resume',
    'rollback',
    'doctor',
    'journal',
    'handover',
  ],
  'host-boundary': [
    'host',
    'boundary',
    'environment',
    'runtime',
    'sandbox',
    'permission',
    'security',
    'secret',
    'platform',
    'target',
    'distribution',
  ],
}

export function classifySection(title, text, file = '') {
  const headingLower = String(title ?? '').toLowerCase()
  const bodyLower = String(text ?? '').toLowerCase()
  const fileLower = String(file ?? '').toLowerCase()

  const regionScores = new Map()
  for (const region of OPENRIG_REGIONS) {
    let score = 0
    for (const kw of REGION_KEYWORDS[region]) {
      if (headingLower.includes(kw)) score += 4
      else if (bodyLower.includes(kw)) score += 1
    }
    if (score > 0) regionScores.set(region, score)
  }

  if (regionScores.size === 0) {
    if (fileLower.includes('product') || fileLower.includes('readme')) {
      regionScores.set('identity', 1)
    } else if (fileLower.includes('stack')) {
      regionScores.set('terrain', 1)
    } else {
      regionScores.set('ontology', 1)
    }
  }

  const sortedRegions = [...regionScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([region]) => region)

  const dimensions = []
  for (const dim of COVERAGE_DIMENSIONS) {
    for (const kw of DIMENSION_KEYWORDS[dim]) {
      if (headingLower.includes(kw) || bodyLower.includes(kw)) {
        dimensions.push(dim)
        break
      }
    }
  }

  return {
    regions: sortedRegions,
    dimensions,
  }
}

export function detectVolatileMarkers(text) {
  const markers = []
  const body = String(text ?? '')
  if (/\bcurrently\b/i.test(body)) {
    markers.push('Contains volatile temporal marker "currently" (prefer derived live facts).')
  }
  if (/\bas of right now\b/i.test(body)) {
    markers.push('Contains volatile temporal marker "as of right now".')
  }
  if (/\bthere are \d+\s+[a-z]+/i.test(body)) {
    markers.push('Contains hardcoded count ("there are <N> ..."); prefer deriving counts.')
  }
  return markers
}

function unquoteYamlScalar(raw) {
  const trimmed = String(raw ?? '').trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  return trimmed
}

function quoteYamlScalar(value) {
  const str = String(value ?? '')
  if (
    str === '' ||
    /[:#[\]{}&*!|>'"%@`]/.test(str) ||
    /^\s|\s$/.test(str) ||
    /^(?:true|false|null|~|\d+)$/i.test(str)
  ) {
    return JSON.stringify(str)
  }
  return str
}

export function serializeWorldManifestYaml(manifest) {
  const lines = [
    `schema: ${quoteYamlScalar(manifest.schema || 'openrig.context-pack/v1')}`,
    `name: ${quoteYamlScalar(manifest.name || 'project-world')}`,
    `taxonomy: ${quoteYamlScalar(manifest.taxonomy || 'world')}`,
    `description: ${quoteYamlScalar(manifest.description || 'Zero-copy addressable world manifest')}`,
    'atoms:',
  ]

  for (const atom of manifest.atoms || []) {
    lines.push(`  - id: ${quoteYamlScalar(atom.id)}`)
    if (atom.address !== undefined) {
      lines.push(`    address: ${quoteYamlScalar(atom.address)}`)
    }
    if (atom.taxonomy !== undefined) {
      lines.push(`    taxonomy: ${quoteYamlScalar(atom.taxonomy)}`)
    }
    if (Array.isArray(atom.regions) && atom.regions.length > 0) {
      lines.push('    regions:')
      for (const r of atom.regions) {
        lines.push(`      - ${quoteYamlScalar(r)}`)
      }
    }
    if (Array.isArray(atom.situations) && atom.situations.length > 0) {
      lines.push('    situations:')
      for (const s of atom.situations) {
        lines.push(`      - ${quoteYamlScalar(s)}`)
      }
    }
    if (atom.purpose !== undefined) {
      lines.push(`    purpose: ${quoteYamlScalar(atom.purpose)}`)
    }
    if (atom.runtime !== undefined) {
      lines.push(`    runtime: ${quoteYamlScalar(atom.runtime)}`)
    }
    if (atom.order !== undefined) {
      lines.push(`    order: ${Number(atom.order)}`)
    }
    if (atom.priority !== undefined) {
      lines.push(`    priority: ${quoteYamlScalar(atom.priority)}`)
    }
    if (Array.isArray(atom.requires) && atom.requires.length > 0) {
      lines.push('    requires:')
      for (const req of atom.requires) {
        lines.push(`      - ${quoteYamlScalar(req)}`)
      }
    }
    if (atom.profile_only !== undefined) {
      lines.push(`    profile_only: ${Boolean(atom.profile_only)}`)
    }
    if (atom.probe && typeof atom.probe === 'object') {
      lines.push('    probe:')
      lines.push(`      prompt: ${quoteYamlScalar(atom.probe.prompt || '')}`)
      lines.push(`      expect: ${quoteYamlScalar(atom.probe.expect || '')}`)
      if (Array.isArray(atom.probe.expectedPatterns)) {
        lines.push('      expectedPatterns:')
        for (const pat of atom.probe.expectedPatterns) {
          lines.push(`        - ${quoteYamlScalar(pat)}`)
        }
      }
    }
    // Preserve any extra keys if caller passed them so validation/serialization stays transparent
    for (const key of Object.keys(atom)) {
      if (!ALLOWED_ATOM_KEYS.includes(key)) {
        lines.push(`    ${key}: ${quoteYamlScalar(atom[key])}`)
      }
    }
  }

  return `${lines.join('\n')}\n`
}

export function parseWorldManifestYaml(rawYaml) {
  const lines = String(rawYaml ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
  const manifest = {
    schema: 'openrig.context-pack/v1',
    name: 'project-world',
    taxonomy: 'world',
    description: '',
    atoms: [],
  }

  let currentAtom = null
  let activeListKey = null
  let inProbe = false
  let inExpectedPatterns = false

  for (const rawLine of lines) {
    const trimmed = rawLine.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const topMatch = rawLine.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/)
    if (topMatch) {
      const [, key, val] = topMatch
      if (key === 'atoms') {
        currentAtom = null
        activeListKey = null
        inProbe = false
        inExpectedPatterns = false
        continue
      }
      manifest[key] = unquoteYamlScalar(val)
      continue
    }

    const atomStart = rawLine.match(/^\s{2}-\s+([a-zA-Z0-9_-]+):\s*(.*)$/)
    if (atomStart) {
      if (currentAtom) manifest.atoms.push(currentAtom)
      currentAtom = {}
      const [, firstKey, firstVal] = atomStart
      currentAtom[firstKey] = unquoteYamlScalar(firstVal)
      activeListKey = null
      inProbe = false
      inExpectedPatterns = false
      continue
    }

    if (!currentAtom) continue

    const propMatch = rawLine.match(/^\s{4}([a-zA-Z0-9_-]+):\s*(.*)$/)
    if (propMatch) {
      const [, key, rawVal] = propMatch
      const val = rawVal.trim()
      activeListKey = null
      inExpectedPatterns = false

      if (key === 'probe') {
        inProbe = true
        currentAtom.probe = { prompt: '', expect: '', expectedPatterns: [] }
        continue
      }
      inProbe = false

      if (val === '') {
        currentAtom[key] = []
        activeListKey = key
        continue
      }

      if (val.startsWith('[') && val.endsWith(']')) {
        const inner = val.slice(1, -1).trim()
        currentAtom[key] = inner
          ? inner.split(',').map((item) => unquoteYamlScalar(item.trim()))
          : []
        continue
      }

      if (key === 'order' && /^\d+$/.test(val)) {
        currentAtom[key] = Number(val)
      } else if (key === 'profile_only' && (val === 'true' || val === 'false')) {
        currentAtom[key] = val === 'true'
      } else {
        currentAtom[key] = unquoteYamlScalar(val)
      }
      continue
    }

    if (activeListKey && /^\s{6}-\s*(.+)$/.test(rawLine)) {
      const itemVal = unquoteYamlScalar(rawLine.match(/^\s{6}-\s*(.+)$/)[1])
      if (!Array.isArray(currentAtom[activeListKey])) currentAtom[activeListKey] = []
      currentAtom[activeListKey].push(itemVal)
      continue
    }

    if (inProbe) {
      const probeProp = rawLine.match(/^\s{6}([a-zA-Z0-9_-]+):\s*(.*)$/)
      if (probeProp) {
        const [, pKey, pRawVal] = probeProp
        const pVal = pRawVal.trim()
        if (pKey === 'expectedPatterns') {
          if (pVal.startsWith('[') && pVal.endsWith(']')) {
            const inner = pVal.slice(1, -1).trim()
            currentAtom.probe.expectedPatterns = inner
              ? inner.split(',').map((item) => unquoteYamlScalar(item.trim()))
              : []
            inExpectedPatterns = false
          } else {
            currentAtom.probe.expectedPatterns = []
            inExpectedPatterns = true
          }
        } else {
          inExpectedPatterns = false
          currentAtom.probe[pKey] = unquoteYamlScalar(pVal)
        }
        continue
      }

      if (inExpectedPatterns && /^\s{8}-\s*(.+)$/.test(rawLine)) {
        const pat = unquoteYamlScalar(rawLine.match(/^\s{8}-\s*(.+)$/)[1])
        currentAtom.probe.expectedPatterns.push(pat)
        continue
      }
    }
  }

  if (currentAtom) manifest.atoms.push(currentAtom)
  return manifest
}

export function loadL1CoveredDimensions(targetDir = packageRoot) {
  const candidates = [
    join(resolve(targetDir), 'adapters/openrig/agentflow-world/manifest.yaml'),
    join(packageRoot, 'adapters/openrig/agentflow-world/manifest.yaml'),
  ]
  const l1Dimensions = new Set()
  const l1Regions = new Set()

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    try {
      const parsed = parseWorldManifestYaml(readFileSync(candidate, 'utf8'))
      for (const atom of parsed.atoms) {
        const rList = Array.isArray(atom.regions) ? atom.regions : atom.region ? [atom.region] : []
        for (const r of rList) l1Regions.add(r)
        const addressOrSource = atom.address || atom.source || ''
        const purposeOrSummary = atom.purpose || atom.summary || ''
        const text = `${atom.id || ''} ${purposeOrSummary} ${addressOrSource} ${rList.join(' ')}`
        const { dimensions } = classifySection(atom.id || '', text, addressOrSource)
        for (const dim of dimensions) l1Dimensions.add(dim)
      }
      break
    } catch {
      // ignore fallback errors
    }
  }
  return { l1Dimensions, l1Regions }
}

export function scanWorld(targetDir, { include = [] } = {}) {
  const root = resolve(targetDir)
  const extraFiles = Array.isArray(include) ? include : []
  for (const inc of extraFiles) {
    resolveContainedPath(root, inc)
  }

  const candidateFiles = [...DEFAULT_SCAN_FILES, ...extraFiles]
  try {
    const gapsFull = resolveContainedPath(root, '.agentflow/world/gaps.md')
    if (existsSync(gapsFull)) {
      candidateFiles.push('.agentflow/world/gaps.md')
    }
  } catch {
    // ignore if symlinked; validateWorldQuality will catch unsafe paths
  }
  const uniqueFiles = [...new Set(candidateFiles.map((f) => String(f).replaceAll('\\', '/')))]

  const files = []
  const sections = []

  for (const relPath of uniqueFiles) {
    const fullPath = resolveContainedPath(root, relPath)
    if (!existsSync(fullPath)) continue
    const content = readFileSync(fullPath, 'utf8')
    const parsedSections = parseMarkdownSections(content)

    let h2Count = 0
    let h3Count = 0
    for (const sec of parsedSections) {
      if (sec.level === 2) h2Count += 1
      if (sec.level === 3) h3Count += 1
      const slug = sec.headerPath.join('/')
      const address = `${relPath}#${slug}`
      const tokens = estimateTokens(sec.text)
      const sectionSha256 = hashSectionText(sec.text)
      const { regions, dimensions } = classifySection(sec.title, sec.text, relPath)
      const volatileMarkers = detectVolatileMarkers(sec.text)
      const hasTodo = /\bTODO\b/i.test(sec.text)

      sections.push({
        file: relPath,
        address,
        title: sec.title,
        level: sec.level,
        slug,
        headerPath: sec.headerPath,
        line: sec.headerLine + 1,
        tokens,
        sectionSha256,
        regions,
        dimensions,
        volatileMarkers,
        hasTodo,
      })
    }

    files.push({
      file: relPath,
      bytes: Buffer.byteLength(content, 'utf8'),
      tokens: estimateTokens(content),
      h2Count,
      h3Count,
      sectionCount: parsedSections.length,
    })
  }

  const regionCoverage = {}
  for (const region of OPENRIG_REGIONS) {
    const matching = sections.filter((s) => s.regions.includes(region))
    regionCoverage[region] = {
      count: matching.length,
      addresses: matching.map((s) => s.address),
      covered: matching.length > 0,
    }
  }

  const missingCoreRegions = CORE_REGIONS.filter((region) => !regionCoverage[region]?.covered)

  const { l1Dimensions } = loadL1CoveredDimensions(root)
  const dimensionCoverage = {}
  for (const dim of COVERAGE_DIMENSIONS) {
    const matching = sections.filter((s) => s.dimensions.includes(dim))
    const l1Credited = l1Dimensions.has(dim)
    dimensionCoverage[dim] = {
      l1Credited,
      l2Count: matching.length,
      addresses: matching.map((s) => s.address),
      covered: l1Credited || matching.length > 0,
    }
  }

  return {
    targetDir: root,
    zeroProseCopied: true,
    files,
    sections,
    regionCoverage,
    missingCoreRegions,
    dimensionCoverage,
  }
}

export function getByKeyPath(obj, keyPath) {
  if (!obj || typeof obj !== 'object' || typeof keyPath !== 'string') return undefined
  if (Object.hasOwn(obj, keyPath)) return obj[keyPath]
  const parts = keyPath.split('.')
  let current = obj
  for (const part of parts) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, part)) {
      return undefined
    }
    current = current[part]
  }
  return current
}

function readJsonIfPresent(root, relPath) {
  try {
    const full = resolveContainedPath(root, relPath)
    if (!existsSync(full)) return null
    return JSON.parse(readFileSync(full, 'utf8'))
  } catch {
    return null
  }
}

export function extractOperationalClaims(targetDir) {
  const root = resolve(targetDir)
  const claims = []

  const workflow = readJsonIfPresent(root, 'agent-workflow.config.json')
  if (workflow && typeof workflow === 'object' && !Array.isArray(workflow)) {
    if (workflow.ciCommands !== undefined) {
      claims.push({
        id: 'workflow.ciCommands',
        file: 'agent-workflow.config.json',
        key: 'ciCommands',
        expected: workflow.ciCommands,
      })
    }
    if (workflow.testCommand !== undefined) {
      claims.push({
        id: 'workflow.testCommand',
        file: 'agent-workflow.config.json',
        key: 'testCommand',
        expected: workflow.testCommand,
      })
    }
    if (workflow.posture !== undefined) {
      claims.push({
        id: 'workflow.posture',
        file: 'agent-workflow.config.json',
        key: 'posture',
        expected: workflow.posture,
      })
    }
  }

  const sdlcPath = existsSync(join(root, 'sdlc.config.json'))
    ? 'sdlc.config.json'
    : existsSync(join(root, '.agentflow/sdlc.config.json'))
      ? '.agentflow/sdlc.config.json'
      : null

  if (sdlcPath) {
    const sdlc = readJsonIfPresent(root, sdlcPath)
    if (sdlc && typeof sdlc === 'object' && !Array.isArray(sdlc)) {
      if (sdlc.allowsSelfReview !== undefined) {
        claims.push({
          id: 'sdlc.allowsSelfReview',
          file: sdlcPath,
          key: 'allowsSelfReview',
          expected: sdlc.allowsSelfReview,
        })
      }
      if (sdlc.ciCommands !== undefined) {
        claims.push({
          id: 'sdlc.ciCommands',
          file: sdlcPath,
          key: 'ciCommands',
          expected: sdlc.ciCommands,
        })
      }
      if (sdlc.posture !== undefined) {
        claims.push({
          id: 'sdlc.posture',
          file: sdlcPath,
          key: 'posture',
          expected: sdlc.posture,
        })
      }
    }
  }

  const pkg = readJsonIfPresent(root, 'package.json')
  if (pkg && typeof pkg === 'object' && !Array.isArray(pkg)) {
    if (typeof pkg.scripts?.test === 'string') {
      claims.push({
        id: 'package.scripts.test',
        file: 'package.json',
        key: 'scripts.test',
        expected: pkg.scripts.test,
      })
    }
  }

  if (existsSync(join(root, 'Cargo.toml'))) {
    claims.push({
      id: 'cargo.manifest',
      file: 'Cargo.toml',
      key: '[package]',
      expected: true,
    })
  }

  return claims
}

function buildProbeForSection(section, primaryRegion) {
  const words = String(section.title ?? '')
    .replace(/[`*_~]/g, '')
    .split(/[^a-zA-Z0-9]+/)
    .filter((w) => w.length >= 3)
    .slice(0, 2)
  const patterns = words.length > 0 ? words : [primaryRegion]
  return {
    prompt: `What does section "${section.title}" (${section.address}) define for ${primaryRegion}?`,
    expect: `Establishes ${section.title} in ${section.file} for ${primaryRegion}.`,
    expectedPatterns: patterns,
  }
}

function buildGapStubMarkdown(missingRegions, { withTodo = false } = {}) {
  const lines = [
    '# World Knowledge Gaps',
    '',
    'Addressable domain stubs for missing OpenRig core regions.',
    '',
  ]
  for (const region of missingRegions) {
    const title = `${region.charAt(0).toUpperCase()}${region.slice(1)}`
    lines.push(`## ${title}`)
    lines.push('')
    if (withTodo) {
      lines.push(`TODO: Document project-specific ${region} conventions and boundaries.`)
    } else {
      lines.push(
        `Project ${region} domain conventions and operational boundaries for this repository.`,
      )
    }
    lines.push('')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

function makeAtomId(file, slug, seenIds) {
  const fileBase = basename(file, '.md')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const cleanSlug = String(slug)
    .replace(/\//g, '-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const baseId =
    fileBase === 'agents' || fileBase === 'readme'
      ? `${fileBase}-${cleanSlug}`
      : `${fileBase}-${cleanSlug}`
  let candidate = baseId || 'atom'
  let counter = 2
  while (seenIds.has(candidate)) {
    candidate = `${baseId}-${counter}`
    counter += 1
  }
  seenIds.add(candidate)
  return candidate
}

export function validateWorldQuality(
  targetDir,
  manifest,
  lock = null,
  { allowStubs = false, virtualFiles = {} } = {},
) {
  const root = resolve(targetDir)
  const errors = []
  const warnings = []

  const atoms = Array.isArray(manifest?.atoms) ? manifest.atoms : []
  const coveredRegions = new Set()
  const resolvedSectionHashes = new Map()

  const readTargetText = (relPath) => {
    const norm = String(relPath).replaceAll('\\', '/')
    const full = resolveContainedPath(root, norm)
    if (Object.hasOwn(virtualFiles, norm) && typeof virtualFiles[norm] === 'string') {
      return virtualFiles[norm]
    }
    if (!existsSync(full)) return null
    return readFileSync(full, 'utf8')
  }

  for (const atom of atoms) {
    const atomId = atom?.id || '(unnamed-atom)'
    for (const key of Object.keys(atom || {})) {
      if (!ALLOWED_ATOM_KEYS.includes(key)) {
        errors.push({
          code: 'disallowed-atom-key',
          atomId,
          target: atom.address || '.agentflow/world/manifest.yaml',
          message: `Atom "${atomId}" contains disallowed key "${key}" outside OpenRig ALLOWED_ATOM_KEYS.`,
        })
      }
    }

    const atomRegions = Array.isArray(atom?.regions)
      ? atom.regions
      : typeof atom?.region === 'string' && atom.region
        ? [atom.region]
        : []
    for (const r of atomRegions) coveredRegions.add(r)

    const isCore = atom?.priority === 'core' || atomRegions.some((r) => CORE_REGIONS.includes(r))

    if (isCore) {
      const probe = atom?.probe
      const hasPrompt = typeof probe?.prompt === 'string' && probe.prompt.trim().length > 0
      const hasExpect = typeof probe?.expect === 'string' && probe.expect.trim().length > 0
      const hasPatterns =
        Array.isArray(probe?.expectedPatterns) && probe.expectedPatterns.length > 0
      if (!hasPrompt || !hasExpect || !hasPatterns) {
        errors.push({
          code: 'invalid-core-probe',
          atomId,
          target: atom?.address || atomId,
          message: `Core atom "${atomId}" is missing a complete probe (prompt, expect, expectedPatterns).`,
        })
      } else {
        for (const pat of probe.expectedPatterns) {
          if (typeof pat !== 'string' || !pat.trim()) {
            errors.push({
              code: 'invalid-core-probe',
              atomId,
              target: atom?.address || atomId,
              message: `Core atom "${atomId}" has an empty expectedPatterns entry.`,
            })
            break
          }
          try {
            new RegExp(pat)
          } catch (err) {
            errors.push({
              code: 'invalid-core-probe',
              atomId,
              target: atom?.address || atomId,
              message: `Core atom "${atomId}" has uncompilable probe regex "${pat}": ${err.message}`,
            })
          }
        }
      }
    } else if (atom?.probe && Array.isArray(atom.probe.expectedPatterns)) {
      for (const pat of atom.probe.expectedPatterns) {
        try {
          new RegExp(pat)
        } catch (err) {
          errors.push({
            code: 'invalid-probe-regex',
            atomId,
            target: atom?.address || atomId,
            message: `Atom "${atomId}" has uncompilable probe regex "${pat}": ${err.message}`,
          })
        }
      }
    }

    const address = atom?.address ?? atom?.source
    if (typeof address !== 'string' || !address.trim()) {
      errors.push({
        code: 'unresolved-address',
        atomId,
        target: '.agentflow/world/manifest.yaml',
        message: `Atom "${atomId}" is missing a valid address pointer.`,
      })
      continue
    }

    let parsedAddr
    try {
      parsedAddr = parseAddress(address)
    } catch (err) {
      errors.push({
        code: 'unresolved-address',
        atomId,
        target: address,
        message: `Atom "${atomId}" has invalid address "${address}": ${err.message}`,
      })
      continue
    }

    let fileText
    try {
      fileText = readTargetText(parsedAddr.ref)
    } catch (err) {
      errors.push({
        code: 'unresolved-address',
        atomId,
        target: address,
        message: `Atom "${atomId}" has unsafe address path "${parsedAddr.ref}": ${err.message}`,
      })
      continue
    }
    if (fileText === null) {
      errors.push({
        code: 'unresolved-address',
        atomId,
        target: address,
        message: `Atom "${atomId}" points to missing file "${parsedAddr.ref}".`,
      })
      continue
    }

    if (parsedAddr.headerPath.length === 0) {
      const fileTokens = estimateTokens(fileText)
      const fileSections = parseMarkdownSections(fileText)
      if (fileTokens > 800 && fileSections.some((s) => s.level === 2)) {
        warnings.push({
          code: 'whole-file-over-budget',
          atomId,
          target: address,
          message: `Whole-file pointer "${address}" estimates ${fileTokens} tokens (> 800 limit) and contains H2 headings; prefer #h2-slug pointers.`,
        })
      }
      if (parsedAddr.ref.endsWith('gaps.md') && /\bTODO\b/i.test(fileText) && !allowStubs) {
        errors.push({
          code: 'unresolved-gap-todo',
          atomId,
          target: address,
          message: `Gap file "${parsedAddr.ref}" contains unresolved TODO markers (pass --allow-stubs to override).`,
        })
      }
      continue
    }

    try {
      const resolved = resolveAddress(fileText, parsedAddr.headerPath)
      const secHash = hashSectionText(resolved.text)
      if (resolvedSectionHashes.has(secHash)) {
        const otherAtomId = resolvedSectionHashes.get(secHash)
        warnings.push({
          code: 'near-duplicate-section',
          atomId,
          target: address,
          message: `Section "${address}" in atom "${atomId}" duplicates normalized content of atom "${otherAtomId}".`,
        })
      } else {
        resolvedSectionHashes.set(secHash, atomId)
      }

      for (const markerMsg of detectVolatileMarkers(resolved.text)) {
        warnings.push({
          code: 'volatile-marker',
          atomId,
          target: address,
          message: `${address}: ${markerMsg}`,
        })
      }

      if (parsedAddr.ref.endsWith('gaps.md') && /\bTODO\b/i.test(resolved.text) && !allowStubs) {
        errors.push({
          code: 'unresolved-gap-todo',
          atomId,
          target: address,
          message: `Gap section "${address}" contains unresolved TODO markers (pass --allow-stubs to override).`,
        })
      }
    } catch (err) {
      const allSections = parseMarkdownSections(fileText)
      const candidates = allSections.map((s) => s.headerPath.join('/'))
      const wanted = parsedAddr.headerPath.join('/')
      const closest = findClosestSlug(wanted, candidates)
      const suggestion = closest ? ` Suggested fix: ${parsedAddr.ref}#${closest}` : ''
      errors.push({
        code: err.message.includes('AMBIGUOUS') ? 'ambiguous-address' : 'unresolved-address',
        atomId,
        target: address,
        suggestedAddress: closest ? `${parsedAddr.ref}#${closest}` : null,
        message: `Atom "${atomId}" address "${address}" failed to resolve: ${err.message}${suggestion}`,
      })
    }
  }

  let gapsDiskText = null
  try {
    gapsDiskText = readTargetText('.agentflow/world/gaps.md')
  } catch (err) {
    errors.push({
      code: 'unresolved-address',
      atomId: 'gaps',
      target: '.agentflow/world/gaps.md',
      message: `Unsafe gaps path: ${err.message}`,
    })
  }
  if (
    gapsDiskText !== null &&
    /\bTODO\b/i.test(gapsDiskText) &&
    !allowStubs &&
    !errors.some((e) => e.code === 'unresolved-gap-todo')
  ) {
    errors.push({
      code: 'unresolved-gap-todo',
      atomId: 'gaps',
      target: '.agentflow/world/gaps.md',
      message:
        '.agentflow/world/gaps.md contains unresolved TODO markers (pass --allow-stubs to override).',
    })
  }

  for (const coreRegion of CORE_REGIONS) {
    if (!coveredRegions.has(coreRegion)) {
      errors.push({
        code: 'missing-core-region',
        atomId: null,
        target: coreRegion,
        message: `Missing required OpenRig core region "${coreRegion}". Add a matching H2/H3 section or run with --stub-gaps.`,
      })
    }
  }

  if (lock && Array.isArray(lock.claims)) {
    for (const claim of lock.claims) {
      const claimId = claim?.id || claim?.key || 'unknown-claim'
      const file = claim?.file || claim?.source
      const key = claim?.key
      if (!file || !key) {
        errors.push({
          code: 'broken-claim-source',
          atomId: claimId,
          target: file || 'world-lock.json',
          message: `Operational claim "${claimId}" is missing file or key binding.`,
        })
        continue
      }
      let fullPath
      try {
        fullPath = resolveContainedPath(root, file)
      } catch (err) {
        errors.push({
          code: 'broken-claim-source',
          atomId: claimId,
          target: file,
          message: `Operational claim "${claimId}" has unsafe file path "${file}": ${err.message}`,
        })
        continue
      }
      if (!existsSync(fullPath)) {
        errors.push({
          code: 'broken-claim-source',
          atomId: claimId,
          target: file,
          message: `Operational claim "${claimId}" references missing file "${file}".`,
        })
        continue
      }
      if (file.endsWith('.json')) {
        const parsed = readJsonIfPresent(root, file)
        if (!parsed || typeof parsed !== 'object') {
          errors.push({
            code: 'broken-claim-source',
            atomId: claimId,
            target: file,
            message: `Operational claim "${claimId}" references invalid JSON file "${file}".`,
          })
          continue
        }
        const actual = getByKeyPath(parsed, key)
        if (actual === undefined) {
          errors.push({
            code: 'broken-claim-source',
            atomId: claimId,
            target: `${file}#${key}`,
            message: `Operational claim "${claimId}" key "${key}" does not exist in "${file}".`,
          })
        } else if (
          claim.expected !== undefined &&
          JSON.stringify(actual) !== JSON.stringify(claim.expected)
        ) {
          errors.push({
            code: 'broken-claim-source',
            atomId: claimId,
            target: `${file}#${key}`,
            message: `Operational claim "${claimId}" drifted in "${file}": expected ${JSON.stringify(claim.expected)}, found ${JSON.stringify(actual)}.`,
          })
        }
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
  }
}

export function refineWorld(
  targetDir,
  {
    include = [],
    stubGaps = false,
    allowStubs = false,
    todoStubs = false,
    generatedAt = null,
  } = {},
) {
  const root = resolve(targetDir)
  const scan = scanWorld(root, { include })
  const repoName =
    basename(root)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'project'

  const sections = [...scan.sections]
  const virtualFiles = {}
  let gapsContent = null

  if (scan.missingCoreRegions.length > 0) {
    gapsContent = buildGapStubMarkdown(scan.missingCoreRegions, { withTodo: todoStubs })
    if (stubGaps) {
      virtualFiles['.agentflow/world/gaps.md'] = gapsContent
      const gapSections = parseMarkdownSections(gapsContent)
      for (const sec of gapSections) {
        const slug = sec.headerPath.join('/')
        const address = `.agentflow/world/gaps.md#${slug}`
        const regionName = slug.toLowerCase()
        const regions = OPENRIG_REGIONS.includes(regionName) ? [regionName] : ['identity']
        sections.push({
          file: '.agentflow/world/gaps.md',
          address,
          title: sec.title,
          level: sec.level,
          slug,
          headerPath: sec.headerPath,
          line: sec.headerLine + 1,
          tokens: estimateTokens(sec.text),
          sectionSha256: hashSectionText(sec.text),
          regions,
          dimensions: ['context'],
          volatileMarkers: [],
          hasTodo: /\bTODO\b/i.test(sec.text),
        })
      }
    }
  }

  const seenIds = new Set()
  const seenAddresses = new Set()
  const manifestAtoms = []
  const lockAtoms = {}
  let order = 1

  for (const section of sections) {
    if (seenAddresses.has(section.address)) continue
    seenAddresses.add(section.address)

    const id = makeAtomId(section.file, section.slug, seenIds)
    const primaryRegion = section.regions[0] || 'ontology'
    const isCore = section.regions.some((r) => CORE_REGIONS.includes(r))
    const priority = isCore ? 'core' : 'recommended'
    const situations = isCore ? ['fresh', 'handover', 'post-compaction'] : ['fresh', 'handover']

    const atom = {
      id,
      address: section.address,
      taxonomy: 'world',
      regions: section.regions,
      situations,
      purpose: `Section "${section.title}" in ${section.file} covering ${section.regions.join(', ')}.`,
      order: order++,
      priority,
      probe: buildProbeForSection(section, primaryRegion),
    }

    manifestAtoms.push(atom)
    lockAtoms[id] = {
      address: section.address,
      sectionSha256: section.sectionSha256,
      tokens: section.tokens,
    }
  }

  const manifest = {
    schema: 'openrig.context-pack/v1',
    name: `${repoName}-world`,
    taxonomy: 'world',
    description: `Zero-copy addressable world manifest for ${repoName}`,
    atoms: manifestAtoms,
  }

  const existingLock = readJsonIfPresent(root, '.agentflow/world/world-lock.json')
  const claims = extractOperationalClaims(root)
  const lock = {
    version: 1,
    generatedAt: generatedAt || existingLock?.generatedAt || '2026-01-01T00:00:00.000Z',
    atoms: lockAtoms,
    claims,
  }

  const quality = validateWorldQuality(root, manifest, lock, {
    allowStubs,
    virtualFiles,
  })

  const manifestYaml = serializeWorldManifestYaml(manifest)
  const proposedGaps =
    scan.missingCoreRegions.length > 0
      ? {
          path: '.agentflow/world/gaps.md',
          missingRegions: scan.missingCoreRegions,
          stubbed: Boolean(stubGaps),
          content: gapsContent,
        }
      : null

  const digestPayload = {
    manifest,
    lock: {
      version: lock.version,
      atoms: lock.atoms,
      claims: lock.claims,
    },
    stubGaps: Boolean(stubGaps),
    gapsContent: stubGaps ? gapsContent : null,
  }
  const digest = recordDigest(digestPayload)

  return {
    targetDir: root,
    digest,
    manifest,
    manifestYaml,
    lock,
    proposedGaps,
    gapsContent: stubGaps ? gapsContent : null,
    quality,
    scan,
  }
}

export function applyWorld(
  targetDir,
  {
    confirm,
    stubGaps = false,
    allowStubs = false,
    todoStubs = false,
    include = [],
    generatedAt = null,
  } = {},
) {
  const root = resolve(targetDir)
  const plan = refineWorld(root, {
    include,
    stubGaps,
    allowStubs,
    todoStubs,
    generatedAt,
  })

  if (!confirm || confirm !== plan.digest) {
    throw new Error(
      `Confirmation digest mismatch: expected ${plan.digest}, received ${confirm || '(none)'}`,
    )
  }

  if (!plan.quality.ok) {
    const messages = plan.quality.errors.map((e) => e.message).join('; ')
    throw new Error(`World quality gate failed: ${messages}`)
  }

  const agentflowDir = resolveContainedPath(root, '.agentflow')
  mkdirSync(agentflowDir, { recursive: true })
  const worldDir = resolveContainedPath(root, '.agentflow/world')
  mkdirSync(worldDir, { recursive: true })
  // Re-verify after creation that neither .agentflow nor .agentflow/world is a symlink
  resolveContainedPath(root, '.agentflow/world')

  let writtenGapsPath = null
  if (stubGaps && plan.gapsContent) {
    const gapsFullPath = resolveContainedPath(root, '.agentflow/world/gaps.md')
    writeFileSync(gapsFullPath, plan.gapsContent, 'utf8')
    writtenGapsPath = '.agentflow/world/gaps.md'
  }

  const manifestFullPath = resolveContainedPath(root, '.agentflow/world/manifest.yaml')
  writeFileSync(manifestFullPath, plan.manifestYaml, 'utf8')

  const lockToWrite = {
    ...plan.lock,
    generatedAt: generatedAt || new Date().toISOString(),
  }
  const lockFullPath = resolveContainedPath(root, '.agentflow/world/world-lock.json')
  writeFileSync(lockFullPath, `${JSON.stringify(lockToWrite, null, 2)}\n`, 'utf8')

  return {
    ok: true,
    targetDir: root,
    digest: plan.digest,
    manifestPath: '.agentflow/world/manifest.yaml',
    lockPath: '.agentflow/world/world-lock.json',
    gapsPath: writtenGapsPath,
    quality: plan.quality,
  }
}

export function ackWorld(targetDir, { atomId = null, all = false } = {}) {
  const root = resolve(targetDir)
  const manifestFullPath = resolveContainedPath(root, '.agentflow/world/manifest.yaml')
  const lockFullPath = resolveContainedPath(root, '.agentflow/world/world-lock.json')

  if (!existsSync(manifestFullPath)) {
    throw new Error('World manifest not found at .agentflow/world/manifest.yaml')
  }
  if (!existsSync(lockFullPath)) {
    throw new Error('World lock not found at .agentflow/world/world-lock.json')
  }

  const manifest = parseWorldManifestYaml(readFileSync(manifestFullPath, 'utf8'))
  const lock = JSON.parse(readFileSync(lockFullPath, 'utf8'))
  lock.atoms = lock.atoms && typeof lock.atoms === 'object' ? lock.atoms : {}

  const targetAtoms =
    all || !atomId ? manifest.atoms : manifest.atoms.filter((a) => a.id === atomId)

  if (targetAtoms.length === 0) {
    throw new Error(`Unknown world atom: ${atomId}`)
  }

  const updatedAtoms = []
  for (const atom of targetAtoms) {
    const { ref, headerPath } = parseAddress(atom.address)
    const fileFullPath = resolveContainedPath(root, ref)
    if (!existsSync(fileFullPath)) {
      throw new Error(`Cannot acknowledge "${atom.id}": file "${ref}" does not exist`)
    }
    const fileText = readFileSync(fileFullPath, 'utf8')
    const sectionText =
      headerPath.length === 0 ? fileText : resolveAddress(fileText, headerPath).text

    const sectionSha256 = hashSectionText(sectionText)
    const tokens = estimateTokens(sectionText)

    lock.atoms[atom.id] = {
      address: atom.address,
      sectionSha256,
      tokens,
    }
    updatedAtoms.push(atom.id)
  }

  writeFileSync(lockFullPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8')

  return {
    ok: true,
    targetDir: root,
    updatedAtoms,
    lockPath: '.agentflow/world/world-lock.json',
    lock,
  }
}
