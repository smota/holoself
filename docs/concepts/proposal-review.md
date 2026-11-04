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

Every change also has `change_id`, `target` (default `context/claims.md`) and `proposal_type`. The default type is `new_fact` for append, `fact_correction` for replace and `fact_update` for supersede and retire. Unknown fields are rejected. Replace, supersede and retire need explicit evidence.

### Claim identity

Approved claim blocks carry a stable id in their marker: `<!-- holoself-claim visibility=private id=<uuid> -->`. New claims get an id derived from the proposal id and `change_id`, so the preview is deterministic. Claims approved before ids existed have none in the file. Their id is computed from the target path and the normalized claim wording, and it is written into the marker only when an approved proposal targets that claim. Holoself never rewrites claim files in bulk.

Delivered context shows the id on every claim block the lens can see, including that computed id for older claims, so agents can reference a claim they have read. Claims hidden by visibility are removed before delivery, so their ids never appear.

A replace, supersede or retire change is refused when the claim id is not found in the target, matches more than one block, or the claim is already superseded or retired (`CLAIM_NOT_FOUND`, `CLAIM_AMBIGUOUS`, `CLAIM_NOT_CURRENT`). Replace and supersede are refused when the new wording equals the old (`CLAIM_UNCHANGED`). Holoself checks this when you create the proposal and again at preview and approval. The target must be Markdown under `profile`, `context`, `reference`, `contribs` or `topics`.

### Preview, approval and receipts

The preview lists each change with `operation`, `claim_id`, the target's `before_sha256` and `after_sha256`, the exact `before_block` and `after_block`, and a `-`/`+` diff. Several changes to the same file are applied in order, each to the result of the one before. `proposals approve --preview-hash <hash>` fails with `STALE_PREVIEW` when the hash no longer matches, and approval also fails with `STALE_PREVIEW` when a target changed after the preview was computed. Any failure during or after the writes restores every target. The receipt lists each change with its `operation`, `target`, `claim_id`, `before_sha256` and `after_sha256`.

`proposals show` prints one comment line per change above the YAML record when a proposal uses replace, supersede or retire. The Workbench review list and preview show each change's operation.

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

MCP clients can create and preview every operation with `holoself_proposal_create` and `holoself_proposal_preview`. MCP can target only claims that the link's own lenses deliver. Any other claim id is reported as `CLAIM_NOT_FOUND`, and MCP cannot preview a proposal that targets a claim it cannot see. MCP has no approval tool.
