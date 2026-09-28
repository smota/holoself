# D00 validation and initial independent review

Date: 2026-09-28. Scope: [D00 / issue #9](https://github.com/smota/holoself/issues/9), [contract v1](../specifications/evidence-contract-v1.md). This sanitized receipt records the **prior reviewed candidate only**. It does not accept the corrected candidate or authorize D01.

## Candidate and execution identity

- Base HEAD: `43dcfbb5e9f443f9fc1f52b47f7ed6290771af7e`.
- Reviewed candidate digest: `263e7399774790415f5f86c9aeb010c3c11b39f4f362042bb7a6311660b092dd`.
- The coordinator's manifest binds HEAD, tracked diff hash and SHA-256 hashes of all 17 changed/new files, including the two synthetic binaries. The digest identifies that supplied manifest; it is not a Git commit or this later report's digest.
- Writer: Codex `gpt-6-astra`, effort `high`, separate writer session. Independent tester: Codex `gpt-6-sol`, effort `high`, fresh session `/root/d00_validation`; read-only validation, separate from the writer. Codex testing is additional verification, not the cross-vendor review.
- Deterministic runner: Node.js `v24.19.0` on Windows. This receipt records local checks, not a portability qualification on Node 20, Linux or macOS.

## Recorded checks for the prior candidate

These results were supplied by the execution coordinator from the separate tester and deterministic runs; Claude inspected their descriptions without executing commands.

| Command | Recorded result |
|---|---|
| `node --test tests/docs.test.mjs tests/evidence-contract.test.mjs` | 21/21 passed; no failures |
| `node scripts/verify.mjs` | 236/236 tests passed; package audit, help and capabilities passed |
| `node scripts/package-audit.mjs` | Package paths and public defaults clean |
| `git diff --check` | Passed |

Run these commands from a source checkout. The fixture corpus and test tools are source-only; npm packages intentionally omit them. No real personal data, private-root reads, parser dependency installation or feature activation was part of this validation.

## Independent Claude review

- Provider/harness: Claude Code CLI; actual substantive model `claude-opus-5`; requested effort `high`.
- Session: `e8c2f5b3-86a2-489e-b76e-1b072fb7fc59`; receipt timestamp `2026-09-28T19:44:12.471226+00:00`.
- Duration: 333.5 seconds. Claude subprocess exit: 0; JSON subtype `success`, `is_error: false`; candidate `unchanged: true`.
- Scope: fresh read-only independent review of D00; no test commands executed by Claude, no authoring or personal-context access. Runtime telemetry also lists auxiliary `claude-haiku-4-5`; the substantive review model was Opus.
- Verdict: **changes-required**, one medium evidence-publication finding and five low findings. This was not approval.
- The outer Python runner exited 1 while printing the completed review through Windows cp1252 because the prose contained an unsupported Unicode character. Saved UTF-8 review, JSON stdout and receipt remained intact. This was a local output-printing failure after successful Claude execution, not a provider error. The coordinator corrected the external runner's output encoding for confirmation; the initial review was not rerun.

The raw `candidate.json`, `receipt.json`, `review.md` and `stdout.json` are retained in an ephemeral OS temporary review directory outside the repository. They are diagnostic provenance, not shipped artifacts; this report preserves the necessary public candidate identity and conclusions without private paths or transcripts.

## Findings and correction status

| ID | Severity and finding | Authored correction; confirmation pending |
|---|---|---|
| C1 | Medium: no published candidate-bound validation receipt | This report records the prior candidate, roles, executed results, review identity and limitations |
| C2 | Low: evidence lens IDs were structurally laxer than existing lens IDs | Match canonical pattern and 40-character limit; malformed and overlength IDs have negative tests |
| C3 | Low: empty blocks/coverage could claim complete extraction | Complete extraction requires nonempty blocks and coverage; empty cases rejected; pending empty state remains valid |
| C4 | Low: shipped docs linked to excluded test fixtures | Corpus paths are explicitly source-only references; local Markdown links now target shipped documents/schemas |
| C5 | Low: stored-only ZIP fixture realism was undisclosed | Disclose compression method 0, zero timestamps and absent document properties; D01 must add realistic deflate coverage |
| C6 | Low: two named counterexamples lacked tests | Add same-bytes/distinct-source attribution cases and extra storage-field rejection |

The earlier independent tester's path portability, semantic golden coverage and linked coaching findings were corrected before this prior candidate was frozen. The tests at that candidate included negative semantic relationship/attribution cases, parent ancestry checks and derived-asset digest binding.

## Visual evidence and remaining gates

The coordinator reports model inspection of all three PDF pages rendered with pypdfium2. This is model QA, not human acceptance or extraction-fidelity certification. DOCX rendering with the packaged `render_docx.py` failed because LibreOffice `soffice.exe` was unavailable on PATH; no installation was attempted. DOCX layout remains unverified, and human golden-corpus acceptance remains pending.

Corrected-candidate tester confirmation and Claude's second/final review round remain pending. Their receipts must bind the newly frozen candidate; prior pass counts and the initial review do not transfer automatically. Candidate-bound human acceptance is also pending. D01 parser selection, license/resource measurements, realistic deflate inputs, rendered DOCX inspection and later runtime security/compatibility gates remain open under the [orchestration contract](../specifications/external-sources-and-coaching-orchestration.md).

## Corrected-candidate confirmation added after review

This separate confirmation was appended after the final independent review. It records supplied candidate-bound execution results and the review receipt; it is an editorial addition and does not revise the prior-candidate history above.

- Candidate digest reviewed: `11c3e73e3204ae2e873d299b2cd218ba15f8ea157f0629a6cbbbb1500f1ea6a2`.
- Final independent review: Claude Code CLI, substantive model `claude-opus-5`, requested effort `high`; session `f251fa3e-b178-4e93-9a5b-cd6192c01e94`; subprocess exit 0, JSON subtype `success`, `is_error: false`; duration 155.6 seconds; candidate `unchanged: true`.
- Verdict: **approved for D00 contract readiness**. The review confirms all findings C1–C6 resolved. It does not record human acceptance or assess D01 gates.
- Corrected-candidate targeted validation supplied by the independent Codex tester (`gpt-6-sol`, effort `high`): `node --test tests/docs.test.mjs tests/evidence-contract.test.mjs` passed 21/21; `git diff --check` passed.
- The writer's full validation supplied for the corrected candidate: `node scripts/verify.mjs` passed 236/236 tests; package audit, help and capabilities passed. The earlier independent full-suite result of 236/236 in the prior-candidate section above belongs to digest `263e7399774790415f5f86c9aeb010c3c11b39f4f362042bb7a6311660b092dd` and is separate from this corrected-candidate result.

These results support contract readiness only. Candidate-bound human acceptance remains pending. DOCX rendered layout and visual acceptance remain pending. D01 obligations remain open, including parser and license selection, resource measurements, realistic deflate coverage, rendered DOCX inspection, and runtime security and compatibility gates. This receipt changes no D00 or D01 scope.
