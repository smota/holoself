# CLI reference

## Invocation

Both command forms execute `bin/holoself.mjs` and expose the same features:

- `holoself ...` uses the `holoself-ai` package bin installed from npm and available on `PATH`. Verify it with `holoself --version`; this form is required for MCP client configuration because the client launches `holoself mcp` outside the setup shell.
- `node bin/holoself.mjs ...` runs the current repository checkout directly. Use it for development or checkout-based evaluation without a global package installation.

Examples in compact references, generated project instructions, and MCP documentation use the installed shorthand. They do not describe a different CLI.

```text
holoself <command> [options]
```

## Machine contract

| Command | Purpose |
|---|---|
| `capabilities --json` | Report the stable local CLI interface, version, context schema and supported command groups |
| `--version` | Print the human-readable version |
| `--version --json` | Print machine-readable product and version information |

<!-- generated:start -->
Generated from `holoself capabilities --json` (product `holoself`, version `0.10.1`, context schema `v1`, index schema `v5`, proposal schemas `v1, v2`) and the CLI flag contract:

- Capability command groups (12): `doctor`, `context`, `ledger`, `search`, `propose`, `proposals`, `instructions`, `knowledge`, `link`, `skill`, `mcp`, `coaching`
- Coaching subcommands (7): `coaching start`, `coaching note`, `coaching action`, `coaching choose`, `coaching review`, `coaching material`, `coaching resume`
- Context features: `need-gate`, `budgets`, `manifest`, `source-handles`, `lifecycle`, `receipts`, `task-contrib-routing`
- MCP tools (7): `holoself_status`, `holoself_context`, `holoself_context_manifest`, `holoself_context_get`, `holoself_search`, `holoself_proposal_create`, `holoself_proposal_preview`

