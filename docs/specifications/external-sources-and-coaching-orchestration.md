# Orchestration plan for external evidence and coaching

Status: execution active, 2026-09-28. D00 delivery `54a29a4459c332b26b997dbd08823f96fcd0a923` has independent review and explicit human acceptance. D01 exploratory testing and read-only Claude review are complete; the corrected candidate passed, with no blocking review findings. See the [D01 validation receipt](../reports/evidence-extraction-d01-validation.md) and [spike report](../reports/evidence-extraction-d01-spike.md). D02 is next and remains a high-assurance candidate gate. Production qualification, including native Linux/macOS provider qualification and suspended Windows startup, remains open. The planning/preflight descriptions below are historical; the D00 contract evidence is in the [D00 validation and acceptance record](../reports/evidence-contract-d00-validation.md).

Scope: [epic #8](https://github.com/smota/holoself/issues/8), all thirteen issues D00–D12. Product scope, acceptance criteria, hypotheses and rollback remain in the [development plan](external-sources-and-coaching-plan.md). This document assigns execution and review responsibilities; it does not change those requirements.

## Outcome and execution readiness

Deliver the full epic with bounded Codex tasks, deterministic checks, independent Claude CLI reviews and the human gates required by AgentFlow. Use inexpensive models for explicit, verifiable work; reserve stronger models for architecture, trust boundaries and unresolved integration problems.

Verified during planning:

- All fourteen GitHub issues are open. No issue is marked implemented or independently reviewed.
- Codex CLI `0.154.0` is installed. The session model catalog and local cache list `gpt-6-luna`, `gpt-6-sol` and `gpt-6-astra` with the efforts used below. This is discovery evidence, not successful inference or current quota evidence.
- Claude Code CLI `2.1.263` supports explicit model/effort selection, print mode, JSON output, restricted tools and session controls. After user login, `claude auth status` reports authenticated first-party claude.ai Pro access. Successful CLI calls resolved `opus` to `claude-opus-5` and `sonnet` to `claude-sonnet-5`; use these explicit IDs below. Entitlement/quota can change and must be rechecked at dispatch.
- AgentFlow framework checkout `5438715` is available locally. `collaboration classify --profile high-assurance --risk high --domains api,data,ui --json` returns `human-gated`.
- The matching `collaboration plan` returns `ok: true` but a degraded `manual` provider binding, with one delegate and depth one. It does not establish automated project adoption or Codex/Claude provider readiness.

Before execution, verify Claude authentication and model access, Codex quota/model access, issue bodies, current repository instructions, and the selected branch. Resolve any AgentFlow adoption/provider work separately with its supported preview; no setup files are overwritten by this plan. The cost-conscious baseline is a sequential, coordinator-managed workflow with one delegate at a time. Automated fanout is optional and requires a verified binding, not an assumed feature.

## Model policy

| Code | Model and effort | Assigned work |
|---|---|---|
| L | Codex `gpt-6-luna`, `high` | Bounded fixture generators after schemas are fixed, repetitive test cases, documentation edits, evidence indexing and narrow changes with explicit expected output |
| S | Codex `gpt-6-sol`, `medium` | Default implementation, focused test design, delivery planning, orchestration and integration |
| SH | Codex `gpt-6-sol`, `high` | Extraction ambiguity, adversarial test design, concurrency and complex integration |
| A | Codex `gpt-6-astra`, `high` | Architecture and authority decisions, disputed findings, architectural escalation; not routine polling or documentation |
| CS | Claude CLI `--model claude-sonnet-5 --effort medium` | Independent review of bounded implementation, coverage and usability |
| CSH | Claude CLI `--model claude-sonnet-5 --effort high` | Independent review of extraction fidelity and complex interaction behavior |
| CO | Claude CLI `--model claude-opus-5 --effort high` | Independent review of authority, privacy, revision integrity, capability boundaries and final integrated release candidate |

These are workload assignments, not measured price/performance results. Current [OpenAI model guidance](https://learn.chatgpt.com/docs/models) positions Luna for focused work, Sol for complex coding and Astra for the hardest workflows. Start with Luna High and Sol Medium; additional effort in this plan is justified by the named risk.

Claude IDs above were resolved from successful CLI runtime metadata, not a model's prose answer. Pin them for the milestone; confirm actual identity and effort support at each dispatch. [Claude model configuration](https://code.claude.com/docs/en/model-config) documents provider-dependent aliases and model-dependent effort. No `opusplan`, automatic fallback, or default-model invocation: a reviewer must not switch model family midway without a recorded new decision. Runtime receipts also report auxiliary Haiku usage; preserve that telemetry without confusing it with the substantive review model.

Do not add Haiku as an extra review tier: deterministic checks and Luna already cover the cheap work, and these review surfaces warrant Sonnet or Opus. Do not use Max/Ultra by default. No model availability, subscription cost or total dollar estimate is asserted until measured on this account.

## Accountable roles and independence

- **Coordinator / product-manager / analyst:** S in a dedicated owner session; freeze issue scope, maintain the dependency graph, accept role handoffs and consolidate status. The coordinator does not author production code.
- **Architect:** A for the shared D00 architecture and material contract changes. Reuse the accepted design in later issues; do not commission a full new architecture review for every slice.
- **Implementation planner and developer:** the writer in the matrix below. One writer lease per checkout; fixes return to this writer.
- **Tester:** fresh Codex session assigned in the matrix. Derive adversarial cases from acceptance criteria before reading implementation details where feasible. Same-vendor testing is additional validation, not the independent cross-vendor review.
- **Reviewer:** fresh Claude CLI session on the frozen candidate. Reviewer has no write tools, does not fix findings and does not accept its own changes.
- **Technical writer:** L for bounded documentation after behavior and command contracts are accepted. If docs change behavior/contracts, send back to S/A.
- **PR readiness:** S verifies required checks and receipts, open findings, review independence and human approval. Shell/CI runs checks without an LLM. No new model call merely to wait on CI.
- **Human authority:** accepts high-assurance deliveries against the exact candidate and criteria. Planning authorization is not advance approval of unseen implementation.

For human-gated transitions, use two bounded council perspectives: the fresh Codex tester covers behavior/fidelity/compatibility; the Claude reviewer covers independent adversarial risk. Each writes distinct advice tied to the same candidate. The sender/coordinator synthesizes and dispositions objections; no majority vote or self-approval. Required roles are covered without requiring a separate expensive session for every role name.

## Full epic assignment matrix

Each issue inherits its development-plan checks and turn-review limits. Writer effort applies to substantive work; L assistance is optional and limited to the named task. An assistant must not concurrently edit the writer's checkout.

| Item | Issue | Writer | Separate tester | Claude reviewer | Low-cost scope | Depends on |
|---|---|---|---|---|---|---|
| D00 | #9 | A | SH | CO | L: format schemas/fixtures only after contract decisions | — |
| D01 | #10 | SH | S | CSH | L: collect benchmark results into the agreed table | D00 |
| D02 | #11 | S | SH | CSH | L: repetitive CLI examples and malformed-path cases | D00, D01 |
| D03 | #12 | S | SH | CSH | L: Markdown adapter and fixtures within frozen block schema | D02 |
| D04 | #13 | SH | SH | CSH | L: expected page inventories; SH owns layout and resource limits | D01, D03 |
| D05 | #14 | S | SH | CO | L: lifecycle cases; S owns revision/concurrency rules | D03, D04 |
| D06 | #15 | SH | SH | CO | L: deterministic budget/denial test tables | D05 |
| D07 | #16 | SH | SH | CO | L: legacy proposal fixtures; SH owns approval/replay behavior | D06 |
| D08 | #17 | S | SH | CO | L: schema/response parity cases | D06, D07 |
| D09 | #18 | S | S | CSH | L: labels, keyboard states and documentation; S owns file access | D05, D07 |
| D10 | #19 | S | S | CS | L: record serialization fixtures and command examples | D07 |
| D11 | #20 | S | SH | CSH | L: surface parity cases and agent documentation | D08, D09, D10 |
| D12 | #21 | S | SH | CO | L: release notes, requirement/evidence mapping and installation docs | D08, D09, D11 |

D12 writer owns integration fixes; L does not own final release qualification. Claude remains the reviewer even when Codex authors tests/docs. If Claude must author a fix, invalidate its independence for that scope and obtain a new, uninvolved Codex reviewer; record the exception rather than presenting it as the normal lane.

The SH tester for D03/D04 owns rendered-fixture inspection using image/PDF tools and records checked pages and mismatches. The S tester for D09 owns keyboard/accessibility checks in a tool-capable browser session, with human fallback if unavailable. Missing visual/browser capability leaves those criteria unverified; text extraction and unit tests cannot substitute for them.

## Schedule and workspace ownership

### Default schedule

`D00 → D01 → D02 → D03 → D04 → D05 → D06 → D07 → D08 → D09 → D10 → D11 → D12`.

This respects all 21 existing dependencies. No extra product dependency is introduced by choosing sequential execution. Each item completes design/check/review/acceptance before its dependent implementation begins. A reviewed, unmerged parent may be used only with a recorded exact base; downstream acceptance is provisional until integration checks pass.

### Optional parallel work after D07

D08, D09 and D10 are dependency-ready after D07, but they share adapters and contracts. Default to sequential work for cost and reliability. If independent module ownership and provider bindings are established, run at most two writers in different managed worktrees from the same accepted D07 base. Reserve a single integration owner for `src/ecosystem.mjs`, CLI composition, shared schemas, package metadata and shared documentation. Rebase/integrate serially and repeat affected checks before D11.

Current hard bound: coordinator plus one delegate, depth one, matching the manual fallback. Only after verified provider binding and an explicit updated execution contract may this rise to coordinator plus two delegates. Do not silently relax the current limit for parallelism.

Inspect attached worktrees and Git state before creating/reusing a checkout. Account for existing local changes, including this plan and unrelated deleted/untracked files. Use a `codex/` workstream branch after approval, then issue-sized commits/PRs as appropriate. Do not create a new user-visible chat for each helper. Archive only checkouts whose work has been preserved and is no longer in use.

## Per-issue execution loop

1. **Freeze:** fetch current issue, dependencies and relevant ADRs. Record base/head or working-tree diff hash, scope, acceptance contract, writer lease and model selection. Test/role output locations must be outside published package paths.
2. **Design:** reuse D00 unless the slice changes the contract. A handles a bounded amendment; Claude review covers the changed authority boundary before implementation. For D01 use a spike with no product claims beyond measurements.
3. **Implement:** assigned Codex writer receives only needed files and constraints. Routine fixture/document work can go to L sequentially, with explicit hand-back of the writer lease.
4. **Verify:** run slice tests and required negative cases. Fresh tester examines criterion coverage and records deterministic/semantic results separately. Missing evidence is not a pass.
5. **Review:** Claude CLI reads the frozen candidate, acceptance contract, relevant source files, results and unresolved questions. Review the full slice, not only an author's summary. No writes; no access to personal data roots.
6. **Resolve:** writer handles accepted findings. The coordinator is a different session from that issue's writer, even when both use S. It records accepted/refuted/deferred dispositions with evidence. A disputed blocking Claude finding requires reviewer confirmation of the rebuttal; if disagreement remains on a human-gated delivery, require human disposition against the evidence. Required acceptance criteria and blocking objections cannot be deferred to obtain a pass. Send changed hunks and prior findings for confirmation, with access to surrounding code.
7. **Accept:** validate AgentFlow records and source-bound advancement before progression where configured; otherwise record manual evidence and its limitation. Human-gated issues require candidate-bound human approval. Update one workflow-status projection per issue on material change.
8. **Integrate:** run affected checks on the integrated commit. Any semantic change after review invalidates affected review/acceptance; final gate must refer to the integrated candidate.

The coordinator may continue independent preparation during a blocked review, but cannot close that issue or start work that relies on unaccepted contracts. Required Claude review is never replaced with self-review because authentication, quota or service availability failed.

## Milestone gates

| Gate | Candidate and required evidence | Model work |
|---|---|---|
| G0, after D00–D01 | Contracts, corpus, dependency/license decisions and measured extraction limits | A resolves design; CO D00 and CSH D01 receipts; human confirms high-assurance contract |
| G1, after D02–D05 | Original hashes preserved, coverage accounted for, revisions and fidelity invalidation correct | Reuse per-issue reviews; CO D05 includes cross-slice integrity delta; candidate-bound human approval for high-assurance issues |
| G2, after D06–D09 | Denial of body/metadata, bounded retrieval, approval integrity, MCP/UI parity | CO D06–D08, CSH D09; human approvals tied to integrated candidates |
| G3, after D10–D11 | Coaching cycle and authority boundaries work across interfaces | CS D10, CSH D11; SH tests cross-interface counterexamples; candidate-bound human approval for high-assurance issues |
| G4, D12 | Full regression, clean installation, portability evidence, package audit and complete acceptance matrix | CO reviews final integrated epic delta and unresolved risks; human approval before merge/release actions requiring it |

Milestone synthesis uses existing receipts, not a duplicate full review at every gate. A single human checkpoint may cover multiple ready issues only if each exact candidate and acceptance scope is listed. Do not close the epic until all children pass; release publication and private installation remain separate actions.

## Cost and escalation controls

- Default writer S, not A. Use SH where the matrix identifies uncertainty. Use A for bounded decisions and escalations, returning routine work to S after the decision.
- Give L a precise input/output contract, allowlisted files and a check. Do not route open-ended architecture, privacy policy or final acceptance to L.
- One initial attempt and one focused correction per assigned model. If the same failure recurs, stop that task and hand off with evidence: L → S/SH → A. Do not keep trying prompts indefinitely.
- CS/CSH can escalate to CO for an unresolved architectural/security dispute. CO remains mandatory on its listed issues. No automatic downgrade, hidden fallback or escalation to Max/Ultra.
- Maximum two review rounds per issue: initial review and confirmation. Remaining blockers require a revised scope/plan; the issue stays open. Do not reset the round count by changing sessions.
- Proposed wall-clock bounds: 30 minutes per writing chunk, 15 minutes per Claude review. Stop at the first applicable wall-clock, turn-review or usage bound; limits are runtime controls, not completion claims. The supervisor can extend only with a recorded reason and bounded next attempt.
- Under the verified claude.ai Pro login, control quota using call count, context and time; reported dollar usage is a list-price estimate, not an invoice. Use `--max-budget-usd` only with an API-billed execution setup verified to enforce it. No dollar budget was supplied. On quota exhaustion stop the review lane, preserve candidate/receipt, notify the user of the provider error and known reset time, and wait for a decision or restored quota. Never buy credits, change subscription or downgrade review silently.
- Default per-review envelope: up to 20 changed files, 2,000 changed non-generated lines and 30,000 tokens of supplied context. Split larger candidates by coherent contracts while preserving shared context and review coverage. D12 may review an integrated evidence map plus relevant source in bounded passes; a final synthesis must account for every changed scope, not treat sampling as full review. Extra passes require a recorded size-based exception; this does not reset the two-round correction limit.
- Use deterministic scripts for checks, inventories, hashes, link validation, status reads and waiting. Send only changed scope plus required context to reviewers; reuse immutable evidence references.

## Claude CLI runbook

The installed CLI help was checked. The following is an invocation template, not a completed call. Use PowerShell and a fresh session in the candidate checkout; do not use `--continue` or resume an author session.

```powershell
claude auth status

# Require PowerShell 7 and preserve Unicode on native stdin.
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $OutputEncoding
# Variables are filled by the execution coordinator, not global settings.
$reviewModel = 'claude-sonnet-5'
$reviewEffort = 'medium'
$reviewBrief = Join-Path $env:TEMP 'holoself-review-brief.md'
$reviewResult = Join-Path $env:TEMP 'holoself-review-result.json'
$reviewErrors = Join-Path $env:TEMP 'holoself-review-stderr.txt'

Get-Content -LiteralPath $reviewBrief -Raw |
  claude -p --model $reviewModel --effort $reviewEffort `
    --permission-mode dontAsk --permission-prompts none `
    --safe-mode --restricted --strict-mcp-config `
    --tools 'Read,Glob,Grep' --allowedTools 'Read,Glob,Grep' `
    --no-session-persistence --output-format json `
    1> $reviewResult 2> $reviewErrors
$reviewExit = $LASTEXITCODE
```

For CSH use `claude-sonnet-5` and `high`; for CO use `claude-opus-5` and `high`. `dontAsk` plus a read-only tool allowlist avoids relying on plan-mode model switching. Safe/restricted mode and strict MCP loading exclude local customizations and extra tools; confirm actual behavior in the first authenticated read-tools preflight. These flags are documented in the [Claude CLI reference](https://code.claude.com/docs/en/cli-reference) and current local help. Planning review and Sonnet availability checks successfully used the same safety flags with all tools disabled; the Read/Glob/Grep variant remains to be exercised. The planning runner used explicit UTF-8 subprocess stdin/stdout rather than relying on shell encoding.

The coordinator must enforce the wall-clock bound externally with a process timeout and capture stdout/stderr/exit status. Before/after checks cover HEAD, tracked diff and relevant untracked file hashes; `git status` alone does not detect modifications to an already dirty file. A changed candidate invalidates the review. The reviewer may inspect source but cannot run test commands with this tool set; the independent tester supplies reproducible logs, and the reviewer reports any evidence gap.

A review is valid only when exit is zero, JSON is parseable, result is nonempty, no provider error/limit is present, actual model/effort satisfies the assignment, the candidate is unchanged, and every required criterion/finding is addressed. Authentication failure is `blocked-provider`, never `approved`. Successful planning calls establish model availability at that time, not future quota or implementation acceptance.

Review brief: issue and candidate identity; requirement IDs; source allowlist; relevant code and full slice diff; independent test results; explicit no-write/no-personal-data boundary; requested findings by severity with evidence; per-criterion pass/fail/unverified; confidence, limits and model metadata receipt. Store the brief outside the repository. Never paste secrets or unrelated transcripts.

## Codex execution runbook

Use native Codex subagents with an explicit model/effort and a fresh bounded task packet when the host binding supports them. Do not inherit the entire orchestration conversation into every worker. CLI fallback is explicit:

```powershell
$taskBrief = Join-Path $env:TEMP 'holoself-task-brief.md'
$taskResult = Join-Path $env:TEMP 'holoself-task-result.md'
$assignedCheckout = (Resolve-Path '<assigned-checkout>').Path
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $OutputEncoding
Get-Content -LiteralPath $taskBrief -Raw |
  codex exec --cd $assignedCheckout --model gpt-6-sol -c 'model_reasoning_effort="medium"' `
    --sandbox workspace-write --output-last-message $taskResult -
```

Run writers only in their assigned checkout. Test/design helpers use `--sandbox read-only` when they do not need to create artifacts; a test writer receives an isolated worktree or a sequential writer lease. For L use `gpt-6-luna` with `high`; for SH use `gpt-6-sol` with `high`; for A use `gpt-6-astra` with `high`. Verify effective configuration at dispatch; do not bypass host permissions.

## Evidence and resumption

Each handoff/receipt records: issue, role, profile, candidate digest, inputs, allowed paths, expected outputs, requested and actual model, effort, runtime version/session ID, timestamps, exit status, usage when available, criteria results, findings/dispositions, writer lease and next owner. Keep raw prompts/transcripts private in run scratch; durable reports contain only necessary provenance and conclusions.

Use AgentFlow `RoleHandoff`, `AcceptanceContract`, `DeliveryReceipt`, council advice/synthesis and `AcceptanceDecision` contracts when adopted. Validate their actual schemas and source-bound advancement; this Markdown is not a fabricated receipt. Resume from the last accepted candidate, invalidate stale downstream results and retain failed-attempt evidence.

## Plan acceptance and pending prerequisites

Planning is complete when every D00–D12 item has an assigned writer, tester, Claude reviewer, dependency order, check and stop rule, and issue tracking preserves existing criteria. Documentation/link checks validate this artifact, not the future product.

Execution is pending authorization and a verified manual or automated AgentFlow execution path. Claude authentication and the substantive Sonnet/Opus model calls now pass; the read-tools review variant and future quota remain preflight checks. The user requested orchestration planning; no implementation task graph, background automation, branch or product installation has been started. The user completed provider login separately.
