# Safety guarantees and limits

## Enforced by CLI

- No publication actions; optional [operation telemetry](../guides/telemetry.md) uses loopback HTTP only and stays off without a valid local consumer configuration
- No automatic deletion or relocation of project artifacts
- Read-only project links
- Explicit confirmation for canonical proposal approval
- Provenance validation on proposals
- Canonical target containment and relative source-path checks
- Recognized secret-like filenames and content patterns excluded from context/index output
- Invalid visibility, malformed link YAML, unsafe paths, and unknown options fail closed
- Indexes remain disposable and Markdown canonical
- MCP is local STDIO only, binds one linked project at startup, and has no listener; optional operation telemetry uses the same loopback-only consumer configuration
- MCP tools accept no project/self roots and expose no raw canonical resources
- MCP proposal creation writes only project-local pending review; approval and canonical writes are absent
- MCP output is bounded and strips absolute self/project paths
- A desktop MCP client without a project (`holoself mcp --client <client-id>`) is bound at launch to one owner-created grant with exactly one lens that is never `private` and cannot grant `restricted`; it reads self content only, is re-attested on every call (revocation needs no restart), and its context calls are recorded in the served-context ledger with its `client_id`
- Desktop client proposals are disabled by default; the opt-in inbox requires evidence, appends only to lens-visible documents, is capped at 50 pending per client, and is approved only by the owner outside MCP
- `holoself mcp configure --client <client-id>` prints by default; writing a host's user-level configuration needs a verified platform, a preview hash, explicit consent, a backup, and refuses collisions, symlinks and hard links

## User responsibilities

- Keep self root and project `.holoself` private
- Review context output before external use
- Verify claims and evidence
- Configure visibility and sensitivity accurately
- Protect filesystem access, backups, and sync providers
- Understand that pattern-based secret detection cannot identify every secret

Holoself reduces disclosure risk; it cannot guarantee safe publication or defend against a tool already granted unrestricted filesystem access. A desktop client ID is not a secret: a process running as the same OS user can claim any client ID or read the self root directly.
