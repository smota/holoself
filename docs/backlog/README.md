# Backlog items

Public backlog items in `docs/backlog/` use dated filenames (`YYYY-MM-DD-<slug>.md`) to record cross-cutting work that spans multiple steps or repositories.

Owner-specific working backlogs and operational notes live in the git-ignored `.local/backlog/` directory (or inside the owner's private self root) and are never committed to the tracked tree.

## Format

Each backlog file includes three required sections:

1. **Goal**: One-paragraph statement of the outcome the backlog batch achieves and what remains out of scope.
2. **Decisions**: Locked design choices, constraints, and non-goals agreed before execution starts.
3. **Cross-repo order**: Ordered list of backlog item IDs (`B-01`, `B-02`, ...) where each item specifies its target project/repository, **Goal** line, and **Depends** line (`none` or prior item IDs).

Keep public backlog files synthetic and machine-independent: do not include personal data, user-home paths, or machine-specific worktree locations.

## Synthetic example (`YYYY-MM-DD-widget-sync.md`)

```markdown
# 2026-10-15 — Widget schema and adapter sync

## Goal

Align the widget manifest schema across `acme-spec` and `acme-cli` so link validation rejects unknown adapter versions before writing project metadata.

## Decisions

- Schema version bumps from `1` to `2` in `acme-spec` before CLI enforcement lands.
- Existing v1 manifests remain readable during dry-run checks with a deprecation warning.
- No network fetches or background migration daemons are introduced.

## Cross-repo order

### B-01 — Publish v2 widget manifest schema (`acme-spec`)
- **Goal**: Add `adapter_version` required integer field and synthetic test fixtures to `schemas/widget-manifest.schema.json`.
- **Depends**: none

### B-02 — Enforce v2 manifest validation on write (`acme-cli`)
- **Goal**: Vendor the updated schema and reject unknown `adapter_version` values during `link repair` and `link activate`.
- **Depends**: B-01

### B-03 — Document migration steps (`acme-docs`)
- **Goal**: Add a synthetic upgrade example showing how to preview and apply the v1-to-v2 manifest update.
- **Depends**: B-02
```
