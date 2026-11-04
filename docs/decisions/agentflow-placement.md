# AgentFlow SDLC framework placement

Status: Accepted (2026-11-04). Issue: #56 (parent: #46).

## Context and problem

`lib/` (~27k LOC), `adapters/openrig/`, `manifests/`, `roles/`, `skills/agentflow-*`, the AgentFlow scripts under `scripts/`, 36 SDLC schemas under `schemas/`, and 24 SDLC pages under `docs/` belong to the vendored AgentFlow SDLC framework (`agentflow-sdlc` 1.10.0, profile `standard`), pinned in [`agent-framework-lock.json`](../../agent-framework-lock.json).

No Holoself product module (`bin/`, `src/`, `web/`) imports `lib/` or any AgentFlow path, and the product runtime has zero dependencies on the framework. Because AgentFlow paths sit at the repository root and share `docs/`, `schemas/`, `scripts/`, and `skills/` with product assets, contributors and coding agents orienting on the repository can mistake SDLC framework modules for product runtime code.

## Options and consequences

1. **Option (a) — Relocate framework files under `.agentflow/` (or another single subdirectory).**
   - *Consequences:* Every entry in `agent-framework-lock.json` pins a fixed `target` path (such as `lib/...`, `adapters/openrig/...`, `roles/...`, `schemas/...`, `docs/...`, `scripts/...`, `skills/agentflow-*`, `AGENTS.md`, `sdlc.config.json`, and `agent-workflow.config.json`) together with its SHA-256 content hash (`managed` or `seed-once` ownership) and has no configurable install root. Moving those files would be reported as lockfile drift by AgentFlow validation and doctor checks, and the next AgentFlow upgrade (#45) would recreate them at their root targets. Internal relative imports across `lib/`, `scripts/`, and `adapters/` also assume root placement.
2. **Option (b) — Install AgentFlow as a pinned external dev tool instead of vendoring.**
   - *Consequences:* Not supported by the current AgentFlow installer, which adopts and upgrades repositories by materializing managed files into the worktree and recording `agent-framework-lock.json`. Removing the vendored files would break AgentFlow doctor/validation and the standard upgrade path (#45).
3. **Option (c) — Keep the vendored AgentFlow SDLC framework at its installer-managed paths and make the product/framework split explicit and enforced.**
   - *Consequences:* Preserves full compatibility with `agent-framework-lock.json` hash verification, AgentFlow doctor, and future upgrades (#45) with zero lockfile drift. Contributors and agents get an explicit top-level classification in [`docs/repository-map.md`](../repository-map.md) linked from [`README.md`](../../README.md) and [`docs/README.md`](../README.md), and automated boundary tests in `tests/repository-boundary.test.mjs` enforce that product code never imports framework paths and that the repository map stays complete. Mixed directories (`docs/`, `schemas/`, `scripts/`, `skills/`) remain shared on disk until upstream supports an install prefix.

## Decision

**Option (c) — keep the vendored AgentFlow SDLC framework at its installer-managed paths and make the product/framework split explicit and enforced.**

Rationale: `agent-framework-lock.json` (AgentFlow 1.10.0, profile `standard`) pins every framework file to a fixed target path with a content hash and has no configurable install root; relocating (a) would be reported as drift and undone by the next upgrade (#45), and installing as an external dev tool (b) is not supported by the current installer. Revisit if AgentFlow adds an install prefix — noted below as an upstream request.

## Follow-ups

- Maintain [`docs/repository-map.md`](../repository-map.md) as the top-level index of Product, Product tooling, AgentFlow-managed, and Owner-local paths.
- Enforce the product/framework boundary in `tests/repository-boundary.test.mjs` as part of `npm test` and `npm run verify`:
  - No module under `bin/`, `src/`, or `web/` may import from `lib/`, `adapters/`, `roles/`, `.agentflow/`, or any target listed in `agent-framework-lock.json`.
  - No `package.json` `files` entry may be an AgentFlow lockfile target or point under `lib/`.
  - Every tracked top-level path (`git ls-files`) must appear in `docs/repository-map.md`, and every path named there must exist (or be git-ignored owner-local state).
  - `docs/README.md` must link every decision record in `docs/decisions/`.
- **Upstream request (AgentFlow):** add a configurable install prefix (for example `.agentflow/framework/`) to `agent-framework-lock.json` and the AgentFlow installer/migrator so consuming repositories can isolate managed framework files from top-level product directories. Revisit Option (a) if upstream adds prefix support during or after #45.
