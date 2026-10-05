# Backlog: Holoself consolidation (holoself)

Created 2026-10-03. Local working file: it contains personal paths, so keep it out of commits (see `CONTRIBUTING.md`).

**Goal.** `holoself-sam` holds only Samuel's self: identity, values, voice, thinking, preferences, trajectory, evidence, stories, personal projects, lenses, approved proposals, coaching sources. Domain projects (Nextstep, Move the Needle) read it through a link; `HS` is the only copy. This repo owns the product changes and the `holoself-sam` cleanup. It also owns `WF\godly-life`'s Holoself link and self content, since that folder has no repo.

## Decisions (Samuel, 2026-10-03)

- **Q2** Lens choice lives in the self: `HS\lenses\bindings.json`, keyed by project. A domain's `link.yaml` keeps only path/access/proposals/index.
- **Q10** Rename lenses `career` → `professional` and `publishing` → `public-voice`. All lenses get the same treatment: no native/custom distinction.
- **Q3** General writing and voice notes about Samuel are self (proposals into `HS`). LinkedIn strategy and structure belong to Move the Needle.
- **Q4** Retire the LinkedIn publishing machine (allowlist, validator, gate). The memory-proposal approval flow stays as is.
- **Q6** Holoself indexes only the self. Domain projects index their own files; their `project_context.include` becomes empty.
- **Q8** Coaching PDFs and documents stay in `HS\coaching\`.
- **Q1/Q9** `linkedin-sam` retires into `WF\movetheneedle\channels\linkedin-personal`. The MTN link lives in the data folder `WF\movetheneedle`.

## Cross-repo order

Three agents (holoself, nextstep, movetheneedle) start today in parallel. In each repo, the `-1` item (backup + baseline) runs before any data change in that repo.

| Start now (parallel) | Waits for |
|---|---|
| HS-1, HS-2, HS-3, HS-4, HS-5, HS-7, HS-9, HS-10 | HS-6 ← HS-3 + HS-4 + Samuel's release OK · HS-8 ← HS-7 · HS-11 ← every other item |
| NS-1, NS-2, NS-3, NS-6, NS-8, NS-10 | NS-4 ← HS-5 · NS-5 ← HS-6 · NS-7 ← HS-8 · NS-9 ← NS-8 + Samuel's confirmation |
| MTN-1, MTN-2, MTN-3, MTN-7 | MTN-4 ← HS-5 · MTN-5 ← MTN-4 · MTN-6 ← MTN-2 + MTN-5 · MTN-8 ← MTN-7 + Samuel's confirmation · MTN-9 ← HS-8 · MTN-10 ← HS-6 + MTN-4 |

The same table appears in all three backlogs: `C:\Users\samue\code\{holoself,nextstep,movetheneedle}\docs\backlog\2026-10-03-holoself-consolidation.md`.

## Paths

| Name | Path |
|---|---|
| `WF` | `C:\Users\samue\OneDrive\1._WorkingFolder` |
| `HS` (canonical self) | `WF\holoself-sam` |
| `BK` (backups, outside OneDrive) | `C:\Users\samue\backups\holoself-consolidation-2026-10-03\` |
| `RUN` (baselines, handoffs, reports) | `WF\grok-bot\work\admin-2026-10-03\holoself-consolidation\` |
| Source analysis (pt-BR, IDs L/K/C/P/Q) | `RUN\claude-report.md` |

## Rules

- **Code holds only the application.** Everything under `C:\Users\samue\code` is app code; data, links (`.holoself/`) and generated state live in the OneDrive data folders under `WF`.
- **Canonical self changes go through Holoself.** Use `holoself propose` (Samuel approves) or `holoself knowledge cleanup` (dry-run → plan → apply with `--digest`). Files outside the canonical Markdown (`scripts/`, `tmp/`, `output/`, `coaching/`) can be moved directly.
- **Zip-first.** Before any data move, edit or delete, write a dated zip of what you touch to `BK` (`<repo>-<item>-<yyyyMMdd-HHmm>.zip`) and check it opens. Data folders rely on OneDrive sync, so the zip is the only rollback (Q7: no git in data folders).
- **Samuel confirms every folder deletion** (named in the item). Prepare the evidence, then wait.
- **Verify every item.** Data items are done when V (below) is green; code items when the repo's tests pass. Record the result in `RUN\verification\<item>.txt`.
- Move files in short windows; if OneDrive shows a sync conflict, stop and report it.

### V (standard verification)

```powershell
$HS = 'C:\Users\samue\OneDrive\1._WorkingFolder\holoself-sam'
holoself lens validate --root $HS
holoself validate --root $HS
holoself link status --project <project>; holoself link doctor --project <project>
$c = holoself context --project <project> --self-only --json | ConvertFrom-Json
"$($c.lens) $($c.validation.status) $($c.self.documents.Count)"
```

Green: `validation.status` is `ok`, no `unknown lens` error, `link doctor` reports no `degraded`, and the self document count matches the item's baseline (or differs by exactly what the item removed).

## Items

### HS-1 Backup and baseline
- **Goal:** a restorable starting point for everything this repo touches.
- **Do:** zip `HS` and `WF\godly-life\.holoself` to `BK`. Run V for `WF\nextstep-sam`, `WF\godly-life`, `WF\linkedin-sam` (and `WF\movetheneedle` if a link exists there). Also run `node HS\scripts\validate-publishing.mjs` once. Save all output to `RUN\baseline\hs\`.
- **Done when:** both zips open and list their files; every baseline command's output is saved.
- **Verify:** `RUN\baseline\hs\` has one output file per command and project.
- **Depends on:** none.

### HS-2 Housekeeping in holoself-sam (C16, C17, L10)
- **Goal:** only self material in the self root.
- **Do:** `HS\output\pdf\*` (3 values-coaching PDFs) → `HS\coaching\values-coaching-2026-09-30\`. `HS\.holoself\reports\2026-09-30-values-coaching-v1.md` → same folder. `HS\tmp\` → zip-first delete. `WF\godly-life\.holoself\link.yaml.bak-*` → zip-first delete. Remove the then-empty `HS\output\`.
- **Done when:** `HS\output` and `HS\tmp` are gone; the PDFs and report open from `coaching\`; no `link.yaml.bak-*` left in godly-life.
- **Verify:** V for godly-life; the self document count is unchanged (none of these files are canonical Markdown).
- **Depends on:** HS-1.

### HS-3 Feature: self-side lens bindings (Q2)
- **Goal:** the self decides which lens a project reads.
- **Do (code):** add `<self-root>/lenses/bindings.json` (e.g. `{ "schema_version": 1, "bindings": { "<normalized absolute project path>": { "default_lens": "...", "secondary_lenses": [] } } }`) and a CLI `holoself lens bind|unbind|bindings`. Make `context`, `link status/doctor/repair`, MCP and Workbench resolve the lens from the binding. Drop `default_lens`/`secondary_lenses` from the `link.yaml` schema (`src/ecosystem.mjs` `readLink`/`writeLink`/validation ~L320, ~L2459). `link repair` moves an existing lens choice from `link.yaml` into `bindings.json`. An unbound project fails closed with a message naming `holoself lens bind`. The Workbench catalog discovers spaces from bindings instead of `context/linked-projects.md` (`src/web-server.mjs:24-25`). Keep `binding_salt` separate; it is a different concept. Update `docs/concepts/lenses-and-privacy.md`, `docs/linked-ecosystem.md`, `docs/reference/filesystem-layout.md`, `docs/reference/cli.md`.
- **Done when:** new tests cover bind/unbind, resolution from the binding, repair migration, fail-closed when unbound, and the catalog built from bindings.
- **Verify:** `npm test`; `npm run verify`; on a copy of `HS` plus a scratch project, `link repair` moves the lens into `bindings.json` and `context --self-only` resolves the same lens as before.
- **Depends on:** none. Same files as HS-4: do HS-3 first or on the same branch.

### HS-4 Feature: lens rename and uniform lens model (Q10)
- **Goal:** `professional` and `public-voice` replace `career` and `publishing`. Every lens is defined and treated the same way.
- **Do (code):** in `src/lenses.mjs`, turn `BUILTIN_*` into default lens definitions with the same schema as `<self-root>/lenses/*.json` (seeded on init/migration, overridable). Remove the `source: builtin/registry` split and the reserved-ID rule. Replace `base_lens` with explicit fields. Move behaviour keyed on a lens ID into lens-definition properties: the public-safety filters on `'publishing'` (`src/ecosystem.mjs` ~L616-734, ~L1153-1154, ~L2237-2238) become e.g. `public_safe: true`, and the sensitivity access keyed on `'career'` becomes `sensitivity_access`. Rename the IDs in `src/annotations.mjs` (`VISIBILITIES`), `src/ecosystem.mjs` (~L63-67, ~L515-516, ~L1602, ~L2035), the `src/cli.mjs` init templates (~L33-41) and `src/migration.mjs`. `private` stays owner-exclusive. Add a migration that rewrites `access_lenses`/`visibility` values in a self root through a `knowledge cleanup` plan (digest + receipt) and renames IDs inside `bindings.json`. Update the docs listed in HS-3.
- **Done when:** `rg -n "'career'|'publishing'|\"career\"|\"publishing\"" src` returns only migration code. Tests prove a renamed custom lens with `public_safe: true` gets the same filtering `publishing` had. A dry-run of the migration on a copy of `HS` lists every affected file (about 51 Markdown files mention these IDs).
- **Verify:** `npm test`; `npm run verify`; the dry-run plan on the `HS` copy.
- **Depends on:** none (coordinate with HS-3).

### HS-5 Empty project context (Q6)
- **Goal:** a link can carry no project content at all.
- **Do:** confirm that `project_context.include: []` (and a missing `project_context`) is accepted by `link add/repair/doctor` and that `context --self-only` output is unchanged. Fix and test if not. Document it as the recommended setting in `docs/linked-ecosystem.md`.
- **Done when:** a test covers `include: []`; a note in `RUN\handoff\HS-5.md` states "include: [] supported in version X", which unblocks NS-4 and MTN-4.
- **Verify:** `npm test`; on a scratch project, `context --self-only --json` is byte-identical with and without `include: []` (apart from timestamps).
- **Depends on:** none.

### HS-6 Roll out bindings and rename to the data
- **Goal:** the live self and its projects use `professional`/`public-voice` and self-side bindings.
- **Do:** after Samuel approves the release, install the new build the same way the current global `holoself` is installed (`Get-Command holoself`). Zip `HS` again. Apply the HS-4 migration to `HS` (dry-run → plan → `--apply --digest`). Write `HS\lenses\bindings.json`: `WF\nextstep-sam` → `professional` (secondary `leadership, technical, interview`); `WF\movetheneedle` → `public-voice` (secondary `technical, leadership`); `WF\godly-life` → `spiritual`. Run `holoself link repair` for godly-life (refreshes its `runtime.json` from toolVersion 0.6.0). Regenerate `HS\ui\catalog.json` from the Workbench. Write `RUN\handoff\HS-6.md` stating that bindings are live, which unblocks NS-5 and MTN-10.
- **Done when:** `bindings.json` holds the three projects; the migration receipt exists in `HS`.
- **Verify:** V is green for nextstep-sam, godly-life and movetheneedle (if linked), with lens names `professional`/`public-voice`/`spiritual`. `rg -l "\b(career|publishing)\b" HS -g "*.md" -g "!proposals/**"` shows no lens/visibility values. `catalog.json` has no `C:\Users\samue\work\` paths.
- **Depends on:** HS-3, HS-4, Samuel's release OK.

### HS-7 Retire the domain registry and template residue (C1, C2, C6, C7, C18, C19)
- **Goal:** no record of domains, and no PersonalOS template noise, in the canonical self.
- **Do:** one `knowledge cleanup` plan that retires `context/linked-projects.md`, `context/insights/from-job-search.md` and `context/insights/from-social.md`; removes the "job-search skill"/"social skill"/`personal/me/<skill>` references from `context/admin.md`, `people.md`, `decisions.md`, `projects.md` and `reference/README.md`; and keeps one copy of `reference/**` vs `contribs/default/**` (keep `contribs/default`). Then refresh `ui/catalog.json` (fully regenerated in HS-6).
- **Done when:** the cleanup receipt exists in `HS`; `rg -n "linked-projects.md|job-search skill|social skill" HS -g "!proposals/**" -g "!.holoself/**"` is empty.
- **Verify:** V. The document count drops by exactly the retired files.
- **Depends on:** HS-1.

### HS-8 Remove domain content from canonical sections (C3-C5, C8-C11, C13-C15)
- **Goal:** canonical files describe Samuel, not Nextstep or LinkedIn operations.
- **Do:** per file, one proposal or cleanup plan (use `knowledge_status: historical`/`superseded` plus a clean replacement where section removal is unsupported):
  - `context/career.md`: move out Interview Q&A Templates, Opening Architecture, ATS Keyword Bank, Job Search Working Memory/Patterns, and Country-Specific Application Norms (keep PREFERENCE-GEOGRAPHIC-MOBILITY-001). From "LinkedIn Confirmed Assets", keep the confirmed headline and move the LinkedIn rules and paths out.
  - `profile/work-context.md`: keep "what I do and why". Move the LinkedIn/career focus, Active Projects paths and progress metrics out.
  - `profile/voice.md`: drop the LinkedIn-Assistant ownership text and keep one durable line on public professional writing.
  - `context/positioning.md`: drop the ownership boundary.
  - `context/publishing.md`: keep durable intent and quality standard; move the boundary list out.
  - `context/public-disclosure.md`: rename "LinkedIn-project" to "domain projects".
  - `context/evidence.md`: drop the EVIDENCE-LINKEDIN-* boundary lines and mark `C:/Cowork/...` paths historical.
  - `context/claims.md`: neutral wording for usage phrasing (low priority).
  
  Write each removed text verbatim to `RUN\handoff\nextstep\` (job search, application norms, career metrics) or `RUN\handoff\mtn\` (LinkedIn rules, audience/publishing metrics, ownership boundaries), with a `MANIFEST.md` giving source file, section and suggested destination.
- **Done when:** every C-item above has an applied receipt, an approved proposal, or a pending proposal listed in `RUN\handoff\HS-8.md`; both handoff folders have a manifest; `rg -n "C:/Cowork|LinkedIn Assistant|Career Assistant" HS\profile HS\context` returns only lines marked historical.
- **Verify:** V; claims and stories are still counted (`holoself validate`).
- **Depends on:** HS-7. Unblocks NS-7 and MTN-9.

### HS-9 Retire the publishing machine in holoself-sam (Q4, C12)
- **Goal:** no LinkedIn publishing gate in the self. The proposal approval flow stays as is.
- **Do:** zip-first delete `HS\scripts\validate-publishing.mjs` (and `scripts\` if empty). Remove the publishing-gate paragraph from `HS\AGENTS.md`. Retire `context/publishing-eligibility.md` through `knowledge cleanup`. In `code\holoself`, remove product docs that present the eligibility allowlist as a gate (`docs/linked-ecosystem.md`, `docs/guides/adoption-and-rollback-runbook.md`, `docs/README.md`). Keep per-document `publication_allowed` metadata, which the public-voice lens filters use.
- **Done when:** `rg -n "validate-publishing|publishing-eligibility" HS code\holoself\docs -g "!proposals/**"` returns only historical/receipt lines.
- **Verify:** V.
- **Depends on:** HS-1. Run cleanup plans one at a time with HS-7/HS-8 (each plan is digest-bound).

### HS-10 Self knowledge from godly-life (K12)
- **Goal:** Samuel's personal projects and preference summary live in the self.
- **Do:** compare the "Me/Preferences/Projects" block in `WF\godly-life\CLAUDE.md` and `memory\glossary.md` with `HS`. Propose what is missing: Tapioca/Gate4EU, AI workstation and Find The Needle OS → `context/projects.md`; any preference summary → `profile/preferences.md`. After Samuel approves, zip and replace that block in `godly-life\CLAUDE.md` with a pointer to Holoself context. Zip-first delete `CLAUDE.md.bak-productivity`.
- **Done when:** proposals are approved or rejected by Samuel; `godly-life\CLAUDE.md` holds a pointer instead of the self portrait.
- **Verify:** V for godly-life; `holoself context --project WF\godly-life --self-only --json` includes the new projects.
- **Depends on:** HS-1 (pointer edit waits for Samuel's approval).

### HS-11 Close-out
- **Goal:** evidence that the consolidation is complete.
- **Do:** rerun the HS-1 baseline set for every linked project. Diff it against `RUN\baseline\`. Write `RUN\final-report.md`: per item ID across HS/NS/MTN, its status, receipts and leftovers.
- **Done when:** every HS/NS/MTN item is done or explicitly deferred by Samuel; no `unknown lens` error; every `.holoself\link.yaml` sits under `WF`.
- **Verify:** `Get-ChildItem C:\Users\samue\code -Recurse -Depth 2 -Force -Filter .holoself` finds nothing outside the holoself repo's own test fixtures.
- **Depends on:** all other HS, NS and MTN items.

## Open questions for Samuel

Until he answers, the default in brackets applies.

1. Three LinkedIn folders exist in MTN data: `channels\linkedin-personal` (workspace and history), `knowledge\company\channels\linkedin-personal` (channel profile, editorial guidelines) and `knowledge\company\content\channels\linkedin-personal` (README only). Merge them? [Keep all three; strategy and structure files go to `channels\linkedin-personal\Context\`.]
2. Under Q10, does `private` stay an owner-exclusive special lens? [Yes.]
3. Does `public-voice` keep the public-safety filters `publishing` has today (compensation redaction, `publication_allowed`)? [Yes, as lens-definition properties.]
4. `WF\nextstep-sam\.holoself\proposals\` includes approved proposal 63110f2e with compensation data in plain text. Keep it? [Keep; it is the project-side proposal record.]
5. The grok-bot briefings (`WF\grok-bot\briefings\escritor.txt`, `linkedin.txt`) point to `linkedin-sam`. They sit outside these three repos: who repoints them before MTN-8? [Samuel or the grok-bot admin agent.]
6. Version number for the Holoself release that carries HS-3/HS-4, and who installs it globally? [Samuel approves; HS agent installs in HS-6.]

## Samuel's answers to the open questions (3 Oct 2026, 18:26) - these win over the defaults above

1. linkedin-personal: merge the three folders into one. linkedin-sam holds the most recent LinkedIn work and holoself-sam the most recent knowledge about Samuel; when versions conflict, prefer those.
2. Lens `private`: leave it as it is for now (the owner is always the operator).
3. Lens `public-voice`: keep it simple; do NOT carry over the publishing safety filters (compensation, publication_allowed). Refine later only when needed.
4. Compensation data may stay in the data folders (including proposal 63110f2e); security is handled by the machine and folder, not by Holoself. No special handling.
5. Bot briefings (grok-bot) that point to linkedin-sam: Miles updates them after MTN-8 is done and Samuel confirms. Not part of this backlog.
6. Holoself release: the next version, after the whole backlog runs in one go.
