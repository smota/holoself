# Use one self on several machines

Many owners keep their self root in a git repository and clone it, and the projects linked to it, on more than one machine (a desktop and a laptop, or Windows and WSL). The clones usually live at different paths. Portable links let the synced files name the self and each project by stable identifiers, and keep the only machine-specific fact, where the self is checked out on this machine, in a small per-user file.

Design and security rationale: [Portable links across machines](../decisions/portable-links.md).

## Concepts

| Identifier | Where it lives | Synced? | What it does |
|---|---|---|---|
| `self_id` (`hs-self-<32 hex>`) | the self root's `config.json` | yes, with the self repository | names the self; random, created once |
| `project_key` (`hs-proj-<32 hex>`) | the project's `.holoself/link.yaml` | yes, with the project | names the linked project; random, kept across rewrites |
| self map `selves.json` | your per-user configuration directory | **no**, one per machine | maps each `self_id` to this machine's checkout path |
| attestation registry | the self root's `.holoself/links.json` | **no**, git-ignored | records which project paths this machine trusts, with their `binding_salt` |

A portable `link.yaml` looks like this. It contains no absolute path, so it is the same file on every machine:

```yaml
project_key: "hs-proj-0123456789abcdef0123456789abcdef"
self_context:
  self_id: "hs-self-fedcba9876543210fedcba9876543210"
  access: "read"
  proposals: "enabled"
  index: "local"
  binding_salt: "00112233445566778899aabbccddeeff"
```

The self's `lenses/bindings.json` keys the project's lens choice by `project_key`, so one entry serves every machine.

When Holoself reads a link with a `self_id`, it tries, in order, and accepts a candidate only if its `config.json` carries the same `self_id`:

1. an explicit `--self` or `--root` (a different self is refused with `SELF_ROOT_NOT_CANONICAL`);
2. `HOLOSELF_HOME`, when set (a different self is skipped, so one machine can hold several selves);
3. this machine's self map entry;
4. a legacy `self_context.path`, if the link still has one.

If none matches, the command fails closed with `SELF_NOT_FOUND`. Session-start hooks stay silent, as for any refusal (no output, or the empty AGY envelope with `--hook-format agy-json`; exit 0).

### Where the self map lives

`selves.json` is in the first of these that applies:

- `HOLOSELF_CONFIG_DIR`, when set to an absolute path;
- `%APPDATA%\holoself` on Windows;
- `$XDG_CONFIG_HOME/holoself`, when `XDG_CONFIG_HOME` is an absolute path;
- `~/.config/holoself`.

Holoself writes it with mode `0600` (and creates the directory with mode `0700`), refuses a symlinked file or directory, and treats a malformed file as empty (with a diagnostic in `machine status`). Reading never writes it. WSL and Windows have separate home directories, so each has its own self map; register the self on each.

`HOLOSELF_HOME` still selects the default self root for commands that take `--root`. It is no longer the only way to find a linked project's self: hosts that start hooks and MCP servers without your shell profile resolve the self through the self map instead.

## First machine

```bash
holoself init --data-dir ~/code/my-self
holoself link setup --project ~/code/my-project --self ~/code/my-self --yes
```

`init` writes a `self_id`. `link setup` (or `link add`) writes a portable `link.yaml`, registers this machine's checkout in the self map, keys the lens binding by `project_key`, and attests the project in this machine's registry. Commit the self repository and the project as listed below.

## Additional machine

1. Upgrade Holoself on this machine first (see the warning below).
2. Clone or pull the self repository and the project, at any paths.
3. Join the project on this machine:

   ```bash
   holoself link setup --project ~/work/my-project --self ~/work/my-self --yes
   ```

   Because the project's `link.yaml` already names this self, setup keeps its `project_key`, `binding_salt`, project context filters and lens binding (unless you pass `--lens` or the project filters) and does not ask for `--force`; the file's content stays the same. It registers the self in this machine's map and attests the project in this machine's registry. Avoid `--force` on a project that other machines already use: it creates a new `binding_salt`, which no other machine's registry attests.

   Equivalent without activation changes:

   ```bash
   holoself machine register --root ~/work/my-self
   holoself link approve --project ~/work/my-project --self ~/work/my-self
   ```

