# Metadata link, snapshot, or legacy mount?

| Need | Use |
|---|---|
| Independent project reads canonical context through lenses | `link add --project --self` metadata project link |
| Inspect-first integration assistant | `link setup --project` |
| Portable or air-gapped generated copy | `export --target` snapshot |
| Self-contained generated packet without fallback files | `export --packet-only` snapshot |
| Legacy project needs complete live data-root directory | `link --target` legacy live mount |

## Metadata project link

Recommended mode. Creates a real project `.holoself/` directory containing `link.yaml`, local index, proposals, reports, Bootstrap, and runtime metadata. It points to canonical self without copying self documents. `access: read` permits resolution; it never grants publication permission.

## Snapshot

`export` and `context --snapshot` generate reviewable context. Snapshot content can become stale and must be treated as private unless separately reviewed for sharing. Source Markdown remains canonical.

## Legacy live mount

`link --target` creates project `.holoself` as a symlink/junction to complete data root. This exposes more private context and conflicts with metadata directory mode. It remains compatibility-only. New integrations should normally use `link add`.

Never convert between these modes silently.
