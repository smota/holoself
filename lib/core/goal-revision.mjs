import { recordDigest } from './record-digest.mjs'

// D2 (W8c) — the ONE revision recipe. A revision is a CONTENT DIGEST: it changes on every edit
// (title, body, or updatedAt) and gates/drift detection bind to it, unlike identity
// (unit-identity.mjs), which stays stable across edits. Before this fix the recipe was defined
// twice — lib/cockpit-goal-model.mjs and scripts/run-delivery.mjs each built the digest inline —
// and the test meant to prove they agreed typed the recipe out a THIRD time instead of calling
// either, so drift between the two would never have been caught. Both call sites now call this
// function; the test now calls it too (see w8c-identity-revision.test.mjs / the anti-divergence
// test in cockpit-goal-model.test.mjs).
//
// The field set is fixed by explicit product decision — do not add, remove, or rename fields here.
// Whether a comment or label change should also invalidate an approval is an open product question
// for the author, not something this workstream decides (see the W8c spec).
export function goalRevision({ repo, number, title, body, updatedAt }) {
  return recordDigest({ repo, number, title, body, updatedAt })
}
