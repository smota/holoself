// Cross-space review inbox: pending proposal aggregation, near-duplicate grouping, conflict hints and atomic batch actions.
import { existsSync, readFileSync, readdirSync, rmSync, rmdirSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { normalizeProjectPath, readBindings } from '../bindings.mjs'
import { canonicalSort } from '../catalog.mjs'
import { ecosystemValidationErrors } from '../catalog/validation.mjs'
import { contradictionDigest } from '../context-selection.mjs'
import { readLink } from '../link/config.mjs'
import { withRegistryLock } from '../link/registry.mjs'
import { normalize, parseClaimBlocks, replaceClaimBlocks } from '../markdown/claim-blocks.mjs'
import { sections, tokenize } from '../markdown/text.mjs'
import { canonicalPath, samePath } from '../path-guard.mjs'
import { frontmatter } from '../policy/privacy-fields.mjs'
import { atomicWrite, hash, slash } from '../shared/fs.mjs'
import { readCatalog, scrubMessage } from '../web/server-helpers.mjs'
import { similarity } from './analysis.mjs'
import {
  UUID_PREFIX_RE,
  applyClaimChange,
  commitTimeToken,
  emptyTarget,
  findProposal,
  proposalChanges,
  proposalPreviewData,
  proposalProjectErrors,
  safeTarget,
  scanProposalStore,
  stateProposal
} from './store.mjs'

// Documented Jaccard token-similarity threshold on normalized claim text (matching src/proposals/analysis.mjs).
export const INBOX_DUPLICATE_THRESHOLD = 0.72
export const MAX_INBOX_BATCH_SIZE = 50
export const DEFAULT_INBOX_LIMIT = 200
export const MAX_INBOX_LIMIT = 500
export const MAX_CONFLICT_HINTS_PER_ITEM = 3
export const MAX_HINT_EXCERPT_CHARS = 200
export const MAX_DUPLICATE_REFS = 10

const SHA256_HEX_RE = /^[0-9a-f]{64}$/i

function inboxError(message, code, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra })
}

export function shortExcerpt(text, max = MAX_HINT_EXCERPT_CHARS) {
  const clean = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (clean.length <= max) return clean
  return `${clean.slice(0, Math.max(1, max - 1)).trimEnd()}…`
}

function tokenSetFromText(text) {
  return new Set(tokenize(text, { stopwords: false }))
}

function tokenSetSimilarity(aa, bb) {
  if (!aa.size && !bb.size) return 1
  if (!aa.size || !bb.size) return 0
  const [small, large] = aa.size <= bb.size ? [aa, bb] : [bb, aa]
  let both = 0
  for (const x of small) if (large.has(x)) both++
  return both / (aa.size + bb.size - both)
}

function shouldFailBatchItem(index) {
  return Boolean(process.env.NODE_TEST_CONTEXT) && Number(process.env.HOLOSELF_TEST_FAIL_BATCH_ITEM) === index + 1
}

export function resolveInboxSpaces(root, { space = 'all', spaces = null } = {}) {
  if (space !== undefined && space !== null && typeof space !== 'string')
    throw inboxError('space filter must be a string', 'INVALID_INPUT')
  let catalogByPath = new Map()
  if (!Array.isArray(spaces)) {
    try {
      const cat = readCatalog(root)
      if (Array.isArray(cat?.spaces)) {
        catalogByPath = new Map(cat.spaces.filter(s => s?.path && s?.id).map(s => [normalizeProjectPath(s.path), s.id]))
      }
    } catch {}
  }
  const catalogSpaces = Array.isArray(spaces)
      ? spaces.map(item => {
          const normPath = normalizeProjectPath(item.path)
          return {
            id: item.id || `space-${hash(normPath).slice(0, 12)}`,
            name: item.name || basename(item.path),
            path: resolve(item.path),
            lens: item.lens || 'general'
          }
        })
      : Object.entries(readBindings(root).bindings).map(([project, binding]) => {
          const normPath = normalizeProjectPath(project)
          return {
            id: catalogByPath.get(normPath) || `space-${hash(normPath).slice(0, 12)}`,
            name: basename(project),
            path: resolve(project),
            lens: binding.default_lens
          }
        }),
    filter = (space ?? 'all').trim()
  if (filter && filter !== 'all') {
    if (isAbsolute(filter)) throw inboxError('space not found', 'SPACE_NOT_FOUND')
    const byId = catalogSpaces.filter(item => item.id === filter),
      matched = byId.length ? byId : catalogSpaces.filter(item => item.name === filter)
    if (!matched.length) throw inboxError('space not found', 'SPACE_NOT_FOUND')
    return [...matched].sort((a, b) => canonicalSort(a.name, b.name) || canonicalSort(a.id, b.id))
  }
  return [...catalogSpaces].sort((a, b) => canonicalSort(a.name, b.name) || canonicalSort(a.id, b.id))
}

export function proposalNormalizedClaim(p) {
  return proposalChanges(p)
    .map(change => normalize(change.claim || ''))
    .filter(Boolean)
    .join(' ')
    .trim()
}

