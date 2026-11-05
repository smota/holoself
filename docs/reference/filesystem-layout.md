# Filesystem layout

## Self root

```text
<data-root>/
  config.json              # includes self_id (hs-self-<32 hex>), random, committed with the self
  AGENTS.md
  profile/
  context/
  lenses/<id>.json         # uniform self-side definitions
  lenses/bindings.json     # project choices keyed by project_key (legacy: absolute project path)
  .holoself/links.json     # attestation salts and grants, keyed by this machine's project path (git-ignored)
  .holoself/clients.json   # unlinked desktop MCP client grants (one lens each), mode 0600
  .holoself/maintenance-receipts/ # immutable digest receipts
  topics/
  reference/
  me/
  contribs/local/        # private extensions; public defaults remain in the product package
  proposals/{pending,approved,rejected,deferred,superseded,receipts}/
  proposals/inbox/         # pending proposals from desktop clients with proposals: inbox
  history/
  exports/
```

## Linked project

```text
<project>/.holoself/
  link.yaml                # project_key + self_context.self_id; legacy links hold self_context.path
  README.md
  BOOTSTRAP.md             # after instruction activation
  runtime.json             # after instruction activation
  index/
  proposals/
  reports/
  runtime/                 # optional reviewed context snapshots
```

Self root owns approved reusable context and lens definitions and bindings. Project owns `.holoself` operational and review artifacts. A missing registry reads as empty; init or reviewed migration seeds definitions. Read-only inspection creates no files. Indexes and packets are generated. Markdown profile/context remains canonical.

## Per-user configuration (one per machine)

```text
<config-dir>/              # HOLOSELF_CONFIG_DIR | %APPDATA%\holoself | $XDG_CONFIG_HOME/holoself | ~/.config/holoself
  selves.json              # self_id -> this machine's self checkout; mode 0600, directory 0700
```

`config.json`, `lenses/bindings.json` and a portable `link.yaml` contain no machine-specific path and can be synced with the self repository and the project. `selves.json`, `.holoself/links.json` and generated indexes stay per machine. Bindings keyed by absolute path are legacy entries; `link repair` replaces this project's entry with its `project_key`, and `link doctor` counts the rest (`path_keyed_bindings`). See [Use one self on several machines](../guides/multiple-machines.md) and [schemas/selves.schema.json](../../schemas/selves.schema.json).

A legacy live mount also uses path `<project>/.holoself`, but that path is a symlink/junction to self root rather than metadata directory. Modes must not be mixed.
