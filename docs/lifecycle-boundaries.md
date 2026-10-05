# Lifecycle and action boundaries

These contracts connect AgentFlow to work before discovery and after PR readiness without adding
mandatory Deploy or Maintain phases.

External signals progress through `observed → proposed → triaged → accepted | rejected`. Product
manager / JTBD or Analyst owns triage. Acceptance requires a goal reference. A signal cannot jump
directly to Developer; it enters the normal goal and requirements path. Every state after
`observed` records `previousState`, so the validator can reject skipped transitions.

A delivery handoff is evidence, not deployment authority. Ready/accepted/completed records name an
external owner, originate from Tech writer or PR readiness, reference artifacts and validation,
and record rollback evidence or why rollback is not applicable. External system state remains
authoritative. State changes record `previousState` and follow
`proposed → ready → accepted → completed`, with `blocked` allowed before completion.

Workflow profile and action boundary are orthogonal. The boundary is `observe`, `propose`,
`mutate-worktree`, `open-pr`, or `external-action`; the effective value is the minimum of request,
profile maximum, parent/delegation boundary, and runtime enforcement. A child never widens it.
External actions require an owning role and applicable human approval. Merge and production are
never implied by implementation.

```text
agentflow-sdlc sdlc validate-lifecycle --type external-signal --path signal.json
agentflow-sdlc sdlc validate-lifecycle --type delivery-handoff --path handoff.json
agentflow-sdlc sdlc validate-lifecycle --type action-boundary --path boundary.json
```
