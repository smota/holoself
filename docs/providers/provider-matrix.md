# Provider matrix

Facets are independently advertised: `inventory`, `project-adapters`, `execution`, `workspace`,
`evidence`, and `lifecycle`. Advanced behavior is not encoded in this table: `inspect()` returns
the current provider's `intentSupport`, implementation, fidelity, evidence level, and limits.

| Provider          | Proven facets                         | Availability behavior              | Important limit                                    |
| ----------------- | ------------------------------------- | ---------------------------------- | -------------------------------------------------- |
| `manual`          | execution, evidence                   | Always explicit                    | Human handoff; no automated launch                 |
| `claude-cli`      | execution, evidence                   | Non-shell `claude --version` probe | Project chooses execution target/model             |
| `codex-cli`       | execution, evidence                   | Non-shell `codex --version` probe  | Harness-native delegation is separate              |
| `agy-cli`         | execution, evidence                   | Non-shell `agy --version` probe    | Agy and Antigravity remain distinct identities     |
| `pi-cli`          | execution, evidence                   | Non-shell `pi --version` probe     | Pi parent/subagent/session targets remain explicit |
| `grok-cli`        | execution, evidence                   | Non-shell version/help probes      | Web disabled; delegation is intent-controlled      |
| `xai-api`         | execution, evidence                   | Unavailable until configured       | Explicit API invoker; never substitutes silently   |
| `ai-foundry-desk` | inventory, project-adapters, evidence | Non-shell `afd --version` probe    | No execution, workspace, or lifecycle facet        |

Inspecting a provider does not install it, authenticate it, edit project configuration, or widen the
current action boundary.

This matrix documents provider service surfaces, not a static capability promise. Use
`agentflow-sdlc providers inspect <id> --json` for the current runtime evidence.
