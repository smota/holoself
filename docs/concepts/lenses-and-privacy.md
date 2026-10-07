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

Explicit document, claim and field access apply to every lens. Definitions control sensitivity categories. `disclosure` and `publication_allowed` remain descriptive metadata. `public-voice` applies no special publication eligibility or compensation filter. Reading context does not authorize external actions. Public and restricted-host adapters retain their explicit snapshot handling contract.

Legacy `visibility`, `public_safe`, `exclude_lenses`, and `field_visibility` remain readable. Canonical documents need modern controls or valid legacy visibility. `knowledge migrate-lenses` previews exact conversion from `career` to `professional` and `publishing` to `public-voice`, including claim markers. Ordinary prose and proposal archives remain intact. See [CLI](../reference/cli.md) and [migration](../guides/migration.md).