4. Check it: `holoself machine status` and `holoself link doctor --project ~/work/my-project`.

Each machine attests each project once. A cloned project cannot attest itself: a committed `binding_salt` grants nothing until that machine's owner runs `link setup` or `link approve`.

## Migrating existing links

Links created by Holoself 0.11 and earlier store `self_context.path` and key the binding by absolute project path. They keep working exactly as before. To migrate one, on each machine:

```bash
holoself link repair --project ~/code/my-project --dry-run
holoself link repair --project ~/code/my-project --yes
```

`link repair` (and `link setup` on an existing link) adds a `self_id` to the self if it has none, registers this machine, adds a `project_key` to `link.yaml`, moves this project's lens binding from its path key to the `project_key` (in one write), records the `project_key` in the registry entry, and drops `self_context.path` once the self resolves through the self map. The existing `binding_salt` is kept, so the attestation stays valid. `--dry-run` prints a `portable_migration` plan and writes nothing. If the link no longer resolves (for example the self moved), pass `--self <dir>`.

Path-keyed bindings written by other machines stay until those machines run `link repair`. `holoself link doctor --project <dir>` reports `path_keyed_bindings`, and `holoself doctor --root <dir>` warns while any remain.

> **Upgrade every machine before repairing links.** Older Holoself versions cannot read a `link.yaml` without `self_context.path`, nor a `bindings.json` keyed by `project_key`. Once one machine repairs a link and you sync it, a machine still on an older version stops serving context for that project until it is upgraded.

## What to commit and what to ignore

In the **self repository**:

| Commit | Keep local (git-ignored by `.holoself/.gitignore`) |
|---|---|
| `config.json` (with `self_id`), `profile/`, `context/`, `history/`, `topics/`, `reference/`, `me/`, `proposals/` | `.holoself/links.json` (attestation registry), `.holoself/clients.json` |
| `lenses/` including `lenses/bindings.json` | `.holoself/catalog/`, `.holoself/index/`, `.holoself/runtime/`, ledgers |

In each **client project**:

| Commit (portable) | Keep per machine |
|---|---|
| `.holoself/link.yaml` once it has `self_id` and `project_key` and no `self_context.path` | `.holoself/catalog/`, `.holoself/index/`, `.holoself/runtime*`, `.holoself/reports/`, ledgers (already in `.holoself/.gitignore`) |
| `.holoself/README.md`, `.holoself/.gitignore`, `.holoself/proposals/` | `.codex/config.toml` and `.agents/mcp_config.json` Holoself entries: they embed the absolute project path |
| `.mcp.json` (Claude's entry uses `--claude-project-dir`, no path) | `.claude/settings.local.json`, `.codex/hooks.json`, `.agents/hooks.json`: per-machine host settings (see [Activated project links](activated-links.md#session-start-hooks)) |

A legacy `link.yaml` that still has `self_context.path` contains a personal absolute path; run `link repair` before committing it. Committing `link.yaml` never grants access by itself: the self map and the registry on each machine decide.

## Troubleshooting `SELF_NOT_FOUND`

`self hs-self-… has no checkout registered on this machine` means none of the candidates above is a self with that id. Check:

- `holoself machine status`: is the self registered, does its path exist, and does its `config.json` still carry the id (`id_matches`)? A stale entry is ignored, never served.
- Did the self move? Run `holoself machine register --root <dir>` at the new path.
- Is this a different self (a fresh `init` creates a new `self_id`)? Link the project to it with `link setup --force`, or restore the original `config.json`.
- Is `selves.json` malformed or a symlink? `machine status` reports it; fix or delete the file and register again.
- Remove an entry you no longer want with `holoself machine forget <self_id> --yes`.

`HOLOSELF_CONFIG_DIR` overrides the self map location; tests and sandboxes should point it at a temporary directory.
