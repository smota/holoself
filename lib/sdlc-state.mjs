import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CANONICAL_TRANSITIONS,
  CANONICAL_VOCABULARY,
  CORE_ROLES,
  PRINCIPLES,
} from './sdlc-vocabulary.mjs'

export const SDLC_CONFIG_PATH = 'sdlc.config.json'
export const DEFAULT_SDLC_CONFIG_PATH = 'defaults/sdlc.config.json'

// D3 (W8g): the package's OWN root directory, resolved from where this module file lives, not
// from the caller-supplied repoRoot. In an adopter checkout, repoRoot is the CONSUMER's project
// directory — there is no `defaults/` folder there, and there never should be one; the packaged
// default config only ever exists next to this file, wherever the `agentflow-sdlc` package itself
// was installed (this repo's own checkout, or a consumer's node_modules/agentflow-sdlc). Deriving
// the fallback from repoRoot instead of from the package's own location was the bug: it made
// `package-parity-smoke` fail with `ENOENT ... consumer/defaults/sdlc.config.json` because a
// packed install run from the consumer's cwd looked for `defaults/` under the CONSUMER's project,
// not under the installed package.
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

// Fixed values an adopter file used to declare as if they were a choice. `executionAdapter` is
// always this path; nothing in the codebase resolves it any other way. These three deliveryPolicy
// fields already lived behind a hard `fixed` block in lib/core/delivery-policy.mjs that throws if
// an adopter configures a different value, so hardcoding them here just stops the adopter file
// from pretending otherwise.
const FIXED_EXECUTION_ADAPTER = 'agent-workflow.config.json'
const FIXED_DELIVERY_POLICY = Object.freeze({
  contractVersion: 2,
  unknownWriterBlocksRecovery: true,
  admissionBudgetRejectsUnknownUsage: true,
})

// Merges a canonical list (roles or transitions) with whatever the adopter's own file adds.
// `identityOf` gives each entry a key: a role's slug, or a transition's "from->to" pair. A
// canonical entry always wins; an adopter entry with a new identity is appended (this is how
// extensionPolicy.mayAdd's "roles" permission is actually implemented); an adopter entry that
// reuses a canonical identity with a *different* definition is refused outright, because that
// would be silently redefining one of the nine canonical roles rather than adding one.
function mergeCanonical(canonical, adopterItems, identityOf, label) {
  const byIdentity = new Map(canonical.map((item) => [identityOf(item), item]))
  const merged = [...canonical]
  for (const item of adopterItems ?? []) {
    const id = identityOf(item)
    const existing = byIdentity.get(id)
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(item)) {
        throw new Error(
          `Adopter config redefines canonical ${label} "${id}"; canonical ${label}s cannot be ` +
            `changed. Use extensionPolicy.mayAdd to add a new ${label} with a different identity instead.`,
        )
      }
      continue
    }
    merged.push(item)
    byIdentity.set(id, item)
  }
  return merged
}

function roleIdentity(role) {
  return role?.slug
}

function transitionIdentity(pair) {
  return `${pair?.[0]}->${pair?.[1]}`
}

// The adopter file (sdlc.config.json, falling back to the packaged default) carries only genuine
// choices: paths, labels, release, gateways, extensionPolicy, authority.human/machine, and the
// operational parts of deliveryPolicy. Product constants — vocabulary, the nine canonical roles,
// their derived transitions, the seven guiding principles, the fixed execution adapter path, and
// the fixed deliveryPolicy internals — are merged in here so every one of the existing consumers
// of `config.roles` / `config.transitions` / `config.vocabulary` keeps seeing exactly the same
// shape it always did, without the adopter file having to carry (and risk breaking) any of it.
function mergeProductConstants(adopter = {}) {
  const { highAssuranceHumanReviewPhase: _dead, ...deliveryPolicyRest } =
    adopter.deliveryPolicy ?? {}
  return structuredClone({
    ...adopter,
    authority: { ...adopter.authority, executionAdapter: FIXED_EXECUTION_ADAPTER },
    principles: PRINCIPLES,
    vocabulary: CANONICAL_VOCABULARY,
    roles: mergeCanonical(CORE_ROLES, adopter.roles, roleIdentity, 'role'),
    transitions: mergeCanonical(
      CANONICAL_TRANSITIONS,
      adopter.transitions,
      transitionIdentity,
      'transition',
    ),
    deliveryPolicy: { ...deliveryPolicyRest, ...FIXED_DELIVERY_POLICY },
  })
}

