# Filesystem layout

## Self root

```text
<data-root>/
  config.json
  AGENTS.md
  profile/
  context/
  lenses/<id>.json         # uniform self-side definitions
  lenses/bindings.json     # normalized project choices
  .holoself/links.json     # attestation salts and grants
  .holoself/maintenance-receipts/ # immutable digest receipts
  topics/
  reference/
  me/
  contribs/local/        # private extensions; public defaults remain in the product package
  proposals/{pending,approved,rejected,deferred,superseded,receipts}/
  history/
  exports/
```

## Linked project

```text
<project>/.holoself/
  link.yaml
  README.md
  BOOTSTRAP.md             # after instruction activation
  runtime.json             # after instruction activation
  index/
  proposals/
  reports/
  runtime/                 # optional reviewed context snapshots
```

Self root owns approved reusable context and lens definitions and bindings. Project owns `.holoself` operational and review artifacts. A missing registry reads as empty; init or reviewed migration seeds definitions. Read-only inspection creates no files. Indexes and packets are generated. Markdown profile/context remains canonical.

A legacy live mount also uses path `<project>/.holoself`, but that path is a symlink/junction to self root rather than metadata directory. Modes must not be mixed.
