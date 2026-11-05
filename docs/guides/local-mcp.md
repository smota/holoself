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

### Every detected client at once

```text
holoself mcp configure --project C:/work/my-project --all-detected --dry-run
holoself mcp configure --project C:/work/my-project --all-detected --yes
```

A client is detected when its executable (`claude`, `codex`, `agy`) is on PATH or the project already has its configuration (`.claude/`, `.mcp.json`, `CLAUDE.md`; `.codex/`, `CODEX.md`; `.agents/mcp_config.json`, `.agy/`, `AGY.md`). The plan lists the detection result, every file, its action and the expected SHA-256, and the exact Holoself-owned entry (`server`, or `managed_block` for Codex). It never prints the rest of your configuration. Apply writes exactly that plan: it refuses if the files changed after the preview (`plan_sha256`), and if any write fails it restores every file already written. When nothing is detected, nothing is written.

An existing `holoself` server that differs from Holoself's is refused for every client in the plan, so nothing is written. To replace it, review it and pass `--force-replace` with `--yes` (or confirm in a terminal). Codex only replaces a plain `[mcp_servers.holoself]` table; other TOML spellings must be removed by hand.

### Default during link activation

`link setup`, `link add`, `link activate` and `link repair` configure MCP by default for each activated host whose MCP support is `verified` in [platform verification](../reference/platform-verification.md). Other hosts use `.holoself/BOOTSTRAP.md` and the CLI. `--mcp` / `--no-mcp` override this; the choice is recorded in `.holoself/runtime.json`. See [activated links](activated-links.md#mcp-servers).

### Read-tool pre-approval (opt-in)

Hosts ask before each MCP tool call in interactive sessions and refuse in headless runs. `--approve-read-tools` on `link setup|add|activate|repair` pre-approves only the read-only tools (`holoself_status`, `holoself_context`, `holoself_context_manifest`, `holoself_context_get`, `holoself_search`, `holoself_proposal_preview`). `holoself_proposal_create` is never pre-approved.

| Client | Where | What |
|---|---|---|
| Claude Code | `.claude/settings.local.json` (per machine) | `permissions.allow` entries `mcp__holoself__<tool>` |
| Codex | `.codex/config.toml` managed block | `[mcp_servers.holoself.tools.<tool>] approval_mode = "approve"` |
| AGY | not written | AGY 1.5.0 reads permissions only from `~/.gemini/antigravity-cli/settings.json` or per-session `--settings`; use `agy --settings '{"permissions":{"allow":["mcp(holoself/holoself_status)", ...]}}'` with the six read tools |

Holoself records which entries it added and removes only those; a rule you already had stays. Codex 0.166.0 already runs read-only tools without asking under the generated `default_tools_approval_mode = "writes"`; the per-tool entries make that explicit.

Codex and AGY absolute bindings are intentionally deterministic local configuration: each machine regenerates them for its own project path, so keep them per machine and do not commit them when a path identifies a private host or user. Claude's project file is path-portable. The server finds the linked self through the project's `link.yaml` and this machine's self map, never through a path in the MCP configuration; see [Use one self on several machines](multiple-machines.md). Existing divergent `holoself` entries and malformed managed markers are refused rather than overwritten.

The `holoself` executable must be on the client process PATH. Install `holoself-ai` from npm (for example `npm install --global holoself-ai`) or, from a source checkout, use a reviewed local or managed package-bin installation that points at that checkout. Confirm `holoself --version` in the client environment before applying configuration; running `node bin/holoself.mjs` in a terminal proves only that the checkout works. See [CLI invocation](../reference/cli.md#invocation).

## Runtime behavior

The client starts `holoself mcp` as a STDIO subprocess. STDOUT is JSON-RPC only. The process exits with the client session; no service remains running. The server rejects missing, unsafe, or ambiguous project bindings before serving context.

Tool calls run on a small pool of worker threads, so a slow context call never delays `ping`, `initialize`, `tools/list`, `prompts/list`, `prompts/get`, or other protocol messages. Responses may arrive out of order; clients must match each response to its request by JSON-RPC id. The CLI and MCP still use the same synchronous core.

- At most two tool calls run at once (`HOLOSELF_MCP_CONCURRENCY`, 1–8). Read-only tools may run in parallel. `holoself_proposal_create` writes project state, so it waits for running calls and runs alone.
- A repeated context call goes to the worker that served it before (the link's default lens is read once at startup for this), so `context_receipt.cache.hit` behaves as it would in a single process. Calls are compared after defaults are applied, so an omitted budget or lens matches the explicit default. After a worker is replaced (cancellation, timeout, or crash), its cache is gone and the next matching call reports `cache.hit: false`.
- `notifications/cancelled` (`params.requestId`) removes a queued call or stops the worker running it. A cancelled call gets no response and never a partial packet. A replacement worker starts only when the next call needs it.
- Each call has a timeout of 60 seconds (`HOLOSELF_MCP_TOOL_TIMEOUT_MS`, 100–3600000). The clock starts when the call is handed to a worker, including that worker's start-up. Time spent waiting in the queue does not count. A call that runs past it returns JSON-RPC error `-32001` with `data.code` `TOOL_TIMEOUT`, and its worker is replaced.
- Write tools (`holoself_proposal_create`) are never stopped part-way, so a proposal is either written completely or not at all. A cancelled write finishes and its response is dropped. The audit log records it as `ok: true, cancelled: true` because the proposal was saved. A write is exempt from the 60-second timeout. It has a separate 10-minute write timeout (`HOLOSELF_MCP_WRITE_TIMEOUT_MS`), after which the client receives `-32001` `TOOL_TIMEOUT`. The write keeps running alone until it really finishes.
- At most 256 calls can be pending at once (`HOLOSELF_MCP_MAX_PENDING`, 1–65536). Calls beyond that return JSON-RPC error `-32000` (`Server busy`, `data.code` `SERVER_BUSY`). A request that reuses the id of a call that has not been answered yet returns `-32600`.
- Each worker's heap is limited to 512 MB (`HOLOSELF_MCP_WORKER_HEAP_MB`, 64–16384). A worker that runs out of memory is replaced, and its call returns a generic tool error.
- When the client closes STDIN, the server finishes the calls it already accepted, writes their responses, stops the workers, and exits. It waits at most the longer of the two timeouts. After that, calls still queued are dropped without a response and the remaining workers are stopped.
- `HOLOSELF_MCP_AUDIT_LOG` (absolute path, opt-in) records one line per `tools/list`, `tools/call`, `prompts/list`, and `prompts/get` with the event, tool or prompt name, outcome, and error code (`CANCELLED`, `TOOL_TIMEOUT`, `SERVER_BUSY`, `PROMPT_NOT_FOUND`, and `INVALID_ARGUMENT` included; arguments are never recorded). The server does not follow a symlink at that path, refuses a file with more than one hard link, sets the file to mode 0600, and stops appending at 10 MiB after writing one final `{"event":"audit_log_capped"}` line.

Recommended model flow:

1. Call `holoself_status` when link health is uncertain.
2. Call `holoself_context_manifest` only when personal context can materially improve the task.
3. Request the smallest useful source set with `holoself_context_get`.
4. Preserve source handles, hashes, restrictions, and the context receipt.
5. Use `holoself_proposal_create` only for durable reusable discoveries with project evidence; review and approval remain outside MCP.
6. At the end of a session, request the `holoself_session_harvest` prompt (`prompts/get`, with optional `focus` ≤ 200 characters) or run `holoself instructions render --harvest --project <dir>` on the CLI to draft 0–3 evidence-backed pending proposals (preferring "propose nothing" when unsure, never inferring sensitive identity attributes or inventing facts, and reminding the owner to approve in the CLI or Workbench).

## Desktop clients without a project

Desktop and app-hosted MCP clients (Claude Desktop and similar) have no project directory, so they cannot use a project link. The owner gives each such app its own grant: an unlinked client identity bound to exactly one lens. It reads self content only, never project content, `private` or `restricted` material. See the [decision record](../decisions/unlinked-client-identity.md).

1. Create the grant from the self root. The command prints the new `client_id`:

   ```bash
   holoself client add --name claude-desktop-laptop --lens professional --root <self-root>
   ```

   The lens must exist, must not be `private`, and must not grant `restricted`. The lens and the proposal mode cannot be edited later: to change either, add a new client, reconfigure the host and revoke the old one.
2. Print the host configuration and add it to the app by hand:

   ```bash
   holoself mcp configure --client <client-id> --platform claude-desktop --root <self-root>
   ```

   The snippet uses an absolute command path and the arguments `mcp --client <client-id> --root <self-root>`, because GUI apps do not inherit the shell `PATH`. `--platform generic` prints only the command and arguments for any STDIO host. Printing writes nothing.
3. Optional: `holoself mcp configure --client <client-id> --platform claude-desktop --apply --root <self-root>` writes the entry into the host's user-level file (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows). It is refused with `MCP_PLATFORM_NOT_VERIFIED` until the platform has a native verification record in [platform verification](../reference/platform-verification.md); today Claude Desktop is print-only. When allowed, it previews the path, current SHA-256, action and entry, requires `--yes` or terminal confirmation, refuses a different existing `holoself` entry (unless `--force-replace` with confirmation), never rewrites unparseable JSON, refuses symlinks and hard links, backs up the original next to it (mode `0600` when the original is group- or world-readable), keeps the file mode and restores the original if the write fails. `--remove` deletes only the Holoself entry.

At runtime:

- `holoself mcp --client <client-id> --root <self-root>` refuses `--project`, `--claude-project-dir` and a non-empty `CLAUDE_PROJECT_DIR` (`CLIENT_BINDING_CONFLICT`). It never discovers a link from the working directory. Without `--root` it uses `HOLOSELF_HOME` or `~/.holoself`.
- Every tool call re-reads `.holoself/clients.json` and the lens definition. A revoked client fails with `CLIENT_REVOKED`, a removed one with `CLIENT_UNKNOWN`, and a lens that became missing, private or invalid with `CLIENT_LENS_INVALID`, without restarting the app. Tool arguments never select an identity, root or lens: any lens other than the bound one returns `LENS_NOT_GRANTED`.
- `holoself_status` reports `identity: client:unlinked`, the client name, its lens and its proposal mode, never the self path.
- Context calls use the same core, budgets, envelope caps, source handles and receipts as linked MCP. Successful context calls append served-context ledger entries to `<self>/.holoself/ledger.ndjson` with `surface: mcp` and `client_id`; read them with `holoself ledger --root <self-root> --client <client-id>`.
- Proposals are off by default: `holoself_proposal_create` and `holoself_proposal_preview` are not listed and calls fail with `CLIENT_PROPOSALS_DISABLED`. A client created with `--proposals inbox` may append one claim to an existing document its lens can read, with required evidence (1–4,000 characters, secret-like text rejected). Pending proposals go to `<self>/proposals/inbox/` with provenance `client:<client-id>`, at most 50 per client (`CLIENT_INBOX_FULL`). Any other target fails with the same `PROPOSAL_TARGET_INVALID` error. Only the owner reviews them: `holoself proposals list --inbox --root <self-root>`, then `holoself proposals approve <id> --inbox --root <self-root>` (or reject). There is no MCP approval tool.
- Manage grants with `holoself client list --root <self-root>`, `holoself client revoke <client-id> --root <self-root>` and `holoself client remove <client-id> --root <self-root>` (remove refuses an active client). A revoked host keeps a failing server entry until you remove it; `holoself mcp status --client <client-id> --root <self-root>` shows whether the host file still carries it.

The client ID is not a secret. Any process running as the same OS user can launch with any ID or read the self root directly. The boundary is least privilege per host: one owner-chosen lens per app, each grant auditable and revocable.

## Fallback

If MCP is unavailable, use `.holoself/BOOTSTRAP.md`, the installed public skill, `holoself context`, or a reviewed snapshot. MCP failure never broadens access and does not invalidate the explicit link.

## Troubleshooting

- `LINK_REQUIRED`: link the project first or start from the correct project.
- `PROJECT_BINDING_AMBIGUOUS`: remove conflicting startup roots; do not guess.
- `CLIENT_BINDING_CONFLICT`, `CLIENT_UNKNOWN`, `CLIENT_REVOKED`, `CLIENT_LENS_INVALID`: check the desktop client grant with `holoself client list --root <self-root>`.
- `missing-or-drifted`: rerun configuration preview and review the diff.
- `mcp status` also reports `client_state` per client: `not-detected`, `detected` (not configured), `configured`, `verified` (configured and natively verified), or `failing` (divergent or drifted entry, unreadable file, or broken link). The Workbench Setup view shows the same states.
- Client shows pending approval: approve the project-scoped server in that client. This is client trust, not Holoself canonical-write approval.
- Headless or non-interactive runs refuse tool calls: allow the Holoself tools by name in that client. The exact per-client settings and the recorded results are in [platform verification](../reference/platform-verification.md#required-approval-settings).
- Tool call returns a bounded error: repair the link/index/metadata through the CLI; MCP deliberately exposes no repair tool.
