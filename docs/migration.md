# Migration from PersonalOS

1. Install Holoself from this workspace or npm when published.
2. Run `holoself init --root <private-path>`.
3. Run `holoself migrate --root <private-path> --from C:\\Code\\PersonalOS --yes`.
4. Review `holoself validate` output and private files.
5. Export to each project with `holoself export --target <project>`.

Migration copies `personal/` into the Holoself data root and preserves the PersonalOS source. It does not publish, delete, or overwrite source files. Use `--force` only when intentionally replacing existing destination profile/context files.
