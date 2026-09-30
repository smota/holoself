# Local coaching sessions

The coaching CLI keeps a question, reflections, a chosen action, and a later review in a session you can resume. It runs locally and does not call a model. Use an AI assistant or another reader for conversation and document extraction; give Holoself only the text and provenance you want to keep.

```bash
holoself coaching start --root C:/private/my-self --question "What should I delegate?"
holoself coaching note <id> --root C:/private/my-self --expected-revision 1 --kind hypothesis --text "A summary may be enough."
holoself coaching action <id> --root C:/private/my-self --expected-revision 2 --text "Ask for a summary."
holoself coaching choose <id> --root C:/private/my-self --expected-revision 3 --action-sequence 3
holoself coaching review <id> --root C:/private/my-self --expected-revision 4 --outcome done --text "I received the summary and used it."
holoself coaching resume <id> --root C:/private/my-self
```

Each command prints the current revision and event history. Use that revision for the next write. `coaching resume --root C:/private/my-self` lists sessions. Notes distinguish `user_report`, `hypothesis`, and `intention`. An action begins as proposed. `choose` records an explicit caller attestation that the action was chosen. A `done` review is a user report; Holoself does not independently verify completion or the caller's identity.

For material that another tool or person has already read, pass extracted text directly:

```bash
holoself coaching material <id> --root C:/private/my-self --expected-revision 5 --material-status partial --source-label "meeting notes" --producer "external reader" --limitations "last page missing" --material-text "Extracted text"
```

Material can be `imported`, `partial`, or `failed`. Partial and failed records require a limitation. Failed material is marked unusable and stores no content. Direct PDF, DOCX, or other file import is unsupported; the CLI reports this clearly. Coaching continues when material is missing or failed.

Session JSON is stored under `<self-root>/coaching/sessions/`. This working history is outside the canonical profile and the default context/export readers. Existing evidence bindings are left untouched; the coaching CLI does not migrate or read them. Proposals and approval remain the path for durable changes to canonical self context.

## Limits and recovery

Each question, note, action, review or supplied material text is limited to 64 KiB. Material is stored as supplied, without trimming indentation. This CLI does not read document files or fetch source links.

If several chosen actions await a review, `review` addresses the most recently chosen one first. Prefer finishing one action/review cycle at a time; the output records the action sequence that was reviewed.

Writes use a per-session `.json.lock` file. A process crash can leave that file behind. If a session keeps reporting busy, first stop all Holoself writers using that self root and copy the session JSON and lock file as a backup. Then remove only `<self-root>/coaching/sessions/<session-id>.json.lock`, preserving the `.json` history, and run `coaching resume` to obtain the current revision before retrying. Never remove a lock while another writer may still be active. No automatic stale-lock deletion is performed.
