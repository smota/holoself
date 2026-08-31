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

The `holoself` executable must be on the client process PATH. From a source checkout, a managed runtime installation may point the command at that checkout; otherwise install the released package before configuration.

## Runtime behavior

The client starts `holoself mcp` as a STDIO subprocess. STDOUT is JSON-RPC only. The process exits with the client session; no service remains running. The server rejects missing, unsafe, or ambiguous project bindings before serving context.

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
- Tool call returns a bounded error: repair the link/index/metadata through the CLI; MCP deliberately exposes no repair tool.
