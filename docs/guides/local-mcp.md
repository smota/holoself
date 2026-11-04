# Local MCP integration

MCP is an optional harness integration for an already linked project. It does not create a link and it does not replace `.holoself/link.yaml`.

## Configure

Preview collision-aware project configuration:

```text
holoself mcp configure --project C:/work/my-project --dry-run
```

After reviewing exact files and hashes:

```text
holoself mcp configure --project C:/work/my-project --yes
holoself mcp status --project C:/work/my-project
```

Use repeatable `--platform codex|agy|claude` to select clients. Holoself writes only project-local client configuration:

| Client | File | Project binding |
|---|---|---|
| Codex | `.codex/config.toml` | fixed absolute `--project` in local configuration |
| AGY | `.agents/mcp_config.json` | fixed absolute `--project` and `cwd` |
| Claude Code | `.mcp.json` | required client-provided `CLAUDE_PROJECT_DIR`; missing signal fails closed |

Codex and AGY absolute bindings are intentionally deterministic local configuration. Do not commit them when a path identifies a private host or user. Claude's project file is path-portable. Existing divergent `holoself` entries and malformed managed markers are refused rather than overwritten.

The `holoself` executable must be on the client process PATH. Install `holoself-ai` from npm (for example `npm install --global holoself-ai`) or, from a source checkout, use a reviewed local or managed package-bin installation that points at that checkout. Confirm `holoself --version` in the client environment before applying configuration; running `node bin/holoself.mjs` in a terminal proves only that the checkout works. See [CLI invocation](../reference/cli.md#invocation).

## Runtime behavior

The client starts `holoself mcp` as a STDIO subprocess. STDOUT is JSON-RPC only. The process exits with the client session; no service remains running. The server rejects missing, unsafe, or ambiguous project bindings before serving context.

Tool calls run on a small pool of worker threads, so a slow context call never delays `ping`, `initialize`, `tools/list`, or other protocol messages. Responses may arrive out of order; clients must match each response to its request by JSON-RPC id. The CLI and MCP still use the same synchronous core.

- At most two tool calls run at once (`HOLOSELF_MCP_CONCURRENCY`, 1–8). Read-only tools may run in parallel. `holoself_proposal_create` writes project state, so it waits for running calls and runs alone.
- A repeated context call goes to the worker that served it before (the link's default lens is read once at startup for this), so `context_receipt.cache.hit` behaves as it would in a single process. Calls are compared after defaults are applied, so an omitted budget or lens matches the explicit default. After a worker is replaced (cancellation, timeout, or crash), its cache is gone and the next matching call reports `cache.hit: false`.
- `notifications/cancelled` (`params.requestId`) removes a queued call or stops the worker running it. A cancelled call gets no response and never a partial packet. A replacement worker starts only when the next call needs it.
- Each call has a timeout of 60 seconds (`HOLOSELF_MCP_TOOL_TIMEOUT_MS`, 100–3600000). A call that runs past it returns JSON-RPC error `-32001` with `data.code` `TOOL_TIMEOUT`, and its worker is replaced.
- Write tools (`holoself_proposal_create`) are never stopped part-way, so a proposal is either written completely or not at all. A cancelled write finishes and its response is dropped. The audit log records it as `ok: true, cancelled: true` because the proposal was saved. A write is exempt from the 60-second timeout. It has a separate 10-minute write timeout (`HOLOSELF_MCP_WRITE_TIMEOUT_MS`), after which the client receives `-32001` `TOOL_TIMEOUT`. The write keeps running alone until it really finishes.
- At most 256 calls can be pending at once (`HOLOSELF_MCP_MAX_PENDING`, 1–65536). Calls beyond that return JSON-RPC error `-32000` (`Server busy`, `data.code` `SERVER_BUSY`). A request that reuses the id of a call that has not been answered yet returns `-32600`.
- Each worker's heap is limited to 512 MB (`HOLOSELF_MCP_WORKER_HEAP_MB`, 64–16384). A worker that runs out of memory is replaced, and its call returns a generic tool error.
- When the client closes STDIN, the server finishes the calls it already accepted, writes their responses, stops the workers, and exits. It waits at most the longer of the two timeouts. After that, calls still queued are dropped without a response and the remaining workers are stopped.
- `HOLOSELF_MCP_AUDIT_LOG` (absolute path, opt-in) records one line per `tools/list` and `tools/call` with the event, tool name, outcome, and error code (`CANCELLED`, `TOOL_TIMEOUT`, and `SERVER_BUSY` included). The server does not follow a symlink at that path, refuses a file with more than one hard link, sets the file to mode 0600, and stops appending at 10 MiB after writing one final `{"event":"audit_log_capped"}` line.

Recommended model flow:

1. Call `holoself_status` when link health is uncertain.
2. Call `holoself_context_manifest` only when personal context can materially improve the task.
3. Request the smallest useful source set with `holoself_context_get`.
4. Preserve source handles, hashes, restrictions, and the context receipt.
5. Use `holoself_proposal_create` only for durable reusable discoveries with project evidence; review and approval remain outside MCP.

## Fallback

If MCP is unavailable, use `.holoself/BOOTSTRAP.md`, the installed public skill, `holoself context`, or a reviewed snapshot. MCP failure never broadens access and does not invalidate the explicit link.

## Troubleshooting

- `LINK_REQUIRED`: link the project first or start from the correct project.
- `PROJECT_BINDING_AMBIGUOUS`: remove conflicting startup roots; do not guess.
- `missing-or-drifted`: rerun configuration preview and review the diff.
- Client shows pending approval: approve the project-scoped server in that client. This is client trust, not Holoself canonical-write approval.
- Headless or non-interactive runs refuse tool calls: allow the Holoself tools by name in that client. The exact per-client settings and the recorded results are in [platform verification](../reference/platform-verification.md#required-approval-settings).
- Tool call returns a bounded error: repair the link/index/metadata through the CLI; MCP deliberately exposes no repair tool.
