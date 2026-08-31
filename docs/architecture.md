# Holoself architecture

Holoself is a local-first, Markdown-first whole-person context protocol. Public code and contribs ship in this repository; a user's profile and context live only in private data root. See [documentation map](README.md), [whole-person context](concepts/whole-person-context.md), [ownership](concepts/ownership.md), and [filesystem reference](reference/filesystem-layout.md).

## Data-root layout

```text
<data-root>/
├── config.json                 # user selection and schema marker
├── profile/                    # stable self attributes
├── context/                    # domain context and notes
├── lenses/                     # optional private typed custom-lens registry
├── topics/                     # bounded explorations; .current selects one
├── reference/                  # private/local reference material
├── me/                         # local self-model activation (for example contribs.md)
├── contribs/local/             # private local extensions only; public methods stay package-owned
├── contribs/local/             # user-only contribs; never packaged
└── exports/                    # generated, reviewable export staging/output
```

`<project>/.holoself/` supports three explicit modes: legacy generated packet, legacy live directory link, or activated linked-ecosystem metadata directory. Metadata mode contains `link.yaml`, platform-neutral `BOOTSTRAP.md`, activation `runtime.json`, local rebuildable `index/`, reviewable `proposals/`, and non-mutating `reports/`; it never copies canonical self files. Bounded sections in detected agent instructions point to bootstrap without exposing absolute self path. Agents may open a data root directly; direct-root detection takes precedence over project `.holoself`. See [linked ecosystem contract](linked-ecosystem.md).

An optional local MCP adapter reverses the Workbench launch relationship: Codex, AGY, or Claude Code starts `holoself mcp` as a project-bound STDIO subprocess and requests only needed context. The link remains authority, and MCP/CLI share the same domain functions. MCP exposes no raw canonical resources, repair, approval, publication, or canonical write operations. See the [architecture decision](decisions/local-mcp-architecture.md).

## Schema and ownership

`config.json` uses `schemaVersion: 1` and `product: "holoself"`. Public `contribs/catalog.json` uses `schemaVersion: 1`; each catalog entry identifies an id, title, domain, type, and shipped path. Markdown is canonical. Config, catalogs, lens definitions, and packets are generated/operational metadata. Custom lens definitions use schema v1 under optional `<data-root>/lenses/*.json`; runtime semantic resolution validates registry membership after structural schema validation.

- **User-owned/private:** `profile/`, `context/`, `topics/`, `reference/`, `me/`, `contribs/local/`.
- **Holoself-managed:** `config.json`, lifecycle/history metadata, and generated `exports/`.
- **Project-owned after review:** project instruction files and linked-project `.holoself/BOOTSTRAP.md`, `runtime.json`, `index`, `proposals`, and `reports`. `export --root-setup` and legacy `link --root-setup` change only bounded Holoself markers and ask for confirmation.
- **Self-owned after review:** approved reusable knowledge accepted through proposal workflow, with evidence and provenance.
- **Public/package-owned:** `contribs/default/`, its catalog/manifest, `skills/`, `docs/`, and source code. `config.json.selectedContribs` is an availability allowlist; public method bodies are not copied into private roots. No profile, context, topic, or private reference data ships.

Private contribs must be placed under `<data-root>/contribs/local/`. They are not discovered as public contribs, copied into this repository, or included in npm package paths.

## Root detection and loading order

Agents resolve roots deterministically: (1) current/opened directory itself when it has Holoself `config.json` plus `profile/` and `context/`; (2) an ancestor's `.holoself/` directory link; (3) `HOLOSELF_HOME`; (4) `~/.holoself`. Invalid or ambiguous roots require asking the user. Direct data roots always win over project links.

After root resolution, the context resolver applies lifecycle, privacy, task relevance, and a bounded budget. It progressively selects current profile/context/topic sources, zero to two task-relevant public methods from the package allowlisted by `config.json.selectedContribs`, then private `contribs/local/` or reference material only when specifically relevant. For linked projects, use the resolver or a reviewed `.holoself/context-packet.md`; do not bulk-read the canonical root.

A packet can be made self-contained with `export --packet-only`; it then embeds the selected profile/context text rather than relying on fallback paths.

## Contrib selection

`init` selects all shipped public contribs by default. `--contribs a,b` is an explicit allow-list; `--exclude-contrib a,b` removes ids from the selected set. Unknown ids fail. Re-running `init` or running `upgrade` refreshes only selected shipped defaults and never touches `contribs/local/`. Selection is recorded in `config.json`.

## Review-before-save

Holoself never silently makes durable context changes. An agent may propose a change, name its target file, and request approval; only then should the user or an approved workflow write it. Review generated packets and exports before committing or sharing. No command sends data or publishes private state.

## Migration

`migrate --from <PersonalOS>` maps `personal/profile`, `personal/context`, and `topics` to their corresponding data-root directories. It maps `personal/reference` to private `reference/` and `personal/me` to private `me/`. The source remains untouched; private material is never copied to package/public contrib paths.
