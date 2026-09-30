# D03 containment and validation checkpoint

Date: 2026-09-30. Status: **internal candidate checkpoint, not D03 acceptance or an available extraction command**. Issue: [#12](https://github.com/smota/holoself/issues/12). D02 remains unaccepted and [#22](https://github.com/smota/holoself/issues/22) remains open under the owner's explicit D03 sequencing exception.

## Implemented in this checkpoint

`src/evidence/supervisor/windows-job.mjs` creates a Node worker with `CREATE_SUSPENDED`, assigns it to a new Job Object with a 536,870,912-byte aggregate committed-memory limit and kill-on-close, verifies both the limit and membership, and only then resumes it. The 60-second maximum clock starts before `CreateProcessW`. Late completion is rejected. Cleanup explicitly terminates the job and polls its active-process count to zero within a separate five-second bound before closing the handle. A failure before resume kills the suspended child. No process handles are inherited by the worker. The primitive currently captures no parser output and is not connected to the evidence use case.

`src/evidence/supervisor/linux-cgroup.mjs` performs read-only cgroup v2 membership and memory/swap accounting preflight. It does not create a child cgroup or launch a worker. `src/evidence/extraction-validation.mjs` checks a proposed complete extraction against source bytes and length, source/revision/policy/parser identity, line bounds, content and asset hashes, coverage uniqueness, relation targets, and visible gap limitations. It returns immutable JSON bytes and a digest for future staging. This consistency check does not prove that the parser detected every semantic source unit. The production `extractEvidence()` entrypoint still returns `DEPENDENCY_MISSING` before parsing.

## Focused evidence

On Windows x64, both Node 20.0.0 and Node 26.10.0 passed the three focused test files: **17 tests, 16 pass, 1 platform skip, 0 fail**. Tests covered the synthetic Markdown adapter, runtime result validation, suspended launch, verified limits, timeout rejection, descendant termination, pre-resume failure cleanup and bounded over-allocation. A synthetic worker requesting 640 MiB in 16 MiB chunks exited 73 after allocation failed under the 512 MiB Job limit. One direct Node 20 probe reported a 541,745,152-byte Job peak; one Node 26 probe reported 542,117,888 bytes. These kernel-accounted peaks can transiently exceed the configured limit, as [E04](../decisions/evidence-04-extraction.md) already states. They are not RSS measures or a zero-overshoot guarantee.

`npm run audit:package`, `git diff --check`, and syntax checks for the new modules passed. A pre-edit SHA-256 inventory of the dirty worktree is stored in the private execution handoff. Of the 23 paths already dirty before this checkpoint, only the existing D03 `src/evidence/extraction.mjs` changed; its unavailable message was updated. All pre-existing D02 candidate paths retained their exact hashes. No original or personal source material was used.

## Remaining D03 work

- Add a bounded worker input/output transport with no writable owner-path redirect. Validate worker output before any staging or publication.
- Add source and policy freshness checks under the D02 owner lock, private staging, and one atomic authoritative generation switch. Test crash, cancellation, late output, retry, and descendant cleanup at that integration boundary. The current synchronous Windows wait does not support explicit cancellation.
- Implement and validate DOCX extraction, streamed expansion and ZIP-entry ceilings, archive/active-content rejection, exact supported relationships, asset hashes, and visible unsupported semantics. Expand Markdown support for lists and styled table cells.
- Implement a Linux child cgroup launcher that positively verifies `memory.max=536870912` and `memory.swap.max=0` before parsing; qualify native Linux. The optional macOS local-Linux-container provider requires explicit provisioning and qualification. No weaker fallback is available.
- Run independent D03 testing and Claude review, selected rendered-fixture inspection, and the candidate-bound human gate. D02's provisional status and #22 must be disclosed there.

Windows API behavior was checked against Microsoft's [CreateProcessW](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw), [AssignProcessToJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject), and [Job Object accounting](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_accounting_information) documentation. Those references support the mechanism; the executed tests above support the local observations.
