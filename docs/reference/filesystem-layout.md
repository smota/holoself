# Filesystem layout

## Self root

```text
<data-root>/
  config.json
  AGENTS.md
  profile/
  context/
  topics/
  reference/
  me/
  contribs/default/
  contribs/local/
  proposals/{pending,approved,rejected,deferred}/
  exports/
```

## Linked project

```text
<project>/.holoself/
  link.yaml
  README.md
  index/
  proposals/
  reports/
```

Self root owns approved reusable context. Project owns `.holoself` operational and review artifacts. Indexes and packets are generated. Markdown profile/context remains canonical.

A legacy live mount also uses path `<project>/.holoself`, but that path is a symlink/junction to self root rather than metadata directory. Modes must not be mixed.
