export const ROLE_PASS_STATUSES = ['pass', 'blocked', 'returned', 'skipped']
// The nine canonical SDLC role definitions. This is the single source of truth: it used to be
// duplicated (with less fidelity) in defaults/sdlc.config.json, which forced every consuming
// project to carry a full copy of product constants it could break but never legitimately change.
// loadSdlcConfig (lib/sdlc-state.mjs) now merges these in at load time instead.
export const CORE_ROLES = Object.freeze([
  {
    phase: 0,
    slug: 'product-manager',
    label: 'Product manager / JTBD',
    owns: ['goal', 'job', 'release-intent'],
  },
  {
    phase: 1,
    slug: 'analyst',
    label: 'Analyst',
    owns: ['requirements', 'acceptance-criteria', 'scope-boundary'],
  },
  {
    phase: 2,
    slug: 'architect',
    label: 'Architect',
    owns: ['technical-design', 'risk', 'path-selection'],
  },
  {
    phase: 3,
    slug: 'implementation-planner',
    label: 'Developer planning',
    owns: ['implementation-plan', 'validation-plan'],
  },
  {
    phase: 4,
    slug: 'developer',
    label: 'Developer',
    owns: ['implementation', 'commit-evidence'],
  },
  {
    phase: 5,
    slug: 'tester',
    label: 'Tester',
    owns: ['validation-evidence', 'coverage-notes'],
  },
  {
    phase: 6,
    slug: 'reviewer',
    label: 'Reviewer',
    owns: ['review-findings', 'independence-boundary'],
  },
  {
    phase: 7,
    slug: 'technical-writer',
    label: 'Technical writer',
    owns: ['docs', 'release-notes', 'product-language'],
  },
  {
    phase: 8,
    slug: 'pr-readiness',
    label: 'PR readiness',
    owns: ['pr-manifest', 'merge-readiness', 'follow-up-status'],
  },
])
// Transitions are mechanically derivable from CORE_ROLES's phase ordering (the same "linear plus
// three return edges" shape sdlc-definition.md describes), but are kept explicit rather than
// generated so they read the same way they always have.
export const CANONICAL_TRANSITIONS = Object.freeze([
  ['product-manager', 'analyst'],
  ['analyst', 'architect'],
  ['architect', 'implementation-planner'],
  ['implementation-planner', 'developer'],
  ['developer', 'tester'],
  ['tester', 'reviewer'],
  ['reviewer', 'technical-writer'],
  ['technical-writer', 'pr-readiness'],
  ['developer', 'implementation-planner'],
  ['reviewer', 'developer'],
  ['technical-writer', 'developer'],
  ['pr-readiness', 'developer'],
])
// The four autonomy postures. lib/core/posture.mjs reads this; it is the only definition.
export const POSTURES = Object.freeze(['advisory', 'assisted', 'delegated', 'autonomous'])
export const DEFAULT_PROFILE_REQUIREMENTS = Object.freeze({
  light: {
    required: [
      'analyst',
      'implementation-planner',
      'developer',
      'tester',
      'reviewer',
      'pr-readiness',
    ],
    optional: ['product-manager', 'architect', 'technical-writer'],
  },
  bounded: {
    required: [
      'analyst',
      'implementation-planner',
      'developer',
      'tester',
      'reviewer',
      'pr-readiness',
    ],
    optional: ['product-manager', 'architect', 'technical-writer'],
  },
  standard: {
    required: [
      'analyst',
      'architect',
      'implementation-planner',
      'developer',
      'tester',
      'reviewer',
      'pr-readiness',
    ],
    optional: ['product-manager', 'technical-writer'],
  },
  'high-assurance': { required: CORE_ROLES.map((role) => role.slug), optional: [] },
  exploratory: {
    required: ['product-manager', 'analyst', 'architect', 'reviewer'],
    optional: ['implementation-planner', 'developer', 'tester', 'technical-writer', 'pr-readiness'],
  },
})
export const ARTIFACT_KINDS = [
  'goal',
  'requirement',
  'design',
  'plan',
  'implementation',
  'validation',
  'review',
  'release',
  'incident',
  'other',
]
export const SOURCE_AUTHORITIES = ['authoritative', 'working-copy', 'mirror']
export const ARTIFACT_RELATIONSHIPS = [
  'input',
  'output',
  'supersedes',
  'verifies',
  'implements',
  'observes',
]
export const ACTION_BOUNDARIES = [
  'observe',
  'propose',
  'mutate-worktree',
  'open-pr',
  'external-action',
]
// W8e / D5 — the evidence/record vocabulary a newcomer actually meets in raw `run` output
// (candidateDigest, definitionDigest, boundary, generation, revision — see finding 7). The entry
// document's doc lint (scripts/validate-docs.mjs) used to check its own private, closed
// GLOSSARY_TERMS list, so "digest" and "candidate" passed silently even though the document used
// them undefined — a term simply missing from that list was never caught. Sourcing these terms from
// the product's own vocabulary module instead means the lint no longer depends on someone having
// remembered to add a second, separate entry for a word already central to the product's own
// concepts.
export const EVIDENCE_VOCABULARY_TERMS = Object.freeze([
  'digest',
  'candidate',
  'boundary',
  'generation',
  'revision',
])
// The full `vocabulary` block loadSdlcConfig merges in verbatim. Not adopter-extensible: an
// adopter cannot add a role-pass status or artifact kind without breaking every validator that
// enumerates these values, so there is nothing to merge here — product only.
export const CANONICAL_VOCABULARY = Object.freeze({
  rolePassStatuses: ROLE_PASS_STATUSES,
  artifactKinds: ARTIFACT_KINDS,
  sourceAuthorities: SOURCE_AUTHORITIES,
  artifactRelationships: ARTIFACT_RELATIONSHIPS,
  actionBoundaries: ACTION_BOUNDARIES,
  postures: POSTURES,
})
// Seven prose statements with zero code references anywhere; kept as a product constant purely
// for human-readable framing, not because any validator reads them.
export const PRINCIPLES = Object.freeze([
  'AgentFlow concepts lead; source systems are substrate.',
  'Durable evidence is required for delivery claims.',
  'Single-agent is default; multi-agent claims require attribution.',
  'High-assurance work requires a human approval gate.',
  'Skipped-by-path roles do not reduce readiness.',
  'Follow-up issues replace hidden TODOs.',
  'Harness directories contain generated adapters only.',
])
// high-assurance is the one profile already built for this level of trust: full role coverage, no
// self-review, and a mandatory human approval gate. Raising ITS ceiling to external-action makes
// the boundary reachable for the path designed to carry it, without handing bounded, standard, or
// exploratory work any authority they never asked for.
export const DEFAULT_PROFILE_MAXIMUMS = Object.freeze({
  light: 'open-pr',
  bounded: 'open-pr',
  standard: 'open-pr',
  'high-assurance': 'external-action',
  exploratory: 'propose',
})

