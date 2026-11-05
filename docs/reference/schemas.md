# Schemas

Machine-readable contracts:

Proposed D00 contracts, not active runtime interfaces: [evidence v1](../../schemas/evidence-v1.schema.json) and [coaching v1](../../schemas/coaching-v1.schema.json). See their [decisions, coverage and acceptance boundaries](../specifications/evidence-contract-v1.md).

- [`schemas/lens.schema.json`](../../schemas/lens.schema.json): self-side lens definition
- [`schemas/link.schema.json`](../../schemas/link.schema.json): project link: root `project_key` and `self_context` with `self_id` or legacy `path` (`cache_limit_entries` and `cache_limit_bytes` are deprecated and ignored)
- [`schemas/selves.schema.json`](../../schemas/selves.schema.json): per-machine self map (`selves.json`, `self_id` to checkout path)
- [`schemas/links-registry.schema.json`](../../schemas/links-registry.schema.json): per-machine attestation registry (`.holoself/links.json`), with `project_key` when known
- [`schemas/adapter-capability.schema.json`](../../schemas/adapter-capability.schema.json): startup adapter capability evidence
- [`schemas/context.schema.json`](../../schemas/context.schema.json): resolved runtime context
- [`schemas/document-metadata.schema.json`](../../schemas/document-metadata.schema.json): canonical Markdown frontmatter, including `field_access` rules (`field_visibility` is deprecated)
- [`schemas/policy-defaults.schema.json`](../../schemas/policy-defaults.schema.json): directory-level privacy policy defaults (`_policy.yaml`)
- [`schemas/catalog.schema.json`](../../schemas/catalog.schema.json): deterministic incremental catalog, schema version 5. An element keeps its deprecated `visibility` label and carries `access_rule` only when no label states its rule exactly
- [`schemas/context-decision-cache.schema.json`](../../schemas/context-decision-cache.schema.json): content-free context decision cache (deprecated; on-disk decision cache removed)
- [`schemas/proposal.schema.json`](../../schemas/proposal.schema.json): proposal lifecycle

Link configuration grants read access and optional proposals. Proposal validation covers backward-compatible single-change records and schema-v2 grouped changes, UUID, type, state, source paths, target containment, evidence/provenance, confidence, visibility, and reserved markers. Context output preserves packet generation/expiry metadata, bounded selection telemetry, receipt and cache evidence, source hashes, restrictions, warnings, leakage validation, lifecycle state, and pending proposals. Document metadata additionally supports `knowledge_status`, temporal validity/review dates, and supersession references.

Lens references are structurally validated as lowercase kebab IDs of at most 40 characters; the CLI then semantically requires each ID to resolve from the selected self registry. Canonical Markdown frontmatter is validated by CLI rules and documented by the standalone metadata schema. Legacy `visibility` and `public_safe` remain readable during migration, but new `access_lenses` metadata requires disclosure, sensitivity, and document role.

Project lens choices use [lens-bindings.schema.json](../../schemas/lens-bindings.schema.json), keyed by `project_key` (legacy entries by absolute project path). A self root's `config.json` carries `self_id` (`hs-self-<32 lowercase hex>`); `validate` rejects any other format. See [portable links](../decisions/portable-links.md). Exact reviewed maintenance plans use [maintenance-plan.schema.json](../../schemas/maintenance-plan.schema.json).

Maintenance plan kinds are `lens-migration`, `section-replacement`, and `instruction-replacement`. The CLI additionally enforces the allowed roots, exact target types, stale-byte checks and protected archives for each kind.
