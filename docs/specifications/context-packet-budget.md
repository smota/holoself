# Context packet budget

Status: accepted for implementation (issue #31). Ships with the #31 pull request. The prerequisite #32 lands first.

## Problem

`holoself context --json` (and the MCP `context` tool) can return a packet many times larger than its budget:

- **Budgets limit content, not the packet.** `CONTEXT_BUDGETS` (`src/context-selection.mjs`) limits only excerpted `content` characters. `ENVELOPE_BYTE_CAPS` (16 KiB / 48 KiB / 128 KiB, which is 2× the content budget) is enforced only when `--manifest` is set: the trimming loop at the end of `contextData` in `src/ecosystem.mjs` runs under `if(o.manifest&&payloadBytes>envelopeCap)`. Full-content packets are never measured.
- **Duplicated bodies.** Each selected record appears in `self.documents` / `project.documents` / `federated[].documents` / `methods.documents` with its `content`. The same record also appears again in `sources[]`, which is built as `records.map(({content,metadata,absolute_path,...source})=>source)`. That entry still carries `search_text` (roughly the body), `sections`, `claims`, and `links`. A full packet therefore carries every body about twice, and JSON escaping makes it larger still.
- **Session start loads everything.** With no task, `relevanceScore` returns 4 for policy documents and 1 for everything else, so every eligible document competes for the budget. A lens cannot say "at session start, load these few sources".
- **Selection logic exists in three copies.** The selection loop (not-needed self skip, project task relevance, contrib limit of 2, the 160-character remaining floor, deliver, excerpt) is implemented three times:
  - `selectContextRecords` in `src/context-selection.mjs`
  - the delivered branch of `cachedSelection` in the same file
  - the persistent decision-cache hit path in `contextData` (`src/ecosystem.mjs`, around lines 1185–1260)

  The copies have already drifted. For example, the in-memory cache-hit path does not re-apply the project-relevance or contrib rules, and its omission reasons differ.
- **Packet size is not reported.** `selection.estimated_tokens` counts content only. `estimated_tokens_total_heuristic` measures `JSON.stringify(selected)` (the records, not the emitted packet) and is overwritten only on the manifest path.

## Design

### 1. Single selection implementation

Add one exported function to `src/context-selection.mjs`:

```js
export function applySelectionPolicy(candidates, options) // → { records, omitted, chars, truncated }
```

It owns, in this order: the not-needed self skip, the project task-relevance skip, the contrib limit, the session-start filter (§4), the budget floor, `deliver`, and `excerpt`. Manifest mode gets a sibling, `applyManifestPage(candidates, startOffset, options)`.

Callers:
- `selectContextRecords` calls it after ranking and cursor resolution.
- The `cachedSelection` hit path calls it with the cached *candidate* IDs re-hydrated from `records`. It replaces the inline loop.
- The decision-cache hit path in `contextData` calls it with `selectedCandidates`/`eligibleCandidates`. It replaces the inline loop and the separate omission-reason reconstruction.

Also extract `selectionSummary(records, omitted, temporalExcluded, options)` and `selectionReceipt(records, options)`, so that all three paths build `selection` and `receipt` identically.

Acceptance: `rg "contrib selection limit reached" src` finds exactly one occurrence.

**Cursor verification on every path.** The persistent decision-cache hit path in `contextData` parses `o.cursor` and trusts its `offset` without the HMAC, identity, lens, budget, temporal, and state-hash checks that `selectContextRecords` applies. Move cursor decoding and verification into one exported `verifyCursor(cursor, expected)` in `src/context-selection.mjs`. All three paths call it before using an offset. A cursor that fails verification is rejected with the same error on every path. Test: a forged or tampered cursor is rejected on a cold call, an in-memory cache hit, and a persistent cache hit.

### 2. Compact JSON shape: no duplicate bodies

Document bodies appear **exactly once**: in the owning `documents` array (`self`, `project`, `federated[]`, or `methods`). `sources[]` becomes a provenance index with these fields:

| kept in `sources[]` | removed from `sources[]` |
|---|---|
| `source_id`, `kind`, `path`, `space_id`, `source_hash`, `freshness`, `knowledge_status`, `temporal_scope`, `document_role`, `task_relevance`, `truncated`, `manifest_only`, `estimated_tokens`, `tags`, `contrib` | `content`, `search_text`, `sections` (replaced by `headings: string[]`), `claims`, `links`, `metadata`, `absolute_path` |

Documents keep `path`, `content`, `metadata`, `source_id`, `truncated`, and `manifest_only`. `packet_metadata.source_hashes` stays: it is small and used by the restricted-host packet.

One projection function, `sourceIndexEntry(record)`, builds `sources[]` in both the initial build and the trimming loop. This replaces the two inline destructurings.

### 3. Whole-packet cap ≤ 2× content budget, on every path

`ENVELOPE_BYTE_CAPS` keeps its values, which are 2× `CONTEXT_BUDGETS`. They become a hard cap on the **emitted** payload for every request, not only `--manifest`:

- The CLI measures `JSON.stringify(result, null, 2) + '\n'`.
- MCP measures the full tool envelope (`content[0].text` plus `structuredContent`). This is the existing `measurePayload`.
- After selection, if `payloadBytes > envelopeCap`, the trimming loop drops the lowest-ranked record. It records `{source, reason: 'packet envelope cap <budget> exceeded'}` in `restrictions` and `selection.omitted`, rebuilds the projections through the shared projection helpers, and measures again.
- In manifest mode, `next_cursor` is recomputed as it is today.
- In content mode, dropped sources are listed in `selection.envelope_dropped` so that callers can fetch them with `--source`.
- `unbounded` keeps `Number.MAX_SAFE_INTEGER`, so it is never trimmed.
- If the packet still exceeds the cap with zero records (metadata alone is too big), return the packet with `selection.truncated: true` and the warning `packet envelope exceeds cap without content`. Do not fail.

With §2 in place, the cap is normally reached only for content that is heavy in multi-byte characters or JSON escapes. The content budget counts characters, while the cap counts UTF-8 bytes.

### 4. Lens-level `session_start_sources`

`src/lenses.mjs` `validateDefinition` accepts one new optional field:

```json
{ "schema_version": 1, "id": "technical", "title": "Technical",
  "session_start_sources": ["profile/identity.md", "profile/work-context.md", "context/technical/*.md"] }
```

Validation:
- The value is an array of at most 20 unique strings, each a relative POSIX path or a glob that supports only `*` within a segment.
- Absolute paths, `..`, backslashes, and empty strings are rejected.
- The definition stays `schema_version: 1` because the field is additive and optional.
- `saveCustomLens` round-trips the field, and the `registry_hash` changes accordingly, which invalidates caches.

Semantics, implemented in `applySelectionPolicy`:
- A request is a **session start** when it has no `task`, no `--source`/`source_ids`, and no cursor.
- At session start, only candidates whose `path` matches one of the patterns are eligible. They are ordered by pattern order, then by the existing tie-breakers.
- Non-matching candidates are omitted with reason `not in lens session_start_sources`.
- Policy documents (`document_role: 'policy'`) are always eligible.
- When the lens omits the field, `DEFAULT_SESSION_START_SOURCES = ['profile/identity.md', 'profile/preferences.md', 'profile/work-context.md']` applies. The owner decided this narrow default (2026-10-07) because it matches #31's goal of cheap recurring session-start loads.
- The single entry `"*"` is reserved and means "all eligible sources". A lens that wants the old load-everything behaviour sets `"session_start_sources": ["*"]`. Recursive globs (`**`) are not supported.

### 5. Size reporting

`selection` gains:
- `total_bytes`: the measured byte size of the emitted payload on the current surface, including the `total_bytes` field itself. Measure, set, and re-measure until the value is stable; that takes at most 3 passes because only the digit count can change.
- `estimated_tokens_total`: `Math.ceil(total_bytes / 4)`, using `estimateTokens` semantics.
- `envelope_cap_bytes`: the cap, or `null` for `unbounded`.

`estimated_tokens_total_heuristic` is kept as a deprecated alias equal to `estimated_tokens_total` for one minor release. `estimated_tokens` (content only) is unchanged. The text packet (`packetFormat`) adds `packet bytes: <total_bytes>` to its receipt line.

### 6. MCP parity

`mcpContextData` already routes through `contextData(..., surface: 'mcp')` and only strips private paths afterwards. Parity requirements:

- `withoutPrivatePaths` runs **before** the final measurement, so the MCP `total_bytes` and cap apply to what is actually sent. This means moving the strip into `contextData` when `surface === 'mcp'`, or re-running the trimming loop afterwards. Moving the strip is preferred.
- The same inputs (`task`, `lens`, `budget`, `temporal`, `manifest`, `sources`) produce identical `selection.selected_sources`, `omitted` reasons, and `context_receipt.context_hash` on the CLI and MCP. The only difference is records dropped by the cap, because the MCP envelope is larger. Those are reported in `envelope_dropped`.
- The MCP tool schema documents `total_bytes`, `estimated_tokens_total`, and `envelope_cap_bytes`.
- **Body once on MCP.** `toolResult` in `src/mcp-server.mjs` currently sends the full payload twice: as `structuredContent` and as `content[0].text = JSON.stringify(structuredContent)`. For the `context` tool, `structuredContent` stays the full packet. `content[0].text` becomes a short text summary: lens, status, selected source paths, `total_bytes`, the receipt hash, and a note that the full packet is in `structuredContent`. This satisfies #31's "no body more than once" on MCP and roughly halves the MCP envelope. Other tools keep their current shape. `measurePayload` for MCP measures the real compact serialization that is sent, not `JSON.stringify(res, null, 2)`. Test: in an MCP `context` result, no document `content` string appears in `content[0].text`, and the measured bytes equal the sent bytes.

## Backward compatibility

- **`sources[]` field removal is a breaking change for JSON consumers** that read `search_text`, `sections`, `claims`, or `links` from `sources[]`. The bodies remain in `documents[].content`. The repository's own consumers are the Workbench (`web/app.mjs`), `packetFormat`, and the tests; they are updated in the same pull request. Note it in CHANGELOG under "Changed". The document arrays are unchanged, but bump `packet_metadata.schema_version` from 2 to 3 to signal the `sources[]` change.
- **Full-content packets may now omit sources** that previously fitted only because nothing was measured. Callers see this in `envelope_dropped` and can page with `--source`.
- **Session-start packets become smaller by default.** A lens can restore the old behaviour with `"session_start_sources": ["*"]`. Any request with a task is unaffected.
- **Lens files** without the new field stay valid. Older Holoself versions reject lens files that contain it, because unknown fields are rejected. Document that it requires the release version or later.
- **Decision-cache entries** (`CACHE_SCHEMA_VERSION`) must be bumped, because selection results now depend on `session_start_sources`.

## Acceptance tests

1. For each budget except `unbounded`, a fixture self with large documents produces `selection.total_bytes <= ENVELOPE_BYTE_CAPS[budget]` with and without `--manifest`, on both the CLI and MCP.
2. In no packet does any `sources[]` entry contain `content`, `search_text`, `sections`, `claims`, or `links`. Each `source_id` appears in exactly one `documents` array.
3. A lens with `session_start_sources: ['profile/identity.md']` and no task selects only that file plus policy documents. With a task, ordinary ranking applies.
4. Invalid `session_start_sources` values (`../x`, `/abs`, 21 entries, duplicates) are rejected by `loadLensRegistry`.
5. A cold run, an in-memory cache hit, and a persistent decision-cache hit return identical `selection` (excluding `cache`) and `context_receipt.context_hash` for the same inputs.
6. `selection.total_bytes` equals the byte length of the emitted output: stdout for the CLI, the envelope for MCP.
7. The CLI and MCP agree on `selected_sources` for the same inputs when the cap is not reached.

## Prerequisite: #32 data-root command form

`templates/AGENTS.md:5` and `skills/holoself/SKILL.md:70` instruct `holoself context --root . --project . …` (the skill uses `--root <root> --project <root>`). In `contextData`, `--project` takes the linked-project branch, which requires `.holoself/link.yaml`. A canonical data root has no link, so the command fails with `LINK_REQUIRED`. The owner-direct branch, `--root` only with the working directory inside the root, is the intended path.

The fix:
- Drop `--project` from both lines: `holoself context --root . --task "<current request>" --budget standard --json` in the template, and `holoself context --root <root> --task "<current request>" --budget standard --json` in the skill. The skill should also state that the command must run from inside `<root>`.
- Add a test that runs the template command verbatim against a fixture data root.

The fix lands before #31, because #31 changes the packet that this command returns and its tests should exercise the corrected form.

## File overlap and ordering

| File | #32 | #31 |
|---|---|---|
| `templates/AGENTS.md`, `skills/holoself/SKILL.md` | command form | budget wording only, if changed |
| `src/context-selection.mjs` | — | §1, §3, §5 |
| `src/ecosystem.mjs` (`contextData`, `mcpContextData`, `packetFormat`) | — | §1, §2, §3, §5, §6 |
| `src/lenses.mjs` | — | §4 |
| `src/mcp-server.mjs` (tool schema text) | — | §6 |

#34 and #33 (see link adapter scope, `docs/decisions/link-adapter-scope.md` added by #36) touch `src/ecosystem.mjs` only in the `link` command branch, which does not overlap with `contextData`. They also touch `src/cli.mjs`. The #33 per-subcommand allowlist must include every `context` flag. If #31 adds no new CLI flag, the two pull requests do not conflict there.

## Implementation notes (#31)

Where the implementation differs from the design above, this section is authoritative.

- **Session start is explicit.** It applies only with `--session-start` (MCP `session_start: true`) and no task, source or cursor. Treating every task-less call as a session start would also narrow restricted-host snapshots and other full task-less exports. The narrow default the owner chose applies to that flag. The session-start filter applies to self sources; project and method selection is unchanged.
- **One selection implementation.** `rankCandidates` → `verifyCursor` → `applyManifestPage` or `applySelectionPolicy` in `src/context-selection.mjs`. In-memory and persistent decision-cache hits re-run that same selection and only mark the hit, so cold and warm results cannot drift. The decision cache keeps recording decisions (content-free), and its key now separates session-start requests. `CACHE_SCHEMA_VERSION` is 4.
- **Cursor finding.** The persistent path used to parse cursors without verification. A forged cursor could not reach it, though, because the decision-cache key includes the cursor string, so a new cursor always went through the verified cold path. With a single path, verification now covers every case by construction.
- **`sources[]` when bodies are delivered** drops body-derived fields (`search_text`, `sections`, `claims`, `links`), the metadata copies (`access_lenses`, `disclosure`, `sensitivity`, `visibility`, `publication_allowed`, `public_safe`, `confidence`) and `source_ref`. `documents[].metadata` and `source_id`/`source_hash` carry those. Manifest entries carry no body, so they keep their snippets: a manifest would be useless without them, and nothing is duplicated.
- **Size fields are measured, not estimated.** `total_bytes`, `estimated_tokens_total` and `envelope_dropped` are present while trimming, with values at least as wide as the final ones. Adding the final values therefore cannot push a packet over the cap.
- **The envelope shrinks before content.** When a packet is over the cap, `restrictions` are first grouped by reason (`{source, reason, count, sources[≤5]}`, flagged `selection.restrictions_grouped`) and pending `proposals` are reduced to `{proposal_id, status}`. Only then are the lowest-ranked documents dropped. Packets that fit keep the ungrouped form.
- **The cap measures the emitted format:** the Markdown packet for default CLI output and snapshots (its receipt line reports `packet bytes`), pretty JSON for `--json`, and the full tool result for MCP.
- **After trimming,** `content_chars`, `estimated_tokens`, `truncated_sources`, `contrib_sources`, `contradiction_digest` and `validation` are recomputed from the kept records.
- **MCP `context_get`** treats handles dropped to fit as delivered-later rather than missing, and returns a partial result listing them in `envelope_dropped`.
- **Session start** orders self sources by pattern (unmatched self sources last) ahead of other kinds, and warns about patterns that match nothing.
