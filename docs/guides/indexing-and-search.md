# Indexing and search

Holoself uses deterministic, dependency-free local JSON indexing today. Markdown remains source of truth.

```bash
node bin/holoself.mjs index rebuild --project C:/work/project
node bin/holoself.mjs index --project C:/work/project --changed
node bin/holoself.mjs index status --project C:/work/project
node bin/holoself.mjs search "regulated AI" --project C:/work/project
node bin/holoself.mjs search "regulated AI" --project C:/work/project --federated
```

Each project owns `.holoself/index/index.json` schema v5/privacy-policy v4. It stores paths, headings, hashes, timestamps, redacted policy metadata, links, tags, claims, visibility, provenance, input/config state hashes, the self-root lens-registry hash, and post-build assertion results. A registry definition change makes the index stale; search rebuilds it before use. Secret-like content is skipped. Search reapplies privacy filters and auto-rebuilds stale indexes; `index status` reports freshness without mutation.

Link-time `--project-assert-include <globs>` and `--project-assert-exclude <globs>` persist build assertions. Build fails closed if an expected include has no indexed match, any forbidden exclude survives, configured boundaries are violated, or secret-pattern leakage is detected after build.

The index is local, versioned independently, rebuildable, ignorable, and safe to delete. SQLite/FTS and embeddings are planned optional acceleration layers; neither may become canonical or require hosted services.
