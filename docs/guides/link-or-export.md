# Link, mount, or export?

| Need | Use |
|---|---|
| Independent project reads canonical context through lenses | `link add --project --self` |
| Inspect-first integration assistant | `link setup --project` |
| Portable or air-gapped snapshot | `export --target` |
| Self-contained packet without fallback files | `export --packet-only` |
| Legacy project needs full live data-root directory | `link --target` legacy mount |

## Recommended project link

Metadata link creates `.holoself/link.yaml`, local index, proposals, and reports. It grants read access without copying self.

## Legacy live mount

`link --target` creates project `.holoself` as a symlink/junction to the complete data root. This exposes more private context to project tools and conflicts with metadata directory mode. It remains supported for compatibility. New integrations should normally use `link add`.

## Export

Export creates a reviewable snapshot. It can become stale and must be treated as private. Use packets when live link access is unavailable or undesirable.
