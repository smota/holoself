# Changelog

All notable Holoself releases are documented here.

## [0.5.0] — 2026-08-13

Holoself v0.5.0 establishes the local-first architecture and public distribution boundary for the first release.

### Architecture

- Markdown-first private data root for profile, context, topics, references, local extensions, and generated exports.
- Versioned `config.json`, public contrib catalog, self-contained context packets, atomic writes, and review-before-save workflow.
- Clear ownership model separates user-private data, Holoself-managed files, project-owned instructions, and package-owned public assets.

### Public contrib library

- Ships a catalogued library of synthetic/public framework defaults under `contribs/default/`.
- `init --contribs`, `--exclude-contrib`, and `upgrade` provide explicit selection and refresh behavior.
- Local contribs remain under the private data root and are never packaged.

### CLI safety

- Migration, linking, and project instruction setup require explicit confirmation (or `--yes` for automation).
- Writes use temporary files and rename; exports are staged and prior exports are backed up.
- Existing non-Holoself paths, symlinks, and junctions are refused rather than replaced. No command sends data, publishes npm, or deploys a site.

### Migration, export, and links

- PersonalOS profile, context, topics, reference, and `me` data map into corresponding private Holoself namespaces without deleting source data.
- Export creates a reviewable `.holoself` project packet containing Markdown profile/context and a context packet; `--packet-only` makes it self-contained.
- `--root-setup` updates bounded markers in project instruction files only after confirmation.
- `link` and `unlink` manage only a link owned by Holoself and pointing at the selected private data root.

### Skill distribution and privacy

- Public `skills/holoself/` instruction is distributed separately from private data and can be installed through skills.sh after review.
- npm package contains source, CLI, public skills/contribs, docs, and release metadata only; private profile, context, topics, references, and local contribs are excluded.
- Project exports and links can expose private context to project tools; review before committing or sharing.

### Tests and known limitations

- Test suite covers initialization, validation, migration safeguards, export refresh and packet-only mode, link safety, contrib selection, and private Markdown boundaries.
- Known limitations: Holoself does not automatically install skills, synchronize data, or provide remote storage; project exports require manual review and each project must be exported separately.

[0.5.0]: https://github.com/smota/holoself/releases/tag/v0.5.0
