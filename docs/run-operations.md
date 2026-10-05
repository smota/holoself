# Run operations

Use `agentflow-sdlc` after installation. Pass `--target <project>` to select your project. These commands do not replace the required project policy, issue, role passes or human review.

## Inspect and configure

```text
agentflow-sdlc doctor-env --inspect --target <project> --json
agentflow-sdlc run --help
```

Run input files (`--plan`, `--request`, `--operation`, `--packet`, consent and acceptance files)
must be regular files inside `--target`, without symlink/junction traversal. Prefer ignored
`.agent-runs/` for temporary inputs; keep them outside `delivery.candidate.inputs`. Relative paths
are resolved against the target, not the shell's directory. An absolute path is allowed only if it
is still inside that target. For fresh-root resume, copy the preserved packet into the new target's
ignored `.agent-runs/` before invoking the command.

Configure `agent-workflow.config.json.delivery` with a source (`local-preview` or `github`), candidate input manifest, named checks, per-role acceptance files and per-role collaboration bundles. For GitHub also supply the exact `repo` and optional coordination `branch`. Local preview never claims durable GitHub acknowledgment.

For a GitHub source, `format` selects the coordination store. Omit it or set `"v1"` for the legacy single-file store; `"segmented-v2"` selects segmented storage. Migration and this project configuration change are separate actions: `run migrate` never flips `source.format` for you.

```json
{
  "delivery": {
    "source": {
      "kind": "github",
      "repo": "owner/project",
      "branch": "agentflow-state",
      "format": "v1"
    },
    "candidate": { "inputs": ["src/app.mjs", "src/app.test.mjs", "package-lock.json"] }
  }
}
```

Before creating a GitHub coordination ref, run `run source-plan <id>`, inspect the repository rules and workflow references in its plan, and authorize that exact destination. Pass its current digest to `run start` with `--setup-confirm <digest>`. A changed baseline/rules/workflow snapshot requires a new setup plan. This does not modify protections or prove permissions that the provider cannot inspect.

```json
{
  "delivery": {
    "source": { "kind": "local-preview" },
    "candidate": { "inputs": ["app.cjs", "app.test.cjs", "package-lock.json"] },
    "checks": {
      "suite": {
        "id": "suite",
        "criterionId": "query",
        "executable": "node",
        "args": ["--test", "--test-reporter=junit", "app.test.cjs"],
        "assertions": ["normalizes query"],
        "timeoutMs": 30000,
        "format": "junit-stdout"
      }
    },
    "contracts": { "product-manager": "requirements/acceptance.json" },
    "collaboration": { "product-manager": "requirements/collaboration.json" }
  }
}
```

The acceptance file uses `delivery-acceptance-v2.schema.json`. Its criterion `definitionDigest` is `recordDigest({...check, ...delivery.candidate})` from the packaged `lib/core/record-digest.mjs`. The frozen `collaborationContractDigest` identifies the existing bilateral contract, and `ownerRole` identifies its accountable owner. The collaboration bundle contains `handoff`, `contract`, `delivery`, `decision` and any required council records, as described in [role collaboration](role-collaboration.md). Run verification supplements this protocol rather than replacing its owner decision.

Input files must exist. Include the actual project dependency lock, not an invented filename. Freeze criteria before running checks. Updating a requirement or check means freezing its new version and collecting current evidence again.

For a GitHub source, `--goal` must be `issue:<number>` or an issue URL in the configured repository. The acceptance file's `goalRevision` is `recordDigest({repo, number, title, body, updatedAt})` from the current GitHub issue, with `updatedAt` taken from `updated_at`. The CLI re-fetches it when freezing and accepting; a human edit invalidates the frozen revision. A local preview uses its local contract digest and does not claim external source verification.

### Prepare a GitHub acceptance revision without importing package internals

After `init` has seeded a meaningful project check, keep its criterion definition digest unchanged
unless the check or candidate inputs change. Switching to a GitHub source requires replacing the
starter acceptance file's `goalRevision` with the exact issue revision. Read the issue through
`gh api repos/OWNER/REPO/issues/NUMBER` and save its JSON outside candidate inputs. Use the returned
`updated_at` field, not the timestamp of this local command.

For JSON records, `recordDigest` means SHA-256 of UTF-8 canonical JSON: remove only the top-level
`digest` property, sort object keys recursively, retain array order, and omit undefined object
properties. Use ordinary JSON values (no undefined array entries or nonfinite numbers).
This standalone Node recipe can prepare the documented acceptance file without package imports:

