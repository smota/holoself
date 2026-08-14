# First linked project

## Preview setup

```bash
node bin/holoself.mjs link setup --project C:/work/project
```

Without `--self --yes`, setup reports instructions, profile-like files, suggested lens, likely duplicates, and migration recommendations without writing configuration.

## Confirm link

```bash
node bin/holoself.mjs link setup --project C:/work/project --self C:/private/my-self --yes
```

Or add directly:

```bash
node bin/holoself.mjs link add --project C:/work/project --self C:/private/my-self --lens career --secondary-lenses technical,leadership --yes
```

`link add` detects agent platforms, generates `.holoself/BOOTSTRAP.md` and runtime metadata, and injects bounded startup pointers after confirmation. Use `--no-activate` only for deliberate configuration-only setup. See [Activated project links](../guides/activated-links.md).

## Verify behavior

```bash
node bin/holoself.mjs link status --project C:/work/project
node bin/holoself.mjs context --project C:/work/project --lens career --format packet --adapter generic
node bin/holoself.mjs analyze all --project C:/work/project
```

Reports recommend actions and do not mutate project files. Canonical self changes require proposals and approval.

## Remove configuration

```bash
node bin/holoself.mjs link remove --project C:/work/project --yes
```

Removal deletes managed activation and `link.yaml`; reports, proposals, indexes, bootstrap, and project artifacts remain for review. It does not delete or relocate project artifacts.
