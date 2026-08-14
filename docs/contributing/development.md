# Development

Requirements: Node.js 20+.

```bash
npm test
npm run audit:package
node bin/holoself.mjs --help
```

Design constraints:

- no private data in package paths;
- Markdown remains source of truth;
- linked-project writes remain within project `.holoself` except explicitly approved canonical proposal targets;
- mutations require clear confirmation and atomic writes;
- new commands need positive, negative, privacy, and path-safety tests;
- documentation examples must match current parser and help output.

Before contributing, run `git diff --check` and inspect `npm pack --dry-run` or package audit output.
