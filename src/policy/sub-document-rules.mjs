// Sub-document access rules: one shape for `field_access` entries, lens-vocabulary claim markers and the deprecated
// `field_visibility` values and `visibility=` markers (docs/decisions/privacy-fields-and-legacy-mount.md, section 2).
// A rule is `{ access_lenses?, disclosure }`. Omitted `access_lenses` inherits the document; `disclosure` is always set.
import { DISCLOSURES, VISIBILITIES } from '../annotations.mjs'
import { lensIdStructurallyValid } from '../lenses.mjs'

export const PUBLICATION_ADAPTERS = ['obsidian-public', 'public', 'restricted-host']
export function publicationAdapter(adapter) {
  return PUBLICATION_ADAPTERS.includes(adapter)
}
// The lens sets of the legacy values narrower than "every lens".
export const LEGACY_LENS_SETS = Object.freeze({
  private: Object.freeze(['private']),
  professional: Object.freeze(['general', 'professional', 'interview', 'private']),
  'public-voice': Object.freeze(['general', 'public-voice', 'private'])
})
// An omitted disclosure is `review-required`: a rule never inherits `publish-approved`.
export const DEFAULT_RULE_DISCLOSURE = 'review-required'
export const PRIVATE_RULE = Object.freeze({ access_lenses: LEGACY_LENS_SETS.private, disclosure: DEFAULT_RULE_DISCLOSURE })
const RULE_KEYS = new Set(['access_lenses', 'disclosure'])
const RESERVED_FIELD_NAMES = new Set(['__proto__', 'prototype', 'constructor'])

