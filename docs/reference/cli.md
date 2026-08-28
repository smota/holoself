# CLI reference

Run as `holoself` when installed globally, or from a repository checkout as `node bin/holoself.mjs`.

```text
holoself <command> [options]
```

## Machine contract

| Command | Purpose |
|---|---|
| `capabilities --json` | Report the stable local CLI interface, version, context schema and supported command groups |
| `--version` | Print the human-readable version |
| `--version --json` | Print machine-readable product and version information |

## Core

| Command | Purpose |
|---|---|
| `data-root` | Print selected private data root |
| `init` | Create private data root and starter files |
| `doctor` | Check runtime and required layout |
| `validate` | Validate root, links, proposals, visibility, provenance, references, and markers |
| `migrate --from <dir>` | Copy supported PersonalOS data after confirmation |
| `export --target <dir>` | Create reviewable project packet snapshot |
| `upgrade` | Refresh selected public defaults |

Core options: `--data-dir <dir>` (`--root` and `--data-root` aliases), `--contribs a,b`, `--exclude-contrib a,b`, `--yes`, `--force`, `--dry-run`, `--packet-only`, `--root-setup`.

## Lenses

```text
lens list [--root <self-root>]
lens show <id> [--root <self-root>]
lens validate [--root <self-root>]
```

These commands are read-only. They list the effective built-in/custom catalog, show normalized resolution, or validate all immediate `<self-root>/lenses/*.json` definitions. Structurally valid but registry-unknown IDs still fail runtime semantic validation.

## Linked ecosystem

```text
link add --project <dir> --self <dir> [--lens general] [--secondary-lenses a,b]
         [--activate auto|all|<list>] [--platform <id>] [--instructions <file>]
         [--install-skill auto|project|global|none] [--skill-home <dir>] [--no-activate] [--yes]
link status|activate|deactivate|repair|doctor --project <dir> [--yes]
link skill migrate-global --project <dir> [--skill-home <dir>] [--dry-run] [--yes]
link remove --project <dir> --yes
link setup --project <dir> [--self <dir> --yes]
skill status --scope user [--platform <id>] [--skill-home <dir>]
skill install --scope user [--platform <id>] [--skill-home <dir>] [--dry-run] [--force] [--yes]
context [--project <dir>] [--self <dir>] [--lens <lens>] [--task <text>] [--self-only]
        [--json | --format packet] [--adapter pi|claude|codex|generic|obsidian|restricted-host]
        [--restricted-host] [--expires-hours 24]
        [--snapshot | --output <project-contained-path>] [--yes]
analyze overlap|conflicts|stale|all --project <dir>
propose --project <dir> [--claim <text>] [--evidence <text>]
        [--source-file <relative-path>] [--target-file <relative-path>]
        [--proposal-type <type>] [--confidence <value>] [--visibility <value>]
proposals list --project <dir>
proposals show|approve|reject|defer <id> --project <dir> [--yes]
index [status|rebuild] --project <dir> [--changed]
search <query> --project <dir> [--federated] [--lens <lens>]
```

`context` defaults to packet output unless `--json` is supplied. `--self-only` applies the selected lens and task while excluding linked-project documents, which lets bounded consumers request personal context without duplicating subject data they already select themselves. `--snapshot --yes` writes a reviewed project-only fallback; `--restricted-host` applies publication-safe filtering and adds default 24-hour expiry metadata. `--expires-hours` accepts values above 0 through 720. Link setup supports `--project-include`, `--project-exclude`, `--project-assert-include`, and `--project-assert-exclude`. `index` without subcommand builds/updates index. `link setup` previews without changes until self path and confirmation are supplied. `link add` configures and activates by default; instruction edits require confirmation. Global skill installation is separately confirmed; project migration validates the global copy before removing managed local copies.

## Legacy live mount

```text
link --target <project> [--root-setup] [--dry-run] [--force] [--yes]
unlink --target <project> [--dry-run] [--yes]
```

This is a filesystem symlink/junction mechanism, not metadata project link. It exposes complete selected data root to project tools. Retained for compatibility; prefer `link add` for new integrations.

## General behavior

- Unknown options fail.
- Missing required values fail.
- Interactive destructive/sensitive actions ask for typed confirmation; automation needs `--yes`.
- CLI performs no network requests.
- Paths resolve to absolute local paths.

Authoritative short form: `node bin/holoself.mjs --help`.
