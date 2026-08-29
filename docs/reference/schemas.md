# Schemas

Machine-readable contracts:

- [`schemas/lens.schema.json`](../../schemas/lens.schema.json): private custom-lens definition
- [`schemas/link.schema.json`](../../schemas/link.schema.json): project `self_context` link
- [`schemas/adapter-capability.schema.json`](../../schemas/adapter-capability.schema.json): startup adapter capability evidence
- [`schemas/context.schema.json`](../../schemas/context.schema.json): resolved runtime context
- [`schemas/document-metadata.schema.json`](../../schemas/document-metadata.schema.json): canonical Markdown frontmatter
- [`schemas/index.schema.json`](../../schemas/index.schema.json): deterministic index freshness and assertion contract
- [`schemas/proposal.schema.json`](../../schemas/proposal.schema.json): proposal lifecycle

Link configuration grants read access and optional proposals. Proposal validation covers backward-compatible single-change records and schema-v2 grouped changes, UUID, type, state, source paths, target containment, evidence/provenance, confidence, visibility, and reserved markers. Context output preserves packet generation/expiry metadata, bounded selection telemetry, receipt and cache evidence, source hashes, restrictions, warnings, leakage validation, lifecycle state, and pending proposals. Document metadata additionally supports `knowledge_status`, temporal validity/review dates, and supersession references.

Lens references are structurally validated as lowercase kebab IDs of at most 40 characters; the CLI then semantically requires each ID to resolve from built-ins or the selected self registry. Canonical Markdown frontmatter is validated by CLI rules and documented by the standalone metadata schema. Legacy `visibility` and `public_safe` remain readable during migration, but new `access_lenses` metadata requires disclosure, sensitivity, and document role.
