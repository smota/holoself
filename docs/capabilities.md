# Harness capability negotiation

AgentFlow describes desired execution behavior without embedding Claude, Codex, Grok, Pi, Agy, or
another harness into lifecycle roles or skills. The active provider is inspected at runtime and the
resolver selects the smallest implementation that satisfies the declared intent and controls.

## Bounded taxonomy

| Concept          | Question                          | Examples                                  |
| ---------------- | --------------------------------- | ----------------------------------------- |
| Lifecycle role   | Who owns the SDLC decision?       | `agentflow:architect`, `agentflow:tester` |
| Skill or method  | How is the work approached?       | `agentflow-scanner`, TDD, event storming  |
| Execution intent | What portable behavior is needed? | `delegated-work`, `parallel-fanout`       |
| Control          | What may never be weakened?       | `single-writer`, `review-independence`    |
| Provider facet   | What service surface exists?      | `execution`, `evidence`, `workspace`      |
| Provider binding | How will this run now?            | provider, transport, fidelity, limits     |
| Evidence         | What actually happened?           | intent resolutions and execution receipt  |

Controls are not capabilities. Provider facets are not execution intents. Runtime platform,
execution target, transport, model, and delegation boundary remain distinct provenance fields.

## Execution intents

| Intent                   | Purpose                                             | Typical consumers               |
| ------------------------ | --------------------------------------------------- | ------------------------------- |
| `plan-before-edit`       | Establish an approach before mutation               | architect, planner, developer   |
| `delegated-work`         | Run bounded work in another context                 | collaborator, reviewer, scanner |
| `parallel-fanout`        | Evaluate independent lanes concurrently             | scanner, tester, QA expert      |
| `isolated-workspace`     | Keep experimental writes outside the issue worktree | migrator, developer spike       |
| `background-execution`   | Continue bounded long-running work asynchronously   | orchestrator, tester            |
| `structured-result`      | Return a schema-constrained result                  | auditor, reviewer, PR readiness |
| `bounded-loop`           | Repeat with explicit limits and stop conditions     | developer, migrator             |
| `workflow-orchestration` | Coordinate steps while preserving AgentFlow phases  | orchestrator                    |

`delegated-work` is intentionally mechanism-neutral. A provider may implement it as a subagent,
fresh session, provider call, sequential role lens, or human handoff.

## Provider descriptors

Providers expose structural `facets` and a separate `intentSupport` descriptor:

```json
{
  "facets": ["execution", "evidence"],
  "intentSupport": [
    {
      "id": "delegated-work",
      "implementation": "native",
      "fidelity": "full",
      "evidence": "probed",
      "limits": { "maxDelegates": 4 }
    }
  ]
}
```

Availability is `available`, `configured`, `manual`, `unknown`, or `unavailable`. Implementation is
`native`, `plugin`, `adapter`, `emulated`, or `manual`; fidelity is `full`, `partial`, or `degraded`;
evidence is `probed`, `contract-tested`, or `self-declared`.

`inspect()` is the runtime authority. There is no target-by-capability matrix. A new provider adds a
descriptor and probe without changing role, skill, or method catalogs.

## Resolution and fallback

The resolver:

1. validates the portable execution intent;
2. checks required provider facets;
3. calls the provider's `inspect()`;
4. resolves every intent with fidelity, evidence, limits, and status;
5. applies only explicitly allowed semantic fallbacks;
6. emits a digest-bound plan and execution receipt.

Valid fallbacks include parallel fanout to sequential role lenses and native planning to an
AgentFlow plan artifact. Invalid fallbacks include a shared-worktree second writer, same-context
self-review presented as independent, or a spike without an isolated workspace.

```bash
agentflow-sdlc providers list --json
agentflow-sdlc providers inspect grok-cli --json
agentflow-sdlc collaboration plan --mode council --provider grok-cli --json
```

Provider-specific documentation is illustrative only. The observed descriptor and receipt are the
authority for the current run.

## Evidence

Role passes record `executionIntentsUsed`. `ExecutionReceipt.executionIntentSource` records the
provider's declared support and actual resolutions. Required loops include maximum iterations and
stop conditions; planning includes its pre-edit artifact; delegated work includes permissions,
context, result, and owner synthesis.

```bash
node scripts/validate-execution-intent-evidence.mjs --path evidence.json --json
```

See [Intelligent collaboration](intelligent-collaboration.md) for mode selection and
[Role collaboration](role-collaboration.md) for deterministic handover acceptance and councils.

Execution integrations use `planBoundExecution({ provider, collaborationPlan, request })` from
`lib/collaboration-plan.mjs` to carry the selected binding into the provider's digest-bound plan.
This preserves intent resolutions and degraded status in the resulting `ExecutionReceipt`.
Do not reconstruct a binding from a provider name or discard its fallback evidence.
