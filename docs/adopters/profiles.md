# Install profiles

List profiles without changing a target:

```bash
agentflow-sdlc adopt profiles --json
```

| Profile    | Use it for                                                    | Boundary                               |
| ---------- | ------------------------------------------------------------- | -------------------------------------- |
| `minimal`  | Provider-neutral contracts and configuration authority        | Contains no provider or Cockpit assets |
| `standard` | Minimal plus execution providers and optional harness catalog | Default; discovery grants no access    |
| `github`   | Standard plus GitHub source adapters                          | External writes remain preview-bound   |
| `cockpit`  | GitHub plus the optional Cockpit projection                   | Cockpit owns no unique domain state    |

Preview a minimal adoption:

```bash
agentflow-sdlc adopt plan --profile minimal --target /path/to/project --json
```

The preview is byte-for-byte read-only. It reports `create`, `update`, `unchanged`, `conflict`,
`preserve-removed`, `seed`, and `seed-skip` actions plus a content-derived token.
Do not approve a blocked plan.

Profile resolution closes relative JavaScript imports and JSON Schema `$ref` dependencies
transitively. A clean target can import every installed module and resolve every installed schema
without relying on files from a larger profile.
