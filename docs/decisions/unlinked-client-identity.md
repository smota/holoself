# Unlinked client identity for MCP clients without a project

Status: Accepted (2026-11-04). The owner delegated this decision to the review-program build session. Implementation is tracked separately. Issue: #66 (parent #48).

## Context

`holoself mcp` binds one linked project when it starts. The binding comes from `--project`, Claude Code's `CLAUDE_PROJECT_DIR`, or an unambiguous current directory ([local MCP architecture](local-mcp-architecture.md)). `resolveCaller` (`src/retrieval/caller.mjs`) knows two identities:

- `client:linked`: a project with a safe `.holoself/link.yaml`. The project is attested in `<self>/.holoself/links.json` (`binding_salt`, `status`, `allowed_lenses`) and bound to lenses in `<self>/lenses/bindings.json`.
- `owner:direct`: the owner working inside the self root through the CLI. This identity has every lens, including `private`.

Any other MCP or web caller fails with `LINK_REQUIRED`. A caller-supplied identity fails with `IDENTITY_NOT_ACCEPTED_FROM_CALLER`.

Desktop and sandboxed clients have no project directory. Examples are Claude Desktop, ChatGPT-style desktop apps and other app-hosted MCP clients. Today the docs send these clients to manual configuration or a reviewed snapshot ([runtime adapters](../guides/runtime-adapters.md), [activated links](../guides/activated-links.md)). They are the largest MCP audience. Serving them needs a third identity, and that changes the authority model. The decision must answer three questions:

1. Where does a desktop client's attestation live, and how is it rotated and revoked?
2. Can a client create proposals without a source project, and with what provenance?
3. How does the host select the identity without trusting caller input?

## Decision

Commands below are planned and not yet in the CLI, so they are written without the `holoself` prefix. For example, `client add` stands for the `client add` subcommand of the `holoself` CLI.

Add a third caller identity, `client:unlinked`. The owner creates it in the self root. It is bound to exactly one lens when the server starts, and it reads only self content. The rest of this section defines it.

### 1. Identity: a self-side client registry

The owner creates each identity explicitly. It lives in `<self>/.holoself/clients.json`:

```json
{
  "schema_version": 1,
  "clients": [
    {
      "client_id": "6f1c2a0e-4d0b-4f7e-9a51-2a8d3b1e9c47",
      "name": "claude-desktop-laptop",
      "lens": "professional",
      "status": "active",
      "proposals": "disabled",
      "created_at": "2026-11-04T10:00:00.000Z",
      "revoked_at": null
    }
  ]
}
```

- **Fields.**
  - `client_id`: a random UUID v4 created by Holoself. It is never chosen by the user or the client.
  - `name`: a unique label made of lowercase letters, digits and hyphens, at most 64 characters.
  - `lens`: exactly one lens ID.
  - `status`: `active` or `revoked`.
  - `proposals`: `disabled` (the default) or `inbox`.
  - `created_at` and `revoked_at`: ISO 8601 UTC timestamps.

  Unknown fields, duplicate IDs or names, and a wrong `schema_version` fail closed (`CLIENT_REGISTRY_SCHEMA_INVALID`), as `links.json` does.