| Command | Accepted flags |
|---|---|
| `capabilities` | `--json` |
| `data-root` | `--root`, `--data-root`, `--data-dir` |
| `init` | `--root`, `--data-root`, `--data-dir`, `--contribs`, `--exclude-contrib` |
| `doctor` | `--root`, `--data-root`, `--data-dir` |
| `validate` | `--root`, `--data-root`, `--data-dir`, `--project` |
| `migrate` | `--root`, `--data-root`, `--data-dir`, `--from`, `--force`, `--dry-run`, `--yes`, `--confirm` |
| `export` | `--root`, `--data-root`, `--data-dir`, `--target`, `--packet-only`, `--root-setup`, `--dry-run`, `--yes`, `--confirm` |
| `link` | `--root`, `--data-root`, `--data-dir`, `--target`, `--root-setup`, `--force`, `--dry-run`, `--yes`, `--confirm` |
| `unlink` | `--root`, `--data-root`, `--data-dir`, `--target`, `--dry-run`, `--yes`, `--confirm` |
| `upgrade` | `--root`, `--data-root`, `--data-dir`, `--contribs`, `--exclude-contrib`, `--dry-run` |
| `web` | `--root`, `--data-root`, `--data-dir`, `--project`, `--port`, `--no-open` |
| `mcp` | `--project`, `--claude-project-dir` |
| `mcp status` | `--project`, `--platform`, `--json` |
| `mcp configure` | `--project`, `--platform`, `--all-detected`, `--force-replace`, `--dry-run`, `--yes`, `--confirm`, `--json` |
| `coaching` | _(none)_ |
| `coaching start` | `--root`, `--data-root`, `--data-dir`, `--question`, `--json` |
| `coaching note` | `--root`, `--data-root`, `--data-dir`, `--expected-revision`, `--kind`, `--text`, `--json` |
| `coaching action` | `--root`, `--data-root`, `--data-dir`, `--expected-revision`, `--text`, `--json` |
| `coaching choose` | `--root`, `--data-root`, `--data-dir`, `--expected-revision`, `--action-sequence`, `--json` |
| `coaching review` | `--root`, `--data-root`, `--data-dir`, `--expected-revision`, `--outcome`, `--text`, `--json` |
| `coaching material` | `--root`, `--data-root`, `--data-dir`, `--expected-revision`, `--material-text`, `--material-status`, `--source-label`, `--producer`, `--limitations`, `--json` |
| `coaching resume` | `--root`, `--data-root`, `--data-dir`, `--json` |
| `knowledge transform` | `--root`, `--data-root`, `--data-dir`, `--replacements`, `--plan-kind`, `--output`, `--dry-run`, `--apply`, `--digest`, `--preview-hash`, `--yes`, `--confirm`, `--json` |
| `knowledge migrate-lenses` | `--root`, `--data-root`, `--data-dir`, `--output`, `--dry-run`, `--apply`, `--digest`, `--preview-hash`, `--yes`, `--confirm`, `--json` |
| `knowledge cleanup` | `--root`, `--data-root`, `--data-dir`, `--output`, `--dry-run`, `--apply`, `--digest`, `--preview-hash`, `--yes`, `--confirm`, `--json` |
| `instructions` | `--project`, `--target`, `--json` |
| `instructions audit` | `--project`, `--target`, `--json` |
| `instructions render` | `--project`, `--target`, `--adapter`, `--harvest`, `--focus`, `--json` |
| `skill status` | `--scope`, `--platform`, `--skill-home`, `--json` |
| `skill install` | `--scope`, `--platform`, `--skill-home`, `--force`, `--dry-run`, `--yes`, `--confirm`, `--json` |
| `lens list` | `--root`, `--data-root`, `--data-dir`, `--json` |
| `lens show` | `--root`, `--data-root`, `--data-dir`, `--json` |
| `lens validate` | `--root`, `--data-root`, `--data-dir`, `--json` |
| `lens bindings` | `--root`, `--data-root`, `--data-dir`, `--json` |
| `lens bind` | `--root`, `--data-root`, `--data-dir`, `--project`, `--lens`, `--secondary-lenses`, `--binding-hash`, `--dry-run`, `--yes`, `--confirm`, `--json` |
| `lens unbind` | `--root`, `--data-root`, `--data-dir`, `--project`, `--binding-hash`, `--dry-run`, `--yes`, `--confirm`, `--json` |
| `link add` | `--project`, `--target`, `--self`, `--lens`, `--secondary-lenses`, `--project-include`, `--project-exclude`, `--project-assert-include`, `--project-assert-exclude`, `--activate`, `--platform`, `--instructions`, `--install-skill`, `--skill-home`, `--no-activate`, `--hooks`, `--no-hooks`, `--mcp`, `--no-mcp`, `--approve-read-tools`, `--no-approve-read-tools`, `--force`, `--dry-run`, `--yes`, `--confirm` |
| `link setup` | `--project`, `--target`, `--self`, `--lens`, `--secondary-lenses`, `--project-include`, `--project-exclude`, `--project-assert-include`, `--project-assert-exclude`, `--activate`, `--platform`, `--instructions`, `--install-skill`, `--skill-home`, `--no-activate`, `--hooks`, `--no-hooks`, `--mcp`, `--no-mcp`, `--approve-read-tools`, `--no-approve-read-tools`, `--force`, `--dry-run`, `--yes`, `--confirm` |
| `link activate` | `--project`, `--target`, `--activate`, `--platform`, `--instructions`, `--install-skill`, `--skill-home`, `--no-activate`, `--hooks`, `--no-hooks`, `--mcp`, `--no-mcp`, `--approve-read-tools`, `--no-approve-read-tools`, `--force`, `--dry-run`, `--yes`, `--confirm` |
| `link repair` | `--project`, `--target`, `--activate`, `--platform`, `--instructions`, `--install-skill`, `--skill-home`, `--no-activate`, `--hooks`, `--no-hooks`, `--mcp`, `--no-mcp`, `--approve-read-tools`, `--no-approve-read-tools`, `--force`, `--dry-run`, `--yes`, `--confirm`, `--lens`, `--secondary-lenses` |
| `link deactivate` | `--project`, `--target`, `--adapters`, `--dry-run`, `--yes`, `--confirm` |
| `link status` | `--project`, `--target`, `--skill-home`, `--json` |
| `link doctor` | `--project`, `--target`, `--skill-home`, `--root`, `--data-root`, `--data-dir`, `--project`, `--target`, `--self`, `--lens`, `--task`, `--need`, `--self-only`, `--budget`, `--source`, `--session-start`, `--hook`, `--temporal`, `--include-history`, `--manifest`, `--cursor`, `--no-cache`, `--federated`, `--spaces`, `--adapter`, `--restricted-host`, `--expires-hours`, `--format`, `--json`, `--snapshot` |
| `link remove` | `--project`, `--target`, `--root`, `--data-root`, `--data-dir`, `--self`, `--force`, `--dry-run`, `--yes`, `--confirm` |
| `link approve` | `--project`, `--target`, `--root`, `--data-root`, `--data-dir`, `--self`, `--revoke`, `--lenses` |
| `link backfill` | `--project`, `--target`, `--root`, `--data-root`, `--data-dir`, `--self`, `--all`, `--lenses` |
| `link prune` | `--root`, `--data-root`, `--data-dir`, `--self` |
| `link skill migrate-global` | `--project`, `--target`, `--platform`, `--instructions`, `--skill-home`, `--force`, `--dry-run`, `--yes`, `--confirm` |
| `migrate policy` | `--root`, `--data-root`, `--data-dir`, `--self`, `--apply`, `--revert`, `--confirm-narrowing`, `--allow-partial`, `--include-linked`, `--dry-run`, `--json` |
| `context` | `--root`, `--data-root`, `--data-dir`, `--project`, `--target`, `--self`, `--lens`, `--task`, `--need`, `--self-only`, `--budget`, `--source`, `--session-start`, `--hook`, `--temporal`, `--include-history`, `--manifest`, `--cursor`, `--no-cache`, `--federated`, `--spaces`, `--adapter`, `--restricted-host`, `--expires-hours`, `--format`, `--json`, `--output`, `--snapshot`, `--yes`, `--confirm` |
| `analyze overlap` | `--project`, `--target`, `--json` |
| `analyze conflicts` | `--project`, `--target`, `--json` |
| `analyze stale` | `--project`, `--target`, `--json` |
| `analyze all` | `--project`, `--target`, `--json` |
| `propose` | `--project`, `--target`, `--claim`, `--op`, `--claim-id`, `--reason`, `--source-file`, `--target-file`, `--proposal-type`, `--type`, `--evidence`, `--confidence`, `--visibility`, `--json` |
| `proposals list` | `--project`, `--target`, `--json` |
| `proposals audit` | `--project`, `--target`, `--json` |
| `proposals show` | `--project`, `--target` |
| `proposals approve` | `--project`, `--target`, `--json`, `--digest`, `--preview-hash`, `--yes`, `--confirm` |
| `proposals reject` | `--project`, `--target`, `--yes`, `--confirm` |
| `proposals defer` | `--project`, `--target`, `--yes`, `--confirm` |
| `proposals supersede` | `--project`, `--target`, `--yes`, `--confirm` |
| `index` | `--project`, `--target`, `--changed`, `--json` |
| `index status` | `--project`, `--target`, `--json` |
| `index rebuild` | `--project`, `--target`, `--json` |
| `ledger` | `--project`, `--target`, `--root`, `--data-root`, `--data-dir`, `--self`, `--since`, `--lens`, `--surface`, `--limit`, `--json` |
| `search` | `--project`, `--target`, `--lens`, `--temporal`, `--federated`, `--spaces`, `--json` |
<!-- generated:end -->

