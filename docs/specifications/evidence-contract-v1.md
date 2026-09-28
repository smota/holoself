# D00 evidence and coaching contract v1

Date: 2026-09-28. Issue: [D00 / #9](https://github.com/smota/holoself/issues/9), epic [#8](https://github.com/smota/holoself/issues/8).

Status: corrected candidate; independent confirmation and candidate-bound human acceptance are pending. The [prior-candidate validation receipt](../reports/evidence-contract-d00-validation.md) records executed checks and the initial Claude review findings. Development authorization does not imply acceptance. These are proposed contracts and synthetic fixtures, not available commands or measured extraction capabilities. D01 has not started.

## Decisions

| ADR | Decision |
|---|---|
| [E01: ownership](../decisions/evidence-01-ownership.md) | Explicit private root, disjoint from knowledge/projects; immutable reference records, optional consented snapshots; durable state and rebuildable derivatives separated |
| [E02: identity/fidelity](../decisions/evidence-02-identity-fidelity.md) | Opaque source identity; revision/extraction/block bindings; accounting and human fidelity are independent |
| [E03: authorization](../decisions/evidence-03-authorization.md) | Explicit retrieval, intersection of grants and current policy, denied metadata omitted, handles revocable |
| [E04: extraction](../decisions/evidence-04-extraction.md) | Local parser ports, bounded workers, no network/OCR fallback; D01 measures dependencies and ceilings |
| [E05: proposals](../decisions/evidence-05-proposals.md) | Per-claim evidence attachment; existing human approval; integrated fail-closed reader required before emission |
| [E06: coaching](../decisions/evidence-06-coaching.md) | Question/session/action/review working state; human commitment and verified outcome remain distinct |

The [development plan](external-sources-and-coaching-plan.md) and [orchestration contract](external-sources-and-coaching-orchestration.md) remain the execution scope and review gates. Six ADRs cover all proposed decision topics; E04 deliberately reserves parser/library/license and measured resource decisions for D01. No policy, command, existing schema or product module changes in D00.

## Machine-readable scope

- [Evidence schema v1](../../schemas/evidence-v1.schema.json): Source, immutable SourceRevision, Extraction with blocks/coverage, FidelityReview, Interpretation and ProposalEvidence attachment.
- [Coaching schema v1](../../schemas/coaching-v1.schema.json): question, session, action and review records.
- Existing [proposal schema](../../schemas/proposal.schema.json) stays byte-for-byte compatible; its legacy and v2 fixtures are exercised.

JSON Schema validates shape. The test-only oracle additionally checks whole-inventory accounting, block/asset hashes, exact semantic relation targets and declared attributions, required limitations, locator bounds, exact reference bindings, kind-specific coaching fields, linked-cycle ancestry and decision digests. Runtime implementations must enforce these and the ADR's filesystem, concurrency and authorization rules; the test helper is not a production API or general JSON Schema implementation. It supports only the used keywords and rejects unknown ones. Coaching decision digests currently specify UTF-8 `JSON.stringify` of the exact record without confirmation/verification fields; D10 must preserve byte serialization for verification or explicitly revise this contract to a canonical serializer before writing records.

Source root registration, mutable availability observations, publication receipts, handle bindings and configuration extensions are behavioral contracts in the ADRs; their persisted/API schemas belong to their implementing slices. D00 intentionally does not invent working interfaces for them.

The evidence schema's `access_lenses` accepts the existing built-in `general` lens. The canonical lens schema's reserved-ID prohibition applies when creating custom lenses. D00 checks only lexical pattern and maximum-length parity with the lens schema; it does not test reserved-ID behavior.

Compatibility note: the existing proposal schema nests a `target` keyword inside its `source_files` schema. Standard JSON Schema treats that misplaced keyword as an annotation. The test oracle preserves precisely that existing behavior, while rejecting unknown keywords in new contracts. Runtime target containment is separately enforced in `src/ecosystem.mjs`; correcting the old standalone schema is outside D00. Legacy shape compatibility does not certify that old schema as a complete security validator.

## Synthetic corpus and golden coverage matrix

The corpus is authored without real personal data. In a source checkout, `tests/fixtures/evidence/build.mjs` deterministically creates sibling files `complex.docx` and `complex.pdf`; `sample.md` is plain text. The sibling `golden.mjs` inventory is authored independently of an extractor, with 11 Markdown units, 16 DOCX units and 15 PDF units. These source-only files are intentionally excluded from the npm package; the reproduction commands below require a repository checkout. Every unit must be represented in later extraction coverage, even when unsupported. These are semantic units, not a mandated one-block-per-unit tokenization.

Fixture realism is limited: the DOCX uses stored-only ZIP entries (compression method 0), zero ZIP timestamps and no `docProps`. Literal byte assertions work because XML members are uncompressed. D01 must add a realistic deflate-compressed DOCX with document properties and verify the same semantic expectations through actual parsers, including expanded-byte accounting and decompression limits. D00 makes no claim about deflate extraction or real-world DOCX layout compatibility.

| Requirement | Fixture/counterexample | D00 check | Later runtime acceptance |
|---|---|---|---|
| R01 Identity and chronology | Move, same bytes/different source, invalid hash/version | Source/revision shape; IDs independent of location | D02 idempotency and A→B→A concurrency |
| R02 Original versus snapshot | Reference has no copy; snapshot without consent | Reject missing consent/extra storage fields | D02 verified copies, changed/missing bytes |
| R03 Source root safety | Traversal, drive/UNC/device/ADS, reserved component names, controls, trailing spaces/dots | Reject unsafe portable locator strings including mixed-case device names | D02 component/reparse/race, case collisions and root-overlap tests |
| R04 Policy and metadata | Owner-only empty grants; invalid/missing policy | Fail-closed structural counterexamples | D06 denied body/metadata/counts and revocation |
| R05 Markdown structure | Question/answer, table, quote, inert link, instruction-shaped text | Byte inventory, relationship and tamper checks | D03 real extraction with adjacent context |
| R06 DOCX structure | Six table cells, comment author/anchors, footnote linkage, speaker, header, image, caption, external relationship | Golden inventory, cell count, exact relationship/attribution mutations and asset digest checks | D01/D03 parser comparison and rendered inspection |
| R07 PDF structure | Three pages, two columns, six cells, chart and image-only page | Page/xref inventory, no invented DOCX page, bounds | D01/D04 all pages, scan gap, chart limitation and visual review |
| R08 Independent states | Complete/unchecked, partial/checked, unsupported units | Invalid completeness, missing reviewer, agent fidelity, approved interpretation rejected | D05 human comparison, correction and invalidation |
| R09 Pinned retrieval | Wrong source/revision/extraction/block/hash/locator/policy | Exact binding oracle rejects every mismatch | D06 bounds, required neighbors, denied references |
| R10 Human adoption | Legacy v1/v2 plus separate attachment | Existing schemas pass, extra fields and empty evidence fail | D07 integrated reader, preview binding, stale/replay/revocation checks |
| R11 Coaching cycle | Hypothesis, source fact, action, reported outcome | Wrong-kind fields/parents, absent parents, mismatched question ancestry, agent confirmation, stale decision and unreferenced verified result rejected | D10/D11 same cycle across interfaces |
| R12 Extraction failure | No text, encrypted, malformed, active content, resource/timeout/dependency failures | Explicit failure codes; missing failure reason rejected | D01 isolated resource/ZIP traversal/bomb tests, measurements/license decisions |
| R13 Retention and compatibility | Withdrawal, purge, recovery, package exclusion | Corpus outside package allowlist; every requirement has a fixture | D05/D12 originals/history preserved, clean install and portability |

The matrix's `Fixture/counterexample` column names the format associated with the later runtime corpus case; it does not promise a one-to-one mapping to a D00 test. In particular, R08's `pdf` label describes a later runtime corpus format while D00 exercises the Markdown contract, and R13's `pdf` label likewise describes later corpus format while D00 checks package configuration. D00 does not enforce those format-to-test links.

DOCX comments and footnotes must retain anchors and attribution; table cells retain headers; PDF columns cannot be silently reordered; page 3 must be identified as image-only. Per-format expected relations, attributions, literal anchors and limitations appear in the golden file and are consumed by tests. Mutation checks remove each relation or redirect it to a different existing block, and remove/change every expected attribution. Positive specimens are proposed adapter outputs assembled for oracle tests, not parsed or visually validated extractions. Shape tests are not evidence of extraction success, filesystem authorization or complete runtime privacy. Runtime resource/security scenarios use the same synthetic corpus plus generated fault cases in the named later slices; D00 does not execute a real ZIP bomb or parser.

Golden visual acceptance is explicitly `pending-human-review`. D01's tester must inspect rendered DOCX/PDF, confirm the inventory and add any missed units before measuring fidelity. Fixtures here are initial reproducible inputs, not a fabricated human-approved gold standard. No parser output generated the expected inventory.

The coordinator reports model inspection of all three rendered PDF pages. DOCX rendering was attempted with the packaged renderer but could not run because LibreOffice `soffice.exe` was unavailable; no installation was attempted. DOCX layout remains unverified. Neither model inspection nor structural tests record human visual acceptance.

## Reproduce and review

```sh
node tests/fixtures/evidence/build.mjs
node --test tests/docs.test.mjs tests/evidence-contract.test.mjs
git diff --check
```

The builder overwrites only its two synthetic siblings. No installation, remote fetch, private-root read or runtime feature activation is required. Tests exercise schema validation and an explicit test-only relational oracle with negative mutations; they also compare committed binaries to deterministic builder output. Full PDF/OOXML conformance and rendered layout remain D01 checks.

Reviewers should challenge authority promotion, root resolution and collisions, revision identity, gaps hidden by complete accounting, policy revocation before cache cleanup, sidecar bypass via old proposal readers, and agent-inferred commitments. Separate tester and Claude receipts must bind the exact candidate. Human acceptance remains pending until explicitly recorded against that candidate. D00 does not authorize starting D01 with an unaccepted contract.
