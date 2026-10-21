import { loadConfiguredRunSource } from '../../lib/application/configured-run-source.mjs'
import { reduceRun } from '../../lib/core/run-state.mjs'
import { recordDigest } from '../../lib/core/record-digest.mjs'
import { validateArtifactRef } from '../../lib/core/artifact-ref.mjs'
import { validateExecutionReceipt } from '../../lib/core/execution-receipt.mjs'
import { validateObservation } from '../../lib/core/verification-observation.mjs'
import { classifyExecutionFailure } from './recovery.mjs'

const stages = ['produced', 'calibrated', 'independentlyAccepted', 'integrated']
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const safe = (value) =>
  typeof value === 'string' &&
  /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,159}$/.test(value) &&
  !value.startsWith('/') &&
  !value.includes('..')
const text = (value) => (safe(value) ? value : null)
async function bounded(call, timeoutMs) {
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(call),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('unavailable')), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
function validExecution(record) {
  try {
    return validateExecutionReceipt(record).ok
  } catch {
    return false
  }
}
const empty = (reason) => ({
  version: 1,
  status: 'unknown',
  assurance: 'cooperative',
  source: null,
  observation: null,
  failures: 0,
  incidents: [],
  oracles: [],
  unknowns: [reason],
})
function sourceIdentity(source) {
  if (!['github', 'local-preview'].includes(source?.kind) || !safe(source.runId))
    throw new Error('source')
  if (source.kind === 'github' && (!safe(source.repo) || !source.repo.includes('/')))
    throw new Error('source')
  return {
    kind: source.kind,
    runId: source.runId,
    ...(source.kind === 'github'
      ? { repo: source.repo, branch: text(source.branch) ?? 'agentflow-state' }
      : {}),
  }
}

