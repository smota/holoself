# Runtime adapters

Machine-readable context:

```bash
node bin/holoself.mjs context --project C:/work/project --json
node bin/holoself.mjs context --project C:/work/project --lens publishing --json
```

Packet adapters:

```bash
node bin/holoself.mjs context --project C:/work/project --format packet --adapter pi
node bin/holoself.mjs context --project C:/work/project --format packet --adapter claude
node bin/holoself.mjs context --project C:/work/project --format packet --adapter codex
node bin/holoself.mjs context --project C:/work/project --format packet --adapter generic
node bin/holoself.mjs context --project C:/work/project --format packet --adapter obsidian
```

JSON contains `self`, `lens`, `project`, `sources`, `restrictions`, `warnings`, and `proposals`. Adapters change delivery framing, not privacy rules or source ownership.
