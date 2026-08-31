# Local MCP architecture decision

Status: accepted and implemented for validation. Default policy: **link-always authority; MCP-preferred interaction after platform verification**.

## Context and problem

Holoself links an independent project to canonical self through `.holoself/link.yaml`, then activates bounded instructions and an optional public skill. This is safe and portable, but a model must remember when and how to call the CLI. The Workbench can also launch a harness with eager context, which duplicates harness setup and sends context before the model proves it needs it.

MCP can make context discovery and retrieval typed and on demand. It must not become a second authority, policy engine, data store, or canonical write path.

## Decision

`holoself mcp` is a dependency-free local STDIO subprocess. The agent client starts one process for one linked project. There is no listener, daemon, account, network request, or standalone service.

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
