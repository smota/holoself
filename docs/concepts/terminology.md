# Terminology

| Term | Meaning |
|---|---|
| Whole-person context | Canonical reusable knowledge about one person |
| Self root or data root | Folder containing canonical context |
| Project | Independent workspace owning execution artifacts |
| Lens | Task-specific read scope and relevance filter |
| Metadata project link | Read-only `.holoself/link.yaml` configuration pointing to canonical self; grants no publication permission |
| Snapshot | Reviewed generated copy or packet for portable/sandboxed use; can become stale |
| Legacy live mount | Filesystem symlink/junction created by `link --target`; exposes complete data root. Deprecated since 0.11.0 (`link --target`, `unlink --target` and legacy-mount detection print a warning); removed in 0.13.0 |
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

Deprecated terms ([decision](../decisions/privacy-fields-and-legacy-mount.md)): **visibility** (document, field, claim and section level; use access lenses, read scope and disclosure), **public_safe** (use disclosure), **field_visibility** (use lens-based field rules), and **legacy live mount** (use a metadata project link). They remain readable until the versions named in the decision: `holoself validate` warns from 0.11.0 and they are rejected from 0.13.0. See [deprecated privacy fields](lenses-and-privacy.md#deprecated-privacy-fields).
