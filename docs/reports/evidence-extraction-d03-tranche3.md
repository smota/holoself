# D03 extraction writer checkpoint: Windows output transport

Date: 2026-09-30. Candidate on `codex/external-evidence-coaching`. This is an internal D03 tranche, not accepted extraction. The user authorized D03 work while D02 remains unaccepted and issue #22 remains open.

## Implemented

The Windows Job Object primitive now optionally captures a bounded combined stdout/stderr byte stream from a synthetic Node worker. It creates anonymous pipes with parent ends non-inheritable, and launches the worker suspended using a `STARTUPINFOEX` handle allowlist containing only the child stdin-read and stdout/stderr-write handles. It retains the native handle-list buffer until process launch completes. The existing 512 MiB aggregate Job limit, membership and limit verification before resume, launch deadline, and descendant termination remain in force. A synchronous poll drains output while the worker runs, including output larger than pipe capacity. Output over the configured byte cap fails closed. A timed-out or nonzero-exit worker returns no output bytes. Cleanup attempts every handle/process step even if an earlier cleanup step fails.

Only `src/evidence/supervisor/windows-job.mjs` and `tests/evidence-supervisor.test.mjs` changed in this tranche. The public `extractEvidence()` entrypoint still throws `DEPENDENCY_MISSING` before parsing. No private source was read, staged, or published.

## Verification

Windows x64 Node 26.10.0: `node --test tests/evidence-docx-markdown.test.mjs tests/evidence-extraction-validation.test.mjs tests/evidence-supervisor.test.mjs` passed 22, skipped one non-Windows case, failed zero. Synthetic tests covered combined stdout/stderr, output larger than pipe capacity, bound rejection, timeout and nonzero-exit discard, and an unrelated inheritable Win32 handle excluded from the worker. `npm run audit:package`, `node --check`, and `git diff --check` passed; Git emitted only pre-existing line-ending warnings.

Before editing, all 29 pre-existing dirty file hashes and a tracked diff were saved under `%TEMP%/holoself-epic8-execution/d03-writer-tranche3-before-*`. Comparison found only these two intended pre-existing D03 files changed; D02 candidate paths and authored fixtures retained their hashes.

## Remaining acceptance work

This transport has no evidence-input protocol, no parser-result framing/hash validation, no explicit cancellation API, and no asynchronous coordinator. The synchronous native call can block cancellation until the deadline. Trailing bytes from descendants after the root worker exits are not qualified as a complete parser protocol. Windows negative native failure injection (assignment/query/resume/cleanup) was not performed in this tranche. Linux cgroup v2 is still preflight only; macOS routing is not implemented.

Atomic private staging, current-source/revision/policy checks with D02 retained owner handles, generation publication, stale/retry/crash tests, full DOCX semantics, richer Markdown list/table handling, rendered fixture checks, independent testing, Claude review, and human acceptance remain open. The next writer tranche should implement an input/output worker protocol and cancellation before connecting parsing or publication. No public operational extraction path should be enabled before those guarantees and atomic publication are proven.

## Coordinator verification and stop

The coordinator reran the same three focused suites on Windows Node 20.0.0: 23 total, 22 passed, one platform skip, zero failures (exit 0). The writer was interrupted at the 30-minute deadline after saving its checkpoint. No further implementation or review was started.