export function detectClaimContradiction(proposedClaim, existingClaim, relTarget, proposalRef = 'proposal', precomputedScore = null) {
  const pNums = [...new Set(String(proposedClaim).match(/\b\d+(?:\.\d+)?%?\b/g) || [])],
    sNums = [...new Set(String(existingClaim).match(/\b\d+(?:\.\d+)?%?\b/g) || [])]
  if (!pNums.length || !sNums.length) return null
  const score = precomputedScore !== null ? precomputedScore : similarity(proposedClaim, existingClaim)
  if (score < 0.35) return null
  const forward = contradictionDigest([
      { kind: 'project', path: proposalRef, content: `# ${relTarget}\n\n${proposedClaim}` },
      { kind: 'canonical', path: relTarget, content: `# ${relTarget}\n\n${existingClaim}` }
    ]),
    reverse = contradictionDigest([
      { kind: 'canonical', path: relTarget, content: `# ${relTarget}\n\n${existingClaim}` },
      { kind: 'canonical', path: proposalRef, content: `# ${relTarget}\n\n${proposedClaim}` }
    ])
  if (forward.potential_conflicts === 0 && reverse.potential_conflicts === 0) return null
  return {
    score: Number(score.toFixed(2)),
    proposed_numbers: pNums,
    existing_numbers: sNums,
    contradiction_digest: forward.digest,
    evidence: shortExcerpt(`related text has differing metrics (${pNums.join(', ')} vs ${sNums.join(', ')})`)
  }
}

export function computeDuplicateGroups(items, threshold = INBOX_DUPLICATE_THRESHOLD) {
  const prepared = items
    .map(item => {
      const norm = item._normClaim !== undefined ? item._normClaim : normalize(item.claim_preview || '')
      return {
        id: item.id,
        _normClaim: norm,
        _tokens: item._tokens instanceof Set ? item._tokens : norm ? tokenSetFromText(norm) : new Set()
      }
    })
    .filter(item => Boolean(item._normClaim))
    .sort((a, b) => canonicalSort(a._normClaim, b._normClaim) || canonicalSort(a.id, b.id))

  const pairSimilar = (a, b) => {
    if (a._normClaim === b._normClaim) return 1
    const minSize = Math.min(a._tokens.size, b._tokens.size),
      maxSize = Math.max(a._tokens.size, b._tokens.size)
    if (!maxSize || minSize / maxSize < threshold) return 0
    const sim = tokenSetSimilarity(a._tokens, b._tokens)
    return sim >= threshold ? sim : 0
  }

  // Complete-linkage clustering: a candidate joins a cluster only when it meets the threshold with every existing member.
  const clusters = []
  for (const item of prepared) {
    let bestCluster = null,
      bestScore = -1
    for (const cluster of clusters) {
      let minSim = Infinity,
        compatible = true
      for (const member of cluster) {
        const sim = pairSimilar(item, member)
        if (sim < threshold) {
          compatible = false
          break
        }
        if (sim < minSim) minSim = sim
      }
      if (compatible && minSim > bestScore) {
        bestScore = minSim
        bestCluster = cluster
      }
    }
    if (bestCluster) bestCluster.push(item)
    else clusters.push([item])
  }

  const byItemId = new Map()
  for (const members of clusters) {
    if (members.length < 2) continue
    const sortedMembers = [...members].sort((a, b) => canonicalSort(a.id, b.id)),
      canonicalNorms = [...new Set(sortedMembers.map(m => m._normClaim))].sort(canonicalSort),
      groupId = `dup-${hash(canonicalNorms.join('\n')).slice(0, 12)}`
    for (const member of sortedMembers) {
      byItemId.set(member.id, {
        group_id: groupId,
        duplicate_of: sortedMembers
          .filter(m => m.id !== member.id)
          .slice(0, MAX_DUPLICATE_REFS)
          .map(m => m.id)
      })
    }
  }
  return byItemId
}

function loadTargetAnalysis(root, targetCache, relTarget) {
  if (targetCache.has(relTarget)) return targetCache.get(relTarget)
  const empty = {
    validTarget: false,
    exists: false,
    allById: new Map(),
    byNorm: new Map(),
    withNums: []
  }
  let abs
  try {
    abs = safeTarget(root, relTarget)
  } catch {
    targetCache.set(relTarget, empty)
    return empty
  }
  if (!existsSync(abs)) {
    const missing = { ...empty, validTarget: true }
    targetCache.set(relTarget, missing)
    return missing
  }
  const raw = readFileSync(abs, 'utf8'),
    rawBlocks = parseClaimBlocks(raw, relTarget),
    allById = new Map(),
    byNorm = new Map(),
    withNums = []

  for (const block of rawBlocks) {
    if (block.claim_id) {
      if (!allById.has(block.claim_id)) allById.set(block.claim_id, [])
      allById.get(block.claim_id).push(block)
    }
    if (block.status === 'current' && !block.malformed && block.text) {
      const norm = normalize(block.text),
        excerpt = shortExcerpt(block.text)
      if (norm && !byNorm.has(norm)) byNorm.set(norm, { claim_id: block.claim_id || null, excerpt })
      const nums = [...new Set(String(block.text).match(/\b\d+(?:\.\d+)?%?\b/g) || [])]
      if (nums.length) {
        withNums.push({
          claim_id: block.claim_id || null,
          text: block.text,
          excerpt,
          norm,
          tokens: tokenSetFromText(block.text),
          nums
        })
      }
    }
  }

  const withoutBlocks = replaceClaimBlocks(frontmatter(raw, { tolerant: true }).body, () => '', { failClosed: false })
  for (const sec of sections(withoutBlocks)) {
    const text = sec.content?.trim()
    if (!text) continue
    const norm = normalize(text),
      excerpt = shortExcerpt(text)
    if (norm && !byNorm.has(norm)) byNorm.set(norm, { claim_id: null, excerpt })
    const nums = [...new Set(String(text).match(/\b\d+(?:\.\d+)?%?\b/g) || [])]
    if (nums.length) {
      withNums.push({
        claim_id: null,
        text,
        excerpt,
        norm,
        tokens: tokenSetFromText(text),
        nums
      })
    }
  }

  const entry = { validTarget: true, exists: true, allById, byNorm, withNums }
  targetCache.set(relTarget, entry)
  return entry
}

