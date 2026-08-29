# Holoself Workbench

Holoself Workbench is the optional, local Web GUI for Holoself. Launch product code with an explicit canonical data root:

```bash
cd C:/Code/holoself
node bin/holoself.mjs web --root C:/Cowork/holoself-sam
# installed CLI equivalent:
holoself web --root C:/Cowork/holoself-sam
```

Canonical root contains `config.json`, `profile/`, `context/`, `topics/`, and related Markdown data; it does not need `.holoself/link.yaml`. Optional `--project <linked-project>` adds a linked project context and must resolve to the same root.

It binds only to `127.0.0.1`, opens no hosted account, uses no remote application service, and has no runtime dependencies beyond Node.js 20. Stop it with Ctrl+C. All CLI workflows continue to work without it.

## Product and information architecture

The Workbench turns the existing model into seven predictable areas:

1. **Overview** — canonical-root readiness, optional linked-project context, and next actions.
2. **Spaces** — independent linked project folders, status, context, health and indexes.
3. **Lenses** — visible scope and sensitivity policy.
4. **Knowledge** — guarded human editing, lifecycle filters, and content-redacted cleanup previews for canonical local Markdown.
5. **Review** — managed and invalid inbox items, review-item creation, grouped previews, and exact-hash approve, defer, reject or supersede decisions.
6. **Conversations** — context-aware turns through an explicitly configured local CLI.
7. **Setup** — canonical-root details and PI, CLAUDE, CODEX and GROK detection/configuration.

The conceptual flow remains Self → Lens → Project → Proposal → Approval. Projects keep their artifacts. Self keeps approved reusable knowledge.

## Architecture and trust boundary

The dependency-free Node HTTP server serves static HTML/CSS/JavaScript and a fixed local API. Mutations require a random per-process token and same-origin requests. It adds a restrictive Content Security Policy, body/output bounds, loopback-only binding, contained file access, and direct process spawning with `shell: false`. There is no generic command endpoint.

Canonical `profile/`, `context/`, `topics/`, `reference/`, `me/`, and `contribs/local/` Markdown remains the source of truth. Disposable catalog and harness settings live under `<root>/ui/`; project-owned transcripts live under linked `<project>/.holoself/conversations/`. Removing UI state does not remove canonical knowledge or link metadata.

## Connectors and conversations

Workbench has one extensible connector registry with `cli`, `terminal`, and `gui` kinds. Built-ins detect PI, Claude, Codex, Grok, Windows Terminal, PowerShell, Command Prompt, and registered Claude/OpenAI Windows apps. Detected built-ins require no setup. Validated root extensions or overrides live under `<root>/connectors/*.json`. Conversation and interactive launch plans use fixed connector capabilities, a linked-space allowlist, structured arguments, and `shell: false`; there is no generic command endpoint.

Every conversation turn resolves bounded, lens-filtered, current Holoself context before invoking the detected CLI. The packet carries its context gate, budget, receipt hash, cache state, estimated tokens, and selected-source count. **Open here** combines a CLI or GUI connector with a terminal host and the selected space working directory.

## Annotation-safe knowledge and lens instructions

Knowledge APIs parse frontmatter fields (`access_lenses`, disclosure, sensitivity, role, confidence, visibility, public-safe status, lifecycle state, validity/review dates, and supersession references) plus `os-section` markers. The UI renders schema-driven metadata controls: dynamic Access Lens checkboxes, guided disclosure/sensitivity/document-role/visibility values, confidence suggestions with custom-value compatibility, and a derived-or-legacy public-safe selector. Unknown lens and confidence values remain visible and preserved. Inline and save-time cross-field checks block unsafe publication combinations and fail closed when modern documents have no Access Lens. Frontmatter delimiters and opening/closing annotation comments are never exposed as editable text; the backend preserves unknown metadata, validates marker order, hash-guards the write, validates the complete root, and rolls back on failure.

Lens instructions contain structured purpose, priorities, include/exclude rules, and response guidance. Personal overrides are stored under `<root>/lenses/instructions/` so built-in definitions remain intact.

## Valuable and correctable Spaces

Space cards foreground purpose, ownership boundary, lens, pending proposals, connector availability, and health. The retained **Degraded** state maps each technical finding to fixed corrective actions such as repair, activate, relink, or rebuild index. Each action uses existing bounded CLI operations with confirmation; technical adapter details remain secondary.

## Recovery

A stale edit is rejected instead of overwritten. Broken links remain visible and recoverable. Harness errors do not alter Markdown. The UI never silently approves proposals or durable AI discoveries.
