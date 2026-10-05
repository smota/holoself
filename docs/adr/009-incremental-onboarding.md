# ADR 009: Incremental Onboarding, Runtime-Owned Installation, and Explicit Legacy/Unknown Migration

- **Status:** Accepted (supersedes previous broad no-legacy policy in `docs/maintainers/breaking-changes.md` specifically via explicit migration)
- **Date:** 2026-09-25
- **Deciders:** Maintainer direction in epic #249; Agy proposal and Codex technical review

## Context

Issue #188 and earlier breaking change notes retired legacy v1 install lockfiles and broad static adapter sync. However, adoption across diverse brownfield environments requires incremental adoption from empty machines through partial, old, or unknown configurations.

Four core architectural requirements arose:

1. **Instruction separation:** The repository's root `AGENTS.md` governs internal development of AgentFlow itself and must never be installed into consumer projects. Consumer guidance must come from a dedicated template (`defaults/AGENTS.md`).
2. **Runtime installation authority:** Runtime installation destinations, package-manager commands, and multi-agent distribution belong to the connected runtime, not AgentFlow's project onboarding code. AgentFlow declares generic requirements; the runtime returns discovery/availability evidence.
3. **Orthogonal readiness:** Runtime readiness, project adoption, and readiness for a governed change are orthogonal dimensions. Tool presence alone proves neither project adoption nor test/governance validity.
4. **Legacy and unknown state recovery:** Malformed or unrecognized lockfiles must not silently overwrite authored files or erase user data, nor should legacy versions be silently accepted without explicit migration.

## Decisions

### 1. Separate Development Policy from Consumer Template

- Root `AGENTS.md` is strictly internal repository policy.
- Consumer adoption seeds from `defaults/AGENTS.md`. Authored consumer instructions and custom workflow rules survive adoption and upgrades.

### 2. Runtime Authority and Generic Handoff

- AgentFlow requests capabilities via generic contracts.
- Runtimes discover and manage host tools/skills in runtime-owned storage.
- Project onboarding writes only scoped project configuration and managed payload files.

### 3. Orthogonal Readiness Model

- System readiness distinguishes three independent axes:
  - `runtimeReady`: Connected runtime provides required tools/skills.
  - `projectReady`: Project contains valid v2 lockfile, valid configuration, and zero unapplied mutations/conflicts.
  - `governedChangeReady`: Changes meet issue contract, verification, and governance gates.

### 4. Transactional Adoption and Root Identity

- Reviewed project adoption uses recoverable transactions: write-ahead journaling (`.agentflow-adoption-journal.json`), staged atomic replacement, and rollback receipts.
- Symlinks and junctions are never traversed for writes.
- Physical device/inode identity (`dev`, `ino`, `realpath`) binds plans to prevent target directory swapping or recreation.
- Repeating apply against an identical state performs zero content mutations and zero lockfile churn.

### 5. Explicit Legacy Migration (Superseding Broad No-Legacy Ban)

- Supersedes the blanket rejection in `docs/maintainers/breaking-changes.md` specifically via explicit migration.
- Exact supported legacy format: JSON object with `version: 1` (or omitted `version`), `files` (mapping safe relative paths to 64-char hex sha256 strings), and `merged` (array of safe relative paths).
- Legacy lockfiles are rejected by default.
- Adoption requires explicit `migrateLegacy: true`, converting legacy entries in-memory into v2 entries without mutating disk until transaction commit.
- Future versions (e.g., `version >= 3`) are strictly distinguished from legacy and rejected under `migrateLegacy`.

### 6. Selective Recovery of Unknown / Malformed Locks (`recoverUnknown`)

- Malformed JSON, future versions, or unrecognized formats are never automatically adopted.
- Adoption requires explicit `recoverUnknown: true` (strictly boolean).
- When `recoverUnknown: true`:
  - Unknown lock is treated as empty ownership in memory.
  - All existing managed files become explicit conflicts requiring per-file resolution (`preserve` or `replace`).
  - Pre-adoption raw lock bytes and hash are bound into the plan token; any subsequent edit invalidates the plan as stale.
  - Lock replacement records original raw bytes in journal and receipt mutations. Rollback restores exact original malformed bytes.
  - Symlinks/junctions on lock files are strictly rejected and never read, written, or recovered.
  - Malformed config (`agent-workflow.config.json`) remains blocked to prevent user data erasure.

## Consequences

- Consumer projects can safely upgrade from legacy v1 setups or recover from corrupted lockfiles without data loss.
- Zero silent mutations: all conflicts require explicit user choice.
- Exact pre-adoption state is verifiable and restorable via transaction receipts.
- Development repository policy remains isolated from consumer installations.