export function computeConflictHints(root, items, { allItems = items, targetCache = new Map() } = {}) {
  const byClaimId = new Map()
  for (const item of allItems) {
    for (const change of item._rawChanges || []) {
      if (!change.claim_id) continue
      const key = `${slash(change.target || 'context/claims.md')}\0${change.claim_id}`
      if (!byClaimId.has(key)) byClaimId.set(key, [])
      byClaimId.get(key).push({
        proposal_id: item.id,
        space: item.space,
        space_id: item.space_id,
        change_id: change.change_id,
        operation: change.operation || 'append_claim',
        target: slash(change.target || 'context/claims.md'),
        claim_id: change.claim_id
      })
    }
  }

  const hintsByItem = new Map()
  for (const item of items) {
    const candidates = []
    if (item._previewError) {
      candidates.push({
        kind: 'invalid_target_state',
        score: 1,
        code: item._previewError.code || 'INVALID_PROPOSAL',
        target: item.targets?.[0] || 'context/claims.md',
        claim_id: item._rawChanges?.find(c => c.claim_id)?.claim_id || null,
        detail: shortExcerpt(item._previewError.message)
      })
    }
    for (const change of item._rawChanges || []) {
      const relTarget = slash(change.target || 'context/claims.md'),
        op = change.operation || 'append_claim',
        targetData = loadTargetAnalysis(root, targetCache, relTarget)

      if (!targetData.validTarget) {
        candidates.push({
          kind: 'invalid_target_state',
          score: 1,
          code: 'INVALID_TARGET',
          target: relTarget,
          claim_id: change.claim_id || null,
          detail: shortExcerpt(`Invalid proposal target: ${relTarget}`)
        })
        continue
      }

      if (op !== 'append_claim' && change.claim_id && !item._previewError) {
        const found = targetData.allById.get(change.claim_id) || []
        if (!found.length) {
          candidates.push({
            kind: 'invalid_target_state',
            score: 1,
            code: 'CLAIM_NOT_FOUND',
            target: relTarget,
            claim_id: change.claim_id,
            detail: shortExcerpt(`claim not found in ${relTarget}: ${change.claim_id} (${change.change_id})`)
          })
        } else if (found.length > 1) {
          candidates.push({
            kind: 'invalid_target_state',
            score: 1,
            code: 'CLAIM_AMBIGUOUS',
            target: relTarget,
            claim_id: change.claim_id,
            detail: shortExcerpt(`claim id is ambiguous in ${relTarget}: ${change.claim_id} (${change.change_id})`)
          })
        } else if (found[0].malformed) {
          candidates.push({
            kind: 'invalid_target_state',
            score: 1,
            code: 'CLAIM_MALFORMED',
            target: relTarget,
            claim_id: change.claim_id,
            detail: shortExcerpt(`claim marker is malformed: ${change.claim_id} (${change.change_id})`)
          })
        } else if (found[0].status !== 'current') {
          candidates.push({
            kind: 'invalid_target_state',
            score: 1,
            code: 'CLAIM_NOT_CURRENT',
            target: relTarget,
            claim_id: change.claim_id,
            detail: shortExcerpt(`claim is already ${found[0].status}: ${change.claim_id} (${change.change_id})`)
          })
        }
      }

      if (change.claim_id) {
        const key = `${relTarget}\0${change.claim_id}`,
          competing = (byClaimId.get(key) || []).filter(other => other.proposal_id !== item.id || other.change_id !== change.change_id)
        for (const other of competing) {
          candidates.push({
            kind: 'competing_pending_claim',
            score: 1,
            target: relTarget,
            claim_id: change.claim_id,
            operation: op,
            conflicting_proposal_id: other.proposal_id,
            conflicting_space: other.space,
            conflicting_space_id: other.space_id,
            conflicting_operation: other.operation,
            detail: shortExcerpt(
              `Claim ${change.claim_id} in ${relTarget} is also targeted by pending proposal ${other.proposal_id} (${other.operation})`
            )
          })
        }
      }
      if (change.claim) {
        const normClaim = normalize(change.claim)
        if (normClaim) {
          const dup = targetData.byNorm.get(normClaim)
          if (dup && !(change.claim_id && dup.claim_id === change.claim_id && (op === 'replace_claim' || op === 'supersede_claim'))) {
            candidates.push({
              kind: 'duplicate_current_claim',
              score: 1,
              target: relTarget,
              claim_id: dup.claim_id || null,
              existing_claim: dup.excerpt,
              detail: shortExcerpt(`Duplicates existing current claim in ${relTarget}`)
            })
          }
        }
        const pNums = [...new Set(String(change.claim).match(/\b\d+(?:\.\d+)?%?\b/g) || [])]
        if (pNums.length && targetData.withNums.length) {
          const pTokens = tokenSetFromText(change.claim)
          if (pTokens.size) {
            for (const existing of targetData.withNums) {
              if (change.claim_id && existing.claim_id === change.claim_id && (op === 'replace_claim' || op === 'supersede_claim'))
                continue
              if (normClaim && existing.norm === normClaim) continue
              const minSize = Math.min(pTokens.size, existing.tokens.size),
                maxSize = Math.max(pTokens.size, existing.tokens.size)
              if (!maxSize || minSize / maxSize < 0.35) continue
              const sim = tokenSetSimilarity(pTokens, existing.tokens)
              if (sim < 0.35) continue
              const contradiction = detectClaimContradiction(
                change.claim,
                existing.text,
                relTarget,
                `${item.id}/${change.change_id}`,
                sim
              )
              if (contradiction) {
                candidates.push({
                  kind: 'contradicts_current_claim',
                  score: contradiction.score,
                  target: relTarget,
                  claim_id: existing.claim_id || null,
                  existing_claim: existing.excerpt,
                  contradiction_digest: contradiction.contradiction_digest,
                  evidence: shortExcerpt(contradiction.evidence),
                  detail: shortExcerpt(`Contradicts current claim in ${relTarget}: ${contradiction.evidence}`)
                })
              }
            }
          }
        }
      }
    }

    candidates.sort(
      (a, b) =>
        b.score - a.score ||
        canonicalSort(a.kind, b.kind) ||
        canonicalSort(a.target || '', b.target || '') ||
        canonicalSort(a.claim_id || '', b.claim_id || '') ||
        canonicalSort(a.detail || '', b.detail || '')
    )
    hintsByItem.set(item.id, candidates.slice(0, MAX_CONFLICT_HINTS_PER_ITEM))
  }
  return hintsByItem
}

