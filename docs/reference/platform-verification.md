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

## Session-start hook verification

Each platform entry in `platform-verification.json` can carry a `session_start_hook` record. `link activate` installs the Holoself session-start hook by default only when that record has `result: "pass"`, `hook_ran: true` and `marker_returned: true`; otherwise the hook needs `--hooks`. The record is written by hand from a synthetic-data run, not by `npm run smoke:mcp`.

| Platform | Host version | Date | Result | Notes |
|---|---:|---|---|---|
| Claude Code | 2.1.318 | 2026-11-04 | pass (Linux/WSL2; Windows unverified) | Hook in `.claude/settings.local.json` ran in `claude -p`; the reply contained the synthetic marker and the exact context receipt |
| Codex | 0.166.0 | — | unverified | `hooks` feature is stable; project `.codex/hooks.json` supports `SessionStart` (`--hooks`), and each hook runs only after the user trusts it (`trusted_hash` in `~/.codex/config.toml`) |
| AGY | 1.5.0 | — | unverified | The bundled `hooks.json` reference lists `SessionStart` in `<workspace>/.agents/hooks.json` (`--hooks`) with `--hook-format agy-json` (`injectSteps` output); workspace hooks load only for trusted folders |

Claude Code run:

1. A new temporary directory held a synthetic self root whose `profile/identity.md` contained a random marker, and a linked project initialised as a git repository. `HOLOSELF_HOME` pointed there and `HOME` was left alone.
2. `link add --project <project> --self <self> --lens general --hooks --yes` created `.claude/settings.local.json` with the Holoself entry.
3. A `holoself` wrapper first on `PATH` set `HOLOSELF_HOOK_AUDIT_LOG`.
4. `claude -p "<question>" --output-format json --model haiku --permission-mode dontAsk` ran in the project and asked for the marker and the context receipt. No tools were used.
5. The run added an `ok: true` audit line with a packet id and receipt. The reply was the marker and the receipt hash from the audit line. Files in the self root outside `.holoself/` were unchanged.

The recorded run used the installed command `holoself context --session-start --budget small --format packet --hook holoself-session-start`, which reads the project from `CLAUDE_PROJECT_DIR`. Earlier runs the same day with a shell-expanded `--project "$CLAUDE_PROJECT_DIR"` form also passed. Windows hosts were not tested.

Headless `claude -p` needed no trust prompt or extra setting for the project hook. Interactive sessions were not tested. The run showed that `.claude/settings.local.json` was ignored only through the user's global git ignore file (pattern `**/.claude/settings.local.json`), not by the repository.

Claude Code 2.1.318 persists hook output above 10,000 characters to a file and shows the model a preview (the hook output threshold is `1e4` in the bundled hook runner), so hook packets are capped at 9,000 bytes.

Sources: `claude --version`; Claude Code hooks documentation (`SessionStart` matchers `startup`, `resume`, `clear`, `compact`; command stdout is added to the session context); `codex --version`, `codex features list`, and the hook trust state format in `~/.codex/config.toml`; `agy --version`, `agy changelog`, and the `hooks.json` reference text bundled in the `agy` binary.

## Earlier evidence (2026-08-31)

Codex `0.146.1` and Claude Code `2.1.220` passed a `holoself_status`-only native call. AGY `1.1.22` discovered the server, but its headless call stopped at the MCP approval gate. The 2026-11-04 runs replace these records.

Automated repository evidence lives in `tests/mcp.test.mjs` and `tests/mcp-verification.test.mjs`. It covers protocol framing, stdout purity at the session boundary, schemas and annotations, CLI/MCP receipt parity, path redaction, bounded validation, the audit log carrying no content, project-local proposal creation, the preview-only canonical boundary, binding failures, collision-aware idempotent configuration, and support levels derived only from the matrix.

A full native verification covers process launch, seven-tool discovery (`holoself_status`, `holoself_context`, `holoself_context_manifest`, `holoself_context_get`, `holoself_search`, `holoself_proposal_create`, `holoself_proposal_preview`), the fixed project, every tool call, and an unchanged canonical self root. Do not claim verified discovery from generated files alone.
