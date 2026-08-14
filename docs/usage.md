# Holoself usage

This compatibility entry point remains for existing links. Current task-oriented documentation:

- [Quickstart](start/quickstart.md)
- [First linked project](start/first-linked-project.md)
- [CLI reference](reference/cli.md)
- [Link, mount, or export?](guides/link-or-export.md)
- [Indexing and search](guides/indexing-and-search.md)
- [Proposal review](concepts/proposal-review.md)

Holoself stores private Markdown under selected data root (`HOLOSELF_HOME`, `--data-dir`, or default `~/.holoself`). Linked projects should normally use metadata `link add`. Legacy `link --target` is a full filesystem mount and exposes more context. No command performs network requests or publication.