function parsePaginationParam(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER, defaultValue = 0 } = {}) {
  if (value === undefined || value === null || value === '') return defaultValue
  if (typeof value === 'boolean' || (typeof value !== 'number' && typeof value !== 'string'))
    throw inboxError(`${name} must be an integer`, 'INVALID_INPUT')
  const str = String(value).trim()
  if (!/^\d+$/.test(str)) throw inboxError(`${name} must be an integer`, 'INVALID_INPUT')
  const num = Number(str)
  if (!Number.isInteger(num) || num < min || num > max)
    throw inboxError(`${name} must be an integer between ${min} and ${max}`, 'INVALID_INPUT')
  return num
}

export function buildReviewInbox(root, { space = 'all', spaces = null, limit = DEFAULT_INBOX_LIMIT, offset = 0, cursor = undefined } = {}) {
  const resolvedRoot = resolve(root),
    canonicalRoot = canonicalPath(resolvedRoot),
    limitNum = parsePaginationParam(limit, 'limit', { min: 1, max: MAX_INBOX_LIMIT, defaultValue: DEFAULT_INBOX_LIMIT }),
    offsetNum = parsePaginationParam(offset !== undefined && offset !== null && offset !== '' ? offset : cursor, 'offset', {
      min: 0,
      max: 1_000_000,
      defaultValue: 0
    }),
    selectedSpaces = resolveInboxSpaces(resolvedRoot, { space, spaces }),
    allKnownSpaces = resolveInboxSpaces(resolvedRoot, { space: 'all', spaces }),
    targetCache = new Map(),
    rawItems = [],
    diagnostics = []

  for (const s of selectedSpaces) {
    if (!existsSync(s.path) || !existsSync(join(s.path, '.holoself', 'link.yaml'))) continue
    const link = readLink(s.path)
    if (!samePath(canonicalPath(link.path), canonicalRoot))
      throw inboxError('linked space belongs to a different canonical self root', 'MIXED_SELF_ROOTS')
    const scan = scanProposalStore(s.path)
    for (const diag of scan.diagnostics) {
      diagnostics.push({
        space: s.name,
        space_id: s.id,
        path: slash(diag.path),
        code: diag.code,
        severity: diag.severity,
        suggested_action: diag.suggested_action,
        ...(diag.detail ? { detail: scrubMessage(diag.detail, [resolvedRoot, s.path]) } : {})
      })
    }
    for (const p of scan.managed) {
      if (p.status !== 'pending') continue
      const changes = proposalChanges(p),
        operations = changes.map(c => c.operation || 'append_claim'),
        targets = [
          ...new Set(
            changes.map(c => {
              try {
                return slash(relative(resolvedRoot, safeTarget(resolvedRoot, c.target || 'context/claims.md')))
              } catch {
                return slash(c.target || 'context/claims.md')
              }
            })
          )
        ],
        visibilityChanges = []

      for (const c of changes) {
        const op = c.operation || 'append_claim'
        if ((op === 'replace_claim' || op === 'supersede_claim') && c.claim_id && c.visibility) {
          const relTarget = slash(c.target || 'context/claims.md'),
            targetData = loadTargetAnalysis(resolvedRoot, targetCache, relTarget),
            found = targetData.allById.get(c.claim_id) || []
          if (found.length === 1 && found[0].visibility && found[0].visibility !== c.visibility) {
            visibilityChanges.push({ from: found[0].visibility, to: c.visibility })
          }
        }
      }

      const claimPreview = shortExcerpt(
          changes
            .map(c => (c.operation === 'retire_claim' ? `Retire ${c.claim_id}: ${c.reason}` : c.claim))
            .filter(Boolean)
            .join(' · '),
          240
        ),
        evidenceText = shortExcerpt(
          [...new Set(changes.map(c => scrubMessage(c.evidence || '', [resolvedRoot, s.path])).filter(Boolean))].join('; '),
          240
        ),
        normClaim = proposalNormalizedClaim(p)

      rawItems.push({
        id: p.proposal_id,
        proposal_id: p.proposal_id,
        space: s.name,
        space_id: s.id,
        title: shortExcerpt(p.title || claimPreview || p.proposal_id, 160),
        operation: operations[0] || 'append_claim',
        operations,
        target: targets.join(', '),
        targets,
        claim_preview: claimPreview,
        affected_files: targets,
        evidence: evidenceText,
        visibility_change: visibilityChanges[0] || null,
        visibility_changes: visibilityChanges,
        created_at: p.created_at,
        _normClaim: normClaim,
        _tokens: normClaim ? tokenSetFromText(normClaim) : new Set(),
        _rawChanges: changes
      })
    }
  }

  rawItems.sort(
    (a, b) =>
      canonicalSort(a.space, b.space) ||
      canonicalSort(a.space_id, b.space_id) ||
      canonicalSort(a.created_at, b.created_at) ||
      canonicalSort(a.id, b.id)
  )

  const total = rawItems.length,
    pagedRawItems = rawItems.slice(offsetNum, offsetNum + limitNum),
    truncated = offsetNum + pagedRawItems.length < total,
    nextOffset = truncated ? offsetNum + pagedRawItems.length : null,
    duplicateMap = computeDuplicateGroups(rawItems, INBOX_DUPLICATE_THRESHOLD),
    conflictMap = computeConflictHints(resolvedRoot, pagedRawItems, { allItems: rawItems, targetCache })

  const items = pagedRawItems.map(({ _normClaim, _tokens, _rawChanges, _previewError, ...item }) => {
    const dup = duplicateMap.get(item.id)
    return {
      ...item,
      duplicate_group: dup ? dup.group_id : null,
      duplicate_of: dup ? dup.duplicate_of : [],
      conflict_hints: conflictMap.get(item.id) || []
    }
  })

  const groups = [],
    groupedDupIds = new Set()
  for (const item of items) {
    if (!item.duplicate_group || groupedDupIds.has(item.duplicate_group)) continue
    groupedDupIds.add(item.duplicate_group)
    const itemIds = items.filter(x => x.duplicate_group === item.duplicate_group).map(x => x.id)
    groups.push({
      group_id: item.duplicate_group,
      kind: 'duplicate',
      space_id: null,
      label: `Near-duplicate group (${item.duplicate_group})`,
      item_ids: itemIds,
      items: itemIds
    })
  }
  const ungroupedBySpace = new Map()
  for (const item of items) {
    if (item.duplicate_group) continue
    if (!ungroupedBySpace.has(item.space_id)) {
      ungroupedBySpace.set(item.space_id, { space_id: item.space_id, space: item.space, item_ids: [] })
    }
    ungroupedBySpace.get(item.space_id).item_ids.push(item.id)
  }
  for (const entry of ungroupedBySpace.values()) {
    groups.push({
      group_id: `space-${entry.space_id}`,
      kind: 'space',
      space_id: entry.space_id,
      label: entry.space,
      item_ids: entry.item_ids,
      items: entry.item_ids
    })
  }

  return {
    items,
    groups,
    diagnostics,
    spaces: allKnownSpaces.map(s => ({ id: s.id, name: s.name, lens: s.lens || 'general' })),
    duplicate_similarity_threshold: INBOX_DUPLICATE_THRESHOLD,
    total,
    limit: limitNum,
    offset: offsetNum,
    truncated,
    next_offset: nextOffset
  }
}

