# D01 validation receipt

Date: 2026-09-28. Scope: exploratory validation of the local extraction feasibility spike for issue #10. The accepted D00 contract remains the baseline: delivery `54a29a4459c332b26b997dbd08823f96fcd0a923`, recorded against base `28f47e28ed7a59dec2e082e16d2f64dff663d170`.

## Independent testing

The writer was assigned Codex `gpt-6-sol/high`; the bounded architecture escalation used `gpt-6-astra/high`. A fresh Codex `gpt-6-sol/medium` session performed the independent testing and correction confirmation. The post-review receipt editor used `gpt-6-luna/high`.

The initial frozen candidate was digest `2f92469f4184a4620152398080b36008a2063030d8d2cc3d29e1a0654f302ad9`. The independent tester found one documentation defect: the report directed Node 20 users to regenerate compressed DOCX bytes, although zlib versions produce different valid DEFLATE bytes. The report was corrected to use fixture identity, structure and parser checks on Node 20+, with exact byte regeneration scoped to Node 24.19.0 and its recorded zlib version.

The tester's correction confirmation passed on digest `e217d6098279faf3c6c5f1bc4401721bd2a03745d85dcb746d4f7919f4e1c738`. It verified that only the spike report changed in the 15-file candidate manifest; the other 14 file hashes and HEAD remained unchanged. The corrected Node 20 checks passed: fixture comparison, resource and timeout probes, and 4/4 targeted tests. Exact fixture regeneration passed on Node 24.19.0. Earlier independent Windows and WSL2 probes, synthetic visual inspection, Docling comparison and packaging checks remain documented in the spike report and original tester receipt; the correction confirmation did not rerun them.

## Independent source review

Claude Code CLI 2.1.263 reviewed the corrected 15-file manifest read-only, using `claude-sonnet-5` at high effort. The run exited 0, reported no error, and confirmed the candidate was unchanged. It took 44.4 seconds at `2026-09-28T20:59:22.164351Z`; session `efda8462-9219-4828-965e-88a38c70abdc`. This was review round 1 of at most 2. Auxiliary Haiku telemetry was present, separate from the substantive Sonnet review.

Verdict: **approved** against issue #10's exploratory spike criteria. The reviewer found no blocking defect. The one low finding was the acknowledged Windows probe limitation: the child was not created suspended, so production launch still requires suspended assignment and limit verification. Informational notes concerned readability of the parser timing table and that the cgroup fixture probe covered PDF.js 4 only; the report's claims are scoped accordingly. Review claims are source-inspection findings. Execution, provider measurements and package checks remain tester- or writer-reported; Claude did not run commands or inspect binary visual fidelity.

## Disposition and boundary

D01's exploratory acceptance criteria are satisfied at spike scope. D00's human acceptance of the contract remains valid. D01 selected parser dependencies and refined expressly provisional resource/supervisor limits within the accepted H3/H6 boundaries; it does not change authority, capture format, or the Node 20 floor. No additional D01 human gate is inferred, and this receipt does not accept future production work.

D02 is next and remains a high-assurance candidate gate. Production qualification remains open for suspended Windows startup, native Linux, the optional explicitly provisioned macOS local-container backend, stress, atomic publication, extraction fidelity and human golden review. The spike did not suspend startup. Node 20 full-suite baseline failures in 42 C00 async-before tests are separate D12 verification debt. No runtime dependency or extraction/coaching feature shipped in D01.

This receipt, its index/orchestration status edits and E04's status-only update were written after Claude's review. They are editorial evidence added afterward and are not included in the reviewed manifest or its unchanged-file result. E04's decision body is unchanged. No delivery commit ID is recorded here; the coordinator will record it separately.
