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

`public-voice` has no extra publication filter: a document that grants `public-voice` access is returned even if it holds compensation details or unapproved evidence. Narrow it by editing the lens's `sensitivity_access` or the document's `access_lenses`. `disclosure` is descriptive on standard adapters; public and restricted-host adapters additionally require `disclosure: publish-approved` and a non-confidential sensitivity (`publicationAllowed`; the Workbench "derived public-safe" status is the same decision). On those adapters a claim or field rule is delivered only when its own `disclosure` is `publish-approved`, on every output path (`content`, `sections`, `claims`, `tags` and `links`). Ordinary sections without a field rule follow the document: wherever the document is delivered, so are its ordinary sections, including on publication adapters when the document is approved for publication. Reading context never authorizes external actions.

Legacy `visibility`, `public_safe`, `exclude_lenses`, and `field_visibility` remain readable. Canonical documents need modern controls or valid legacy visibility. `knowledge migrate-lenses` previews exact conversion from `career` to `professional` and `publishing` to `public-voice`, including claim markers. Ordinary prose and proposal archives remain intact. See [CLI](../reference/cli.md) and [migration](../guides/migration.md).

### Deprecated privacy fields

`visibility`, `public_safe`, `field_visibility` and the claim-marker `visibility=` attribute are deprecated in favour of `access_lenses`, `read_scope`, `disclosure` and lens-based field and claim rules ([decision](../decisions/privacy-fields-and-legacy-mount.md)). They keep working until they are rejected.

| Version | Change |
|---|---|
| 0.11.0 | `holoself validate` prints one `[warn] deprecated …` line on stderr per document and deprecated field (claim markers are counted per document), with root-relative paths. `holoself migrate policy` rewrites `visibility` and `public_safe` with the exact mapping below and removes them. |
| 0.12.0 | The runtime reads `field_access` and lens-vocabulary claim markers. `migrate policy` also rewrites `field_visibility` and claim markers, `validate --fix` prints the exact mapping per file and hands off to `migrate policy --dry-run`, and approved proposals write the new claim marker. |
| 0.13.0 | Deprecated fields are rejected: a canonical document carrying them is excluded with a validation error; a project or contrib document is restricted to `private`. |
| 0.14.0 | They are removed from the schemas. |

`holoself migrate policy --dry-run` shows the plan. The mapping keeps every valid explicit field and writes only what the legacy runtime filled implicitly, always materializing `access_lenses`, `read_scope`, `disclosure`, `sensitivity` and `document_role` so an inherited `_policy.yaml` default cannot fill a gap later:

| Legacy value | `access_lenses` (if missing) | `read_scope` (if missing) | `disclosure` |
|---|---|---|---|
| `visibility: private` | `[private]` | `restricted` | missing: `internal-only` |
| `visibility: linked-projects`, or none | the seven seeded lenses | `shared` | missing: `internal-only` |
| `visibility: professional` | `[general, professional, interview, private]` | `shared` | missing: `internal-only` |
| `visibility: public-voice` | `[general, public-voice, private]` | `shared` | missing: `internal-only` |
| `visibility: public-safe` | the seven seeded lenses | `shared` | missing: `publish-approved` (unless `public_safe: false`) |
| `public_safe: true` | — | — | missing: `publish-approved` |
| `public_safe: false` | — | — | `review-required`, overriding `publish-approved`; an explicit `internal-only` is kept |

A missing `sensitivity` becomes `personal` and a missing `document_role` becomes `content` (the runtime defaults). A restricted `read_scope` or `sensitivity` keeps only the `private` lens, which is the only one it ever admitted. Invalid legacy values are written as the restricted metadata the runtime already applies. The mapping is exact: a synthetic proof over every combination of the legacy and modern fields shows no access or publication decision changes, for every lens (including custom), caller and adapter. Coverage loss, and with it `--confirm-narrowing`, appears only when removing the legacy field lets a `_policy.yaml` default such as `exclude_lenses` narrow the document. A canonical document the catalog currently excludes (for example `visibility: public-safe` with `public_safe: false`) is an activation: it is listed under the plan's `activations`, skipped unless `--confirm-activation` is given, and mapped with the narrower rules (conflicting or restricted metadata becomes fully restricted, a missing `visibility` counts as `private`).

### Field and claim rules

`field_access` maps a field or heading name to a rule. A claim marker carries the same rule as attributes:

```yaml
field_access:
  Salary:
    access_lenses: [private]
  Public bio:
    disclosure: publish-approved
```

```markdown
<!-- holoself-claim access_lenses=general,professional disclosure=review-required -->
...
<!-- /holoself-claim -->
```