function resolveBatchItemSpace(canonicalRoot, resolvedRoot, item, catalogSpaces, { allowAbsoluteSpace = false } = {}) {
  if (typeof item?.space !== 'string' || !item.space.trim())
    throw inboxError('batch item space must be a non-empty string', 'INVALID_INPUT')
  const ref = item.space.trim()
  if (isAbsolute(ref) && !allowAbsoluteSpace) {
    throw inboxError(`space not found: ${scrubMessage(ref, [resolvedRoot])}`, 'SPACE_NOT_FOUND')
  }
  const byId = catalogSpaces.filter(s => s.id === ref),
    byName = byId.length ? [] : catalogSpaces.filter(s => s.name === ref),
    byPath =
      !byId.length && !byName.length && allowAbsoluteSpace && isAbsolute(ref) && existsSync(ref)
        ? catalogSpaces.filter(s => samePath(canonicalPath(s.path), canonicalPath(ref)))
        : [],
    matched = byId.length ? byId : byName.length ? byName : byPath
  let chosen = null
  if (matched.length === 1) {
    chosen = matched[0]
  } else if (matched.length > 1) {
    for (const candidate of matched) {
      if (existsSync(join(candidate.path, '.holoself', 'link.yaml'))) {
        const candidateLink = readLink(candidate.path)
        if (!samePath(canonicalPath(candidateLink.path), canonicalRoot))
          throw inboxError('batch items must belong to the same canonical self root', 'MIXED_SELF_ROOTS')
      }
    }
    const proposalRef = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : item.proposal_id.trim(),
      withProposal = matched.filter(candidate => {
        try {
          findProposal(candidate.path, proposalRef)
          return true
        } catch {
          return false
        }
      })
    if (withProposal.length === 1) chosen = withProposal[0]
    else throw inboxError(`ambiguous space for proposal: ${scrubMessage(ref, [resolvedRoot])}`, 'AMBIGUOUS_SPACE')
  } else {
    throw inboxError(`space not found: ${scrubMessage(ref, [resolvedRoot])}`, 'SPACE_NOT_FOUND')
  }

  if (!existsSync(chosen.path) || !existsSync(join(chosen.path, '.holoself', 'link.yaml')))
    throw inboxError(`linked space is unavailable: ${chosen.name}`, 'SPACE_NOT_FOUND')
  const link = readLink(chosen.path)
  if (!samePath(canonicalPath(link.path), canonicalRoot))
    throw inboxError('batch items must belong to the same canonical self root', 'MIXED_SELF_ROOTS')
  return { space: chosen, link }
}

