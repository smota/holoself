# Proposal and review

Projects cannot silently update canonical self context. They create evidence-backed proposals.

States:

```text
pending → approved | rejected | deferred | superseded
```

Proposal types: `new_fact`, `fact_update`, `fact_correction`, `new_story`, `new_preference`, `preference_update`, `new_decision`, `privacy_warning`, `conflict_resolution`. `preference_update` remains supported for existing reviewed proposal records.

Schema-v2 proposals group one or more typed changes under one review decision while schema-v1 records remain readable. Approval computes an exact preview hash, applies all targets transactionally, restores every target on failure, preserves provenance per `change_id`, archives state, and validates afterward. `proposals audit` reports malformed and unmanaged inbox files without exposing their bodies or hiding valid proposals. Reject, defer, and supersede preserve review records. Pending proposals require contained relative source and target paths; terminal review records may retain historical external evidence paths or multi-target summaries because they are audit-only and cannot be applied again.

## Change operations

| Operation | Fields | Effect on the target |
| --- | --- | --- |
| `append_claim` | `claim`, `evidence`, `confidence`, `visibility` | Appends a new claim block. |
| `replace_claim` | `claim_id`, `claim`, `evidence`, `confidence`, optional `visibility` | Rewrites the claim in place and keeps its id. Use it for corrections; the old wording survives only in the receipt hashes and the review archive. |
| `supersede_claim` | `claim_id`, `claim`, `evidence`, `confidence`, optional `visibility` | Appends a new claim with `supersedes=<old id>` and marks the old block `status=superseded superseded_by=<new id> superseded_at=<time>`. The old wording stays in the file as history. |
| `retire_claim` | `claim_id`, `reason` (one line), `evidence` | Marks the claim `status=historical retired_at=<time>` and adds `Retired`, `Retirement reason`, `Retirement evidence` and `Retirement provenance` lines. The wording stays in the file. |

Every change also has `change_id` (lowercase letters, digits, `_` and `-`, at most 64 characters, matching `^[a-z0-9][a-z0-9_-]{0,63}$`), `target` (default `context/claims.md`) and `proposal_type`. The default type is `new_fact` for append, `fact_correction` for replace and `fact_update` for supersede and retire. Unknown fields are rejected. Replace, supersede and retire need explicit evidence. No proposal text, `change_id` included, may contain a claim marker.

### Claim identity

Approved claim blocks carry a stable id in their marker: `<!-- holoself-claim access_lenses=private disclosure=review-required id=<uuid> -->`. New claims get an id derived from the proposal id and `change_id`, so the preview is deterministic. Claims approved before ids existed have none in the file. Their id is computed from the target path and the normalized claim wording, and it is written into the marker only when an approved proposal targets that claim. Approval never rewrites other claims. `holoself migrate policy` rewrites marker attributes through its own reviewed plan, and that leaves claim ids unchanged.

Delivered context shows the id on every claim block the lens can see, including that computed id for older claims, so agents can reference a claim they have read. Claims hidden by their rule are removed before delivery, so their ids never appear.

Claim markers are parsed regardless of spacing (including invisible format characters such as zero-width spaces, joiners, BOM and non-breaking spaces), letter case and attribute order. A marker that does not parse cleanly fails closed: Holoself treats the block as private and historical. Unclean markers include an unknown or repeated attribute, a missing `visibility`, an invalid `status` or `id`, and a marker nested in another block. Delivery and the catalog also drop everything after an opening marker that is never closed, and the text between the previous block and a closing marker that has no opener. Validation reports malformed markers and opening and closing markers that do not pair up, so approval refuses to run on such a self root until it is repaired.

A replace, supersede or retire change is refused when the claim id is not found in the target, matches more than one block, or the claim is already superseded or retired (`CLAIM_NOT_FOUND`, `CLAIM_AMBIGUOUS`, `CLAIM_NOT_CURRENT`). Replace and supersede are refused when the new wording equals the old (`CLAIM_UNCHANGED`). Holoself checks this when you create the proposal and again at preview and approval. The target must be Markdown under `profile`, `context`, `reference`, `contribs` or `topics`.

### Preview, approval and receipts

The preview lists each change with `operation`, `claim_id`, `evidence`, `visibility_change` (`{from, to}` when a replace or supersede changes visibility, else `null`; the CLI prints `! visibility: <from> → <to>`), the `before_sha256` and `after_sha256` of the file as that change found and left it (so hashes chain across several changes to one file), the exact `before_block` and `after_block`, and a `-`/`+` diff. Several changes to the same file are applied in order, each to the result of the one before. `proposals approve --preview-hash <hash>` fails with `STALE_PREVIEW` when the hash no longer matches, and approval also fails with `STALE_PREVIEW` when a target changed after the preview was computed. The stale check, the writes, archiving and validation run under the self root's registry lock. Any failure during or after the writes restores every target. The approval time is written through a placeholder unique to the proposal, so literal `<commit-time>` text in claims or files is left alone. The receipt lists each change with its `operation`, `target`, `claim_id`, `before_sha256` and `after_sha256`.

