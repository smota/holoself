# Filesystem layout

## Self root

```text
<data-root>/
  config.json
  AGENTS.md
  profile/
  context/
  lenses/                 # optional private custom-lens JSON definitions
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

Self root owns approved reusable context and the optional custom-lens registry. Project owns `.holoself` operational and review artifacts. A missing `lenses/` directory is valid and is never created by read-only lens inspection. Indexes and packets are generated. Markdown profile/context remains canonical.

A legacy live mount also uses path `<project>/.holoself`, but that path is a symlink/junction to self root rather than metadata directory. Modes must not be mixed.
