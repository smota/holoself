# Collaboration modes

| Mode                 | Pattern                      | Effort ceiling                   | Use                               |
| -------------------- | ---------------------------- | -------------------------------- | --------------------------------- |
| `single-agent`       | normal orchestration         | `low` (`P0`) / `medium` (`P1+`)  | clear routine work                |
| `advisory`           | scoped scout or critique     | `low` (scout) / `medium` (peer)  | focused second opinion            |
| `council`            | clean L2 subagent panel      | `high` (`<30k–40k` clean ctx)    | high-uncertainty strategy         |
| `parallel-discovery` | bounded read-only fanout     | `low` (fast flash/grok subagent) | broad repository discovery        |
| `spike`              | isolated worktree experiment | `medium`                         | uncertain implementation approach |
| `human-gated`        | human authority gate         | `medium` + human sign-off        | sensitive or high-assurance work  |

Use the smallest sufficient mode. A helper advises; the owning AgentFlow role decides. Never run `effort: high` in a dirty (`>40k` token) parent loop; spawn a clean L2 subagent instead.
