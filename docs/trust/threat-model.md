# Threat model

## Assets

Private profile/context, evidence, third-party data, employer-confidential material, proposal history, and project artifacts.

## Trust boundaries

- Operating system and filesystem permissions
- AI tool granted project or self-root access
- Project `.holoself` metadata
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

## Out of scope

Endpoint compromise, malicious administrators, compromised AI runtimes, encrypted storage, hosted identity, and publication approval outside CLI.

Report security issues privately to repository owner before public disclosure.
