# Link adapter scope for repair and deactivation

Status: accepted for implementation (issues #34, #33). Ships with the #34 pull request; #33 builds on it.

## Problem

`.holoself/runtime.json` records which platform adapters a project activated (`activatedAdapters[].id`). Two link commands ignore that record.

- **Repair (#34).** `link repair` calls `activateLinkedProject` (`src/ecosystem.mjs`), which defaults to `activate: o.activate || 'auto'`. `auto` selects every *detected* adapter, so repair can add adapters the user never activated or drop ones whose host files are no longer detected. `migrateProjectSkillsToGlobal` (`src/adapters.mjs`) already does this correctly through `activeAdapterIds(project, readRuntime(project))`; repair does not reuse it. The Workbench `POST /api/spaces/:id/repair` (`src/web-server.mjs`) runs `link repair --project <dir> --yes`. It applies the change without showing the plan, and the browser shows only a generic `confirm()`.
- **Deactivation (#33).** `deactivateProject(project, options)` takes no scope. It removes every managed instruction block, every managed skill file, and `runtime.json`. You cannot deactivate a single host. `--adapter` cannot provide the scope because the global parser in `src/cli.mjs` already binds it to the context-packet format (`pi|claude|codex|generic|obsidian|restricted-host`). The parser has one flat flag table, so a flag that is valid for any command is accepted, and silently ignored, by every command.

## Decision

### Repair reuses recorded adapters (#34)

1. Export `activeAdapterIds(project, runtime)` from `src/adapters.mjs` and add a small helper next to it. Also export `REGISTRY` or a `isKnownAdapter(id)` helper if a caller needs one.

   ```js
   export function recordedActivation(project, runtime = readRuntime(project)) {
     // { ids, source: 'recorded' | 'detected', dropped }; empty ids mean "use auto"
   }
   ```

   The source is `recorded` when `runtime.json` lists adapters, and `detected` otherwise. The `detected` fallback first uses managed-marker discovery, then `auto` detection.
2. In the repair branch of `link repair`, when the caller passed neither `--activate` nor `--platform`, set `o.activate` to the recorded IDs joined with commas, so `activationPlan` takes its `list` mode. When the fallback finds nothing, keep `auto`. An explicit `--activate` or `--platform` still overrides the record and reports `source: "explicit"`.
3. `activateLinkedProject` adds `source: "recorded" | "detected" | "explicit"` and `adapter_ids` to the printed `activation_plan` JSON. `link activate` reports `detected` or `explicit`. It never reads the record: activation is the step that creates the record.
4. Repair keeps `skillInstallPolicy` from the runtime record. This is already the behaviour, through `installSkill: o.installSkill || readRuntime(project)?.skillInstallPolicy`.
5. A recorded ID that is no longer in the registry is dropped and reported in `activation_plan.dropped_adapters`; it is not treated as an error. Repair must not fail on an adapter that was removed in a later release.

### Workbench repair previews before applying (#34)

1. `POST /api/spaces/:id/repair` with no body, or with `{"preview": true}`, runs `link repair --project <dir> --dry-run --yes` and returns `{ preview: { output, plan: { activation_plan, binding_migration? }, plan_hash } }`. `plan_hash` is the SHA-256 of the exact dry-run output, which is deterministic for an unchanged project. A dry run also prints the activation plan after any binding migration. The `--yes` flag here only satisfies the non-TTY confirmation; `--dry-run` guarantees that nothing is written.
2. `POST /api/spaces/:id/repair` with `{"apply": true, "plan_hash": "<hash>"}` recomputes the preview, rejects the request with `409 PLAN_CHANGED` if the hash differs, and only then runs `link repair --project <dir> --yes`.
3. `web/app.mjs` replaces the generic `confirm()` for `repair` with a dialog that shows the adapters, their `source`, the writes, and any binding migration. A second click sends the apply request.
4. Other destructive space actions (`activate`, `deactivate`, `relink`, `setup`) keep their current behaviour in this change. Follow-up work can reuse the same preview/apply contract for them.

### Scoped deactivation (#33)

1. **Flag:** `link deactivate --adapters <list>`. It uses the same list semantics as `--activate`, parsed by the existing `parseSelection`:
   - `codex,claude`: deactivate the listed adapter IDs only.
   - `all`, or the flag omitted: current behaviour, everything is removed. This keeps scripts working.
   - Unknown IDs: error `unknown platform adapter: <ids>`, the same message `activationPlan` uses.
   - An ID that is known but not recorded as active: reported as `result: "not-active"`. This is not an error, so repeated runs are safe.

   `--adapter` (singular) keeps its context-packet meaning, so the two concepts no longer share a flag. `--platform` is rejected for `deactivate` so that users have only one way to pass the scope.
2. **`deactivateProject(project, { dryRun, adapters })`:**
   - Without `adapters`, or with `all`: unchanged.
   - With a list, remove only the instruction files and project skill files belonging to those adapters. Map adapter to files through `runtime.activatedAdapters[].file` and `runtime.skillInstallations[].id`, falling back to `REGISTRY[].files` and `skillDirs`.
   - `agents` owns the canonical section that the overlays point to. Deactivating `agents` while other adapters remain fails with `deactivation preflight failed: agents is required by <ids>; deactivate them too or use --adapters all`.
   - Rewrite `runtime.json` without the removed entries (`activatedAdapters`, `skillInstallations`, `skillShims`, `globalSkillInstallations` for those IDs). Delete it **only when no adapters remain**. Delete `BOOTSTRAP.md` on the same condition, matching full deactivation.
   - The whole operation stays a single snapshot/rollback transaction, as it is today.
   - Global skill deployments are never removed by scoped deactivation. They belong to the user skill home, not the project.
3. **`link remove`** keeps calling the unscoped `deactivateProject`.
4. **Output:** each result line gains `adapter`. `--dry-run` prints the planned results without writing.

### Per-subcommand flag allowlist (#33)

`src/cli.mjs` keeps its single tokenizer: flag spelling and value arity stay global. After parsing it validates the flags against a `COMMAND_FLAGS` table keyed by `command` or `command subcommand`, for example `'link deactivate'` and `'context'`:

```js
const COMMON_FLAGS = ['--root','--data-root','--data-dir','--help','-h','--json','--yes','--confirm','--dry-run']
const COMMAND_FLAGS = {
  'link deactivate': ['--project','--adapters'],
  'link repair':     ['--project','--lens','--secondary-lenses','--activate','--platform','--instructions','--install-skill','--skill-home','--no-activate','--force'],
  'context':         ['--project','--self','--task','--lens','--budget','--manifest','--source','--temporal','--cursor','--include-history','--no-cache','--format','--adapter','--output','--snapshot','--restricted-host','--expires-hours'],
  // …one entry per command/subcommand
}
```

- An entry in the table is enforced: any other flag fails with `option <flag> is not supported by '<command>'; see holoself <command> --help`.
- A command with no entry is not validated during migration. A test asserts that every dispatched command has an entry, so the table cannot drift. The release notes list the commands that became strict.
- `parse` records the raw flag names it saw (`o._flags`). Validation needs the spelling the user typed, not the option key: `--confirm` and `--yes` share a key.

## Ordering and file overlap

Implement #34 before #33. Both change `src/adapters.mjs` (exports near `activeAdapterIds` and `deactivateProject`) and the `link` branch of `src/ecosystem.mjs`. #33 reuses the adapter-ID mapping and the `source` reporting that #34 introduces. Only #33 touches `src/cli.mjs`. Only #34 touches `src/web-server.mjs` and `web/app.mjs`.

## Acceptance tests

- Repair on a project activated with `--activate codex` while Claude files are also present: the plan lists `agents` and `codex` with `source: "recorded"`, and `CLAUDE.md` stays untouched.
- Repair with no `runtime.json` but with active markers: `source: "detected"`, and the plan contains the marker-bearing adapters only.
- Workbench repair: a preview request writes nothing; apply with a stale `plan_hash` returns 409; apply with a matching hash writes.
- `link deactivate --adapters claude` removes the Claude block and skill, keeps AGENTS.md, Codex, and `BOOTSTRAP.md`, and rewrites `runtime.json` without `claude`. A following `--adapters agents,codex` deletes `runtime.json`.
- `link deactivate --adapters agents` with Codex still active fails before any write.
- `link deactivate --adapter claude` fails with an unsupported-option error. `context --adapters x` fails the same way.
- Unscoped `link deactivate` and `link remove` behave as they do on `main`.

## Backward compatibility

Older `runtime.json` files without `activatedAdapters` fall back to `detected`. Unscoped deactivation does not change. The only breaking change is that a flag now fails on a command that previously ignored it silently. The changelog calls this out.
