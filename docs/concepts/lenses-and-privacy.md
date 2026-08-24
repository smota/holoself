# Lenses and privacy

Built-in lenses: `general`, `career`, `publishing`, `technical`, `leadership`, `interview`, `private`.

## Custom lens registry

A private self root may add typed definitions under `<data-root>/lenses/*.json`. A missing directory is valid. Use `lens list`, `lens show <id>`, and `lens validate` to inspect the effective built-in plus custom vocabulary.

```json
{
  "schema_version": 1,
  "id": "client-advisory",
  "title": "Client advisory",
  "base_lens": "publishing",
  "sensitivity_access": ["employer-confidential"]
}
```

IDs are lowercase kebab-case, begin with a letter, and are at most 40 characters. Bases are built-in and affect safe filtering behavior only: they never grant access. A canonical document must explicitly include the custom ID in `access_lenses`. Custom lenses receive no confidential sensitivity access by default; allowed categories must be listed, and `restricted` is never available to custom lenses in v1. Unknown, duplicate, malformed, or unsafe definitions fail closed.

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
- `sensitivity` classifies handling risk: `public`, `personal`, `compensation-confidential`, `third-party-personal`, `recruiter-confidential`, `employer-confidential`, `application-private`, `restricted`, or `none`. `personal` does not automatically block a permitted lens.
- `document_role` distinguishes `policy`, `evidence`, and ordinary `content`.
- Optional `task_include` and `task_exclude` string lists narrow use by explicit task text. `task_include` without matching `--task` fails closed.

Readability is never publication approval. A metadata link grants read access only. `linked-projects` visibility does not mean `publish-approved`.

Publishing resolution always includes readable `policy` documents, even when their disclosure is `internal-only`, because policy governs output rather than supplying publishable facts. Unapproved `evidence` is excluded from publishing context. Other readable, unapproved content is marked `publication_allowed: false` and receives an explicit restriction. Confidential sensitivity categories are never publication-eligible, even when disclosure metadata is mistakenly permissive.

Sensitivity defaults narrow lenses: compensation, recruiter, and application-private material to career/interview/private; third-party personal material to leadership/private; employer-confidential material to career/technical/leadership/interview/private; and restricted material to private. Policy documents may still be read where their access lens permits because they constrain output rather than provide facts.

## Legacy metadata

`visibility`, `public_safe`, `exclude_lenses`, and `field_visibility` remain supported for migration. Mapping is conservative:

- `public-safe` or `public_safe: true` maps to `publish-approved`.
- Other legacy visibility values grant reading only; they do not grant publication.
- Unknown legacy sensitivity strings resolve conservatively as `restricted` but fail validation until migrated to a supported value.
- Canonical files with neither `access_lenses` nor legacy `visibility` fail closed during context resolution and fail validation.
- New files using `access_lenses` must also declare `disclosure`, `sensitivity`, and `document_role`.

Privacy metadata reduces accidental disclosure; review remains required before publication.
