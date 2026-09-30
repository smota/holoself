# Coaching course correction: implementation and validation

Date: 2026-09-30. Scope: owner-authorized coaching-first replacement of the experimental evidence platform. Local candidate, not committed, pushed, released or installed into a personal root.

## Delivered

The CLI supports `coaching start`, `note`, `action`, `choose`, `review`, `material` and `resume`. Sessions preserve event history and revision checks under an exclusive write lock. A chosen action is an explicit caller attestation; a reported outcome stays unverified. Optional material stores supplied text verbatim with source/producer/status/limitations. Unsupported document import returns an actionable error. Working state is outside canonical profile discovery; no automatic knowledge adoption.

The experimental native evidence store/CLI, parser, supervisor, native bindings and their implementation-specific tests were removed from the active product. Package runtime dependencies returned to the baseline. The previous tracked patch and 24 untracked files were preserved in a separate local recovery archive before removal. Historical schemas, fixtures and reports remain research evidence. Bug #22 remains unresolved for that retired candidate; removal is not a root-cause fix or D02 acceptance.

The [plan](../specifications/external-sources-and-coaching-plan.md), [orchestration](../specifications/external-sources-and-coaching-orchestration.md), [usage guide](../guides/coaching.md) and GitHub epic #8 now reflect the reduced scope. D10 comes first; D03 is supplied-material intake. Own PDF processing, standalone fidelity auditing and advanced retrieval were retired/folded; MCP and Workbench are deferred.

## Executed verification

- Coordinator final `npm run verify`, Windows Node 26.10.0: 243 tests passed, zero failed/skipped; package audit, help and capabilities passed.
- Coordinator exact Windows Node 20.0.0 `node --test tests/coaching.test.mjs`: 3 passed, zero failed/skipped, including direct package CLI use.
- Writer earlier focused CLI/coaching: 20 passed. Earlier full run: 242 passed before the added direct-bin test. The final 243-test run above supersedes that count.
- `git diff --check` passed with existing line-ending warnings.
- No personal source data was used. No Linux/macOS execution or full Node20 regression claim is made.

## Independent source review

Claude Code CLI 2.1.263, `claude-sonnet-5`, medium effort; different vendor/harness from the Codex author. Prior user authorization covers the provider. Read-only Read/Glob/Grep tool allowlist, safe/restricted mode, no MCP configuration, 600-second timeout. Exit0, nonempty approved verdict, 83.1 seconds, candidate unchanged during review, one round. Session: `416a91ba-6523-4361-939d-01be40f36f6a`. Candidate digest: `0b62a6e7ff7fa6ddfc85afe5ed998f35e04d65f6832b59517135d5e1ba078155` (pre-final documentation notes).

The reviewer inspected the coaching module, CLI wiring, tests, guide and required context/discovery code. It did not execute tests; runtime evidence above comes from executed coordinator/writer commands. Old evidence reports and unrelated future features were out of review scope. The raw brief, result, manifest and receipt are retained outside the repository. Provider-reported list-price estimate was USD0.213876, not subscription billing or the cost of the whole task.

Findings: no blockers. Low orphan-lock recovery and informational most-recent-chosen-action review order were accepted and documented in the usage guide after review. No production code changed after the approved review. No second model review was needed for these documentation clarifications.

## Limits

This is a local owner CLI with supplied-text intake, not autonomous coaching, direct document conversion, MCP/Workbench integration or automatic learning approval. Inputs are limited to64KiB each. Interrupted writes can leave a lock requiring the documented manual recovery; no unsafe automatic stale-lock deletion. Existing experimental evidence bindings remain untouched. Direct owner-equivalent OS tampering is outside this ordinary local-storage boundary.
