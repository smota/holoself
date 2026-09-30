# Coaching delivery plan

Date: 2026-09-30. Owner-authorized course correction; implementation in progress. Epic [#8](https://github.com/smota/holoself/issues/8). This plan supersedes the evidence-platform-first sequence, native providers, custom extraction and mandatory per-slice council gates. Earlier D00/D01 receipts remain historical. D02 was never accepted; removing its candidate is not resolution of bug #22.

## Outcome and acceptance

Deliver question -> session/reflection -> action -> reported outcome -> resume. This must work without files, a parser, a model or the native evidence subsystem. Existing coaching methods are optional guidance; the user's agent conducts the conversation while Holoself preserves reviewable continuity.

- CLI opens a question, records notes/session, proposes or explicitly confirms an action, records a reported outcome and resumes complete history.
- Reports, hypotheses, intentions, confirmed commitments and verified outcomes remain distinct. Nothing enters the canonical profile automatically.
- Working state is isolated from default context discovery. Existing profile/context/proposal behavior remains compatible.
- Optional material consists of externally supplied text, source label, producer, date, import status and limitations. Keep full supplied content and available structure; never invent locators or certify fidelity.
- Imported, partial and failed input are explicit. Failure preserves existing usable state and suggests supplying text or using an external reader. Coaching still works.
- No implicit converter installation, native worker runtime, external upload, paid call or automatic retries. Document reading belongs to the user's existing tool; Holoself does not build a converter platform.
- Synthetic tests prove the no-file cycle, retained history, authority boundaries and optional material failure. User data never becomes a product/test dependency.

## Revised delivery

| Phase | Issue | Disposition |
|---|---|---|
| D00 | #9 | Historical contract work; retain useful origin/authority principles, supersede full extraction ontology for MVP |
| D01 | #10 | Completed research, no production implementation obligation |
| D02 | #11 | Retire native evidence experiment; recoverable archive before removal; no coaching dependency |
| D03 | #12 | Supplied-text/material intake after usable coaching, no own file parser |
| D04 | #13 | Retire built-in PDF extraction |
| D05 | #14 | Fold limitations/correction into D03; no fidelity audit product |
| D06 | #15 | Fold explicit material selection into D03; defer search/index/RAG |
| D07 | #16 | Optional learning handoff to existing proposals after D10; no new approval engine |
| D08 | #17 | Defer MCP adapter until CLI validated |
| D09 | #18 | Defer Workbench until CLI validated |
| D10 | #19 | First usable question/session/action/review/resume CLI; independent of D02-D09 |
| D11 | #20 | Actual usage instructions and optional methods; interface parity deferred |
| D12 | #21 | Validate/package/document this scope, no native converter qualification |

Order: cleanup -> D10 -> optional D03 -> D11 -> D12. D07 optional follow-up; D08/D09 deferred. Do not silently restore the old dependencies. Bug #22 remains historical unresolved work, outside this delivery's critical path.

## Cleanup and compatibility

Preserve the full uncommitted candidate outside the repository before removing experimental runtime, CLI routes, parser/native dependencies and implementation-specific tests. Retain reports, authored synthetic corpus and historical schemas/receipts with a supersession notice. Preserve personal roots and existing legacy evidence configuration; no implicit migration or deletion. Document legacy bindings as experimental rather than promising continued native functionality.

Use a small versioned coaching working-state representation, existing storage conventions, root containment and serialized updates. New data must not be discovered as canonical profile knowledge. Keep useful integrity rules without requiring the old extraction block ontology. Never import a test oracle as runtime validation.

## Implementation boundaries

Coaching owns local continuity. Optional intake stores supplied content and provenance; the external tool owns format processing. CLI composes these use cases. Session learning adoption uses existing human proposal approval. No new web/MCP/converter/RAG framework is part of the first slice.

## Checks, limits and rollback

One gpt-6-sol/medium writer, maximum30-minute dispatch, no nested agents. Token targets are not measurable billing caps. Focused end-to-end, history, authority and failure tests plus regression/package checks. One bounded read-only Claude CLI claude-sonnet-5/medium review of the coherent candidate, at most one correction/confirmation; no repetitive per-module reviews. Runtime/model choices retain prior authorization, not a price comparison.

Stop for unexpected ownership, data-loss risk or unavailable authority boundaries; preserve actual partial state at time limit. No automatic extension. Rollback uses the archived candidate; preserve new user working records. No commit, push, release, private migration or profile approval is implied. See [orchestration](external-sources-and-coaching-orchestration.md).
