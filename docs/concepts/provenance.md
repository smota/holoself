# Provenance

Every context result lists source files. Search results include source, section, passage, provenance, visibility, and freshness. Approved proposals append source project, source files, evidence, and approval timestamp.

Provenance supports:

- verification before reusing a claim;
- conflict and staleness analysis;
- accountable proposal review;
- regeneration of derived views;
- correction without searching hidden memory.

Generated views should record source paths, timestamp, lens, visibility policy, and content hash. Missing provenance is a validation error for proposals.

Every served context packet also records a local metadata receipt in `<project>/.holoself/ledger.ndjson` (or `<self>/.holoself/ledger.ndjson` for owner-direct queries) with `served_at`, `surface`, `host`, `lens`, `budget`, `need`, `task_sha256`, `context_hash`, `packet_id`, delivered `source_ids`, counts, and `total_bytes`—never document bodies, snippets, or filesystem paths. See [Served-context ledger](../guides/served-context-ledger.md) and inspect entries with `holoself ledger --project <dir>`.
