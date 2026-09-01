# Proposal and review

Projects cannot silently update canonical self context. They create evidence-backed proposals.

States:

```text
pending → approved | rejected | deferred | superseded
```

Proposal types: `new_fact`, `fact_update`, `fact_correction`, `new_story`, `new_preference`, `preference_update`, `new_decision`, `privacy_warning`, `conflict_resolution`. `preference_update` remains supported for existing reviewed proposal records.

Schema-v2 proposals group one or more typed `append_claim` changes under one review decision while schema-v1 records remain readable. Approval computes an exact preview hash, applies all targets transactionally, restores every target on failure, preserves provenance per `change_id`, archives state, and validates afterward. `proposals audit` reports malformed and unmanaged inbox files without exposing their bodies or hiding valid proposals. Reject, defer, and supersede preserve review records. Pending proposals require contained relative source and target paths; terminal review records may retain historical external evidence paths or multi-target summaries because they are audit-only and cannot be applied again.

```bash
node bin/holoself.mjs propose --project C:/work/project --claim "..." --evidence "source evidence" --source-file notes.md
node bin/holoself.mjs proposals list --project C:/work/project
node bin/holoself.mjs proposals audit --project C:/work/project
node bin/holoself.mjs proposals show <id> --project C:/work/project
node bin/holoself.mjs proposals approve <id> --project C:/work/project --yes
```

`--yes` is explicit automation consent, not permission for agents to invent facts or evidence.
