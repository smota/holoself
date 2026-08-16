# Startup adapters and packet formatters

Holoself has two separate integration surfaces.

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
```

JSON contains `self`, `lens`, `project`, `sources`, `restrictions`, `warnings`, and `proposals`. Source metadata includes access lenses, disclosure, sensitivity, document role, and publication eligibility.

Claude Desktop/Cowork, ChatGPT/Cowork, and other sandboxed clients normally need manual project configuration or a reviewed snapshot. A formatter label does not create automatic application integration.
