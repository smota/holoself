# Workbench guided tour

Holoself Workbench is a local visual layer over the same Markdown, link, lens, proposal, and connector contracts used by the CLI. It is optional: closing it does not remove your knowledge or project links.

## Launch it

From the Holoself source repository:

```bash
node bin/holoself.mjs web --root C:/private/my-self
```

Or with the installed CLI:

```bash
holoself web --root C:/private/my-self
```

Add `--project C:/work/my-project` when launching from a linked project. The project must resolve to the same canonical root. Workbench listens only on `127.0.0.1`; stop it with Ctrl+C.

## Read the status first

The status in the upper-right describes the launch context:

- `Canonical root · Ready` means Workbench was opened directly against the self root.
- `Linked project · Ready` means it was launched with a verified project link.
- A warning or degraded space is actionable state, not a cosmetic badge. Read the finding before editing knowledge or launching a connector.

## Tour the seven areas

| Area | Start here when you want to |
|---|---|
| [Overview](overview.md) | Confirm readiness and choose the next action |
| [Spaces](spaces.md) | Link a project, inspect bounded context, or repair link health |
| [Lenses](lenses.md) | Understand or refine what a project may receive |
| [Knowledge](knowledge.md) | Browse or safely edit canonical Markdown |
| [Review](review.md) | Decide whether project evidence becomes reusable self knowledge |
| [Conversations](conversations.md) | Run a context-aware turn through a detected local CLI |
| [Setup](setup.md) | Inspect connector detection or add a root-owned connector extension |

The normal operating loop is **Self → Lens → Project → Proposal → Human approval**. Start with Overview, verify a Space and its Lens, preview context, and use Review only for durable knowledge changes.

> Screenshot note: the guide uses a real local canonical root captured on 2026-09-01. Counts, paths, connector availability, custom lenses, and health states are machine-specific and will differ on another installation. The screenshots avoid document bodies and conversation output.

For security properties and storage boundaries, see [Workbench architecture](../web-gui.md#architecture-and-trust-boundary).
