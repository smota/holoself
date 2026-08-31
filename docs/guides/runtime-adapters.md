# Startup adapters and packet formatters

Holoself has three separate integration surfaces.

## Local MCP adapter

For Codex, AGY, and Claude Code, `holoself mcp` is a third surface: the client launches a project-bound STDIO subprocess and discovers six typed tools. It shares the CLI domain core and keeps `.holoself/link.yaml` as authority. Configuration records are not verification; promote a platform only after the native evidence in [platform verification](../reference/platform-verification.md) passes. BOOTSTRAP and skill activation remain the fallback.

## Startup adapters

Startup adapters create bounded pointers in project instruction files so a host can discover `.holoself/BOOTSTRAP.md`. Generation proves only that Holoself wrote a valid file. It does not prove a product loaded or obeyed it.

Each activation capability record uses:

- `delivery`: `file`, `skill`, `manual-project-config`, or `snapshot`
- `discovery`: `verified`, `configured`, `generated-only`, or `unsupported`
- `tested_product` and `tested_version`
- `evidence` and `last_verified`

Null `tested_version` or `last_verified` means no bundled, versioned application smoke test exists. `support` remains a compatibility summary and no longer claims blanket native support.

Activation plans and `.holoself/runtime.json` expose these fields. Product support should move to `verified` only after an application-level test records version, instruction discovery, lens resolution, disclosure behavior, and evidence.

## Packet formatters

Packet formatter names change delivery framing only. They are not startup adapters and do not assert product discovery.

```bash
node bin/holoself.mjs context --project C:/work/project --json
node bin/holoself.mjs context --project C:/work/project --lens publishing --json
node bin/holoself.mjs context --project C:/work/project --format packet --adapter pi
node bin/holoself.mjs context --project C:/work/project --format packet --adapter claude
node bin/holoself.mjs context --project C:/work/project --format packet --adapter codex
node bin/holoself.mjs context --project C:/work/project --format packet --adapter generic
node bin/holoself.mjs context --project C:/work/project --format packet --adapter obsidian
node bin/holoself.mjs context --project C:/work/project --snapshot --restricted-host --expires-hours 24 --yes
```

Packet schema v2 JSON contains `self`, the compatibility `lens` string, normalized `lens_resolution`, `project`, `packet_metadata`, `sources`, `restrictions`, `warnings`, `validation`, and `proposals`. Packet metadata includes a deterministic lens-registry hash; raw private definition files and registry paths are not exposed. Source metadata includes access lenses, disclosure, sensitivity, document role, publication eligibility, freshness, and SHA-256 source hash.

Restricted-host snapshots default to 24-hour expiry metadata and can set more than 0 and at most 720 hours with `--expires-hours`. Packet metadata includes unique packet id, generation/expiry timestamps, host mode, and filtered-source hashes. Consumers must reject expired packets and refresh after source changes; hashes support comparison but do not make snapshots live.

Claude Desktop/Cowork, ChatGPT/Cowork, and other sandboxed clients normally need manual project configuration or a reviewed snapshot. `--restricted-host` is product-owned safe packet generation, not proof that any external product discovers or enforces packet metadata. A formatter label does not create automatic application integration.
