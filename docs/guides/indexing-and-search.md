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

Context and search index canonical self only. Legacy project include policies and federation flags cannot include domain documents. Warm caches are checked against the current self-only source set before reuse. Domain engines own their domain indexing. Self-side lens choices and attestation grants are checked before retrieval; private remains owner-only.

The index is local, versioned independently, rebuildable, ignorable, and safe to delete. SQLite/FTS and embeddings are planned optional acceleration layers; neither may become canonical or require hosted services.
