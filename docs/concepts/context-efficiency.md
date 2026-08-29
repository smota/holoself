# Context efficiency and receipts

Holoself resolves context progressively. A request is classified as `required`, `helpful`, or `not-needed`; linked agents should avoid personal context for mechanical work. When context is useful, the resolver applies privacy and lifecycle rules before relevance and budget selection.

The default `standard` budget is bounded. `small` and `deep` support lighter or richer work; `unbounded` is an explicit diagnostic mode. `--manifest` returns opaque stable source handles without bodies, and repeatable `--source <handle>` expands reviewed sources. At most two selected public contrib methods are injected for a task. `config.json.selectedContribs` controls availability, not automatic loading.

Every result includes a context receipt: task hash, lens, temporal selector, budget, selected source handles and hashes, estimated tokens, truncation, and cache status. Selection telemetry also carries a content-redacted contradiction digest: explicit supersession edges and source-handle pairs with potentially conflicting metrics under shared headings. Source hashes make refresh incremental and receipts auditable without copying private body text.

```powershell
holoself context --project . --task "prepare the leadership interview" --budget small --manifest --json
holoself context --project . --task "prepare the leadership interview" --budget deep --source hs-... --json
```

Current knowledge is the default. Historical or superseded material requires `--temporal historical|superseded|all`; privacy lenses still apply.
