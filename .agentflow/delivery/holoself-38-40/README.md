# Delivery scope for issues 38, 39 and 40

This configuration resumes the existing local-preview run. The issue snapshot retains the source title, body, update time and digest. It is local evidence, not GitHub-acknowledged run state.

The `scope` check validates preparation only. Product checks require named regression assertions from their actual test suites, and `verify` executes the repository verification script. Missing assertions fail verification even when unrelated tests pass. Product acceptance remains unimplemented until those checks and the owning role review succeed.

Candidate inputs bind tracked repository files plus this scope and its check executables. Add new implementation files before freezing their phase criteria. A candidate or definition change requires current evidence. Per-role acceptance contracts and bilateral bundles are stored in ignored `.agent-runs/issues/38-40/`; they are authored when that phase is ready, not preaccepted or committed as product code. A missing future bundle intentionally blocks advancement.

To resume, inspect `agentflow-sdlc run status holoself-38-40 --json` and the local checkpoint. Use the current writer and generation. Freeze before verifying; obtain actual role delivery and council advice before acceptance. This run authorizes local work only. PR publication and human merge gates retain their own authority.
