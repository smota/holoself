# Knowledge lifecycle

Canonical Markdown may declare `knowledge_status: current|historical|superseded`, `temporal_scope`, `valid_from`, `valid_until`, `review_after`, `supersedes`, and `superseded_by`. Missing lifecycle metadata remains `current` for compatibility. Invalid dates and incomplete supersession metadata fail closed.

Historical knowledge remains available for explicit resolution and audit, but is excluded from current context by default. Approved, rejected, deferred, and superseded proposal archives are immutable review evidence and are never cleanup candidates.

Cleanup is reviewed and digest-bound:

```powershell
holoself knowledge cleanup --root C:/path/to/self --dry-run
holoself knowledge cleanup --root C:/path/to/self --output C:/safe/cleanup-plan.json
holoself knowledge cleanup --root C:/path/to/self --apply C:/safe/cleanup-plan.json --digest <sha256> --yes
```

Plans contain paths, operations, reasons, and input hashes—not document bodies. Apply rejects stale hashes, symlinks, existing destinations, protected proposal archives, and digest mismatches, and writes an immutable receipt.
