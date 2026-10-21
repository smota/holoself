# Autonomy envelope and state contract

This optional protocol is inert until existing source authority admits a tick. It does not create a
scheduler, authentication service, runtime adapter, phase, or approval ledger. Conversation history
MUST NOT supply authority. The [heartbeat procedure](heartbeat.md) applies this contract; the
[shipped state template](../assets/steer-state.yaml) contains no grant.

## Envelope bytes and closed schema

The recipe is `steerer-envelope-v1`. MUST bind that recipe, the full payload reference, stable
identity, and full hash explicitly in the ordinary governed goal body. Recipe version is outside
the payload; it is not a tenth field. Hash the exact UTF-8 JSON bytes with SHA256. MUST reject a
BOM, CR, missing or multiple terminal LF, invalid UTF-8, decoded duplicate keys at any nesting
level (including escaped spellings), unknown keys, and payloads larger than 16 KiB (16384 bytes).
MUST NOT reserialize before hashing. Byte changes, including whitespace, require fresh
sponsor-bound authority even when JSON meaning is equivalent. JSON.parse alone does not detect
duplicate keys; admission MUST check duplicates before parsing can discard them.

Exactly these nine fields are permitted:

| Field            | Type and constraint                                                                                                                                             |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `envelopeId`     | Nonempty string identifying a stable envelope record.                                                                                                           |
| `goalId`         | Nonempty string identifying the governed goal.                                                                                                                  |
| `gateId`         | Nonempty logical gate alias; null only in an inert example. Active use MUST resolve it to its current authoritative gate. It is never the computed gate digest. |
| `allowedActions` | Duplicate-free array drawn only from `advise`, `inform`, `wake`, `refocus`, `checkpoint`, `reassign`, `escalate`. An empty array grants no action.              |
| `constraints`    | Array of nonempty strings narrowing allowed behavior.                                                                                                           |
| `antiGoals`      | Array of nonempty strings naming prohibited behavior.                                                                                                           |
| `budgets`        | Closed object with exactly `actions` and `lines`: safe integers in 0..3 and 0..5 respectively.                                                                  |
| `deadline`       | Finite UTC ISO8601 timestamp expiring this envelope's authority, not an obligation due time.                                                                    |
| `ownerRef`       | Nonempty string identifying the stable accountable policy owner record.                                                                                         |

No executable commands, provider-specific fields, mutable caches, approval, answer, payload hash,
or computed gate digest belong in the hash preimage. The logical alias avoids hash self-reference:
the computed gate and subject digests stay outside it. Constraints and anti-goals still narrow
an allowed label. A label MUST NOT grant a new adapter, source mutation, custody change, or tool.

## Current sponsor admission

Before effects or steering state/journal writes, MUST establish this complete chain from current
source records:

1. Load the exact envelope bytes and verify the closed schema, stable identity, recipe and hash.
2. Verify their full reference/hash/recipe binding in the ordinary governed goal body. Derive the
   canonical subject through the existing `githubGoalSubject` / `goalSubjectDigest` recipe for the
   source medium. This is distinct from the `goalRevision` gate recipe; MUST NOT interchange them.
3. Resolve the logical alias to the current adequacy-of-intent `goalRevision` gate on that subject.
   Verify the full canonical gate digest, full goal subject digest, and current agreed judgment.
4. Read the original source-confirmed answer and filing provenance. Verify the exact confirmation
   phrase `agree <gate_id> as <sponsor>` against that current gate, not a refusal or copied proposal.
   A digest prefix MUST resolve unambiguously to the full current gate digest.
5. Verify the actual answering principal against the trusted source policy's authorized sponsor
   and against any named gate person. A current core `agreed` judgment alone does not enforce
   that named-person match. An agent filing the answer is not the answering person. A delegation
   grant or an agent action on behalf of the person is not the person's original answer.
6. Establish current source/write permission, applicable narrower caps, and trusted time strictly
   before envelope expiry. Recheck time and source revisions immediately before every effect/write.

A human-platform label, copied phrase, local assertion, fixture identity, or checksum is not an
identity signature. Missing authentication, ambiguous gate, mismatched principal, stale subject,
invalid bytes, unknown caps, or unknown/untrusted time means HARD STOP with zero state/journal
mutation. Inert null aliases, hashes, approval fields and source references grant nothing. Source
records remain the authority; this protocol adds no `envelopeHash` subject type or live gate.

At expiry, after expiry, or inability to prove time freshness, MUST stop before effects and writes.
Crossing expiry between boundaries stops the remaining work without replay, local fabricated
completion, or authority extension. Retain real earlier authoritative receipts at their source and
reconcile the incomplete pair on a later authorized tick. Renewal changes authority-bearing bytes
and MUST obtain a new current sponsor confirmation. Recovery deadlines are separate restrictions.

