# Quickstart

> Status: supported from repository checkout. npm registry package is not published yet.

## 1. Get Holoself

```bash
git clone https://github.com/smota/holoself.git
cd holoself
node bin/holoself.mjs --help
```

Node.js 20+ is required.

## 2. Initialize private context

Default location is `~/.holoself`. Override with `HOLOSELF_HOME` or `--data-dir`; CLI option wins.

```bash
node bin/holoself.mjs init --data-dir C:/private/my-self
node bin/holoself.mjs doctor --data-dir C:/private/my-self
node bin/holoself.mjs validate --data-dir C:/private/my-self
```

Inspect files before adding personal information. Do not place private context in this public product repository.

## 3. Add initial context

Edit Markdown under `profile/` and `context/`. Start small: identity, work context, preferences, voice, current projects, and decisions. Optional frontmatter controls visibility.

## 4. Link project metadata

```bash
node bin/holoself.mjs link add --project C:/work/project --self C:/private/my-self --lens general
node bin/holoself.mjs link status --project C:/work/project
```

This creates project `.holoself/link.yaml`, `index/`, `proposals/`, and `reports/`. It does not copy self files.

## 5. Resolve context

```bash
node bin/holoself.mjs context --project C:/work/project --task "plan next milestone" --json
```

Review `sources`, `restrictions`, and `warnings` before using output externally.

Next: [first linked project](first-linked-project.md) and [safety guarantees](../trust/safety-guarantees.md).
