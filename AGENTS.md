# AGENTS.md — holoself

Holoself connects local approved context to independent AI projects through task-specific lenses and review.

## Working model

This is an open-source, local-first whole-person context protocol built on Markdown, project links, lenses, provenance, deterministic local indexing, and explicit proposal review. Read [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution flow and testing requirements.

## How work enters this repo

- **Large features and architectural changes**: open a GitHub issue for scope agreement before implementation (see [CONTRIBUTING.md](CONTRIBUTING.md)).
- **Backlog items**: recorded as dated `docs/backlog/YYYY-MM-DD-<slug>.md` files with Goal, Decisions, and Cross-repo order sections (see existing items for format).
- **Decisions**: documented in `docs/decisions/<slug>.md`.
- **Specifications**: detailed designs in `docs/specifications/<slug>.md`.
- **Branch naming**: use `feat/<feature>`, `fix/<bug>`, or `docs/<documentation>` from `main`.
- **Pull requests**: one focused change per PR; PRs are squash-merged to `main` with the PR title as the commit message.
- **Review**: complete the pull-request template; address feedback and keep the branch current until the required check passes.
