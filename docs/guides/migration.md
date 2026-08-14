# Migration guide

Migration copies supported PersonalOS data into private Holoself layout. Source remains unchanged.

```bash
node bin/holoself.mjs migrate --from C:/private/PersonalOS --data-dir C:/private/my-self --dry-run --yes
node bin/holoself.mjs migrate --from C:/private/PersonalOS --data-dir C:/private/my-self --yes
```

Dry run reports paths and counts without printing private content. Existing user-authored destinations are preserved unless `--force`. Applied migration writes `migration-manifest.json`.

Do not begin by restructuring every project. Recommended order: initialize self, inspect migration, establish ownership, add project links, resolve conflicts through reports and proposals, then retire duplicates gradually.

Legacy entry point: [../migration.md](../migration.md).
