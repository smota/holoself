// Document access policy: lens, visibility, disclosure, sensitivity and task gates.
import { DOCUMENT_ROLES, SENSITIVITIES, VISIBILITIES, effectiveDisclosure, publicationAllowed } from '../annotations.mjs'
import { KNOWLEDGE_STATUSES, TEMPORAL_SCOPES, dateValue } from '../context-selection.mjs'
import { DEFAULT_LENS_IDS } from '../lenses.mjs'
import { replaceClaimBlocks } from '../markdown/claim-blocks.mjs'

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
  if (v === 'private') return ['private']
  if (v === 'professional') return ['general', 'professional', 'interview', 'private']
  if (v === 'public-voice') return ['general', 'public-voice', 'private']
  return [...LENSES]
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
export const PUBLICATION_ADAPTERS = ['obsidian-public', 'public', 'restricted-host']
export function publicationAdapter(adapter) {
  return PUBLICATION_ADAPTERS.includes(adapter)
}
// A sub-document visibility (section, claim, field, tag, link) under a lens and adapter. On publication adapters only
// `public-safe` is delivered: the sub-document equivalent of `disclosure: publish-approved` (see publicationAllowed).
export function visibleUnderBehavior(visibility, behaviorLens, adapter = 'generic') {
  const v = VISIBILITIES.includes(visibility) ? visibility : 'private'
  if (publicationAdapter(adapter)) return v === 'public-safe'
  if (v === 'linked-projects' || v === 'public-safe') return true
  return legacyAccessLenses({ visibility: v }).includes(behaviorLens)
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
  if (subj.kind === 'client:linked') {
    if (lens === 'private') return { allowed: false, reason: 'private lens not granted to linked client', phase: 2 }
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
function subDocumentExclusion(subject, value, lens, adapter) {
  return publicationAdapter(adapter) && visibleUnderBehavior(value, lens, 'generic')
    ? `${subject} not approved for publication on ${adapter} adapter`
    : `${subject} excluded by ${lens} lens`
}
export function filterClaimVisibility(body, lens, source, restrictions, resolution = null, identityKind = 'owner:direct', adapter = 'generic') {
  const behaviorLens = lens
  return replaceClaimBlocks(body, block => {
    if (visibleUnderBehavior(block.visibility, behaviorLens, adapter)) return block.raw
    if (identityKind === 'owner:direct')
      restrictions.push({
        source,
        reason: block.malformed ? 'malformed claim marker excluded' : subDocumentExclusion(`claim visibility ${block.visibility}`, block.visibility, lens, adapter)
      })
    return ''
  })
}
// A claim block's own lifecycle status narrows its document's: current claims follow the document, while superseded
// and retired (historical) claims appear only when the temporal selector asks for that status or for `all`.
export function claimStatusIncluded(status = 'current', temporal = 'current') {
  return status === 'current' || temporal === 'all' || temporal === status
}
export function filterClaimStatus(body, temporal, source, restrictions, identityKind = 'owner:direct') {
  return replaceClaimBlocks(body, block => {
    const status = block.status
    if (claimStatusIncluded(status, temporal || 'current')) return block.raw
    if (identityKind === 'owner:direct' && !restrictions.some(x => x.source === source && x.reason === `claim status ${status} excluded by temporal selector`))
      restrictions.push({ source, reason: `claim status ${status} excluded by temporal selector` })
    return ''
  })
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
  const behaviorLens = lens,
    configured =
      metadata.field_visibility && typeof metadata.field_visibility === 'object' && !Array.isArray(metadata.field_visibility) ? metadata.field_visibility : {}
  const policies = { ...configured }
  let blockedHeading = false,
    reportedCompensation = false
  return body
    .split(/\r?\n/)
    .filter(line => {
      const heading = line.match(/^#{1,6}\s+(.+)$/)
      if (heading) {
        const key = heading[1].trim().toLowerCase(),
          rule = Object.entries(policies).find(([field]) => key.includes(field.toLowerCase()))
        blockedHeading = Boolean(rule && !visibleUnderBehavior(rule[1], behaviorLens, adapter))
        if (blockedHeading) restrictions.push({ source, reason: subDocumentExclusion(`field ${rule[0]}`, rule[1], lens, adapter) })
        return !blockedHeading
      }
      if (blockedHeading) return false
      const field = line.match(/^\s*[-*]?\s*([^:]{2,40}):\s*(.+)$/),
        rule = field && Object.entries(policies).find(([name]) => field[1].trim().toLowerCase() === name.toLowerCase())
      if (rule && !visibleUnderBehavior(rule[1], behaviorLens, adapter)) {
        restrictions.push({ source, reason: subDocumentExclusion(`field ${rule[0]}`, rule[1], lens, adapter) })
        return false
      }
      return true
    })
    .join('\n')
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
  if (result.valid_until) result.valid_until_epoch_ms = dateValue(result.valid_until, true)
  return result
}
