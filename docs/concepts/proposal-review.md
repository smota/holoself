# Proposal and review

Projects cannot silently update canonical self context. They create evidence-backed proposals.

States:

```text
pending → approved | rejected | deferred | superseded
```

Proposal types: `new_fact`, `fact_update`, `fact_correction`, `new_story`, `new_preference`, `new_decision`, `privacy_warning`, `conflict_resolution`.

Approval shows target, evidence, affected files, and proposed diff; requires explicit confirmation; preserves provenance; archives state; and validates afterward. Reject and defer preserve review records.

```bash
node bin/holoself.mjs propose --project C:/work/project --claim "..." --evidence "source evidence" --source-file notes.md
node bin/holoself.mjs proposals list --project C:/work/project
node bin/holoself.mjs proposals show <id> --project C:/work/project
node bin/holoself.mjs proposals approve <id> --project C:/work/project --yes
```

`--yes` is explicit automation consent, not permission for agents to invent facts or evidence.
