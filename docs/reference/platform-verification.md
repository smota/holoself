# MCP platform verification

MCP becomes preferred only for a tested product/version. `configured` means the project file is structurally present; it does not prove discovery or invocation.

The machine-readable record is [`platform-verification.json`](platform-verification.json). `holoself capabilities --json` (`mcp.platforms`) and `holoself mcp status` report a platform as `verified`, with `tested_version` and `last_verified`, only when that record shows server discovery, a passing call for every tool, an unchanged canonical self root, and a pending project-local proposal. A platform with any failed, blocked, or missing tool stays `configured` with null version and date. File-instruction adapters (`AGENTS.md`, `CLAUDE.md`, and so on) are not affected by this record.

## Results recorded 2026-11-04

Synthetic data only. Each run used a fresh temporary self root and linked project; temporary paths are not recorded.

| Platform | Host version | Discovery | status | context | manifest | get | search | proposal create | proposal preview | No canonical write | Support |
|---|---:|---|---|---|---|---|---|---|---|---|---|
| Claude Code | 2.1.318 | verified | pass | pass | pass | pass | pass | pass | pass | yes | verified |
| Codex | 0.166.0 | verified | pass | pass | pass | pass | pass | pass | pass | yes | verified |
| AGY | 1.5.0 | verified | pass | pass | pass | pass | pass | pass | pass | yes | verified |

These results come from headless runs with the tool-scoped approval settings below. Interactive sessions reach the same tools after the user approves them in the client.

## Required approval settings

Headless runs with each host's default settings, recorded the same day, show which approvals a user must grant. Holoself does not grant these itself, and none of the runs used a host's dangerous permission bypass.

| Platform | Without the setting (headless) | Tool-scoped setting used for verification |
|---|---|---|
| Claude Code | Server discovered (seven tools listed); every call refused: "permission denied (don't ask mode)". | `--allowedTools mcp__holoself__holoself_status,mcp__holoself__holoself_context,mcp__holoself__holoself_context_manifest,mcp__holoself__holoself_context_get,mcp__holoself__holoself_search,mcp__holoself__holoself_proposal_create,mcp__holoself__holoself_proposal_preview` (or the same entries in `permissions.allow`) |
| Codex | Read tools pass with the generated configuration. `holoself_proposal_create` refused: "Approval required but approval policy is never", because the generated `default_tools_approval_mode = "writes"` asks before write tools. Preview then had no proposal to read. | `mcp_servers.holoself.default_tools_approval_mode = "approve"` for the session (`-c`). Interactive Codex asks once for the write tool instead. |
| AGY | Server discovered (seven tools listed); every call refused: `denied_actions: mcp:CallMcpTool`. | `permissions.allow` entries `mcp(holoself/holoself_status)`, `mcp(holoself/holoself_context)`, `mcp(holoself/holoself_context_manifest)`, `mcp(holoself/holoself_context_get)`, `mcp(holoself/holoself_search)`, `mcp(holoself/holoself_proposal_create)`, `mcp(holoself/holoself_proposal_preview)`, passed for the session with `--settings`. |

`holoself_proposal_create` writes only a pending proposal inside the project. Approving it in a client does not approve any change to the canonical self; that still needs `holoself proposals approve <id> --project <dir>` after human review outside MCP.

## How a run is judged

`npm run smoke:mcp` (script: `scripts/mcp-smoke.mjs`) needs the host CLIs installed and signed in, so it is not part of `npm run verify` or CI. For each host it:

1. Creates a synthetic self root and linked project in a new temporary directory, sets `HOLOSELF_HOME` there, leaves `HOME` alone so the host keeps its own sign-in, and runs `holoself mcp configure --platform <host>`.
2. Puts a `holoself` wrapper first on the host's `PATH` that sets `HOLOSELF_MCP_AUDIT_LOG`. The server appends one line per `tools/list` and `tools/call`: event, tool name, ok, error code. It records no arguments, results, or paths.
3. Hashes every file in the canonical self root before and after the run.
4. Runs the host headlessly in the project (`claude -p --mcp-config .mcp.json --strict-mcp-config --permission-mode dontAsk`, `codex exec -C <project> --sandbox read-only --ephemeral`, `agy -p --new-project`) with a five-minute timeout. The prompt asks the host to call all seven tools in order and print a JSON summary.
5. Marks a tool `pass` only when the server's audit log shows a successful call. `fail` means the server returned an error, and `blocked` means the host refused the call. `not-run` means no call was seen. The host's own summary is kept for diagnosis but never used to mark a pass.
6. Checks that the project has the pending proposal file the run created.

Codex loads project configuration only for trusted projects, so the script trusts the temporary project for that session only (`-c projects=...`). For AGY, the script uses `--new-project` so that workspace MCP configuration is active.

Options: `--platform claude|codex|agy` (repeatable), `--approval scoped|host-default`, `--timeout-ms`, `--keep` (keep the temporary directory and host output), and `--write-matrix` (update `platform-verification.json`). The temporary directory is removed even when a run fails, unless `--keep` is set. Paths are shell-quoted in the wrapper and escaped as TOML strings in the Codex trust override. Absolute paths in host-reported reasons are replaced with `<local-path>` before they are written to the matrix. A `host-default` run is recorded under `host_default`. It never replaces the scoped verification record.

## Fixes made during the 2026-11-04 verification

- Generated Codex configuration left `holoself_context` out of `enabled_tools`, so Codex could not call it. This was found by reading the configuration before the runs. Generated Codex configuration now enables all seven tools.
- In an AGY run, `holoself_context_get` failed with `INVALID_ARGUMENT` because the model used a guessed handle. The text summary from the context tools did not list source handles, and AGY's model apparently sees only text content. The summary now lists `path [source_id]` for each document. The recorded AGY run used the fixed summary.

## Earlier evidence (2026-08-31)

Codex `0.146.1` and Claude Code `2.1.220` passed a `holoself_status`-only native call. AGY `1.1.22` discovered the server, but its headless call stopped at the MCP approval gate. The 2026-11-04 runs replace these records.

Automated repository evidence lives in `tests/mcp.test.mjs` and `tests/mcp-verification.test.mjs`. It covers protocol framing, stdout purity at the session boundary, schemas and annotations, CLI/MCP receipt parity, path redaction, bounded validation, the audit log carrying no content, project-local proposal creation, the preview-only canonical boundary, binding failures, collision-aware idempotent configuration, and support levels derived only from the matrix.

A full native verification covers process launch, seven-tool discovery (`holoself_status`, `holoself_context`, `holoself_context_manifest`, `holoself_context_get`, `holoself_search`, `holoself_proposal_create`, `holoself_proposal_preview`), the fixed project, every tool call, and an unchanged canonical self root. Do not claim verified discovery from generated files alone.
