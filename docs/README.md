# Holoself documentation

Use the shortest path that fits your goal. You do not need to read the documentation in order.

## Choose your path

| Audience | Recommended path | What it answers |
|---|---|---|
| Regular user | [Quickstart](start/quickstart.md) → [Workbench tour](workbench/index.md) → [Common use cases](guides/common-use-cases.md) | How do I start, use my context, and stay in control? |
| Advanced user | [First linked project](start/first-linked-project.md) → [Activated links](guides/activated-links.md) → [Local MCP](guides/local-mcp.md) → [CLI reference](reference/cli.md) | How do I automate bounded context, search, review, and integration? |
| Data architect | [Concepts in five minutes](start/concepts-in-five-minutes.md) → [Architecture](architecture.md#architecture-at-a-glance) → [Ownership](concepts/ownership.md) → [Lenses and privacy](concepts/lenses-and-privacy.md) → [Threat model](trust/threat-model.md) | Where is authority, how does data flow, and which controls enforce the boundary? |

If you are evaluating Holoself, the core contract is: **projects own execution artifacts; self owns approved reusable personal knowledge; AI tools receive only context permitted by the selected link, lens, lifecycle, and task.**

## Command notation

Install `holoself-ai` from npm to use the `holoself` package bin on `PATH`. `node bin/holoself.mjs` runs the same CLI directly from a repository checkout. The installed form is required when an MCP client launches Holoself. See [CLI invocation and reference](reference/cli.md#invocation).

## Start

- [Quickstart](start/quickstart.md)
- [Concepts in five minutes](start/concepts-in-five-minutes.md)
- [First linked project](start/first-linked-project.md)

## Concepts

- [Whole-person context](concepts/whole-person-context.md)
- [Ownership](concepts/ownership.md)
- [Lenses and privacy](concepts/lenses-and-privacy.md)
- [Provenance](concepts/provenance.md)
- [Proposal review](concepts/proposal-review.md)
- [Principles](concepts/principles.md)
- [Terminology](concepts/terminology.md)

## Guides

- [Local coaching sessions](guides/coaching.md)
- [Activated project links](guides/activated-links.md)
- [Link or export?](guides/link-or-export.md)
- [Synthetic career and publishing example](guides/synthetic-linked-projects.md)
- [Indexing and search](guides/indexing-and-search.md)
- [Runtime adapters](guides/runtime-adapters.md)
- [Local MCP integration](guides/local-mcp.md)
- [Common use cases](guides/common-use-cases.md)
- [Migration](guides/migration.md)
- [Adoption and rollback runbook](guides/adoption-and-rollback-runbook.md)

## Workbench

- [Guided tour and launch](workbench/index.md)
- [Overview](workbench/overview.md)
- [Spaces](workbench/spaces.md)
- [Lenses](workbench/lenses.md)
- [Knowledge](workbench/knowledge.md)
- [Review](workbench/review.md)
- [Conversations](workbench/conversations.md)
- [Setup and connectors](workbench/setup.md)
- [Architecture and trust boundary](web-gui.md)

## Reference

- [CLI](reference/cli.md)
- [Filesystem layout](reference/filesystem-layout.md)
- [Schemas](reference/schemas.md)
- [MCP tools](reference/mcp-tools.md)
- [MCP platform verification](reference/platform-verification.md)

## Decisions

- [Local MCP architecture](decisions/local-mcp-architecture.md)

## Development specifications

The context/lens research below records earlier designs. The current contract uses [uniform self-side lenses and bindings](concepts/lenses-and-privacy.md) and self-only indexes.

The D00–D03 evidence documents below record earlier research and experiments. The current coaching workflow is described in [Local coaching sessions](guides/coaching.md); it does not use the experimental native extraction runtime.

- [External sources and coaching development plan](specifications/external-sources-and-coaching-plan.md)
- [External sources and coaching orchestration plan](specifications/external-sources-and-coaching-orchestration.md)
- [D01 local extraction feasibility spike](reports/evidence-extraction-d01-spike.md)
- [D01 independent testing and review receipt](reports/evidence-extraction-d01-validation.md)
- [D02 native provider prototype report](reports/evidence-native-provider-prototype.md)
- [D03 extraction experiment, tranche 2](reports/evidence-extraction-d03-tranche2.md)
- [D03 extraction experiment, tranche 3](reports/evidence-extraction-d03-tranche3.md)
- [Independent review of the orchestration plan](reports/external-sources-orchestration-review.md)
- [Context and lenses specification](specifications/context-and-lenses-vnext.md)
- [Context and lenses implementation plan and C-00 evidence](specifications/context-and-lenses-implementation-plan.md)
- [C-02 research: catalog and freshness](specifications/c02-research-catalog-and-freshness.md)
- [C-03 research: lenses and migration](specifications/c03-research-lenses-and-migration.md)
- [C-04 research: federation](specifications/c04-research-federation.md)
- [C-05 research: single query, instructions, and Workbench](specifications/c05-research-single-query-and-experience.md)
- [C-06 research: traceability and readiness](specifications/c06-research-traceability-and-readiness.md)
- [Before-after report: C-00 to C-06](reports/before-after-c00-to-c06.md)

## Releases

- [Holoself 0.10.1](releases/0.10.1.md)

- [Holoself 0.10.0](releases/0.10.0.md)
- [Holoself 0.9.0](releases/0.9.0.md)
- [Holoself 0.8.0](releases/0.8.0.md)

## Trust

- [Safety guarantees and limits](trust/safety-guarantees.md)
- [Threat model](trust/threat-model.md)
- [Privacy policy](../PRIVACY.md)

## Contributing

- [Development](contributing/development.md)
- [Release process](contributing/releases.md)
- [Status and roadmap](contributing/status-and-roadmap.md)
- [Holoself consolidation backlog](backlog/2026-10-03-holoself-consolidation.md)

Compatibility entry points remain at [architecture.md](architecture.md), [linked-ecosystem.md](linked-ecosystem.md), [migration.md](migration.md), [ownership.md](ownership.md), and [usage.md](usage.md).

- [Coaching course correction and validation](reports/coaching-course-correction.md): current local CLI delivery, retired experimental scope, and review evidence.

- [External public skill deployments](decisions/external-skill-deployments.md): read-only skills-manager compatibility, provider paths, diagnostics, and maintenance safety.

- [Link adapter scope](decisions/link-adapter-scope.md): repair restores recorded adapters with a Workbench preview (#34); scoped deactivation and per-command flags (#33).

## AgentFlow SDLC

- [AgentFlow SDLC Definition](sdlc-definition.md)
- [Agent Workflow](agent-workflow.md)
- [Stack Conventions](stack-conventions.md)
- [Capabilities](capabilities.md)
- [Delivery Release Acceptance](delivery-release-acceptance.md)
- [Evidence Contracts](evidence-contracts.md)
- [Intelligent Collaboration](intelligent-collaboration.md)
- [Issue Standards](issue-standards.md)
- [Lifecycle Boundaries](lifecycle-boundaries.md)
- [Modular Architecture](modular-architecture.md)
- [Reliable Delivery](reliable-delivery.md)
- [Role Collaboration](role-collaboration.md)
- [Run Operations](run-operations.md)
- [Adopters Index](adopters/index.md)
- [Adopters Profiles](adopters/profiles.md)
- [ADR 007: Verifiable Recoverable Delivery](adr/007-verifiable-recoverable-delivery.md)
- [ADR 009: Incremental Onboarding](adr/009-incremental-onboarding.md)
- [Providers Index](providers/index.md)
- [Provider Authoring](providers/authoring.md)
- [Provider Matrix](providers/provider-matrix.md)
- [Roles Index](roles/index.md)
- [Roles Methods](roles/methods.md)

