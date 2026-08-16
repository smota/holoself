# Schemas

Machine-readable contracts:

- [`schemas/link.schema.json`](../../schemas/link.schema.json): project `self_context` link
- [`schemas/adapter-capability.schema.json`](../../schemas/adapter-capability.schema.json): startup adapter capability evidence
- [`schemas/context.schema.json`](../../schemas/context.schema.json): resolved runtime context
- [`schemas/document-metadata.schema.json`](../../schemas/document-metadata.schema.json): canonical Markdown frontmatter
- [`schemas/proposal.schema.json`](../../schemas/proposal.schema.json): proposal lifecycle

Link configuration grants read access and optional proposals. Proposal validation covers UUID, type, state, source paths, target containment, evidence/provenance, confidence, visibility, and reserved markers. Context output preserves sources, restrictions, warnings, and pending proposals.

Canonical Markdown frontmatter is validated by CLI rules and documented by the standalone metadata schema. Legacy `visibility` and `public_safe` remain readable during migration, but new `access_lenses` metadata requires disclosure, sensitivity, and document role.
