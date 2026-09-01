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

- [Activated project links](guides/activated-links.md)
- [Link or export?](guides/link-or-export.md)
- [Synthetic career and publishing example](guides/synthetic-linked-projects.md)
- [Indexing and search](guides/indexing-and-search.md)
- [Runtime adapters](guides/runtime-adapters.md)
- [Local MCP integration](guides/local-mcp.md)
- [Common use cases](guides/common-use-cases.md)
- [Migration](guides/migration.md)

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

## Releases

- [Holoself 0.8.0](releases/0.8.0.md)

## Trust

- [Safety guarantees and limits](trust/safety-guarantees.md)
- [Threat model](trust/threat-model.md)
- [Privacy policy](../PRIVACY.md)

## Contributing

- [Development](contributing/development.md)
- [Release process](contributing/releases.md)
- [Status and roadmap](contributing/status-and-roadmap.md)

Compatibility entry points remain at [architecture.md](architecture.md), [linked-ecosystem.md](linked-ecosystem.md), [migration.md](migration.md), [ownership.md](ownership.md), and [usage.md](usage.md).
