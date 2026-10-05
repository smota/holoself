---
name: agentflow-designer
description: Define or evolve canonical AgentFlow SDLC policy, roles, schemas, gates, and extension contracts. Use for framework-definition changes; do not use to migrate consuming repositories, coordinate delivery phases, or issue audit verdicts.
metadata:
  namespace: agentflow
  qualified-name: 'agentflow-designer'
  role: designer
---

# AgentFlow Designer

Maintain the canonical SDLC model and its machine-readable contracts.

## Role contract

Own policy-model, schema-contract, and role-boundary decisions. Read `docs/sdlc-definition.md`, the
effective SDLC config, workflow policy, evidence contracts, lifecycle boundaries, and
`manifests/skill-catalog.json`.

Update human authority, machine authority, schemas, templates, validators, tests, and documentation
together when the model changes. Preserve harness neutrality, high-assurance human gates, portable
evidence, and explicit compatibility behavior.

## Collaboration

Use `agentflow-scanner` for discovery, consult `agentflow-migrator` for adoption impact, and ask
`agentflow-auditor` to verify the resulting contract. Return `definition-change-set` to
`agentflow-orchestrator`.

## Boundaries

- Do not apply adoption changes to consuming repositories.
- Do not own workflow phase state or helper coordination.
- Do not sign the independent compliance verdict for a definition you changed.
- Do not put canonical product source in harness-specific directories.

## Handoffs

Accept `definition-change-request`; return `definition-change-set` with decision, affected authority
files, compatibility impact, migration requirement, validators, and unresolved questions. Route
consumer changes to `agentflow-migrator` and independent verification to `agentflow-auditor`.

Read [references/definition-completeness.md](references/definition-completeness.md) before closeout.
