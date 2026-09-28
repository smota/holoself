# Independent review of the epic orchestration plan

Date: 2026-09-28. Scope: [orchestration plan](../specifications/external-sources-and-coaching-orchestration.md) for [epic #8](https://github.com/smota/holoself/issues/8), not implementation acceptance.

## Candidate and provenance

- Authoring harness: Codex. Independent reviewer: Claude Code CLI `2.1.263`, actual substantive model `claude-opus-5`, requested effort `high`.
- Independence: different harness and model vendor, fresh sessions, supplied documents only, all tools disabled. No repository or personal-context retrieval was requested from Claude.
- First candidate orchestration SHA-256: `df3d720e5469c808c9a5a7dcdbf504558063319c497c831d5bd9301b4649967c`.
- Reviewed development-plan SHA-256: `7c3529d42d482933108333405e23c5ab49e43aa6c85b1b3a1543f64ffe3aaca7`.
- Final orchestration candidate SHA-256: `ff73e3b4bbd984d5f1f13ccfc6255baa667800a4eaab1241573ab0a83a54d4db`.
- Round 1 session: `3ac5ab81-7817-42ca-ba10-a26eb4b45d70`, exit 0, 96.1 seconds, verdict `changes-required`.
- Round 2 session: `59934b8c-e0f9-4145-ac03-e0ab263fb774`, exit 0, 40.0 seconds, verdict `approved`, no remaining blockers.
- In both rounds, HEAD, tracked diff hash, Git status and the candidate document hashes were unchanged during the call. Separate scratch preparation did not enter the review scope.
- Briefs and raw stdout/stderr/receipts were saved outside the repository in OS temporary run directories named `holoself-orchestration-review-jp36bssb` and `holoself-orchestration-confirm-gehehwmi`. They are ephemeral diagnostics, not public package content. This report preserves durable conclusions and identity.

## Findings and dispositions

| ID | Finding | Disposition and confirmation |
|---|---|---|
| F1 | Reviewer claimed several Claude flags were unsupported | Refuted using installed `--help` and successful calls using those flags. Reviewer withdrew the claim in round 2 |
| F2 | G1/G3 human approval not explicit in the gate table | Added candidate-bound human approval; confirmed resolved |
| F3 | Coordinator could refute an independent blocker without proper resolution | Separate coordinator/writer sessions; reviewer confirms rebuttal or human resolves disagreement; confirmed resolved |
| F4 | Quota, dollar-cap applicability and review size needed clearer bounds | Pro quota distinguished from API billing; review envelope and pause protocol added; confirmed resolved |
| F5 | PowerShell native stdin could corrupt Unicode | Require PowerShell 7 and UTF-8; actual review runner used explicit UTF-8 subprocess I/O; confirmed resolved |
| F6 | Codex invocation lacked explicit checkout | Added `--cd` with resolved assigned checkout; confirmed resolved |
| F7 | Process cap was ambiguous under one-delegate fallback | Current cap explicitly coordinator plus one delegate; parallelism conditional on new verified contract; confirmed resolved |
| F8 | Visual/keyboard checks lacked a named executor | D03/D04 SH tester owns visual checks; D09 S tester owns browser/keyboard checks; missing tools leave criteria unverified; confirmed resolved |
| F9 | Reviewer confused Max/Ultra reasoning with subscription terminology | Refuted with active model catalog and CLI help; reviewer withdrew the claim. Stale authentication observations were updated |
| F10 | D02 could use the cheaper Sonnet review lane | Adopted CSH for D02; CO D05 retains cross-slice revision-integrity review; confirmed |

## Validation and limits

Claude confirmed coverage of D00–D12, all 21 dependency edges, valid sequential order and the D08/D09/D10 ready set after D07. The document also passed all seven repository documentation tests and whitespace checks at the reviewed candidate.

The inherited GitHub profiles clarify the reviewer's non-blocking human-gate note: D00 and D02–D11 are proposed high-assurance; D01 exploratory; D12 standard, with final human release authority retained. None of D02–D05 or D10–D11 is exempt from its high-assurance gate. Reconfirm profiles before execution.

Sonnet availability smoke: session `b7519613-1527-4bd9-ba60-4565638b53e4`, requested `sonnet`/`medium`, actual `claude-sonnet-5`, exit 0, response `READY`. This establishes availability at call time, not review quality. Runtime metadata also records auxiliary Haiku calls; they were not the substantive reviewer.

Plan review calls used no tools. The Read/Glob/Grep review variant, current provider quotas and manual versus automated AgentFlow advancement still require execution-time verification. No implementation, model-performance benchmark, privacy assessment of product code, or human approval of future delivery is implied by this report.