## Effective budgets and refusal modes

Operational action limit is `min(3, approved budgets.actions, every applicable narrower source action cap)`.
Journal limit is `min(5, approved budgets.lines, every applicable narrower source journal cap)`.
An applicable cap that is absent is unknown, not zero and not the absolute maximum. MUST hold
without operational effects or journal append; never substitute 3/5. Existing nonnegative consumed
counts for a stable tick remain shared across retries and occupant changes. Enforce remaining
capacity before every effect and physical appended line.

Zero actions permits no operational action. Zero lines permits no journal append. A valid grant
may permit bounded zero-action state projections only when all write/shape/time/source checks pass.
Loading, reading, validation, and bounded intent/receipt/state bookkeeping are not operational
slots. They MUST NOT conceal another source mutation, notification or recovery operation.
Every emitted advice, notification, wake, refocus, checkpoint, reassignment, or escalation is a
discrete action. Grouped commands and embedded newlines MUST NOT evade either cap. Bookkeeping
appends consume physical lines; insufficient journal capacity means defer/hold, not false commit.

| Mode      | Decision boundary                                                                                                                                                      |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HARD STOP | Invalid/stale/expired/unknown authority or limits. No envelope-granted effect or state/journal write.                                                                  |
| ASK       | Accepted-scope change, uncertain receipt, disputed source, unresolved overflow, or exhausted recovery needs the existing accountable owner/person. It is not approval. |
| INFORM    | Bounded allowed notice under current authority and remaining effective capacity. Never claim delivery without a receipt.                                               |
| Self-heal | One finite ordered recovery step on a later triggered tick, only with source/custody/checkpoint prerequisites. Never repair application source or bypass holds.        |

An outward HARD STOP notification needs independently current existing stop-channel authority.
An invalid/expired envelope supplies no grant. Intersect the independent source action cap with
absolute 3 and all actions already consumed by the stable tick; MUST NOT reset counts or write
state/journal while envelope authority is invalid. Under a still-valid envelope, operational
notifications also obey its lower cap: a valid zero grant cannot be bypassed as a stop operation.
If channel or capacity is unavailable, emit no effect and retain delivery as unavailable/unresolved.
Report that only on an existing independently authorized observer surface, if available; a report
MUST NOT hide another outward effect or invent delivered escalation. No notification service or
publication permission is added.

## JSON-compatible state schema

The `.yaml` template MUST remain JSON-compatible and parse with Node JSON.parse. Only its two
canonical/native shipped asset paths use the scoped Prettier JSON parser override; formatted
actual bytes MUST also parse and pass resolved project formatting checks. No YAML parser dependency
is needed. The maximum state size is 64 KiB (65536 UTF-8 bytes), validated before writes.

Top-level keys are exactly `version`, `phase`, `envelope_hash`, `approved_by`, `items`, `seats`,
`open_escalations`, `next_tick_hint`, `tick`, `recovery`, `archive_refs`. `version` is integer 1.
The seven customer keys (`phase`, `envelope_hash`, `approved_by`, `items`, `seats`,
`open_escalations`, `next_tick_hint`) MUST always be present, including held, recovery and
zero-action writes. Unknowns MUST stay explicit rather than imply completion.

| Field              | Shape and source boundary                                                                                                                                                                                                                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `phase`            | `{value, source, revision}`. Value is the current phase identifier or null. Active source/revision are nonempty strings; null only for inert or explicitly unresolved held projections. Phase source retains ownership.                                                             |
| `envelope_hash`    | Full lowercase SHA256 string (64 hex characters), or inert null.                                                                                                                                                                                                                    |
| `approved_by`      | `{principal, source, revision, confirmation_ref, gate_digest, goal_subject_digest}`. Active authorized strings are nonempty; both digests are full lowercase SHA256. All six are null when inert. Confirmation reference points to the original confirmed answer, not copied prose. |
| `items`            | `{source, revision, entries}`; active source/revision identify owner records; at most 32 entries with `id, status, source, revision, receipt_ref`. IDs are stable. Receipt reference is null only when genuinely uncertain.                                                         |
| `seats`            | Same source/revision projection wrapper; at most 32 entries with `logical_id, occupant_id, status, source, revision`. Logical seat identity survives occupant replacement; source owns custody.                                                                                     |
| `open_escalations` | Same wrapper; at most 32 entries with `id, obligation_id, status, source, revision, receipt_ref`. Unavailable delivery MUST NOT become delivered.                                                                                                                                   |
| `next_tick_hint`   | Finite UTC ISO8601 or inert null. A hint, not scheduler configuration or permission to wait.                                                                                                                                                                                        |
| `tick`             | Closed object defined below; owns only bounded steering execution history.                                                                                                                                                                                                          |
| `recovery`         | Same wrapper; at most 32 entries defined below. Owns bounded steering recovery history, not source phase/custody/holds.                                                                                                                                                             |
| `archive_refs`     | At most 32 `{source, revision}` references to verified durable retained records.                                                                                                                                                                                                    |

