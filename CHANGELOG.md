# Changelog

All notable Holoself releases are documented here.

## Unreleased

- Directory-level privacy policy defaults (`_policy.yaml`): canonical directories (`profile/`, `context/`, `history/`, `topics/`, `reference/`, their subdirectories, and the self root) can define `_policy.yaml` defaults for `access_lenses`, `exclude_lenses`, `disclosure`, `sensitivity`, `document_role`, `read_scope`, `task_include`, `task_exclude`, `confidence`, `knowledge_status` (`current`/`historical`), and `temporal_scope` (`schemas/policy-defaults.schema.json`). Nested `_policy.yaml` files replace parent defaults field by field, and document frontmatter overrides inherited fields explicitly. Unreadable, malformed, unknown-key, restricted-widening, or symlinked `_policy.yaml` files fail closed so documents beneath them receive no defaults and report relative-path validation errors. Catalog partitions track `_policy.yaml` hashes and stat tuples for automatic invalidation while never indexing or delivering `_policy.yaml` as content. Per-field provenance (`frontmatter` vs `policy:<relative-path>`) is recorded in `catalog.json` (`policy_sources`) and surfaced in `holoself validate`, the Workbench document view, and owner-direct `context_receipt.policy_sources` (omitted from linked callers). Workbench document saves continue writing only document frontmatter, and `holoself migrate policy` respects directory defaults: it compares before/after on the effective metadata the catalog would serve (frontmatter plus inherited `_policy.yaml` defaults, with the legacy-visibility skip), so an edit that turns inheritance on is judged on its real outcome, and every migrated document is written with `access_lenses`, `disclosure`, `sensitivity`, `document_role` and `read_scope` explicitly so directory defaults cannot later widen it (#73).
- Proposal operations to correct knowledge through review: schema-v2 proposals accept `replace_claim`, `supersede_claim` and `retire_claim` next to `append_claim`. Each targets an existing claim by a stable `claim_id`, requires evidence, and goes through the same preview hash, transactional apply, rollback and receipt flow. Supersede keeps the old claim as linked history (`status=superseded superseded_by=…`); retire marks it `status=historical` with `retired_at` and a reason. Approved claim markers now carry `id=<uuid>`. Older claims get a deterministic id from target path and wording, which is written only when a proposal targets them. Delivered context shows ids for visible claim blocks only. Superseded and retired claims are excluded from context and search unless `--temporal` selects their status or `all`. `holoself propose --op replace|supersede|retire --claim-id <id>` with `--claim` or `--reason`, `proposals show` summaries and the Workbench review view show the operations. `holoself_proposal_create` gains `operation`, `claim_id` and `reason`. `claim` is now required only for append, replace and supersede, and MCP may target only claims its link's lenses can read. There is still no MCP approval path. Approval now also fails with `STALE_PREVIEW` when a target changed after the preview. Preview entries and receipts gain `operation` and `claim_id`, and preview entries also gain `before_block` and `after_block`. Catalog sections and claims may carry `claim_status`. Claim markers parse regardless of spacing (invisible format characters included), case and attribute order. Malformed, nested or unclosed markers fail closed: the block is treated as private and historical, text after an unclosed opener and text before a stray closer are not delivered, and validation reports the marker. `change_id` must match `^[a-z0-9][a-z0-9_-]{0,63}$` and may not contain claim markers. Through MCP, duplicate and ambiguity checks see only claims the link can read, and a hidden target always reports `CLAIM_NOT_FOUND`. Preview entries add `evidence` and `visibility_change`, and their hashes chain across changes to one file. The approval time uses a placeholder unique to each proposal. Approval holds the self registry lock from the stale check through validation. `normalize` moved from `src/proposals/analysis.mjs` to `src/markdown/claim-blocks.mjs` (#70).
- Add explicit context-need overrides (`holoself context --need required|helpful|not-needed` on the CLI and optional `need` on MCP `holoself_context` and `holoself_context_manifest`), record `need` and `need_reason` (`explicit`, `matched:personal:<pattern-id>`, `matched:mechanical:<pattern-id>`, `default`) in `selection`, `context_receipt`, and packet text headers, soften default `not-needed` selection so regex-classified mechanical tasks still keep `document_role: policy` documents, lens `session_start_sources`, and task-overlapping self records (while explicit `--need not-needed` strictly drops all self records), and weigh bilingual (EN/PT) domain and personal nouns against mechanical keywords (`tie → helpful`) so tasks like deterministic simulation testing or onboarding plan fixes no longer drop domain context (#68).
- Fix `holoself migrate policy` widening access on documents restricted by the runtime and missing publication or custom-lens widening in `verifyNonAmplification`: parse migration frontmatter with the same privacy validation as the catalog (`validatePrivacy: true`), preserve present-but-empty or invalid privacy fields such as `access_lenses: []` as restricted to `private` instead of treating them as missing, and evaluate before/after outcomes with the runtime's own `allowedDocument` and `publicationAllowed` across all registered lenses (including custom lenses), callers (`owner:direct`, `client:linked`), and adapters (`generic`, `public`, `obsidian-public`, `restricted-host`), eliminating false coverage-loss reports on exact mappings (#105).
- Add a synthetic retrieval golden-set evaluation harness (`scripts/eval-retrieval.mjs`, `npm run eval:retrieval`) with 53 synthetic documents (`tests/fixtures/retrieval-eval/corpus.mjs`), 48 bilingual English/Portuguese evaluation cases (`tests/fixtures/retrieval-eval/cases.json`), a recorded baseline (`tests/fixtures/retrieval-eval/baseline.json`), a CI regression and zero-leak gate (`tests/retrieval-eval.test.mjs`), and a contributor guide (`docs/guides/retrieval-evaluation.md`) covering personal vs mechanical tasks, need-classifier false negatives (#68), synonym/paraphrase token-overlap gaps (#69), knowledge lifecycle states, lens sensitivity boundaries, budget pressure, and session-start selection (#67).
- Local served-context ledger ("what each AI saw"): every served context packet now appends one metadata-only NDJSON entry (`schema_version: 2`) to `<project>/.holoself/ledger.ndjson` (linked callers) or `<self>/.holoself/ledger.ndjson` (owner-direct callers) across CLI `context`, MCP (`holoself_context`, `holoself_context_manifest`, `holoself_context_get`, written from the main thread after worker completion), SessionStart hook mode (`--hook holoself-session-start`), and Workbench conversations (recorded only after the harness call succeeds; owner previews in Workbench do not record entries). Entries record `schema_version`, `served_at`, `surface`, `mode` (`packet`, `manifest`, `get`), `host` (from `CLAUDE_CODE` / `CODEX` / `AGY` markers or MCP `initialize` `clientInfo.name`), `lens`, `budget`, `need`, `task_hmac` (HMAC-SHA256 keyed by `<self>/.holoself/runtime/ledger.key`, linkable only on this machine; plain `task` only when `ledger.record_task_text: true`), `context_hash`, `packet_id`, `source_ids` (`hs-...` handles only), `counts` (`documents_delivered` for `packet`/`get` or `items_listed` for `manifest`, plus `restricted` and `envelope_dropped`), and `total_bytes`—never document bodies, snippets, headings, filesystem paths, or restricted-source IDs. Holoself maintains `<dir>/.holoself/.gitignore` in both linked projects and the self root so `ledger*.ndjson`, `ledger*.lock`, `catalog/`, `index/`, `runtime/`, `runtime*`, `conversations/`, `reports/`, and `links.json*` stay out of git while `link.yaml`, `BOOTSTRAP.md`, `README.md`, and `proposals/` remain trackable. The writer uses `O_NOFOLLOW`, `nlink === 1`, mode `0600`, path-guard checks, and an `O_EXCL` rotation lock (`ledger.ndjson.rotate.lock`), rotating at 5 MiB (`ledger.1.ndjson`..`ledger.3.ndjson`) and failing open for packets with a scrubbed CLI stderr warning or MCP/hook audit entry. Added `holoself ledger [--project <dir>] [--since <date>] [--lens <id>] [--surface <s>] [--limit <n>] [--json]`, `.holoself/link.yaml` `ledger.enabled: false` configuration, and Workbench `GET /api/ledger` + "Served context" view (#65).
- Narrowing on publication adapters: on `public`, `obsidian-public` and `restricted-host`, delivered `content` (and catalog section snippets, and search when called with a publication adapter) now applies claim-marker and `field_visibility` rules with the real adapter, so only `public-safe` claims and fields are delivered. Claims and fields marked `private`, `professional`, `linked-projects` or `public-voice` used to stay in the `content` of a publish-approved document while already being dropped from `sections` and `claims`; they are now removed, and `total_bytes` and `content_chars` measure the narrowed content. Hidden fields are reported as `field <name> not approved for publication on <adapter> adapter` (claims only to the direct owner, as before). No files change and standard adapters such as `generic` and `claude` are unaffected (#106).
- Holoself now requires Node.js 22 or newer (Node.js 20 reached end-of-life in April 2026); CI runs Linux, Windows and macOS on Node 22.
- MCP by default where verified: `link setup`, `link add`, `link activate` and `link repair` configure the project-local MCP server for every activated host whose MCP support is `verified` (Claude Code `.mcp.json`, Codex `.codex/config.toml`, AGY `.agents/mcp_config.json`); other hosts keep BOOTSTRAP + CLI. `--mcp` / `--no-mcp` override the default. `runtime.json` records `mcpPolicy`, `mcpApproveReadTools` and `mcpInstallations`; `link repair` restores them and `link deactivate` removes only the recorded Holoself entries. A divergent existing `holoself` entry is skipped by the default and refused with `--mcp`. New `holoself mcp configure --all-detected` configures every client detected from PATH or project configuration in one all-or-nothing transaction; the dry-run plan includes `detection` and `plan_sha256`, and apply refuses if the plan changed. `--force-replace` (with `--yes` or terminal confirmation) replaces a divergent `holoself` entry. Opt-in `--approve-read-tools` pre-approves only the six read-only tools (never `holoself_proposal_create`): Claude Code `permissions.allow` in `.claude/settings.local.json`, Codex per-tool `approval_mode = "approve"` in the managed block, AGY documented only. `mcp status` adds `client_state` (`not-detected`, `detected`, `configured`, `verified`, `failing`), `detected`, `entry` and `link_state`, and the Workbench Setup view shows the same per-client state through the token-protected `GET /api/mcp/clients`. Activation plans gain `mcp_policy`, `mcp_servers`, `mcp_fallback` and `mcp_commit_warning`, so link setup/activate/deactivate output changes. Upgrade note: `link repair` (and `link activate`) on a link created before this release now adds MCP configuration for verified hosts by default; pass `--no-mcp` to opt out (the choice is recorded). When Holoself edits an existing `.mcp.json`, `.agents/mcp_config.json` or `.claude/settings.local.json`, the file is re-serialized as 2-space JSON; its content and key order are preserved. `.codex/` and `.agents/` directories that Holoself created are removed again when rollback or deactivation leaves them empty. `--force-replace` on Codex refuses multi-line values in the unmanaged table and checks the result is well-formed before writing; the project path is fully escaped in TOML; JSON parse errors report only the line, never file content (#64).
- Session-start hooks: `link activate`, `link setup`, `link add` and `link repair` install a Claude Code `SessionStart` hook in `.claude/settings.local.json` that runs `holoself context --session-start --budget small --format packet --hook holoself-session-start`, so each new, resumed, cleared or compacted session starts with the bound session-start packet. The command has no shell syntax: hook mode reads the project from `CLAUDE_PROJECT_DIR` and prints nothing when it is missing. Only the Holoself-owned entry is added or removed; other keys and hooks are preserved, and the file is reformatted as 2-space JSON when Holoself changes it. Existing settings keep their file mode; files Holoself creates are 0600. `--hooks` / `--no-hooks` choose explicitly (recorded as `hookPolicy` in `runtime.json`). `link repair` on an existing link now installs the hook by default for verified hosts; pass `--no-hooks` to opt out. `link deactivate`, including `--adapters claude`, removes the entry; invalid or unsafe settings are reported as `unremovable` without stopping deactivation, and `link remove` deactivates first but always revokes the link and binding, warning when local cleanup was refused. Symlinked or invalid settings are refused at activation and writes roll back. Hook mode always exits 0, writes nothing to stderr, prints nothing on any refusal, and caps the packet at 9,000 bytes (Claude Code moves hook output above 10,000 characters to a file). `HOLOSELF_HOOK_AUDIT_LOG` records outcomes without content through the hardened audit writer now shared with `HOLOSELF_MCP_AUDIT_LOG`. `link status` and `link doctor` report hook state. Verified live on Claude Code 2.1.318 on Linux (`session_start_hook` in `docs/reference/platform-verification.json`); Windows is unverified, so status reports it as `unverified` there and activation installs it only with `--hooks`. Codex and AGY have host session-start hooks but are not installed yet. `holoself mcp configure` now keeps the file mode of existing configuration files (#63).
- `holoself mcp` no longer blocks while a slow tool call runs. Tool calls run on a pool of worker threads (two by default, `HOLOSELF_MCP_CONCURRENCY`), and `ping`, `initialize`, `tools/list`, and notifications are answered immediately. Responses are matched to requests by JSON-RPC id. `notifications/cancelled` stops a queued or running call without sending a response. Each call has a timeout (60 seconds by default, `HOLOSELF_MCP_TOOL_TIMEOUT_MS`), after which the server returns JSON-RPC error `-32001` (`TOOL_TIMEOUT`). `holoself_proposal_create` runs alone and is never stopped part-way: a cancelled write finishes and its response is dropped, and writes are exempt from the 60-second timeout. They have a 10-minute write timeout instead (`HOLOSELF_MCP_WRITE_TIMEOUT_MS`), and when the client closes STDIN the server waits no longer than that before stopping its workers. At most 256 calls can be pending (`HOLOSELF_MCP_MAX_PENDING`). Calls beyond that return `-32000` (`SERVER_BUSY`). A request that reuses the id of an unanswered call returns `-32600`. Worker heaps are limited to 512 MB (`HOLOSELF_MCP_WORKER_HEAP_MB`). Responses can arrive out of order, so clients must match them by id. Tool results, error scrubbing, and size limits are unchanged (#62).
- The MCP audit log (`HOLOSELF_MCP_AUDIT_LOG`) is no longer followed through a symlink, refuses a hard-linked file, is set to mode 0600 even when the file already exists, and stops at 10 MiB with one final `audit_log_capped` line.
- `npm run smoke:mcp` now removes its temporary directory when a run fails (unless `--keep` is set). It shell-quotes paths in its wrapper, escapes the project path in the Codex TOML trust key, and replaces absolute paths in host-reported reasons before writing the verification matrix.

- Existing Codex MCP configurations generated before this release omit `holoself_context` from `enabled_tools`; `mcp status` reports them as `missing-or-drifted` until you re-run `holoself mcp configure --platform codex`.
- Verify native MCP use in Claude Code 2.1.318, Codex 0.166.0 and AGY 1.5.0 with all seven tools, recorded in `docs/reference/platform-verification.json`. `holoself capabilities --json` (`mcp.platforms`) and `holoself mcp status` now report `verified`, `tested_version` and `last_verified` only from that record; any failed, blocked or missing tool keeps a platform `configured`. The repeatable synthetic-data smoke test is `npm run smoke:mcp` (not part of `npm run verify`). Each host's tool-scoped approval setting is documented. The server accepts an opt-in `HOLOSELF_MCP_AUDIT_LOG` that records only the event, tool name and outcome. Generated Codex configuration now enables `holoself_context`, and context tool text summaries list source handles so text-only hosts can call `holoself_context_get` (#61).

- Compare canonical paths (`canonicalPath` / `samePath`) when checking whether the caller working directory and `--root` or project refer to the same self root or project, avoiding spurious `"No project link found; resolved explicit/default self root."` warnings when `--root` or `TMPDIR` traverses a symlinked ancestor (#85).

- Strip private local filesystem paths (`source_project_path`, `_path`, `absolute_path`) from linked-client CLI `holoself context` output before measuring envelope byte budgets, matching MCP context path stripping and making linked context packet sizes path-independent when pending proposals exist (#84).

- Reconcile documentation drift with current runtime behavior: update `docs/contributing/status-and-roadmap.md` to version `0.10.1`, update MCP tool counts to seven (including `holoself_proposal_preview`), align `docs/guides/local-mcp.md` with npm `holoself-ai` availability, mark evidence ADRs E01–E06 superseded by `docs/specifications/external-sources-and-coaching-plan.md (2026-09-30)`, update remaining `career`/`publishing` references to `professional`/`public-voice`, align `public-voice` sensitivity/disclosure semantics across `docs/workbench/lenses.md` and `docs/concepts/lenses-and-privacy.md`, align `AGENTS.md` and `CONTRIBUTING.md` branch prefixes with `agent-workflow.config.json`, and generate CLI/MCP reference tables via `scripts/generate-reference.mjs` (`npm run docs:reference`) with drift checks in `tests/docs.test.mjs` (#54).

- Remove dead federation plumbing (`getEligibleFederatedSpaces`, federated catalog/index/search/context branches, and the always-empty `federated` context packet field), delete the no-op on-disk context decision cache (`src/catalog.mjs`, `HOLOSELF_CACHE_MAX_*`), remove `persistent-cache` from `capabilities --json` `contextFeatures`, and simplify `readIndex(project)`. Context packets and `context_receipt` now always report `cache.persistent: false` (with `cache.hit: true` occurring only within a long-lived process via the in-memory selection cache). Keep `--federated` and `--no-cache` accepted as deprecated no-ops with stderr warnings for one release, keep `cache_limit_entries` and `cache_limit_bytes` accepted and ignored in `.holoself/link.yaml`, mark `schemas/context-decision-cache.schema.json` deprecated, and safely clean up legacy decision-cache files on `holoself index rebuild` (#60).

- Unify frontmatter parsing, tokenization, section splitting and atomic file writes across the CLI, catalog, migration and Workbench modules: Workbench document saves now preserve multi-line YAML `access_lenses` lists without duplicating list items into unknown metadata, unescape single-quoted `''` values, and treat `#` after whitespace in a frontmatter value as a comment, matching catalog reads (#59).

- Document the product, tooling, AgentFlow SDLC framework, and owner-local repository layout in `docs/repository-map.md` and `docs/decisions/agentflow-placement.md`, index all architecture decisions in `docs/README.md`, and enforce the product/framework boundary in `tests/repository-boundary.test.mjs` (#56).

- Move owner-specific working backlog files to the git-ignored `.local/backlog/`, add a synthetic backlog format reference in `docs/backlog/README.md`, and verify that tracked documentation contains no user-home or machine-specific paths (#55).

- Holoself now works when the self root or a project sits below a symlinked folder (for example macOS `/var` or a symlinked home); symlinks inside the root are still refused. On case-insensitive filesystems such as macOS, instruction files that differ only by case (`CODEX.md`/`codex.md`) are detected once. Lens bindings fail closed when a bound project path is swapped for a symlink or several stored paths resolve to the same folder. CI now verifies Linux, Windows and macOS on Node 20 and the current LTS, and releases require that matrix.

- Workbench error handling now distinguishes typed client validation errors (400/413) and stale-state conflicts (409) from unexpected internal or CLI subprocess failures (500 `{code:"INTERNAL",message:"internal error"}`), and scrubs absolute local paths from all HTTP error responses (#53).

- Fix `superseded_by` frontmatter validation throwing a `ReferenceError` and silently dropping the document from the catalog; surface per-file catalog build errors as `[warn]` lines in `holoself validate` and `holoself doctor` and under the additive `warnings` key in `holoself link doctor` JSON with root-relative paths (#52).

- Workbench hardening: the local server answers only `127.0.0.1:<port>` and `localhost:<port>` hosts, requires the session token on every `/api` request (the page now receives it in the served HTML, not from `/api/session`), accepts changes only from a loopback origin, and serves only regular files from its web directory.

- An explicit canonical root containing the current directory now resolves owner-direct even when nested inside a linked project. Explicit project selection and callers outside that root retain linked authority.

- Workbench activate, deactivate, relink and setup now preview every affected file and require the unchanged plan hash to apply. Content or configuration drift returns `PLAN_CHANGED` (409). Relink preserves project metadata and activation choices; legacy setup preflights without unlinking and restores the junction on recoverable failure (#39).

- CLI options are now checked before execution for all command families: core root operations, web, mcp, coaching, knowledge, instructions, skill, lens, link, context, analyze, propose, proposals, index and search. Known unused options fail with `OPTION_NOT_SUPPORTED`; root, confirmation and dry-run options are no longer accepted globally. JSON-native commands retain explicit `--json` compatibility.
- Planning commands accept `--dry-run` only without apply, revert or output writes. Remove ignored `--yes` from link approve/backfill/prune invocations and ignored `--changed` from index rebuild.

- Fix the data-root `AGENTS.md` block and the public skill, which recommended `holoself context --root . --project .` (it fails with `LINK_REQUIRED`). They now use `holoself context --root . --task …` from inside the root. `holoself init` updates existing root blocks, and `--project` pointing at a data root now explains the fix (#32).
- `link repair` restores the adapters recorded in `.holoself/runtime.json` instead of re-detecting hosts, so it no longer re-creates adapters you removed or overwrites hand-written instruction files. The plan reports `source: recorded|detected|explicit`. Workbench repair now shows the plan first and applies it only if it is unchanged (`PLAN_CHANGED` otherwise) (#34).
- `link deactivate --adapters <list>` removes only the listed adapters and keeps `runtime.json` for the rest. `link deactivate` now prints its plan before confirming, and rejects flags it doesn't use (such as `--platform` or `--adapter`) instead of silently ignoring them. `--adapters` is rejected on every other command (#33).
- Context packets are bounded as a whole: every response, with or without `--manifest`, stays within twice its content budget (16/48/128 KiB), and reports `selection.total_bytes`, `estimated_tokens_total`, `envelope_cap_bytes` and `envelope_dropped`. Document bodies appear once: when content is delivered, `sources[]` is a body-free index (`packet_metadata.schema_version` 3), and MCP context tools send the packet once with a short text summary. `context --session-start` (MCP `session_start`) loads only the lens `session_start_sources`, by default identity, preferences and work context; lens files can set this new optional field. One selection implementation now serves cold and cached requests (#31).

## [0.10.1] — 2026-10-04

- Recognize exact current public skills deployed through terminal directory links as external, read-only installations, while preserving strict managed writes and permission checks.
- Correct Codex and Pi global skill paths and avoid requiring a separate generic global skill when providers are selected.
- Add explicit reviewed root instruction replacement plans and strengthen cleanup path checks, receipt replay and recoverable rollback.

Existing linked projects can preview and apply link repair to reconcile runtime activation. See [release notes](docs/releases/0.10.1.md).

## [0.10.0] — 2026-10-03

- Keep context, search and indexing restricted to self records; domains own their indexing.
- Store uniform lens definitions and project bindings in the self. Rename career to professional and publishing to public-voice; preserve owner-exclusive private access and proposal approval.
- Retire publishing-specific filters and discover Workbench spaces from bindings.
- Add digest-bound maintenance previews, receipts, replay checks and rollback for recoverable failures, preserving proposal history.
- Correct explicit link approval and attestation backfill paths.

Existing installations require a backed-up lens migration and project link repair. Consumers requesting legacy lens IDs must be updated. See [release notes](docs/releases/0.10.0.md).

## [0.9.0] — 2026-09-30

Holoself 0.9.0 helps you bring relevant context into AI conversations and keep a local coaching history from a question through an action and its review.

### More focused context across projects

- Request task-specific context in one CLI or MCP call, with Portuguese and English task gating.
- Bound responses with small, standard, and deep byte budgets, explicit truncation, and selective source expansion.
- Reuse an integrity-checked catalog and discover linked spaces through a central registry.
- Apply the intersection of consumer, producer, and document lens permissions when sharing context across spaces.
- Plan, apply, and reverse legacy access-policy migrations; migrate legacy mounts to metadata links through the Workbench.

### Coaching you can resume

- Start a question, record reflections, propose and choose an action, report an outcome, and resume the session history.
- Keep user reports, hypotheses, intentions, and action choices distinct.
- Attach text supplied by another reader with provenance and imported, partial, or failed status. Partial and failed material records include their limitations.
- Store coaching history locally, outside the canonical profile and default context/export readers. Durable profile changes still use proposal and approval workflows.

### Availability and limits

Node.js 20 or later is required. Coaching is available through the local CLI; coaching integration with MCP and the Workbench is deferred. It does not call a model, read PDF/DOCX files, or fetch source links. Document extraction is delegated to an external reader. Earlier experimental document-extraction runtime is not included.

For existing context policies, review the [adoption and rollback runbook](docs/guides/adoption-and-rollback-runbook.md) before migration. See the [coaching guide](docs/guides/coaching.md) for commands, revision handling, and lock recovery.

Changes since 0.8.0: [context and lenses (#7)](https://github.com/smota/holoself/pull/7) and [local coaching (#23)](https://github.com/smota/holoself/pull/23).

## [0.8.0] — 2026-08-31

Holoself can now meet AI tools inside an already linked project. A local MCP integration gives supported clients typed, on-demand access to bounded self-context without introducing a daemon, hosted account, or second source of truth.

### Context where you work, only when it is useful

- Codex, AGY, and Claude Code can be configured from one previewed `holoself mcp configure` workflow.
- Each client starts a project-bound STDIO subprocess; Holoself does not open a port or keep a background service running.
- Status, manifest, context, and search tools return structured, size-bounded results and reuse the same lens, privacy, lifecycle, and provenance rules as the CLI.
- Manifest-first retrieval lets an AI inspect what is available before requesting selected sources, reducing unnecessary context loading.

### Explicit control remains the default

- `.holoself/link.yaml` remains the project authorization boundary and the only pointer to the canonical self root.
- MCP tools accept no filesystem paths, cannot broaden the linked lens, and redact private roots from outputs and errors.
- Read tools do not create cache or index files. Search can rebuild a stale index in memory without changing canonical data.
- An AI may create a project-local pending proposal and preview its effect, but it cannot approve it or write canonical self-context.
- BOOTSTRAP instructions, the shared skill, CLI, reviewed snapshots, and Workbench remain available as deterministic fallbacks.

### Safer setup and recovery

- Configuration is project-local, collision-aware, idempotent, and previewable before it writes Codex, AGY, or Claude Code files.
- Existing divergent entries, malformed managed markers, unsafe roots, and symlink or junction parents are refused instead of overwritten.
- A failed multi-client configuration restores existing files byte for byte and removes files created by the failed transaction.
- `holoself mcp status` distinguishes generated configuration from proven native client behavior.

### Platform status at release

Codex and Claude Code have verified native server discovery and status invocation. AGY has verified native discovery in a registered synthetic project; non-interactive invocation remains subject to its normal MCP approval policy. MCP is therefore activated but not yet promoted over the explicit link, shared skill, and CLI as Holoself's cross-platform default.

## [0.7.0] — 2026-08-31

Holoself is now easier to use day to day: you can manage your context through a local Workbench, install its AI skill once instead of copying it into every project, and give AI tools smaller, more relevant context with a clear record of what was shared.

### A local Workbench for managing your context

The optional Holoself Workbench provides a visual interface for the main workflows:

- See whether your self-context and linked projects are healthy.
- Browse independent project spaces and understand their purpose and boundaries.
- Safely edit knowledge and privacy annotations without manipulating raw metadata.
- Review, approve, defer, reject, or supersede proposed knowledge.
- Configure lenses and personal lens instructions.
- Start context-aware conversations through detected local AI tools.
- Follow specific recovery actions when a project is degraded.

The Workbench runs only on your computer, binds to `127.0.0.1`, requires no hosted account, and does not replace the CLI or Markdown source files.

### More relevant context with less unnecessary loading

Holoself now decides whether personal context is required, helpful, or unnecessary for a task.

When context is useful, it:

- Selects sources based on the task, lens, privacy rules, and knowledge lifecycle.
- Uses bounded `small`, `standard`, or `deep` budgets.
- Loads current knowledge by default instead of mixing in outdated material.
- Can return a compact manifest first and expand only selected sources.
- Limits automatic framework injection to the most relevant methods.
- Reuses cached selections when the underlying sources have not changed.

Every selection includes a receipt describing what was selected, the source hashes, estimated size, applied lens and budget, and whether anything was truncated—without copying private document bodies into the receipt.

### Clear lifecycle for knowledge

Personal knowledge can now be marked as current, historical, or superseded. Historical information remains available when explicitly requested, but it no longer appears in normal current-context requests.

Reviewed cleanup is also available. Cleanup plans contain paths, reasons, operations, and hashes—not private document contents. Applying a plan requires the exact approved digest, rejects stale inputs, and produces an immutable receipt. Proposal archives remain protected.

### Install the Holoself skill once

Holoself can install its shared skill at user level instead of creating another copy inside every project.

Existing linked projects can be migrated to this global model through a previewed, transactional workflow. Holoself validates the global installation before removing managed project copies and rolls back if the migration fails.

User-created project overrides and unmanaged file collisions are preserved and reported for review rather than silently overwritten.

### Easier integration with AI tools

Holoself now exposes a small, stable machine-readable interface:

- `capabilities --json` describes the supported local interface.
- `--version --json` reports product and version information.
- `context --self-only` supplies personal context without redundantly including documents already managed by the requesting project or tool.

This makes integration more predictable while keeping Holoself independent of any single AI application.

### Safer context-aware conversations

Workbench connectors can detect supported local CLI, terminal, and desktop tools. Each conversation resolves bounded, lens-filtered context before launching the configured tool.

Executable paths and arguments remain structured, linked spaces are allowlisted, and there is no generic remote-command endpoint.

### Privacy and control remain foundational

- Canonical knowledge stays in local Markdown.
- The CLI performs no network requests.
- The Workbench is loopback-only and optional.
- Stale edits are rejected rather than overwriting newer changes.
- Writes are hash-guarded, validated, and rolled back on failure.
- Durable AI discoveries still require explicit proposal approval.
- Global installation, project migration, cleanup, and corrective actions remain previewed and confirmation-gated.
- Project artifacts remain owned by their projects; only approved reusable knowledge belongs in self-context.

## [0.6.0] — 2026-08-24

- Adds optional private `<data-root>/lenses/*.json` custom-lens registries with strict v1 definitions, deterministic hashes, hard-error semantic validation, exact document grants, explicit sensitivity access, and read-only `lens list|show|validate` commands.
- Advances context packets to schema v2 with normalized lens resolution and registry hash, and indexes to schema v4/privacy-policy v3 so registry changes invalidate freshness without migrating Markdown or links.
- Separates read access (`access_lenses`), public reuse (`disclosure`), handling classification (`sensitivity`), and policy/evidence/content behavior (`document_role`). Untagged canonical documents fail closed; legacy visibility metadata remains conservatively supported.
- Ensures publishing resolution includes governing policy while excluding unapproved evidence and employer-confidential non-policy content. Context packets and search results expose publication eligibility explicitly.
- Replaces blanket native-adapter claims with capability evidence fields and clarifies startup adapters, packet formatters, metadata links, snapshots, and legacy live mounts.
- Adds canonical metadata and adapter capability schemas plus end-to-end privacy/capability tests.
- Adds task selectors and explicit compensation, third-party, recruiter, employer, and application sensitivity categories with fail-closed lens defaults and post-resolution leakage checks.
- Upgrades deterministic index to schema v4/privacy-policy v3 with input/config/registry freshness hashes, automatic stale rebuild for search, and persisted include/exclude build assertions.
- Adds restricted-host packet generation with bounded expiry, packet ids, source hashes, validation metadata, and honest snapshot-only adapter documentation.
- Hardens Windows live activation by normalizing CRLF public skills before managed-section parsing.
- Preserves legacy folded/literal proposal text, `preference_update` records, and terminal audit archives while retaining strict containment for pending proposals.
- Adds activated read-only project links: `link add` detects agent platforms, generates a neutral bootstrap/runtime manifest, injects bounded startup pointers after confirmation, and supports activate/deactivate/repair/doctor lifecycle commands.
- Adds lens/task/privacy-aware context resolution with provenance and Pi, Claude Code, Codex, generic, and Obsidian packet adapters.
- Adds non-mutating overlap/conflict/stale reports and confirmed proposal approval/rejection/defer workflow.
- Adds local deterministic indexing, changed/rebuild/status commands, and provenance-preserving federated search. Markdown remains source of truth; SQLite/FTS remains optional acceleration, not dependency.
- Adds visibility, link, proposal, provenance, duplicate-claim, broken-reference, and generated-view validation plus public JSON schemas.
- Security hardening validates proposal UUIDs/containment/schema/provenance, uses realpath containment for activation writes, preflights and transactionally rolls back adapter changes, protects unmanaged skill shims, detects managed-block drift, cleans markers despite missing runtime metadata, fails closed on malformed control/canonical YAML, conservatively salvages project privacy fields, excludes agent/config/generated trees, preserves metadata collisions, blocks legacy export overwrite, and applies privacy policy to index/search.
- Adds Antigravity activation through `ANTIGRAVITY.md` detection.

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

[0.8.0]: https://github.com/smota/holoself/releases/tag/v0.8.0
[0.7.0]: https://github.com/smota/holoself/releases/tag/v0.7.0
[0.6.0]: https://github.com/smota/holoself/releases/tag/v0.6.0
[0.5.0]: https://github.com/smota/holoself/releases/tag/v0.5.0
