Implemented direct data-root usage and deterministic loading.

Changed files:
- `src/cli.mjs`
- `templates/AGENTS.md`
- `package.json`
- `skills/holoself/SKILL.md`
- `docs/architecture.md`
- `docs/usage.md`
- `tests/cli.test.mjs`

Validation:
- `npm test` passed: 15/15
- Package audit passed
- `npm pack --dry-run` passed
- `git diff --check` passed
- No staged files
- `.pi/` remains pre-existing untracked