- Omitted `access_lenses` means "inherit": no restriction beyond the document. A rule can only narrow the document, so listing a lens does not open a document closed to it.
- Omitted `disclosure` means `review-required`. A rule never inherits `publish-approved`, even in a publish-approved document.
- A marker needs at least one of `access_lenses` and `disclosure`.
- A `Field: value` line matches a rule with the same name, and a heading matches a rule whose name it contains, ignoring case. When several `field_access` rules match, all of them apply.
- A heading rule covers everything under that heading until the next heading of its level or above: its text, deeper headings and claim blocks, on every output path. A claim under a hidden heading stays hidden whatever its own rule says. A heading rule inside a claim block stops at the end of that block.
- `_policy.yaml` cannot carry these rules.

Rules are the owner's. On publication adapters, and for every non-owner caller, delivered claim markers keep only `disclosure`, and `field_access`, `field_visibility` and `access_rule` are left out of delivered metadata and index entries, because a lens list can name a custom lens. A document's own `access_lenses` is still delivered.

Mistakes fail closed. An unknown attribute, lens or `disclosure` makes a claim block private and historical. Malformed `field_access` excludes a canonical document with a validation error and restricts a project document to `private`.

`field_visibility` and `visibility=` keep working in 0.12.0. When both vocabularies apply to one field or marker, the narrower result wins.

`migrate policy` uses this mapping, which matches the old behaviour exactly for every lens and adapter, including custom lenses:

| `field_visibility` or `visibility=` value | `access_lenses` | `disclosure` |
|---|---|---|
| `private`, or any unknown value (`career`, `publishing`, …) | `[private]` | `review-required` |
| `linked-projects` | inherit | `review-required` |
| `professional` | `[general, professional, interview, private]` | `review-required` |
| `public-voice` | `[general, public-voice, private]` | `review-required` |
| `public-safe` | inherit | `publish-approved` |

The rewrite changes only the targeted bytes and never changes a claim's id, so pending proposals still resolve. It rewrites exactly the blocks the runtime reads, which includes a complete block inside a fenced code block, because the runtime enforces those too. Some items are left as they are, each with a plan warning, and keep working until 0.13.0:

- A malformed marker, which keeps failing closed.
- A marker or field rule whose conflicting vocabularies admit no lens, because that has no written form.
- `field_visibility` beside an invalid `field_access`, or one that is not a mapping.

Some files stay out of the plan entirely, with a warning: a file that is not valid UTF-8, and a document whose frontmatter does not parse while it carries field rules. `migrate policy --apply` checks every file before it writes the first one, and restores the files it has written if a later write fails. Revert restores the exact prior bytes.

`field_visibility` stops at the first rule that matches, while `field_access` applies every match. A heading that matches two old rules can therefore become narrower after migration. The plan reports that as coverage loss, so it needs `--confirm-narrowing`.

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
- **Legacy visibility opt-out**: When a document's own frontmatter declares legacy `visibility` or `public_safe` fields, Holoself applies no directory policy defaults to that document at all (matching `holoself migrate policy`) so legacy visibility scopes cannot be widened by directory defaults. Owner-facing provenance outputs record `policy_skipped: legacy-visibility`. A document that sets only `public_safe` therefore gets no defaults and stays excluded until it declares the required fields itself; remove the legacy field to inherit the directory policy. `holoself migrate policy` evaluates its non-amplification gate on this effective metadata before and after the edit, and writes all four required fields plus `read_scope` into every document it migrates, so removing legacy `visibility` later cannot widen a migrated document through inherited defaults. Documents that the catalog currently excludes (`canonicalPrivacyMetadataErrors` non-empty after resolving `_policy.yaml` defaults, or invalid privacy frontmatter) are treated as denied for every lens, caller, and adapter before migration: `holoself migrate policy` lists them separately under `activations` with the lenses and adapters they would newly reach, skips them by default with a warning, and migrates them only with `--confirm-activation` (covered by the plan digest).
- **Allowed default keys**: `access_lenses`, `exclude_lenses`, `disclosure`, `sensitivity`, `document_role`, `read_scope`, `task_include`, `task_exclude`, `confidence`, `knowledge_status` (`current` or `historical`), and `temporal_scope`. Document-specific fields (`superseded_by`, `supersedes`, `valid_from`, `valid_until`, `review_after`, `field_visibility`) and legacy fields (`visibility`, `public_safe`) are rejected in `_policy.yaml`. See [`schemas/policy-defaults.schema.json`](../../schemas/policy-defaults.schema.json).
- **No restricted widening**: Neither a `_policy.yaml` file nor effective document metadata may combine `sensitivity: restricted` or `read_scope: restricted` with any lens other than `private`, or combine `disclosure: publish-approved` with a confidential or restricted sensitivity.
- **Fail-closed validation**: If any `_policy.yaml` in a document's ancestor chain is unreadable, malformed, symlinked, or contains unknown or invalid keys, no defaults are applied to documents under that directory. Those documents keep only their own frontmatter (so files lacking complete frontmatter are excluded as missing metadata), and `holoself validate` reports the relative `_policy.yaml` path.
- **Provenance and catalog freshness**: Each effective field records its source (`frontmatter` or `policy:<relative-path>`) in `catalog.json` (`policy_sources`), `holoself validate`, the Workbench document editor, and owner-direct `context_receipt.policy_sources`. Linked callers never receive `policy_sources`. Adding, editing, or removing a `_policy.yaml` file automatically invalidates affected catalog entries, and `_policy.yaml` itself is never indexed or delivered as content.

