# Quickstart

> Status: supported through the `holoself-ai` npm package and from a repository checkout.

Outcome: in about ten minutes you will have a private local self root, a healthy validation result, an optional visual Workbench, and one project that can request bounded context. Commands below are safe to rerun unless they explicitly ask for confirmation.

## 1. Get Holoself

```bash
npm install --global holoself-ai
holoself --help
```

Node.js 20+ is required.

This guide uses the installed `holoself` package bin. To evaluate or develop from a repository checkout instead, clone the repository and replace `holoself` with `node bin/holoself.mjs`; see [CLI invocation](../reference/cli.md#invocation).

## 2. Initialize private context

Default location is `~/.holoself`. Override with `HOLOSELF_HOME` or `--data-dir`; CLI option wins.

```bash
holoself init --data-dir C:/private/my-self
holoself doctor --data-dir C:/private/my-self
holoself validate --data-dir C:/private/my-self
```

Inspect files before adding personal information. Do not place private context in this public product repository.

## 3. Add initial context

Open the generated Markdown under `profile/` and `context/`. Start with only two files:

- `profile/identity.md`: a short description of who you are and the stable facts an assistant repeatedly needs;
- `profile/preferences.md`: how you prefer an assistant to work, communicate, and handle uncertainty.

Keep the generated frontmatter in place. Add one or two paragraphs beneath the headings, save, then verify again:

```bash
holoself validate --data-dir C:/private/my-self
```

Add career, leadership, technical, publishing, or other context later when a real use case needs it. Small, current, reviewed context is more useful than importing everything at once.

## 4. See it in Workbench (optional)

```bash
holoself web --root C:/private/my-self
```

Workbench opens locally. On **Overview**, confirm the canonical root is ready. Use **Knowledge** to browse the starter files and **Setup** to inspect detected local tools. Stop the server with Ctrl+C. Workbench is optional; it does not replace the Markdown files or CLI.

## 5. Link one project

```bash
holoself link add --project C:/work/project --self C:/private/my-self --lens general
holoself link status --project C:/work/project
```

This creates project `.holoself/link.yaml`, `index/`, `proposals/`, and `reports/`. It does not copy self files.

## 6. Resolve context

```bash
holoself context --project C:/work/project --task "plan next milestone" --json
```

Review `sources`, `restrictions`, and `warnings` before using output externally.

You are done when `validate` passes, `link status` reports the intended self root and lens, and the context result contains only sources you expected.

Next: [common use cases](../guides/common-use-cases.md), [first linked project](first-linked-project.md), or [safety guarantees](../trust/safety-guarantees.md).
