# Common use cases

These workflows start from a validated self root and, where noted, a metadata-linked project. Replace the example paths with your own. Use `holoself` instead of `node bin/holoself.mjs` only when the CLI is installed and available on your PATH.

## Give an AI project relevant context

Use this when an assistant needs your preferences or background without receiving your entire self root.

```bash
node bin/holoself.mjs link add --project C:/work/project --self C:/private/my-self --lens general
node bin/holoself.mjs context --project C:/work/project --task "plan the next milestone" --json
```

Check `sources`, `restrictions`, `warnings`, and the receipt before relying on the result. The project receives a bounded view; it does not own or copy canonical self knowledge.

## Use Holoself visually

Use this when you want to browse knowledge, understand project health, or review changes without memorizing commands.

```bash
node bin/holoself.mjs web --root C:/private/my-self
```

In Workbench:

1. **Overview** shows readiness and next actions.
2. **Knowledge** lets you browse and safely edit annotated Markdown.
3. **Spaces** links or inspects independent projects.
4. **Review** previews pending knowledge changes before a decision.
5. **Setup** shows detected connectors and advanced configuration.

Workbench stays on `127.0.0.1`. Stop it with Ctrl+C. See the [first-run tour](../web-gui.md#first-run).

## Reuse a project discovery without silently changing memory

Use this when a project produced a durable fact, preference, decision, or story that should become reusable.

```bash
node bin/holoself.mjs propose --project C:/work/project --claim "..." --evidence "..." --source-file notes.md
node bin/holoself.mjs proposals show <id> --project C:/work/project
node bin/holoself.mjs proposals approve <id> --project C:/work/project --yes
node bin/holoself.mjs validate --data-dir C:/private/my-self
```

Approval displays the target, evidence, affected files, and exact proposed change. Reject or defer when the evidence or wording is not ready. AI-created proposals remain pending until a human decision.

## Find prior knowledge with provenance

Use project-bound search when you need a relevant passage and its source rather than a large context packet.

```bash
node bin/holoself.mjs index status --project C:/work/project
node bin/holoself.mjs search "regulated AI" --project C:/work/project --federated
```

Indexes are local and rebuildable. Search reapplies privacy and lens rules and returns provenance and freshness; the index is never the source of truth.

## Connect a supported AI client on demand

Advanced users can let a verified client start a project-bound local MCP subprocess. Link the project first, then preview every configuration change.

```bash
holoself mcp configure --project C:/work/project --dry-run
holoself mcp configure --project C:/work/project --yes
holoself mcp status --project C:/work/project
```

MCP does not run as a daemon and cannot approve proposals, alter links, or write canonical self knowledge. Use it only where the current platform/version has passed native verification. See [Local MCP integration](local-mcp.md).

## Share a reviewed snapshot with a restricted environment

Use a snapshot when the destination cannot access the live local root. A snapshot is generated, reviewable, and can become stale.

```bash
node bin/holoself.mjs context --project C:/work/project --task "review draft" --restricted-host --snapshot --expires-hours 24 --yes
```

Review the generated file before sharing it. Expiry metadata communicates intent but cannot remotely revoke a copied file.

## Diagnose a degraded linked project

```bash
node bin/holoself.mjs link status --project C:/work/project
node bin/holoself.mjs link doctor --project C:/work/project
node bin/holoself.mjs index status --project C:/work/project
```

Read the reported corrective action before changing anything. `link repair` and activation changes are explicit, reviewable mutations; a missing integration never broadens context access.

## Choose the right interface

| Need | Best starting interface |
|---|---|
| Browse, edit, review, or understand health | Workbench |
| Repeatable local operation or recovery | CLI |
| Typed, on-demand access from a verified AI client | Project-bound MCP |
| Portable, disconnected, or restricted-host handoff | Reviewed snapshot |
| Human-readable canonical knowledge | Markdown in the private self root |

All interfaces preserve the same model: project artifacts stay with the project, canonical self changes require review, and generated views are not authoritative.