```javascript
// Save as prepare-goal.mjs outside the candidate. Run:
// node prepare-goal.mjs OWNER/REPO issue.json /target/agentflow-acceptance.json
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const [repo, issueFile, acceptanceFile] = process.argv.slice(2)
const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object'
      ? `{${Object.keys(value)
          .filter((key) => value[key] !== undefined)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(',')}}`
      : JSON.stringify(value)
const issue = JSON.parse(readFileSync(issueFile, 'utf8'))
const acceptance = JSON.parse(readFileSync(acceptanceFile, 'utf8'))
acceptance.goalRevision = createHash('sha256')
  .update(
    canonical({
      repo,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      updatedAt: issue.updated_at,
    }),
  )
  .digest('hex')
writeFileSync(acceptanceFile, JSON.stringify(acceptance, null, 2) + '\n')
```

Review and commit the target's configuration and acceptance file before the durable run. Use
`run source-plan` and its `result.digest` with `run start --setup-confirm`; select a dedicated
coordination branch, distinct from the candidate branch. Start with the real issue goal, explicit
writer and writer PID. `freeze` and `verify` establish a supported observed result; they do not
require or imply phase acceptance. To advance, additionally supply the bilateral bundle and
phase-zero consent described below. Never fabricate either to make the starter pass a later gate.

### Migrate a GitHub run to segmented storage

Run migration against the GitHub source while it is still readable as `v1`. The first command previews the exact current source and emits a confirmation digest. Apply only that digest; a source change makes the preview stale. The apply writes segmented records, a snapshot, tail, manifest, and a fail-closed marker at the old single-file path. It does not change project configuration. After verifying the migration result, explicitly update `delivery.source.format` to `"segmented-v2"` so later commands use the migrated store.

```text
agentflow-sdlc run migrate demo --target <project> --json
agentflow-sdlc run migrate demo --target <project> --execute --boundary external-action --confirm <preview-digest> --json
```

Read the first command's `result.confirm` value from its version-1 JSON envelope. The apply re-previews and compares the same digest before writing. If the current source is already migrated, preview reports that state without converting it again. Preserve the source history and the version setting together; a legacy binary fails closed on the marker instead of reading the migrated run as a v1 event list.

## Cooperative delegation and bounded GitHub actions

For the exact exercised environment, failure windows and remaining qualification
limits, see [public delivery qualification](delivery-release-acceptance.md).

Delegation is available only for a GitHub-backed durable run configured with a cooperative issuer. Add `delivery.delegation` before starting the run; its policy is captured when the run starts, so changing policy requires a new run. `reviewCheck` names a configured check that produces fresh, independently resolved automated-review evidence for the exact candidate.

```json
{
  "delivery": {
    "delegation": {
      "issuerId": "local",
      "reviewCheck": "automated-review",
      "policy": {
        "version": 1,
        "issuers": [
          {
            "id": "local",
            "origin": "cli",
            "authorityRef": "local-operator",
            "mode": "local-cooperative",
            "allowedActions": ["edit", "pr:create", "pr:update"],
            "allowThroughMerge": false
          }
        ],
        "requiredChecks": ["suite"],
        "reviewPolicy": "automated",
        "materiality": "fixed-scope-v1",
        "allowSubdelegation": false,
        "safetyReserve": 2
      }
    }
  }
}
```

Create a request JSON file following [the delegation contract](lifecycle-boundaries.md). Preview it against the current run revision and candidate, save the returned `result.plan` as `grant-plan.json`, then issue only that plan with its `result.confirm` digest:

```text
agentflow-sdlc run grant-plan demo --request grant-request.json --target <project> --json
agentflow-sdlc run grant-issue demo --plan grant-plan.json --confirm <plan-digest> --execute --boundary external-action --target <project> --json
agentflow-sdlc run grant-status demo --grant <grant-id> --target <project> --json
agentflow-sdlc run grant-revoke demo --grant <grant-id> --reason "Operator revoked delegation" --execute --boundary external-action --target <project> --json
```

The CLI's issuance decision is `local-cooperative`: the explicit digest confirmation binds the local decision to the request, plan, run revision and candidate. It does not authenticate a human or distinguish hostile processes sharing the same account. `trusted-host` binding and hard token/currency ceilings remain unsupported. Attempts, external-effect limits, paths, actions, checks, candidate identity and expiry are enforced from the grant; an already admitted action may finish after a later revocation, while new admissions after recorded revocation are denied.

