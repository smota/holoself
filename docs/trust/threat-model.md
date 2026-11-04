# Threat model

## Assets

Private profile/context, evidence, third-party data, employer-confidential material, proposal history, project artifacts, and the self-side client registry (`.holoself/clients.json`: which desktop MCP clients may read which lens).

## Trust boundaries

- Operating system and filesystem permissions
- AI tool granted project or self-root access
- Project `.holoself` metadata
- Agent-client MCP configuration and the client-launched STDIO subprocess
- Desktop MCP clients without a project (Claude Desktop and similar apps), bound to one owner-attested client identity at launch ([decision](../decisions/unlinked-client-identity.md))
- Host user-level MCP configuration files that Holoself edits only with `holoself mcp configure --client <client-id> --platform <platform> --apply`
- Generated packets and indexes
- Private sync or Git provider chosen by user

## Threats and mitigations

| Threat | Mitigation | Residual risk |
|---|---|---|
| Tool reads excessive context | Lenses, visibility, linked metadata instead of full mount | Tool with broad filesystem access can bypass CLI |
| Secret enters index | Filename/content patterns and sensitivity filtering | Novel secret formats may evade detection |
| Project silently changes self | Read-only links and confirmed proposals | User can still manually edit canonical files |
| Path traversal or target escape | Relative-path and containment validation | OS-level link/race behavior remains platform concern |
| Stale or contradictory copies | Deterministic analysis and freshness metadata | Semantic classification is heuristic |
| Private packet committed | Warnings and private-by-default guidance | Git policy is user-controlled |
| Malformed config weakens policy | Strict fields and fail-closed parsing | Future schema migration needs care |
| MCP client selects the wrong project | Fixed startup binding, mandatory safe link, path-free tools, ambiguity rejection | A compromised client with broad filesystem access can bypass MCP |
| MCP leaks roots or excessive output | Manifest-first retrieval, source handles, output caps, absolute-path stripping | Selected content remains private and client-visible |
| Model writes canonical self | MCP exposes only project-local pending proposal creation; approval is absent | User or another unrestricted tool can still edit files directly |
| Desktop app with network access receives self context | Owner-created client identity bound to exactly one non-`private` lens that cannot grant `restricted`; self-only, no project content; same budgets and envelope caps; served-context ledger (#65) entries tagged `client_id` | Everything the chosen lens allows can leave the machine through that app; lens choice is the control |
| Prompt injection in a desktop chat writes false facts | Client proposals disabled by default; opt-in inbox requires evidence text, targets only lens-visible documents, is capped per client, and is approved only by the owner through CLI or Workbench | An owner can still approve an injected claim after review |
| Desktop client claims another identity | Identity fixed from the owner-written launch command (`--client`); tool arguments carry no identity (`IDENTITY_NOT_ACCEPTED_FROM_CALLER`); `clientInfo.name` is descriptive only | Client ID is not a secret: a same-user process can launch with any ID or read the self root directly |
| Stale client configuration after revocation | Registry and lens re-checked on every call; revoked or unknown client fails closed without restarting the host | Host keeps showing a failing server until its entry is removed |
| Host configuration edit damages user settings or leaks secrets | Print-only by default; `--apply` needs a verified platform, plan-hash preview, `--yes`, collision refusal, backup, symlink and hard-link refusal, mode preservation, and atomic write with rollback; preview prints only the Holoself entry | Host may rewrite its own file concurrently; plan-hash check refuses but cannot prevent it |

## Out of scope

Endpoint compromise, malicious administrators, compromised AI runtimes, encrypted storage, hosted identity, and publication approval outside CLI.

Report security issues privately to repository owner before public disclosure.
