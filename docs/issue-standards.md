# Issue Standards

This document defines the issue title and label standards for this project's GitHub issues.
Agents must follow it when opening or modifying issues.

## Issue Body Update Rules

Issue updates must keep the management plane deterministic and reviewable. The canonical
body-update mechanism is `scripts/issue-markdown.mjs` — a pure section-replace transform — applied
with a native GitHub call (`gh issue edit --body-file` for Codex/Agy, `mcp__github__issue_write`
for Claude Code).

### Default rule

Prefer **section-targeted updates** over full body replacement.

Use a section update when you are changing a known heading such as:

- `Background & Problem Statement`
- `Proposed Solution`
- `Requirements`
- `Technical Design`
- `Acceptance criteria`
- `Open questions`
- `Feature Tracking`
- `Test plan`
- `Workflow classification`

Section updates preserve all untouched sections, plus labels, milestone, comments, and linked issue
metadata that live outside the body.

The canonical section parser targets level-2 headings in the form `## Heading`. Nested subheadings
remain part of the enclosing section content.

### Full replacement rule

Use **full replacement** only when one of these is true:

- Bootstrapping a brand-new issue from a template
- Migrating a legacy or malformed issue body into the canonical structure
- Performing a deliberate issue-wide rewrite after a material reframing of the work

When replacing the full body, the agent must preserve any still-valid governance content such as:

- `**Epic:** #<id>` links on child issues
- Existing `## Feature Tracking` task lists on epic issues
- Any accepted execution checks or acceptance criteria that remain in scope

If the issue needs a substantive requirement change, document it in the body update and continue.
Do not block waiting for human input unless a real decision is required.

### Authority and ownership

- Agent-created issues are agent-managed by default.
- Humans may refine direction through issue comments; agents should fold resolved answers back into
  the body when they clarify the source of truth.
- Workflow-status comments are separate from body updates and must not be treated as body sections.
- Labels, milestones, and lifecycle metadata are managed explicitly and are not inferred from body
  edits alone.

### Canonical update commands

Prefer these over ad hoc `gh issue edit --body` rewrites:

```bash
# Fetch the current body
gh issue view 123 --json body --jq '.body' > .agent-runs/scratch/123-body.md

# Update one canonical section while preserving the rest of the issue body
node scripts/issue-markdown.mjs --section "Feature Tracking" \
  --replacement tracking.md --body .agent-runs/scratch/123-body.md > .agent-runs/scratch/123-new-body.md

# Append a missing canonical section when needed
node scripts/issue-markdown.mjs --section "Test plan" \
  --replacement test-plan.md --create-if-missing --body .agent-runs/scratch/123-body.md > .agent-runs/scratch/123-new-body.md

# Apply the updated body with native GitHub tooling
gh issue edit 123 --body-file .agent-runs/scratch/123-new-body.md
# Claude Code: use mcp__github__issue_write with the new body instead
```

For full replacement, construct the new body directly — preserving the governance content listed
above — and apply it the same way. `scripts/issue-markdown.mjs` only performs section-targeted
updates.

## Recommended Issue Structure

To ensure the Architect phase has a clear, unambiguous goal, issues should use a strict template that separates the _problem_ from the _technical design_:

```markdown
## Background & Problem Statement

_Why is this needed? What fails or scales poorly in the current state?_

## Proposed Solution

_High-level description of what we are building._

## Requirements

- [ ] Business or technical requirement 1

## Technical Design

_Exact file paths, template names, or data structures expected. The Architect phase writes its Solution Design Document (SDD) here._

## Acceptance criteria

- [ ] Pass/Fail condition 1
```

## Issue Hierarchy

This is the one description of how a work record shows its kind and its parent.

A work record has a kind of `goal`, `capability`, or `spec` in the body marker
`<!-- agentflow-work:{...} -->`. The title starts with `goal:`, `capability:`, or `spec:`, and the
issue wears `kind:goal`, `kind:capability`, or `kind:spec`. Those three names are the same kind.
A record with no kind is a legacy bug. It keeps a conventional title, it wears no `kind:` label,
and it is not a goal.

`Part of #<parent>` is the only parent. A capability or a spec has one. A goal has none.
`**Epic:** #<parent>` may repeat that same number and must not name a different one. A GitHub
sub-issue is only a navigation mirror. The open path writes the title prefix, the kind label, the
marker, and `Part of` together. The issue validator rejects a disagreement.

A part has one current record. A breakdown note that is not yet admitted has the `capability:`
title, the `kind:capability` label, one `Part of`, and no work marker. That shape is valid. An
admitted capability may carry one `Replaces #<note>` line. That line is the only replacement
authority. It sets no parent, it does not move what a person agreed, and the note is not edited. A
goal's current parts are its admitted records plus the notes nothing replaces. Given the other
records (`validate-sdlc-issue --records <file>`), the issue validator refuses two capabilities that
replace one note, a capability that names more than one note, a note under another parent, and a
replacement of a goal, a spec, an admitted capability, or itself.

### Goal Child Completion and Parts Ledger