export function loadSdlcConfig(repoRoot = process.cwd(), configPath = SDLC_CONFIG_PATH) {
  const path = `${repoRoot}/${configPath}`
  // D3 (W8g): resolved against PACKAGE_ROOT, not repoRoot — see the constant's comment above.
  const fallback = join(PACKAGE_ROOT, DEFAULT_SDLC_CONFIG_PATH)
  const source = existsSync(path) ? path : fallback
  const adopter = JSON.parse(readFileSync(source, 'utf8'))
  return mergeProductConstants(adopter)
}

export function roleSlugs(config) {
  return new Set((config.roles || []).map((role) => role.slug))
}

export function validateSdlcConfigShape(config = {}) {
  const findings = []
  if (config.version !== 1) findings.push(finding('blocker', 'config.version', 'version must be 1'))
  for (const key of [
    'authority',
    'roles',
    'paths',
    'labels',
    'release',
    'gateways',
    'extensionPolicy',
  ]) {
    if (config[key] === undefined)
      findings.push(finding('blocker', `config.${key}`, `${key} is required`))
  }
  if (!Array.isArray(config.roles) || !config.roles.length) {
    findings.push(finding('blocker', 'config.roles', 'at least one role is required'))
  }
  const slugs = roleSlugs(config)
  if (slugs.size !== (config.roles ?? []).length) {
    findings.push(finding('high', 'config.roles', 'role slugs must be unique'))
  }
  for (const [pathName, path] of Object.entries(config.paths || {})) {
    for (const role of [...(path.requiredRoles || []), ...(path.optionalRoles || [])]) {
      if (!slugs.has(role))
        findings.push(finding('high', `paths.${pathName}`, `unknown role ${role}`))
    }
    if (pathName === 'high-assurance' && path.requiresHumanApproval !== true) {
      findings.push(
        finding('blocker', 'paths.high-assurance', 'high-assurance must require human approval'),
      )
    }
    if (pathName === 'high-assurance' && path.allowsSelfReview !== false) {
      findings.push(
        finding('blocker', 'paths.high-assurance', 'high-assurance must forbid self-review'),
      )
    }
  }
  for (const pair of config.transitions || []) {
    if (!Array.isArray(pair) || pair.length !== 2 || !slugs.has(pair[0]) || !slugs.has(pair[1])) {
      findings.push(
        finding('medium', 'config.transitions', `invalid transition ${JSON.stringify(pair)}`),
      )
    }
  }
  if (config.vocabulary !== undefined) {
    for (const field of [
      'rolePassStatuses',
      'artifactKinds',
      'sourceAuthorities',
      'artifactRelationships',
      'actionBoundaries',
    ]) {
      const values = config.vocabulary?.[field]
      if (values === undefined) continue
      if (
        !Array.isArray(values) ||
        !values.length ||
        values.some((value) => typeof value !== 'string' || !value.trim()) ||
        new Set(values).size !== values.length
      ) {
        findings.push(
          finding(
            'high',
            `config.vocabulary.${field}`,
            `${field} must be unique non-empty strings`,
          ),
        )
      }
    }
  }
  if (config.actionPolicy !== undefined) {
    const boundaries = new Set(config.vocabulary?.actionBoundaries ?? [])
    if (config.actionPolicy.profileMaximums !== undefined) {
      for (const pathName of Object.keys(config.paths ?? {})) {
        const maximum = config.actionPolicy.profileMaximums?.[pathName]
        if (!maximum || (boundaries.size && !boundaries.has(maximum))) {
          findings.push(
            finding(
              'high',
              `config.actionPolicy.profileMaximums.${pathName}`,
              `missing or unknown action boundary for profile ${pathName}`,
            ),
          )
        }
      }
    }
    if (config.actionPolicy.delegationMayNotWidenBoundary === false) {
      findings.push(
        finding(
          'blocker',
          'config.actionPolicy.delegationMayNotWidenBoundary',
          'delegation must not widen the action boundary',
        ),
      )
    }
  }
  return report(findings)
}