Operations follow the source contract and require current exact-candidate checks, the configured automated review check, a clean tracked Git candidate at the operation's exact `headSha`, and a matching repository/candidate. `act` supports the configured `edit` provider plus the GitHub `pr:create`, `pr:update` and `merge` actions. `pr:create` defaults to a **draft** pull request; explicitly set `arguments.draft: false` in the admitted operation to create a PR ready for review. The operation digest binds this choice, and reconciliation checks GitHub's observed draft state. Creation consumes one external-effect allowance; a later merge requires its own admitted operation and allowance. `pr:update` does not change draft state. An uncertain outcome must be reconciled before any retry:

```text
agentflow-sdlc run act demo --operation operation.json --grant <grant-id> --execute --boundary external-action --target <project> --json
agentflow-sdlc run reconcile demo --operation <operation-id> --execute --boundary external-action --target <project> --json
agentflow-sdlc run journal-reconcile demo --execute --target <project> --json
```

`reconcile` resolves an admitted external action by operation ID. `journal-reconcile` checks the local write-ahead journal against the durable source; add `--replay` only when the unchanged source and current writer are eligible to replay the exact pending event. The journal is recovery data, not a replacement for source acknowledgment. Never repeat an uncertain business operation merely because its first command returned an error. For interrupted local stages, use the explicit `--recover-stages` and optional `--recover-lock-owner` procedure in [pending audit journal recovery](reliable-delivery.md); source absence is not permission to redispatch.

For a named merge, the run and current posture must permit `external-action`, and
the captured issuer policy must include `merge` with `allowThroughMerge: true`.
Create a new request restricted to `allowedActions: ["merge"]`, the exact repository
and base, required checks, a concrete expiry and one attempt/effect. Its preview
must report `destination: "named-merge"`. Issue that exact plan, then use the same
`act`/`reconcile` commands with an operation whose action is `merge` and whose
arguments are `{"prNumber":123,"headSha":"<exact-40-character-SHA>","mergeMethod":"squash"}`.
The operation also binds the grant's plan/policy, paths, candidate/workspace digests,
checks and review. Reconciliation requires the observed merged PR, exact head/base
and merge commit. GitHub's conditional merge protects the head SHA, not an atomic
base-branch comparison; cooperative deployments must exclude concurrent retargeting.
A human candidate-release gate blocks this cooperative merge path.

The `edit` action reaches a configured engineering provider and records its bounded receipt/output, but this command path does not establish a qualified end-to-end autonomous coding model. A provider must pass its actual target, model, capability, boundary and receipt checks. Default models have no qualification claim. The optional Meshloop path requires the explicitly pinned binary and configuration in [minimal Meshloop integration](intelligent-collaboration.md); that qualification uses a deterministic worker and does not qualify arbitrary LLM models. A returned edit result is not proof that the integrated workflow, tests, review, or final candidate were accepted. Keep human high-assurance security and acceptance review on the open PR before merge.

For a durable GitHub run, the engineering checkpoint can contain provider output and inline artifact bytes. It is withheld by default. To authorize publishing this bounded evidence to the configured coordination branch, set the exact `sourceEvidenceDisclosure` value below before issuing an edit operation:

```json
{
  "delivery": {
    "source": { "kind": "github", "repo": "owner/project", "branch": "agentflow-state" },
    "engineeringProvider": {
      "id": "codex-engineering-cli",
      "executionTarget": "codex-cli",
      "requestedModel": "<explicit-model>",
      "sourceEvidenceDisclosure": "bounded-output-and-artifacts"
    }
  }
}
```

The opt-in must match the operation's configured repository. Expected and returned artifact paths must be within the operation's admitted paths. The publication check rejects known secret patterns, private absolute paths and private artifact names in raw output and decoded artifact bytes; this heuristic cannot prove that evidence contains no secrets. Review the allowed paths and returned output, and keep credentials and private local files outside the provider's workspace. Do not treat a digest-only rewrite as equivalent evidence: durable receipt reconciliation currently depends on the exact bounded output.

## Execute and inspect

```text
agentflow-sdlc run start demo --goal issue:123 --writer operator --generation 0 --execute --target <project>
agentflow-sdlc run freeze demo --writer operator --generation 0 --execute --target <project>
agentflow-sdlc run verify demo --check suite --writer operator --generation 0 --execute --target <project>
agentflow-sdlc run status demo --target <project> --json
agentflow-sdlc run next demo --target <project> --json
```

