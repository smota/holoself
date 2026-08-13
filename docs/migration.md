# Migration from PersonalOS

Holoself is a separate local package. PersonalOS remains a valid source and is not modified.

1. Install Holoself from this workspace, or from npm after a release.
2. Run `holoself init --root <private-path>`.
3. Run `holoself migrate --root <private-path> --from C:\\Code\\PersonalOS --yes`.
4. Review `holoself validate` output and private files.
5. Export to each project with `holoself export --root <private-path> --target <project>`.

Migration copies `personal/` into the Holoself data root and preserves source. It does not publish, delete, or overwrite source files. Existing destination files are preserved unless `--force` is supplied; starter templates are replaced only when still unchanged. Symbolic links in source or destination are refused. Migration writes files atomically.

Holoself does not automatically install into AI tools. `skills.sh` is separate. If wanted, install only public instruction with `npx skills add smota/holoself --skill holoself`, then review installer changes. This does not transfer private data.
