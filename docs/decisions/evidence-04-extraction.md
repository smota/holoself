# ADR E04: Local extraction boundary and D01 decision gate

Status: D00 boundary accepted; D01 parser and supervisor feasibility decision independently tested and reviewed at spike scope. See the [D01 validation receipt](../reports/evidence-extraction-d01-validation.md). Production implementation remains unverified. A human decision is required if the accepted contract changes materially. Issues: #9 and #10; date: 2026-09-28.

## Decision

v1 covers local Markdown, DOCX and PDF. Parser adapters emit the same immutable block/coverage contract. The domain knows no filesystem, PDF/ZIP library, CLI, web server or model. Use cases own policy, expected revision and publication; adapters implement storage/extraction ports. CLI/MCP/web compose those adapters. Coaching imports evidence/proposal contracts; evidence never imports coaching.

No mandatory remote service, silent dependency installation, OCR or chart interpretation. Preserve a chart/image as a referenced visual block and mark semantics unsupported. A scan without text is explicit partial extraction with a gap; it cannot become semantic text through optimistic reporting. External DOCX relationships may be recorded as inert metadata but are never fetched. Reject macros, active embedded content and unsupported encrypted documents; corruption, parser absence and timeout produce stable error codes and actionable owner guidance.

Provisional ceilings for the spike: 50 MiB input, 200 PDF pages, 200 MiB actual expanded DOCX bytes, 10,000 ZIP entries, 60 seconds and 512 MiB per job; one heavy job per process. These are hypotheses, not supported product limits. Count actual streamed decompression, not ZIP declarations; reject traversal and links in archive members before materialization. Bound CPU/memory/time outside the parser process. Stage outputs privately; publish only validated complete manifests via one atomic generation switch. A killed worker leaves identifiable staging, never partially visible current extraction. Retry is explicit and idempotent.

### D01 supervisor feasibility decision

Keep the provisional whole-job budget at **512 MiB = 536,870,912 bytes**. Define it as the provider's kernel-accounted memory for the worker and all descendants: Windows uses a Job Object aggregate committed-virtual-memory limit (`JOB_OBJECT_LIMIT_JOB_MEMORY` plus `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`); Linux uses cgroup v2 `memory.max=536870912` with `memory.swap.max=0`; macOS requires an explicitly provisioned local Linux container provider with that same Linux cgroup metric. The coordinator and disclosed provider VM overhead are outside this job budget. These provider metrics are not identical to RSS, and kernel enforcement does not promise zero transient overshoot. No macOS provider has been measured yet.

The use case requires a fail-closed supervisor port. Verify the selected provider and applied limits before parser work; if unavailable, return a stable unavailable result. Do not implicitly install or start a provider, pull an image, access the network, or fall back to an advisory memory poll or V8 heap flag. Start the 60-second deadline at job launch; reject any result completed after it, terminate the entire job tree, and record cleanup latency separately. Windows production launch must create the worker suspended, assign it to the Job Object and verify limits before resuming it. A parser exception, limit breach or deadline cannot publish staging. D01 only demonstrates bounded local feasibility; D03/D04 must validate publication, descendants and stress, and D12 must qualify native Linux, Windows and the opted-in macOS provider. The [D01 report](../reports/evidence-extraction-d01-spike.md) records the probes and gaps.

D01 compares local candidates on the complex synthetic DOCX and PDF, pinning versions, runtime/OS/hardware, licenses, transitive distribution obligations, offline behavior, dependency detection, page/element mismatches, wall time, peak memory and enforcement failures. Its report must decide dependencies and revise or confirm each ceiling. No dependency is selected in D00 without those measurements. Native tools remain optional with a clear unavailable result. Node >=20 and Windows/Linux/macOS remain required; an untested platform is an evidence gap.

## Gate and alternatives

Reject parser-specific public blocks, in-process unbounded extraction, network fallback and calling accounting a fidelity seal. If the spike cannot satisfy local safety/portability/fidelity boundaries, return to the product decision before D02. The [corpus](../specifications/evidence-contract-v1.md) defines expected units independently of candidate extractors. It is a starting corpus; D01 must add dangerous archive/resource fixtures in isolated tests, never check in a live bomb.

Actual dependency wiring is unimplemented and unverified.