`next` returns a JSON envelope whose `result.advancePlan` is the plan object and `result.confirm` is its digest. Save only `result.advancePlan` to a project-local file. For phase zero, use `run intent-plan demo --plan <file> --confirm <digest>` to obtain the exact sealed scope, then follow the [host-observed intent consent protocol](evidence-contracts.md). Apply a current typed receipt with `run advance demo --plan <file> --confirm <digest> --consent <receipt.json> --consent-confirm <receipt-digest> --writer operator --generation 0 --execute`. Missing bilateral acceptance remains blocked even when tests pass. This cooperative receipt records actual session consent for frozen intent only; it does not certify human identity or satisfy later high-assurance review.

All run output is a versioned JSON envelope. Exit codes: `0` success, `2` invalid input, `3` blocked/evidence missing, `4` stale/conflict, `5` unavailable dependency, `6` external outcome unknown. An absent run is reported explicitly.

## Checkpoint, pause and recover

`run checkpoint` records a progress boundary. `run pause --reason <text>` pauses Agentflow state; it does not pretend an arbitrary external process was stopped. Record the actual writer PID at startup with `--writer-pid` when the invoking parent is not the workspace writer.

For a local-preview run, `agentflow-sdlc run resume demo --writer replacement --writer-pid <pid>` previews recovery. Save the returned plan and apply with `--plan <file> --confirm <digest> --generation <old-generation> --execute`. The plan includes the replacement identity. An unknown prior writer, changed preconditions or unresolved operation blocks transfer. Use the returned generation for subsequent commands.

For a durable GitHub run, the supported entrypoints are top-level `handoff` and `resume`; pass the run ID as `--run`. Handoff requires `--execute`, a clean checkout with all work committed, and the candidate branch in the configured GitHub repository already pointing at the exact local `HEAD`. The run's candidate digest must match. The emitted continuation packet records that branch and commit SHA, source revision, run state, and SHA-256 references with byte lengths for every configured candidate input. Save the JSON `result` as a packet file for the next invocation.

```text
agentflow-sdlc handoff --run demo --writer operator --generation <current-generation> --target <project> --execute --json
agentflow-sdlc resume --run demo --packet .agent-runs/continuation.json --writer replacement --writer-pid <replacement-pid> --target <project> --json
agentflow-sdlc resume --run demo --packet .agent-runs/continuation.json --plan .agent-runs/recovery-plan.json --confirm <plan-digest> --writer replacement --writer-pid <replacement-pid> --execute --generation <old-generation> --target <project> --json
```

For a fresh-root continuation, push the candidate branch to the configured repository before
handoff. The packet records the candidate branch, not the separate coordination branch. Clone that exact branch and commit for resume; retain target configuration and any required
untracked input files through an explicitly reviewed transfer. Keep packets/plans outside candidate
inputs. Configure Git line-ending policy before creating the original candidate and use the same
policy in the new checkout (for example, a project-owned `.gitattributes` with `* text eol=lf` for
an LF-only project). A clean Git status alone does not prove byte identity under different checkout
filters. If the packet's byte digests differ, stop and correct the materialization policy; do not
rewrite the packet or silently repair individual bytes to manufacture a passing qualification.

For handoff, use the current owner and generation from `run status`; the implicit OS-user
identity will be stale if the run was started with another `--writer`. For resume preview and
apply, use the same explicit replacement name and its actual live process PID. Save the preview's
`result` as the plan and use its `result.digest` as confirmation; apply with the packet's old generation, then use the returned
new generation. Do not use a made-up PID to bypass the recorded prior-writer liveness check.

The packet-backed resume checks the packet against the authoritative run and source revision, its recorded writer generation, exact workspace branch and commit, candidate digest, candidate input bytes, and prior-writer liveness. It then produces a recovery plan; applying that plan rechecks pending operations and liveness before generation transfer. A packet alone neither copies files nor starts an agent. The stock liveness observer can prove a writer stopped only when it can inspect that PID on its recorded host; a different host or uncertain PID remains blocked. No timeout grants takeover. Never delete a lock or journal to force recovery; preserve the evidence and resolve the specific unknown state.

