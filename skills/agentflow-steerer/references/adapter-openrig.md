# OpenRig Execution Adapter Reference

This document maps the provider-neutral 6-verb steering interface (`steer.lead`) to concrete OpenRig CLI operations. It establishes execution layer decoupling: the steering lead reasons in abstract steering verbs, while this reference specifies how those verbs execute within an OpenRig topology.

## Invariants

1. **Ground Truth Invariant**: Seats report progress through durable artifacts (`.agent-runs/`, git commits, PR bodies, issue comments). Process telemetry and terminal captures are strictly for liveness checks and stall detection, never for certifying task completion.
2. **Bounded Observation Invariant**: Raw terminal captures MUST NEVER exceed 40 lines. Captures are ephemeral glances that MUST be immediately classified into exactly one discrete state: `idle`, `busy`, `waiting-input`, `stalled`, or `exited`. Raw capture text MUST NOT be retained across ticks or leaked into conversation context.
3. **Decoupled Execution Invariant**: Steering logic depends only on the 6 verb signatures. Runtimes without OpenRig use alternative adapter tables (see [adapter-tmux](adapter-tmux.md) and [adapter-github](adapter-github.md)) without altering steering rules.

---

## Target Routing Allowlist

The steering plane communicates exclusively across rig boundaries to designated entry seats. Direct communication with internal delivery execution seats is strictly prohibited:

| Target Seat    | Canonical Session Pattern                 | Allowed Verbs                | Purpose                                                                                 |
| :------------- | :---------------------------------------- | :--------------------------- | :-------------------------------------------------------------------------------------- |
| `pm.manager`   | `manager@<project>-product`, `pm-manager` | `assign`, `nudge`, `observe` | Ingestion of customer jobs, goal framing, macro DAG alignment.                          |
| `orch.arch`    | `architect@<project>`, `orch-arch`        | `observe`, `nudge`, `read`   | Cross-rig synchronization, unfreeze resolutions, merge-check readiness.                 |
| `human`        | `human`                                   | `escalate`, `queue create`   | Human release gates, person-waivers, abandonment approvals, quota/security escalations. |
| `dev.build*`   | `builder*@<project>`                      | **PROHIBITED**               | In-rig builder seats. Steerer must never assign, nudge, or dispatch to builders.        |
| `dev.qa`       | `qa@<project>`                            | **PROHIBITED**               | In-rig verification seat. Verification is owned within the delivery squad.              |
| `dev.test-eng` | `test-eng@<project>`                      | **PROHIBITED**               | In-rig test authoring seat. Steerer must not interfere with test authoring.             |
| `rev.review`   | `reviewer@<project>`                      | **PROHIBITED**               | In-rig peer review seat. Independent review must remain uninfluenced by steering.       |
| `pm.analyst`   | `analyst@<project>-product`               | **PROHIBITED**               | In-rig product analysis seat. Communication flows through `pm.manager`.                 |

---

## The 6-Verb Interface

### 1. `assign(seat, brief_ref)`

Dispatches an admitted task brief to a designated squad seat.

- **Signature**: `assign(seat: string, brief_ref: string) -> { assigned: boolean, queue_id?: string }`
- **Preconditions**:
  - `brief_ref` points to an immutable, admitted specification or task packet on disk.
  - `seat` is an authorized entry seat in the target routing allowlist (`pm.manager`).
- **OpenRig Mapping**:
  ```bash
  # Enqueue durable work item with goal and transition pointers
  rig queue create --destination <session> --body-file <brief_ref> --summary "Task brief: <brief_ref>"
  # Direct prompt notification into target seat pane
  rig send <session> "Goal: <goal_uri> | Transition: <transition_uri> | Brief: <brief_ref>"
  ```
- **Postconditions**: Task is durable in the seat's queue; target terminal is nudged.
- **Heuristic Acceleration (Decider Port)**: When multiple candidate tasks await assignment, the external steerer may triage queue priority using `triageQueueOrdering` via the local decider port (`http://127.0.0.1:8002/v1/decide` with Jev auth and deterministic fallback).

### 2. `observe(seat)`

Inspects seat liveness and operational posture without disrupting its context.

- **Signature**: `observe(seat: string) -> { state: "idle" | "busy" | "waiting-input" | "stalled" | "exited", lines_captured: number }`
- **Preconditions**: `seat` exists in current rig topology and is an authorized observation target (`pm.manager`, `orch.arch`).
- **OpenRig Mapping**:
  ```bash
  # Check node process status
  rig ps --nodes --json
  # Ephemeral glance at screen (bounded to last 40 lines)
  rig capture <canonicalSessionName> | tail -n 40
  ```
- **Classification Rules**:
  - `idle`: Prompt is waiting for user/agent input, no active task executing.
  - `busy`: Tool execution, compilation, test run, or generation in progress.
  - `waiting-input`: Interactive confirmation prompt (permission, gate, question) detected.
  - `stalled`: Process active but unchanged across multiple heartbeats with zero progress.
  - `exited`: Process or pane terminated.

