# Contributing to Holoself

Thank you for helping improve Holoself. Small, focused contributions are welcome, including documentation, tests, bug fixes, and carefully scoped features.

## Before you start

- Search existing issues and pull requests before opening a duplicate.
- Open an issue before a large feature or architectural change so the direction can be agreed first.
- Never include personal Holoself context, credentials, private paths, generated context packets, or other sensitive data in an issue, test fixture, commit, or pull request.
- Use synthetic examples wherever a test or document needs realistic context.

## Contribution flow

1. Fork the repository and create a short-lived branch from `main`.
2. Use a descriptive branch name such as `feat/bounded-search`, `fix/link-validation`, or `docs/quickstart`.
3. Make one focused change and add or update tests and documentation where behavior changes.
4. Run the full local verification:

   ```bash
   npm run verify
   ```

5. Open a pull request against `main` and complete the pull-request template.
6. Address review feedback and keep the branch current until the required check passes.
7. A maintainer squash-merges an accepted pull request. Branches in this repository are deleted automatically after merge; contributors can delete branches in their own forks.

Holoself requires Node.js 20 or newer. The repository currently has no third-party runtime dependencies, so no install step is required before verification.

## Pull-request titles

Use a concise title that describes the result. Prefix it with one of:

- `feat:` for user-visible functionality
- `fix:` for a defect correction
- `docs:` for documentation only
- `test:` for test-only changes
- `refactor:` for internal restructuring without a behavior change
- `chore:` for maintenance

The repository uses squash merges, so the pull-request title becomes the commit title on `main` and feeds the generated release notes.

## Review expectations

A contribution should:

- stay within the scope described by the pull request;
- preserve local-first operation and explicit review boundaries;
- fail closed when privacy, provenance, or filesystem authority is unclear;
- include tests for changed behavior and documentation for changed user flows;
- pass `npm run verify` and the GitHub `Verify` check.

Maintainers may ask for a change to be split when unrelated concerns are combined. Acceptance of a contribution does not imply that every proposed follow-up will be adopted.

## Releases

Contributors do not need to change product versions for ordinary pull requests. Maintainers collect accepted changes into a release pull request and follow the process in [the release guide](docs/contributing/releases.md).
