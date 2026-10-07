# MCP tool reference

All tools are bound to one linked project at server startup. No tool accepts a project path, self root, or arbitrary filesystem root. Inputs reject unknown properties.

| Tool | Effect |
|---|---|
| `holoself_status` | Read-only link, context, and pending-proposal health without private root paths |
| `holoself_context` | Read-only privacy-filtered context for a task in one round-trip; `session_start: true` loads the lens session-start sources |
| `holoself_context_manifest` | Read-only bounded source handles, metadata, restrictions, selection, and receipt; bodies omitted |
| `holoself_context_get` | Read-only context for 1–16 manifest source handles through the same privacy/lifecycle gates |
| `holoself_search` | Read-only deterministic index search, limited to 1–20 results |
| `holoself_proposal_create` | Creates one project-local pending proposal from 1–8 contained evidence files; no canonical write |
| `holoself_proposal_preview` | Read-only exact preview/digest; cannot approve or apply |

Context tasks and search queries are limited to 500 characters. An explicit lens must be the link's default or one of its secondary lenses; MCP cannot escalate a link to another lens. MCP budgets are `small`, `standard`, or `deep`; unbounded output is intentionally unavailable. Temporal scopes are `current`, `historical`, `superseded`, and `all`. Context tools (`holoself_context`, `holoself_context_manifest`, `holoself_context_get`) return the packet once, in `structuredContent`, with a short text summary listing the selected paths, `total_bytes` and the receipt hash. The whole result stays within the budget's envelope cap (16 KiB, 48 KiB or 128 KiB); `selection.total_bytes`, `estimated_tokens_total` and `envelope_cap_bytes` describe it, and sources dropped to fit are listed in `selection.envelope_dropped`. A packet that had to shrink also groups `restrictions` by reason (entries gain `count` and up to five `sources`, flagged by `selection.restrictions_grouped`) and reduces `proposals` to `{proposal_id, status}`; consumers should accept both forms. Other tools return JSON text plus identical `structuredContent`. All responses are capped at 512 KiB and strip absolute self/project paths.

Read-only MCP tools are physically non-mutating: context caching is disabled and search builds a missing/stale index in memory without persisting it. Use the CLI to rebuild durable project index state.

Tool annotations describe expected effects for the client, but server-side enforcement is authoritative. The proposal tool is non-read-only, non-destructive, non-idempotent, and closed-world. All other tools are read-only and closed-world.

Not exposed: resources, prompts, sampling, elicitation, tasks, link mutation, proposal approval/rejection, cleanup apply, skill installation, publication, network access, raw canonical files, or canonical writes.
