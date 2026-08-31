# Safety guarantees and limits

## Enforced by CLI

- No network requests or publication actions
- No automatic deletion or relocation of project artifacts
- Read-only project links
- Explicit confirmation for canonical proposal approval
- Provenance validation on proposals
- Canonical target containment and relative source-path checks
- Recognized secret-like filenames and content patterns excluded from context/index output
- Invalid visibility, malformed link YAML, unsafe paths, and unknown options fail closed
- Indexes remain disposable and Markdown canonical
- MCP is local STDIO only, binds one linked project at startup, and has no listener or network access
- MCP tools accept no project/self roots and expose no raw canonical resources
- MCP proposal creation writes only project-local pending review; approval and canonical writes are absent
- MCP output is bounded and strips absolute self/project paths

## User responsibilities

- Keep self root and project `.holoself` private
- Review context output before external use
- Verify claims and evidence
- Configure visibility and sensitivity accurately
- Protect filesystem access, backups, and sync providers
- Understand that pattern-based secret detection cannot identify every secret

Holoself reduces disclosure risk; it cannot guarantee safe publication or defend against a tool already granted unrestricted filesystem access.
