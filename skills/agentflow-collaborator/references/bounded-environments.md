# Bounded environments

| Environment       | Default authority | Intended use                          |
| ----------------- | ----------------- | ------------------------------------- |
| current session   | parent writer     | normal single-agent path              |
| forked context    | read-only helper  | advisory, council, discovery          |
| fresh session     | read-only helper  | independent local review              |
| provider API call | read-only helper  | bounded external perspective          |
| isolated worktree | isolated writer   | reversible spike only                 |
| human handoff     | human decision    | security, acceptance, external action |

Record permissions, context boundary, artifact location, stop condition, and cleanup rule. Never
allow multiple writers in one shared worktree.
