# ADR E02: Identity, revisions, block coverage and fidelity

Status: proposed D00 contract, pending independent review and human acceptance. Issue: #9; date: 2026-09-28.

## Decision

Allocate an opaque UUID per Source. Do not derive identity from a path or content hash: a move preserves identity after explicit owner reconciliation; equal bytes from different sources keep distinct attribution and policy. The existing catalog's path-based `hs-*` source ID remains unchanged. A later evidence catalog adapter uses a separate namespace and full evidence reference, never silently aliases the existing ID.

Revisions are immutable records identified by UUID, bound to source ID and SHA-256 of raw bytes. Repeating one operation ID with the same request returns the existing result; reusing it with different input fails. Same source and current bytes returns the current revision. A changed source creates a successor even if its bytes match an older revision (A→B→A has three chronological revisions). Expected manifest revision controls concurrent registration; source revision and mutable manifest revision are distinct. Extraction rechecks bytes and policy before atomic publication; changed input becomes stale and is not published as current.

Evidence references pin source, revision, extraction, block, block-content hash and locator. Block IDs are stable only within one immutable extraction. Extraction identity includes parser name/version, configuration hash and source revision. Re-extraction can change block boundaries; no automatic ID remapping or inherited fidelity. Corrections create a new extraction with explicit predecessor; the original remains untouched. Reviews survive cache deletion and bind exact extraction, block hashes, policy revision, reviewer and time.

Use Markdown line ranges; DOCX part plus structural path (section/paragraph/table/row/cell/footnote/comment), without invented stable page numbers; PDF one-based pages with optional bounding boxes in points from the top-left of the rotated page. Bounding boxes need page dimensions and valid bounds. Relations explicitly connect heading/content, question/answer, header/cell, caption/figure and speaker/utterance. Missing or ambiguous relationships are coverage gaps, never guessed facts.

Comment and footnote blocks link back to the annotated block using `annotates` and `footnote_of`. `attributions` preserve declared speaker and comment-author labels without claiming verified real-world identity. The golden oracle compares semantic targets through coverage-unit mappings, so an existing but incorrect target still fails. Expected speaker/author labels and documented limitations are part of that comparison.

Every derived `asset_path` requires `asset_sha256` over its bytes; a digest without a path is invalid. The immutable extraction binds that pair, and evidence references to asset-bearing blocks must also carry the exact asset digest. Reads verify bytes before serving an asset; replacement or loss is an integrity/availability failure, never the same historical visual. Text `content_sha256` remains the digest of block text only. Asset lookup and hashing must follow the same authorization/containment rules as the source; D00 tests use an in-memory byte map and do not implement filesystem access.

Each detected unit has exactly one coverage disposition: `extracted`, `preserved`, `unsupported`, `failed`, or `omitted`. Each coverage row points to at least one block, including a gap block when content is unavailable. Inventory status is independently `complete` or `incomplete`; counts do not prove the parser detected everything. `complete` extraction requires a complete inventory and no failed/omitted units. Preserved visuals and explicitly unsupported semantics may coexist with complete accounting; the report must display these limitations. Partial, failed, pending and stale remain explicit. A failed inventory cannot be reported as complete. The synthetic golden inventory detects omissions that a parser's own counters would miss.

Fidelity is independent: `unchecked`, `checked`, `needs_correction`. A checked block can belong to a partial extraction; a complete extraction can be wholly unchecked. Fidelity is a durable human comparison decision, not truth certification. A changed block/extraction or policy makes a former review inapplicable until revalidated. Interpretation stays candidate/proposed; knowledge approval lives only in the existing proposal lifecycle. None of these states changes another implicitly.

## Consequences and verification

More IDs and explicit observations prevent path moves, deduplication and cache rebuilds from rewriting attribution. The [schema and corpus](../specifications/evidence-contract-v1.md) pin independent state axes, coverage and locators. D03–D05 must demonstrate actual extraction, reference resolution and concurrency; contract validation alone does not do so.
