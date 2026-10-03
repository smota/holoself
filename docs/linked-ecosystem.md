# Linked Holoself ecosystem contract

Holoself holds durable self context. Domain projects own and index their execution files. Start with [First linked project](start/first-linked-project.md), [Lenses and privacy](concepts/lenses-and-privacy.md), and [CLI reference](reference/cli.md).

## Link and binding

```yaml
self_context:
  path: "C:/Example/Self"
  access: "read"
  proposals: "enabled"
  index: "local"
  binding_salt: "0123456789abcdef0123456789abcdef"
project_context:
  include: []
```

`link add --project <dir> --self <self-root> --lens professional --yes` creates a link and a self-side choice in `lenses/bindings.json`. `lens bind|unbind|bindings` manages choices. CLI, MCP and Workbench resolve that same binding. Missing bindings fail closed; `private` remains exclusive to the direct owner. Attestation salts and status stay separate from lens selection.

Legacy `default_lens` and `secondary_lenses` in link.yaml are diagnostic and explicit migration inputs. After reviewing `knowledge migrate-lenses`, use `link repair --project <dir> --no-activate --yes` to move a configured legacy choice into the self and remove those fields. Conflicting choices require an explicit `--lens` and secondary list. Malformed stores and unknown IDs fail closed.

## Self context only

`project_context.include: []` is recommended; a missing include defaults to `[]`. Legacy includes and federation flags do not enable domain indexing. Context/index refresh discards stale domain catalog entries. Explicit analysis may inspect configured project documents to recommend reusable knowledge; reports remain project-owned.

Lenses are uniform definitions in the self root, seeded by init or reviewed migration. `professional` and `public-voice` replace old IDs. Public voice has no special compensation or publication-allowed filter. Explicit document, claim and field access still apply. Reading does not authorize external action.

## Proposals and maintenance

`propose` creates pending project-side proposals. Approval previews the exact change, requires confirmation, appends evidence and provenance, archives the decision and validates the result. Terminal proposals and receipts remain immutable.

`knowledge migrate-lenses` and `knowledge transform --replacements <json>` create exact before/after previews and hashes. Applying requires `--apply <plan> --digest <sha256> --yes`. Every target must have matching bytes and safe contained paths. Partial failure rolls back written files. Successful repeats return the original receipt only while applied bytes match. Keep a restorable backup before data maintenance.

Workbench discovers and prunes its disposable catalog from bindings. It does not use `context/linked-projects.md` as a registry. Spaces edits project choices; Lenses edits definitions. MCP shares CLI authority and self-only retrieval. See [MCP integration](guides/local-mcp.md) and [Workbench](workbench/index.md).

Markdown and evidence remain authoritative. Indexes and decision caches are local, disposable acceleration. Retrieval preserves provenance and excludes recognized secret-like inputs. Pattern matching is a limited safeguard; data stays private and user review governs durable changes.

The local search index uses schema v5/privacy-policy v4. Registry, policy, and source changes invalidate cached content before retrieval.
