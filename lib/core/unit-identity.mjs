import { requireText } from './delivery-record.mjs'

// D1 (W8c) — the ONE identity function. A unit's identity is stable across edits — unlike its
// revision, the content digest computed by goal-revision.mjs, which changes on every edit. Relations
// (partOf), the unit graph, and run ids all bind to IDENTITY, never revision: keying any of those by
// revision would break them the instant someone edits an issue (see w8c-identity-revision.test.mjs
// test 3). Namespaced by source and repo so two repositories can never collide on the same
// source-native number (test 4) — this is what a bare `${n}` template, in any of its four prior
// spellings (`goal:${n}`, `issue:${n}`, `issue-${n}`, `readiness-${n}`), could never guarantee.
export function unitIdentity({ source = 'github', repo, id } = {}) {
  requireText(source, 'source')
  if (id === null || id === undefined || id === '') throw new Error('id is required')
  return `${source}:${repo || 'unscoped'}:${id}`
}

// Run ids are constrained to [\w-]{1,100} by the durable run store (see
// lib/sources/github-run-store.mjs's own validation) — identity itself is not shaped like that (it
// carries `:` and the repo's own `/`). This derives a run id from identity deterministically, by
// character substitution — never by re-deriving identity a second, different way, which is exactly
// how a human's `close-unit` (scripts/cockpit-server.mjs) and the actuator
// (scripts/actuate-readiness.mjs) ended up writing to two different runs for the same unit (W8c
// finding 1). Both call sites now derive their run id by calling `unitRunId(unitIdentity(...))` over
// the SAME (source, repo, id) — never a hand-rolled template string.
export function unitRunId(identity) {
  requireText(identity, 'identity')
  return identity.replace(/[^\w-]/g, '-')
}

// D1 (W8c2) — a run id is always DERIVED, never accepted on trust. W8c already fixed close-unit and
// the actuator to derive from the SAME (source, repo, id) via unitRunId(unitIdentity(...)); the
// defect this closes is narrower but just as real: `payload.runId || unitRunId(...)` let a
// client-supplied runId WIN over the derived one whenever it was present, so a client could anchor a
// human's decision in any run it liked — the exact class of bug W8a already fixed for
// `subjectDigest` (lib/cockpit-actions.mjs's resolveUnitSubjectDigest: derive first, compare the
// client's claim second, never prefer it). This is that same pattern for runId: derive it here, and
// if the caller also supplied one, it must match exactly or the request is refused — never silently
// preferred either way.
export function resolveVerifiedRunId({ source = 'github', repo, id, requestedRunId = null } = {}) {
  const runId = unitRunId(unitIdentity({ source, repo, id }))
  if (requestedRunId !== null && requestedRunId !== undefined && requestedRunId !== runId) {
    return { ok: false, runId: null, errors: ["runId does not match the unit's derived run"] }
  }
  return { ok: true, runId, errors: [] }
}
