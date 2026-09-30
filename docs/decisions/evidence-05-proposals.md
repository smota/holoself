# ADR E05: Claim provenance and existing human approval

Status: proposed D00 contract, pending independent review and human acceptance. Issue: #9; date: 2026-09-28.

## Decision

Keep legacy single-change and v2 grouped proposals, their states and their schema unchanged. Current validation rejects unknown fields. A versioned evidence attachment is the future extension boundary; it binds proposal UUID and exact proposal SHA-256 to per-change evidence references, interpretation ID and explicit limitations. It is private operational state under the evidence root. It does not make a new approval mechanism.

An Interpretation names its author/agent, claims, uncertainty and counterpoints, with immutable source references for each claim. Its states are `candidate` and `proposed`; an attachment does not set approved status. A proposed interpretation references the existing proposal ID. Each proposed change must map to its exact claim and evidence; missing, duplicate or cross-proposal bindings fail. A v1 single change uses `claim` as its change ID. Source-reference revisions and block hashes are immutable, including source authorship and temporal uncertainty.

D07 must implement an integrated preview/approval reader before evidence-backed proposals can be emitted. Do not place apparently ordinary pending proposals into the legacy queue while only a sidecar knows mandatory validation. Otherwise a legacy approver could bypass freshness checks. D07 must define a version/capability gate that old readers reject, plus export-before-downgrade; ordinary historical v1/v2 proposals continue working without attachments. No new proposal format is active in D00.

Preview revalidates project authority, current policy, source availability, revision, extraction, referenced block hashes, applicable human fidelity decisions and canonical expected revision. Referenced blocks must be checked and not superseded; unrelated gaps remain visible and do not automatically bar a bounded, supported claim. Missing context, stale extraction or withdrawn source blocks approval. A newer source revision requires an explicit rebase and new preview even when old bytes remain available. Partial evidence requires explicit scope and limitation disclosure, never invented completeness.

The preview digest binds exact canonical before/after changes, proposal bytes, attachment digest, interpretation digest, references, fidelity decisions, policy/link revisions and limitations. Immediately before applying, revalidate all dependencies and compare the expected digest/revision. Any drift refuses application; a fresh human decision is required. The existing human owner approves/rejects/defers; MCP can only create candidates. An atomic receipt records the decision and exact bindings. Replay returns the previous receipt without a second append; rejected/deferred history is retained. This approval governs adoption, not objective truth.

## Consequences and verification

D00 defines the [attachment schema](../../schemas/evidence-v1.schema.json) and counterexamples; it deliberately cannot create a working bypass via legacy proposals. D07 tests current v1/v2 parity, stale/revoked/partial references, preview drift, replay and canonical concurrency. Approved text is reverted only through existing reviewed history, never by deleting provenance when a source is withdrawn.
