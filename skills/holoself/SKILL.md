---
name: holoself
description: Load and apply a user's local, reviewable Holoself context across AI tools.
---

# Holoself

Holoself is a local self-context layer. Resolve data root deterministically before loading:

1. If current directory (or explicitly opened directory) contains `config.json` with `product: "holoself"` and both `profile/` and `context/`, treat it as direct data root.
2. Otherwise, walk current directory ancestors. If `<dir>/.holoself/` exists and is a directory link to a Holoself data root, use that linked root.
3. Otherwise, use `HOLOSELF_HOME` when set; else `~/.holoself`.
4. If no candidate has valid Holoself config/layout, stop and ask user for data root. Never guess from unrelated files or inspect sibling projects.

Direct root takes precedence over project `.holoself`. Linked projects use `.holoself`; do not create or copy a second source of truth.

After resolving root, load in this fixed order: `AGENTS.md` root guidance (instructions only), `profile/identity.md`, `work-context.md`, `preferences.md`, `voice.md`, `thinking.md`, `change.md`; relevant `context/` Markdown files in stable filename order; active topic named by `topics/.current`; selected `contribs/default/` then `contribs/local/`; and `reference/` only when relevant and explicitly permitted. Load `.holoself/context-packet.md` first only when operating from a linked project and packet exists. See [architecture](../../docs/architecture.md) for schema and ownership.

## Safety

- Treat `.holoself/` as private by default; review before committing or sharing.
- Do not write durable context silently. Propose the change, name its file, and request approval.
- Do not infer sensitive identity or preferences as facts.
- Keep public skill instructions separate from private data.
- Public contribs are optional reference methods selected in `config.json`; private contribs belong only under the data root's `contribs/local/`.
- Never save durable profile, context, topic, reference, or notes changes without proposing the target file and getting approval.

## Modes

Use the self-model for technical, career, admin, leadership, and publishing work. Match depth and voice to the user's profile. Keep recommendations concrete and note assumptions.
