# Release guide

Holoself uses Semantic Versioning, a release pull request, and an immutable `vX.Y.Z` tag. The tag starts the GitHub Release workflow; ordinary contribution pull requests do not change the version.

## 1. Prepare the release pull request

Create `release/vX.Y.Z` from the current `main` branch, then update these release surfaces together:

- `package.json`
- `src/version.mjs`
- `CHANGELOG.md`
- `docs/releases/X.Y.Z.md`

Move the relevant user-facing changes out of `Unreleased` in the changelog. Lead the release document with user value and keep technical detail proportional to its usefulness.

Run:

```bash
npm run verify
```

Open a pull request titled `chore: prepare vX.Y.Z`. Merge it only after the `Verify` check passes and the version, changelog, and release document have been reviewed.

## 2. Tag the merged release commit

Update local `main`, resolve the exact merge commit, and create an annotated tag on that commit:

```bash
git switch main
git pull --ff-only origin main
git tag -a vX.Y.Z -m "Holoself vX.Y.Z" <release-commit>
git push origin vX.Y.Z
```

The tag name must match both version files. A `vX.Y.Z` tag triggers `.github/workflows/release.yml`, which validates the metadata, runs the full repository verification, and creates the GitHub Release with generated comparison notes.

## 3. Verify publication

Confirm all three references resolve to the intended release commit:

```bash
git rev-parse origin/main
git rev-list -n 1 vX.Y.Z
gh release view vX.Y.Z --json tagName,targetCommitish,url,publishedAt
```

Also confirm the Release workflow succeeded in GitHub Actions. A source version or local tag alone is not evidence that a GitHub Release was published.

Released tags must not be moved or reused. If a release is wrong, correct it in a new patch release.