## Core

| Command | Purpose |
|---|---|
| `data-root` | Print selected private data root |
| `init` | Create private data root and starter files |
| `doctor` | Check runtime and required layout |
| `validate` | Validate root, links, proposals, visibility, provenance, references, and markers |
| `migrate --from <dir>` | Copy supported PersonalOS data after confirmation |
| `export --target <dir>` | Create reviewable project packet snapshot |
| `upgrade` | Refresh selected public contrib availability; method files remain package-owned |
| `web` | Start the optional loopback-only Workbench |
| `mcp` | Run the local project-bound STDIO MCP server; normally client-launched |
| `knowledge cleanup` | Build or apply a digest-bound lifecycle cleanup plan |
| `instructions render|audit` | Render or audit consolidated project instructions |

Core options: `--data-dir <dir>` (`--root` and `--data-root` aliases), `--contribs a,b`, `--exclude-contrib a,b`, `--yes`, `--force`, `--dry-run`, `--packet-only`, `--root-setup`.

## Lenses

```text
lens list [--root <self-root>]
lens show <id> [--root <self-root>]
lens validate [--root <self-root>]
lens bindings --root <self-root>
lens bind --root <self-root> --project <dir> --lens <id> [--secondary-lenses a,b] --yes
lens unbind --root <self-root> --project <dir> --yes
```

