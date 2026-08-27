# Activated project links

A project link is complete only when configuration, agent startup activation, and context resolution pass end to end.

## Configure and activate

```bash
node bin/holoself.mjs link add --project C:/work/project --self C:/private/self --lens career --yes
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
holoself link doctor --project .
```

Use `--no-activate` only for deliberate configuration-only workflows. Use `--instructions <relative-file>` to identify an existing canonical manual. Use `--install-skill auto|project|global|none` to control skill resolution. `project` installs full public skills under `.agents`, `.claude`, and `.pi`; `global` requires validated user-level installations and creates no project copies; `none` disables skill management and validation. Preview lists every instruction, bootstrap/runtime artifact, and skill installation. Activation upgrades the old generated miniature shim in place, rejects symlink parents, malformed or reversed markers, and preserves unmanaged skill files unless `--force --yes` appends a bounded managed installation. Deactivation deletes an unchanged Holoself-owned install, but removes only the managed block when user content was appended. Managed writes roll back on failure.

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

`link status` and `link doctor` report project and global skill installation separately from instruction activation. Under global policy, `doctor` also rejects unexpected project overrides. They report whether this process was invoked from the source checkout or a package bin; running `node bin/holoself.mjs` does **not** mean a global `holoself` command is installed. The npm package remains unpublished, so use the documented source-checkout invocation.

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