function missingTargetDirs(resolvedRoot, targetPath) {
  const dirs = []
  let dir = dirname(targetPath)
  while (dir.startsWith(resolvedRoot + sep) && dir !== resolvedRoot && !existsSync(dir)) {
    dirs.push(dir)
    dir = dirname(dir)
  }
  return dirs
}

function rollbackProposalEntries(resolvedRoot, resolvedItems, state, rollbackFailures) {
  for (const entry of resolvedItems) {
    try {
      atomicWrite(entry.proposal._path, entry.proposalBefore)
    } catch {
      rollbackFailures.push(`${entry.spaceName}/.holoself/proposals/${entry.proposal.proposal_id}.yaml`)
    }
    if (!entry.archiveExistedBefore && existsSync(entry.archive)) {
      try {
        rmSync(entry.archive)
      } catch {
        rollbackFailures.push(slash(relative(resolvedRoot, entry.archive)))
      }
    }
    if (!entry.receiptExistedBefore && existsSync(entry.receipt)) {
      try {
        rmSync(entry.receipt)
      } catch {
        rollbackFailures.push(slash(relative(resolvedRoot, entry.receipt)))
      }
    }
  }
}

export async function applyInboxBatch(
  root,
  { action, items, spaces = null, allowAbsoluteSpace = undefined, onItemApplied = null } = {}
) {
  if (!['approve', 'reject', 'defer'].includes(action))
    throw inboxError('batch action must be approve, reject, or defer', 'INVALID_INPUT')
  if (!Array.isArray(items) || !items.length)
    throw inboxError('batch items must be a non-empty array', 'INVALID_INPUT')
  if (items.length > MAX_INBOX_BATCH_SIZE)
    throw inboxError(`batch size exceeds maximum of ${MAX_INBOX_BATCH_SIZE}`, 'BATCH_TOO_LARGE')

  const isSingleCliSpaceList = Array.isArray(spaces) && spaces.length === 1 && !spaces[0]?.discoveredFrom,
    allowAbs = allowAbsoluteSpace !== undefined ? Boolean(allowAbsoluteSpace) : isSingleCliSpaceList

  let resolvedRoot = root ? resolve(root) : null
  if (!resolvedRoot) {
    const cliPath = isSingleCliSpaceList && typeof spaces[0]?.path === 'string' ? resolve(spaces[0].path) : null
    if (cliPath && existsSync(join(cliPath, '.holoself', 'link.yaml')))
      resolvedRoot = resolve(readLink(cliPath).path)
    else throw inboxError('canonical self root is required', 'INVALID_INPUT')
  }
  const canonicalRoot = canonicalPath(resolvedRoot),
    catalogSpaces = resolveInboxSpaces(resolvedRoot, { space: 'all', spaces }),
    seenIds = new Set(),
    resolvedItems = []

  for (const raw of items) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw inboxError('each batch item must be an object', 'INVALID_INPUT')
    if (typeof raw.space !== 'string' || !raw.space.trim())
      throw inboxError('batch item space must be a non-empty string', 'INVALID_INPUT')
    if (raw.id !== undefined && typeof raw.id !== 'string')
      throw inboxError('batch item id must be a string', 'INVALID_INPUT')
    if (raw.proposal_id !== undefined && typeof raw.proposal_id !== 'string')
      throw inboxError('batch item proposal_id must be a string', 'INVALID_INPUT')
    const rawId = raw.id !== undefined ? raw.id : raw.proposal_id
    if (typeof rawId !== 'string' || !rawId.trim() || !UUID_PREFIX_RE.test(rawId.trim()))
      throw inboxError('invalid proposal id', 'INVALID_INPUT')
    const id = rawId.trim()

    if (raw.preview_hash !== undefined && raw.preview_hash !== null && typeof raw.preview_hash !== 'string')
      throw inboxError('preview_hash must be a 64-character hex string', 'INVALID_INPUT')
    if (raw.previewHash !== undefined && raw.previewHash !== null && typeof raw.previewHash !== 'string')
      throw inboxError('preview_hash must be a 64-character hex string', 'INVALID_INPUT')
    const rawPreviewHash = raw.preview_hash ?? raw.previewHash
    if (action === 'approve' && (typeof rawPreviewHash !== 'string' || !rawPreviewHash.trim()))
      throw inboxError('Preview hash required for every batch item.', 'STALE_PREVIEW')
    const trimmedHash = typeof rawPreviewHash === 'string' ? rawPreviewHash.trim() : ''
    if (trimmedHash && !SHA256_HEX_RE.test(trimmedHash))
      throw inboxError('preview_hash must be a 64-character hex string', 'INVALID_INPUT')

    const { space, link } = resolveBatchItemSpace(canonicalRoot, resolvedRoot, raw, catalogSpaces, { allowAbsoluteSpace: allowAbs })
    const proposal = findProposal(space.path, id)
    if (seenIds.has(proposal.proposal_id))
      throw inboxError(`duplicate proposal in batch: ${proposal.proposal_id}`, 'DUPLICATE_BATCH_ITEM')
    seenIds.add(proposal.proposal_id)
    resolvedItems.push({
      proposal,
      project: space.path,
      spaceName: space.name,
      spaceId: space.id,
      link,
      previewHash: trimmedHash || null
    })
  }

  return await withRegistryLock(resolvedRoot, async () => {
    const state = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'deferred',
      uniqueProjects = [...new Set(resolvedItems.map(x => x.project))]
    for (const entry of resolvedItems) {
      const fresh = findProposal(entry.project, entry.proposal.proposal_id)
      if (fresh.status !== 'pending')
        throw inboxError(`proposal is ${fresh.status}, expected pending`, 'INVALID_PROPOSAL')
      entry.proposal = fresh
      if (action === 'approve') {
        const projectErrors = proposalProjectErrors(fresh, entry.project)
        if (projectErrors.length)
          throw inboxError(`proposal provenance validation failed: ${projectErrors.join('; ')}`, 'INVALID_PROPOSAL')
        const individualPreview = proposalPreviewData(entry.project, fresh.proposal_id)
        if (individualPreview.preview_hash !== entry.previewHash)
          throw inboxError('proposal preview is stale', 'STALE_PREVIEW')
      } else if (entry.previewHash) {
        let currentHash = null
        try {
          currentHash = proposalPreviewData(entry.project, fresh.proposal_id).preview_hash
        } catch {}
        if (currentHash && currentHash !== entry.previewHash)
          throw inboxError('proposal preview is stale', 'STALE_PREVIEW')
      }
      entry.proposalBefore = readFileSync(fresh._path)
      entry.archive = join(resolvedRoot, 'proposals', state, `${fresh.proposal_id}.yaml`)
      entry.receipt = join(resolvedRoot, 'proposals', 'receipts', `${fresh.proposal_id}-${state}.json`)
      entry.archiveExistedBefore = existsSync(entry.archive)
      entry.receiptExistedBefore = existsSync(entry.receipt)
    }

    if (action !== 'approve') {
      try {
        for (let i = 0; i < resolvedItems.length; i++) {
          const entry = resolvedItems[i]
          if (shouldFailBatchItem(i))
            throw inboxError(`injected batch failure on item ${i + 1}`, 'BATCH_ITEM_FAILED')
          stateProposal(entry.project, entry.proposal, state)
          await onItemApplied?.(i, entry)
        }
      } catch (error) {
        const rollbackFailures = []
        rollbackProposalEntries(resolvedRoot, resolvedItems, state, rollbackFailures)
        if (rollbackFailures.length) {
          const affected = [...new Set(rollbackFailures)]
          throw inboxError(
            `batch rollback incomplete for: ${affected.join(', ')} (after error: ${scrubMessage(error.message, [resolvedRoot, ...uniqueProjects])})`,
            'ROLLBACK_INCOMPLETE',
            { affected_paths: affected }
          )
        }
        throw error
      }
      return {
        action,
        count: resolvedItems.length,
        results: resolvedItems.map(entry => ({
          id: entry.proposal.proposal_id,
          proposal_id: entry.proposal.proposal_id,
          space: entry.spaceName,
          space_id: entry.spaceId,
          status: state,
          receipt: `proposals/receipts/${entry.proposal.proposal_id}-${state}.json`
        }))
      }
    }

    for (const proj of uniqueProjects) {
      const preErrors = ecosystemValidationErrors(resolvedRoot, proj)
      if (preErrors.length)
        throw inboxError(`pre-approval validation failed: ${preErrors.join('; ')}`, 'VALIDATION_FAILED')
    }

    const targetSnapshots = new Map(),
      touchedClaims = new Set(),
      commitTime = new Date().toISOString()

    try {
      for (let i = 0; i < resolvedItems.length; i++) {
        const entry = resolvedItems[i],
          p = entry.proposal,
          timeToken = commitTimeToken(p),
          stamp = text => text.replaceAll(timeToken, commitTime),
          shown = text => (text === null ? null : text.replaceAll(timeToken, '<commit-time>')),
          appliedChanges = [],
          chainedPreviews = [],
          itemTargets = new Map()

        if (shouldFailBatchItem(i))
          throw inboxError(`injected batch failure on item ${i + 1}`, 'BATCH_ITEM_FAILED')

        for (const change of proposalChanges(p)) {
          const op = change.operation || 'append_claim',
            target = safeTarget(resolvedRoot, change.target),
            rel = slash(relative(resolvedRoot, target))
          if (change.claim_id) {
            const claimKey = `${rel}\0${change.claim_id}`
            if (touchedClaims.has(claimKey))
              throw inboxError(`claim is already modified by an earlier proposal in this batch: ${change.claim_id}`, 'CLAIM_NOT_CURRENT')
            touchedClaims.add(claimKey)
          }
          let snap = targetSnapshots.get(target)
          if (!snap) {
            const existed = existsSync(target),
              createdDirs = existed ? [] : missingTargetDirs(resolvedRoot, target),
              before = existed ? readFileSync(target, 'utf8') : emptyTarget(resolvedRoot)
            if (before.includes(timeToken))
              throw inboxError(`target already contains this proposal's reserved placeholder: ${rel}`, 'INVALID_TARGET')
            snap = { target, rel, existed, createdDirs, before, current: before, written: false }
            targetSnapshots.set(target, snap)
          } else if (snap.current.includes(timeToken)) {
            throw inboxError(`target already contains this proposal's reserved placeholder: ${rel}`, 'INVALID_TARGET')
          }
          const beforeChange = snap.current,
            applied = applyClaimChange(beforeChange, rel, { ...change, operation: op }, p, null),
            stampedBefore = stamp(beforeChange),
            stampedAfter = stamp(applied.after)
          chainedPreviews.push({
            change_id: change.change_id,
            operation: op,
            target: rel,
            claim_id: applied.claim_id,
            evidence: change.evidence,
            visibility_change: applied.visibility_change,
            before_sha256: hash(beforeChange),
            after_sha256: hash(applied.after),
            before_block: shown(applied.before_block),
            after_block: shown(applied.after_block),
            preview: shown(applied.preview)
          })
          snap.current = stampedAfter
          itemTargets.set(target, stampedAfter)
          appliedChanges.push({
            change_id: change.change_id,
            operation: op,
            target: rel,
            claim_id: applied.claim_id,
            before_sha256: hash(stampedBefore),
            after_sha256: hash(stampedAfter)
          })
        }

        for (const [targetPath, content] of itemTargets.entries()) {
          atomicWrite(targetPath, content)
          const snap = targetSnapshots.get(targetPath)
          if (snap) snap.written = true
        }
        const batchPreviewHash = hash(JSON.stringify(chainedPreviews))
        stateProposal(entry.project, p, 'approved', {
          preview_sha256: entry.previewHash,
          batch_preview_sha256: batchPreviewHash,
          applied_changes: appliedChanges
        })
        entry.appliedChanges = appliedChanges
        entry.batchPreviewHash = batchPreviewHash
        await onItemApplied?.(i, entry)
      }

      for (const proj of uniqueProjects) {
        const postErrors = ecosystemValidationErrors(resolvedRoot, proj)
        if (postErrors.length)
          throw inboxError(`post-approval validation failed: ${postErrors.join('; ')}`, 'VALIDATION_FAILED')
      }
    } catch (error) {
      const rollbackFailures = []
      for (const snap of targetSnapshots.values()) {
        if (!snap.written) continue
        try {
          if (snap.existed) {
            atomicWrite(snap.target, snap.before)
          } else {
            if (existsSync(snap.target)) rmSync(snap.target)
            for (const dir of snap.createdDirs || []) {
              try {
                if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir)
              } catch {}
            }
          }
        } catch {
          rollbackFailures.push(snap.rel)
        }
      }
      rollbackProposalEntries(resolvedRoot, resolvedItems, state, rollbackFailures)
      if (rollbackFailures.length) {
        const affected = [...new Set(rollbackFailures)]
        throw inboxError(
          `batch rollback incomplete for: ${affected.join(', ')} (after error: ${scrubMessage(error.message, [resolvedRoot, ...uniqueProjects])})`,
          'ROLLBACK_INCOMPLETE',
          { affected_paths: affected }
        )
      }
      throw error
    }

    return {
      action: 'approve',
      count: resolvedItems.length,
      results: resolvedItems.map(entry => ({
        id: entry.proposal.proposal_id,
        proposal_id: entry.proposal.proposal_id,
        space: entry.spaceName,
        space_id: entry.spaceId,
        status: 'approved',
        preview_hash: entry.previewHash,
        batch_preview_hash: entry.batchPreviewHash,
        receipt: `proposals/receipts/${entry.proposal.proposal_id}-approved.json`,
        applied_changes: entry.appliedChanges
      }))
    }
  })
}