List/show/validate are read-only; bind/unbind support dry-run and require confirmation. They list the self-side definitions, show normalized resolution, or validate all immediate `<self-root>/lenses/*.json` definitions. Structurally valid but registry-unknown IDs still fail runtime semantic validation.

## Linked ecosystem

```text
link add --project <dir> --self <dir> [--lens general] [--secondary-lenses a,b]
         [--activate auto|all|<list>] [--platform <id>] [--instructions <file>]
         [--install-skill auto|project|global|none] [--skill-home <dir>] [--no-activate] [--yes]
link status|activate|deactivate|repair|doctor --project <dir> [--yes]
link deactivate --project <dir> [--adapters all|<list>] [--dry-run|--yes]
link skill migrate-global --project <dir> [--skill-home <dir>] [--dry-run] [--yes]
link remove --project <dir> --yes
link setup --project <dir> [--self <dir> --yes]
skill status --scope user [--platform <id>] [--skill-home <dir>]
skill install --scope user [--platform <id>] [--skill-home <dir>] [--dry-run] [--force] [--yes]
context [--project <dir>] [--self <dir>] [--lens <lens>] [--task <text>] [--self-only]
        [--budget small|standard|deep|unbounded] [--manifest] [--source <handle>] [--session-start]
        [--temporal current|historical|superseded|all]
        [--json | --format packet] [--adapter pi|claude|codex|generic|obsidian|restricted-host]
        [--restricted-host] [--expires-hours 24]
        [--snapshot | --output <project-contained-path>] [--yes]
analyze overlap|conflicts|stale|all --project <dir>
propose --project <dir> [--claim <text>] [--evidence <text>]
        [--source-file <relative-path>] [--target-file <relative-path>]
        [--proposal-type <type>] [--confidence <value>] [--visibility <value>]
proposals list|audit --project <dir>
proposals show|approve|reject|defer|supersede <id> --project <dir> [--yes]
index [status|rebuild] --project <dir> [--changed]
search <query> --project <dir> [--lens <lens>]
mcp configure --project <dir> [--platform codex|agy|claude | --all-detected] [--force-replace] [--dry-run] [--yes]
mcp status --project <dir> [--platform codex|agy|claude]
mcp [--project <dir>]
instructions render|audit --project <dir> [--adapter generic] [--harvest [--focus <text>]] [--json]
knowledge migrate-lenses --root <self-root> [--output <plan.json>]
knowledge transform --root <self-root> --replacements <changes.json> [--output <plan.json>]
knowledge migrate-lenses|transform --root <self-root> --apply <plan.json> --digest <sha256> --yes
knowledge cleanup [--root <self-root>] [--output <plan.json>]
knowledge cleanup [--root <self-root>] --apply <plan.json> --digest <sha256> --yes
```

`context` defaults to packet output unless `--json` is supplied. Every context packet stays within twice its budget (`selection.total_bytes`, `envelope_cap_bytes`). A packet that had to shrink lists dropped sources in `selection.envelope_dropped`, groups `restrictions` by reason (adding `count` and `sources`) and reduces `proposals` to ids. `--session-start` loads only the lens `session_start_sources`; see [context efficiency](../concepts/context-efficiency.md). Context and search index self only; `--self-only` remains a compatible explicit spelling, while `--federated` and `--no-cache` remain accepted as deprecated no-ops for one release and emit a stderr warning. Missing bindings fail closed. `--snapshot --yes` writes a reviewed project-only fallback; `--restricted-host` applies publication-safe filtering and adds default 24-hour expiry metadata. `--expires-hours` accepts values above 0 through 720. Link setup supports `--project-include`, `--project-exclude`, `--project-assert-include`, and `--project-assert-exclude`. `index` without subcommand builds/updates index; `index rebuild` also removes any legacy decision-cache files on disk. `link setup` previews without changes until self path and confirmation are supplied. `link add` configures and activates by default; instruction edits require confirmation. Global skill installation is separately confirmed; project migration validates the global copy before removing managed local copies.

