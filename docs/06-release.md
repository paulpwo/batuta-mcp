# Releases

A release is a version tag plus a GitHub Release with notes, and both are created automatically. Nothing is published to npm: people install BatutaMCP with the one-command installer from the Release (see [SETUP.md](../SETUP.md)).

## How a release happens

Nobody edits a version by hand. `.github/workflows/release.yml` runs after every green `CI` run started by a push to `main`, and `installer/next-release.mjs` decides the next version from the Conventional Commit subjects since the last `vX.Y.Z` tag:

| Commits since the last tag | Next version (from 0.2.3) |
| --- | --- |
| a `!` after the type (`feat!:`) or a `BREAKING CHANGE:` footer | major: `1.0.0` |
| any `feat:` | minor: `0.3.0` |
| `fix:`, `perf:`, `refactor:`, `chore:`, `build:`, `revert:`, or a subject without a type | patch: `0.2.4` |
| only `docs:`, `test:`, `ci:`, `style:` | no release |

When there is a release, the script sets `server/package.json`'s version and turns the `## [Unreleased]` section of `CHANGELOG.md` into `## [X.Y.Z] - YYYY-MM-DD` (with no text there, it writes the section from the commit subjects). The workflow commits that as `chore: release X.Y.Z` on `main` (as `github-actions[bot]`; a push made with `GITHUB_TOKEN` starts no new workflow, so it does not loop), tags that commit `vX.Y.Z` and creates the GitHub Release with the section as its notes. If `main` moved past the tested commit, that run steps aside and the newer one releases.

The workflow also builds the server (Node 22.20.0, pnpm 12.1.0, `pnpm install --frozen-lockfile`, `pnpm run build`) and runs `node installer/pack-release.mjs`, which attaches these assets to the Release:

| Asset | What it is |
| --- | --- |
| `batuta-mcp-vX.Y.Z.tar.gz` and `.sha256` | the versioned archive: built server (`server/dist/src` and `server/package.json`), `remote_script/BatutaMCP/*.py`, `installer/install.mjs`, `installer/desktop-config.mjs`, `installer/claude-code-settings.mjs`, `clients/claude-code/`, `LICENSE`, `README.md`, `SETUP.md`, `CHANGELOG.md`, `VERSION` (no tests, no `odd/`, no `node_modules`) |
| `batuta-mcp.tar.gz` and `.sha256` | the same bytes under a stable name, so `releases/latest/download/batuta-mcp.tar.gz` works without knowing the version |
| `install.sh` | the installer, also stable-named: `curl -fsSL https://github.com/paulpwo/batuta-mcp/releases/latest/download/install.sh \| bash` |

Any other push to `main` does nothing. A failing CI run never releases.

## Cutting a version

Push to `main` with Conventional Commit messages; the type decides the bump (table above). For release notes in your own words, write them under `## [Unreleased]` in `CHANGELOG.md` in the same push; otherwise they are made from the commit subjects. `server/package.json` is the only file holding the version (`installer/test/version.test.mjs` fails if one is written elsewhere) and keeps `"private": true`, so the package can never reach npm by accident. `main` must stay unprotected, or allow `github-actions[bot]` to push, for the release commit.

## Repository settings (once)

- Settings > General > Social preview: `docs/assets/batuta-banner.png` (1280x640).
- Settings > Code security: private vulnerability reporting, Dependabot alerts, secret scanning with push protection.
- Settings > Branches: protect `main` (required status check `CI / test`, no force pushes, no deletions).
