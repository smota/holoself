# External public skill deployments

Status: accepted for implementation and filesystem validation.

## Problem

Skills managers can deploy the public Holoself skill through a directory symlink or Windows junction. Treating every discovered deployment as a managed project write makes diagnostics throw before they can describe the problem. Following any linked path as a managed write could instead modify a shared library. Pi also uses different project and user skill directories.

## Decision

Skill inspection is separate from managed writes. Canonical data, instructions, activation artifacts, and managed installation/removal continue to use their strict containment checks. The OS enforces normal filesystem permissions; inspection neither elevates privileges nor changes ACLs.

Inspection accepts an external deployment only when all these conditions hold:

1. The only linked source component is the terminal `holoself` directory at a known skill location. Its ancestors are regular directories.
2. The link resolves to a real directory. Both the configured target path and its resolved path have no linked ancestors; `SKILL.md` is a regular file with no further links.
3. `SKILL.md` matches the current package's public skill exactly after CRLF/LF normalization. Extra instructions, missing files, legacy shims, and merely compatible managed blocks do not satisfy this external contract.

These deployments report `external: true`, `readOnly: true`, and `full-public-skill-current`. Holoself can inspect them, but never updates, replaces, removes, or cleans them up, including with `--force`. The deployment manager owns changes. This classification proves the inspected public skill artifact; it does not identify the manager, certify arbitrary supporting files, or prove that a host loaded it. Native host discovery still needs a smoke test.

An identical externally managed local deployment does not count as a conflicting override under global policy. It remains visible in `project_skill_deployments`. Modified or unsafe deployments remain degraded and expose a corrective action. Regular local override files retain their existing review requirements. The original `project_skill_overrides` list remains available, with structured details alongside it.

For global policy, selected providers supply the skill: Codex uses `.codex/skills/holoself`, Claude uses `.claude/skills/holoself`, and Pi uses `.pi/agent/skills/holoself`. Generic `AGENTS.md` remains the instruction fallback. A generic-only selection requires `.agents/skills/holoself`; selecting Codex, Claude, or Pi does not also require a separate generic global deployment. Existing runtime records are reconciled by explicit activation or repair.

Pi's project directory stays `.pi/skills/holoself`. Its [configuration source](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/config.ts) defines the default agent directory as `~/.pi/agent`; see also the [skill loader](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/skills.ts) and [skills documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md). The old Holoself user installation at `.pi/skills` is not moved or deleted automatically.

## Validation and limits

Synthetic tests cover current directory deployments, altered and broken targets, linked source/target ancestors, linked `SKILL.md`, strict managed writes and deactivation, provider selection, doctor diagnostics, and target preservation. A linked path with unclear authority remains degraded. The filesystem checks provide bounded synchronous inspection, not a guarantee against arbitrary concurrent hostile filesystem changes. Reinspect after updating the deployment library.

## Related maintenance safety

Reviewed root instruction edits use the explicit `instruction-replacement` plan kind and allow existing `AGENTS.md` or `CLAUDE.md` only. Section replacements keep their existing canonical Markdown scope. Both preserve the digest, stale-byte, receipt, and rollback rules; proposals and receipts remain protected.

Cleanup archives known canonical Markdown from profile, context, topics, reference, and me to `history/<original-path>`. It checks source, destination, root and receipt ancestors before mutation and rollback, shares the authority lock, removes transaction-created directories on recoverable failure, and preserves an existing receipt on replay failure. Empty authority directories may remain. Abrupt process termination still requires inspection and recovery.
