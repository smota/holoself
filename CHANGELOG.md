# Changelog

All notable Holoself releases are documented here.

## Unreleased

## [0.6.0] — 2026-08-24

- Adds optional private `<data-root>/lenses/*.json` custom-lens registries with strict v1 definitions, deterministic hashes, hard-error semantic validation, exact document grants, explicit sensitivity access, and read-only `lens list|show|validate` commands.
- Advances context packets to schema v2 with normalized lens resolution and registry hash, and indexes to schema v4/privacy-policy v3 so registry changes invalidate freshness without migrating Markdown or links.
- Separates read access (`access_lenses`), public reuse (`disclosure`), handling classification (`sensitivity`), and policy/evidence/content behavior (`document_role`). Untagged canonical documents fail closed; legacy visibility metadata remains conservatively supported.
- Ensures publishing resolution includes governing policy while excluding unapproved evidence and employer-confidential non-policy content. Context packets and search results expose publication eligibility explicitly.
- Replaces blanket native-adapter claims with capability evidence fields and clarifies startup adapters, packet formatters, metadata links, snapshots, and legacy live mounts.
- Adds canonical metadata and adapter capability schemas plus end-to-end privacy/capability tests.
- Adds task selectors and explicit compensation, third-party, recruiter, employer, and application sensitivity categories with fail-closed lens defaults and post-resolution leakage checks.
- Upgrades deterministic index to schema v4/privacy-policy v3 with input/config/registry freshness hashes, automatic stale rebuild for search, and persisted include/exclude build assertions.
- Adds restricted-host packet generation with bounded expiry, packet ids, source hashes, validation metadata, and honest snapshot-only adapter documentation.
- Hardens Windows live activation by normalizing CRLF public skills before managed-section parsing.
- Preserves legacy folded/literal proposal text, `preference_update` records, and terminal audit archives while retaining strict containment for pending proposals.
- Adds activated read-only project links: `link add` detects agent platforms, generates a neutral bootstrap/runtime manifest, injects bounded startup pointers after confirmation, and supports activate/deactivate/repair/doctor lifecycle commands.
- Adds lens/task/privacy-aware context resolution with provenance and Pi, Claude Code, Codex, generic, and Obsidian packet adapters.
- Adds non-mutating overlap/conflict/stale reports and confirmed proposal approval/rejection/defer workflow.
- Adds local deterministic indexing, changed/rebuild/status commands, and provenance-preserving federated search. Markdown remains source of truth; SQLite/FTS remains optional acceleration, not dependency.
- Adds visibility, link, proposal, provenance, duplicate-claim, broken-reference, and generated-view validation plus public JSON schemas.
- Security hardening validates proposal UUIDs/containment/schema/provenance, uses realpath containment for activation writes, preflights and transactionally rolls back adapter changes, protects unmanaged skill shims, detects managed-block drift, cleans markers despite missing runtime metadata, fails closed on malformed control/canonical YAML, conservatively salvages project privacy fields, excludes agent/config/generated trees, preserves metadata collisions, blocks legacy export overwrite, and applies privacy policy to index/search.
- Adds Antigravity activation through `ANTIGRAVITY.md` detection.

## [0.5.0] — 2026-08-13

Holoself v0.5.0 establishes the local-first architecture and public distribution boundary for the first release.

### Architecture

- Markdown-first private data root for profile, context, topics, references, local extensions, and generated exports.
- Versioned `config.json`, public contrib catalog, self-contained context packets, atomic writes, and review-before-save workflow.
- Clear ownership model separates user-private data, Holoself-managed files, project-owned instructions, and package-owned public assets.

### Public contrib library

- Ships a catalogued library of synthetic/public framework defaults under `contribs/default/`.
- `init --contribs`, `--exclude-contrib`, and `upgrade` provide explicit selection and refresh behavior.
- Local contribs remain under the private data root and are never packaged.

### CLI safety

- Migration, linking, and project instruction setup require explicit confirmation (or `--yes` for automation).
- Writes use temporary files and rename; exports are staged and prior exports are backed up.
- Existing non-Holoself paths, symlinks, and junctions are refused rather than replaced. No command sends data, publishes npm, or deploys a site.

### Migration, export, and links

- PersonalOS profile, context, topics, reference, and `me` data map into corresponding private Holoself namespaces without deleting source data.
- Export creates a reviewable `.holoself` project packet containing Markdown profile/context and a context packet; `--packet-only` makes it self-contained.
- `--root-setup` updates bounded markers in project instruction files only after confirmation.
- `link` and `unlink` manage only a link owned by Holoself and pointing at the selected private data root.

### Skill distribution and privacy

- Public `skills/holoself/` instruction is distributed separately from private data and can be installed through skills.sh after review.
- npm package contains source, CLI, public skills/contribs, docs, and release metadata only; private profile, context, topics, references, and local contribs are excluded.
- Project exports and links can expose private context to project tools; review before committing or sharing.

### Tests and known limitations

- Test suite covers initialization, validation, migration safeguards, export refresh and packet-only mode, link safety, contrib selection, and private Markdown boundaries.
- Known limitations: Holoself does not automatically install skills, synchronize data, or provide remote storage; project exports require manual review and each project must be exported separately.

[0.6.0]: https://github.com/smota/holoself/releases/tag/v0.6.0
[0.5.0]: https://github.com/smota/holoself/releases/tag/v0.5.0
