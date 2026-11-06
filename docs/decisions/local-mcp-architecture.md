# Local MCP architecture decision

Status: accepted and implemented for validation. Default policy: **link-always authority; MCP-preferred interaction after platform verification**.

## Context and problem

Holoself links an independent project to canonical self through `.holoself/link.yaml`, then activates bounded instructions and an optional public skill. This is safe and portable, but a model must remember when and how to call the CLI. The Workbench can also launch a harness with eager context, which duplicates harness setup and sends context before the model proves it needs it.

MCP can make context discovery and retrieval typed and on demand. It must not become a second authority, policy engine, data store, or canonical write path.

## Decision

`holoself mcp` is a dependency-free local STDIO subprocess. The agent client starts one process for one linked project. There is no listener, daemon, account, or standalone service. Optional [operation telemetry](../guides/telemetry.md) uses loopback HTTP only and stays off without a valid local consumer configuration.

The server binds its project once at startup from explicit `--project`, Claude Code's trusted `CLAUDE_PROJECT_DIR`, or an unambiguous current directory. Every tool is path-free. A safe `.holoself/link.yaml` is mandatory and is revalidated by the shared domain functions.

MCP and the CLI call the same deterministic context, index, lens, lifecycle, privacy, and proposal functions. MCP exposes only bounded context/search and project-local pending proposals. It cannot create or modify links, approve proposals, apply cleanup, install skills, publish, or write canonical self.

## Coexistence and defaults

- The metadata link is always the authorization/control-plane default.
- MCP is the preferred interaction path on a platform/version with a passing native smoke test.
- BOOTSTRAP, the public skill, CLI, and reviewed snapshot remain the deterministic fallback.
- Workbench subprocess launching remains a separate explicit compatibility workflow.

This improves the ordinary user experience through discovery, typed arguments, smaller on-demand context, and structured receipts. It adds one-time client configuration and platform-specific approval UX; tool discovery still cannot guarantee a model calls Holoself at the right time.

## Rejected alternatives

- HTTP or a persistent local service: unnecessary lifecycle, port, and exposure complexity.
- MCP as link replacement: weakens explicit project authorization.
- Raw canonical resources: broadens disclosure beyond task-bounded tools.
- Model-callable approval/canonical writes: violates review-before-save.
- CLI subprocess parsing: creates drift between interfaces.

## Sign-off

Codex, AGY, and Claude architect/harness reviews approved this direction with conditions: retain explicit link authority, reuse the deterministic core, keep STDIO local, prevent canonical writes, preserve fallbacks, and promote MCP per platform only after versioned native validation. Implementation evidence is tracked in [platform verification](../reference/platform-verification.md).

Post-implementation review on 2026-08-31:

- Codex AI architect: approved; no remaining architecture blocker.
- Codex harness specialist: approved for merge and continued validation; link/skill/CLI stays default until the full native matrix passes.
- Claude Code AI architect: approved after cross-platform path redaction and fail-closed diagnostics were regression-tested.
- Claude Code harness specialist: approved after direct subprocess purity, required `CLAUDE_PROJECT_DIR`, no-write reads, symlink/collision handling, and both rollback branches were tested.
- AGY architect and harness design sign-offs remain approved with the same conditions. AGY 1.1.22 discovered all six tools from a registered isolated synthetic project; its headless status call then stopped at the normal MCP approval boundary. No dangerous bypass was used, and native invocation promotion remains pending an interactive approval or separately reviewed tool-scoped allow rule.

## Subsequent updates

- 2026-11-04: `holoself mcp` now exposes seven tools via `tools/list` (`holoself_status`, `holoself_context`, `holoself_context_manifest`, `holoself_context_get`, `holoself_search`, `holoself_proposal_create`, and `holoself_proposal_preview`). The 2026-08-31 sign-off above records the six tools present at the time of initial MCP validation.
- 2026-11-04: the STDIO server runs tool calls on a bounded worker-thread pool (default two workers) instead of on its main thread (#62). The core stays synchronous and shared with the CLI. Each worker imports the same modules, so there is still one implementation. The main thread is the only writer to stdout and the audit log. Locking: catalog files are written with a unique temporary file and an atomic rename, so parallel readers see either the old or the new complete file. Two workers that rebuild the same stale catalog both write equivalent content, and the last rename wins. Read-only tools can therefore run in parallel. `holoself_proposal_create`, the only tool that writes project state, runs alone. It is never terminated: a cancelled write finishes, its response is dropped, and the audit log records that the write happened. It is exempt from the read timeout. Past a separate 10-minute write timeout, the client gets `TOOL_TIMEOUT`, but the write keeps its exclusive slot until it finishes. When the client closes STDIN, the server waits at most that long before stopping its workers. This keeps a proposal from existing on disk while the client sees no response and retries. A read-only call stopped by cancellation or timeout can leave a `*.tmp-*` file next to a catalog it was rebuilding. It never leaves a partly written catalog. Pending calls are capped (256 by default), and each worker's heap is capped (512 MB by default).
- 2026-11-04: default rule for link activation (#64). `link setup`, `link add`, `link activate` and `link repair` configure the project-local MCP entry by default for every activated host whose MCP support is `verified` in `docs/reference/platform-verification.json` (today Claude Code, Codex and AGY). A host is activated when it is detected for this project (its directory or instruction file exists) or selected with `--platform`/`--activate`. Every other host keeps BOOTSTRAP + CLI as before. `--mcp` configures every activated MCP-capable host, `--no-mcp` none. The choice (`mcpPolicy`) and each installation (`mcpInstallations`, with created-file and created-container bookkeeping) are recorded in `.holoself/runtime.json`: `link repair` restores them and `link deactivate` removes only the recorded Holoself entries, keeping foreign servers and settings. The default never overrides a divergent `holoself` entry; it skips that host and reports it. Only `holoself mcp configure --force-replace` with explicit confirmation replaces one. `holoself mcp configure --all-detected` configures every detected client (executable on PATH or project configuration) in one all-or-nothing transaction whose dry-run plan hash must match at apply. Read-tool pre-approval is never the default: `--approve-read-tools` writes allow entries only for the six read-only tools and never for `holoself_proposal_create` (Claude Code: `.claude/settings.local.json` `permissions.allow`; Codex: per-tool `approval_mode = "approve"` inside the managed block; AGY: documented only, because AGY 1.5.0 reads permissions from user-global settings or per-session `--settings`).
- 2026-11-04: accepted design for MCP clients without a project (#66): an owner-attested `client:unlinked` identity in `<self>/.holoself/clients.json`, selected by `mcp --client <id>` at launch, self-only with one non-`private` lens, attested on every call, proposals off by default. See [unlinked client identity](unlinked-client-identity.md). Not yet implemented.
