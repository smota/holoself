# tmux Fallback Execution Adapter Reference

This document maps the provider-neutral 6-verb steering interface to standalone `tmux` sessions. It demonstrates decoupling from OpenRig: when OpenRig is unavailable, the steering PO invokes identical verbs backed by standard tmux multiplexer commands.

## Invariants

1. **Ground Truth Invariant**: Progress is derived exclusively from disk artifacts, git commits, and issue comments. Screen captures are strictly for liveness and classification.
2. **Bounded Observation Invariant**: Raw pane captures MUST NEVER exceed 40 lines. Captures MUST be mapped to one state (`idle`, `busy`, `waiting-input`, `stalled`, `exited`) and discarded from long-term memory.

---

## The 6-Verb tmux Mapping

| Verb                       | tmux Command Pattern                                                                  | Notes                                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `assign(seat, brief_ref)`  | `tmux send-keys -t <session> "agentflow-sdlc phase append --brief <brief_ref>" Enter` | Types task intake command into target session prompt.                                                                                           |
| `observe(seat)`            | `tmux capture-pane -pt <session> -S -40`                                              | Captures at most 40 lines from pane buffer and classifies state.                                                                                |
| `nudge(seat, "gentle")`    | `tmux send-keys -t <session> "echo 'Status check: <brief_ref>'" Enter`                | Non-destructive prompt text.                                                                                                                    |
| `nudge(seat, "standard")`  | `tmux send-keys -t <session> "agentflow-sdlc phase status" Enter`                     | Queries current phase progress.                                                                                                                 |
| `nudge(seat, "interrupt")` | `tmux send-keys -t <session> C-c`                                                     | Sends SIGINT to terminate hanging process.                                                                                                      |
| `read(artifact)`           | Standard filesystem read (`node -e "..."` or shell `cat <artifact>`)                  | Reads durable phase evidence on disk.                                                                                                           |
| `merge(pr)`                | `gh pr merge <pr> --squash --delete-branch`                                           | Halts unless recorded human approval or auto-merge exists; otherwise `escalate("human-gate", "PR #<pr> requires human approval before merge")`. |
| `escalate(class, msg)`     | `tmux send-keys -t supervisor "ALERT [<class>]: <msg>" Enter`                         | Notifies human/supervisor session and writes issue comment.                                                                                     |
