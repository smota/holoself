# Activated project links

A project link is complete only when configuration, agent startup activation, and context resolution pass end to end.

## Configure and activate

```bash
node bin/holoself.mjs link add --project C:/work/project --self C:/private/self --lens career --yes
```

By default, Holoself detects platform evidence, always installs the generic `AGENTS.md` fallback, writes `.holoself/BOOTSTRAP.md` and `runtime.json`, and injects bounded pointers into detected instructions. Personal paths remain in private `link.yaml`; injected instructions contain no absolute self path.

Supported adapter ids: `agents`, `claude`, `codex`, `pi`, `agy`, `antigravity`, `gemini`, `copilot`, `cursor`, and `windsurf`. Antigravity is detected through `ANTIGRAVITY.md` or `.antigravity/`.

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

Use `--no-activate` only for deliberate configuration-only workflows. Use `--instructions <relative-file>` to identify an existing canonical manual. Use `--install-skill auto|project|none` to control generated skill shims. Preview lists every instruction, bootstrap/runtime artifact, and skill shim. Activation rejects symlink parents, malformed or reversed markers, and unmanaged skill collisions before writing; `--force --yes` may append a bounded managed shim to an existing skill without replacing its content. Managed writes roll back on failure. Runtime drift hashes only bounded managed blocks, so ordinary user edits outside those blocks remain valid.

## Project context boundaries

Control-plane and canonical-self YAML are strict and fail closed. Arbitrary project Markdown frontmatter is tolerant and isolated: recognized privacy fields are preserved when unrelated YAML syntax is unsupported; otherwise content defaults private. Unclosed frontmatter is always restricted to private. Agent configuration, skills, generated files, dependencies, and Holoself operational files are excluded by default.

```bash
holoself link add --project . --self <path> --yes \
  --project-include "Master/**/*.md,Candidatures/**/*.md" \
  --project-exclude "Candidatures/archive/**"
```

## Sandboxed platforms

Platforms that cannot access external paths cannot use a live link. Generate a reviewed snapshot explicitly:

```bash
holoself context --project . --snapshot --adapter generic --yes
```

This writes `.holoself/runtime/context-packet.md`. It is generated, potentially sensitive, and stale until refreshed. Markdown in canonical self remains source of truth.
