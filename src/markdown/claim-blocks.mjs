// Approved claim blocks: marker parsing, stable claim identity and claim lifecycle status.
// Parsing is deliberately loose about spacing, case and attribute order, and fails closed: an opener that does not
// parse cleanly makes its block private and historical, and text after an unclosed opener is never delivered.
import { DISCLOSURES } from '../annotations.mjs'
import { PRIVATE_RULE, intersectRules, legacySubDocumentRule, normalizeRule, ruleForRegistry, ruleLensesValid, ruleMarkerAttrs, ruleVisibility } from '../policy/sub-document-rules.mjs'
import { hash, slash } from '../shared/fs.mjs'

export const CLAIM_STATUSES = ['current', 'superseded', 'historical']
// Marker attributes in their canonical write order; the access rule always comes first and is not listed here.
export const CLAIM_MARKER_ATTRS = ['id', 'status', 'supersedes', 'superseded_by', 'superseded_at', 'retired_at']
export const CLAIM_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
// Any text that opens or closes a claim block, however it is spaced or cased.
// Whitespace for marker matching also covers invisible format characters (\p{Cf}: BOM, ZWSP, ZWNJ, ZWJ, soft hyphen,
// bidi controls) so they cannot hide a marker from the parser; \s already covers NBSP and BOM.
const WS = String.raw`[\s\p{Cf}]`
export const CLAIM_MARKER_RE = new RegExp(String.raw`<!--${WS}*\/?${WS}*holoself-claim\b`, 'iu')
const OPENER = String.raw`<!--${WS}*holoself-claim\b([^>]*?)-->`
const CLOSER = String.raw`<!--${WS}*\/${WS}*holoself-claim${WS}*-->`
const OPENER_START = String.raw`<!--${WS}*holoself-claim\b`
const OPENER_PREFIX = new RegExp(`^${OPENER_START}`, 'iu')
const RULE_ATTRS = ['visibility', 'access_lenses', 'disclosure']
const MARKER_KEYS = new Set([...RULE_ATTRS, ...CLAIM_MARKER_ATTRS])
// Lines inside a claim block that carry review metadata rather than claim wording.
const CLAIM_METADATA_LINE = /^[-*]\s+(?:Evidence|Confidence|Visibility|Provenance|Approved|Retired|Retirement reason|Retirement evidence|Retirement provenance):/i