`run publish demo --issue <number>` previews a versioned issue comment for a GitHub-backed run. Apply the saved plan with `--confirm`, the current writer/generation, `--execute` and `--boundary external-action`. Publication also requires the persisted run boundary and effective posture/profile ceiling to allow `external-action`; coordination-branch write permission alone is insufficient. It preserves the issue body. Planned, submitted, unknown and confirmed projection records account for this comment separately from delegated grant attempts and external-effect allowances. Grant `maxExternalEffects` counts admitted logical business effects, not each GitHub request; source blob, tree, commit and ref requests are outside that allowance. This protocol does not enforce a total API-spend ceiling. A repeated invocation reconciles the original operation and does not submit another comment. If source acknowledgment succeeds but projection publication fails, inspect the pending operation before retrying.

Cockpit exposes the same source-derived run at `/runs/<id>` and JSON at `/runs/<id>.json`, within its configured repository and authorization boundary. It is optional and does not unlock a gate unavailable in the CLI.

`run context <id>` returns the current phase's contract, writer, candidate, findings, operation references and policy links. It avoids replaying a full transcript. Status lists missing observations explicitly; a displayed passing observation still needs fresh source resolution at acceptance.

Completed runs can still publish their final issue projection without reopening development. Pending projections remain visible and take priority in `nextAction`, including after completion.

## Integration ports

The stock `run verify` command executes project checks using the structured-report or native JUnit collector. Hosts can use `collectGitHubCheck` and `resolveGitHubCheck` for exact commit/check/app observations. `observeGitHubLifecycle` resolves merge, tag and release identity. Deployment and exercised rollback use `observeDeployment` and `observeRollback`, with provider-supplied runtime identity and required behavior assertions; a plan alone cannot satisfy exercised rollback. Feed re-resolved observations into `resolveLifecycle` separately from numbered role completion. These APIs observe outcomes; they do not deploy or operate a scheduler.

The run service accepts host `observeUsage` and `requestSafeStop` ports. Usage must be verified in the configured budget unit. The CLI has no provider usage meter, so an admission-enforced or provider-enforced budget with unknown usage pauses before launching another check. Advisory budgets disclose unknowns. A host with a verified meter can admit bounded attempts, and one with cancellation can request safe stop. Pausing the stock CLI records the checkpoint without claiming it stopped an arbitrary provider process.

Each configured budget admission records the observed usage, next-attempt estimate and their separate certainty. Status and Cockpit replay the same record. The run's budget is fixed at creation; changing its configuration requires a new reviewed run. Obsolete writers cannot consult or stop providers through admission. Budget denial first persists the local pause, even if external cancellation is unavailable or unauthorized. An authorized provider stop is journaled before calling `requestSafeStop(state, {authority, revision, operationId})`; the provider must fence its action by generation and use the operation ID for reconciliation. Only `{verified:true, stopped:true}` confirms termination. A failed or uncertain response remains an operation that the host's `reconcileOperation` must resolve before recovery.

Metrics distinguish observed evidence from accepted delivery, setup/planning from activated execution, and retries from planned promotions. Attempt records include run, phase, criterion and candidate. Missing intervention counts, unsupported-claim audits and usage remain explicit unknowns; they are not reported as zero.

Domain constraints belong in `sdlc.config.json.deliveryPolicy`. Set `requiredJourneyCoverage: true` to require journeys when freezing criteria. `deterministicOrigins` can restrict the accepted observed origins. `budgetMaxima`, for example `{"tokens":10000}`, requires an enforced operational budget in that unit at or below the ceiling; the initial implementation supports one budget unit per run. The v2 contract, source acknowledgment, human-review phase and unknown-writer/usage protections cannot be disabled. The stock local-preview source remains explicitly non-durable.

A compact acceptance file can include `journeys: [{"id":"search","required":true,"criteria":["query"]}]`. Every required journey must reference currently verified criteria. Non-UI changes can omit journeys. Coverage keeps verified, accepted and deployed states separate.

## Adoption storage and recovery

```text
agentflow-sdlc adopt plan --profile standard --storage project --target <project> --json
agentflow-sdlc adopt apply --profile standard --storage project --confirm <plan-token> --target <project> --json
agentflow-sdlc adopt rollback --receipt <returned-receipt-path> --confirm <receipt-token> --target <project> --json
agentflow-sdlc adopt recover --confirm <recovery-token> --target <project> --json
```

The returned receipt path is authoritative; transaction IDs differ from plan tokens. External storage remains available through `--receipt <absolute-outside-file>`. A pending journal blocks new adoption. Keep receipts for the required rollback window and clean them only after confirming transaction completion and retention needs. Project-local receipts disappear if the project is deleted.