// These callbacks are trusted host integration ports, never values decoded from a CLI
// request or checkpoint. A source digest establishes integrity, not authenticated authorship.
export async function summarizeIncidentEvidence({
  resolveSource,
  resolveEvidence,
  timeoutMs = 1000,
} = {}) {
  if (
    typeof resolveSource !== 'function' ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 60000
  )
    return empty('source-unavailable')
  const deadline = Date.now() + timeoutMs
  let remainingEvidence = 500
  let remainingClaims = 500
  let snapshot, source, state
  try {
    snapshot = await bounded(resolveSource, timeoutMs)
    if (
      !Array.isArray(snapshot.events) ||
      snapshot.events.length > 10000 ||
      snapshot.events.some((event) => !safe(event?.id))
    )
      throw new Error('source bounds')
    source = sourceIdentity(snapshot.source)
    state = reduceRun(snapshot.events)
    if (!state || state.runId !== source.runId || state.revision !== snapshot.revision)
      throw new Error('source')
  } catch {
    return empty('source-unavailable-or-invalid')
  }
  const result = {
    version: 1,
    status: 'observed',
    assurance: 'cooperative',
    source,
    observation: {
      runRevision: state.revision,
      sourceRevision: text(snapshot.sourceRevision),
      generation: state.generation,
      revocationEpoch: state.revocationEpoch,
    },
    failures: 0,
    incidents: [],
    oracles: [],
    unknowns: [],
  }
  const seen = new Set(),
    counted = new Set(),
    packages = new Map()
  for (const event of snapshot.events) {
    const identity = { source: recordDigest(source), eventId: event.id, eventDigest: event.digest }
    const key = recordDigest(identity)
    if (seen.has(key)) continue
    seen.add(key)
    const envelope = event.kind === 'checkpoint' ? event.payload?.incidentEvidence : null
    if (!envelope || envelope.version !== 1) continue
    const resolve = async (ref) => {
      try {
        if (
          typeof resolveEvidence !== 'function' ||
          !ref ||
          typeof ref !== 'object' ||
          !validateArtifactRef(ref).ok ||
          !sha(ref.digest) ||
          typeof ref.revision !== 'string' ||
          !ref.revision ||
          remainingEvidence-- <= 0 ||
          Date.now() >= deadline
        )
          return null
        const evidence = await bounded(
          () =>
            resolveEvidence({
              ref: structuredClone(ref),
              eventIdentity: structuredClone(identity),
              source: structuredClone(source),
            }),
          Math.max(1, deadline - Date.now()),
        )
        if (
          evidence?.eventId !== event.id ||
          evidence.eventDigest !== event.digest ||
          evidence.revision !== ref.revision ||
          evidence.digest !== ref.digest ||
          recordDigest(evidence.record) !== ref.digest
        )
          return null
        return evidence
      } catch {
        return null
      }
    }
    if (envelope.executionRef) {
      const item = {
        identity,
        timestamp: new Date(event.timestamp).toISOString(),
        runId: state.runId,
        generation:
          Number.isInteger(event.generation) && event.generation >= 0 ? event.generation : null,
        executionStatus: null,
        classification: 'unknown',
        actual: null,
        configuredIntent: null,
        unknowns: [],
      }
      if (envelope.configuredIntent && typeof envelope.configuredIntent === 'object')
        item.configuredIntent = Object.fromEntries(
          ['runtime', 'providerRoute', 'model', 'effort', 'profile']
            .map((field) => [field, text(envelope.configuredIntent[field])])
            .filter(([, value]) => value !== null),
        )
      const evidence = await resolve(envelope.executionRef)
      if (evidence && validExecution(evidence.record)) {
        const receipt = evidence.record,
          receiptKey = recordDigest({
            source: identity.source,
            revision: envelope.executionRef.revision,
            digest: envelope.executionRef.digest,
          }),
          observed = evidence.observedExecution
        item.executionStatus = receipt.status
        item.actual = {
          runtime: text(receipt.actual.platform),
          executionTarget: text(receipt.actual.target),
          transport: text(receipt.actual.transport),
          model: text(receipt.actual.model),
          providerRoute: null,
          effort: null,
        }
        // Additional observations must agree with canonical receipt fields; configured intent
        // never completes missing actual fields. The resolver owns provider observation trust.
        if (
          observed &&
          observed.runtime === receipt.actual.platform &&
          observed.model === receipt.actual.model
        ) {
          item.actual.providerRoute = text(observed.providerRoute)
          item.actual.effort = text(observed.effort)
        }
        if (receipt.status === 'failed')
          item.classification = classifyExecutionFailure({
            structuredError: receipt.metadata?.structuredError,
            nowMs: Date.parse(event.timestamp),
          }).classification
        if (item.classification !== 'unknown' && !counted.has(receiptKey)) {
          result.failures++
          counted.add(receiptKey)
        } else if (receipt.status === 'failed' && item.classification === 'unknown')
          item.unknowns.push('structured-failure-unavailable')
      } else item.unknowns.push('execution-evidence-unresolved')
      result.incidents.push(item)
    }
    if (
      Array.isArray(envelope.oracle) &&
      envelope.oracle.length > 100 &&
      !result.unknowns.includes('oracle-claims-truncated')
    )
      result.unknowns.push('oracle-claims-truncated')
    for (const claim of Array.isArray(envelope.oracle) ? envelope.oracle.slice(0, 100) : []) {
      if (--remainingClaims < 0) break
      if (
        !stages.includes(claim?.stage) ||
        !sha(claim.artifactDigest) ||
        !sha(claim.candidateDigest)
      )
        continue
      const packageKey = `${claim.artifactDigest}:${claim.candidateDigest}`
      let entry = packages.get(packageKey)
      if (!entry) {
        entry = {
          artifactDigest: claim.artifactDigest,
          candidateDigest: claim.candidateDigest,
          states: Object.fromEntries(stages.map((stage) => [stage, 'unknown'])),
          evidence: [],
        }
        packages.set(packageKey, entry)
      }
      const evidence = await resolve(claim.evidenceRef),
        record = evidence?.record
      if (
        !record ||
        !validateObservation(record).ok ||
        !['collector-observed', 'external-resolved'].includes(record.origin) ||
        record.candidateDigest !== claim.candidateDigest ||
        record.subject?.artifactDigest !== claim.artifactDigest ||
        record.subject?.stage !== claim.stage ||
        record.criterionId !== `oracle.${claim.stage}`
      )
        continue
      const assertion = record.assertions.find((item) => item.id === `oracle.${claim.stage}`)
      let status = 'unknown'
      if (record.outcome === 'fail' && assertion?.outcome === 'fail') status = 'rejected'
      if (record.outcome === 'pass' && assertion?.outcome === 'pass') {
        if (
          claim.stage !== 'independentlyAccepted' ||
          (record.origin === 'external-resolved' &&
            safe(record.subject.authorIdentity) &&
            safe(record.subject.reviewerIdentity) &&
            record.subject.authorIdentity.toLowerCase() !==
              record.subject.reviewerIdentity.toLowerCase() &&
            record.assertions.some(
              (a) => a.id === 'oracle.independent-review' && a.outcome === 'pass',
            ))
        )
          status = 'verified'
      }
      // Conflicting proof is explicit, never last-writer-wins acceptance.
      const previous = entry.states[claim.stage]
      entry.states[claim.stage] =
        previous === 'unknown'
          ? status
          : status === 'unknown' || status === previous
            ? previous
            : 'conflicting'
      entry.evidence.push({
        stage: claim.stage,
        status,
        identity,
        observationDigest: claim.evidenceRef.digest,
      })
    }
  }
  result.oracles = [...packages.values()]
  if (remainingEvidence <= 0 || remainingClaims < 0 || Date.now() >= deadline)
    result.unknowns.push('evidence-budget-exhausted')
  if (typeof resolveEvidence !== 'function') result.unknowns.push('evidence-reader-unavailable')
  return result
}

// Read-only configured-source adapter. No default evidence resolver, authentication lookup,
// execution dispatch, new ledger, or promotion of unsigned local records into human authority.
export async function summarizeConfiguredIncidents({
  root,
  runId,
  client,
  resolveEvidence,
  timeoutMs,
} = {}) {
  return summarizeIncidentEvidence({
    timeoutMs,
    resolveEvidence,
    resolveSource: async () => {
      const loaded = await loadConfiguredRunSource({ root, runId, client })
      const snapshot = await loaded.store.read({ cache: false })
      if (snapshot.revision !== loaded.revision) throw new Error('source changed')
      return { ...snapshot, source: loaded.source }
    },
  })
}