### 3. `nudge(seat, level)`

Sends a prompt or wake signal to an executing seat.

- **Signature**: `nudge(seat: string, level: "gentle" | "standard" | "urgent", message?: string) -> { sent: boolean }`
- **Levels**:
  - `gentle`: Informational wake or status reminder.
    ```bash
    rig send <session> "Status update check: please report current step on <brief_ref>"
    ```
  - `standard`: Expected transition or handoff overdue notice.
    ```bash
    rig send <session> "Handoff pending: please record phase evidence and transition"
    ```
  - `urgent`: Escalated status reminder for stuck or stalled turn.
    ```bash
    rig send <session> "Turn stall detected: please check blocker, emit receipt, or yield turn"
    ```
- **Keystroke Safety Invariant**: Keystroke interrupts (such as sending raw `^C` keystrokes) are strictly prohibited as they corrupt non-interactive terminal processes and nested subshells.
- **Heuristic Acceleration (Decider Port)**: The external steerer may resolve calibrated nudge urgency (`gentle` | `standard` | `urgent`) using `triageNudgeLevel` via the decider port, with deterministic threshold fallbacks (`idle >= 300s` or `round >= 2` -> `urgent`).

### 4. `read(artifact)`

Loads durable execution artifacts from the filesystem or repository.

- **Signature**: `read(artifact: string) -> { exists: boolean, content: string, digest: string }`
- **Behavior**: Reads evidence files, phase transition receipts, test summaries, or git patches. Telemetry or volatile console buffers are prohibited here.
- **Paths**: `.agent-runs/issues/<issue>/...`, `manifests/...`, `.worktrees/<branch>/...`.

### 5. `merge(pr)`

Executes squash-and-merge of a verified pull request after bilateral/council review sign-off.

- **Signature**: `merge(pr: number) -> { merged: boolean, sha?: string }`
- **Preconditions**:
  - Independent reviewer or auditor sign-off recorded.
  - Four-eyes principle satisfied (builder != reviewer).
  - All CI status checks green.
  - Explicit human approval recorded for this PR merge, or a recorded auto-merge configuration for this delivery.
- **Gate**: Without that recorded human approval or recorded auto-merge configuration, halt. Do not run the merge command. Emit `escalate("human-gate", "PR #<pr> requires human approval before merge")`.
- **Mapping** (only after the gate passes):
  ```bash
  gh pr merge <pr> --squash --delete-branch
  ```

### 6. `escalate(class, msg)`

Raises an out-of-band escalation to the human operator or supervising orchestrator.

- **Signature**: `escalate(class: "human-gate" | "contract-breach" | "blocker" | "resource-exhaustion", msg: string) -> { escalated: boolean }`
- **OpenRig Mapping**:
  ```bash
  # Enqueue durable human decision/escalation item
  rig queue create --destination human --summary "ESCALATION [<class>]: <msg>" --body-file <escalation_file> --human-intent decision
  # Record durable escalation on issue or PR
  gh issue comment <issue> --body "⚠️ **ESCALATION [<class>]**: <msg>"
  ```

---

## Decider Provider Port Integration (`d3-flash`)

The external steering lead connects optionally to the local non-causal decision model (`d3-flash` on `http://127.0.0.1:8002/v1/decide` with Jev authentication headers) via `lib/providers/decider-port.mjs` for low-latency (<15ms) heuristic triage.

### Strict Invariants & Boundaries

1. **Plane Isolation**: The decider port connects strictly in the external supervisory steering plane. In-rig delivery seats (`dev.build`, `dev.test-eng`, `dev.qa`, `orch.pm`, `pm.manager`, etc.) are barred from invoking the decider port; invocations require an authorized steering seat (`steer.lead`, session prefix `steer-lead@`, or registered supervisor) and fail closed.
2. **Zero Source Code Egress**: All payloads transmitted to the decider port are sanitized: raw source code, patches, diff contents, and secrets are strictly redacted. Transmitted payloads carry only criterion IDs, exit codes, diff statistics (`filesChanged`, `insertions`, `deletions`), and defect summaries.
3. **Strict Allowlist**: Restricted exclusively to advisory triage:
   - `queue-ordering`: `triageQueueOrdering` for candidate brief priority.
   - `issue-dedupe`: `triageIssueDedupe` for finding deduplication against open backlog.
   - `nudge-level`: `triageNudgeLevel` for calibrated wake urgency (`gentle` | `standard` | `urgent`).
4. **Absolute Prohibitions**: The decider port is strictly barred from granting gate sign-offs, advancing phases, altering scope, or executing code merges.
5. **Deterministic Fallbacks**: Every triage operation includes an autonomous deterministic fallback if the decider service is offline, unresponsive, or unauthenticated.
