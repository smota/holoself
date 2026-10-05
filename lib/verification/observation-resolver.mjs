import { readFileSync } from 'node:fs'
import { recordDigest } from '../core/record-digest.mjs'
import { containedPath, fingerprintCandidate } from './workspace.mjs'
import { inspectProcessRuntime } from './process-collector.mjs'

const COLLECTOR_ID_PATTERN = /^[a-f0-9-]{36}$/

// W8f D1 — the ONE place that decides whether a verification observation is real. Everything it
// binds to is something the author of a record does not write:
//   - the collector's own storage (.agent-runs/verification/<id>/observation.json), read
//     independently and compared against the record the caller handed in;
//   - a check the TARGET's own agent-workflow.config.json configures (delivery.checks), matched by
//     criterionId and by recomputing its definitionDigest — never trusted from the record;
//   - a candidate fingerprint recomputed from the actual working tree;
//   - a runtime identity recomputed from the actual executable currently on disk.
// A record that only asserts things about itself (its own assertions, its own definitionDigest,
// its own candidateDigest) can never satisfy this on its own — every binding here is recomputed or
// independently loaded, never read from the record.
//
// Used by both `scripts/run-delivery.mjs` (the real run, via its `resolveObservation` port) and
// `scripts/validate-sdlc-role-pass.mjs` (the role-pass gate) so there is exactly one implementation
// of this trust decision — previously the gate had a second, weaker one that derived
// `requiredAssertions` from the record's own assertions and trusted the author's `definitionDigest`.
//
// This module does file I/O (collector storage, the executable on disk), so it lives outside
// lib/core/, which keeps zero outbound calls.
export function resolveObservation({ root, config, observation }) {
  const candidate = fingerprintCandidate(root, config?.candidate ?? {})
  const unresolved = {
    verified: false,
    sourceVerified: false,
    observation,
    candidateDigest: candidate.digest,
    definitionDigest: null,
    check: null,
    requiredAssertions: [],
  }
  if (
    !observation ||
    observation.origin !== 'collector-observed' ||
    typeof observation.id !== 'string' ||
    !COLLECTOR_ID_PATTERN.test(observation.id)
  )
    return unresolved

  let stored = null
  try {
    stored = JSON.parse(
      readFileSync(
        containedPath(root, `.agent-runs/verification/${observation.id}/observation.json`),
        'utf8',
      ),
    )
  } catch {
    stored = null
  }

  const check =
    Object.values(config?.checks ?? {}).find(
      (candidateCheck) =>
        candidateCheck.criterionId === observation.criterionId &&
        recordDigest({ ...candidateCheck, ...config?.candidate }) === observation.definitionDigest,
    ) ?? null
  const definitionDigest = check ? recordDigest({ ...check, ...config?.candidate }) : null

  let runtime = null
  if (check) {
    try {
      runtime = inspectProcessRuntime(root, check).identity
    } catch {
      runtime = null
    }
  }

  // The record loaded from collector storage matches the one presented to us. This is a NARROWER
  // claim than `verified` below: it says nothing yet about whether the candidate, definition or
  // runtime still line up, only that the presented record is genuinely what is on file under its
  // own id.
  const sourceVerified = stored !== null && stored.digest === observation.digest

  const verified =
    sourceVerified &&
    candidate.digest === observation.candidateDigest &&
    runtime !== null &&
    runtime.digest === observation.executionContextDigest

  return {
    verified,
    sourceVerified,
    observation: stored ?? observation,
    candidateDigest: candidate.digest,
    definitionDigest,
    check,
    requiredAssertions: check?.assertions ?? [],
  }
}