export function sdlcVocabulary(config = {}) {
  const configured = config.vocabulary ?? {}
  const roles = config.roles?.length ? config.roles : CORE_ROLES
  const paths =
    config.paths && Object.keys(config.paths).length ? config.paths : DEFAULT_PROFILE_REQUIREMENTS
  return {
    roles: roles.map((role) => role.slug),
    profiles: Object.keys(paths),
    rolePassStatuses: configured.rolePassStatuses ?? ROLE_PASS_STATUSES,
    artifactKinds: configured.artifactKinds ?? ARTIFACT_KINDS,
    sourceAuthorities: configured.sourceAuthorities ?? SOURCE_AUTHORITIES,
    artifactRelationships: configured.artifactRelationships ?? ARTIFACT_RELATIONSHIPS,
    actionBoundaries: configured.actionBoundaries ?? ACTION_BOUNDARIES,
  }
}

export function actionBoundaryRank(boundary, config = {}) {
  return sdlcVocabulary(config).actionBoundaries.indexOf(boundary)
}

export function actionBoundaryAllows(parentBoundary, childBoundary, config = {}) {
  const parentRank = actionBoundaryRank(parentBoundary, config)
  const childRank = actionBoundaryRank(childBoundary, config)
  return parentRank >= 0 && childRank >= 0 && childRank <= parentRank
}

export function canonicalRole(role, config = {}) {
  const normalized = String(role ?? '')
    .trim()
    .toLowerCase()
  const match = (config.roles?.length ? config.roles : CORE_ROLES).find(
    (item) => item.slug === normalized || item.label?.toLowerCase() === normalized,
  )
  return match?.slug ?? null
}

export function normalizeRole(role, config = {}) {
  const input = String(role ?? '')
    .trim()
    .toLowerCase()
  const canonical = canonicalRole(input, config)
  return {
    input,
    canonical,
  }
}

export function isAllowedTransition(fromRole, toRole, config = {}) {
  return (config.transitions ?? []).some(([from, to]) => from === fromRole && to === toRole)
}
