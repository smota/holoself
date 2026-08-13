# Holoself usage

Holoself stores private Markdown under `~/.holoself` (override with `HOLOSELF_DATA_ROOT` or `--root`). Public defaults in the npm package are copied only into `contribs/default`; personal profile, context, topics, and local contribs never ship.

## skills.sh integration

[skills.sh](https://skills.sh/) is an existing skill installer and registry, separate from Holoself. Holoself does not call it, require it, or publish to it. Install the public instruction manually when wanted:

```bash
npx skills add smota/holoself --skill holoself
```

Review any installer changes before accepting them. This command may alter the current tool's skill directory; it does not import your Holoself data.

## Contrib selection

`init` defaults to all shipped public contribs. `--contribs a,b` selects an explicit allow-list; `--exclude-contrib a,b` removes names from that set. Unknown names fail rather than silently changing behavior. Re-running `init` preserves `createdAt`, updates selection, and removes deselected shipped defaults; files under `contribs/local` remain untouched. `upgrade` refreshes selected public defaults only.

## Safety

- `migrate` confirms in interactive terminals and requires `--yes` in automation. It copies `personal/` (or the supplied source) and never deletes source.
- Writes use temporary files followed by rename, avoiding partial JSON, packet, or instruction files.
- `export` copies profile/context into a project-local `.holoself`; review it before sharing or committing.
- `export --root-setup` separately confirms bounded marker edits in `AGENTS.md`, `CLAUDE.md`, and `CODEX.md`.
- `link` creates a junction on Windows or directory symlink elsewhere. Existing non-Holoself paths are never replaced. `unlink` removes only a link pointing at the selected data root.

No command sends network requests, publishes npm, or deploys a website.
