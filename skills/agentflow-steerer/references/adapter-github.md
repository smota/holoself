# GitHub Remote Execution Adapter Reference

This document maps the provider-neutral 6-verb steering interface to GitHub native constructs (`gh` CLI, issues, PRs, actions). It proves decoupling for remote asynchronous multi-agent coordination without shared local terminals.

## Invariants

1. **Ground Truth Invariant**: PR status check rollups, git merge bases, and signed issue comments constitute ground truth.
2. **Bounded Observation Invariant**: API responses and logs are bounded to relevant summaries; large logs must not be dumped into context.

---

## The 6-Verb GitHub Mapping

| Verb                       | GitHub CLI / API Pattern                                                                                                         | Notes                                                                                                                                           |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `assign(seat, brief_ref)`  | `gh issue comment <issue> --body "Assigned to @<seat>: <brief_ref>"`                                                             | Posts durable assignment comment or updates issue assignees.                                                                                    |
| `observe(seat)`            | `gh pr view <pr> --json statusCheckRollup,state` & `gh run list`                                                                 | Inspects CI checks and workflow state for the seat's branch.                                                                                    |
| `nudge(seat, "gentle")`    | `gh issue comment <issue> --body "@<seat> status check requested"`                                                               | Gentle mention ping on issue thread.                                                                                                            |
| `nudge(seat, "standard")`  | `gh pr review <pr> --comment --body "Handoff/review pending"`                                                                    | Review reminder on pull request.                                                                                                                |
| `nudge(seat, "interrupt")` | `gh run cancel <run_id>`                                                                                                         | Cancels stuck workflow run.                                                                                                                     |
| `read(artifact)`           | `gh pr view <pr> --json body,files` or `git show <commit>:<path>`                                                                | Reads committed artifacts and pull request manifests.                                                                                           |
| `merge(pr)`                | `gh pr merge <pr> --squash --delete-branch`                                                                                      | Halts unless recorded human approval or auto-merge exists; otherwise `escalate("human-gate", "PR #<pr> requires human approval before merge")`. |
| `escalate(class, msg)`     | `gh issue comment <issue> --body "🚨 **ESCALATION [<class>]**: <msg>" && gh issue edit <issue> --add-label "escalation:<class>"` | Tags human supervisor via labels and issue alerts.                                                                                              |
