# Repository map

Holoself ships a dependency-free Node.js CLI, local MCP server, local Workbench UI, declarative skill, schemas, templates, and synthetic default contrib library (`holoself-ai` on npm). Alongside the product, this repository vendors the **AgentFlow SDLC** framework (`agentflow-sdlc` 1.10.0, profile `standard`, pinned in `agent-framework-lock.json`). See the [AgentFlow placement decision](decisions/agentflow-placement.md) for why framework files remain at their installer-managed paths.

Product runtime code (`bin/`, `src/`, `web/`) never imports from `lib/` or any AgentFlow-managed path. That boundary and this map are verified by `tests/repository-boundary.test.mjs`.

## Top-level directory and file classification

| Top-level path | Classification | Purpose and ownership |
|---|---|---|
| `bin/` | Product | Shipped CLI entrypoint (`bin/holoself.mjs`). |
| `src/` | Product | Shipped product runtime modules (CLI, context, lenses, links, catalog/index, search, proposals, coaching, local STDIO MCP server, Workbench HTTP server). Zero external or AgentFlow imports. |
| `web/` | Product | Shipped local Workbench browser application (`web/index.html`, `web/app.mjs`, `web/styles.css`). |
| `contribs/` | Product | Shipped synthetic/public default framework library (`contribs/catalog.json`, `contribs/default/`). |
| `templates/` | Product | Shipped Markdown and configuration seed templates used by `holoself init` and project links. |
| `package.json` | Product | npm package manifest (`holoself-ai`), `files` allowlist, and verification scripts. |
| `README.md` | Product | Shipped package and repository overview. |
| `CHANGELOG.md` | Product | Shipped release history. |
| `PRIVACY.md` | Product | Shipped privacy policy. |
| `LICENSE` | Product | Shipped MIT license. |
| `skills/` | Mixed (Product + AgentFlow-managed) | **Product (shipped):** `skills/holoself/SKILL.md`. **AgentFlow-managed (19 lockfile targets):** `skills/agentflow-auditor/`, `skills/agentflow-collaborator/`, `skills/agentflow-designer/`, `skills/agentflow-maintainer/`, `skills/agentflow-migrator/`, `skills/agentflow-orchestrator/`, `skills/agentflow-scanner/`, `skills/agentflow-steerer/`. |
| `schemas/` | Mixed (Product + AgentFlow-managed) | **Product (15 schemas):** listed in [Product schemas](#product-schemas) below. **AgentFlow-managed (36 lockfile targets):** SDLC, delivery, role, skill, council, onboarding, and oracle schemas pinned in `agent-framework-lock.json`. |
| `docs/` | Mixed (Product + AgentFlow-managed) | **Product:** `docs/README.md`, `docs/repository-map.md`, `docs/architecture.md`, `docs/linked-ecosystem.md`, `docs/migration.md`, `docs/ownership.md`, `docs/usage.md`, `docs/web-gui.md`, and `docs/{assets,backlog,concepts,contributing,decisions,guides,reference,releases,reports,specifications,start,trust,workbench}/`. **AgentFlow-managed (24 lockfile targets):** SDLC pages under `docs/` and `docs/{adopters,adr,providers,roles,sources}/` (indexed under *AgentFlow SDLC* in [docs/README.md](README.md#agentflow-sdlc)). |
| `scripts/` | Mixed (Product tooling + AgentFlow-managed) | **Product tooling:** `scripts/verify.mjs`, `scripts/run-tests.mjs`, `scripts/package-audit.mjs`, `scripts/generate-reference.mjs`, and research/evaluation harnesses (`scripts/c00-baseline.mjs`, `scripts/evidence-spike.mjs`, `scripts/evidence-docling-spike.py`, `scripts/evidence-supervisor-linux.sh`, `scripts/evidence-supervisor-windows.ps1`). **AgentFlow-managed (8 lockfile targets):** `scripts/probe-environment.mjs`, `scripts/provider-status.mjs`, `scripts/role-collaboration-smoke.mjs`, `scripts/role-collaboration.mjs`, `scripts/run-delivery.mjs`, `scripts/validate-path-ownership.mjs`, `scripts/validate-role-catalog.mjs`, `scripts/validate-skill-catalog.mjs`. |
| `tests/` | Product tooling | Node `--test` test suite (`tests/*.test.mjs`), helpers (`tests/helpers/`), and synthetic fixtures (`tests/fixtures/`). Not shipped in the npm package. |
| `.github/` | Product tooling | GitHub Actions workflows (`.github/workflows/verify.yml`, `.github/workflows/release.yml`), issue templates, and pull-request template. |
| `CONTRIBUTING.md` | Product tooling | Contributor workflow, verification commands, and pull-request checklist. |
| `.gitignore` | Product tooling | Git ignore rules for local state, agent harnesses, and `.local/`. |
| `.gitattributes` | Product tooling | Git line-ending normalization rules. |
| `.pi/` | Product tooling | Tracked subagent evaluation artifacts under `.pi/subagents/artifacts/` (new local Pi state is git-ignored). |
| `lib/` | AgentFlow-managed | 101 AgentFlow SDLC framework modules (`lib/{adoption,application,config,core,observability,onboarding,providers,runtime,services,sources,verification}/` and top-level `lib/*.mjs`). All 101 files are pinned in `agent-framework-lock.json`. Never imported by Holoself product code or shipped in the npm package. |
| `adapters/` | AgentFlow-managed | OpenRig SDLC adapter modules (`adapters/openrig/incident-evidence.mjs`, `platform-fallback.mjs`, `recovery.mjs`) pinned in `agent-framework-lock.json`. |
| `roles/` | AgentFlow-managed | 11 AgentFlow role contracts (`roles/{analyst,architect,developer,implementation-planner,pr-readiness,product-manager,qa-expert,requester,reviewer,technical-writer,tester}/ROLE.md`) pinned in `agent-framework-lock.json`. |
| `manifests/` | AgentFlow-managed | 7 AgentFlow catalog and profile manifests pinned in `agent-framework-lock.json` (`composition-profiles.json`, `execution-distributions/subscription-balanced-v1.json`, `method-catalog.json`, `product-payload.json`, `role-catalog.json`, `runtime-platforms.json`, `skill-catalog.json`) plus `manifests/path-ownership.json`. |
| `.agentflow/` | AgentFlow-managed | Harness role projections (`.agentflow/roles/{agy,claude-code,codex,pi}/`), catalogs/policy configs (`.agentflow/*.json`), and delivery scope records (`.agentflow/delivery/`). |
| `agent-framework-lock.json` | AgentFlow-managed | Lockfile pinning all 217 managed and `seed-once` AgentFlow 1.10.0 (`standard` profile) target paths and SHA-256 hashes. |
| `agent-workflow.config.json` | AgentFlow-managed | AgentFlow workflow configuration (`seed-once` target in `agent-framework-lock.json`). |
| `sdlc.config.json` | AgentFlow-managed | AgentFlow SDLC configuration (`seed-once` target in `agent-framework-lock.json`). |
| `AGENTS.md` | AgentFlow-managed | Repository agent instructions (`seed-once` target in `agent-framework-lock.json`, customized for Holoself). |
| `.local/` | Owner-local | Git-ignored owner-specific working notes (such as `.local/backlog/`). Never tracked in Git or packaged. |

## Product schemas

Of the 51 JSON schemas in `schemas/`, these 15 belong to the Holoself product (documented in [docs/reference/schemas.md](reference/schemas.md) and exercised by `tests/`):

- `schemas/adapter-capability.schema.json` — startup adapter capability evidence
- `schemas/catalog.schema.json` — deterministic incremental catalog
- `schemas/coaching-v1.schema.json` — local coaching cycle contract (`tests/evidence-contract.test.mjs`)
- `schemas/context-decision-cache.schema.json` — content-free context decision cache (deprecated)
- `schemas/context.schema.json` — resolved runtime context packet
- `schemas/document-metadata.schema.json` — canonical Markdown frontmatter
- `schemas/evidence-v1.schema.json` — evidence ownership and revision contract (`tests/evidence-contract.test.mjs`)
- `schemas/lens-bindings.schema.json` — self-side project lens bindings (`tests/docs.test.mjs`)
- `schemas/lens.schema.json` — self-side lens definition (`tests/evidence-contract.test.mjs`)
- `schemas/link.schema.json` — project `.holoself/link.yaml` contract
- `schemas/links-registry.schema.json` — self-side linked spaces registry
- `schemas/maintenance-plan.schema.json` — digest-bound maintenance plan
- `schemas/migration-plan.schema.json` — legacy access-policy/lens migration plan
- `schemas/migration-receipt.schema.json` — migration execution receipt
- `schemas/proposal.schema.json` — proposal review lifecycle (`tests/evidence-contract.test.mjs`)

The remaining 36 files in `schemas/` are AgentFlow-managed targets listed in `agent-framework-lock.json`.

## AgentFlow-managed targets by top-level path

Running `jq -r '.entries[].target' agent-framework-lock.json` yields 217 framework-managed files across 11 top-level paths:

| Top-level path | Lockfile target count | Ownership mode | Notes |
|---|---:|---|---|
| `AGENTS.md` | 1 | `seed-once` | Repository root agent instructions |
| `adapters/` | 3 | `managed` | `adapters/openrig/*.mjs` |
| `agent-workflow.config.json` | 1 | `seed-once` | Workflow configuration |
| `docs/` | 24 | `managed` (23), `seed-once` (`docs/stack-conventions.md`) | Mixed directory; only these 24 SDLC pages are AgentFlow-managed |
| `lib/` | 101 | `managed` | Entire directory is AgentFlow-managed |
| `manifests/` | 7 | `managed` | `manifests/path-ownership.json` is repo-tracked alongside the 7 lock targets |
| `roles/` | 11 | `managed` | Entire directory is AgentFlow-managed |
| `schemas/` | 36 | `managed` | Mixed directory; the other 15 schemas are Holoself product schemas |
| `scripts/` | 8 | `managed` | Mixed directory; `verify.mjs`, `run-tests.mjs`, `package-audit.mjs`, and research spike scripts are product tooling |
| `sdlc.config.json` | 1 | `seed-once` | SDLC configuration |
| `skills/` | 24 | `managed` | Mixed directory; 8 `skills/agentflow-*/` directories (24 files) are AgentFlow-managed, while `skills/holoself/` is the product skill |
