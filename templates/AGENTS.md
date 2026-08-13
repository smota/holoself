<!-- holoself-root-start -->
## Holoself data root

This directory is a private Holoself data root. Load files directly from this directory; do not look for a project-local .holoself fallback.

Loading order:
1. Read profile/identity.md, work-context.md, preferences.md, voice.md, thinking.md, and change.md.
2. Read only relevant files under context/ in stable filename order.
3. Read active topic named by topics/.current, when present.
4. Apply selected public defaults from contribs/default/, then local extensions listed in me/contribs.md or stored under contribs/local/.
5. Read reference/ only when relevant and explicitly permitted.

Do not write durable context silently: propose changes and ask approval.
<!-- holoself-root-end -->
