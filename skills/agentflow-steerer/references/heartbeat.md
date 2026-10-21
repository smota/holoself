# One stateless heartbeat tick

A tick is one bounded decision turn triggered externally. It reads small durable records, uses
current source authority, and exits. It MUST NOT accumulate conversation as state, schedule itself,
sleep, wait for a reset, or poll inside the turn. This document specifies a protocol, not a shipped
runtime loop. Execution verbs are mapped via [adapter-openrig](adapter-openrig.md); reverse-seam
governance is codified in [seam-rules](seam-rules.md). No new source owner, lifecycle phase or scheduler is installed by this skill.

Read the [envelope and state contract](envelope.md) before using this procedure. The
[inert template](../assets/steer-state.yaml) is a starting shape only. Availability of the skill
or template does not activate steering. Advisory cognitive grooming remains the default.

## 1. Load evidence, not recollections

Load `state.yaml`, the actual `journal.md` pair, the exact envelope bytes and current owner records.
Read source `goal.json` / `gates.json` where supported, or the equivalent governed medium records;
inspect current git and PR artifacts and source revisions needed for this decision. Do not invent
filesystem records for another medium. Use bounded revision/digest comparisons to identify changes,
not an unbounded scan or repeated live checks. Every projection names its authoritative source and
revision. A missing record, unreachable source or unknown comparison stays explicit unknown/held.

Reload phase, accepted scope, original sponsor answer, person gate, holds, dependency verification,
seat/custody and receipt evidence at each tick. Local steering history owns only tick/recovery
metadata. Existing sources retain phase, delivery owner, acceptance and publication authority.
A prior message, optimistic intention or stale state field never replaces them.

## 2. Admit or hard stop before mutation

Apply the complete exact-byte/sponsor/goal/gate/time/write/cap admission chain in the envelope
contract. Reject malformed/duplicate/extra fields, inert or unresolved active authority, stale
subject/hash, mismatched actual or named sponsor, expired envelope, unknown time/source or missing
applicable cap. Invalid admission means no steering state/journal write and no envelope-granted
effect. An outward stop needs its own current channel authority and bounded capacity; no permitted
channel means unavailable/unresolved, not delivered.

Distinguish a present zero grant from an absent applicable source cap. Zero is a known valid limit;
absence is unknown and held. Intersect absolute, approved and narrower source caps before selection.
Load stable-tick consumed counts; do not reset them on retry, reassign or occupant replacement.
Trust neither a digest nor a human-platform label as proof of the actual sponsor.

## 3. Reconcile previous partial work

Keep the same stable tick and action IDs for retries. Inspect authoritative effect receipts,
intent references and actual state/journal generations before proposing new effects.

- Receipt-backed completed action: emit no duplicate effect, retain actual receipt and consumed count.
- Intention with unknown effect: hold/ASK; reconcile at source, never blindly replay or claim success.
- State-only partial pair: separately compare real journal and source receipts; state intent is not
  completion. Do not create a second effect to repair the missing write.
- Journal-only partial pair: separately read the real journal records and source receipts; do not
  append a second complete journal or assume state has committed.

Reconciliation needs current authority, write permission, shape/byte bounds and remaining budgets.
Matching asserted generation numbers alone do not prove a committed pair. If authority expired,
retain real earlier receipts at their source and leave local pair unresolved; do not mutate it to
claim completion. A later authorized tick may reconcile. There is no atomic pair/exactly-once claim.

## 4. Select at most three priority actions

Within the effective action cap and remaining journal capacity, select only labels admitted by the
envelope and existing source authority. Apply this order:

1. Preserve safety/person gates, accepted scope, authoritative holds and unresolved receipt uncertainty.
2. Escalate a decision that requires its existing owner/person, including expired/exhausted recovery
   when an independently authorized channel and remaining capacity permit it.
3. Consider one eligible recovery step, then bounded information/advisory work for independently
   ready dependencies. A delivery hold remains held even under quota/reset pressure.

Prefer the smallest eligible customer-progress proposal; use the cognitive grooming rationale when
product trade-offs matter. Scope expansion returns to the product owner/person, not a new steering
grant. Busy, stale or disputed availability MUST NOT become a ready squad on an assumption.

One emitted advice/notification/recovery operation is one discrete action. Grouped commands do not
compress multiple effects into one. Effective caps are min(absolute3/5, approved budgets, applicable
narrower source caps); existing counts are shared with retries. Under zero action capacity perform
no operational effect. Under zero line capacity append nothing. Bounded reads/validation and valid
zero-action state projection bookkeeping are not effects, but cannot hide notifications, source
mutations or recovery. If required intent/journal bookkeeping cannot fit, defer/hold instead of
exceeding capacity or claiming the pair committed.

