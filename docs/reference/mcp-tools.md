# MCP tool reference

All tools are bound to one linked project at server startup. No tool accepts a project path, self root, or arbitrary filesystem root. Inputs reject unknown properties.

<!-- generated:start -->
| Tool | Mode | Required inputs | Optional inputs | Description |
|---|---|---|---|---|
| `holoself_status` | Read-only | _(none)_ | _(none)_ | Check the fixed linked project, explicit link authority, context health, and pending proposals without revealing private root paths. |
| `holoself_context` | Read-only | `task` | `lens`, `budget`, `temporal`, `cursor`, `session_start`, `need`, `source_ids` | Resolve and deliver privacy-filtered, lens-scoped context for the current task in a single round-trip. Manifest and get remain optional for fine-grained inspection. |
| `holoself_context_manifest` | Read-only | _(none)_ | `task`, `lens`, `budget`, `temporal`, `cursor`, `session_start`, `need` | Return bounded source handles, metadata, restrictions, and a deterministic receipt. It does not return source bodies. |
| `holoself_context_get` | Read-only | `source_ids` | `task`, `lens`, `budget`, `temporal`, `cursor`, `session_start` | Resolve only the requested manifest source handles through the link, lens, lifecycle, and privacy gates. |
| `holoself_search` | Read-only | `query` | `lens`, `temporal`, `federated`, `limit` | Search the deterministic local privacy-filtered index for the fixed linked project. |
| `holoself_proposal_create` | Project-local write | `source_files` | `operation`, `claim`, `claim_id`, `reason`, `evidence`, `target`, `proposal_type`, `confidence`, `visibility` | Create a project-local pending proposal backed by contained project evidence. It never writes canonical self. operation append_claim (default) adds a claim; replace_claim, supersede_claim and retire_claim target an existing claim by the claim_id shown in delivered context and require evidence. |
| `holoself_proposal_preview` | Read-only | `proposal_id` | _(none)_ | Preview the exact canonical changes and digest for a pending proposal without applying or approving it. |
<!-- generated:end -->

Context tasks and search queries are limited to 500 characters. An explicit lens must be the link's default or one of its secondary lenses; MCP cannot escalate a link to another lens. MCP budgets are `small`, `standard`, or `deep`; unbounded output is intentionally unavailable. Temporal scopes are `current`, `historical`, `superseded`, and `all`. Context tools (`holoself_context`, `holoself_context_manifest`, `holoself_context_get`) return the packet once, in `structuredContent`, with a short text summary listing the selected paths, `total_bytes` and the receipt hash. The whole result stays within the budget's envelope cap (16 KiB, 48 KiB or 128 KiB); `selection.total_bytes`, `estimated_tokens_total` and `envelope_cap_bytes` describe it, and sources dropped to fit are listed in `selection.envelope_dropped`. A packet that had to shrink also groups `restrictions` by reason (entries gain `count` and up to five `sources`, flagged by `selection.restrictions_grouped`) and reduces `proposals` to `{proposal_id, status}`; consumers should accept both forms. Other tools return JSON text plus identical `structuredContent`. All responses are capped at 512 KiB and strip absolute self/project paths.

Read-only MCP tools are physically non-mutating: context caching is disabled and search builds a missing/stale index in memory without persisting it. Use the CLI to rebuild durable project index state.

Tool annotations describe expected effects for the client, but server-side enforcement is authoritative. The proposal tool is non-read-only, non-destructive, non-idempotent, and closed-world. All other tools are read-only and closed-world.

## Prompts

The server advertises `prompts: { listChanged: false }` in `initialize` and serves `prompts/list` and `prompts/get` on the main thread without reading user files or embedding user data.

| Prompt | Optional arguments | Description |
|---|---|---|
| `holoself_session_harvest` | `focus` (single-line string, 1–200 chars, no reserved markers) | Review the session and draft 0–3 evidence-backed pending proposals (`holoself_proposal_create` and `holoself_proposal_preview`) without writing canonical self. |

The prompt text is a versioned constant (`v1`). It instructs the agent to prefer proposing nothing when unsure, never infer sensitive identity attributes or invent facts, use `append_claim`, `replace_claim`, `supersede_claim`, or `retire_claim` (targeting `claim_id` when a visible claim in context is outdated), report what was proposed, and remind the owner to approve in the CLI or Workbench. Unknown prompt names or invalid arguments return JSON-RPC `-32602` (`PROMPT_NOT_FOUND` or `INVALID_ARGUMENT`). Non-MCP hosts print the identical prompt text with `holoself instructions render --harvest --project <dir> [--focus <text>]`.

Not exposed: resources, sampling, elicitation, tasks, link mutation, proposal approval/rejection, cleanup apply, skill installation, publication, network access, raw canonical files, or canonical writes.
