# BatutaMCP quickstart

The short path to a first answer from Live. Details, upgrades and troubleshooting are in [docs/02-install.md](docs/02-install.md).

## Requirements

- macOS.
- Ableton Live 12.4 or later (Lite, Standard or Suite).
- Node.js 22.14 or later (the `engines` field of `server/package.json`).
- pnpm 12, only when building from source: `npm install --global pnpm@12.1.0` (the corepack bundled with Node 22 cannot activate pnpm 12).

## Install (one command)

One command installs BatutaMCP, and the same command upgrades it:

```sh
curl -fsSL https://github.com/paulpwo/batuta-mcp/releases/latest/download/install.sh | bash
```

It downloads the latest release, checks its SHA-256, unpacks it into `~/.batuta-mcp` (the previous copy is kept as `~/.batuta-mcp.previous`), installs the Remote Script for Live, and registers the server with Claude Code (`claude`) and Claude Desktop when they are installed. It needs macOS and Node.js 22.14 or later; no pnpm, no build, no sudo. Claude Desktop's config gets only the `batutaMCP` entry (backup first; a config that is not valid JSON is left alone and the entry is printed instead). With Claude Code it also sets `"tui": "fullscreen"` in `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`), whatever it was, with a backup first: the transport bar's buttons only take clicks under the fullscreen renderer. `/tui default` switches back.

- Preview without writing anything: end the command with `bash -s -- --dry-run` instead of `bash`.
- A specific release: `bash -s -- --version v0.1.0`.
- Read the script first: [install.sh](install.sh) (short and commented).

One manual step remains: in Live, Settings > Link, Tempo & MIDI > Control Surface: choose **BatutaMCP** (Input and Output: None), and restart Live. Then restart Claude Code (fully quit and reopen Claude Desktop) and ask for `batuta_status`.

Then start a new Claude Code session and ask for `batuta_status`. The server connects on the first tool call that needs Live, so `batuta_status` alone may show `idle`; run `get_session_info` and check it again.

## From source

The steps below build and install from a checkout.

1. Get the latest release (a version tag; `main` may hold unreleased work):

   ```sh
   git clone https://github.com/paulpwo/batuta-mcp.git
   cd batuta-mcp
   git checkout "$(git describe --tags --abbrev=0)"
   ```

   Or download the Source code archive of the [latest release](https://github.com/paulpwo/batuta-mcp/releases/latest) and unpack it.

2. Install the Remote Script (read the dry run first):

   ```sh
   node installer/install.mjs install --dry-run
   node installer/install.mjs install
   ```

3. Build the server:

   ```sh
   cd server && pnpm install --frozen-lockfile && pnpm run build
   ```

4. Register it with Claude Code. The installer prints this command with your paths filled in; run that line:

   ```sh
   claude mcp add --scope user batutaMCP -- '/absolute/path/to/node' --disallow-code-generation-from-strings '/absolute/path/to/server/dist/src/bin.js'
   ```

5. In Live: Settings > Link, Tempo & MIDI > Control Surface, choose **BatutaMCP** (Input and Output: None). Restart Live if it was running.

6. Start a new Claude Code session and ask for `batuta_status`. It should report the connection, the Live edition and the Remote Script version. The server connects on the first tool call that needs Live, so `batuta_status` alone may show `idle`; run `get_session_info` and check it again.

Only one Claude session controls Live at a time; see [Several Claude sessions](docs/02-install.md#several-claude-sessions).

## Upgrade

Run the install command again (it keeps the previous copy in `~/.batuta-mcp.previous` and archives the previous Remote Script) and restart Live. From a source checkout: `git fetch --tags && git checkout "$(git describe --tags --abbrev=0 "$(git rev-list --tags --max-count=1)")"`, then repeat steps 2 and 3 above. Release notes: [CHANGELOG.md](CHANGELOG.md).
