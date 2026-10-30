# Releases

A release is a version tag plus a GitHub Release with notes, and both are created automatically. Nothing is published to npm: people install BatutaMCP with the one-command installer from the Release (see [SETUP.md](../SETUP.md)).

## How a release happens

`.github/workflows/release.yml` runs after every green `CI` run started by a push to `main`. It reads the version from `server/package.json` and creates the tag `vX.Y.Z` and its GitHub Release, with that version's `CHANGELOG.md` section as the notes, when both hold:

- `CHANGELOG.md` has a dated section for the version: `## [X.Y.Z] - YYYY-MM-DD` (a section still marked `Unreleased` is skipped);
- the tag `vX.Y.Z` does not exist yet.

The workflow also builds the server (Node 22.20.0, pnpm 12.1.0, `pnpm install --frozen-lockfile`, `pnpm run build`) and runs `node installer/pack-release.mjs`, which attaches these assets to the Release:

| Asset | What it is |
| --- | --- |
| `batuta-mcp-vX.Y.Z.tar.gz` and `.sha256` | the versioned archive: built server (`server/dist/src` and `server/package.json`), `remote_script/BatutaMCP/*.py`, `installer/install.mjs`, `installer/desktop-config.mjs`, `clients/claude-code/`, `LICENSE`, `README.md`, `SETUP.md`, `CHANGELOG.md`, `VERSION` (no tests, no `odd/`, no `node_modules`) |
| `batuta-mcp.tar.gz` and `.sha256` | the same bytes under a stable name, so `releases/latest/download/batuta-mcp.tar.gz` works without knowing the version |
| `install.sh` | the installer, also stable-named: `curl -fsSL https://github.com/paulpwo/batuta-mcp/releases/latest/download/install.sh \| bash` |

Any other push to `main` does nothing. A failing CI run never releases.

## Cutting a version

In one commit on `main`:

1. Set the new version in all three places that carry it: `server/package.json`, `server/src/version.ts` (`VERSION`) and `remote_script/BatutaMCP/limits.py` (`SCRIPT_VERSION`). A test (`installer/test/version.test.mjs`) fails if they differ.
2. Rename the `Unreleased` section of `CHANGELOG.md` to `## [X.Y.Z] - YYYY-MM-DD`.

Push it. When CI passes, the workflow tags that exact commit and publishes the Release. `server/package.json` keeps `"private": true` so the package can never reach npm by accident.

## Repository settings (once)

- Settings > General > Social preview: `docs/assets/batuta-banner.png` (1280x640).
- Settings > Code security: private vulnerability reporting, Dependabot alerts, secret scanning with push protection.
- Settings > Branches: protect `main` (required status check `CI / test`, no force pushes, no deletions).
