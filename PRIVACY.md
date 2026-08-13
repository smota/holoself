# Privacy

Holoself is local-first. Profile, context, topics, and local contribs are written under the data root selected by `HOLOSELF_HOME` or `--data-dir` (`--root` remains a compatibility alias). The CLI option wins when both are supplied. They are not included in the package source and no network operation is performed by the CLI.

Treat project exports as private. Review `.holoself/` before committing. `migrate` copies files only after confirmation and never deletes the source. `link` creates a local filesystem link; `unlink` refuses to remove a non-link. `export --root-setup` asks for explicit confirmation before modifying AGENTS.md, CLAUDE.md, or CODEX.md and updates only Holoself marker content.

Public skills and defaults must not contain personal profile or context. Keep private contribs in `<data-root>/contribs/local/`.