Goals maintain a deterministic, structured section under `## Child Work & History` (or `## Parts Ledger`) documenting all child parts, replacement relations, merging PRs, commits, dates, and delivery completion:

```markdown
## Child Work & History

> **Status:** All child capabilities delivered — ready for person review/closure
> **Progress:** 5/5 delivered (100%)

| Part | Kind       | Title                                    | Status    | Replacement   | Delivery PR | Commit    | Date       |
| :--- | :--------- | :--------------------------------------- | :-------- | :------------ | :---------- | :-------- | :--------- |
| #440 | capability | capability: zero-friction assisted setup | Delivered | Replaces #435 | #445        | `573989c` | 2026-10-13 |
| #441 | capability | capability: self-healing configuration   | Delivered | —             | #446        | `6b823dd` | 2026-10-13 |
```

Rules and Invariants:

1. **Non-Automatic Closure Invariant**: Parent goals must **never** be auto-closed by child PR merges. The human person retains final authority to review and close the completed goal.
2. **Ready-for-Closure Milestone**: When all admitted child capabilities are delivered, the goal ledger visibly reflects this milestone with `> **Status:** All child capabilities delivered — ready for person review/closure`.
3. **Audit Trail**: Every delivered child records its merging PR, merge commit SHA, completion date, and replacement mapping.
4. **Validation & Synchronization**: Tooling (`agentflow-sdlc goal sync <number>`, `scripts/sync-goal-ledger.mjs`, and `scripts/validate-sdlc-issue.mjs --records`) validates ledger consistency against child issue records and rejects desynchronized or premature ready-for-closure statuses. Updating the ledger section does not move the goal subject a person agreed to in human gates.

## Issue Titles

