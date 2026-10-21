import { readFileSync } from 'node:fs'
import { recordDigest } from '../core/record-digest.mjs'

const PROFILE = JSON.parse(
  readFileSync(
    new URL(
      '../../manifests/execution-distributions/subscription-balanced-v1.json',
      import.meta.url,
    ),
    'utf8',
  ),
)
const ROUTES = {
  openai: ['codex', 'codex-cli', 'openai-codex', 'openai', 'codex'],
  gemini: ['pi', 'pi-session', 'antigravity', 'google', 'pi'],
  grok: ['pi', 'pi-session', 'grok', 'xai', 'pi'],
  claude: ['claude-code', 'claude-cli', 'anthropic', 'anthropic', 'claude'],
}
const FIELDS = ['runtime', 'executionTarget', 'providerRoute', 'providerFamily', 'client']
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
function keys(value, allowed, label) {
  if (!object(value)) throw new Error(`${label} must be an object`)
  for (const k of Object.keys(value))
    if (!allowed.includes(k)) throw new Error(`Unknown ${label} field ${k}`)
}
const APPROVED_MODELS = new Set(
  Object.values(PROFILE.roles).flatMap((r) => r.options.map((o) => `${o.subscription}:${o.model}`)),
)
function validateOptions(options, scope) {
  if (!Array.isArray(options) || options.length !== 3)
    throw new Error('Each role requires one default and exactly two fallbacks')
  const seen = new Set()
  for (const o of options) {
    keys(o, [...FIELDS, 'subscription', 'model', 'effort'], 'route option')
    const tuple = Object.hasOwn(ROUTES, o.subscription) ? ROUTES[o.subscription] : null
    if (!tuple || FIELDS.some((f, i) => o[f] !== tuple[i]))
      throw new Error('Route must use the declared subscription client and provider')
    const prefixes = { openai: 'gpt-', gemini: 'gemini-', grok: 'grok-', claude: 'claude-' }
    if (
      typeof o.model !== 'string' ||
      !o.model.startsWith(prefixes[o.subscription]) ||
      !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(o.model)
    )
      throw new Error('Canonical model does not match subscription route')
    if (
      !(scope === 'bounded-clean-context' ? ['low', 'medium', 'high'] : ['low', 'medium']).includes(
        o.effort,
      )
    )
      throw new Error('Persistent role effort must be low or medium')
    const key = `${o.subscription}:${o.model}`
    if (!APPROVED_MODELS.has(key))
      throw new Error(
        'Model is outside the approved distribution catalog; define an explicit profile version',
      )
    if (seen.has(key)) throw new Error('Duplicate fallback model')
    seen.add(key)
  }
  if (new Set(options.map((o) => o.subscription)).size < 2)
    throw new Error('Fallbacks require distinct subscription budgets')
}
export function defaultDistributionSelection() {
  return { profile: PROFILE.id, profileDigest: recordDigest(PROFILE), overrides: {} }
}
export function resolveDistribution(selection) {
  keys(selection, ['profile', 'profileDigest', 'overrides'], 'distribution selection')
  if (selection.profile !== PROFILE.id)
    throw new Error(
      'Unknown distribution profile; retain the installed version or explicitly migrate',
    )
  if (selection.profileDigest !== recordDigest(PROFILE))
    throw new Error('Distribution profile digest mismatch; explicit policy migration required')
  const profile = structuredClone(PROFILE)
  for (const role of Object.values(profile.roles)) validateOptions(role.options, role.scope)
  const overrides = selection.overrides ?? {}
  if (!object(overrides)) throw new Error('Distribution overrides must be an object')
  for (const [seat, override] of Object.entries(overrides)) {
    if (!Object.hasOwn(profile.roles, seat)) throw new Error(`Unknown distribution role ${seat}`)
    keys(override, ['reason', 'options'], 'override')
    if (typeof override.reason !== 'string' || !override.reason.trim())
      throw new Error('Project override requires a reason')
    validateOptions(override.options, profile.roles[seat].scope)
    profile.roles[seat].options = structuredClone(override.options)
    profile.roles[seat].overrideReason = override.reason
  }
  return {
    ...profile,
    profileDigest: selection.profileDigest,
    selectionDigest: recordDigest(selection),
  }
}
export function distributionRole(profile, role) {
  const seat = Object.hasOwn(profile.roleAliases, role) ? profile.roleAliases[role] : role
  if (!Object.hasOwn(profile.roles, seat)) throw new Error(`Unknown distribution role ${role}`)
  return { seat, ...profile.roles[seat] }
}
// This is an eligibility proposal, never a dispatch, grant or effective-model attestation.
export function selectDistributionRoute({
  selection,
  role,
  availability = [],
  excludedFamilies = [],
  now = Date.now(),
  maxAgeMs = 300000,
}) {
  const profile = resolveDistribution(selection),
    resolved = distributionRole(profile, role)
  const effectiveMaxAgeMs =
    Number.isInteger(maxAgeMs) && maxAgeMs >= 10000 && maxAgeMs <= 86400000 ? maxAgeMs : 300000
  if (!Array.isArray(availability) || !Array.isArray(excludedFamilies) || !Number.isFinite(now))
    throw new Error('Invalid availability inputs')
  const reasons = []
  for (const [index, option] of resolved.options.entries()) {
    const records = availability.filter((a) => a?.subscription === option.subscription)
    const a = records.length === 1 ? records[0] : null
    const fresh =
      a &&
      Number.isFinite(a.observedAt) &&
      Number.isFinite(a.expiresAt) &&
      a.observedAt <= now &&
      now < a.expiresAt &&
      now - a.observedAt <= effectiveMaxAgeMs &&
      a.expiresAt - a.observedAt <= effectiveMaxAgeMs
    if (excludedFamilies.includes(option.providerFamily))
      reasons.push({ index, reason: 'independence-boundary' })
    else if (!fresh || a.status !== 'healthy')
      reasons.push({
        index,
        reason:
          fresh && a.status === 'unavailable' ? 'subscription-unavailable' : 'availability-unknown',
      })
    else
      return {
        status: 'eligible-proposal',
        seat: resolved.seat,
        selected: option,
        fallbackIndex: index,
        selectionDigest: profile.selectionDigest,
        reasons,
        effects: [],
      }
  }
  return { status: 'held', seat: resolved.seat, selected: null, reasons, effects: [] }
}
export function distributionDrift({ selection, installed }) {
  const profile = resolveDistribution(selection),
    differences = [],
    seen = new Set()
  if (!Array.isArray(installed) || !installed.length)
    throw new Error('Installed roster must be a non-empty array')
  for (const entry of installed) {
    if (!entry || typeof entry.seat !== 'string')
      throw new Error('Installed roster requires seat tuples')
    if (distributionRole(profile, entry.seat).seat !== entry.seat)
      throw new Error('Installed roster requires canonical seat IDs')
    if (seen.has(entry.seat)) throw new Error('Duplicate installed seat')
    seen.add(entry.seat)
    const expected = distributionRole(profile, entry.seat).options[0]
    const prefix = expected.providerRoute === 'grok' ? 'grok-cli' : expected.providerRoute
    const model = expected.runtime === 'pi' ? `${prefix}/${expected.model}` : expected.model
    for (const field of ['runtime', 'model', 'effort'])
      if (entry[field] !== (field === 'model' ? model : expected[field]))
        differences.push({
          seat: entry.seat,
          field,
          expected: field === 'model' ? model : expected[field],
          installed: entry[field] ?? null,
        })
  }
  return {
    ok: differences.length === 0,
    selectionDigest: profile.selectionDigest,
    differences,
    checkedSeats: [...seen],
    scope: 'provided-roster-only',
    liveObservation: 'not-performed',
    effects: [],
  }
}
