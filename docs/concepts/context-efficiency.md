# Context efficiency and receipts

Holoself resolves context progressively. A request is classified as `required`, `helpful`, or `not-needed`. Bilingual (English and Portuguese) keyword scoring weighs personal and domain nouns against mechanical verbs (`tie → helpful`), so architectural or editorial tasks that contain words like `format`, `fix`, or `testing` stay `helpful` or `required`. When the default classifier returns `not-needed`, Holoself avoids broad personal context while still keeping `document_role: policy` documents, the lens's `session_start_sources`, and any self records whose tokens overlap the task. Callers can override classification on any request with `--need required|helpful|not-needed` (CLI) or `need` (MCP `holoself_context` and `holoself_context_manifest`); an explicit `--need not-needed` (or `need: "not-needed"`) strictly omits all self records. When context is useful, the resolver applies privacy and lifecycle rules before relevance and budget selection.

The default `standard` budget is bounded. `small` and `deep` support lighter or richer work; `unbounded` is an explicit diagnostic mode. `--manifest` returns opaque stable source handles without bodies, and repeatable `--source <handle>` expands reviewed sources. At most two selected public contrib methods are injected for a task. `config.json.selectedContribs` controls availability, not automatic loading.

Every result includes a context receipt: task hash, lens, temporal selector, budget, resolved `need` (`required`, `helpful`, `not-needed`), `need_reason` (`explicit`, `matched:personal:<pattern-id>`, `matched:mechanical:<pattern-id>`, or `default`), selected source handles and hashes, estimated tokens, truncation, and in-memory selection cache status (`persistent: false`). When the optional FTS5 engine ranked the packet, the receipt also carries `engine: "fts5"`; without it the ranking was the deterministic JSON engine. Selection telemetry also carries `need`, `need_reason`, and a content-redacted contradiction digest: explicit supersession edges and source-handle pairs with potentially conflicting metrics under shared headings. Source hashes make refresh incremental and receipts auditable without copying private body text.

```powershell
holoself context --project . --task "prepare the leadership interview" --budget small --manifest --json
holoself context --project . --task "prepare the leadership interview" --budget deep --source hs-... --json
holoself context --project . --task "format this JSON" --need not-needed --budget small --json
```

## Ranking

Relevance ranks candidates that already passed privacy and lifecycle rules. The JSON engine scores token overlap with the path (6 per token), headings (3) and catalog text (2), plus small boosts for policy and core profile documents. When the FTS5 engine is available, a BM25 score over the same candidates' filtered section snippets adds up to 4 points, scaled to the best-scoring candidate, so stemmed and diacritic-folded matches (`guaranteeing`/`guarantees`, `compensacao`/`compensação`) can lift a document into a small budget. Ordering is deterministic: score, then source id. See [Indexing and search](../guides/indexing-and-search.md#optional-fts5-engine).

## Packet size

Budgets bound the delivered content (`small` 8,000 characters, `standard` 24,000, `deep` 64,000). The whole emitted packet is also capped at twice that, measured in bytes on the surface that sends it: 16 KiB, 48 KiB and 128 KiB, or the full tool result for MCP. This applies with or without `--manifest`. When a packet would exceed the cap, the lowest-ranked sources are dropped, listed in `selection.envelope_dropped`, and recorded in `restrictions`; fetch them with `--source` if needed. `selection.total_bytes` is the exact size of the emitted packet, `estimated_tokens_total` is `total_bytes / 4`, and `envelope_cap_bytes` is the cap (`null` for `unbounded`).

Each document body appears once, in its `documents` array. When bodies are delivered, `sources[]` is a provenance index: id, kind, path, hash, freshness, lifecycle, relevance, truncation and a `headings` outline, with no body text or metadata copy. Manifest entries carry no body, so they keep their section snippets. MCP context tools return the packet once, in `structuredContent`, with a short text summary.

## Session start

`--session-start` (MCP: `session_start: true`) marks a recurring load at the start of a session. With no task, it returns only the self sources named by the lens's `session_start_sources`, in that order, plus policy documents. The default is `profile/identity.md`, `profile/preferences.md` and `profile/work-context.md`. A lens can list its own paths or `*`-in-segment globs (up to 20), or `["*"]` to keep everything. Task-less calls without the flag, such as snapshots, select as before.

```powershell
holoself context --project . --session-start --budget small --json
```

Current knowledge is the default. Historical or superseded material requires `--temporal historical|superseded|all`; privacy lenses still apply.
