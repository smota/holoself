# Served-Context Ledger

The served-context ledger records a local, append-only metadata log of every context packet delivered to an AI tool (`<project>/.holoself/ledger.ndjson` for linked projects, or `<self>/.holoself/ledger.ndjson` for owner-direct queries).

## Privacy and content boundary

The ledger answers **"what each AI saw"** without creating a second copy of your personal knowledge:

- **Metadata and source handles only**: each line records the timestamp, surface (`cli`, `mcp`, `hook`, `workbench`), host (`claude`, `codex`, `agy`, or the MCP `clientInfo.name` from `initialize`), lens, budget, context need, `context_hash`, `packet_id`, delivered `source_ids` (`hs-...` handles only), counts (`documents_delivered`, `restricted`, `envelope_dropped`), and `total_bytes`.
- **Never document bodies or paths**: the ledger never contains Markdown bodies, excerpts, headings, snippets, absolute paths, relative file paths, or restricted-source identifiers.
- **Task hashed by default**: the task string is stored only as `task_sha256` (`sha256` hex digest, or `null` when no task was supplied). Plain-text `task` is omitted unless explicitly opted in with `ledger.record_task_text: true`.
- **Local only**: the ledger lives inside `.holoself/` and is never transmitted over the network.

## Entry schema

Each NDJSON line is a JSON object with `schema_version: 1`:

```json
{
  "schema_version": 1,
  "served_at": "2026-10-04T12:00:00.000Z",
  "surface": "mcp",
  "host": "claude-code",
  "lens": "professional",
  "budget": "standard",
  "need": "required",
  "task_sha256": "3f79bb7b435b05321651daefd374cdc681dc06faa65e374e38337b88ca046dea",
  "context_hash": "8a5e...",
  "packet_id": "550e8400-e29b-41d4-a716-446655440000",
  "source_ids": ["hs-0123456789abcdef0123"],
  "counts": {
    "documents_delivered": 2,
    "restricted": 1,
    "envelope_dropped": 0
  },
  "total_bytes": 1842
}
```

## Surfaces recorded

Exactly one entry is written per served packet:

1. **CLI** (`surface: "cli"`): `holoself context --project <dir>` and owner-direct `holoself context --root <self-root>`.
2. **MCP** (`surface: "mcp"`): `holoself_context`, `holoself_context_manifest`, and `holoself_context_get` calls that succeed, written from the main MCP server thread after the worker returns. Cancelled, timed-out, or failed calls are not written.
3. **SessionStart hook** (`surface: "hook"`): `holoself context --session-start --budget small --format packet --hook holoself-session-start`.
4. **Workbench** (`surface: "workbench"`): context packets resolved for Workbench conversation turns.

Internal health checks (`holoself link doctor`, `holoself_status`) validate resolution without serving a packet and do not write ledger entries.

## Inspecting the ledger

List entries from the CLI:

```bash
holoself ledger --project <dir>
holoself ledger --project <dir> --surface mcp --lens professional --limit 20
holoself ledger --project <dir> --since 2026-10-01 --json
holoself ledger --root <self-root> --json
```

In the local [Workbench](../web-gui.md), open **Served context** (or query the token-protected `GET /api/ledger?space=<id>&limit=100` endpoint) to filter entries by space, lens, and surface.

## Configuration and rotation

Ledger recording is enabled by default. You can disable it or opt in to plain-text task recording in `.holoself/link.yaml` (or in `<self-root>/config.json` for owner-direct queries):

```yaml
self_context:
  path: "C:/private/my-self"
  access: "read"
  proposals: "enabled"
  index: "local"
ledger:
  enabled: true
  record_task_text: false
```

- **Hardened file safety**: writes use `O_NOFOLLOW`, verify a single-linked regular file (`nlink === 1`), set mode `0600`, and refuse symlinks at `.holoself/` or any ledger file slot.
- **Rotation**: when `ledger.ndjson` reaches 5 MiB, it rotates to `ledger.1.ndjson` (keeping up to `ledger.3.ndjson`).
- **Fail-open for packets**: a ledger write failure never blocks or alters a served packet; it emits a single path-scrubbed warning on CLI stderr or a `ledger/write` entry in the MCP/hook audit log.
