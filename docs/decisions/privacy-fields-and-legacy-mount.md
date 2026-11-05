# Privacy fields and the legacy live mount

Status: Accepted (2026-11-04). The owner delegated this decision to the review-program build session. Implementation is tracked separately. Issue: #75 (parent #51).

## Context

Privacy frontmatter grew in layers. `visibility` and `public_safe` came first. `access_lenses`, `disclosure`, `sensitivity`, `document_role` and `read_scope` replaced them, but the old fields still change runtime decisions. The overlaps are hard to reason about, the migration gate checks a different model from the one the runtime enforces, and directory defaults from `_policy.yaml` (#73) have to skip every document that carries a legacy field.

Separately, Holoself still ships a legacy live mount: `link --target` makes the project `.holoself` a symlink or junction to the whole data root.

This record inventories the current fields, sets the target field set and an exact mapping from the deprecated fields, defines the migration and deprecation timeline, and plans the retirement of the legacy live mount.

Commands written with the `holoself` prefix existed when this record was accepted. Commands written without the prefix were planned then. `holoself validate --fix` now exists, and the timeline in section 3 shows which stages have shipped.

## 1. Inventory

Vocabularies: `VISIBILITIES = private, linked-projects, professional, public-voice, public-safe`, `DISCLOSURES = internal-only, review-required, publish-approved` (`src/annotations.mjs:1-2`). The seven seeded lens ids are `DEFAULT_LENS_IDS` (`src/lenses.mjs:69`), and `LENSES` in `src/policy/access.mjs:6` is the same list.

### Document-level fields

| Field | Controls | Read by | Overlaps and contradictions |
|---|---|---|---|
| `access_lenses` | Which lenses may read the document | `accessLenses` (`src/policy/access.mjs:25`), `allowedDocument` phase 3 (`:79-80`) | When it is missing, `legacyAccessLenses(visibility)` supplies the lens list (`:18-24`). |
| `exclude_lenses` | Subtracts lenses after `access_lenses` | `allowedDocument` phase 4 (`:81-82`) | Redundant with a shorter `access_lenses` on a single document. It is still useful as an inherited `_policy.yaml` default. Kept. |
| `read_scope` | Who and where: `shared`, `local` (space must be reachable), `restricted` (direct owner under `private` only) | `allowedDocument` phase 1 (`:61-72`, `:90-94`), `privacyMetadata` (`:152-156`) | When it is missing, the default depends on `visibility`: `private` gives `restricted`, anything else gives `shared` (`:62`). `read_scope: restricted` and `sensitivity: restricted` produce the same gate (owner plus `private`, `:63-66` and `:85-89`). |
| `sensitivity` | Handling class. Gates sensitive categories by lens `sensitivity_access` and blocks publication for confidential classes. | `allowedDocument` phases 6 and 6b (`:84-102`), `publicationAllowed` (`:37-44`), `derivedPublicSafe` (`src/annotations.mjs:27`) | `restricted` duplicates `read_scope: restricted` (see above). `document_role: policy` skips the phase 6b category check (`:97`). |
| `disclosure` | Publication state. Descriptive on standard adapters, required to be `publish-approved` on `public`, `obsidian-public` and `restricted-host` | `disclosure()` (`:28-33`), `publicationAllowed`, `allowedDocument` phase 7 (`:103-105`) | `disclosure()` is not the raw field. `public_safe: false` forces `review-required` even when `disclosure: publish-approved` is set (`:29`). `public_safe: true` or `visibility: public-safe` produce `publish-approved` when `disclosure` is missing (`:31`). |
| `visibility` (legacy) | Four things at once: the lens set when `access_lenses` is missing, the `read_scope` default, the `disclosure` default (`public-safe`), and the default visibility of every ordinary section | `visibility()` (`:15-17`, default `linked-projects`), `legacyAccessLenses`, `allowedDocument` (`:62`), `disclosure()` (`:31`), `privacySections` (`src/catalog/source.mjs:31`) | `public-safe` grants all seven seeded lenses (the fall-through at `:23`), not a public-only set. The migration code assumes a different default (`'private'`, `src/migration.mjs:11`) than the runtime (`'linked-projects'`). So does the unmigrated-policy warning (`src/retrieval/records.mjs:39`), which never fires on catalog policy because `privacyMetadata` always fills `read_scope`. |
| `public_safe` (legacy) | Overrides publication in both directions | `disclosure()` (`:29`, `:31`), `annotationSchema` (`src/annotations.mjs:41`, "derived-override") | Contradicts `disclosure`: `disclosure: publish-approved` with `public_safe: false` is not publishable. `validateAnnotationMetadata` only warns about the difference (`src/annotations.mjs:83-84`). `visibility: public-safe` with `public_safe: false` is a canonical error (`src/policy/privacy-fields.mjs:77-78`). |
| `publication_allowed` / `derivedPublicSafe` | Derived outputs, never frontmatter | `privacyMetadata` (`:162`), `derivedPublicSafe` (`src/annotations.mjs:27`), packet render (`src/render/packet.mjs:50`) | Two functions answer the same question differently. `derivedPublicSafe` reads raw `disclosure` and ignores `public_safe` and `visibility`. `publicationAllowed` uses `disclosure()`. For `visibility: public-safe` with no `disclosure`, the first returns false and the second true. With no legacy fields present, the two agree: both sensitivity lists are the same six classes. |
| `document_role` | `policy`, `evidence`, `content`. `policy` skips the sensitive-category lens check. | `documentRole` (`:34-36`), `allowedDocument` (`:97`) | None. Kept. |
| `task_include` / `task_exclude` | Task substring selectors | `taskAllowed` (`:45-51`) | None. Kept. |
| Lifecycle (`confidence`, `knowledge_status`, `temporal_scope`, `valid_from`, `valid_until`, `review_after`, `supersedes`, `superseded_by`) | Freshness and supersession | `src/context-selection.mjs`, `privacyMetadata` | Not privacy controls. Unchanged. |

### Sub-document fields

| Field | Controls | Read by | Overlaps and contradictions |
|---|---|---|---|
| `field_visibility` (`{field: VISIBILITY}`) | Hides headings or `Field: value` lines | `filterFieldVisibility` (`src/policy/access.mjs:119-147`), `privacySections` (`src/catalog/source.mjs:30`) | Uses the legacy `visibility` vocabulary, not lens ids. Through `visibleUnderBehavior` (`:52-57`), `linked-projects` and `public-safe` mean "every lens", including custom registry lenses. The same value at document level means "the seven seeded lenses". |
| Claim marker `<!-- holoself-claim visibility=X -->` | Hides claim blocks. Approved proposals write it (`src/proposals/store.mjs:292`). | `filterClaimVisibility` (`:111-118`), `privacySections` (`src/catalog/source.mjs:21-25`), catalog claim, tag and link filters (`src/retrieval/records.mjs:87-89`, `src/retrieval/delivery.mjs:99-101`) | Same vocabulary problem. Unknown values, including archived `career` and `publishing`, fall back to `private` (`:53`). |
| Section `visibility` (catalog) | Gates catalog sections, claims, tags and links per adapter | `visibleUnderBehavior` in `records.mjs:64`, `delivery.mjs:84`, `catalog/index.mjs:83` | On publication adapters a section shows only if its visibility is `public-safe` (`access.mjs:54`). An ordinary section inherits the document's `visibility`, which defaults to `linked-projects`. A modern document with `disclosure: publish-approved` and no legacy `visibility` therefore passes phase 7 but shows no catalog sections. The `content` path still delivers its body, because `filterClaimVisibility` and `filterFieldVisibility` always evaluate with the `'generic'` adapter (`access.mjs:114`, `:133`, `:140`). As a result, on a publication adapter, claims and fields marked `linked-projects`, `professional` or `public-voice` stay in `content` while being dropped from `sections` and `claims`. |

### Migration gate findings

`verifyNonAmplification` (`src/migration.mjs:170-198`) does not evaluate the runtime policy. It uses two private re-implementations, `evaluateAllowedV1` and `evaluateAllowed` (`:97-168`):

- **Publication model.** Publication is decided by `meta.publication_allowed`, which is never a frontmatter field, or by `visibility === 'public-safe'` (`:134`, `:164`). It ignores `disclosure`, `public_safe` and `sensitivity`. Two consequences follow. Removing `public_safe: false` from a `disclosure: publish-approved` document passes the gate even though runtime publication changes from denied to allowed. Replacing `visibility: public-safe` with `disclosure: publish-approved`, which is exact at runtime, is reported as coverage loss.
- **Coverage.** The gate tests the seven seeded lenses and only the `generic` and `public` adapters. It ignores task selectors, `read_scope: local`, lens `sensitivity_access`, custom registry lenses and `restricted-host`.
- **Parsing.** `planPolicyMigration` parses with `validatePrivacy: false` (`:285`) and treats `access_lenses: []` as absent (`:19`). The runtime parser restricts such a document to `private` (`privacyValueValid` requires at least one lens, `src/policy/privacy-fields.mjs:29`; then `restrictPrivacyMetadata`). A dry run on a synthetic `access_lenses: []` plus `visibility: linked-projects` document plans all seven lenses and reports no coverage loss. **The existing `migrate policy` can widen access, and the gate does not detect it.** This must be fixed before any deprecation migration ships (see acceptance criteria).

## 2. Target field set

Five orthogonal concerns, one field family each:

| Concern | Fields | Meaning |
|---|---|---|
| Access | `access_lenses`, `exclude_lenses`, `read_scope` | Which lenses, and which subjects and spaces, may read the document |
| Handling | `sensitivity` | Category gate through lens `sensitivity_access`, plus confidential classes that can never be published |
| Publication | `disclosure` | The only publication input. `publicationAllowed` = `disclosure == publish-approved` and a non-confidential `sensitivity`. `derivedPublicSafe` becomes an alias of `publicationAllowed`. |
| Role | `document_role` | Unchanged |
| Selectors | `task_include`, `task_exclude` | Unchanged |
| Lifecycle | `confidence`, `knowledge_status`, `temporal_scope`, `valid_*`, `review_after`, `supersedes`, `superseded_by` | Unchanged |

`read_scope: restricted` and `sensitivity: restricted` both stay. They answer different questions (who may read versus how the content is handled) and only coincide on the restricted lens gate. Validation already rejects pairing either one with non-`private` lenses (#73).

**Sub-document rules use the same vocabulary.**

- `field_access` replaces `field_visibility`. It maps a field or heading name to `{ access_lenses?: [...], disclosure?: ... }`.
- Claim markers become `<!-- holoself-claim access_lenses=a,b disclosure=review-required -->`.
- Omitted `access_lenses` means "inherit": no restriction beyond the document. Omitted `disclosure` on a rule means `review-required`. A rule never inherits `publish-approved` implicitly.
- Ordinary sections without a rule inherit the document's access and disclosure.
- On publication adapters, every output path (`content`, `sections`, `claims`, `tags`, `links`) applies the same rule: the sub-document `disclosure` must be `publish-approved`.

**Deprecated:** `visibility`, `public_safe`, `field_visibility`, the `visibility=` claim-marker attribute, and the catalog section, claim, tag and link `visibility` property (rebuilt from the new rules, since the catalog is disposable). `exclude_lenses` is not deprecated: it is the only subtractive control that works as an inherited `_policy.yaml` default.

### Mapping: document level

Rules apply only to fields the document does not already set validly, because explicit modern fields already win at runtime. The single exception is `public_safe: false`, which overrides `disclosure`. The migration always materializes all four canonical fields (`access_lenses`, `disclosure`, `sensitivity`, `document_role`) plus `read_scope`. That way an inherited `_policy.yaml` default can never fill a gap that the legacy runtime resolved implicitly (see section 3).

| Legacy value | `access_lenses` (if missing) | `read_scope` (if missing) | `disclosure` | Result |
|---|---|---|---|---|
| `visibility: private` | `[private]` | `restricted` | missing: `internal-only` | Exact |
| `visibility: linked-projects`, or no `visibility` | the seven seeded lenses (custom lenses excluded, as today) | `shared` | missing: `internal-only` | Exact |
| `visibility: professional` | `[general, professional, interview, private]` | `shared` | missing: `internal-only` | Exact |
| `visibility: public-voice` | `[general, public-voice, private]` | `shared` | missing: `internal-only` | Exact |
| `visibility: public-safe` | the seven seeded lenses | `shared` | missing: `publish-approved`, unless `public_safe: false` | Exact |
| `public_safe: true` | none | none | missing: `publish-approved`. An explicit value is kept. | Exact |
| `public_safe: false` | none | none | `review-required`, overriding `publish-approved`. An explicit `internal-only` is kept. | Exact for every access and publication decision. Keeping `internal-only` narrows the label only. |
| Invalid legacy value (runtime restricts the document) | output of `restrictPrivacyMetadata`: `[private]` | `restricted` | `internal-only`, with `sensitivity: restricted` | Exact |
| Missing `sensitivity` | none | none | none | Write `personal`. It is ungated like a missing value (`access.mjs:84-102`, `:40`). Exact. |
| Missing `document_role` | none | none | none | Write `content` (`access.mjs:35`). Exact. |

The table was checked against the real `allowedDocument` and `publicationAllowed` on 1,728 synthetic combinations. The combinations cover every `visibility` (including missing), every `public_safe` value, missing or explicit `access_lenses`, every `disclosure`, missing, `shared` and `restricted` `read_scope`, and four sensitivities. Each combination was evaluated across eight lenses (the seven seeded plus one custom), both subjects, three adapters, and resolutions with and without `sensitivity_access`. The result: 0 widened cells, 0 narrowed cells, 0 publication differences.

This replaces the narrower tables in `computeMeetMetadata` (`src/migration.mjs:9-61`). That code maps a missing `visibility` to `private`, `public-safe` (self) to three lenses, and every project-kind value to two or fewer lenses. Those narrowings came from the wrong default, not from an owner decision. The exact mapping keeps `--confirm-narrowing` for real narrowing. Documents already migrated carry explicit fields, so they are not remapped.

### Mapping: claim and field level

| Legacy value | `access_lenses` | `disclosure` | Result |
|---|---|---|---|
| `private`, or any unknown value (`career`, `publishing`, …) | `[private]` | `review-required` | Exact |
| `linked-projects` | inherit | `review-required` | Exact (every lens on generic adapters, hidden on publication adapters) |
| `professional` | `[general, professional, interview, private]` | `review-required` | Exact |
| `public-voice` | `[general, public-voice, private]` | `review-required` | Exact |
| `public-safe` | inherit | `publish-approved` | Exact (the document itself must still pass phase 7) |

This was checked against `visibleUnderBehavior` for every value, eight lenses and three adapters, with 0 differences.

### Flagged non-exact cases

1. **Narrowing (runtime correction, not a data mapping).** On publication adapters, the `content` path applies sub-document disclosure, as `sections` and `claims` already do. Claims and fields marked `linked-projects`, `professional` or `public-voice` stop appearing in public `content`. This closes a leak. It changes no files, so `--confirm-narrowing` does not apply, but it is listed in the release notes.
2. **Sections alignment.** Ordinary catalog sections of a document that is `disclosure: publish-approved` without legacy `public-safe` start showing on publication adapters. No new text crosses the boundary: the `content` path already returns the same body for the same subject, lens and adapter (`src/retrieval/delivery.mjs:51-66`). This is recorded here because it changes the `sections` field. A dedicated test pins that `sections` is a subset of `content`.
3. **Narrowing (data).** If an owner chooses to keep the old narrower `computeMeetMetadata` result for a document, the plan reports it as coverage loss, and `holoself migrate policy --apply <plan_id> --confirm-narrowing` is required.

## 3. Migration

Migration reuses `holoself migrate policy` with the same plan, apply and revert lifecycle, hashes, TOCTOU checks and receipts:

1. Preview with `holoself migrate policy --dry-run`. The plan also lists claim markers and `field_visibility` rewrites.
2. Apply with `holoself migrate policy --apply <plan_id>`. Add `--confirm-narrowing` only when the plan reports coverage loss.
3. Revert with `holoself migrate policy --revert <receipt_id>`.

The plan writes the materialized target fields from section 2 and removes `visibility`, `public_safe` and `field_visibility` in the same edit. The revert receipt restores the exact prior bytes.

`verifyNonAmplification` is rebuilt to evaluate before and after metadata through the runtime parser and the real `allowedDocument`, `publicationAllowed` and sub-document filter. It must also include the effective `_policy.yaml` defaults the document would inherit after the change.

**Deprecation timeline**

| Version | Status | Change |
|---|---|---|
| 0.11.0 | Shipped | `holoself validate` warns for every document carrying `visibility`, `public_safe`, `field_visibility` or a `visibility=` claim marker, and names the mapped fields. The gate fixes from section 1 ship first. |
| 0.12.0 | Implemented, not yet released | The runtime reads `field_access` and lens-vocabulary claim markers, and `holoself migrate policy` rewrites `field_visibility` and claim markers. `holoself validate --fix` prints the exact mapping per file and hands off to `holoself migrate policy --dry-run`. It does not migrate deprecated fields. Its existing repair still replaces an invalid value, narrowing only (see the corrections below). Approved proposals write the new claim marker. Archived proposal records stay readable. |
| 0.13.0 | Planned | Deprecated fields are rejected. A canonical document that carries them is excluded with a validation error. A tolerant project or contrib document is restricted to `private`, as invalid metadata is today. `_policy.yaml` already rejects them. |
| 0.14.0 | Planned | They are removed from `schemas/document-metadata.schema.json`, from `VISIBILITIES` consumers, from the annotation schema and from catalog schemas. |

**Corrections from the 0.12.0 implementation (#108)**

- The narrowing in flagged case 1 and the alignment in flagged case 2 shipped in 0.11.0 (#106 and the 0.11.0 stage of #108). 0.12.0 keeps them. It adds two narrowings to heading rules, listed below, which also apply to legacy documents.
- **Changed promise.** This record said `validate --fix` "never edits files itself", written when the flag was only planned. The repair command that shipped before this stage does edit files. The first 0.12.0 change quietly reworded the promise to "never edits those fields", which was also false: an invalid `visibility: career` becomes `private`, and an invalid `public_safe` becomes `false`. The intent of the promise is that `validate --fix` does not migrate, and that is what the record now says: it never rewrites a valid deprecated field to the new vocabulary, and it repairs invalid values, narrowing only. The mapping report itself writes nothing.
- `validate --fix` already existed as a repair command when this stage was built. The mapping report sits beside its plan, outside the plan digest, so the repair flow is unchanged. A document with broken frontmatter that carries field rules is no longer repaired, because the repair rebuilds frontmatter from salvaged scalars and would lose them.
- A claim marker needs at least one of `access_lenses`, `disclosure` or `visibility`. A marker with none stays malformed, as it was.
- The catalog keeps `visibility` on sections, claims, tags and links as a label until 0.14.0. An element adds `access_rule` only when no label states its rule exactly, so a migrated document produces the same catalog as its legacy form.
- `field_visibility` stops at the first matching name and `field_access` applies every match. Migration drops an old rule shadowed by a same-name rule, which is exact. A heading that matched two different old rules becomes narrower, and the plan reports that as coverage loss. Conflicts cannot widen.
- When two lens lists overlap but neither contains the other, the combined rule fails closed to `private`. This keeps the behaviour of `professional` with `public-voice`, for new rules too.
- The rewrite covers exactly the blocks the runtime parses, including complete blocks inside fenced code. Documents without frontmatter get their markers rewritten too, because the runtime reads them.

**Corrections from the independent review of 0.12.0 (#108)**

- A heading rule covers the claim blocks under it on every output path. The catalog used to lift a claim out of its section and apply only the claim's own rule, and in `content` a heading inside a claim ended the rule around it, so the paths disagreed and a claim with its own heading was not covered on any of them. Content, sections, claims, tags, links and search now share one walk over the document. This corrects behaviour in released versions.
- A heading rule covers deeper headings until the next heading of its level or above, and a heading inside a claim no longer ends the rule around that claim. Both narrow existing documents. A heading rule inside a claim stops at the claim's closing marker, so ordinary text after the claim, which `sections` already delivered, is now in `content` too.
- A heading-shaped line inside fenced code is not a heading: it ends no rule and creates no section, and this corrects behaviour in released versions. It still opens a rule when it carries a ruled name, up to the next real heading. That is deliberate: a fence that was never closed can hide a real heading, and treating the line as code would switch the rule off. Fences therefore only remove what ends a rule, never what starts one, so a fence, closed or not, can only narrow. A fence opened inside a claim ends with the claim, and a fence opened outside continues across a claim block. The text outside claim blocks and each claim body are read separately, so a fence inside a claim cannot affect the text after it, and hiding a claim from one lens cannot change the rest of the document for that lens. `claimBlockText` keeps skipping `#` lines, fenced or not, because that text is claim identity.
- **A heading rule starts liberally and ends conservatively**, so unusual heading shapes hide more rather than less. `src/markdown/lines.mjs` holds the rule, and every path uses that one scope. A rule starts on any line that could plausibly present its name as a heading, wherever it sits: ATX with any indent or no space, closed ATX, Setext, HTML headings, table header cells, lines holding only emphasis, a caption-like element or a name and a colon, behind blockquote or list prefixes, and inside fences, raw HTML and comments. A rule ends only at an unambiguous real heading of its level or above: ATX at column 0 with a space or tab after the hashes, outside fences, raw HTML blocks and comments, with no other heading shape on the line. An ATX line stays a heading whatever its text ends with, so `## Education:` is no label. Setext `===` is level 1, `---` is level 2, HTML `hN` is N, and otherwise the ATX count applies. A shape that states no level, and anything inside a raw construct, ends at the next real heading of any level. That keeps ordinary prose such as `My salary history:` from hiding a whole document. Only real headings split sections, so a start in mid-section hides line by line and carries on into later sections. Starts do not depend on any raw state, and real headings are a subset of the column 0 `#` lines that ended a rule before, so rule scoping can only narrow.
- Names are compared through presentation on both the rule and the line: NFKC, format characters removed, whitespace folded, basic HTML entities decoded, inline emphasis removed, and case ignored. `＃` counts as `#` for starts only. Homoglyphs across scripts are out of scope: a Cyrillic letter that looks like a Latin one is a different letter, and no rule matches it.
- Pieces of a line split by a multi-line claim block read as the line they join into when the block is lifted out, on every path. A claim on such a line is covered by a heading rule on that line.
- Rule details are the owner's. On publication adapters, and for every non-owner caller, delivered markers keep only `disclosure`, and `field_access`, `field_visibility` and `access_rule` are removed from delivered metadata and index entries. `access_lenses` and `exclude_lenses` there, and in search results, keep only seeded lenses and the caller's lens. Restriction reasons name no field. A claim body no longer records a lens list, and such a line in an existing body is left out of delivery to those callers. MCP proposal previews work on the delivered text, never on the file.
- A snippet is cut after filtering. A long section of a document with field rules keeps its full text in the local catalog, filtered per caller and then cut, so `sections` is a subset of `content`.
- A claim whose rule admits no lens is refused by replace, supersede and retire. Writing any marker for it would widen it.
- `field_access` names with surrounding spaces are rejected.
- `migrate policy` leaves out, with a warning, a file that is not valid UTF-8 and a document whose frontmatter does not parse while carrying field rules. Apply verifies every entry before the first write and rolls back on a later failure. Receipts keep prior bytes as `before_base64`, and older receipts with `before_text` still revert.
- The catalog schema version is 5, so catalogs built with the earlier rule scope rebuild.

**Interaction with `_policy.yaml` (#73).** Until 0.13.0, a document carrying `visibility` or `public_safe` receives no directory defaults (`policy_skipped: legacy-visibility`). After migration the legacy fields are gone, so the document inherits defaults for every field it does not set. Because the migration materializes `access_lenses`, `read_scope`, `disclosure`, `sensitivity` and `document_role`, inherited defaults can only add narrowing controls (`exclude_lenses`, task selectors, lifecycle). Without this materialization, a directory default such as `disclosure: publish-approved` or `document_role: policy` would widen a former legacy document. The rebuilt gate checks the inherited result. From 0.13.0 the skip rule has nothing left to trigger on and is removed.

## 4. Legacy live mount

**What it is.** `holoself link --target <dir>` replaces `<dir>/.holoself` with a directory symlink (a junction on Windows) to the entire data root (`src/cli.mjs:490-512`). `holoself unlink --target <dir>` removes it after checking that it points at this root (`:514-525`, `isHoloselfLink` at `:120`).

**Why it is unsafe.** Any tool in the project reads every canonical file directly: `private`-lens and `sensitivity: restricted` documents, proposals, lens definitions and `.holoself/links.json` with every link's `binding_salt`. Lenses, bindings, link attestation, `read_scope`, sub-document rules, publication gates and context receipts are all skipped, because Holoself is never on the read path. The threat model already lists this residual risk (`docs/trust/threat-model.md`, "Tool reads excessive context").

**Current detection.** Holoself refuses to serve through a mount. `resolveCaller` (`src/retrieval/caller.mjs:28-32`), `readLink` (`src/link/config.mjs:141-145`) and the MCP project binding (`src/mcp-server.mjs:189-190`) fail with `LEGACY_MOUNT_DETECTED`. `link status` and link health report `mode: legacy-mount` (`src/link/health.mjs:8-44`, `src/cli/commands/link/status.mjs:20`).

**Current migration path, and a gap.** Every detection message says to "run holoself link setup". However, CLI `link setup` refuses a symlinked `.holoself` (`inspectLinkCollisions`, `src/link/config.mjs:240`: "is not a regular metadata directory; refusing to replace"). This was reproduced on a synthetic junction. The only working migration is the Workbench "Migrate to metadata link" action (`src/web/server-helpers.mjs:245-246`). That action calls `planSpaceAction` / `applySpaceAction` with `action: setup`, which replaces the junction with a real metadata directory and supports rollback (`src/space-actions.mjs:46-48`, `:80`, `:146-171`).

**Plan**

- 0.11.0: `holoself link --target <dir>` prints a deprecation warning that names the removal version and the replacement, `holoself link setup --project <dir> --self <path>`, on every run, including `--dry-run`. Every `LEGACY_MOUNT_DETECTED` message and `mode: legacy-mount` status adds the same warning. CLI `link setup` gains the Workbench path: when `.holoself` is a junction pointing exactly to the chosen self, it plans and applies the `space-actions` `setup` migration with preview hash and rollback. Junctions pointing anywhere else still fail closed.
- Until 0.13.0, `holoself unlink --target <dir>` keeps working so owners can remove an existing mount without migrating.
- 0.13.0: `link --target` and `unlink --target` are removed. Detection remains permanent and fail-closed, and its message points to `link setup` and manual removal. `export --target` snapshots are unaffected.
- Docs: README delivery modes, [link or export](../guides/link-or-export.md), [filesystem layout](../reference/filesystem-layout.md), [adoption runbook](../guides/adoption-and-rollback-runbook.md), the [CLI reference](../reference/cli.md) and the [terminology](../concepts/terminology.md) mark the mount as deprecated in 0.11.0 and drop it in 0.13.0.

## 5. Alternatives considered

- **Keep every field and document the precedence.** Rejected. The precedence is the problem: four runtime effects of `visibility`, two-way overrides from `public_safe`, two publication functions that disagree, and a migration gate that already models the rules wrongly. Documentation cannot make `_policy.yaml` inheritance safe while legacy fields silently change defaults.
- **Collapse everything into a single `scope` enum.** Rejected. That would reproduce `visibility`'s failure: one value encoding lens set, subject restriction and publication at once. Custom registry lenses and per-lens `sensitivity_access` cannot be expressed in a closed enum. Orthogonal fields map one-to-one onto the phases of `allowedDocument`.
- **Automatic silent migration on read or index.** Rejected. Holoself never rewrites canonical context without review. A silent rewrite would skip the plan hash, receipt, revert and narrowing confirmation, and it would edit files a mount or sync tool might be holding. Runtime compatibility already preserves behaviour until the owner migrates.

## 6. Acceptance criteria

- A test enumerates every deprecated value: each `visibility` (including missing and invalid), `public_safe` true and false, each `field_visibility` value and each claim-marker value (including unknown ones). It runs on synthetic fixtures only, with no personal data. For each, it asserts that the mapped document is never allowed where the legacy document was denied. The evaluation goes through the runtime `frontmatter` parser and `allowedDocument`, over all registry lenses plus a custom lens, `owner:direct` and `client:linked`, `generic`, `public`, `obsidian-public` and `restricted-host`, and resolutions with and without `sensitivity_access`. It also asserts that `publicationAllowed` never becomes true where it was false.
- The same test asserts the exact cases in section 2 produce no narrowing either, and that `planPolicyMigration` reports zero coverage loss for them.
- `verifyNonAmplification` uses the runtime parser and policy functions rather than private copies. Regression tests show it rejects removing `public_safe: false`, rejects planning lenses for `access_lenses: []`, and does not report coverage loss for `visibility: public-safe` mapped to `disclosure: publish-approved`.
- A test shows a migrated former-legacy document under a `_policy.yaml` with `disclosure: publish-approved` and `document_role: policy` keeps its pre-migration decisions.
- A test shows that on every publication adapter, `content`, `sections`, `claims`, `tags` and `links` apply the same sub-document disclosure rule, and that `sections` text is a subset of `content`.
- `holoself validate` emits one deprecation warning per document and field in 0.11.0, and an error in 0.13.0.
- `holoself link --target <dir>` prints the deprecation warning, including under `--dry-run`. CLI `link setup` migrates a junction pointing to the chosen self, with preview, apply and rollback tests, and still refuses a junction pointing elsewhere.
- A `migrate policy` apply followed by a revert restores byte-identical files for fixtures containing every deprecated field.
