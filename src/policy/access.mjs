// Document access policy: lens, visibility, disclosure, sensitivity and task gates.
import { DOCUMENT_ROLES, SENSITIVITIES, VISIBILITIES, effectiveDisclosure, publicationAllowed } from '../annotations.mjs'
import { KNOWLEDGE_STATUSES, TEMPORAL_SCOPES, dateValue } from '../context-selection.mjs'
import { DEFAULT_LENS_IDS } from '../lenses.mjs'
import { CLAIM_CLOSER, parseClaimBlocks, replaceClaimBlocks } from '../markdown/claim-blocks.mjs'
import { classifyLines } from '../markdown/lines.mjs'
import {
  LEGACY_LENS_SETS,
  PUBLICATION_ADAPTERS,
  createHeadingScope,
  fieldLineRule,
  fieldRuleTable,
  intersectRules,
  legacySubDocumentRule,
  normalizeFieldAccess,
  publicationAdapter,
  ruleVisibility,
  subDocumentVisible
} from './sub-document-rules.mjs'

export const LENSES = DEFAULT_LENS_IDS
export const SENSITIVITY_LENSES = {
  'compensation-confidential': ['professional', 'interview', 'private'],
  'third-party-personal': ['leadership', 'private'],
  'recruiter-confidential': ['professional', 'interview', 'private'],
  'employer-confidential': ['professional', 'technical', 'leadership', 'interview', 'private'],
  'application-private': ['professional', 'interview', 'private'],
  restricted: ['private']
}
export function visibility(meta) {
  return meta.visibility || 'linked-projects'
}
export function legacyAccessLenses(meta) {
  const v = visibility(meta)
  return [...(LEGACY_LENS_SETS[v] || LENSES)]
}
export function accessLenses(meta) {
  return Array.isArray(meta.access_lenses) ? meta.access_lenses : legacyAccessLenses(meta)
}
export function disclosure(meta) {
  return effectiveDisclosure(meta)
}
export function documentRole(meta) {
  return DOCUMENT_ROLES.includes(meta.document_role) ? meta.document_role : 'content'
}
export { publicationAllowed }
export function taskAllowed(meta, task) {
  const include = Array.isArray(meta.task_include) ? meta.task_include : [],
    exclude = Array.isArray(meta.task_exclude) ? meta.task_exclude : [],
    value = (task || '').trim().toLowerCase()
  if (include.length && (!value || !include.some(pattern => value.includes(pattern.toLowerCase())))) return false
  return !value || !exclude.some(pattern => value.includes(pattern.toLowerCase()))
}
export { PUBLICATION_ADAPTERS, publicationAdapter }
// A deprecated sub-document visibility under a lens and adapter: its exact rule (see sub-document-rules.mjs). On
// publication adapters only `public-safe` is delivered, the equivalent of `disclosure: publish-approved`.
export function visibleUnderBehavior(visibility, behaviorLens, adapter = 'generic') {
  return subDocumentVisible(legacySubDocumentRule(visibility), behaviorLens, adapter)
}
// The narrowest single visibility admitted wherever both a and b are (an element governed by two rules, such as a
// field line inside a claim block).
export function intersectVisibility(a, b) {
  return ruleVisibility(intersectRules(legacySubDocumentRule(a), legacySubDocumentRule(b)))
}
export function allowedDocument(meta, lens, adapter = 'generic', task = null, resolution = null, subject = null, sourceSpaceId = null) {
  const subj = subject || { kind: 'owner:direct', accessible_spaces: ['self', 'contrib'] }
  const srcSpace = sourceSpaceId || 'self'
  const explicitReadScope = ['shared', 'local', 'restricted'].includes(meta.read_scope) ? meta.read_scope : null
  const readScope = explicitReadScope || (visibility(meta) === 'private' ? 'restricted' : 'shared')
  if (explicitReadScope === 'restricted') {
    if (!(subj.kind === 'owner:direct' && lens === 'private')) {
      return { allowed: false, reason: 'restricted read_scope requires direct owner under private lens', phase: 1 }
    }
  } else if (readScope === 'local') {
    const accSpaces = subj.accessible_spaces || []
    if (!accSpaces.includes(srcSpace)) {
      return { allowed: false, reason: `local read_scope not accessible from space ${srcSpace}`, phase: 1 }
    }
  }
  if (subj.kind === 'client:linked' || subj.kind === 'client:unlinked') {
    if (lens === 'private') return { allowed: false, reason: `private lens not granted to ${subj.kind === 'client:linked' ? 'linked' : 'unlinked'} client`, phase: 2 }
    if (subj.effective_allowed_lenses && !subj.effective_allowed_lenses.has(lens)) {
      return { allowed: false, reason: `lens ${lens} not in effective allowed lenses`, phase: 2 }
    }
  }
  const docAccessLenses = accessLenses(meta)
  if (!docAccessLenses.includes(lens)) return { allowed: false, reason: `access_lenses exclude ${lens} lens`, phase: 3 }
  const excluded = Array.isArray(meta.exclude_lenses) ? meta.exclude_lenses : []
  if (excluded.includes(lens)) return { allowed: false, reason: `access_lenses exclude ${lens} lens`, phase: 4 }
  if (!taskAllowed(meta, task)) return { allowed: false, reason: `task selector excludes ${task || '(unspecified task)'}`, phase: 5 }
  const sensitivity = meta.sensitivity || ''
  if (sensitivity === 'restricted') {
    if (!(subj.kind === 'owner:direct' && lens === 'private')) {
      return { allowed: false, reason: `sensitivity ${sensitivity} excludes ${lens} lens`, phase: 6 }
    }
  }
  if (readScope === 'restricted') {
    if (!(subj.kind === 'owner:direct' && lens === 'private')) {
      return { allowed: false, reason: 'restricted read_scope requires direct owner under private lens', phase: 1 }
    }
  }
  if (
    lens !== 'private' &&
    documentRole(meta) !== 'policy' &&
    SENSITIVITY_LENSES[sensitivity] &&
    !(resolution?.sensitivity_access || []).includes(sensitivity)
  ) {
    return { allowed: false, reason: `sensitivity ${sensitivity} excludes ${lens} lens`, phase: 6 }
  }
  if (publicationAdapter(adapter) && !publicationAllowed(meta)) {
    return { allowed: false, reason: 'not approved for publication on public adapter', phase: 7 }
  }
  return { allowed: true, reason: null, phase: null }
}
export function allowed(meta, lens, adapter = 'generic', task = null, resolution = null, subject = null, sourceSpaceId = null) {
  return allowedDocument(meta, lens, adapter, task, resolution, subject, sourceSpaceId).allowed
}
// Why a sub-document element was hidden: the lens, or (when the lens alone would show it) the publication adapter.
function subDocumentExclusion(subject, rule, lens, adapter) {
  return publicationAdapter(adapter) && subDocumentVisible(rule, lens, 'generic')
    ? `${subject} not approved for publication on ${adapter} adapter`
    : `${subject} excluded by ${lens} lens`
}
export function filterClaimVisibility(body, lens, source, restrictions, resolution = null, identityKind = 'owner:direct', adapter = 'generic', registry = null) {
  return replaceClaimBlocks(
    body,
    block => {
      if (subDocumentVisible(block.rule, lens, adapter)) return block.raw
      if (identityKind === 'owner:direct')
        restrictions.push({
          source,
          reason: block.malformed ? 'malformed claim marker excluded' : subDocumentExclusion(`claim visibility ${block.visibility}`, block.rule, lens, adapter)
        })
      return ''
    },
    { registry }
  )
}
// A claim block's own lifecycle status narrows its document's: current claims follow the document, while superseded
// and retired (historical) claims appear only when the temporal selector asks for that status or for `all`.
export function claimStatusIncluded(status = 'current', temporal = 'current') {
  return status === 'current' || temporal === 'all' || temporal === status
}
export function filterClaimStatus(body, temporal, source, restrictions, identityKind = 'owner:direct', registry = null) {
  return replaceClaimBlocks(
    body,
    block => {
      const status = block.status
      if (claimStatusIncluded(status, temporal || 'current')) return block.raw
      if (identityKind === 'owner:direct' && !restrictions.some(x => x.source === source && x.reason === `claim status ${status} excluded by temporal selector`))
        restrictions.push({ source, reason: `claim status ${status} excluded by temporal selector` })
      return ''
    },
    { registry }
  )
}
// Each line of a body with the field heading rules in force on it. filterFieldVisibility and the catalog share this
// walk, so `content` and the catalog paths cannot disagree about what a heading rule covers. `outer` is what applies
// around a claim block, and `matches` adds the headings inside it. The text outside claim blocks and each claim body are
// classified separately, exactly as the catalog splits them. So nothing raw crosses a marker, hiding a claim from one
// lens cannot change how the text around it reads, and pieces of a line split by a claim read as the line they join into.
export function* scopedLines(body, table) {
  const source = String(body),
    blocks = parseClaimBlocks(source),
    parts = source.split(/(\r?\n)/),
    physical = [],
    outerLines = ['']
  let index = 0,
    offset = 0
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i],
      end = offset + line.length
    while (blocks[index] && offset >= blocks[index].end) index++
    const touching = []
    for (let j = index; blocks[j] && blocks[j].start < end; j++) touching.push(blocks[j])
    let cursor = offset
    for (const item of touching) {
      outerLines[outerLines.length - 1] += source.slice(cursor, Math.max(cursor, item.start))
      cursor = Math.max(cursor, Math.min(item.end, end))
    }
    outerLines[outerLines.length - 1] += source.slice(cursor, end)
    physical.push({ line, offset, end, touching, outerIndex: outerLines.length - 1 })
    // A line break inside a claim block is gone once the block is lifted out, so the outer line carries on.
    if (!touching.some(item => end < item.end)) outerLines.push('')
    offset = end + (parts[i + 1]?.length ?? 0)
  }
  const walk = (kind, scope) => {
    let opened = kind.real ? scope.heading(kind.real.level, kind.real.text) : null
    for (const start of kind.starts) opened = scope.heading(start.level, start.text, { ends: false }) || opened
    return { heading: Boolean(kind.real || opened), opened }
  }
  const outerKinds = classifyLines(outerLines),
    outerScope = createHeadingScope(table),
    inner = new Map()
  let walked = -1
  for (const { line, end, touching, outerIndex } of physical) {
    let step = { heading: false, opened: null }
    while (walked < outerIndex) step = walk(outerKinds[++walked], outerScope)
    const outer = outerScope.matches()
    for (const item of touching) {
      if (!inner.has(item.start))
        inner.set(item.start, { scope: createHeadingScope(table, outer), kinds: classifyLines(item.body.split(/\r?\n/)), next: 0, line: -1 })
      const state = inner.get(item.start)
      if (end >= item.start + item.raw.indexOf('-->') + 3) state.line++
      while (state.next <= state.line && state.next < state.kinds.length) {
        const innerStep = walk(state.kinds[state.next++], state.scope)
        step = { heading: step.heading || innerStep.heading, opened: innerStep.opened || step.opened }
      }
    }
    const block = touching[0] || null
    yield {
      line,
      block,
      blocks: touching,
      closes: Boolean(block) && end >= block.end,
      ...step,
      matches: [...touching.flatMap(item => inner.get(item.start).scope.matches()), ...outer],
      outer
    }
  }
}
export function filterFieldVisibility(
  body,
  metadata,
  lens,
  source,
  restrictions,
  resolution = null,
  identityKind = 'owner:direct',
  adapter = 'generic'
) {
  const table = fieldRuleTable(metadata),
    visible = match => subDocumentVisible(match.rule, lens, adapter),
    // A field name is a rule detail, so only the owner reading their own document sees it in a reason.
    named = identityKind === 'owner:direct' && !publicationAdapter(adapter),
    record = match => restrictions.push({ source, reason: subDocumentExclusion(named ? `field ${match.name}` : 'field', match.rule, lens, adapter) }),
    kept = []
  for (const { line, block, closes, heading, opened, matches, outer } of scopedLines(body, table)) {
    if (opened && !visible(opened)) record(opened)
    const lineMatch = heading || !matches.every(visible) ? null : fieldLineRule(line, table),
      hiddenLine = lineMatch && !visible(lineMatch)
    if (hiddenLine) record(lineMatch)
    if (matches.every(visible) && !hiddenLine) kept.push(line)
    // A rule on a heading inside a claim hides the rest of that claim, not its closing marker.
    else if (block && closes && outer.every(visible)) kept.push(CLAIM_CLOSER)
  }
  return kept.join('\n')
}
// The text of a catalog section for one caller. A long section of a document with field rules keeps its full text in the
// local catalog, so it is filtered first and cut after: a cut can never break a heading shape the filter relies on.
export function deliveredSection(section, filter) {
  const { full_text: fullText, ...rest } = section
  if (fullText === undefined) return { ...rest, snippet: filter(section.snippet || '') }
  const text = filter(fullText).trim()
  return { ...rest, snippet: text.length > 360 ? text.slice(0, 357) + '...' : text }
}
export function privacyMetadata(metadata, registry = null) {
  const rawSensitivity = typeof metadata.sensitivity === 'string' ? metadata.sensitivity : null,
    sensitivity = SENSITIVITIES.includes(rawSensitivity) ? rawSensitivity : rawSensitivity ? 'restricted' : 'personal',
    known = x => (registry ? registry.byId.has(x) : LENSES.includes(x))
  const read_scope = ['shared', 'local', 'restricted'].includes(metadata.read_scope)
    ? metadata.read_scope
    : visibility(metadata) === 'private'
      ? 'restricted'
      : 'shared'
  const result = {
    access_lenses: accessLenses(metadata).filter(known),
    disclosure: disclosure(metadata),
    sensitivity,
    document_role: documentRole(metadata),
    publication_allowed: publicationAllowed({ ...metadata, sensitivity }),
    task_include: Array.isArray(metadata.task_include) ? metadata.task_include : [],
    task_exclude: Array.isArray(metadata.task_exclude) ? metadata.task_exclude : [],
    visibility: visibility(metadata),
    read_scope,
    public_safe: Object.hasOwn(metadata, 'public_safe') ? metadata.public_safe : null,
    confidence: typeof metadata.confidence === 'string' ? metadata.confidence : null,
    exclude_lenses: Array.isArray(metadata.exclude_lenses) ? metadata.exclude_lenses.filter(known) : [],
    field_visibility: {},
    knowledge_status: KNOWLEDGE_STATUSES.includes(metadata.knowledge_status) ? metadata.knowledge_status : 'current',
    temporal_scope: TEMPORAL_SCOPES.includes(metadata.temporal_scope) ? metadata.temporal_scope : 'current',
    valid_from: typeof metadata.valid_from === 'string' ? metadata.valid_from : null,
    valid_until: typeof metadata.valid_until === 'string' ? metadata.valid_until : null,
    valid_until_epoch_ms: null,
    review_after: typeof metadata.review_after === 'string' ? metadata.review_after : null,
    supersedes: Array.isArray(metadata.supersedes) ? metadata.supersedes : [],
    superseded_by: typeof metadata.superseded_by === 'string' ? metadata.superseded_by : null
  }
  if (metadata.field_visibility && typeof metadata.field_visibility === 'object' && !Array.isArray(metadata.field_visibility))
    for (const [key, value] of Object.entries(metadata.field_visibility)) result.field_visibility[key] = VISIBILITIES.includes(value) ? value : 'private'
  const fieldAccess = normalizeFieldAccess(metadata.field_access)
  if (Object.keys(fieldAccess).length) result.field_access = fieldAccess
  if (result.valid_until) result.valid_until_epoch_ms = dateValue(result.valid_until, true)
  return result
}
