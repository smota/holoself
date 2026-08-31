# Linked Holoself ecosystem contract

This compatibility overview remains stable for existing links. For task-oriented documentation, start with [Concepts in five minutes](start/concepts-in-five-minutes.md), [First linked project](start/first-linked-project.md), and [CLI reference](reference/cli.md).

## Core model and ownership

Holoself models one whole person: identity, work context, preferences, voice, thinking, career, technical, leadership, publishing, projects, people, decisions, stories, and private context. Lenses change relevance, depth, and privacy; they never create personas.

Self owns identity/preferences, durable career facts, approved stories, decisions, and reusable knowledge. Projects own execution artifacts: applications, research, interview notes, posts, calendars, publishing performance, templates, and project strategy. Reusable insight discovered in project enters self only through reviewed proposal.

For verified clients, local STDIO MCP is the preferred interaction adapter after the link exists. It improves tool discovery and on-demand context selection but does not replace link authority, project ownership, or review-before-save. BOOTSTRAP, the public skill, and CLI continue as the fallback.

Project link grants read access:

```yaml
self_context:
  path: "C:/Cowork/holoself-sam"
  access: "read"
  proposals: "enabled"
  index: "local"
  default_lens: "career"
  secondary_lenses:
    - "technical"
    - "leadership"
```

`link add` creates `.holoself/link.yaml`, README, `BOOTSTRAP.md`, `runtime.json`, and empty `index/`, `proposals/`, `reports/`. By default it detects agent-platform evidence and, after confirmation, injects bounded pointers into startup instructions; `--no-activate` is explicit configuration-only mode. It never copies canonical self. See [activated project links](guides/activated-links.md). `link setup` reports instructions, profile-like files, likely duplicates, lens suggestion, and migration recommendations before confirmed configuration creation. Existing README or link configuration collisions are refused unless `--force --yes`; user README content is preserved. Legacy export refuses any ecosystem metadata directory. No command deletes or relocates project artifacts.

## Context and privacy

Resolution order: canonical self → validated built-in/custom lens → project-local context → task relevance → privacy filter → provenance-preserving output. Built-ins are `general`, `career`, `publishing`, `technical`, `leadership`, `interview`, and `private`; optional private custom definitions live under the self root's `lenses/*.json`. Base lenses preserve safe behavior but never grant document access: custom IDs must be explicit in `access_lenses`.

Optional Markdown frontmatter:

```yaml
---
visibility: private
public_safe: false
sensitivity: employer-confidential
confidence: confirmed
exclude_lenses:
  - publishing
---
```

Visibility values: `private`, `linked-projects`, `career`, `publishing`, `public-safe`. Explicit sensitivity categories include `compensation-confidential`, `third-party-personal`, `recruiter-confidential`, `employer-confidential`, and `application-private`; category defaults narrow eligible lenses and all confidential categories block publication. Optional `task_include`/`task_exclude` metadata narrows documents by `--task`, while project documents with no task match are removed (policy documents remain available to constrain work). Secret-like files are excluded from context/index output and reported as restrictions. Output lists source paths and SHA-256 hashes. JSON follows `schemas/context.schema.json`; packet adapters are `pi`, `claude`, `codex`, `generic`, `obsidian`, and product-owned `restricted-host` snapshot framing.

## Analysis and proposal review

Analysis classifies exact/semantic duplicates, contradictions, stale copies, project-specific content, candidates for self, sensitive leakage, and unclear ownership. Reports are timestamped under project `.holoself/reports/`; reports recommend action and never mutate source files.

Proposals follow `schemas/proposal.schema.json`. UUIDs, filenames, allowed fields, relative source paths, canonical target containment, project provenance, reserved markers, and state transitions are validated before use. States are `pending → approved|rejected|deferred|superseded`. Approval prints target, evidence, affected files, and proposed diff; requires explicit confirmation; appends provenance; archives proposal by state; and validates afterward. Rejected/deferred records remain preserved. Self never changes silently.

## Local indexing and search

Markdown remains source of truth. Each linked project owns rebuildable `.holoself/index/index.json` schema v4/privacy-policy v3, containing paths, headings, SHA-256 content hashes, input/config state hashes, timestamps, redacted privacy-policy metadata, visibility-annotated links/tags/claims, provenance, and passed post-build assertions. Search verifies freshness and auto-rebuilds when selected inputs or link policy change. `index status` reports `stale` without rebuilding. Optional `project_context.assert_include` and `assert_exclude` patterns make builds fail when expected sources are absent or forbidden sources survive. Search reapplies file, claim, field, sensitivity, and publishing compensation filters. Credential-like filenames, explicit secret sensitivity, private keys, tokens, connection strings, and common secret content patterns are excluded. Dependency-free deterministic JSON is current engine. SQLite/FTS can be added as optional acceleration later, but cannot become source of truth. Index is local, ignorable, independently versioned, and safe to delete/rebuild.

Federated search reads linked self and project entries in place; it does not centralize Markdown. Results include source, section, passage, provenance, visibility, and freshness.

## Commands

```text
holoself link add --project <path> --self <path> [--lens career]
holoself link status --project <path>
holoself link remove --project <path> --yes
holoself link setup --project <path> --self <path> --yes
holoself context --project <path> --lens career --task "prepare interview" --json
holoself context --project <path> --format packet --adapter claude
holoself context --project <path> --snapshot --restricted-host --expires-hours 24 --yes
holoself analyze overlap|conflicts|stale|all --project <path>
holoself propose --project <path> --claim "..." --evidence "..." --source-file file.md
holoself proposals list|show|approve|reject|defer [id] --project <path>
holoself index [status|rebuild] --project <path> [--changed]
holoself search "regulated AI" --project <path> [--federated]
holoself mcp configure --project <path> [--platform codex|agy|claude] --dry-run
holoself mcp configure --project <path> [--platform codex|agy|claude] --yes
holoself mcp status --project <path>
holoself mcp --project <path> # normally launched by the client
```

Safety invariants: no automatic deletion, relocation, publication, external action, or canonical write; declared compensation/employer-confidential content is filtered from publishing output; recognized secret-like filenames and content patterns are excluded from indexes; provenance appears on every result and accepted claim. Pattern matching cannot guarantee detection of every secret, so indexes remain private and review is required. Unknown CLI options and malformed existing link YAML fail closed before target selection or mutation.