// The exact mapping table ("Mapping: claim and field level"). Unknown values fall back to `private`.
export function legacySubDocumentRule(value) {
  const v = VISIBILITIES.includes(value) ? value : 'private'
  if (v === 'linked-projects') return { disclosure: DEFAULT_RULE_DISCLOSURE }
  if (v === 'public-safe') return { disclosure: 'publish-approved' }
  return { access_lenses: [...LEGACY_LENS_SETS[v]], disclosure: DEFAULT_RULE_DISCLOSURE }
}
const lensKnown = (id, registry) => typeof id === 'string' && lensIdStructurallyValid(id) && (!registry?.byId || registry.byId.has(id))
export function ruleLensesValid(value, registry = null) {
  return Array.isArray(value) && value.length > 0 && value.every(id => lensKnown(id, registry)) && new Set(value).size === value.length
}
export function subDocumentRuleValid(value, registry = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (Object.keys(value).some(key => !RULE_KEYS.has(key))) return false
  if (Object.hasOwn(value, 'access_lenses') && !ruleLensesValid(value.access_lenses, registry)) return false
  return !Object.hasOwn(value, 'disclosure') || DISCLOSURES.includes(value.disclosure)
}
export function fieldRuleNameValid(name) {
  return typeof name === 'string' && Boolean(name) && name === name.trim() && !RESERVED_FIELD_NAMES.has(name)
}
export function fieldAccessValid(value, registry = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.entries(value).every(([name, rule]) => fieldRuleNameValid(name) && subDocumentRuleValid(rule, registry))
}
// The rule a stored entry means. An entry that does not validate fails closed to private.
export function normalizeRule(value) {
  if (!subDocumentRuleValid(value)) return { access_lenses: [...PRIVATE_RULE.access_lenses], disclosure: PRIVATE_RULE.disclosure }
  return { ...(value.access_lenses ? { access_lenses: [...value.access_lenses] } : {}), disclosure: value.disclosure ?? DEFAULT_RULE_DISCLOSURE }
}
export function normalizeFieldAccess(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).map(([name, rule]) => [name, normalizeRule(rule)]))
}
export function narrowerDisclosure(a, b) {
  return DISCLOSURES[Math.min(DISCLOSURES.indexOf(a), DISCLOSURES.indexOf(b))] ?? 'internal-only'
}
// The rule for an element governed by two rules, never wider than either. When neither lens list contains the other,
// the overlap fails closed to `private` (if both admit it), so `professional` with `public-voice` stays what the
// deprecated vocabulary made it. Two lists with no shared lens give an empty list: no lens reads the element.
export function intersectRules(a, b) {
  const disclosure = narrowerDisclosure(a.disclosure, b.disclosure)
  if (!a.access_lenses || !b.access_lenses) {
    const lenses = a.access_lenses || b.access_lenses
    return { ...(lenses ? { access_lenses: [...lenses] } : {}), disclosure }
  }
  const shared = a.access_lenses.filter(lens => b.access_lenses.includes(lens)),
    nested = shared.length === a.access_lenses.length || shared.length === b.access_lenses.length
  return { access_lenses: nested ? shared : shared.filter(lens => lens === 'private'), disclosure }
}
// Whether a lens and adapter may see an element under a rule. On publication adapters the rule's disclosure must be
// `publish-approved`, on every output path. The document gate has already passed, so a rule can only narrow it.
export function subDocumentVisible(rule, lens, adapter = 'generic') {
  if (rule.access_lenses && !rule.access_lenses.includes(lens)) return false
  return publicationAdapter(adapter) ? rule.disclosure === 'publish-approved' : true
}
function sameLenses(a, b) {
  return a.length === b.length && a.every(lens => b.includes(lens))
}
// The deprecated label of a rule: its exact name, or `private` when it has none (the narrowest legacy value).
export function ruleVisibility(rule) {
  const approved = rule.disclosure === 'publish-approved'
  if (!rule.access_lenses) return approved ? 'public-safe' : 'linked-projects'
  if (approved) return 'private'
  for (const [name, lenses] of Object.entries(LEGACY_LENS_SETS)) if (sameLenses(rule.access_lenses, lenses)) return name
  return 'private'
}
function ruleHasExactName(rule) {
  const named = legacySubDocumentRule(ruleVisibility(rule)),
    approved = disclosure => disclosure === 'publish-approved'
  if (approved(named.disclosure) !== approved(rule.disclosure)) return false
  return named.access_lenses && rule.access_lenses ? sameLenses(named.access_lenses, rule.access_lenses) : !named.access_lenses && !rule.access_lenses
}
export function ruleMarkerAttrs(rule) {
  return [...(rule.access_lenses ? [`access_lenses=${rule.access_lenses.join(',')}`] : []), `disclosure=${rule.disclosure}`]
}
// A rule as reports show it: its deprecated name when exact, otherwise its attributes.
export function describeRule(rule) {
  return ruleHasExactName(rule) ? ruleVisibility(rule) : ruleMarkerAttrs(rule).join(' ')
}
// Catalog fields of a sub-document element. `visibility` stays until the catalog schemas drop it, and `access_rule`
// carries the rule only when no deprecated name states it exactly.
export function catalogRuleFields(rule) {
  return { visibility: ruleVisibility(rule), ...(ruleHasExactName(rule) ? {} : { access_rule: rule }) }
}
// A stored rule may also have an empty lens list: two rules with no shared lens, which no lens reads.
export function catalogRuleValid(value) {
  return subDocumentRuleValid(value?.access_lenses?.length === 0 ? { ...value, access_lenses: ['private'] } : value)
}
export function catalogElementRule(element) {
  if (!element?.access_rule) return legacySubDocumentRule(element?.visibility)
  if (!catalogRuleValid(element.access_rule)) return normalizeRule(null)
  return element.access_rule.access_lenses?.length === 0 ? { access_lenses: [], disclosure: DEFAULT_RULE_DISCLOSURE } : normalizeRule(element.access_rule)
}
export function catalogElementVisible(element, lens, adapter = 'generic') {
  return subDocumentVisible(catalogElementRule(element), lens, adapter)
}
// A mapped rule limited to lenses this self defines, so the written marker or field stays valid. A lens outside the
// registry can never be requested, so decisions do not change. Null when no lens remains.
export function ruleForRegistry(rule, registry = null) {
  if (!rule.access_lenses || !registry?.byId) return rule
  const access_lenses = rule.access_lenses.filter(lens => registry.byId.has(lens))
  return access_lenses.length ? { ...rule, access_lenses } : null
}
// Field rules of a document, ready to match. The deprecated map keeps its first-match behaviour; every matching
// `field_access` entry applies, and all of them intersect with it, so a conflict can only narrow.
export function fieldRuleTable(metadata = {}) {
  const entries = map => Object.entries(map).map(([name, rule]) => ({ name, key: name.toLowerCase(), rule })),
    legacy = metadata?.field_visibility
  return {
    legacy:
      legacy && typeof legacy === 'object' && !Array.isArray(legacy)
        ? Object.entries(legacy).map(([name, value]) => ({ name, key: name.toLowerCase(), rule: legacySubDocumentRule(value) }))
        : [],
    modern: entries(normalizeFieldAccess(metadata?.field_access))
  }
}
function matchFieldRule(table, matches) {
  const first = table.legacy.find(entry => matches(entry.key)),
    found = [...(first ? [first] : []), ...table.modern.filter(entry => matches(entry.key))]
  if (!found.length) return null
  return { name: found[0].name, rule: found.map(entry => entry.rule).reduce(intersectRules) }
}
// The rule filterFieldVisibility applies to one line: `Field: value` lines whose field name equals a rule.
export function fieldLineRule(line, table) {
  const field = String(line).match(/^\s*[-*]?\s*([^:]{2,40}):\s*(.+)$/)
  if (!field) return null
  const key = field[1].trim().toLowerCase()
  return matchFieldRule(table, name => key === name)
}
// The rule filterFieldVisibility applies to a whole section through its heading.
export function fieldHeadingRule(heading, table) {
  const key = String(heading).trim().toLowerCase()
  return matchFieldRule(table, name => key.includes(name))
}
// The field heading rules in force at one point of a document. A ruled heading covers everything under it, deeper
// headings included, until the next heading of its level or above. `inherited` holds the matches around a claim block:
// a heading inside the block can neither end those nor outlive the block.
// Rules start liberally and end conservatively (src/markdown/lines.mjs). A real heading ends the rules at its level and
// below. Any other heading shape only opens a rule (`ends: false`). Nothing but a real heading removes a rule, so no
// fence, raw HTML block or unusual shape can switch one off.
export function createHeadingScope(table, inherited = []) {
  let open = []
  return {
    heading(level, text, { ends = true } = {}) {
      if (ends) open = open.filter(entry => entry.level < level)
      const match = fieldHeadingRule(text, table)
      if (match) open.push({ level, ...match })
      return match
    },
    matches: () => [...inherited, ...open]
  }
}
export function scopeRule(matches) {
  return matches.length ? matches.map(match => match.rule).reduce(intersectRules) : null
}