## 5. Execute only already-authorized operations

Use an existing authorized channel/adapter only when independently available; this protocol supplies
no implementation. Recheck trusted time, source revisions, permission, holds and remaining limits
immediately before each effect and write. Do not poll or wait to make a prerequisite become true.

Persist stable intent before its effect. Capture the actual source receipt before marking completed.
An unsuccessful or uncertain attempt consumes its actual effect/notification/recovery capacity;
uncertainty is not permission to reset the tick and try again. Reuse receipt-backed IDs to refuse
duplicates. Crossing authority expiry stops remaining work, including writes; preserve source
receipts honestly without fabricating local completion or silently renewing authority.

Never perform application-code edits, linters/automated fixes, phase advancement, acceptance edits,
QA/review self-certification, merge/publication, hold bypass, unapproved provider/model changes or
accepted-scope expansion. Refuse each forbidden operation separately even if bundled with an allowed
advisory task. Allowed labels do not transfer another role's authority.

## 6. Persist bounded projections and exit

Only under still-current write authority, build the complete state shape, including all seven
customer fields and bounded tick/recovery metadata. Verify source references, active approval shape,
counts, array limits, at most64KiB state and matching actual generation/receipt semantics. Append at
most the effective remaining physical journal lines, with tick/action IDs, generations, source
intent/receipt references and uncertainty. The total stable tick stays within absolute three actions
and five lines and all lower approved/source limits. Newlines/grouping/retries cannot evade counts.

If one write succeeds and the other fails, record no fictional committed pair. Use the distinct
state-only/journal-only reconciliation rules on a later admitted tick. If line capacity cannot fit
required records, hold/defer; don't append anyway. Do not silently discard unresolved records to fit
32-entry/byte limits. Archive references require verified authorized durable retention; otherwise
retain the old durable state and ASK the owner when an authorized channel permits it.

`next_tick_hint` is a finite UTC ISO8601 timestamp or inert null, not a timer, scheduler configuration
or promise that another turn will occur. Report the observed result, held dependency/owner and next
bounded decision when available, then exit immediately. Arrange future triggering only through an
existing separately authorized external mechanism; do not add one here.

## Finite per-obligation recovery

A stall needs current source evidence, a stable obligation ID, accountable owner and custody. Unknown
or busy delivery preserves the hold. Keep a finite recovery deadline and safe attempts/max_attempts
(0..max_attempts, max_attempts1..5), exhausted flag and checkpoint evidence in the bounded recovery
projection. Defaults allow one attempt at each ordered step and at most five attempts total.

On a later externally triggered tick, permit at most one eligible ordered step:

| Step           | Required evidence and boundary                                                                                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wake           | Source-confirmed stalled obligation and current owner/channel permission. One bounded nudge; preserve its receipt/unknown delivery.                                                                     |
| Refocus        | Wake history and still-stalled current source/custody; bounded return to current intent, not another blind wake.                                                                                        |
| Checkpoint     | Current owner's permitted checkpoint mechanism and verified source/receipt of preserved work. Do not answer a person's prompt or manufacture a checkpoint.                                              |
| Reassign       | Current custody authority, verified checkpoint/work preservation and authorized available successor. Preserve holds, obligation identity, attempts, deadline and receipts. No provider/model inference. |
| Escalate / ASK | Existing accountable owner/person channel and bounded capacity. Exhaustion/deadline makes this terminal; no further automatic reassignment. Unavailable delivery stays unresolved.                      |

Attempts, deadline, prior steps and exhaustion MUST remain monotonic for the obligation across
retries, reassignments and occupants. Never fork a new obligation to reset the ladder. If evidence
is missing, remain held; do not skip to a destructive later step. Before an effect, recheck envelope
expiry and independent recovery deadline. Recovery exhaustion stops automatic reassignment until
a new authorized person decision; it is not a renewed envelope grant or permission to bypass zero
budgets. A real receipt is needed to call an escalation delivered.

## Proof ownership and honest limits

Source tests prove actual template parsing/formatting, support-file registration/copy/staleness and
native/packed/adopted byte fidelity. They are not a semantic autonomy verdict. Independent QA
applies the candidate to its own sealed application inputs, checks schema/type/byte/cap/time/source
boundaries and records actual decisions, effects, state, journal and receipt uncertainties. Builder
MUST NOT author expected semantic prose or grade those scenarios. Reviewer follows QA, not beside it.

Unknown source authentication or time remains unknown. A synthetic fixture label or scratch checker
is not sponsor login, a product runtime or a live scheduler. No model-generalization, exactly-once
execution, automatic host activation or provider-specific mechanism is claimed by this protocol.