`proposals show` prints one comment line per change above the YAML record when a proposal uses replace, supersede or retire. The Workbench review list and preview show each change's operation.

### Cross-space review inbox and batch actions

The Workbench review inbox (`GET /api/inbox?space=all|<space>&limit=<n>&offset=<n>`) lists pending proposals across cataloged linked spaces (matching catalog `space_id` first, then `space` name; never arbitrary filesystem paths) with `space_id`, space names and root-relative targets (never absolute paths), per-item `claim_preview`, `visibility_change`, deterministic complete-linkage `duplicate_group` clusters (claims where every pair in the cluster has normalized token `similarity >= 0.72`, preventing transitive `A~B, B~C` chaining), and capped `conflict_hints` (up to the top 3 hints per item by score, with short excerpts `<= 200` characters, covering existing current claims in the target that contradict per `contradictionDigest` / differing metrics, duplicate current claims, or competing pending proposals on the same `claim_id`). Groups list proposal IDs only (`item_ids`) and key space groups by `space_id`. Responses cap items at 200 by default and report `total`, `limit`, `offset`, `truncated`, and `next_offset`. Full diff previews and `preview_hash` values are computed lazily when an item is expanded via `POST /api/proposals/<id>/preview`.

Batch actions (`POST /api/inbox/batch` with `{action: "approve"|"reject"|"defer", items: [{id, space, preview_hash}]}` and CLI `proposals approve <id> <id> ... --yes`) cap batches at 50 items, refuse batches mixing spaces with different canonical self roots (`MIXED_SELF_ROOTS`), require a fresh 64-character hex `preview_hash` for each approved item, and execute all-or-nothing under one `withRegistryLock`. Each item's user-supplied `preview_hash` attests the pre-batch canonical file state that the reviewer inspected before submitting the batch. When multiple items in the same batch modify the same target file, their changes apply sequentially in batch order: each approval receipt (`proposals/receipts/<id>-approved.json`) records both `preview_sha256` (the reviewer's pre-batch `preview_hash` attestation) and `batch_preview_sha256` (the chained per-item preview hash computed against the file state that item actually applied to), alongside the chained `before_sha256` and `after_sha256` in `applied_changes`. If any item is stale, conflicts on the same `claim_id`, or fails during write or post-approval validation, every target file (including newly created empty directories), proposal file, archive and receipt in the batch is rolled back; if any restore itself fails, rollback still attempts every remaining restore and fails with `ROLLBACK_INCOMPLETE` listing the affected root-relative paths.

The review inbox covers project proposal stores in cataloged linked spaces only. Proposals that desktop MCP clients write to the self-root client inbox (`<self>/proposals/inbox/`, provenance `client:<id>`) are not listed by `GET /api/inbox` and cannot be resolved by `POST /api/inbox/batch`; review them with `holoself proposals … --inbox --root <self>` or the Workbench `?inbox=1` / `inbox: true` proposal routes, one id at a time, so the revoked-client approval gate (`--allow-revoked`) always applies. A multi-id `--inbox` approval is refused with `INVALID_INPUT`.

```bash
node bin/holoself.mjs propose --project C:/work/project --claim "..." --evidence "source evidence" --source-file notes.md
node bin/holoself.mjs propose --project C:/work/project --op supersede --claim-id <id> --claim "..." --evidence "..." --source-file notes.md
node bin/holoself.mjs propose --project C:/work/project --op retire --claim-id <id> --reason "..." --evidence "..." --source-file notes.md
node bin/holoself.mjs proposals list --project C:/work/project
node bin/holoself.mjs proposals audit --project C:/work/project
node bin/holoself.mjs proposals show <id> --project C:/work/project
node bin/holoself.mjs proposals approve <id> --project C:/work/project --yes
```

`--yes` is explicit automation consent, not permission for agents to invent facts or evidence.

MCP clients can create and preview every operation with `holoself_proposal_create` and `holoself_proposal_preview`. MCP can target only claims that the link's own lenses deliver. Any other claim id is reported as `CLAIM_NOT_FOUND`, also when previewing a proposal that targets a claim it cannot see. Through MCP, the duplicate and ambiguity checks consider only claims the link can read, so their errors never confirm hidden wording. The full checks run again at local approval. MCP has no approval tool.
