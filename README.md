# Holoself

Holoself is a local, reviewable self-context layer for AI tools. Your data stays in a private data root; public defaults and the `skills/holoself/SKILL.md` instruction are separate.

## Install and start

```bash
npm install -g holoself-ai
holoself init
holoself doctor
holoself validate
```

Find or override storage with `holoself data-root` or `--root <path>`. Public contrib defaults ship with Holoself and are available by default. Select or exclude them explicitly:

```bash
holoself init --contribs communication
holoself init --exclude-contrib communication
```

Private contribs belong only in `<data-root>/contribs/local/` and are never copied into this repository or published package.

## Commands

- `init`, `doctor`, `validate`: create and check local data.
- `migrate --from <PersonalOS>`: copy personal data after confirmation; source remains untouched.
- `export --target <project>`: write a project packet. Add `--root-setup` for explicit confirmation before bounded marker injection.
- `link` / `unlink`: manage a clearly-owned `.holoself` junction or symlink.
- `upgrade`: refresh shipped public defaults without touching profile/context.

Exported `.holoself` content is private by default. Review before committing. No command sends data, publishes npm, or deploys a site.

## Development

```bash
npm test
node bin/holoself.mjs --help
```

See [PRIVACY.md](PRIVACY.md), [docs/architecture.md](docs/architecture.md), and [docs/migration.md](docs/migration.md). Public contribs are catalogued in [`contribs/catalog.json`](contribs/catalog.json); shipped defaults are synthetic/public only. Private reference, me extensions, profile, context, topics, and notes stay in the local data root.
