# Indexing and search

Holoself uses deterministic, dependency-free local JSON indexing today. Markdown remains source of truth.

```bash
node bin/holoself.mjs index rebuild --project C:/work/project
node bin/holoself.mjs index --project C:/work/project --changed
node bin/holoself.mjs index status --project C:/work/project
node bin/holoself.mjs search "regulated AI" --project C:/work/project
node bin/holoself.mjs search "regulated AI" --project C:/work/project --federated
```

Each project owns `.holoself/index/index.json`. It stores paths, headings, hashes, timestamps, redacted policy metadata, links, tags, claims, visibility, and provenance. Secret-like content is skipped. Search reapplies privacy filters.

The index is local, versioned independently, rebuildable, ignorable, and safe to delete. SQLite/FTS and embeddings are planned optional acceleration layers; neither may become canonical or require hosted services.