`mcp configure` first prints exact project-local file actions and expected hashes. Without `--dry-run`, it requires confirmation or `--yes`. Existing divergent `holoself` server entries and malformed markers fail closed; `--force-replace` with confirmation replaces a divergent entry. `--all-detected` selects every client whose executable is on PATH or whose configuration exists in the project, applies all changes or none, and refuses when the files changed after the preview. Link activation (`link setup|add|activate|repair`) configures MCP by default for verified hosts; `--mcp`/`--no-mcp` and opt-in `--approve-read-tools` control it. Bare `mcp` uses explicit `--project`, trusted `CLAUDE_PROJECT_DIR`, or unambiguous cwd and requires a safe `.holoself/link.yaml`; tools cannot supply paths. See [MCP tools](mcp-tools.md).

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

Verify the source checkout with `node bin/holoself.mjs --help`, or a PATH installation with `holoself --help`.

## Reviewed transformations

Preview `holoself knowledge migrate-lenses --root <self-root> --output <plan.json>`. Inspect every operation and the printed digest, then use `holoself knowledge migrate-lenses --root <self-root> --apply <plan.json> --digest <sha256> --yes`. This seeds definitions, merges legacy instruction overrides, renames lens metadata and binding IDs, and preserves proposal archives. Repair each legacy project link afterward.

For a reviewed section edit, supply a JSON array of `{ "path": "context/example.md", "after": "exact complete replacement text", "reason": "reviewed section edit" }` to `knowledge transform --replacements <changes.json>`. Preview/output/apply use the same digest contract. Plans contain complete before/after text and may be private. Apply checks bytes and safe paths, rolls back partial failure, and writes an immutable receipt. Replay requires matching applied bytes.

```powershell
node bin/holoself.mjs knowledge migrate-lenses --root C:/Example/self-copy --output C:/Example/review/lens-plan.json
# Review the plan, then copy its digest into the apply command.
node bin/holoself.mjs knowledge migrate-lenses --root C:/Example/self-copy --apply C:/Example/review/lens-plan.json --digest <sha256> --yes
node bin/holoself.mjs knowledge transform --root C:/Example/self-copy --replacements C:/Example/review/changes.json --output C:/Example/review/section-plan.json
node bin/holoself.mjs knowledge transform --root C:/Example/self-copy --apply C:/Example/review/section-plan.json --digest <sha256> --yes
```

Migration leaves legacy project link choices untouched until explicit `link repair --project <project> --yes --no-activate`. Repair imports configured choices into bindings and preserves the attestation salt. Conflicting existing choices require an explicit reviewed `--lens` selection. Apply refuses stale bytes, symlink ancestors, overlapping targets, protected archives, and a busy authority lock. Partial failure restores changed files and removes files/directories created by the transaction; an empty `.holoself` authority directory may remain. A receipt is written only after validation. This transaction protects recoverable operation failures; it does not provide crash recovery after process or machine termination.

Root instruction changes use an explicit plan kind. Supply exact full replacement text for an existing `AGENTS.md` or `CLAUDE.md`:

```bash
holoself knowledge transform --root <self-root> --plan-kind instruction-replacement --replacements <changes.json> --output <plan.json>
holoself knowledge transform --root <self-root> --apply <plan.json> --digest <sha256> --yes
```

The ordinary section plan protects root instruction files. Instruction plans protect all other targets and cannot create or delete files. Cleanup archives profile/context/topics/reference/me Markdown to its exact `history/<source>` destination and checks ancestors before moves and rollback. Existing cleanup receipts support replay only while the archived bytes match. See [maintenance and external deployment safety](../decisions/external-skill-deployments.md).
