# Changelog

All notable Holoself releases are documented here.

## Unreleased

## [0.8.0] — 2026-08-31

Holoself can now meet AI tools inside an already linked project. A local MCP integration gives supported clients typed, on-demand access to bounded self-context without introducing a daemon, hosted account, or second source of truth.

### Context where you work, only when it is useful

- Codex, AGY, and Claude Code can be configured from one previewed `holoself mcp configure` workflow.
- Each client starts a project-bound STDIO subprocess; Holoself does not open a port or keep a background service running.
- Status, manifest, context, and search tools return structured, size-bounded results and reuse the same lens, privacy, lifecycle, and provenance rules as the CLI.
- Manifest-first retrieval lets an AI inspect what is available before requesting selected sources, reducing unnecessary context loading.

### Explicit control remains the default

- `.holoself/link.yaml` remains the project authorization boundary and the only pointer to `HOLOSELF_DATA`.
- MCP tools accept no filesystem paths, cannot broaden the linked lens, and redact private roots from outputs and errors.
- Read tools do not create cache or index files. Search can rebuild a stale index in memory without changing canonical data.
- An AI may create a project-local pending proposal and preview its effect, but it cannot approve it or write canonical self-context.
- BOOTSTRAP instructions, the shared skill, CLI, reviewed snapshots, and Workbench remain available as deterministic fallbacks.

### Safer setup and recovery

- Configuration is project-local, collision-aware, idempotent, and previewable before it writes Codex, AGY, or Claude Code files.
- Existing divergent entries, malformed managed markers, unsafe roots, and symlink or junction parents are refused instead of overwritten.
- A failed multi-client configuration restores existing files byte for byte and removes files created by the failed transaction.
- `holoself mcp status` distinguishes generated configuration from proven native client behavior.

### Platform status at release

Codex and Claude Code have verified native server discovery and status invocation. AGY has verified native discovery in a registered synthetic project; non-interactive invocation remains subject to its normal MCP approval policy. MCP is therefore activated but not yet promoted over the explicit link, shared skill, and CLI as Holoself's cross-platform default.

## [0.7.0] — 2026-08-31

Holoself is now easier to use day to day: you can manage your context through a local Workbench, install its AI skill once instead of copying it into every project, and give AI tools smaller, more relevant context with a clear record of what was shared.

### A local Workbench for managing your context

The optional Holoself Workbench provides a visual interface for the main workflows:

- See whether your self-context and linked projects are healthy.
- Browse independent project spaces and understand their purpose and boundaries.
- Safely edit knowledge and privacy annotations without manipulating raw metadata.
- Review, approve, defer, reject, or supersede proposed knowledge.
- Configure lenses and personal lens instructions.
- Start context-aware conversations through detected local AI tools.
- Follow specific recovery actions when a project is degraded.

The Workbench runs only on your computer, binds to `127.0.0.1`, requires no hosted account, and does not replace the CLI or Markdown source files.

### More relevant context with less unnecessary loading

Holoself now decides whether personal context is required, helpful, or unnecessary for a task.

When context is useful, it:

- Selects sources based on the task, lens, privacy rules, and knowledge lifecycle.
- Uses bounded `small`, `standard`, or `deep` budgets.
- Loads current knowledge by default instead of mixing in outdated material.
- Can return a compact manifest first and expand only selected sources.
- Limits automatic framework injection to the most relevant methods.
- Reuses cached selections when the underlying sources have not changed.

Every selection includes a receipt describing what was selected, the source hashes, estimated size, applied lens and budget, and whether anything was truncated—without copying private document bodies into the receipt.

### Clear lifecycle for knowledge

Personal knowledge can now be marked as current, historical, or superseded. Historical information remains available when explicitly requested, but it no longer appears in normal current-context requests.

Reviewed cleanup is also available. Cleanup plans contain paths, reasons, operations, and hashes—not private document contents. Applying a plan requires the exact approved digest, rejects stale inputs, and produces an immutable receipt. Proposal archives remain protected.

### Install the Holoself skill once

Holoself can install its shared skill at user level instead of creating another copy inside every project.

Existing linked projects can be migrated to this global model through a previewed, transactional workflow. Holoself validates the global installation before removing managed project copies and rolls back if the migration fails.

User-created project overrides and unmanaged file collisions are preserved and reported for review rather than silently overwritten.

### Easier integration with AI tools

Holoself now exposes a small, stable machine-readable interface:

- `capabilities --json` describes the supported local interface.
- `--version --json` reports product and version information.
- `context --self-only` supplies personal context without redundantly including documents already managed by the requesting project or tool.

This makes integration more predictable while keeping Holoself independent of any single AI application.

### Safer context-aware conversations

Workbench connectors can detect supported local CLI, terminal, and desktop tools. Each conversation resolves bounded, lens-filtered context before launching the configured tool.

Executable paths and arguments remain structured, linked spaces are allowlisted, and there is no generic remote-command endpoint.

### Privacy and control remain foundational

- Canonical knowledge stays in local Markdown.
- The CLI performs no network requests.
- The Workbench is loopback-only and optional.
- Stale edits are rejected rather than overwriting newer changes.
- Writes are hash-guarded, validated, and rolled back on failure.
- Durable AI discoveries still require explicit proposal approval.
- Global installation, project migration, cleanup, and corrective actions remain previewed and confirmation-gated.
- Project artifacts remain owned by their projects; only approved reusable knowledge belongs in self-context.

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

[0.8.0]: https://github.com/smota/holoself/releases/tag/v0.8.0
[0.7.0]: https://github.com/smota/holoself/releases/tag/v0.7.0
[0.6.0]: https://github.com/smota/holoself/releases/tag/v0.6.0
[0.5.0]: https://github.com/smota/holoself/releases/tag/v0.5.0
