# Lenses and privacy

All lenses are definitions in `<self-root>/lenses/<id>.json`. Init seeds `general`, `professional`, `public-voice`, `technical`, `leadership`, `interview`, and `private`. Every definition has the same schema and can be edited. Reading a missing registry returns an empty catalog; reads create no files.

```json
{
  "schema_version": 1,
  "id": "client-advisory",
  "title": "Client advisory",
  "sensitivity_access": ["employer-confidential"],
  "instructions": {
    "purpose": "Support client decisions",
    "priorities": ["evidence"],
    "include": [],
    "exclude": [],
    "response_guidance": []
  }
}
```

An optional `session_start_sources` array (up to 20 self-relative paths or globs with `*` inside one segment, such as `"context/communication-*.md"`) names what `context --session-start` loads. Without it, the default is `profile/identity.md`, `profile/preferences.md` and `profile/work-context.md`; `["*"]` keeps every eligible source. Older Holoself versions reject lens files that use this field.

IDs use lowercase kebab-case and match filenames. `bindings` is reserved for configuration. There is no base-lens inheritance. Documents grant explicit `access_lenses`; definitions supply sensitivity access and instructions. Only the direct owner can use `private` to access restricted material. Bound lenses must be unbound before removal, and private cannot be removed.

## Project choices

The self owns `lenses/bindings.json`:

```json
{
  "schema_version": 1,
  "bindings": {
    "C:/Example/Domain": {
      "default_lens": "professional",
      "secondary_lenses": ["technical", "interview"]
    }
  }
}
```

`lens bind|unbind|bindings` manages the store. Paths are absolute; Windows drive and UNC paths compare without case differences. Duplicate normalized paths fail closed. A linked project without a binding receives a corrective `lens bind` message. The separate `.holoself/links.json` attestation preserves `binding_salt`, status and `allowed_lenses`. Binding commands update matching grants while preserving salt and status.

## Document controls

```yaml
---
access_lenses: [professional, public-voice, private]
disclosure: review-required
sensitivity: personal
document_role: evidence
---
```

Document, claim and field access rules apply to every lens. Documents tagged with a sensitive category (`compensation-confidential`, `third-party-personal`, `recruiter-confidential`, `employer-confidential`, `application-private`) are returned only when the active lens lists that category in its `sensitivity_access`; `restricted` is always limited to the owner's `private` lens. The seeded lenses grant:

| Lens | Sensitive categories granted |
|---|---|
| `general` | none |
| `professional`, `interview` | compensation, recruiter, employer, application |
| `technical` | employer |
| `leadership` | third-party, employer |
| `public-voice` | all five |
| `private` | all five plus `restricted` |

`public-voice` has no extra publication filter: a document that grants `public-voice` access is returned even if it holds compensation details or unapproved evidence. Narrow it by editing the lens's `sensitivity_access` or the document's visibility. `disclosure` is descriptive on standard adapters; public and restricted-host adapters additionally require `disclosure: publish-approved` and a non-confidential sensitivity. Reading context never authorizes external actions.

Legacy `visibility`, `public_safe`, `exclude_lenses`, and `field_visibility` remain readable. Canonical documents need modern controls or valid legacy visibility. `knowledge migrate-lenses` previews exact conversion from `career` to `professional` and `publishing` to `public-voice`, including claim markers. Ordinary prose and proposal archives remain intact. See [CLI](../reference/cli.md) and [migration](../guides/migration.md).

### Directory policy defaults (`_policy.yaml`)

You can place a `_policy.yaml` file in the self root or any canonical directory (`profile/`, `context/`, `history/`, `topics/`, `reference/`, and their subdirectories) so every Markdown document in that subtree inherits privacy and lifecycle defaults without repeating frontmatter on each file:

```yaml
access_lenses: [professional, technical, private]
disclosure: review-required
sensitivity: personal
document_role: content
read_scope: shared
```

Resolution and rules:

- **Nearest-first inheritance with field replacement**: Holoself walks from the self root down to the document's directory (never above the self root). A nested `_policy.yaml` replaces—rather than merges—individual fields from ancestor `_policy.yaml` files while keeping any ancestor fields it does not set. The document's own YAML frontmatter overrides inherited policy defaults field by field, allowing explicit per-file narrowing or widening (for example, setting `exclude_lenses: []` in a document's frontmatter clears an inherited policy exclusion).
- **Legacy visibility opt-out**: When a document's own frontmatter declares legacy `visibility` or `public_safe` fields, Holoself applies no directory policy defaults to that document at all (matching `holoself migrate policy`) so legacy visibility scopes cannot be widened by directory defaults. Owner-facing provenance outputs record `policy_skipped: legacy-visibility`.
- **Allowed default keys**: `access_lenses`, `exclude_lenses`, `disclosure`, `sensitivity`, `document_role`, `read_scope`, `task_include`, `task_exclude`, `confidence`, `knowledge_status` (`current` or `historical`), and `temporal_scope`. Document-specific fields (`superseded_by`, `supersedes`, `valid_from`, `valid_until`, `review_after`, `field_visibility`) and legacy fields (`visibility`, `public_safe`) are rejected in `_policy.yaml`. See [`schemas/policy-defaults.schema.json`](../../schemas/policy-defaults.schema.json).
- **No restricted widening**: Neither a `_policy.yaml` file nor effective document metadata may combine `sensitivity: restricted` or `read_scope: restricted` with any lens other than `private`, or combine `disclosure: publish-approved` with a confidential or restricted sensitivity.
- **Fail-closed validation**: If any `_policy.yaml` in a document's ancestor chain is unreadable, malformed, symlinked, or contains unknown or invalid keys, no defaults are applied to documents under that directory. Those documents keep only their own frontmatter (so files lacking complete frontmatter are excluded as missing metadata), and `holoself validate` reports the relative `_policy.yaml` path.
- **Provenance and catalog freshness**: Each effective field records its source (`frontmatter` or `policy:<relative-path>`) in `catalog.json` (`policy_sources`), `holoself validate`, the Workbench document editor, and owner-direct `context_receipt.policy_sources`. Linked callers never receive `policy_sources`. Adding, editing, or removing a `_policy.yaml` file automatically invalidates affected catalog entries, and `_policy.yaml` itself is never indexed or delivered as content.
