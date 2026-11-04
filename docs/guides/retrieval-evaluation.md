# Retrieval evaluation

Holoself includes a deterministic retrieval evaluation harness to measure context selection quality across lenses, budgets, languages, and knowledge lifecycles before changing the ranker or context-need classifier.

For how indexing and search work at runtime, see [Indexing and search](indexing-and-search.md) and [Lenses and privacy](../concepts/lenses-and-privacy.md).

## Running the evaluation

Run the golden-set evaluator from a repository checkout:

```bash
npm run eval:retrieval
```

By default, `scripts/eval-retrieval.mjs` prints the per-category summary table and known-gap breakdown to `stderr` and writes the full deterministic JSON report to `stdout`.

To write the JSON report to a file while printing the summary table to `stdout`:

```bash
npm run eval:retrieval -- --out /tmp/retrieval-eval.json
```

When a ranking or classification change intentionally improves retrieval recall, update the committed baseline:

```bash
npm run eval:retrieval -- --update-baseline
```

## How the harness works

1. **Synthetic corpus (`tests/fixtures/retrieval-eval/corpus.mjs`)**: Materializes a temporary self root and a linked project containing 53 synthetic Markdown documents across `profile/`, `context/`, and `history/`. All personas, companies, and architectures are fictional (`Alexia V. Moreira`, `Aethelgard Cloud`, `Meridian`), with zero personal data.
2. **Real CLI execution**: Each case in `tests/fixtures/retrieval-eval/cases.json` invokes `holoself context --project <dir> --lens <lens> --budget <budget> --task <text> --json` (or `holoself context --project <dir> --lens <lens> --budget <budget> --session-start --json` for session-start cases) as a child process against the linked synthetic project.
3. **Metrics per case**:
   - **`recall` (`recall@budget`)**: Fraction of `expected_source_paths` present in the delivered context packet (`expected_found / expected_count`, or `1` when `expected_source_paths` is empty and no self sources are delivered).
   - **`precision`**: Fraction of delivered sources that appear in `expected_source_paths` (`expected_found / delivered_count`, or `1` when both `expected_source_paths` and `delivered_source_paths` are empty).
   - **`forbidden_leaks`**: Count of delivered sources that appear in `forbidden_source_paths` or carry `sensitivity: restricted`. Must always be `0`.
   - **`bytes_used`**: Total UTF-8 byte length of the emitted JSON context packet (`selection.total_bytes`).

## Categories and known gaps

The golden set (`tests/fixtures/retrieval-eval/cases.json`) covers seven categories across English (`en`) and Portuguese (`pt`):

| Category | What it verifies |
|---|---|
| `personal` | Identity, career progression, writing voice, leadership, and interview preparation queries retrieve the right `profile/` and `context/` sources. |
| `mechanical` | Pure mechanical code tasks (`Fix lint warnings`, `Sort the import statements`) classify as `context_need: not-needed` and keep only `session_start_sources` and policy documents while omitting broad personal content, whereas tasks pairing mechanical verbs with domain or personal nouns resolve to `helpful` or `required` (#68). |
| `synonyms` | Queries phrased with synonyms or paraphrases that share zero exact tokens with the target document are tracked as `known_gap: true` (#69). |
| `lifecycle` | Default `current` selection excludes `superseded`, `historical`, and expired (`valid_until` in the past) documents; explicit `--temporal historical` and `--temporal superseded` selectors retrieve them. |
| `privacy` | Sensitivity gates (`compensation-confidential`, `third-party-personal`, `recruiter-confidential`, `employer-confidential`, `application-private`) block unauthorized lenses, and `restricted` documents never appear in linked-project responses. |
| `budget` | Under `small` budget pressure (8,000 characters / 16 KiB envelope cap), the highest-scoring task-relevant documents outrank generic baseline documents. |
| `session-start` | `--session-start` loads the lens `session_start_sources` (default `profile/identity.md`, `profile/preferences.md`, `profile/work-context.md`, or lens-specific overrides) and omits non-policy content documents. |

Cases marked with `"known_gap": true` record the true `expected_source_paths` that *should* be retrieved alongside the current baseline outcome (`recall: 0`), rather than faking empty expectations.

## CI regression gate

`tests/retrieval-eval.test.mjs` runs automatically as part of `npm test` and `npm run verify`. The test fails if:

- Any case reports `forbidden_leaks > 0`.
- Aggregate `mean_recall` drops below `baseline.summary.mean_recall - 0.02`.
- Any non-`known_gap` case's `recall` drops below its recorded baseline in `tests/fixtures/retrieval-eval/baseline.json`.

Improvements over the baseline pass the gate and print a reminder to run `npm run eval:retrieval -- --update-baseline`.

## Extending the golden set

1. If you need a new synthetic document, add an entry to `SYNTHETIC_DOCUMENTS` in `tests/fixtures/retrieval-eval/corpus.mjs` with full canonical frontmatter (`access_lenses`, `disclosure`, `sensitivity`, `document_role`) and fictional content.
2. Add your test case to `tests/fixtures/retrieval-eval/cases.json` with `id`, `category`, `language`, `task`, `lens`, `budget`, `expected_source_paths`, `forbidden_source_paths`, and `notes`.
3. Run `npm run eval:retrieval -- --update-baseline` and `npm run verify` to record the updated baseline and confirm all checks pass.