export function releaseCandidateFromIssue(issue = {}) {
  const body = issue.body || ''
  const explicit = body.match(
    /(?:target release|release|version)\s*:?\s*(v\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/i,
  )?.[1]
  if (explicit) return explicit
  const milestone = typeof issue.milestone === 'string' ? issue.milestone : issue.milestone?.title
  if (/^v\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/i.test(milestone || '')) return milestone
  return null
}

export function releaseImpactFromIssue(issue = {}) {
  const body = issue.body || ''
  const labels = (issue.labels || []).map((label) =>
    typeof label === 'string' ? label : label.name,
  )
  if (/no release impact|internal-only/i.test(body)) return 'none'
  if (/docs-only|documentation/i.test(body) || labels.includes('documentation')) return 'docs-only'
  if (/breaking|major/i.test(body)) return 'major'
  if (/feature|minor/i.test(body) || labels.includes('feature')) return 'minor'
  if (/bug|fix|patch/i.test(body) || labels.includes('bug')) return 'patch'
  return 'unknown'
}

export function releaseAssignmentState(issue = {}) {
  const impact = releaseImpactFromIssue(issue)
  if (impact === 'none') return 'no-release-impact'
  if (issue.state === 'closed' && !hasLabel(issue, 'awaiting-release')) return 'released'
  return releaseCandidateFromIssue(issue) ? 'assigned' : 'needs-assignment'
}

export function selectedPathFromIssue(issue = {}, config = loadSdlcConfig()) {
  const body = issue.body || ''
  const explicit = body.match(
    /(?:profile|workflow classification)\s*:?\s*(bounded|standard|high-assurance|exploratory)/i,
  )?.[1]
  if (explicit) return explicit.toLowerCase()
  const labels = (issue.labels || []).map((label) =>
    typeof label === 'string' ? label : label.name,
  )
  if (
    /security|auth|remote|migration|data loss|production|high-assurance/i.test(body) ||
    labels.some((label) => /security|high-risk/i.test(label))
  )
    return 'high-assurance'
  if (/exploratory|spike|research/i.test(body) || labels.includes('exploratory'))
    return 'exploratory'
  if (/docs-only|typo|bounded|low-risk/i.test(body)) return 'bounded'
  return config.paths?.standard ? 'standard' : Object.keys(config.paths || {})[0]
}

export function readinessDenominatorForPath(pathName, config = loadSdlcConfig()) {
  return new Set(config.paths?.[pathName]?.requiredRoles || [])
}

export function parseEnvelope(markdown = '', type = 'ROLE-PASS') {
  const re = new RegExp(
    `<!-- \\[AGENTFLOW-${type}-v1\\] -->([\\s\\S]*?)<!-- \\[/AGENTFLOW-${type}-v1\\] -->`,
    'g',
  )
  const entries = []
  for (const match of markdown.matchAll(re)) {
    const json = match[1].match(/```json\s*([\s\S]*?)```/i)?.[1]
    if (!json) continue
    try {
      entries.push(JSON.parse(json))
    } catch {
      entries.push({ malformed: true, raw: json.slice(0, 200) })
    }
  }
  return entries
}

export function validateNoForbiddenEvidenceText(text = '') {
  const findings = []
  if (/BEGIN (RSA|OPENSSH|PRIVATE) KEY|api[_-]?key\s*=|secret\s*=|token\s*=/i.test(text)) {
    findings.push(finding('blocker', 'evidence.secrets', 'possible secret in durable evidence'))
  }
  if (/(^|\n)(User|Assistant|Tool|System):/i.test(text) && text.length > 2000) {
    findings.push(
      finding('high', 'evidence.raw-log', 'possible raw prompt/transcript/log in durable evidence'),
    )
  }
  return report(findings)
}

export function validateIssueAgainstSdlc(issue = {}, config = loadSdlcConfig()) {
  const findings = []
  const labels = (issue.labels || [])
    .map((label) => (typeof label === 'string' ? label : label.name))
    .filter(Boolean)
  const typeLabels = new Set(config.labels?.type || [])
  if (!labels.some((label) => typeLabels.has(label)))
    findings.push(finding('high', 'issue.labels.type', 'missing primary type/domain label'))
  if (
    labels.some((label) =>
      (config.labels?.forbiddenPrefixes || []).some((prefix) => label.startsWith(prefix)),
    )
  )
    findings.push(
      finding('blocker', 'issue.labels.forbidden', 'forbidden deprecated label prefix present'),
    )
  if (!/##\s+Acceptance criteria/im.test(issue.body || ''))
    findings.push(finding('medium', 'issue.acceptance', 'missing Acceptance criteria section'))
  if (
    releaseAssignmentState(issue) === 'needs-assignment' &&
    releaseImpactFromIssue(issue) !== 'unknown'
  )
    findings.push(
      finding(
        'medium',
        'issue.release.assignment',
        'release-impact issue needs release assignment or no-impact decision',
      ),
    )
  return report(findings)
}

export function finding(severity, code, message, extra = {}) {
  return { severity, code, message, ...extra }
}

export function report(findings = [], profile = 'sdlc') {
  return {
    ok: findings.every((item) => !['blocker', 'high'].includes(item.severity)),
    profile,
    findings,
  }
}

function hasLabel(issue, name) {
  return (issue.labels || []).some(
    (label) => (typeof label === 'string' ? label : label.name) === name,
  )
}
