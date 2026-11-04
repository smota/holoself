// Approved claim blocks: marker parsing, stable claim identity and claim lifecycle status.
import { hash, slash } from '../shared/fs.mjs'

export const CLAIM_STATUSES = ['current', 'superseded', 'historical']
// Marker attributes in their canonical write order; `visibility` always comes first and is not listed here.
export const CLAIM_MARKER_ATTRS = ['id', 'status', 'supersedes', 'superseded_by', 'superseded_at', 'retired_at']
export const CLAIM_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
// Lines inside a claim block that carry review metadata rather than claim wording.
const CLAIM_METADATA_LINE = /^[-*]\s+(?:Evidence|Confidence|Visibility|Provenance|Approved|Retired|Retirement reason|Retirement evidence|Retirement provenance):/i

// A fresh global regex over complete claim blocks: groups are visibility, raw attribute string and block body.
export function claimBlockPattern(visibility = '[a-z-]+') {
  return new RegExp(`<!-- holoself-claim visibility=(${visibility})((?: [a-z_]+=\\S+?)*) -->([\\s\\S]*?)<!-- \\/holoself-claim -->`, 'g')
}
export function normalize(text) {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .trim()
}
export function parseClaimAttrs(raw = '') {
  const attrs = {}
  for (const pair of String(raw).trim().split(/\s+/).filter(Boolean)) {
    const at = pair.indexOf('=')
    if (at > 0) attrs[pair.slice(0, at)] = pair.slice(at + 1)
  }
  return attrs
}
// Unknown status values fail closed as historical so they never reach current context.
export function claimStatus(attrs = {}) {
  if (attrs.status === undefined) return 'current'
  return CLAIM_STATUSES.includes(attrs.status) ? attrs.status : 'historical'
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
export function formatClaimMarker(visibility, attrs = {}) {
  const parts = CLAIM_MARKER_ATTRS.filter(key => attrs[key] !== undefined && attrs[key] !== null && attrs[key] !== '').map(key => ` ${key}=${attrs[key]}`)
  return `<!-- holoself-claim visibility=${visibility}${parts.join('')} -->`
}
// Every complete claim block in a document, with offsets, parsed attributes and its effective claim id.
export function parseClaimBlocks(text, target = '') {
  const blocks = []
  for (const match of String(text).matchAll(claimBlockPattern())) {
    const attrs = parseClaimAttrs(match[2]),
      wording = claimBlockText(match[3])
    blocks.push({
      start: match.index,
      end: match.index + match[0].length,
      raw: match[0],
      visibility: match[1],
      attrs,
      body: match[3],
      text: wording,
      status: claimStatus(attrs),
      legacy: !attrs.id,
      claim_id: attrs.id || legacyClaimId(target, wording)
    })
  }
  return blocks
}
// Adds the deterministic legacy id to delivered claim markers that have none, so agents can reference them.
export function withClaimIds(body, target) {
  return String(body).replace(claimBlockPattern(), (block, visibility, rawAttrs, inner) => {
    const attrs = parseClaimAttrs(rawAttrs)
    if (attrs.id) return block
    return formatClaimMarker(visibility, { ...attrs, id: legacyClaimId(target, claimBlockText(inner)) }) + inner + '<!-- /holoself-claim -->'
  })
}
