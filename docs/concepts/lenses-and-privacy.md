# Lenses and privacy

Supported lenses: `general`, `career`, `publishing`, `technical`, `leadership`, `interview`, `private`.

| Task | Typical lens |
|---|---|
| General planning | general |
| Applications and career decisions | career |
| Public content preparation | publishing |
| Architecture and implementation | technical |
| People leadership | leadership |
| Interview preparation | interview |
| Sensitive self-review | private |

## Independent controls

Canonical Markdown uses four independent controls:

```yaml
---
access_lenses:
  - publishing
  - private
disclosure: review-required
sensitivity: personal
document_role: evidence
confidence: confirmed
---
```

- `access_lenses` answers **which tasks may read this document**.
- `disclosure` answers **whether document facts may be reproduced publicly**: `internal-only`, `review-required`, or `publish-approved`.
- `sensitivity` classifies handling risk: `public`, `personal`, `employer-confidential`, `restricted`, or `none`. `personal` does not automatically block a permitted lens.
- `document_role` distinguishes `policy`, `evidence`, and ordinary `content`.

Readability is never publication approval. A metadata link grants read access only. `linked-projects` visibility does not mean `publish-approved`.

Publishing resolution always includes readable `policy` documents, even when their disclosure is `internal-only`, because policy governs output rather than supplying publishable facts. Unapproved `evidence` is excluded from publishing context. Other readable, unapproved content is marked `publication_allowed: false` and receives an explicit restriction. Employer-confidential content remains excluded from publishing context.

## Legacy metadata

`visibility`, `public_safe`, `exclude_lenses`, and `field_visibility` remain supported for migration. Mapping is conservative:

- `public-safe` or `public_safe: true` maps to `publish-approved`.
- Other legacy visibility values grant reading only; they do not grant publication.
- Unknown legacy sensitivity strings resolve conservatively as `restricted` but fail validation until migrated to a supported value.
- Canonical files with neither `access_lenses` nor legacy `visibility` fail closed during context resolution and fail validation.
- New files using `access_lenses` must also declare `disclosure`, `sensitivity`, and `document_role`.

Privacy metadata reduces accidental disclosure; review remains required before publication.
