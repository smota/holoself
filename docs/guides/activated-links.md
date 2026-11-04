# Activated project links

A project link is complete only when configuration, agent startup activation, and context resolution pass end to end.

Examples use `holoself` where an installed package bin is required and `node bin/holoself.mjs` for a direct source checkout. Both execute the same CLI; see [CLI invocation](../reference/cli.md#invocation).

MCP is an optional second activation surface for Codex, AGY, and Claude Code. It is a client-launched STDIO subprocess, not a service, and never replaces the link or bounded instruction fallback. Configure it separately only after link activation:

```bash
holoself mcp configure --project . --dry-run
holoself mcp configure --project . --yes
holoself mcp status --project .
```

The preview is collision-aware and names exact client files. Generated configuration is not proof of client discovery; record native evidence in the [platform matrix](../reference/platform-verification.md).

## Configure and activate

```bash
node bin/holoself.mjs link add --project C:/work/project --self C:/private/self --lens professional --yes
```

By default, Holoself detects platform evidence, always installs the generic `AGENTS.md` fallback, writes `.holoself/BOOTSTRAP.md` and `runtime.json`, and injects bounded pointers into detected instructions. Personal paths remain in private `link.yaml`; injected instructions contain no absolute self path.

Configurable startup adapter ids: `agents`, `claude`, `codex`, `pi`, `agy`, `antigravity`, `gemini`, `copilot`, `cursor`, and `windsurf`. Antigravity evidence is detected through `ANTIGRAVITY.md` or `.antigravity/`. Generation is not proof of product discovery: activation plans and runtime records expose delivery, discovery, tested-product, version, evidence, and verification fields. See [runtime adapters](runtime-adapters.md).

```bash
# Preview through the interactive confirmation
holoself link add --project . --self <path>

# Select activation
holoself link add --project . --self <path> --activate all --yes
holoself link activate --project . --platform claude --platform pi --yes
holoself link repair --project . --yes
holoself link deactivate --project . --yes
holoself link deactivate --project . --adapters claude --dry-run
holoself link activate --project . --no-hooks --yes
holoself link doctor --project .
```

`link deactivate` always prints its plan, every file and what happens to it, before asking for confirmation. `--dry-run` stops after the plan. `--adapters <list>` removes only the listed adapters' managed sections and project skills, and rewrites `runtime.json` with the rest. When nothing would remain, it deactivates everything, which is also what `all` or omitting the flag does. `agents` can't be removed while other adapters still point to it. A file still recorded for a remaining adapter, such as a canonical file shared through `--instructions`, is kept and reported as `kept-shared`. Global skill deployments are never removed. `link deactivate` rejects flags it doesn't use, such as `--platform` or `--adapter` (the context packet format).

`link repair` restores the adapters recorded in `.holoself/runtime.json`. It does not re-detect hosts, so it doesn't add adapters you didn't activate. With no usable runtime record, it falls back to adapters that still have managed markers, then to detected hosts. In that last fallback it skips any adapter whose instruction file exists without Holoself markers (a file you wrote by hand) and lists it under `skipped_unmanaged`. `AGENTS.md` is always kept, because it holds the canonical section. The printed `activation_plan.source` says which set applied: `recorded`, `detected`, or `explicit` when you pass `--activate` or `--platform`. Recorded adapters that no longer exist are listed under `dropped_adapters`. Run `link repair --project . --dry-run --yes` to see the plan without writing.

Use `--no-activate` only for deliberate configuration-only workflows. Use `--instructions <relative-file>` to identify an existing canonical manual. Use `--install-skill auto|project|global|none` to control skill resolution. `project` installs full public skills under `.agents`, `.claude`, and `.pi`; `global` requires validated user-level installations and creates no project copies; `none` disables skill management and validation. Preview lists every instruction, bootstrap/runtime artifact, and skill installation. Activation upgrades the old generated miniature shim in place, rejects symlink parents, malformed or reversed markers, and preserves unmanaged skill files unless `--force --yes` appends a bounded managed installation. Deactivation deletes an unchanged Holoself-owned install, but removes only the managed block when user content was appended. Managed writes roll back on failure.

### Migrating a legacy `.holoself` mount

Older workspaces that mounted the canonical self root directly at `<project>/.holoself` through a directory symlink or Windows junction fail closed with `LEGACY_MOUNT_DETECTED`. Migrate the mount to a bounded metadata link with `link setup`:

```bash
holoself link setup --project . --dry-run
holoself link setup --project . --lens professional --yes
```

`link setup` verifies that the mount points to a canonical self root (and matches `--self` when provided), prints the exact file and activation plan (`plan_hash`, `.holoself` mount replacement, created metadata files, and host adapters), preflights instruction, skill, hook, and MCP targets before unlinking, and restores the original symlink or junction if any step fails. The canonical self root's contents are never modified.

## Session-start hooks

Instruction pointers and skills ask the agent to load context; nothing guarantees it does. Where a host runs a command when a session starts, activation also installs a session-start hook, so the session begins with the bounded session-start packet for the bound lens. The hook only reads; it never writes canonical data.

| Host | Hook file (project) | State |
|---|---|---|
| Claude Code | `.claude/settings.local.json`, `hooks.SessionStart` | Installed by default; verified on 2.1.318 (`--hook-format text`) |
| Codex | `.codex/hooks.json`, `hooks.SessionStart` | Unverified (`not-installed` by default; `--hooks` installs); needs user trust in `~/.codex/config.toml` (`installed-untrusted` until trusted) |
| AGY | `.agents/hooks.json`, `holoself-session-start.SessionStart` | Unverified (`not-installed` by default; `--hooks` installs with `--hook-format agy-json`); workspace hooks load only for trusted folders |
| Other hosts | none | `unsupported` |

Holoself adds one entry to the Claude Code (`.claude/settings.local.json`) or Codex (`.codex/hooks.json`) settings file:

```json
{
  "matcher": "startup|resume|clear|compact",
  "hooks": [
    {
      "type": "command",
      "command": "holoself context --session-start --budget small --format packet --hook holoself-session-start",
      "timeout": 30
    }
  ]
}
```

For AGY (`.agents/hooks.json`), Holoself writes a named hook entry with `--hook-format agy-json`:

```json
{
  "holoself-session-start": {
    "SessionStart": [
      {
        "type": "command",
        "command": "holoself context --session-start --budget small --format packet --hook holoself-session-start --hook-format agy-json",
        "timeout": 30
      }
    ]
  }
}
```

- **Why `settings.local.json`, `.codex/hooks.json`, and `.agents/hooks.json`.** The command needs `holoself` on this machine's `PATH` and a link to your self root, which collaborators don't share, so it belongs in per-machine settings rather than committed repository files. Holoself doesn't edit `.gitignore`. Check `git check-ignore .claude/settings.local.json .codex/hooks.json .agents/hooks.json` before committing; on the verification machine the pattern `**/.claude/settings.local.json` was already in the user's global git ignore file.
- **No shell syntax and project resolution.** In hook mode the project comes from `--project`, else the `CLAUDE_PROJECT_DIR` environment variable that Claude Code sets for hooks, else the process working directory (`process.cwd()`, which Codex sets to the project root and AGY sets to `<workspace>/.agents` where `.agents/hooks.json` lives), so the command contains no quoting or `$` expansion. The resolved path must be absolute; if it is missing or relative, the hook fails closed. Only Claude Code on Linux (WSL2) has a recorded live verification in `docs/reference/platform-verification.json`. Codex, AGY, and Windows remain `unverified`, so default `auto` leaves them `not-installed` and activation installs them only when `--hooks` is passed.
- **Codex user trust.** Codex 0.166.0 runs a project hook from `.codex/hooks.json` only after the user trusts that hook in `~/.codex/config.toml` (`hooks.state."<file>:session_start:<group>:<hook>".trusted_hash`). Holoself never writes `~/.codex/config.toml`. After installing the Codex hook, Holoself prints the trust instruction: run `codex` in the project and approve the startup `"Hooks need review"` prompt (or run `/hooks` in an interactive `codex` session). Until `~/.codex/config.toml` contains a matching `trusted_hash` (checked read-only when the file exists), `link status` and `link doctor` report the Codex hook state as `installed-untrusted`.
- **Ownership.** The `--hook holoself-session-start` text in the command marks the entry as Holoself's. Other keys and hooks, including other `SessionStart` hooks and other named AGY hooks, are preserved; the file is reformatted as 2-space JSON when Holoself changes it, and left untouched otherwise. Empty `hooks`, `holoself-session-start`, or `SessionStart` containers that existed before are kept on removal; without a runtime record, containers left empty by removing the Holoself entry are removed. A hook file or parent directory (`.claude`, `.codex`, `.agents`) that Holoself created is deleted again when nothing else is left in it.
- **File mode.** A settings file that already exists keeps its permission bits (it can hold `env` secrets); a file Holoself creates is mode 0600.
- **Choice.** `--hooks` installs the hook even for a host without a recorded verification; `--no-hooks` skips it and removes an existing Holoself entry. The choice is recorded as `hookPolicy` in `.holoself/runtime.json`, and `link repair` restores the recorded `hookInstallations`. `link deactivate`, including `--adapters claude|codex|agy`, removes the entry.
- **Safety.** A symlinked settings file or parent folder (`.claude`, `.codex`, `.agents`), invalid JSON, and a group that holds the Holoself hook together with foreign hooks are refused before any write. The plan (`session_start_hooks`, with `install` and `action`) is printed before confirmation and by `--dry-run`. Hook writes roll back with the other managed files on failure. If the settings file becomes invalid or unsafe after installation, `link deactivate` and `link remove` report the hook as `unremovable`, leave the file alone, and carry on; remove the `holoself-session-start` entry by hand. `link remove` deactivates first, but always revokes the link and removes the lens binding even when deactivation is refused; it then prints a warning to finish with `link deactivate`.
- **Hook mode and output formats.** `--hook holoself-session-start` makes `holoself context` exit 0 in every case and write nothing to stderr. `--hook-format text` (the default, used by Claude Code and Codex) prints only the plain-text packet and prints nothing on any refusal. `--hook-format agy-json` (used by AGY) wraps the packet in `{"injectSteps":[{"systemMessage":{"systemMessage":"<packet>"}}]}` and on any refusal prints the empty envelope `{"injectSteps":[]}`, so AGY parses a valid empty response without injecting unauthorized context. The output (including the JSON envelope in `agy-json` mode) is capped at 9,000 bytes, because Claude Code moves hook output above 10,000 characters to a file and shows the model only a preview; documents are dropped first and the receipt is kept. Set `HOLOSELF_HOOK_AUDIT_LOG=<absolute file>` to append one line per run with the outcome, error code, packet id and receipt; it records no content or paths and uses the same hardened writer as the MCP audit log (no symlinks or hard links, mode 0600, 10 MiB cap).
- **Status.** `link status` lists `session_start_hooks` for each activated host as `installed`, `installed-untrusted`, `missing`, `drifted`, `untracked`, `disabled`, `not-installed`, or `unsupported`. `link doctor` summarises them in `checks.session_start_hook`; `missing` and `drifted` make the link degraded, while `installed-untrusted` surfaces the pending Codex trust step without failing the link check.

## MCP servers

Activation also configures the project-local MCP server for hosts where Holoself MCP is verified (see [local MCP](local-mcp.md)). The default (`auto`) covers each activated host whose MCP support is `verified` in `docs/reference/platform-verification.json`; a host is activated when it is detected for this project (its directory or instruction file) or selected with `--platform`/`--activate`. Other hosts, such as Pi or Gemini CLI, keep `.holoself/BOOTSTRAP.md` and the CLI and are listed under `mcp_fallback`.

| Host | File | Default |
|---|---|---|
| Claude Code | `.mcp.json` | configured when activated (verified on 2.1.318) |
| Codex | `.codex/config.toml` managed block | configured when activated (verified on 0.166.0) |
| AGY | `.agents/mcp_config.json` | configured when activated (verified on 1.5.0) |

```text
holoself link activate --project . --no-mcp --yes          # keep BOOTSTRAP + CLI only
holoself link activate --project . --mcp --yes             # every activated MCP-capable host, verified or not
holoself link activate --project . --approve-read-tools --yes
```

- **Plan.** `mcp_policy`, `mcp_servers` (with `install`, `action` and any `reason`), `mcp_fallback` and, when Codex or AGY are configured, `mcp_commit_warning` are printed before confirmation and by `--dry-run`.
- **Ownership.** `.holoself/runtime.json` records `mcpPolicy`, `mcpApproveReadTools` and `mcpInstallations` (file, whether Holoself created the file or the `mcpServers` container, and the approval entries it added). `link repair` restores them. `link deactivate`, including `--adapters <host>`, removes only those recorded entries: other MCP servers, other permissions and your own copies of the same rules stay, and a file Holoself created is deleted when nothing else is left in it. A recorded entry that was changed by hand is reported as `unremovable` and left alone. Entries written by `holoself mcp configure` are not recorded and are not removed by deactivation.
- **Collisions.** The default skips a host whose file already has a different `holoself` server and reports `action: skipped`; `--mcp` refuses instead. Symlinked or invalid configuration files are refused before any write, and MCP writes roll back with the other managed files.
- **Read-tool pre-approval.** `--approve-read-tools` is opt-in and recorded; `--no-approve-read-tools` removes the recorded entries. It never includes `holoself_proposal_create`. Claude Code entries go in `.claude/settings.local.json` next to the session-start hook, Codex entries in the managed block, and AGY is documented only (no project settings file).

## User-level skills and project cleanup

Install or inspect the complete public skill once for the current user:

```bash
holoself skill status --scope user
holoself skill install --scope user --dry-run
holoself skill install --scope user --yes
```

User-level installation writes only after confirmation. Existing unmanaged files are reported as collisions and require reviewed `--force --yes` replacement. Use `--skill-home <dir>` to inspect or test an isolated user home.

After the global installations are healthy, migrate a linked project transactionally:

```bash
holoself link skill migrate-global --project . --dry-run
holoself link skill migrate-global --project . --yes
```

Migration validates every required global skill before changing the project, repairs the bounded activation metadata, removes generated project copies, records runtime schema 2 with `skillInstallPolicy: "global"`, and rolls back on failure. User-authored content outside managed skill markers is preserved; the remaining local file is reported as a project override and keeps `link doctor` degraded until the user relocates or reviews it.

`link status` and `link doctor` report project and global skill installation separately from instruction activation. Under global policy, `doctor` also rejects unexpected project overrides. They report whether this process was invoked from the source checkout or a package bin; running `node bin/holoself.mjs` does **not** mean a global `holoself` command is installed. Install `holoself-ai` from npm and verify `holoself --version` before configuring clients that launch the package bin.

## Project context boundaries

Control-plane and canonical-self YAML are strict and fail closed. Arbitrary project Markdown frontmatter is tolerant and isolated: recognized privacy fields are preserved when unrelated YAML syntax is unsupported; otherwise content defaults private. Unclosed frontmatter is always restricted to private. Agent configuration, skills, generated files, dependencies, and Holoself operational files are excluded by default.

```bash
holoself link add --project . --self <path> --yes \
  --project-include "Master/**/*.md,Candidatures/**/*.md" \
  --project-exclude "Candidatures/archive/**"
```

## Sandboxed platforms

Platforms that cannot access external paths—including many Claude Desktop/Cowork and ChatGPT/Cowork configurations—cannot use a live metadata link. Generate a reviewed snapshot explicitly:

```bash
holoself context --project . --snapshot --adapter generic --yes
```

This writes `.holoself/runtime/context-packet.md`. It is generated, potentially sensitive, and stale until refreshed. Markdown in canonical self remains source of truth.

## Skills Manager deployments

A directory junction or symlink at a known `holoself` skill location can be inspected as an external deployment when it contains the exact current public skill and its source/target paths pass the strict checks. It is reported as current and read-only. Holoself does not update or remove that deployment, even with `--force`; use its deployment manager. Identical external local deployments appear in diagnostics without causing an override conflict. Changed, missing, inaccessible, or linked ancestor paths remain degraded with a corrective action.

Codex global skills live under `.codex/skills`, Claude under `.claude/skills`, and Pi under `.pi/agent/skills`. Pi's project skills remain under `.pi/skills`. A selected Codex/Claude/Pi provider supplies the global skill; the generic `AGENTS.md` instruction fallback remains in the project. For example, after deploying the current public skill globally through your manager:

```bash
holoself skill status --scope user --platform codex
holoself link repair --project . --activate agents,codex --install-skill global --dry-run
holoself link repair --project . --activate agents,codex --install-skill global --yes
holoself link doctor --project .
```

Review the dry-run before applying. Diagnostic artifact validation does not prove native host discovery. Read the [external deployment decision](../decisions/external-skill-deployments.md) for the path, ownership, and compatibility contract.
