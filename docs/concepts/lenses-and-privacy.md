# Lenses and privacy

Supported lenses: `general`, `career`, `publishing`, `technical`, `leadership`, `interview`, `private`.

| Task | Typical lens |
|---|---|
| General planning | general |
| Applications and career decisions | career |
| Public content | publishing |
| Architecture and implementation | technical |
| People leadership | leadership |
| Interview preparation | interview |
| Sensitive self-review | private |

Optional frontmatter:

```yaml
---
visibility: private
public_safe: false
sensitivity: employer-confidential
confidence: confirmed
exclude_lenses:
  - publishing
---
```

Visibility values are `private`, `linked-projects`, `career`, `publishing`, and `public-safe`. Publishing excludes employer-confidential and compensation-like content. Private content requires private lens. Field-level policy is supported through frontmatter. Invalid visibility fails validation.

Privacy metadata reduces accidental disclosure; it is not a substitute for reviewing output before publication.
