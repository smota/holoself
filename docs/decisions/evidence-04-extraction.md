# ADR E04: Local extraction boundary and D01 decision gate

Status: proposed D00 boundary; parser selection and measured limits pending D01, independent review and human acceptance. Issue: #9; date: 2026-09-28.

## Decision

v1 covers local Markdown, DOCX and PDF. Parser adapters emit the same immutable block/coverage contract. The domain knows no filesystem, PDF/ZIP library, CLI, web server or model. Use cases own policy, expected revision and publication; adapters implement storage/extraction ports. CLI/MCP/web compose those adapters. Coaching imports evidence/proposal contracts; evidence never imports coaching.

No mandatory remote service, silent dependency installation, OCR or chart interpretation. Preserve a chart/image as a referenced visual block and mark semantics unsupported. A scan without text is explicit partial extraction with a gap; it cannot become semantic text through optimistic reporting. External DOCX relationships may be recorded as inert metadata but are never fetched. Reject macros, active embedded content and unsupported encrypted documents; corruption, parser absence and timeout produce stable error codes and actionable owner guidance.

Provisional ceilings for the spike: 50 MiB input, 200 PDF pages, 200 MiB actual expanded DOCX bytes, 10,000 ZIP entries, 60 seconds and 512 MiB per job; one heavy job per process. These are hypotheses, not supported product limits. Count actual streamed decompression, not ZIP declarations; reject traversal and links in archive members before materialization. Bound CPU/memory/time outside the parser process. Stage outputs privately; publish only validated complete manifests via one atomic generation switch. A killed worker leaves identifiable staging, never partially visible current extraction. Retry is explicit and idempotent.

D01 compares local candidates on the complex synthetic DOCX and PDF, pinning versions, runtime/OS/hardware, licenses, transitive distribution obligations, offline behavior, dependency detection, page/element mismatches, wall time, peak memory and enforcement failures. Its report must decide dependencies and revise or confirm each ceiling. No dependency is selected in D00 without those measurements. Native tools remain optional with a clear unavailable result. Node >=20 and Windows/Linux/macOS remain required; an untested platform is an evidence gap.

## Gate and alternatives

Reject parser-specific public blocks, in-process unbounded extraction, network fallback and calling accounting a fidelity seal. If the spike cannot satisfy local safety/portability/fidelity boundaries, return to the product decision before D02. The [corpus](../specifications/evidence-contract-v1.md) defines expected units independently of candidate extractors. It is a starting corpus; D01 must add dangerous archive/resource fixtures in isolated tests, never check in a live bomb.

Actual dependency wiring is unimplemented and unverified.
