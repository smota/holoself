# Migration from PersonalOS

Holoself is a separate local package. PersonalOS remains a valid source and is not modified.

1. Install Holoself from this workspace, or from npm after a release.
2. Run `holoself init --data-dir <private-path>` (or set `HOLOSELF_HOME=<private-path>`).
3. Run `holoself migrate --data-dir <private-path> --from <PersonalOS-directory> --yes` (replace placeholder with local source path).
4. Review `holoself validate` output and private files.
5. Export to each project with `holoself export --data-dir <private-path> --target <project>`.

Migration maps `personal/profile` → `profile`, `personal/context` → `context`, `personal/reference` → private `reference`, and `personal/me` → private `me`; `topics` remains `topics`. It preserves source and never publishes private files. It does not delete or overwrite source files. Existing user-authored destination files are preserved unless `--force` is supplied; starter templates are replaced only when still unchanged. Symbolic links in source or destination are refused. Migration writes files atomically.

## Preview and migration report

Use `--dry-run` before applying a migration:

```bash
holoself migrate --from <PersonalOS-directory> --data-dir <private-path> --dry-run
```

Dry-run scans and reports source/target roots, detected file count, source-to-destination mappings, copied/preserved/conflicting paths, and skipped, sensitive, or generated paths. It does not create or modify the destination. Reports contain paths and counts only; Holoself never prints private file contents.

An apply writes the same report to `<data-dir>/migration-manifest.json` with `schemaVersion`, tool/version, timestamp, source and target roots, mappings, and file lists. Review conflicts before using `--force`. The source remains unchanged in both modes.

Holoself does not automatically install into AI tools. `skills.sh` is separate. If wanted, install only public instruction with `npx skills add smota/holoself --skill holoself`, then review installer changes. This does not transfer private data.
