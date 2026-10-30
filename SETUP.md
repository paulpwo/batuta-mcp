# BatutaMCP quickstart

The short path from a fresh checkout to a first answer from Live. Details, upgrades and troubleshooting are in [docs/02-install.md](docs/02-install.md).

## Requirements

- macOS.
- Ableton Live 12.4 or later (Lite, Standard or Suite).
- Node.js 22.14 or later (the `engines` field of `server/package.json`).

## Steps

1. Install the Remote Script (read the dry run first):

   ```sh
   node installer/install.mjs install --dry-run
   node installer/install.mjs install
   ```

2. Build the server:

   ```sh
   cd server && pnpm install --frozen-lockfile && pnpm run build
   ```

3. Register it with Claude Code. The installer prints this command with your paths filled in; run that line:

   ```sh
   claude mcp add --scope user batutaMCP -- '/absolute/path/to/node' --disallow-code-generation-from-strings '/absolute/path/to/server/dist/src/bin.js'
   ```

4. In Live: Settings > Link, Tempo & MIDI > Control Surface, choose **BatutaMCP** (Input and Output: None). Restart Live if it was running.

5. Start a new Claude Code session and ask for `batuta_status`. It should report the connection, the Live edition and the Remote Script version. The server connects on the first tool call that needs Live, so `batuta_status` alone may show `idle`; run `get_session_info` and check it again.

Only one Claude session controls Live at a time; see [Several Claude sessions](docs/02-install.md#several-claude-sessions).
