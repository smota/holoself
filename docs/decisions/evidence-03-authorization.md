# ADR E03: Explicit evidence retrieval and revocation

Status: proposed D00 contract, pending independent review and human acceptance. Issue: #9; date: 2026-09-28.

## Decision

Default context/search behavior stays unchanged. Evidence selection is a new explicit opt-in input, never implied by a lens, directory name, stored source or coaching session. Existing link authority remains necessary for linked clients; an owner source grant is an additional narrowing condition. Link schemas and current operations do not change in D00.

The effective policy is the intersection of source policy, every referenced block/derivative policy, current project link, active identity, allowed lenses, task scope, lifecycle and bounded budget. Unknown/malformed policy denies access. Source policy includes a monotonic revision, explicit project UUID grants, existing lens IDs, disclosure and sensitivity. Empty project grants mean owner-only. A matching lens is relevance, not a project grant. Owner access still requires explicit evidence selection and safe source resolution. Publication and external sharing always require separate review.

Authorize before reading body or returning metadata. A denied source returns the same generic not-available result as an unknown ID: no label, path, author, dates, counts, snippets, coverage or existence hints. Lists filter denied items before totals, ranking and pagination. Diagnostics with identifying details are owner-local, never client errors. Derived images, snippets, summaries, logs, indexes and caches inherit at least all input restrictions. A multi-source interpretation requires access to every input; do not return a partially redacted summary whose wording can disclose the missing input.

Handles bind project identity, self/evidence-root identity, source revision, extraction revision, policy revision, lens and expiry. Revalidate current policy and source status on every dereference. Revocation invalidates handle/cache eligibility before cleanup; physical cache deletion is not the authority check. Cache keys include these bindings and current link/policy digests. A withdrawal or unavailable historical original cannot resolve to newer bytes. Previously delivered bytes cannot be recalled; report that boundary honestly.

Retrieval proceeds map → block → bounded neighboring context. Tables carry required headers; answers carry questions; speech carries attribution. If required context is inaccessible, missing or exceeds budget, return a structured incomplete result with no denied metadata. Do not silently remove context and present the remaining excerpt as sufficient. Source text, document links and instructions are untrusted data. Rendering cannot execute scripts, macros, embedded objects or network relationships.

## Consequences and verification

CLI, MCP and Workbench call the same future use cases with input adapters binding identity; no parallel authorization engines. MCP cannot select filesystem roots, grant access, approve knowledge or confirm commitments. D06/D08 need adversarial body-and-metadata tests and actual read counters; D09 needs safe file opening and accessibility evidence. D00 [cases R03–R04/R09](../specifications/evidence-contract-v1.md) specify the boundaries without adding interfaces.
