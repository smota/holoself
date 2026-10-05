# Intelligent collaboration

AgentFlow SDLC 1.0 uses intelligent collaboration to help teams use AI more confidently in software delivery. The goal is not more agents. The goal is better SDLC decisions with less coordination burden and compact, auditable evidence.

## Core principle

Increase intelligence per decision, not agents per task.

Agent tools may run temporary helper intelligence behind stable SDLC roles, but the visible workflow remains the same: issue, role phases, evidence, validation, PR manifest, and follow-up issues.

Core planning emits a versioned `CollaborationIntent`: desired mode, participant roles, risk/profile,
single-writer policy, human gate, portable execution intents, and permitted fallback. It does not choose a
provider, executable, model, transport, or worktree. A later `ProviderBinding` resolves those details
from inspected provider facets and intent support.

## Decision budget

```text
Spend AI tokens where uncertainty is high.
Spend workflow ceremony where audit risk is high.
Spend human attention only where authority is needed.
```

## Smallest sufficient collaboration

Use the least coordination that reduces meaningful risk:

- If single-agent work is enough, do not spawn helpers.
- If one advisory helper is enough, do not create a council.
- If read-only is enough, do not allocate a child worktree.
- If compact evidence is enough, do not publish raw transcripts.
- If a required intent is unavailable, fail closed. If the intent explicitly permits fallback
  and the required controls remain enforceable, record a sequential/manual degradation.

## Collaboration modes

| Mode                 | Use when                                                                         | Harness leverage                                                | Guardrail                                                         |
| -------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------- |
| `auto-minimal`       | Default mode. Select the smallest safe mode from issue metadata and uncertainty. | Resolver-selected.                                              | Explain why in one sentence.                                      |
| `single-agent`       | Low-risk, clear work.                                                            | None beyond normal workflow.                                    | Default for routine changes.                                      |
| `advisory`           | One or more focused second opinions would reduce risk.                           | Read-only helpers or provider calls.                            | Parent synthesizes; helpers do not sign gates.                    |
| `sparring`           | Adversarial review before code write (pre-code review) or contract verification. | Read-only adversary CLI or forced sparring view inner subagent. | Multi-round resolution ledger; zero open blockers to unlock gate. |
| `council`            | Major ambiguous strategy decision.                                               | Role-local panel of scouts/critics.                             | Record synthesis and dissent; no raw transcript required.         |
| `parallel-discovery` | Broad repo discovery exceeds parent context budget.                              | Read-only fanout with scoped file/tool limits.                  | No mutation; parent validates findings.                           |
| `spike`              | Uncertain implementation path needs experiment.                                  | Isolated child worktree or session.                             | Explicit opt-in; parent ports or rejects.                         |
| `human-gated`        | Authority or high-assurance review is required.                                  | Human handoff plus optional advisory helpers.                   | Human owns security/acceptance gate.                              |

## Sparring mode (Adversarial Pre-Code Review)

Sparring mode introduces structured red-team adversarial evaluation before code changes are committed, reducing architectural churn and preventing defects early:

1. **Dual-Gate Lifecycle:**
   - **Specification Sparring Gate (Pre-Code):** The specification, architecture proposal, and contract slice undergo formal sparring before implementation starts.
   - **Implementation Acceptance Gate (Post-Code):** Traditional test execution, deterministic criteria verification, and multi-agent review attest to the completed implementation.
2. **Review Target Identity Binding:** Approvals are strictly bound to a composite `ReviewTargetIdentity` (`workItemId`, `cycle`, `contractDigest`, `sliceManifestDigest`, `policyDigest`). If code, contracts, or policies change, previous round approvals are automatically invalidated.
3. **Strict Finding Taxonomy:**
   - `[B]` **Blocker:** Critical invariant violation, security defect, or contract inconsistency. Prevents gate advancement.
   - `[S]` **Structural:** Abstraction leakage, architectural divergence, or testability risk.
   - `[N]` **Nit:** Non-blocking stylistic, formatting, or naming observation.
4. **Separation of Powers:** Reviewers only observe `open` or `verified_closed` statuses. Only the author can submit resolution evidence for findings, and only human/policy authority can grant waivers.
5. **Execution Topologies:**
   - **Mode A (External Harness / Cross-Review):** Dispatches to an external CLI (e.g., `codex exec -s read-only` or `claude`) using stdin streaming.
   - **Mode B (Single-Harness Inner Agent):** When operating in a single harness, an inner subagent is spawned with the forced sparring brief template (`agents/templates/sparring-brief.md`), recording `delegationTopology: "child-subagent"` and `independenceClassification: "same-harness-child"`. Under `high-assurance`, this triggers an explicit human sign-off requirement before gate unlock.
6. **Cumulative Snapshot Ledger:** All rounds, fencing tokens, and finding lifecycles are persisted in `.agentflow/review-ledger.json`, providing a self-contained snapshot document that can be handed off across harnesses at any time.

## Role-local panels

Panels are advisory instruments inside a role, not extra public workflow phases.

Examples:

- analyst: requirements gap scout, acceptance criteria scout;
- architect: risk scout, implementation strategist, testability scout, docs-impact scout;
- tester: coverage planner, failure analyst;
- review: security reviewer, maintainability reviewer, evidence reviewer;
- PR readiness: manifest auditor, issue-link auditor.

## Acceptance between roles

Collaboration continues across a transition. The sending role issues the handover together with an
`AcceptanceContract`; the receiving role returns a `DeliveryReceipt`; deterministic checks run
before the sending role records an `AcceptanceDecision` or `ReworkRequest`.

The sender accepts only conformance to its contract. It does not take ownership of the receiver's
specialist verdict. Complexity routing selects `linear`, `bilateral`, `council`, or `human-gated`
acceptance. See [Role collaboration](role-collaboration.md).

## Council decision model

Councils are role-local advisory exchanges. All seats receive the same evidence digest and return
structured advice. The accountable role synthesizes the advice and dispositions blocking
objections; no majority vote or helper becomes a new lifecycle owner. Providers may run council
seats concurrently or sequentially without changing the evidence contract.

## Evidence model

Durable evidence should be compact:

- selected collaboration mode;
- why the mode was selected;
- helpers used and boundaries;
- synthesis decision;
- accepted/rejected/deferred critiques;
- follow-up issues;
- validation results.
- handover contract, delivery receipt, deterministic report, and acceptance decision;
- council objections and their dispositions when a council was required.

Raw helper output stays local under `.agent-runs/` by default and is summarized into the configured
durable source only when useful and safe.

## Human-facing output

A good summary says:

```text
Mode: advisory. Reason: architecture uncertainty in standard-profile change.
Helpers: risk-scout and testability-scout, read-only.
Decision: choose Option B.
Dissent: testability-scout preferred Option C; deferred to follow-up.
```

It should not expose raw prompt chains, private local data, secrets, or noisy deliberation.

## Relationship to existing workflow

Intelligent collaboration never replaces:

- `AGENTS.md` policy;
- role-pass evidence;
- workflow-status comments;
- handover comments;
- PR manifests;
- validation commands;
- high-assurance human review;
- follow-up issue discipline.
