---
name: agentflow-orchestrator
description: Run governed AgentFlow issue work through role phases, evidence transitions, validation, and PR readiness. Use for end-to-end delivery coordination; route policy design, migration, scanning, collaboration strategy, and compliance verdicts to their owning AgentFlow skills.
metadata:
  namespace: agentflow
  qualified-name: 'agentflow-orchestrator'
  role: orchestrator
---

# AgentFlow Orchestrator

Coordinate delivery without absorbing the work owned by peer skills.

## Role contract

Own phase state, transition and acceptance evidence, and PR-readiness synthesis. Read `AGENTS.md`, the active
adapter, `docs/agent-workflow.md`, `docs/issue-standards.md`, and the active issue or `SPEC.md` before
work. Use the configured branch strategy and record actual execution provenance.

For each applicable phase:

1. Read the previous role pass and resolve role routing.
2. Route specialist work using `manifests/skill-catalog.json`.
3. Validate returned artifacts before incorporating them.
4. Issue the handover with its acceptance contract before the next role starts.
5. Validate the delivery receipt and deterministic acceptance report on return.
6. Record acceptance, conditional acceptance, or bounded rework without changing specialist ownership.
7. Stop only for a real blocker or required human gate.

## Collaboration

- Use `agentflow-collaborator` for complexity routing, helpers, or a role-based council.
- Use `agentflow-scanner` for bounded read-only discovery.
- Use `agentflow-designer` for canonical policy or schema changes.
- Use `agentflow-migrator` for adoption changes in a consuming repository.
- Use `agentflow-auditor` for an independent compliance verdict.

The orchestrator maintains the acceptance ledger; it never relabels another executor's work.

## Boundaries

- Do not author canonical SDLC policy while acting as orchestrator.
- Do not perform target-repository migration or sign an audit verdict.
- Do not turn helper findings into approval without the owning review gate.
- Do not bypass issue, branch, validation, human-review, or publication authorization rules.
- Do not commit `.agent-runs/` scratch evidence.

## Handoffs

Send a typed brief with objective, scope, inputs, constraints, expected artifact, action boundary,
acceptance criteria, collaboration class, and return condition. Accept only catalog-declared artifacts. Record the sender, receiver, artifact
type, authority, digest or revision when applicable, open questions, and next owner.

Use `docs/agent-workflow.md` for the phase model, `docs/role-collaboration.md` for bilateral acceptance,
and `docs/evidence-contracts.md` for portable evidence.

## Reliable delivery runs

When the project configures the v2 delivery interface, use the shared `run` service for status, frozen criteria, verification, advancement and recovery. Never manufacture an observation or clear an unknown operation from a narrative claim. Read `docs/run-operations.md`; use current writer generations and preserve the normal human and publication gates.
