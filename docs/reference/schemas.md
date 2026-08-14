# Schemas

Machine-readable contracts:

- [`schemas/link.schema.json`](../../schemas/link.schema.json): project `self_context` link
- [`schemas/context.schema.json`](../../schemas/context.schema.json): resolved runtime context
- [`schemas/proposal.schema.json`](../../schemas/proposal.schema.json): proposal lifecycle

Link configuration grants read access and optional proposals. Proposal validation covers UUID, type, state, source paths, target containment, evidence/provenance, confidence, visibility, and reserved markers. Context output preserves sources, restrictions, warnings, and pending proposals.

Current Markdown frontmatter is validated by CLI rules rather than a standalone JSON schema.
