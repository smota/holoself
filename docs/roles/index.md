# Lifecycle roles

AgentFlow roles are versioned accountability contracts. They define who owns a decision, which
inputs and outputs cross a phase boundary, what authority applies, and what evidence proves the
role completed. A role is not an AI persona, runtime, skill, or methodology.

```text
Role = accountability
Skill = reusable capability
Actor = human or AI runtime executing the role
Method play = configurable way to perform part of a role
Workflow profile = applicability, transition, and gate policy
```

## Product taxonomy

The catalog in `manifests/role-catalog.json` defines nine lifecycle roles and one optional
sidecar:

| Identity                           | Owns                                       | Does not own                               |
| ---------------------------------- | ------------------------------------------ | ------------------------------------------ |
| `agentflow:product-manager`        | problem, outcome, release intent           | requirements, architecture, implementation |
| `agentflow:analyst`                | requirements, acceptance, scope            | priority, architecture, implementation     |
| `agentflow:architect`              | design, risk, workflow profile             | implementation, test verdict               |
| `agentflow:implementation-planner` | implementation, validation, rollback plans | design, implementation, verdicts           |
| `agentflow:developer`              | implementation, change evidence            | test or review verdicts                    |
| `agentflow:tester`                 | deterministic verdict, validation evidence | implementation, review verdict             |
| `agentflow:reviewer`               | digest-bound review verdict and findings   | implementation, deterministic test verdict |
| `agentflow:technical-writer`       | guidance, onboarding, release language     | product behavior or specialist verdicts    |
| `agentflow:pr-readiness`           | PR manifest, traceability, follow-up state | specialist or merge decisions              |
| `agentflow:qa-expert`              | exploratory findings                       | deterministic test or review verdicts      |

`qa-expert` is a sidecar attached to testing and review. It is not a tenth lifecycle phase.

Role definitions use qualified `agentflow:<slug>` identities. CLI input may use the matching current
short slug, such as `reviewer`; aliases from earlier releases are rejected.

## Interaction model

Roles interact through typed artifacts and `RoleHandoff`, not ambient prompt context. The sender
satisfies exit criteria and emits a digest-bound proposal. The receiver checks its declared input
contract and accepts, rejects, or requests clarification. Workflow state advances only when the
handoff is accepted. A single actor still performs logical handoffs when it changes roles.

The internal role handoff is distinct from `DeliveryHandoff`, which transfers a validated delivery
to an external owner or operational lifecycle.

## CLI

```bash
agentflow-sdlc roles catalog --json
agentflow-sdlc roles inspect developer --json
agentflow-sdlc roles validate --json
agentflow-sdlc roles resolve analyst --methods agentflow:method:event-storming --json
agentflow-sdlc roles sync --harness all --dry-run --target /path/to/project --json
agentflow-sdlc roles sync --harness all --apply --target /path/to/project --json
agentflow-sdlc roles status --harness all --target /path/to/project --json
```

Generated role projections live under `.agentflow/roles/<harness>/`. They are portable adapter
inputs, not a claim that every harness has the same native subagent format.
