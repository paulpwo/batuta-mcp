# Releases

A release is a version tag plus a GitHub Release with notes, and both are created automatically. Nothing is published to npm: people install BatutaMCP from this repository (see [SETUP.md](../SETUP.md)).

## How a release happens

`.github/workflows/release.yml` runs after every green `CI` run started by a push to `main`. It reads the version from `server/package.json` and creates the tag `vX.Y.Z` and its GitHub Release, with that version's `CHANGELOG.md` section as the notes, when both hold:

- `CHANGELOG.md` has a dated section for the version: `## [X.Y.Z] - YYYY-MM-DD` (a section still marked `Unreleased` is skipped);
- the tag `vX.Y.Z` does not exist yet.

Any other push to `main` does nothing. A failing CI run never releases.

## Cutting a version

In one commit on `main`:

1. Set the new version in `server/package.json`.
2. Rename the `Unreleased` section of `CHANGELOG.md` to `## [X.Y.Z] - YYYY-MM-DD`.

Push it. When CI passes, the workflow tags that exact commit and publishes the Release. `server/package.json` keeps `"private": true` so the package can never reach npm by accident.

## Repository settings (once)

- Settings > General > Social preview: `docs/assets/batuta-banner.png` (1280x640).
- Settings > Code security: private vulnerability reporting, Dependabot alerts, secret scanning with push protection.
- Settings > Branches: protect `main` (required status check `CI / test`, no force pushes, no deletions).
