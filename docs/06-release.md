# Release checklist (owner only)

Every step below touches a remote service and needs the owner's explicit approval before it is done. Nothing in this repository performs these steps automatically.

## 0. Before the first push

- [x] (approval) Replace every `<PIN-SHA>` in `.github/workflows/ci.yml` and `release.yml` with the full 40-character commit SHA of the release named in the comment above it. Verify each SHA belongs to the official action repository.
- [ ] (approval) Apply the `server/package.json` changes listed in "Package changes" below.
- [ ] (approval) Run the full local test suites once and confirm `git status` shows no `odd/`, `node_modules/` or `dist/` files staged.
- [ ] (approval) Run a final search of the tree for internal or third-party project names (`static-names` test covers this) and read the first-commit file list.

## 1. Create the GitHub repository

- [ ] (approval) Create `paulpwo/batuta-mcp` as a public repository (empty, no README).
- [ ] (approval) `git init`, first commit (identity: owner only, no AI attribution), add the remote, push `main`.

## 2. Repository settings

- [ ] (approval) Settings > Code security: enable **Private vulnerability reporting**, Dependabot alerts, and secret scanning with push protection.
- [ ] (approval) Settings > Actions > General: workflow permissions "Read repository contents"; require approval for workflows from outside contributors; allow only actions you pinned.
- [ ] (approval) Settings > Branches: protect `main` (pull request required, required status check `CI / test`, no force pushes, no deletions, linear history).
- [ ] (approval) Settings > Tags: add a tag ruleset restricting who can create `v*` tags.
- [ ] (approval) Settings > Environments: create `release` with **Required reviewers** (the owner) and deployment restricted to `v*` tags. This is the manual approval gate for publishing.

## 3. npm

- [ ] (approval) Make sure the `@paulpwo` scope exists on npm and the account has two-factor authentication enabled.
- [ ] (approval) For the first publish a package must exist before a trusted publisher can be attached: either publish `0.1.0` once by hand with 2FA (`npm publish --access public`, from a clean checkout) and then configure trusted publishing, or use npm's flow for setting up a trusted publisher for a not-yet-published name if the UI offers it.
- [ ] (approval) npmjs.com > package > Settings > Trusted Publisher: GitHub Actions, owner `paulpwo`, repository `batuta-mcp`, workflow `release.yml`, environment `release`.
- [ ] (approval) In the same settings page choose "Require two-factor authentication and disallow tokens" so only trusted publishing can publish.

## 4. First tag

- [ ] (approval) Update `CHANGELOG.md` (move 0.1.0 out of "Unreleased" with the date) and make sure `server/package.json` version is `0.1.0`.
- [ ] (approval) Create and push the signed tag: `git tag -s v0.1.0 -m "v0.1.0"` then `git push origin v0.1.0`.
- [ ] (approval) Approve the pending `release` environment deployment in the Actions run after reviewing the `verify` job.
- [ ] (approval) Check the npm page shows the provenance badge, run `gh attestation verify` on the downloaded tarball, and review the SBOM artifact.
- [ ] (approval) Create the GitHub Release from the tag, attaching the tarball and SBOM.

## Package changes (`server/package.json`)

Applied before the first push: `author`, `repository` (`git+https://github.com/paulpwo/batuta-mcp.git`, directory `server`), `homepage`, `bugs` and `keywords`. Still to do before the first npm publish:

- Remove `"private": true` (npm refuses to publish private packages).
- Keep the repository URL above in sync with the GitHub repository: it must match the provenance source exactly or npm rejects the publish.
- Add `"publishConfig": {"access": "public", "provenance": true}`.
- Extend `files` to include `README.md`, `LICENSE` (npm adds them only when they sit inside `server/`; either copy them in at pack time or add a `prepack` step) and make sure the Remote Script and installer ship if the package is meant to install them; otherwise document that they come from the repository.
- Check that `files: ["dist/src"]` excludes `dist/test` and that the tarball (`pnpm pack --dry-run`) contains no tests, maps you do not want, or scratch files.
- Confirm `engines.node` (`>=22.14`) is still accurate and that `bin` keeps the executable bit in the tarball.
