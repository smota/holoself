# Terminology

| Term | Meaning |
|---|---|
| Whole-person context | Canonical reusable knowledge about one person |
| Self root or data root | Folder containing canonical context |
| Project | Independent workspace owning execution artifacts |
| Lens | Task-specific read scope and relevance filter |
| Metadata project link | Read-only `.holoself/link.yaml` configuration pointing to canonical self; grants no publication permission |
| Snapshot | Reviewed generated copy or packet for portable/sandboxed use; can become stale |
| Legacy live mount | Filesystem symlink/junction created by `link --target`; exposes complete data root |
| Proposal | Evidence-backed request to update canonical self context |
| Packet | Generated context delivery format, not source of truth |
| Index | Disposable local retrieval metadata |
| Startup adapter | Generated host instruction pointer used to discover Bootstrap |
| Packet formatter | Output framing selected by `context --adapter`; does not configure host discovery |
| Contrib | Optional reusable method instruction; public default or private local extension |
| Access lens | Permission for a task lens to read a document |
| Disclosure | Permission state for reproducing facts publicly |
| Sensitivity | Handling classification, independent of access and disclosure |
| Document role | Policy, evidence, or content classification used during resolution |

Prefer **context** to **memory** in product copy. Memory can imply autonomous persistence, which Holoself rejects. Prefer **lens** to persona or mode when discussing task relevance. Use the full terms **metadata project link**, **snapshot**, and **legacy live mount** when behavior could be confused.
