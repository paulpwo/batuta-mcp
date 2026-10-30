# Release checklist (owner only)

A release is a version tag plus a GitHub Release with notes. Nothing is published to npm: people install BatutaMCP from this repository (see [SETUP.md](../SETUP.md)). The tag and the Release are created by the owner; no workflow runs on tags.

## Before tagging

- [ ] `main` is green in CI (`CI / test`).
- [ ] Run the local suites once: server (`cd server && pnpm test`), loudness (`node --test "loudness/test/*.test.ts"`), installer (`node --test "installer/test/*.test.mjs"`), Remote Script (`python3 -I -B -m unittest discover -s tests/remote_script -t .`).
- [ ] `CHANGELOG.md`: move the version out of "Unreleased" and add the date. `server/package.json` carries the same version.
- [ ] `server/package.json` keeps `"private": true` so the package can never be published to npm by accident.

## Tag and Release

1. Commit the CHANGELOG change on `main` and push it.
2. Create the tag on that commit and push it: `git tag -a vX.Y.Z -m "vX.Y.Z"` then `git push origin vX.Y.Z`.
3. Create the GitHub Release from the tag with a short "What's new" list taken from the CHANGELOG: `gh release create vX.Y.Z --title vX.Y.Z --notes-file <notes.md>`. No assets: GitHub attaches the source archives itself.

## Repository settings (once)

- Settings > General > Social preview: `docs/assets/batuta-banner.png` (1280x640).
- Settings > Code security: private vulnerability reporting, Dependabot alerts, secret scanning with push protection.
- Settings > Branches: protect `main` (required status check `CI / test`, no force pushes, no deletions).
