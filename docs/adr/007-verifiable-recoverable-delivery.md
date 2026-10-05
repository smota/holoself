# ADR 007 — Verifiable and recoverable delivery

**Status:** Implemented proposal; high-assurance review and release acceptance pending

**Date:** 2026-09-03

## Context

The demo exposed a gap between an agent claiming success, a tool observing the required behavior and an accountable role accepting the exact candidate. Interrupted delivery also depended on conversational context, while deployment identity and runtime freshness were separate operational concerns.

## Decision

Add typed candidate/observation/resolution records and a v2 acceptance policy. Preserve the role taxonomy and existing semantic handover protocol. A shared run service resolves current evidence and binds bilateral acceptance to the run before appending a transition. Local hashes prove content consistency, not actor identity or a trustworthy host.

Keep the pure reducer in `lib/core`, use cases in `lib/application`, and I/O in providers, verification and sources. CLI and Cockpit share projections. GitHub source coordination uses a state-only ref with non-force updates; comments are human-facing projections, never an alternative acceptance authority. Durable intent precedes external submission, and uncertain outcomes require reconciliation.

Recovery requires source/workspace preconditions, verified operation outcomes and prior-writer termination. A new generation fences old Agentflow mutations, while provider controls remain responsible for actual process isolation. Unknown liveness blocks transfer.

Extend ADR 006 with project-contained transaction storage and an explicit receipt durability barrier. The API requires a durable receipt destination. Apply and rollback journals support restart after interruption; authored drift remains protected. No retired installer aliases or lock migrations are introduced.

Separate executable inspection from effect-declared probes. Add journey coverage, lifecycle observations and budget fidelity without adding mandatory SDLC phases, a scheduler or a provider dependency to the portable kernel.

## Consequences

The system blocks more incomplete evidence, at the cost of explicit check/contract configuration and bounded source storage. GitHub contents permission and repository-rule inspection become prerequisites for durable runs. Cooperative local execution cannot certify hostile-host isolation. Preview success is not a released-package, live-provider or public-deployment certification.

Human policy, machine policy, schemas, packaging and tests must evolve together. Existing role records remain historical evidence; only a freshly resolved v2 run gate permits new governed transitions. See [release acceptance](../delivery-release-acceptance.md) for unresolved release gates.
