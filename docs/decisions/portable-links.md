# Portable links across machines

Status: accepted (2026-11-05). Tracking issue: #131.

## Problem

Many owners keep the self root in a git repository and clone it, and their client projects, on several machines at different paths. Today three pieces of synced state hold absolute, machine-specific paths:

- A client project's `.holoself/link.yaml` stores `self_context.path` as an absolute path (`writeLink`). On another machine it points nowhere, and committing it publishes a personal path.
- The self's `lenses/bindings.json` is committed with the data repository but keyed by absolute project path (`normalizeProjectPath`). An entry written on machine A does not match on machine B (`LENS_BINDING_REQUIRED`), and both machines' entries accumulate in git.
- Symlinks do not help: project and self paths are realpath-canonicalized before storage and comparison.

The per-machine pieces are already right and stay per-machine: the self's `.holoself/links.json` (attestation registry), `clients.json`, catalog, index and ledger are git-ignored. Session-start hooks and Claude's `.mcp.json` entry contain no paths.

An environment variable alone is not enough. Hosts launch hooks and MCP servers themselves; desktop applications often do not inherit shell profile variables, and WSL and Windows have separate environments. One variable also allows only one self per machine, and it does nothing for `bindings.json`.

## Decision

Reference the self and each project by stable identifiers in synced files, and keep the identifier-to-path mapping in a small per-machine file.

### 1. Self identifier

The self root's `config.json` (already committed with the data repository) gains `self_id`, format `hs-self-<32 lowercase hex>`, generated randomly once. `holoself init` writes it; `link setup`, `link add`, `link repair`, `link approve` and `machine register` add it to an existing self that lacks one, preserving every other `config.json` field and formatting conventions used elsewhere. A self without `self_id` keeps working through legacy paths.

### 2. Per-machine self map

A per-user file maps `self_id` to this machine's checkout:

- Location: `HOLOSELF_CONFIG_DIR` if set to an absolute path; otherwise `%APPDATA%\holoself` on Windows; otherwise `$XDG_CONFIG_HOME/holoself` when `XDG_CONFIG_HOME` is absolute; otherwise `~/.config/holoself`. File: `selves.json`.
- Content: `{ "schema_version": 1, "selves": { "<self_id>": { "path": "<absolute realpath>", "updated_at": "<iso>" } } }`, with a JSON schema in `schemas/`.
- Written atomically with mode `0600` (directory `0700` when created), refusing a symlinked file or directory, following the existing atomic-write and path-guard helpers. A malformed or unsafe file fails closed (treated as no entries, with a diagnostic), never as a crash in hook mode.
- Written by `link setup`, `link add`, `link repair`, `link approve` and `holoself machine register`. Reading never writes.
- A self registered under an id whose `config.json` no longer carries that id is ignored with a diagnostic.

New command family `holoself machine`:

- `machine status [--json]` lists registered selves, whether each path exists, and whether its `config.json` id matches.
- `machine register [--root <self>]` (default root resolution as today: `--root`/`HOLOSELF_HOME`/`~/.holoself`) ensures `self_id` and records this machine's path. Supports `--dry-run`.
- `machine forget <self_id> --yes` removes an entry.

### 3. Link file

`link.yaml` gains `self_context.self_id` and a root-level `project_key` (format `hs-proj-<32 lowercase hex>`, random once per project, preserved across rewrites like `binding_salt`). New writes omit `self_context.path`. The schema requires `self_id` or `path` (both allowed). With `project_key` and `self_id` and no path, `link.yaml` contains no machine-specific data and may be committed in the client project; the attestation registry remains per machine.

### 4. Resolving the self for a linked project

For a link carrying `self_id`, candidates are tried in this order, and a candidate is accepted only if it is a canonical self whose `config.json` `self_id` equals the link's:

1. An explicit `--self`/`--root` (as today, an explicit root that is not the link's self is refused; the comparison is by `self_id`, error `SELF_ROOT_NOT_CANONICAL`).
2. `HOLOSELF_HOME`, when set. A mismatching `HOLOSELF_HOME` is skipped, not an error, so one machine can hold several selves.
3. The per-machine map entry for `self_id`.
4. A legacy `self_context.path`, if present.

If none matches, resolution fails closed with `SELF_NOT_FOUND`: `self <self_id> has no checkout registered on this machine; run 'holoself machine register --root <dir>' or 'holoself link setup'`. Hook mode stays silent as for any refusal (prints nothing, or the empty `{"injectSteps":[]}` envelope with `--hook-format agy-json`, and exits 0). A link with only a legacy `path` resolves exactly as before.

This applies everywhere `link.yaml` is read: `readLink`, caller resolution, hook mode, MCP, Workbench and every `link` subcommand that parses `link.yaml` directly.

### 5. Bindings keyed by project key

`lenses/bindings.json` accepts `project_key` keys next to legacy absolute-path keys. Lookup for a project with a `project_key` tries the key first, then the legacy path match. Writing a binding for such a project writes the key and removes that project's path-keyed entry in the same atomic write. `link repair` and `link setup` migrate the current project's entry. Entries from other machines stay until those machines run `link repair`; `link doctor` and `holoself doctor` report the number of remaining path-keyed entries.

### 6. Attestation stays per machine

The registry (`.holoself/links.json`) stays git-ignored and path-keyed (`project_id` remains the path hash). Entries additionally record `project_key` when known, so space discovery (Workbench, `lens bindings`) can join registry paths to key-keyed bindings. Each machine still attests each project once (`link setup` or `link approve`); a cloned project cannot attest itself, and committing `binding_salt` grants nothing without that machine's registry entry.

### 7. Migration and compatibility

- `link repair` and `link setup` on an existing link add `self_id` to the self, register this machine, add `project_key` to `link.yaml`, migrate the binding, and drop `self_context.path` once the self resolves through the map.
- Older Holoself versions cannot read a link without `self_context.path`; upgrade every machine before repairing links. The release notes and the guide say so.
- Codex and AGY MCP configurations still embed the absolute project path and remain per-machine files; the guide lists which project files to commit and which to ignore.

## Security

- Identifiers are random and carry no path or personal data.
- A link's `self_id` only selects among selves already present on this machine; every candidate is verified against its own `config.json`, and attestation and lens authority are unchanged.
- `HOLOSELF_HOME` or the map pointing at a different self cannot serve it to the project: the id must match, and that self's registry must attest the project.
- `selves.json` is per-user, `0600`, symlink-refusing, and fails closed.
