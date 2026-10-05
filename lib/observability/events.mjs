import { createHash } from 'node:crypto'
import { RUN_ROLES } from '../core/run-state.mjs'

const counter = (value) => Number.isSafeInteger(value) && value >= 0
const measure = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0
const oneOf =
  (...values) =>
  (value) =>
    values.includes(value)
const nullable = (check) => (value) => value === null || check(value)
const identity = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const correlations = Object.fromEntries(
  ['runId', 'sessionId', 'attemptId', 'operationId', 'eventId'].map((key) => [key, identity]),
)
const hashedIdentifiers = new Set([
  ...Object.keys(correlations),
  'commitSha',
  'branchRef',
  'worktreePath',
])
const digests = Object.fromEntries(
  ['candidateDigest', 'planDigest', 'policyDigest', 'grantDigest'].map((key) => [key, digest]),
)
const eventKind = oneOf(
  'started',
  'contract-frozen',
  'candidate',
  'observation',
  'budget-admission',
  'advanced',
  'returned',
  'rework-resolved',
  'paused',
  'blocked',
  'resumed',
  'operation',
  'cancelled',
  'completed',
  'checkpoint',
  'grant-issued',
  'grant-revoked',
  'operation-admitted',
  'delegation-safety',
)
const errorType = nullable(
  oneOf(
    'GitHubCliError',
    'GitHubApiError',
    'TransportError',
    'ParseError',
    'StoreError',
    'ExportError',
  ),
)
const transition = {
  eventKind,
  fromPhase: nullable((value) => Number.isInteger(value) && value >= 0 && value < RUN_ROLES.length),
  toPhase: (value) => Number.isInteger(value) && value >= 0 && value < RUN_ROLES.length,
  fromRole: nullable(oneOf(...RUN_ROLES)),
  toRole: oneOf(...RUN_ROLES),
}
const source = {
  method: oneOf('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'),
  status: nullable((value) => Number.isInteger(value) && value >= 100 && value <= 599),
  requestBytes: counter,
  responseBytes: nullable(counter),
  duration: measure,
  errorType,
}

export const OBSERVATION_FIELDS = Object.freeze({
  github_cli_request: source,
  github_client_request: source,
  run_event_attempted: transition,
  run_event_appended: transition,
  run_event_failed: { ...transition, errorType },
  session: { state: oneOf('started', 'completed', 'failed'), duration: measure },
  file_read: {
    bytes: counter,
    files: counter,
    purpose: oneOf('policy', 'context', 'candidate', 'evidence', 'configuration'),
  },
  context_admitted: { bytes: counter, repeatedBytes: counter, policyBytes: counter },
  execution_attempt: {
    state: oneOf('started', 'completed', 'failed', 'cancelled', 'unknown'),
    duration: measure,
  },
  process_stage: {
    stage: oneOf('coordination', 'human-wait', 'ci', 'first-evidence'),
    duration: measure,
  },
  usage: {
    inputTokens: counter,
    outputTokens: counter,
    cachedInputTokens: counter,
    totalTokens: counter,
  },
  verification: { outcome: oneOf('pass', 'fail', 'unknown'), duration: measure },
  recovery: {
    outcome: oneOf('resumed', 'blocked', 'unknown'),
    duration: measure,
    temperature: oneOf('cold', 'warm', 'unknown'),
  },
  meshloop_execution_attempt: {
    state: oneOf('started', 'completed', 'failed', 'cancelled', 'unknown'),
    duration: nullable(measure),
  },
  meshloop_engineering_metrics: {
    astReductionRatio: (value) =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1,
    lyapunovIterations: counter,
    orphanProcessCount: counter,
    worktreeLockWaitMs: nullable(measure),
    duration: nullable(measure),
  },
  meshloop_commit_ingested: {
    commitSha: (value) => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value),
    branchRef: (value) => typeof value === 'string' && value.length > 0 && value.length <= 256,
    filesCount: counter,
    worktreePath: nullable((value) => typeof value === 'string' && value.length <= 512),
  },
})

// Closed value domains stop secrets hidden under otherwise permitted attribute names.
// Identifiers are hashed because run IDs, refs, and paths can contain private text.
export function normalizeObservation(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !Object.hasOwn(OBSERVATION_FIELDS, value.kind)
  )
    return null
  const checks = { ...OBSERVATION_FIELDS[value.kind], ...correlations, ...digests }
  const result = { kind: value.kind, schemaVersion: 1 }
  for (const [key, field] of Object.entries(value)) {
    if (key === 'kind' || field === undefined) continue
    if (!Object.hasOwn(checks, key) || !checks[key](field)) return null
    result[key] =
      hashedIdentifiers.has(key) && field !== null
        ? createHash('sha256').update(field).digest('hex')
        : field
  }
  return result
}

// Only finite category values are metric dimensions. Measurements and correlation
// digests belong in values/spans, never metric labels.
export function metricLabels(event) {
  return Object.fromEntries(
    [
      'kind',
      'method',
      'status',
      'errorType',
      'eventKind',
      'state',
      'purpose',
      'outcome',
      'stage',
      'temperature',
    ]
      .filter((key) => event[key] !== undefined && event[key] !== null)
      .map((key) => [key, event[key]]),
  )
}