const blockPattern = () => new RegExp(`${OPENER}([\\s\\S]*?)${CLOSER}`, 'giu')
export function normalize(text) {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .trim()
}
// Attributes of one opener in any order and spacing; problems make the block malformed.
// With a registry, a lens it does not define is a problem too (see `registry` on the functions below).
export function parseClaimOpener(raw = '', { registry = null } = {}) {
  const attrs = {},
    problems = [],
    tokens = String(raw).split(/[\s\p{Cf}]+/u).filter(Boolean)
  for (const token of tokens) {
    const match = token.match(/^([a-z_]+)=(\S+)$/)
    if (!match) problems.push(`malformed claim marker attribute ${JSON.stringify(token)}`)
    else if (!MARKER_KEYS.has(match[1])) problems.push(`unknown claim marker attribute ${match[1]}`)
    else if (Object.hasOwn(attrs, match[1])) problems.push(`duplicate claim marker attribute ${match[1]}`)
    else attrs[match[1]] = match[2]
  }
  if (RULE_ATTRS.every(key => attrs[key] === undefined)) problems.push('claim marker has no visibility or access rule')
  if (attrs.access_lenses !== undefined && !ruleLensesValid(attrs.access_lenses.split(','), registry)) problems.push(`invalid claim marker access_lenses ${attrs.access_lenses}`)
  if (attrs.disclosure !== undefined && !DISCLOSURES.includes(attrs.disclosure)) problems.push(`invalid claim marker disclosure ${attrs.disclosure}`)
  if (attrs.status !== undefined && !['superseded', 'historical'].includes(attrs.status)) problems.push(`invalid claim status ${attrs.status}`)
  if (attrs.id !== undefined && !CLAIM_ID_RE.test(attrs.id)) problems.push(`invalid claim id ${attrs.id}`)
  return { attrs, problems }
}
export function claimBlockText(body) {
  return String(body)
    .split(/\r?\n/)
    .map(x => x.trim())
    .filter(x => x && !x.startsWith('#') && !CLAIM_METADATA_LINE.test(x))
    .join(' ')
    .trim()
}
function uuidFromDigest(digest) {
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-${((parseInt(digest[16], 16) & 3) | 8).toString(16)}${digest.slice(17, 20)}-${digest.slice(20, 32)}`
}
// Identity of a legacy claim block without an `id`: target path plus normalized wording, stable until either changes.
export function legacyClaimId(target, text) {
  return uuidFromDigest(hash(`holoself-claim-id\n${slash(target)}\n${normalize(text)}`))
}
// Identity of the claim a proposal change creates, fixed by the proposal so previews stay deterministic.
export function proposalClaimId(proposalId, changeId) {
  return uuidFromDigest(hash(`holoself-proposal-claim\n${proposalId}\n${changeId}`))
}
// A rule writes the lens vocabulary. A string writes the deprecated `visibility=`, which only delivery of a block that
// still carries it uses.
export function formatClaimMarker(rule, attrs = {}) {
  const parts = CLAIM_MARKER_ATTRS.filter(key => attrs[key] !== undefined && attrs[key] !== null && attrs[key] !== '').map(key => ` ${key}=${attrs[key]}`),
    head = typeof rule === 'string' ? `visibility=${rule}` : ruleMarkerAttrs(rule).join(' ')
  return `<!-- holoself-claim ${head}${parts.join('')} -->`
}
// The effective rule of a well-formed marker. Both vocabularies on one marker intersect, so a conflict only narrows.
function markerRule(attrs) {
  const legacy = attrs.visibility === undefined ? null : legacySubDocumentRule(attrs.visibility)
  if (attrs.access_lenses === undefined && attrs.disclosure === undefined) return legacy
  const modern = normalizeRule({
    ...(attrs.access_lenses === undefined ? {} : { access_lenses: attrs.access_lenses.split(',') }),
    ...(attrs.disclosure === undefined ? {} : { disclosure: attrs.disclosure })
  })
  return legacy ? intersectRules(legacy, modern) : modern
}
function blockInfo(raw, rawAttrs, body, start, target, registry = null) {
  const { attrs, problems } = parseClaimOpener(rawAttrs, { registry })
  if (CLAIM_MARKER_RE.test(body)) problems.push('nested claim marker')
  const malformed = problems.length > 0,
    wording = claimBlockText(body),
    rule = malformed ? { ...PRIVATE_RULE } : markerRule(attrs)
  return {
    start,
    end: start + raw.length,
    raw,
    rawVisibility: attrs.visibility,
    // Malformed blocks fail closed: private and historical, so they never reach current or shared context.
    rule,
    visibility: ruleVisibility(rule),
    attrs,
    body,
    text: wording,
    status: malformed ? 'historical' : attrs.status || 'current',
    malformed,
    problems,
    legacy: !attrs.id,
    claim_id: !malformed && attrs.id ? attrs.id : legacyClaimId(target, wording)
  }
}
// Every complete claim block in a document, with offsets, parsed attributes and its effective claim id.
export function parseClaimBlocks(text, target = '', { registry = null } = {}) {
  return [...String(text).matchAll(blockPattern())].map(match => blockInfo(match[0], match[1], match[2], match.index, target, registry))
}
// Rewrites each claim block through `fn`. With failClosed, everything from an unclosed or stray opener onwards is
// dropped, so a broken marker can never expose the claim text that follows it.
export function replaceClaimBlocks(text, fn, { failClosed = true, target = '', registry = null } = {}) {
  const source = String(text)
  let out = '',
    last = 0
  const gap = segment => {
    if (failClosed) {
      // An unmatched closer means its opener was hidden or broken: drop the text before it back to the previous block.
      const closers = [...segment.matchAll(new RegExp(CLOSER, 'giu'))]
      if (closers.length) segment = segment.slice(closers.at(-1).index + closers.at(-1)[0].length)
    }
    const stray = failClosed ? segment.search(new RegExp(OPENER_START, 'iu')) : -1
    out += stray < 0 ? segment : segment.slice(0, stray)
    return stray < 0
  }
  for (const match of source.matchAll(blockPattern())) {
    if (!gap(source.slice(last, match.index))) return out
    out += fn(blockInfo(match[0], match[1], match[2], match.index, target, registry))
    last = match.index + match[0].length
  }
  gap(source.slice(last))
  return out
}
// Validation problems: malformed openers and markers that do not pair up into complete blocks.
export function claimMarkerProblems(text, { registry = null } = {}) {
  const source = String(text),
    blocks = parseClaimBlocks(source, '', { registry }),
    openers = (source.match(new RegExp(OPENER_START, 'giu')) || []).length,
    closers = (source.match(new RegExp(CLOSER, 'giu')) || []).length,
    problems = blocks.flatMap(block => block.problems)
  if (openers !== blocks.length || closers !== blocks.length)
    problems.push(`unbalanced claim markers (${openers} opening, ${closers} closing, ${blocks.length} complete blocks)`)
  return [...new Set(problems)]
}
// Adds the deterministic legacy id to delivered claim markers that have none, so agents can reference them. A marker
// keeps the vocabulary it was written in; one that mixes both is delivered as its effective rule.
export function withClaimIds(body, target, { registry = null } = {}) {
  return replaceClaimBlocks(
    body,
    block => {
      if (block.malformed || block.attrs.id) return block.raw
      const legacyOnly = block.attrs.access_lenses === undefined && block.attrs.disclosure === undefined
      return formatClaimMarker(legacyOnly ? block.visibility : block.rule, { ...block.attrs, id: block.claim_id }) + block.body + '<!-- /holoself-claim -->'
    },
    { target, registry }
  )
}
// Removes marker comments from text, for comparing what two versions of a document deliver.
export function stripClaimMarkers(text) {
  return String(text).replace(new RegExp(`${OPENER}|${CLOSER}`, 'giu'), '')
}
// Only the attribute tokens of the rule change: the marker's spacing, case and other attributes stay as they are.
function rewrittenOpener(opener, rule) {
  const prefix = opener.match(OPENER_PREFIX)[0],
    parts = opener.slice(prefix.length, -3).split(/([\s\p{Cf}]+)/u)
  let placed = false,
    out = ''
  for (let i = 0; i < parts.length; i += 2) {
    const separator = i > 0 ? parts[i - 1] : ''
    if (!RULE_ATTRS.some(key => parts[i].startsWith(`${key}=`))) out += separator + parts[i]
    else if (!placed) {
      out += separator + ruleMarkerAttrs(rule).join(' ')
      placed = true
    }
  }
  return `${prefix}${out}-->`
}
// The opener rewrites `holoself migrate policy` plans for one document body: exactly the blocks the runtime parses, and
// nothing else. That includes blocks inside fenced code, because the runtime enforces those too. Text the runtime does
// not read as a block (stray or unclosed markers) stays as it is. Malformed blocks keep failing closed and are reported,
// as is a marker whose effective rule no lens can read, which has no written form.
export function claimMarkerRewrites(body, { registry = null, target = '' } = {}) {
  const rewrites = [],
    skipped = []
  for (const block of parseClaimBlocks(body, target, { registry })) {
    if (block.attrs.visibility === undefined) continue
    if (block.malformed) {
      skipped.push({ claim_id: block.claim_id, reason: `malformed claim marker: ${block.problems.join('; ')}` })
      continue
    }
    const rule = ruleForRegistry(block.rule, registry)
    if (!rule || (rule.access_lenses && !rule.access_lenses.length)) {
      skipped.push({ claim_id: block.claim_id, reason: 'claim marker rule admits no lens' })
      continue
    }
    const before = block.raw.slice(0, block.raw.indexOf('-->') + 3),
      after = rewrittenOpener(before, rule),
      [check] = parseClaimBlocks(after + block.raw.slice(before.length), target, { registry })
    if (!check || check.malformed || check.claim_id !== block.claim_id || check.status !== block.status || check.text !== block.text)
      throw new Error(`claim marker rewrite changed claim identity: ${block.claim_id}`)
    rewrites.push({ claim_id: block.claim_id, start: block.start, before, after })
  }
  return { rewrites, skipped }
}
