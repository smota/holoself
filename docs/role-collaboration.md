# Role collaboration and acceptance

Every role transition is a bilateral contract. The sending role defines what the receiving role
must produce and how that delivery will be accepted. The receiver remains accountable for its own
phase; the sender accepts only conformance to the contract it issued.

## Protocol

```text
Role A -> RoleHandoff + AcceptanceContract
Role B -> DeliveryReceipt
Verifier -> deterministic report
Council -> optional structured advice and synthesis
Role A -> AcceptanceDecision or ReworkRequest
```

`RoleHandoff` is immutable and uses `state: issued`. Acceptance is a separate digest-bound record;
changing the candidate, handover, contract, delivery, or council synthesis invalidates downstream
decisions.

## Complexity routing

| Class         | Trigger                                                                   | Required path                         |
| ------------- | ------------------------------------------------------------------------- | ------------------------------------- |
| `linear`      | bounded, low-risk, complete evidence                                      | deterministic checks                  |
| `bilateral`   | medium risk, uncertainty, or multiple domains                             | checks plus sender acceptance         |
| `council`     | public contract, migration, high risk/uncertainty, or broad domain impact | targeted council plus sender decision |
| `human-gated` | high assurance, sensitive surface, or irreversible action                 | council evidence plus human authority |

Routing uses explicit rules rather than an opaque numeric score. Projects may tune sensitive
surfaces, domain thresholds, public-contract/migration triggers, and structured council seats under
`agent-workflow.config.json#collaboration`. They may not weaken single-writer, action-boundary,
review-independence, or human-approval controls. This separates the stable protocol taxonomy from
the engineering or business-analysis methods chosen by each adopter.

```bash
agentflow-sdlc collaboration classify \
  --profile standard --risk high --domains api,data,ui --json
```

## Deterministic-first acceptance

Code validates record integrity, digests, candidate identity, required criterion results,
ArtifactRefs, handover provenance, and required council completion. Execution receipts separately
record writer leases and execution provenance; these are not authenticated by content digests.
Semantic review receives only the
contract, current delta, deterministic report, and unresolved questions.

An acceptance criterion declares `verification: deterministic|semantic`. A required deterministic
criterion passes only with a `pass` result and evidence. Semantic criteria remain owned by the
handover sender and cannot replace specialist verdicts: planners check plan conformance, architects
check design conformance, testers own test verdicts, and reviewers own independent review.

```bash
agentflow-sdlc collaboration verify \
  --handoff role-handoff.json \
  --delivery delivery-receipt.json \
  --council-request council-request.json \
  --council-advice council-advice.json \
  --council-synthesis council-synthesis.json \
  --json
```

## Councils

`CollaborationIntent.mode` selects an execution pattern (advisory, discovery, spike, and so on).
`AcceptanceContract.collaborationClass` selects the assurance path (linear, bilateral, council,
human-gated). They are distinct: a council assurance path can run sequentially or in parallel.

A council is an advisory pattern inside the current role, not a lifecycle phase or majority vote.
The request freezes one evidence digest, question, accountable owner, and role-based seats. Each
seat returns structured advice, evidence, objections, confidence, and out-of-scope notes. The owner
must disposition every blocking objection and remains the final decision owner.

`council-advice.json` is an array with one record per participating seat. Verification checks the
delivery digest, owner, required seats, exact advice digests, and every blocking objection. A
deferred blocking objection does not permit acceptance. Semantic acceptance requires one passing
finding with a reason for every required semantic criterion. Human-gated acceptance additionally
requires delivery-bound human approval evidence. Digests detect stale content; they do not
authenticate the human or replace the host platform's authorization controls.

Harnesses may execute seats in parallel, sequentially, in isolated sessions, or through humans.
The record format and accountability do not change.

## Records

- `AcceptanceContract`: criteria, complexity class, candidate digest, controls, and council policy.
- `DeliveryReceipt`: criterion results, evidence, deviations, execution reference, and provenance.
- `AcceptanceDecision`: deterministic report, semantic findings, conditions, and final state.
- `ReworkRequest`: failed criteria and concrete required changes.
- `CouncilRequest`, `CouncilAdvice`, `CouncilSynthesis`: bounded advisory exchange.

Validate any record through `agentflow-sdlc collaboration validate --path <record.json> --json` or
the general `sdlc validate-evidence` command.

## Advancement gate

Record validation checks integrity; it does not authorize advancement. `createAcceptanceDecision`
recomputes verification from the source handoff, contract, delivery, and council records rather than
trusting a supplied report. Before advancing, run the source-bound gate with the current durable
rework ledger (`[]` explicitly means no open rework):

```bash
agentflow-sdlc collaboration advance \
  --handoff role-handoff.json --delivery delivery-receipt.json \
  --decision acceptance-decision.json --rework open-rework.json --json
```

Supply the council request, advice array, and synthesis flags above when required. Rejection,
rework, stale evidence, or conditional acceptance blocks advancement. Resolve conditions and issue
a new unconditional `accepted` decision before continuing. The orchestrator owns obtaining the
complete current ledger from the authoritative workflow source; a local file is only its input
projection, not an independent source of truth.
