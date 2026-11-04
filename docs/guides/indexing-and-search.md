# Indexing and search

Holoself uses deterministic, dependency-free local JSON indexing, with an optional SQLite FTS5 (BM25) ranking layer when the running Node.js provides it. Markdown remains source of truth.

```bash
node bin/holoself.mjs index rebuild --project C:/work/project
node bin/holoself.mjs index --project C:/work/project --changed
node bin/holoself.mjs index status --project C:/work/project
node bin/holoself.mjs search "regulated AI" --project C:/work/project
```

Each project maintains a local `.holoself/catalog/catalog.json` partition (schema v5/privacy-policy v4) alongside the self-root catalog. It stores paths, headings, hashes, timestamps, redacted policy metadata, links, tags, claims, visibility, provenance, input/config state hashes, the self-root lens-registry hash, and post-build assertion results. A registry definition change makes the catalog stale; search rebuilds it before use. Secret-like content is skipped. Search reapplies privacy filters and auto-rebuilds stale catalogs; `index status` reports freshness without mutation, and `index rebuild` also removes any legacy decision-cache files on disk.

Context and search index canonical self only. Legacy project include policies and deprecated `--federated` flags cannot include domain documents (`--federated` and `--no-cache` emit a deprecation warning on stderr and have no effect). Warm catalog partitions are checked against the current self-only source set before reuse. Domain engines own their domain indexing. Self-side lens choices and attestation grants are checked before retrieval; private remains owner-only.

The index is local, versioned independently, rebuildable, ignorable, and safe to delete. Embeddings remain a planned optional layer; no index may become canonical or require hosted services.

## Optional FTS5 engine

Two retrieval engines exist, and every `search` result (CLI and `holoself_search`), `index` report and FTS5-ranked context receipt names the one in use:

| Engine | When | Search semantics | Context ranking |
|---|---|---|---|
| `fts5` | Default when `node:sqlite` loads without a flag (Node.js 22.13 or newer) and an FTS5 table can be created | Every query term must match a stemmed, diacritic-folded token of the section heading or filtered snippet. Terms of 4+ characters also match by prefix of their stem; stopwords are ignored when other terms remain. Results are ordered by `bm25` (higher is better), then file and section order; `score` is still the matched-term count. | Token overlap (`relevanceScore`) plus a BM25 bonus of up to 4 points, scaled to the best candidate; ties break by source id. `context_receipt.engine` is `"fts5"`. |
| `deterministic-json` | Older Node.js builds, or `HOLOSELF_INDEX_ENGINE=json` | Every query term must be a lowercase substring of heading + filtered snippet; results ordered by file. | Token overlap only. `context_receipt` has no `engine` field, so JSON-engine packets are byte-identical to earlier releases. |

Set `HOLOSELF_INDEX_ENGINE=json` to force the JSON engine for debugging or comparison (`fts5` or `auto` select the default). Tokenization uses Unicode NFKD with diacritic stripping and the FTS5 `porter unicode61 remove_diacritics 2` tokenizer, so `compensacao` finds `compensação` and `guaranteeing` finds `guarantees`. Stemming is English Porter: it helps inflections, not true synonyms or paraphrases (`pager fatigue` still does not find `rotation exhaustion`). Everything runs offline with no model and no npm dependency; `node:sqlite`'s experimental warning is filtered from CLI stderr.

The FTS5 database is `<self>/.holoself/catalog/fts5.sqlite` (git-ignored with `catalog/`, mode `0600`). It is a derived cache of the self catalog's section snippets, no other text, and is rebuilt (written to a temporary file, then renamed) whenever the catalog freshness inputs change: catalog schema, lens-registry hash, and each source's content hash and stat tuple. `index rebuild` deletes and rebuilds it. A missing, stale or corrupt file is rebuilt; a symlink at or below the self root is refused and never followed. When the file cannot be used (including a Windows rename refused because another process has it open, retried briefly and then skipped as busy), the same text is tokenized in memory, which yields the same scores, so the file only saves work. Each rebuild first removes `fts5.sqlite.tmp-*` build files older than 10 minutes left by an interrupted rebuild (regular files only; symlinks are never followed or removed). `holoself capabilities --json` reports `index.engine.available` and `index.engine.selected`.

Privacy is applied before ranking, as for the JSON engine. BM25 runs only over the documents and sections that passed the caller's lens, adapter, read-scope and lifecycle gates, using their claim- and field-filtered text. For context ranking the BM25 bonus is computed after the temporal filter, so superseded, historical or expired documents excluded by the selector do not count either. Document counts, term frequencies and average lengths come from those documents alone, so a hidden document never appears, never receives a score, and never shifts the scores or order of visible ones. Sections whose filtered text differs from the catalog snippet are tokenized in a per-call in-memory database instead of the cache.
