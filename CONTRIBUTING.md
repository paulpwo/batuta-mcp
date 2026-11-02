# Contributing

Thanks for helping. This project is security-sensitive, so a few rules are firm.

## Ground rules

- **Test first.** Write the failing test, see it fail, then make it pass. Changes without tests are not merged.
- **No runtime dependencies.** The server uses Node built-ins only and the Remote Script uses the Python standard library only. Dev dependencies must be exact-pinned and installed with the lockfile (`pnpm install --frozen-lockfile`).
- **Respect the scanners.** Static tests reject dynamic code evaluation, reflection tricks, computed property access, new `child_process` users (only `server/src/host/runner.ts` may start processes), network access in the Remote Script, and forbidden names. Do not weaken or bypass a scanner to land a change; if a rule is wrong, open an issue.
- **Fail closed.** Unknown input, unreadable state and ambiguous Live objects must refuse, not guess.
- Keep comments and documentation in English.

## Running the tests

```sh
cd server && pnpm install --frozen-lockfile && pnpm test
node --test "loudness/test/*.test.ts"
node --test "installer/test/*.test.mjs"
python3 -I -B -m unittest discover -s tests/remote_script -t .
```

Requirements: Node 22.18 or newer, pnpm 12.1.0 (via corepack), Python 3.11 or newer.

## Pull requests

Keep them small and focused, use Conventional Commit messages (their type sets the next version: see [docs/06-release.md](docs/06-release.md)), and describe the behavior change and the tests that cover it. Report vulnerabilities privately as described in `SECURITY.md`.