Source/revision references MUST identify actual owner records, not conversation summaries. An empty
inert wrapper uses null source/revision and an empty entries array. Active entries use nonempty
stable identifiers and source/revision strings; status projects the source's actual status rather
than inventing a second status ledger. Explicit source uncertainty remains held. The protocol
MUST NOT replace accepted phase, custody, hold or person-gate sources with its own cache.

`tick` has exactly `id`, `status`, `actions_used`, `journal_lines_used`, `state_generation`,
`journal_generation`, `intent_refs`, `receipt_refs`. ID is a stable string or inert null. Status
is `inert`, `planned`, `uncertain`, `committed` or `held`. Counters are nonnegative safe integers
bounded by 3/5 and the effective approved limits; retries MUST NOT reset them. Generations are
nonnegative safe integers. Committed status requires matching verified generations, not merely
equal locally asserted numbers. Intent/receipt arrays each hold at most 32 `{source, revision}`
references; source receipts prove effects. An intention alone never proves completion.

Each recovery entry has exactly `obligation_id`, `step`, `attempts`, `max_attempts`, `deadline`,
`exhausted`, `source`, `revision`, `checkpoint_ref`. Steps are `wake`, `refocus`, `checkpoint`,
`reassign`, `escalate` (the last means ASK). Attempts is a safe integer in 0..max_attempts;
max_attempts is a safe integer in 1..5. Deadline is finite UTC ISO8601; exhausted is boolean.
Defaults allow one attempt per ordered step and at most five total attempts. Source/revision
identify actual recovery evidence; checkpoint reference is unresolved until proven and MUST be
verified before a dependent reassignment. Preserve obligation identity, attempts, deadline and
exhaustion through retries, reassignment and occupant changes. Do not restart the ladder.

Validate array/byte/type bounds before writing. Unresolved overflow MUST hold/ASK; MUST NOT truncate
unresolved obligations or silently discard history. Archive only with existing permission, verified
durable destination, and explicit preservation of unresolved records. Archive references do not
grant deletion authority. When preservation cannot fit safely, retain the prior durable state and
return the bounded owner decision instead of overwriting it.

## Receipt, replay and pair semantics

MUST persist stable action intent before its effect under current write authority. Record completion
only from authoritative receipt evidence. Unknown effect means hold/ASK and source reconciliation,
not replay. A known completed duplicate emits no repeated effect. Counts are shared by stable tick
identity, not by process, occupant or retry. Receipt IDs and source revisions MUST remain traceable.

`state.yaml` and `journal.md` are separate writes. MUST NOT claim atomic two-file or exactly-once
behavior. Each physical journal record identifies the tick/action and generation plus source
intent/receipt references and uncertainty. Respect line budget even for reconciliation.

- State-only partial generation: do not emit the effect again or mark committed just because state
  contains an intention. Read authoritative receipts and the actual journal generation; reconcile
  only under current authority and remaining capacity.
- Journal-only partial generation: do not append a second full journal or infer matching state.
  Read the journal's real tick/action receipts, reconcile state and source revisions under current
  authority, and preserve uncertainty when effect proof is absent.
- Only a source/receipt-reconciled matching pair may be marked committed. A crash or expired authority
  leaves an incomplete/uncertain pair for a later admitted tick. It never grants extra actions.

The [heartbeat](heartbeat.md) owns the bounded ordering. Application-source edits, linters/fix
scripts, workflow transitions, QA/review verdicts, merge, publication, accepted-scope rewrites,
hold bypass and unapproved provider/model changes remain forbidden in every mode.

## Unfreeze resolution record

A frozen resolution ledger does not clear its fencing token inside this envelope. The transition
envelope may carry one signed `unfreeze-resolution` record, as defined in
[seam-rules](seam-rules.md): `resolution` is `re-scope`, `slice-split`, `person-waiver`, or
`abandonment`; `actor` and `rationale` are nonempty; `fencingToken` is the next epoch token; and
the record digest is current. Absent that signed record, the fence stays in force.
