# Holoself architecture

Holoself is a local-first, Markdown-first self-context layer. Public code and contribs are shipped in this repository; a user's profile and context live only in their private data root.

## Data-root layout

```text
<data-root>/
├── config.json                 # user selection and schema marker
├── profile/                    # stable self attributes
├── context/                    # domain context and notes
├── topics/                     # bounded explorations; .current selects one
├── reference/                  # private/local reference material
├── me/                         # local self-model activation (for example contribs.md)
├── contribs/default/           # selected copies of shipped public contribs
├── contribs/local/             # user-only contribs; never packaged
└── exports/                    # generated, reviewable export staging/output
```

`<project>/.holoself/` is a generated project packet or link, not a second source of truth. It contains a bounded snapshot of profile/context and `context-packet.md`, or links directly to the data root for live use. Agents may open a data root directly; direct-root detection takes precedence over project `.holoself`.

## Schema and ownership

`config.json` uses `schemaVersion: 1` and `product: "holoself"`. Public `contribs/catalog.json` uses `schemaVersion: 1`; each catalog entry identifies an id, title, domain, type, and shipped path. Markdown is canonical. Config, catalogs, and packets are generated/operational metadata.

- **User-owned/private:** `profile/`, `context/`, `topics/`, `reference/`, `me/`, `contribs/local/`.
- **Holoself-managed:** `config.json`, `contribs/default/`, and generated `exports/`.
- **Project-owned after review:** project instruction files. `export --root-setup` and `link --root-setup` change only bounded Holoself markers and ask for confirmation.
- **Public/package-owned:** `contribs/default/`, its catalog/manifest, `skills/`, `docs/`, and source code. No profile, context, topic, or private reference data ships.

Private contribs must be placed under `<data-root>/contribs/local/`. They are not discovered as public contribs, copied into this repository, or included in npm package paths.

## Root detection and loading order

Agents resolve roots deterministically: (1) current/opened directory itself when it has Holoself `config.json` plus `profile/` and `context/`; (2) an ancestor's `.holoself/` directory link; (3) `HOLOSELF_HOME`; (4) `~/.holoself`. Invalid or ambiguous roots require asking the user. Direct data roots always win over project links.

After root resolution, load root `AGENTS.md` instructions, then profile files in stable order: identity, work-context, preferences, voice, thinking, change; relevant context files: projects, people, decisions, story-bank, career, admin, leadership, technical, publishing; active topic selected by `topics/.current`; explicitly selected public defaults from `contribs/default/`, then local contribs from `contribs/local/`; and private reference material only when relevant and explicitly permitted. For linked projects, load generated `.holoself/context-packet.md` first when present.

A packet can be made self-contained with `export --packet-only`; it then embeds the selected profile/context text rather than relying on fallback paths.

## Contrib selection

`init` selects all shipped public contribs by default. `--contribs a,b` is an explicit allow-list; `--exclude-contrib a,b` removes ids from the selected set. Unknown ids fail. Re-running `init` or running `upgrade` refreshes only selected shipped defaults and never touches `contribs/local/`. Selection is recorded in `config.json`.

## Review-before-save

Holoself never silently makes durable context changes. An agent may propose a change, name its target file, and request approval; only then should the user or an approved workflow write it. Review generated packets and exports before committing or sharing. No command sends data or publishes private state.

## Migration

`migrate --from <PersonalOS>` maps `personal/profile`, `personal/context`, and `topics` to their corresponding data-root directories. It maps `personal/reference` to private `reference/` and `personal/me` to private `me/`. The source remains untouched; private material is never copied to package/public contrib paths.
