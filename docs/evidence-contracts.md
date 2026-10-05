# Portable evidence contracts

AgentFlow uses versioned JSON contracts as the machine authority for handoffs. Markdown role passes
are human-readable projections; creating a file never advances a phase by itself.

AgentFlow reuses this vocabulary across provider execution and source integrations.
`ExecutionReceipt` references inputs, outputs, and validation through existing `ArtifactRef`
objects. It also records request/plan digests, actual runtime identity, requested/effective/enforced/
observed/declared boundaries, revision and workspace fingerprint, writer lease, timing and
cancellation, artifact/change/output digests, execution-intent source, cleanup, disclosure authorization,
and redaction. A digest is not described as a signature without a managed signing key.
The provider descriptor supplies actual platform identity. When revision, workspace fingerprint,
effective/enforced boundary, or observed boundary was not instrumented, the receipt records `null`;
requested and declared boundaries remain canonical values. Unknown evidence is never replaced by a
provider ID or copied policy intent.
`ReviewAttestation` binds an independent decision to the exact SHA-256 candidate digest; a changed
candidate makes the review stale.

```bash
node scripts/review-digest.mjs --json
agentflow-sdlc sdlc validate-evidence \
  --type review-attestation \
  --path /path/to/attestation.json \
  --expected-digest <sha256> \
  --json
```

Receipts and attestations add provenance; they do not duplicate role-pass, transition, lifecycle, or
PR evidence.

Role transitions also use `AcceptanceContract`, `DeliveryReceipt`, `AcceptanceDecision`, optional
`ReworkRequest`, and council records. These bind the sender's acceptance criteria to the exact
handover and candidate digest. Deterministic verification runs before semantic acceptance.

## Canonical vocabulary

The workflow graph and profiles come from `sdlc.config.json`. Its canonical roles are `product-manager`,
`analyst`, `architect`, `implementation-planner`, `developer`, `tester`, `reviewer`, `technical-writer`, and
`pr-readiness`. Outputs use canonical slugs. Profiles are `bounded`, `standard`,
`high-assurance`, and `exploratory`.

The role product uses the qualified identities in `manifests/role-catalog.json`, such as
`agentflow:developer` and `agentflow:reviewer`. `RoleHandoff` evidence uses qualified identities;
transition envelopes and role passes use the matching current short slugs.

## ArtifactRef and transition envelope

An `ArtifactRef` identifies evidence without copying the source into AgentFlow. It records artifact
kind, source system, URI, authority, relationship, and—when available—revision or digest. Only one
authoritative reference may exist for the same kind and scope. Referencing an external source never
transfers its ownership to AgentFlow.

A version-1 transition envelope records subject, canonical current and next roles, decision,
next-role contract, timestamp, input/output/validation references, open questions, and actual
platform/executor/transport/delegation provenance. The current-role decision and configured graph
remain authoritative. Existing role-pass v1 Markdown remains readable; new portable outputs add
this envelope.

```text
agentflow-sdlc sdlc validate-evidence --type artifact-ref --path artifact.json
agentflow-sdlc sdlc validate-evidence --type transition-envelope --path transition.json
agentflow-sdlc sdlc validate-evidence --type role-handoff --path role-handoff.json
agentflow-sdlc collaboration verify --handoff role-handoff.json --delivery delivery-receipt.json --json
```

## Three requirement namespaces

- Execution intent: requested portable behavior such as planning or orchestration.
- Tool permission: allowed operation such as read, shell, edit, network, external write, or deploy.
- Control requirement: independently enforced or evidenced boundary such as single-writer,
  review independence, branch protection, or human approval.

Extension manifests use `requiredExecutionIntents`, `requiredToolPermissions`, and
`controlRequirements`. Prose
alone cannot satisfy a control.
