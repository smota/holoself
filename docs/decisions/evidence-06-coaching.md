# ADR E06: Minimal coaching work and confirmation

Status: proposed D00 contract, pending independent review and human acceptance. Issue: #9; date: 2026-09-28.

## Decision

Persist a small ID-linked cycle: question → session → action → review. Use durable UTF-8 JSON in the private evidence root, governed by its owner and source-derived restrictions. An export can make those records readable without granting publication permission. This is explicit working state, never generic context or self profile. No automatic new lens, person ranking, clinical diagnosis, programme management or mandatory model.

A question holds the topic and open/closed state. A session belongs to a question and records separately attributed observations (`user_report`, `source_fact`, `hypothesis`, `intention`) with evidence references when claiming a source fact. Methods are optional catalog IDs, selected within the existing allowlist and task budget. A model may draft a hypothesis or proposed action; it cannot certify an observation or confirm a commitment.

An action belongs to a session and is `proposed` or `confirmed`. Confirmation requires a durable explicit human decision bound to the exact action digest and expected record revision. Changing the action text invalidates confirmation. A review links the action, recording reported execution separately from result evidence. `reported` outcome is not `verified`; verified outcome requires evidence references and an attributed human verification decision. Verification is bounded to the cited evidence and does not infer causality. A review can report no action taken or unknown outcome without fabricating success.

All edits use expected revisions and append successor records; preserve prior session, action and review history. Resumption fetches authorized records and pinned evidence with current availability/fidelity, showing question, reports, hypotheses, confirmed action, execution report and outcome distinctly. Missing evidence is visible to the authorized owner and does not become a fact. Multiple sessions and reviews can link to the same question/action without overwriting earlier reports.

A cycle validates parent identity and kind: every record resolves its question; actions resolve sessions; reviews resolve actions. Every parent and child must share question ancestry. A missing parent, wrong record kind, duplicate ID in the selected current-record set or cross-question link is invalid. The test oracle evaluates one selected revision per record ID; historical revisions remain separately retained.

Reusable learning takes the Interpretation → evidence-backed proposal route in E05, with exact human approval. Recording a session, confirming an action or verifying an outcome does not approve profile knowledge. CLI/MCP/Workbench share use cases; clients can draft candidates, while commitment confirmation is a human action. UI approval must bind the exact record and reject stale revisions.

## Consequences and verification

The [coaching schema](../../schemas/coaching-v1.schema.json) excludes a knowledge-approved field and requires explicit confirmation/verification bindings. D10/D11 implement the cycle and surface parity after D07. [Case R11](../specifications/evidence-contract-v1.md) rejects machine-confirmed commitments and unreferenced verified outcomes; these are contract examples, not implemented coaching commands.