A legacy record, which has no work kind, must start with one of these exact Conventional Commit prefixes. A goal, capability, or spec uses the kind prefix in [Issue Hierarchy](#issue-hierarchy) instead.

- `feat:` - user-facing product capability or feature work
- `fix:` - defect, regression, or security bug fix
- `chore:` - repository maintenance, documentation, process, or agent workflow work
- `refactor:` - code restructuring without intended behavior changes
- `build:` - build, CI, packaging, release, or infrastructure automation changes
- `qa:` - exploratory QA sessions, QA session planning/execution, or QA evidence work

Rules:

- Use the exact lowercase prefix, including the trailing colon.
- Do not use scoped prefixes such as `fix(cli):` unless this standard is updated.
- Do not use legacy title markers such as `[Epic]`, `epic:`, `Feature:`, or `Chore:`.
- Use labels to communicate issue type, epic status, routing, and lifecycle state.
- Keep the title concise and action-oriented.

Examples:

- `chore: establish unified agent issue formatting standards`
- `feat: add customer import validation`
- `fix: prevent tenant leakage in customer list`
- `refactor: split feature flag resolution service`
- `build: add cli issue creation command`
- `qa: exploratory sysadmin QA session`

For epic issues, use a normal Conventional Commit title and apply the `epic` label:

- `feat: customer lifecycle automation epic`
- `chore: developer workflow automation epic`

## Minimum Required Labels

Every new issue must have at least:

1. **One primary type/domain label** — `feature`, `bug`, `dx`, `tooling`, `documentation`, or `qa` (choose the one that best describes the primary work)
2. **A lifecycle label** — `drafted-by:<agent>` when the issue is created or drafted by an agent

The type/domain label requirement applies to every new issue, human or agent-created. The `drafted-by:<agent>` requirement applies only when the issue is created or drafted by an agent. An issue missing its primary type/domain label, or missing `drafted-by:<agent>` when agent-created, is incomplete and must be corrected before work begins.

The `drafted-by:<agent>` label must name the runtime that actually created or materially drafted the issue in the current session. Do not copy the label from an adapter file, a previous issue, a prompt example, or the user's preferred agent. If the correct runtime-specific label does not exist, create it before opening the issue or immediately correct the issue after creation.

Examples:

| Created by | Minimum labels                    |
| ---------- | --------------------------------- |
| Human      | `feature`                         |
| Claude     | `feature`, `drafted-by:claude`    |
| Codex      | `bug`, `drafted-by:codex`         |
| Agy        | `dx`, `drafted-by:agy`            |
| Pi         | `tooling`, `drafted-by:pi`        |
| QA agent   | `qa`, `drafted-by:<actual-agent>` |

Additional routing and lifecycle labels (`for-implementation:<agent>`, `implemented-by:<agent>`, etc.) are applied as work progresses. They supplement — never replace — the minimum required set.

## Canonical Labels

Use this canonical label vocabulary for new issues and issue updates.

### Type and Domain Labels

- `epic` - parent tracking issue with a GitHub task list of child issues
- `feature` - user-facing product capability
- `bug` - defect, regression, security bug, or broken behavior
- `dx` - developer experience, agent workflow, repository workflow, or contributor experience work
- `tooling` - CLI tooling, automation, scripts, CI helpers, or local developer tools
- `documentation` - documentation-first work where docs are the primary deliverable or review surface
- `qa` - exploratory QA sessions, QA planning/execution, or QA evidence work
- `exploratory` - exploratory/manual test-session scope marker used with `qa` issues

Apply secondary labels only when they describe the primary work or a meaningful review queue. Do not add `documentation` merely because an implementation issue includes docs updates in its acceptance criteria; use it when the issue is documentation-first or when documentation review is the main work surface.

### Process State

Every work item shows exactly one process state. The product computes it from the phase record and
one integration fact; nobody sets it by hand.

| State     | When                                                                         |
| --------- | ---------------------------------------------------------------------------- |
| Backlog   | No transition, phase 0, or a return to phase 0 or 1. Acceptance is open.     |
| Readiness | The latest transition is a phase 1 pass. Acceptance is frozen.               |
| WIP       | Any later transition, including a return to phase 3 or 4 and a phase 8 pass. |
| Delivered | The result is on the integration line or trunk. A version tag is not needed. |

The integration fact wins over the phase record. On GitHub it is an `integrated:<branch>` label or a
merged pull request into the integration line or trunk that closes the issue. On the filesystem
medium it is `integration.json` beside `goal.json`, written by `agentflow-sdlc phase integrate`. A
closed flag is not the fact: an item closed without it has no state and is left off the board as a
count.

On GitHub the issue carries one label for its state: `state:backlog`, `state:readiness`,
`state:wip`, or `state:delivered`. `phase append` replaces it when the projection changes. Do not
set it by hand. `agentflow-sdlc board` shows the four groups for a GitHub repository or a
filesystem root.

The four states are fixed. An extension pack or adopter profile cannot add or rename one.
`status:in-progress`, `status:backlog`, `status:v1-ready`, and `status:superseded` are retired; the
product neither writes nor reads them as a state.

### Test Debt Labels

- `needs-test` — applied by the `qa-expert` role at bug issue creation; removed by the `tester` role only after a regression test (`*.spec.ts` or `*.e2e.ts`) is committed and passing in the fix PR. A bug PR that closes a `needs-test` issue without adding or modifying a test file must explain why in `## Agent review`.

### Agent Routing Labels

- `for-implementation:<agent>` - route implementation work to an agent

Examples:

- `for-implementation:codex`
- `for-implementation:claude`
- `for-implementation:agy`

Routing labels express a preference, not proof that the issue is eligible for a workflow profile
or provider. Lane B is provider-neutral; Agy is preferred for documentation, multimodal work,
and broad discovery, but is never an independent review signer. Run the deterministic bounded-work
validator before treating any issue as bounded.

### Agent Lifecycle Labels

- `drafted-by:<agent>` - issue, plan, or spec was drafted by the named agent/runtime in the current session
- `implemented-by:<agent>` - implementation was completed by an agent
- `for-review:<agent>` - review is requested from an agent
- `reviewed-by:<agent>` - review was completed by an agent

Examples:

- `drafted-by:codex`
- `implemented-by:agy`
- `for-review:claude`
- `reviewed-by:codex`

Use lowercase registered platform slugs for provenance labels and routable platform slugs for
routing labels. Keep labels specific: prefer one routing label and one lifecycle label over generic
ownership. Provenance labels are factual audit metadata: never name Claude, Codex, Agy, Pi,
ChatGPT/Cowork, Antigravity, human, or future registered runtime unless that platform actually
drafted or performed work.
Update one workflow-status issue comment as work progresses. Do not create a comment for every
internal phase or evidence role.

## Deprecated Labels

Legacy `agent:*` labels are forbidden for new work.

Do not add labels such as:

- `agent:codex`
- `agent:claude`
- `agent:agy`

When modifying an existing issue that still has an `agent:*` label, do not preserve that pattern for new state. If the meaning is clear, replace it with the specific lifecycle or routing label:

- Replace assignment intent with `for-implementation:<agent>`.
- Replace completed implementation state with `implemented-by:<agent>`.
- Replace requested review state with `for-review:<agent>`.
- Replace completed review state with `reviewed-by:<agent>`.

## Label Examples

Feature implementation:

- Title: `feat: add customer import validation`
- Labels: `feature`, `for-implementation:codex`

Feature implementation drafted by Pi:

- Title: `feat: add Omnigent routing runtime support`
- Labels: `feature`, `dx`, `tooling`, `drafted-by:pi`

Bug fix:

- Title: `fix: prevent tenant leakage in customer list`
- Labels: `bug`, `for-implementation:codex`

Developer tooling:

- Title: `build: add cli issue creation command`
- Labels: `dx`, `tooling`, `for-implementation:codex`

Epic:

- Title: `feat: customer lifecycle automation epic`
- Labels: `epic`, `feature`

Documentation-first issue:

- Title: `chore: document Omnigent-powered SDLC scenarios`
- Labels: `documentation`, `dx`, `drafted-by:pi`

Agent review:

- Title: `chore: review route planning spec coverage`
- Labels: `dx`, `for-review:claude`, `drafted-by:codex`

Exploratory QA session:

- Title: `qa: exploratory sysadmin QA session`
- Labels: `qa`, `exploratory`, `drafted-by:codex`