- **Lens rule.** A client lens must exist in the lens registry, must not be `private`, and its `sensitivity_access` must not include `restricted`. `client add` checks this, and the server checks it again on every call, because the owner can edit a lens definition after the client exists. One lens, not a default plus secondary lenses, because a desktop chat has no task boundary like a project's. The owner decides once what that app may see. A client that needs a wider view gets a second identity that the owner configures deliberately. It never gets a lens switch that the model can choose.
- **Same storage discipline as `links.json`.** The file is schema-versioned. Every write is atomic, checks the base hash (`CLIENT_REGISTRY_CONCURRENT_MODIFICATION`) and runs under the existing registry lock (`withRegistryLock`, `.holoself/links.json.lock`). One lock serialises link and client changes, so a cross-check never sees half of an operation. Examples: `lens remove` refusing a lens that a client still uses, or a `link approve` that runs at the same time as `client add`. The self-root `.holoself/.gitignore` written by the served-context ledger (#65) adds `clients.json*`. The file is local operational state, like `links.json`.
- **Separate file.** The registry is not stored in `links.json` or `bindings.json`. Link entries are keyed by `project_id` and project path, carry a `binding_salt` that must match a project-side `link.yaml`, and are sorted and validated as projects. Bindings are keyed by absolute project paths. Putting clients in either file would require nullable project fields and branches in every existing validator. A separate file keeps both schemas unchanged and keeps the client rules in one place.
- **CLI.** The owner manages clients from the self root:
  - `client add --name <n> --lens <id> [--proposals inbox]` prints the new `client_id`.
  - `client list [--json]` shows ID, name, lens, status, proposal mode and dates.
  - `client revoke <id|name>` sets `status: revoked` and `revoked_at`.
  - `client remove <id|name>` deletes the entry. It refuses an `active` client, so the owner must revoke first.

  Revoked entries stay listed until removed. That keeps served-context ledger entries and inbox proposals attributable. A removed UUID is never reused, because a new one is generated each time. The lens and proposal mode are not editable. To change either, add a new client, reconfigure the host and revoke the old client. One ID then always means one grant, and the ledger cannot attribute two grants to the same ID. Workbench management can come later and uses the same functions.

### 2. Binding: fixed at server start, attested on every call

- **The launch command selects the identity.** The command is `mcp --client <client_id> --root <absolute-self-root>`. The owner writes it into the host's MCP configuration with `holoself mcp configure` (section 5) or by hand. Tool arguments never select or change the identity. MCP tool schemas gain no identity, root or lens-switch field, and `resolveCaller` still rejects `identity` with `IDENTITY_NOT_ACCEPTED_FROM_CALLER`. This is the same pattern as project binding at startup: the configuration that launches the process is owner-controlled, and the conversation is not.
- **Self root.** The configured command carries the absolute self root because a GUI app's working directory and environment are arbitrary. Without `--root`, the server uses `HOLOSELF_HOME` or `~/.holoself`. The root must be a canonical self layout, must not be a symlink, and must contain an active entry for the client.
- **No mixed bindings.** `--client` with `--project` fails with `CLIENT_BINDING_CONFLICT`. So does `--client` with a non-empty `CLAUDE_PROJECT_DIR`. A host that has a project uses the link, which gives it project content and project-scoped proposals. Client mode never discovers a link from the current directory.
- **Attestation on every call.** Each tool call re-reads `clients.json` and the lens definition. It refuses `CLIENT_REVOKED` for a revoked entry, `CLIENT_UNKNOWN` for a missing entry, and `CLIENT_LENS_INVALID` for a lens that is missing, private or grants `restricted`. Revocation therefore takes effect on the next call without restarting the desktop app or editing its configuration. A server that starts for an unknown or revoked client exits with the same codes. The main thread re-reads the file when it receives each call, as the worker pool already allows. The cost is one small file read per call.
- **The client ID is not a secret.** The design states this limitation plainly:
  - Holoself's threat model is one local user. The client ID is stored in the host's configuration file and in `clients.json`. Both belong to the same OS user.
  - Any process running as that user can already read the self root directly, so it can read more than any client grant would give it.
  - A secret token therefore adds no authentication between local processes. A process that can read the token can read the data it protects.
  - The boundary this design enforces is **least privilege per host**. Each desktop app gets the context of one owner-chosen lens through the Holoself tools, never `private` or `restricted` material. Every grant can be audited and revoked separately.
  - The design does not stop a local process from claiming another client's ID. It does not protect against a host that already has unrestricted filesystem access. [Safety guarantees](../trust/safety-guarantees.md) states the same limit for every surface.
- **`clientInfo.name` is descriptive only.** The MCP `initialize` handshake sends `clientInfo.name`, which the client chooses. It is recorded as `host` in the ledger and is never used to make an authority decision.

### 3. Scope: self-only, one lens, same core

- **No project at all.** A client gets no project content, no project partition or index, no `link.yaml` and no `runtime.json`. `resolveCaller` returns `{ kind: 'client:unlinked', project: null, self, client_id, allowedLenses: new Set([lens]) }`. The subject is `{ space_id: 'self', accessible_spaces: ['self'] }`. `contrib` is excluded, because private extensions are owner material and no client needs them for the issue's use case.
- **Lens.** A tool call may omit `lens` or pass the bound lens. Any other value fails with `LENS_NOT_GRANTED`, including `private`. `resolveLensAuthority` gains a `client:unlinked` branch that does this check. `private` and `restricted` cannot be reached in two ways: the registry refuses them when it writes, and the server refuses them on every call. The access policy also keeps `restricted` for direct-owner `private` reads (`src/policy/access.mjs`).
- **Same retrieval core.** Calls use the same deterministic context selection, self index, budgets, 512 KiB envelope cap, absolute-path stripping, source handles and context receipts as linked MCP. Client mode adds no second implementation.
- **Tools.** These tools are listed: `holoself_status`, `holoself_context`, `holoself_context_manifest`, `holoself_context_get` and `holoself_search`. `holoself_status` reports `identity: client:unlinked`, the client name, its lens and its proposal mode. It does not report the self path. `holoself_proposal_create` and `holoself_proposal_preview` are listed only when the client's proposal mode is `inbox` at startup. The server still checks the mode on every call (`CLIENT_PROPOSALS_DISABLED`). A newly enabled mode appears after the host restarts the server, and a newly disabled mode applies at once.
- **Ledger.** Successful context calls write served-context ledger (#65) entries to `<self>/.holoself/ledger.ndjson` with `surface: "mcp"` and an additional `client_id` field. All other ledger rules stay the same: metadata and handles only, task stored as an HMAC, no bodies or paths. `ledger --root <self> --client <id>` filters by client. The owner can therefore answer "what did Claude Desktop see" for each grant.

### 4. Proposals: off by default, inbox when enabled

- **Default `disabled`.** A desktop chat takes in untrusted text: web pages, pasted documents, other connected MCP servers. Prompt injection can tell the model to "remember" false facts or to ask for the profile. A project-scoped agent writes proposals into a project the owner is working in and reviews. A desktop chat has no such review context, and injected content reaches it more easily. Proposal creation is therefore off unless the owner opts in for that client.
- **Opt-in `inbox`.** With `--proposals inbox`, `holoself_proposal_create` writes a pending proposal to `<self>/proposals/inbox/`. The inbox is separate from `proposals/pending/` because the existing pending validator requires a `source_project` that matches a linked project (`src/proposals/store.mjs`). [ADR E05](evidence-05-proposals.md) has the same concern: records that look ordinary but have different validation must not enter the queue a legacy approver reads. Inbox records:
  - carry `origin: { kind: "client", client_id }` and `provenance: ["client:<client_id>"]`, with no `source_project`, `source_project_path` or `source_files`. There is no project to cite.
  - **require** `evidence` text, 1–4,000 characters. This text is the only basis the reviewer has, so a proposal without it fails with `EVIDENCE_REQUIRED`. Secret-like content is rejected using the same patterns as the index.
  - may only append claims to an existing canonical document that the client's lens can read. A client cannot create new files. Any other target fails with the same `PROPOSAL_TARGET_INVALID` error whether or not the target exists, so the tool cannot be used to probe for hidden documents.
  - are capped at 50 pending inbox proposals per client (`CLIENT_INBOX_FULL`). This limits flooding from an injected loop.
- **Approval stays with the owner.** Approval happens only through the CLI or Workbench: `proposals list|show|approve|reject --root <self> --inbox`. The same exact-preview hash, transactional apply, receipts and archive states are used. Proposals are never approved automatically, and MCP never gains an approval tool. Review shows the client name and its current status. A proposal from a client revoked after it was written can still be reviewed or rejected. Revocation only stops new writes.
- **Writes run alone.** The worker pool already runs `holoself_proposal_create` exclusively. It keeps the same never-terminated write semantics in client mode.

### 5. Host configuration

- **Print by default.** `mcp configure --client <id> --platform <claude-desktop|generic>` prints the exact configuration snippet: the server key `holoself`, an absolute command path and arguments `["mcp", "--client", "<id>", "--root", "<self>"]`. The command path is absolute because GUI apps on macOS and Windows do not inherit the shell `PATH`. The command writes nothing. `generic` prints only the command and arguments for any STDIO host. Printing is the default because this is the only place Holoself would write outside a project or self root.
- **`--apply` edits the host's user-level file, with these limits:**
  - **Known locations only.** It writes only the documented user-level configuration path for a platform whose MCP support is `verified` in [platform verification](../reference/platform-verification.md). For Claude Desktop that is `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS and `%APPDATA%\Claude\claude_desktop_config.json` on Windows. Other platforms remain print-only until verified natively.
  - **Preview.** The preview shows the file path, the current SHA-256, the action and the exact Holoself entry. It never prints the rest of the file, which may hold other servers' environment secrets. Apply recomputes the plan and refuses if `plan_sha256` changed, the same contract as `--all-detected`.
  - **Consent.** It requires `--yes` or confirmation in a terminal. A non-interactive run without `--yes` writes nothing.
  - **Collision refusal.** An existing `holoself` entry that differs is refused. Only `--force-replace` with explicit confirmation replaces it, matching existing `mcp configure`. Unparseable JSON is never rewritten.
  - **Backup.** Before writing, Holoself copies the original file to `<file>.holoself-backup-<UTC timestamp>` next to it, with the original's mode. If the original is group- or world-readable, the backup is created with mode `0600`.
  - **Filesystem safety.** It refuses a symlink at the file or on any path segment below the user's home or app-data boundary (`assertNoLinkBelow`), and a file with more than one hard link. It preserves the file mode and writes atomically. If the write fails, the file is restored from memory.
  - **Removal.** `--remove` deletes only the Holoself entry, under the same rules.

  Holoself records nothing about the host file. Instead, `mcp status --client <id>` reads the host file to report `client_state`. Revocation does not edit host files. Per-call attestation makes a stale entry harmless: every call fails with `CLIENT_REVOKED`.

### 6. Answers to the open questions

| Question | Answer |
|---|---|
| Where does attestation live; how is it rotated or revoked? | In the self-owned `<self>/.holoself/clients.json`, written under the registry lock and checked on every call. `client revoke` takes effect on the next call. Rotation means adding a new client, reconfiguring the host and revoking the old one. IDs are never edited or reused. |
| Proposals without a source project? Provenance? | Disabled by default. When the owner opts in, proposals go to `<self>/proposals/inbox/` with provenance `client:<client_id>` and required evidence text. Only the owner approves them, through the CLI or Workbench. |
| How does the host select the identity without trusting caller input? | Through `--client <id>` in the launch command, which the owner writes into the host's configuration. Tool arguments carry no identity, and `IDENTITY_NOT_ACCEPTED_FROM_CALLER` still applies. `clientInfo.name` is descriptive only. |

## Alternatives considered

- **(a) Status quo: reviewed snapshots only.** Rejected as the main path. Snapshots are static, eager and refreshed by hand, so a desktop client loses on-demand retrieval, budgets and receipts. **Kept as the fallback** for clients without MCP support and for anyone who does not want a live grant.
- **(b) Owner-direct MCP for desktop clients.** Rejected. `owner:direct` grants every lens, including `private` and `restricted` material. It would give a desktop app with network access the owner's full authority.
- **(c) A pseudo-project directory per client.** Rejected. Creating an empty linked project for each app would reuse the link machinery, but it brings back project semantics: project partition, `runtime.json`, adapters, BOOTSTRAP and `source_project` provenance. It also ties the identity to a directory that the app never opens, and moving or deleting that directory would break or orphan the grant.
- **(d) HTTP or remote MCP with tokens.** Rejected by the [local MCP architecture](local-mcp-architecture.md): no listener, daemon, port or network surface. Desktop hosts that support local STDIO do not need one.
- **(e) Client tokens that carry a secret.** Rejected for now. A token gives no security against processes running as the same user, which can read the token and the self root alike. It would also require secret storage, rotation and redaction in host files, logs and backups. Revisit this only if Holoself ever serves several OS users or a remote transport.

## Consequences

- Desktop MCP clients get typed, on-demand, lens-bounded self context with receipts and ledger entries, without a project. The grant is explicit, can be audited per host, and can be revoked without restarting the client.
- The authority model gains a third identity kind. Every `switch (identity.kind)` must handle `client:unlinked` or fail closed. The existing `default` branch already throws `UNRECOGNIZED_IDENTITY`.
- Holoself gains its first write outside a project or self root: the host's user-level configuration, only through `--apply` with explicit consent. The default stays print-only.
- The design accepts that same-user processes can impersonate a client ID. This is documented in the threat model and safety guarantees, not hidden.
- Lens removal and lens edits now also check client grants.

## Migration

Nothing changes for existing data. `clients.json` is absent until the first `client add`, and an absent file reads as an empty registry, the same rule as `links.json`. Project links, bindings, `link.yaml` and existing proposal queues are untouched. Older Holoself versions ignore `clients.json` and reject `--client` as an unknown option, so they fail closed.

## Implementation acceptance criteria

- [ ] `src/clients/registry.mjs` (or an equivalent module) reads and writes `<self>/.holoself/clients.json` (schema 1, fields above) through `withRegistryLock`, atomic writes and base-hash concurrency checks. A missing file reads as empty. Malformed JSON, the wrong schema, unknown fields and duplicate IDs or names fail closed.
- [ ] `client add|list|revoke|remove` behave as specified. `add` rejects a lens that is missing, is `private` or grants `restricted`. `remove` refuses an active client. `lens remove` refuses a lens used by any client entry that has not been removed.
- [ ] `mcp --client <id> [--root <self>]` starts without a project. It refuses `--project` or `CLAUDE_PROJECT_DIR` alongside `--client` (`CLIENT_BINDING_CONFLICT`), and an unknown or revoked client at startup.
- [ ] `resolveCaller` and `resolveLensAuthority` support `client:unlinked`. A call with a non-bound lens returns `LENS_NOT_GRANTED`, and a caller-supplied `identity` still returns `IDENTITY_NOT_ACCEPTED_FROM_CALLER`. MCP tool input schemas have no identity or root field.
- [ ] Per-call attestation: revoking a client, or editing its lens to grant `restricted`, makes the next call on the running server fail (`CLIENT_REVOKED`, `CLIENT_LENS_INVALID`) without a restart.
- [ ] Retrieval parity: for the same self fixture, lens, task and budget, a client-mode packet equals a linked packet's self portion (same handles, hashes, envelope caps and path stripping). No project document, `private` document or `restricted` material appears under any input.
- [ ] Ledger: successful client context calls append one entry with `surface: "mcp"` and `client_id` under the self root. Failed, cancelled and status calls append none. `ledger --client` filters correctly.
- [ ] Proposals: tools are absent and refused when `disabled`. In `inbox` mode the server writes only under `<self>/proposals/inbox/`, enforces provenance `client:<id>`, required and bounded evidence, lens-visible existing targets with a uniform error, secret rejection and the 50-item cap. CLI and Workbench approval uses the existing preview hash and transaction. No MCP path approves.
- [ ] `mcp configure --client` prints by default and writes nothing. `--apply` enforces the verified platform, preview hash, `--yes`, collision refusal, backup with safe mode, symlink and hard-link refusal, mode preservation, atomic write and rollback. `--remove` removes only the Holoself entry. Tests use a temporary home or app-data directory and never touch the real user configuration.
- [ ] Docs: [local MCP guide](../guides/local-mcp.md), [MCP tools](../reference/mcp-tools.md), [CLI](../reference/cli.md), [filesystem layout](../reference/filesystem-layout.md), [safety guarantees](../trust/safety-guarantees.md) and [runtime adapters](../guides/runtime-adapters.md) describe client mode and its limits. Claude Desktop moves from print-only to `--apply` only after a native verification record.
