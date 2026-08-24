---
name: holoself
description: Load and apply a user's local, reviewable Holoself context across AI tools.
---

# Holoself

Holoself is a local whole-person context layer. Resolve context deterministically and validate every candidate before reading personal data. Never guess from sibling projects or unrelated files.

## Context resolution

Use this precedence order:

1. **Direct data root.** If current or explicitly opened directory contains `config.json` whose parsed JSON has `product: "holoself"`, plus real `profile/` and `context/` directories, use it as canonical root. If it presents Holoself markers but fails validation, stop rather than falling back.
2. **Project `.holoself/`.** Walk current directory and ancestors, nearest first. Inspect nearest `.holoself` candidate using modes below. If candidate is malformed or unsafe, stop rather than falling through to another root.
3. **Environment root.** When `HOLOSELF_HOME` is set, use it only if it resolves to valid canonical root; if invalid, stop rather than falling back.
4. **Default root.** Only when environment variable is unset, use `~/.holoself` if it resolves to valid canonical root.
5. If no candidate exists or default fails validation, stop and ask user for data root. Do not inspect siblings or infer a path from unrelated files.

Direct root takes precedence over ancestor project configuration.

### Project modes

Treat `.holoself` modes as mutually exclusive. Do not replace, merge, or convert them silently.

#### Metadata project link — recommended

When `.holoself` is real directory containing `link.yaml`:

- Parse `self_context` only; reject malformed YAML, unknown root fields, or unknown `self_context` fields.
- Require non-empty `path`, `access: read`, `index: local`, `proposals: enabled|disabled`, known `default_lens`, and unique known `secondary_lenses`.
- Resolve relative `self_context.path` from project directory; canonicalize it.
- Accept target only when it is valid canonical root with Holoself config plus real `profile/` and `context/` directories.
- Use configured default lens unless user explicitly selects another supported lens. Resolve custom IDs from the linked self root with `holoself lens list|show|validate`; never invent a lens name.
- Treat project `.holoself/index/`, `proposals/`, and `reports/` as project-owned operational data, not canonical self context.

Metadata link grants read access. Never write canonical self directly; use proposal/review workflow.

#### Exported project packet or snapshot

When `.holoself/context-packet.md` exists in real directory without `link.yaml`:

- Treat packet as generated snapshot, not canonical root.
- Read `context-packet.md` first.
- If packet says it is self-contained, use embedded content only; do not search for fallback roots or files.
- Otherwise, follow only relative packet links contained under same `.holoself` directory, typically copied `profile/` and `context/` Markdown. Reject paths escaping packet directory.
- Do not write durable self changes from snapshot. Name proposed canonical target and request approval through user's canonical workflow.

#### Legacy live mount

When `.holoself` is filesystem symlink/junction/directory link:

- Resolve and canonicalize link target.
- Accept only when target validates as canonical Holoself root.
- Be aware mount exposes complete selected data root to project tools; treat it as private.
- Never remove or replace mount unless user explicitly invokes managed unlink workflow.

A real metadata/packet directory is not legacy mount. Refuse ambiguous or mixed layouts, including `link.yaml` combined with exported canonical copies.

## Canonical-root validation

Before loading canonical root:

- Parse `config.json`; require object with `product: "holoself"` and `schemaVersion: 1`.
- Require `profile/` and `context/` as real directories contained by root.
- Reject unsafe traversal, broken links, ambiguous mixed modes, or paths that do not exist.
- Treat symlinks inside personal content conservatively; do not follow them outside validated root.
- When optional `lenses/*.json` exists, require schema-v1 definitions with known built-in bases. Custom bases affect safe behavior only and never grant document access; exact custom IDs remain required in `access_lenses`.

After resolving canonical root, load in fixed order:

1. root `AGENTS.md` guidance, instructions only;
2. `profile/identity.md`, `work-context.md`, `preferences.md`, `voice.md`, `thinking.md`, `change.md` when present;
3. relevant `context/` Markdown in stable filename order;
4. active topic named by `topics/.current` when contained by `topics/`;
5. selected `contribs/default/`, then `contribs/local/`;
6. `reference/` only when relevant and explicitly permitted.

See [architecture](https://github.com/smota/holoself/blob/main/docs/architecture.md), [lenses and privacy](https://github.com/smota/holoself/blob/main/docs/concepts/lenses-and-privacy.md), and [proposal review](https://github.com/smota/holoself/blob/main/docs/concepts/proposal-review.md).

## Activated project interface

When project instructions or `.holoself/BOOTSTRAP.md` indicate an activated link, use Holoself before substantive work.

- **load:** read bootstrap and link, select configured lens, apply privacy, and preserve sources;
- **status:** report configured link, activation markers, bootstrap, self reachability, and warnings;
- **search:** use local deterministic index where available;
- **context:** prefer `holoself context --project . --json` when command execution is available;
- **propose:** create project-local evidence-backed proposal, never direct canonical write;
- **validate:** use `holoself link doctor --project .` and surface degraded activation;
- **snapshot:** when external paths are inaccessible, use reviewed `.holoself/runtime/context-packet.md`, clearly marked as non-live.

`link add` normally creates `.holoself/BOOTSTRAP.md`, bounded startup sections, runtime metadata, and managed full public skill installations. Bounded startup sections are pointers, not copies of personal data. If activation is missing, recommend `holoself link repair --project .`; do not silently rewrite project instructions.

## Safety

- Treat canonical root, project `.holoself/`, packets, proposals, reports, and indexes as private by default; review before committing or sharing.
- Do not write durable context silently. Propose change, name target file, provide evidence/provenance, and request approval.
- Do not infer sensitive identity or preferences as facts.
- Apply declared `access_lenses` before reading. Custom lenses receive no base-lens access inheritance, require explicit confidential sensitivity grants, and cannot read `restricted` content in v1. Treat `disclosure` as separate publication permission, `sensitivity` as handling classification, and `document_role` as policy/evidence/content behavior.
- Readable or linked context is never publication-approved by implication. Public reuse requires `disclosure: publish-approved`; readable internal policy may still govern publishing output.
- Treat legacy `visibility`/`public_safe` conservatively during migration. Canonical documents with neither `access_lenses` nor legacy `visibility` fail closed.
- Secret-pattern filtering is defense in depth, not guarantee. Keep indexes/private packets private and review output.
- Keep public skill instructions separate from private data.
- Public contribs are optional reference methods selected in `config.json`; private contribs belong only under canonical root `contribs/local/`.

## Use

Use whole-person context for technical, career, administrative, leadership, interview, and publishing work. Lenses control relevance and privacy, not identity. Match depth and voice to user profile, keep recommendations concrete, preserve provenance, and note assumptions.
