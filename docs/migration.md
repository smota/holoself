# Migration from PersonalOS

This compatibility reference remains for existing links. Current guide: [guides/migration.md](guides/migration.md).

Holoself is separate local product. PersonalOS source remains unchanged.

1. Initialize private data root.
2. Preview migration with `--dry-run --yes`.
3. Apply only after reviewing mappings.
4. Validate destination.
5. Add project metadata links gradually; do not restructure every project at once.

```bash
node bin/holoself.mjs init --data-dir C:/private/my-self
node bin/holoself.mjs migrate --data-dir C:/private/my-self --from C:/private/PersonalOS --dry-run --yes
node bin/holoself.mjs migrate --data-dir C:/private/my-self --from C:/private/PersonalOS --yes
node bin/holoself.mjs validate --data-dir C:/private/my-self
```

Existing destination files are preserved unless `--force`. Applied migration writes `migration-manifest.json`. Private `reference/` and `me/` stay private; generated or repository files are skipped. Source is never deleted or rewritten.
