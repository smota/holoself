# Privacy

Holoself is local-first. CLI performs no network requests, creates no hosted account, and does not publish data.

Private profile, context, topics, reference material, proposals, and local contribs live under data root selected by `HOLOSELF_HOME` or `--data-dir` (`--root` remains compatibility alias). CLI option wins. Personal data is not included in package source.

## Linked projects

Recommended `link add --project --self` creates project-local metadata with `access: read`; it does not copy canonical self files. Lenses and visibility metadata filter resolved context. Project proposals cannot change canonical context without explicit approval.

Legacy `link --target` creates filesystem symlink/junction to complete data root. It exposes more private context to project tools and should be used only when full live mounting is intended. `unlink` removes only managed link.

## Generated data

Exports, packets, indexes, reports, and project `.holoself/` content are private by default. Review before committing or sharing. Indexing skips recognized secret-like filenames/content and redacts policy metadata, but pattern detection cannot guarantee finding every secret.

## Mutations

Migration copies only after confirmation and never deletes source. Proposal approval shows evidence, target, affected files, and diff, then requires confirmation. Root setup edits only bounded Holoself markers in instruction files. `--dry-run` previews supported operations; automation uses explicit `--yes`.

See [threat model](docs/trust/threat-model.md) and [safety guarantees](docs/trust/safety-guarantees.md).
