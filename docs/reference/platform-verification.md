# MCP platform verification

MCP becomes preferred only for a tested product/version. `configured` means the project file is structurally present; it does not prove discovery or invocation.

| Platform | Tested version | Config | Startup/root evidence | Discovery | Read invocation | Proposal boundary | Fallback | Status |
|---|---:|---|---|---|---|---|---|---|
| Codex | 0.146.1 | `.codex/config.toml` | explicit fixed synthetic project | six-tool schema accepted; allowlisted status discovered | `holoself_status` returned correct project/link/lens/context | automated core test passes | BOOTSTRAP/skill/CLI | native status verified; full promotion pending |
| AGY | 1.1.22 | `.agents/mcp_config.json` | registered synthetic project with fixed absolute project argument | six tools discovered natively | headless call reached normal MCP approval gate; not bypassed | automated core test passes | BOOTSTRAP/skill/CLI | native discovery verified; invocation approval-gated |
| Claude Code | 2.1.220 | `.mcp.json` | client supplied synthetic `CLAUDE_PROJECT_DIR` | explicit config discovered | `holoself_status` returned correct project/link/lens/context | automated core test passes | BOOTSTRAP/skill/CLI | native status verified; full promotion pending |

Required native evidence for each row: process launch, six-tool discovery, correct fixed project, status call, manifest/source retrieval, no absolute private root in output, malformed/missing-link failure, and continued instruction/CLI fallback. Record exact command, product version, date, result, and any approval interaction. Do not claim verified discovery from generated files alone.

## Native evidence recorded 2026-08-31

Synthetic data only; local fixture path is redacted from this public record.

- Codex `0.146.1`: `codex exec --ephemeral --skip-git-repo-check --ignore-user-config --strict-config --sandbox read-only -C <synthetic-project> -c "mcp_servers.holoself.command='holoself'" -c "mcp_servers.holoself.args=['mcp','--project','<synthetic-project>']" -c "mcp_servers.holoself.required=true" -c "mcp_servers.holoself.enabled_tools=['holoself_status']" -c "mcp_servers.holoself.default_tools_approval_mode='writes'" --json <status-prompt>`. Result: native `mcp_tool_call` completed; returned the synthetic project name, `.holoself/link.yaml`, `career`, and `valid`. No approval interaction for the read-only tool.
- Claude Code `2.1.220`: `claude --mcp-config .mcp.json --strict-mcp-config --no-session-persistence --permission-mode dontAsk --allowedTools mcp__holoself__holoself_status --output-format json -p <status-prompt>`. Result: success; returned the same project/link/lens/context tuple. Project-file listing separately showed pending approval, while the explicit ephemeral config ran without persisting approval.
- AGY `1.1.22`: an unregistered temporary folder did not activate workspace MCP configuration. After registering an isolated public synthetic clone with `--new-project`, AGY discovered the Holoself server and attempted `holoself_status`. The non-interactive run then denied the call because MCP tools require approval unless a scoped allow rule is present. No dangerous permission bypass was used. Invocation remains pending an interactive approval or a separately reviewed, tool-scoped allow rule.

The Codex and Claude status calls prove startup/discovery/invocation only; AGY currently proves startup and discovery. This evidence deliberately does not promote MCP to the cross-platform default until the remaining matrix checks are captured.

Automated repository evidence lives in `tests/mcp.test.mjs`: protocol framing, stdout purity at the session boundary, schemas/annotations, CLI/MCP receipt parity, path redaction, bounded validation, project-local proposal creation, preview-only canonical boundary, binding failures, and collision-aware idempotent configuration.
