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

Tool calls run on a small pool of worker threads, so a slow context call never delays `ping`, `initialize`, `tools/list`, or other protocol messages. Responses are matched to requests by JSON-RPC id and can arrive in a different order from the requests. The CLI and MCP still use the same synchronous core.

- At most two tool calls run at once (`HOLOSELF_MCP_CONCURRENCY`, 1–8). Read-only tools may run in parallel. `holoself_proposal_create` writes project state, so it waits for running calls and runs alone.
- A repeated call with the same tool and arguments goes to the worker that served it before, so `context_receipt.cache.hit` behaves as it would in a single process.
- `notifications/cancelled` (`params.requestId`) removes a queued call or stops the worker running it. A cancelled call gets no response and never a partial packet. The next call starts on a fresh worker.
- Each call has a timeout of 60 seconds (`HOLOSELF_MCP_TOOL_TIMEOUT_MS`, 100–3600000). A call that runs past it returns JSON-RPC error `-32001` with `data.code` `TOOL_TIMEOUT`, and its worker is replaced.
- When the client closes STDIN, the server finishes the calls it already accepted, writes their responses, stops the workers, and exits.
- `HOLOSELF_MCP_AUDIT_LOG` (absolute path, opt-in) records one line per `tools/list` and `tools/call` with the event, tool name, outcome, and error code (`CANCELLED` and `TOOL_TIMEOUT` included). The server does not follow a symlink at that path, sets the file to mode 0600, and stops appending at 10 MiB after writing one final `{"event":"audit_log_capped"}` line.

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