### Fixing excluded documents (`holoself validate --fix`)

`validate --fix` does not migrate deprecated fields. It repairs invalid values only, and only by narrowing: an unknown `visibility` becomes `private`, and an invalid `public_safe` becomes `false`. Beside its repair plan, and outside the plan digest, it prints the exact mapping of each file's deprecated fields and hands off to `holoself migrate policy --dry-run`. With `--json` the report is the `deprecated_fields` key. A document with broken frontmatter that carries `field_access` or `field_visibility` stays excluded for a repair by hand, because rebuilding the frontmatter would lose those rules.

Canonical Markdown documents under `profile/`, `context/`, `topics/`, and `history/` that lack complete or valid privacy metadata (`access_lenses`, `disclosure`, `sensitivity`, `document_role`) after `_policy.yaml` inheritance fail closed and are excluded from context.

Exclusions are surfaced on owner-facing surfaces only:

- `holoself doctor` and `holoself validate` print `"N canonical documents are excluded from context because their privacy metadata is incomplete — run "` followed by `` `holoself validate --fix` ``.
- Owner-direct `holoself context` includes `context_receipt.excluded_incomplete_metadata`. Linked callers and MCP responses never receive this field.
- The Workbench Overview (`GET /api/overview`) displays the count with a link to Knowledge.

To repair excluded documents conservatively without widening existing access:

1. **Preview the repair plan**: Run `holoself validate --fix` (or `holoself validate --fix --json --out plan.json`; `--out` writes `0600` and stores a hashed `root_id` rather than the absolute filesystem path). For each excluded document, Holoself proposes the most conservative defaults:
   - `access_lenses: [private]`
   - `disclosure: internal-only`
   - `sensitivity: personal` (or keeps the existing valid `sensitivity`)
   - `document_role: content` (or keeps the existing valid `document_role`)
   - **Never widen**: Any field that is already present and valid is kept unchanged. Any field that is present and invalid is replaced with its conservative default and reported in the plan reasons and per-file `frontmatter_diff`.
   - **No silent publication activation**: If a document's existing kept values include `disclosure: publish-approved` (or legacy `visibility: public-safe` / `public_safe: true`) and the fix would make it newly included, Holoself skips that document by default with a warning (`would activate publish-approved; add the missing fields by hand or rerun with --allow-publish-approved`). Pass `--allow-publish-approved` explicitly to include those documents in the repair plan.
   - **Directory `_policy.yaml` suggestions**: When two or more files in the same directory are excluded for shared missing fields and no `_policy.yaml` exists in that directory yet, the plan also includes a `policy_suggestions` entry for `<dir>/_policy.yaml` as an optional alternative.
2. **Apply the digest-bound plan**: Run `holoself validate --fix --apply --digest <sha256> --yes` (or confirm interactively in a TTY). Apply verifies every file's `before_sha256` against disk and refuses with `PLAN_CHANGED` if any file changed since planning, preserves existing file modes on apply and rollback (and creates new `_policy.yaml` files with mode `0600`), rolls back all writes on any error, and writes an immutable receipt under `.holoself/validate-fix-receipts/<digest>.json`.
3. **Apply directory `_policy.yaml` suggestions (optional)**: Pass `--with-policy-files` (`holoself validate --fix --with-policy-files` and `holoself validate --fix --apply --with-policy-files --digest <sha256> --yes`) to create `<dir>/_policy.yaml` instead of editing per-file frontmatter in eligible directories. Existing `_policy.yaml` files are never overwritten.
