# Operator notes: install and coexistence

Everything here is manual and local; nothing is uploaded.

## One-command install

```sh
curl -fsSL https://github.com/paulpwo/batuta-mcp/releases/latest/download/install.sh | bash
```

`install.sh` (repo root, attached to every release) downloads `batuta-mcp.tar.gz` and its `.sha256` from the latest release, verifies the checksum, refuses archive entries with absolute paths, `..` or links, and swaps the unpacked tree into `~/.batuta-mcp` (the old one becomes `~/.batuta-mcp.previous`; it refuses a symlinked target or a folder that is not a BatutaMCP install). Then it runs the Remote Script installer below, re-registers `batutaMCP` with Claude Code (`claude mcp remove` then `claude mcp add --scope user`, with the absolute node path and the hardening flag) and merges the same entry into Claude Desktop's `claude_desktop_config.json` when Claude Desktop is installed (see [Claude Desktop](#claude-desktop)). Options: `--dry-run` (write nothing), `--version vX.Y.Z`. Environment: `BATUTA_HOME_DIR` (install folder), `BATUTA_DOWNLOAD_BASE` (where the assets are fetched from). The manual steps below are the same installation done from a checkout.

## Install order (from source)

1. `node installer/install.mjs install --dry-run`, read the plan, then `install` without the flag.
2. `node installer/install.mjs verify` (hashes vs manifest and vs the package) and `status`.
3. Live > Settings > Link, Tempo & MIDI > Control Surface: pick **BatutaMCP**, Input/Output None. Restart Live.
4. `status` again: the runtime dir `~/Library/Application Support/BatutaMCP/` should exist, mode 0700, with `token` (0600) and `live.sock`. The installer never creates it; the Remote Script does when it loads.
5. Build the server (`cd server && pnpm install --frozen-lockfile && pnpm run build`) and register it. Use the command the installer prints:
   `claude mcp add --scope user batutaMCP -- '<abs path of node>' --disallow-code-generation-from-strings '<abs path>/server/dist/src/bin.js'`. The node path is the one that ran the installer (`process.execPath`), so registration works even when `node` is not on Claude Code's PATH (nvm), and the code-generation flag is always passed. Fallback, only when node is on your client's PATH: register the binary itself (`... -- '<abs path>/server/dist/src/bin.js'`); the build makes it executable, and if it does not the installer prints a `chmod 755 '<path>'` line for that fallback.
6. In Claude Code permissions keep `batuta_confirm` on "ask". For Claude Desktop see the next section.
7. Optional, for the host automation tools (`new_set`, `save_set`, `save_set_as`, `export_audio`): System Settings > Privacy & Security > Accessibility, enable the app that runs your MCP client (Terminal, iTerm, Claude, ...). The first use may also ask to let that app control System Events (Automation). `launch_live` and `open_set` need neither. Set `host.enabled` to `false` in `server.json` to remove these tools. See `docs/04-host-automation.md`.

## Claude Desktop

Claude Desktop (macOS) can use the same server. `install.sh` adds the `batutaMCP` entry to `~/Library/Application Support/Claude/claude_desktop_config.json` for you (other servers and keys untouched; a timestamped `.bak-` copy first; atomic write; a symlinked or invalid-JSON file is refused and the block is printed instead). Then fully quit Claude Desktop (Cmd-Q) and reopen it. The steps below are the manual path, used when you install from source: the Remote Script installer prints a ready-to-paste block and never touches that file.

1. Open `~/Library/Application Support/Claude/claude_desktop_config.json` and paste the printed block. If the file already has an `mcpServers` object, merge only the `batutaMCP` entry into it.
2. The `command` must be the absolute path of `node` (the block uses the one that ran the installer). Claude Desktop does not load your shell PATH, so a bare `node` will not start.
3. Fully quit Claude Desktop (Cmd-Q) and reopen it.
4. Host automation tools: grant Accessibility to `Claude.app` itself (System Settings > Privacy & Security > Accessibility). The first use may also ask to let it control System Events (Automation).
5. When Claude Desktop asks to allow `batuta_confirm`, choose **Allow once**. Never choose "always allow": that bypasses the confirmations.
6. The repo skills (`skills/batuta-ableton`, `skills/mixing-ableton`) are not loaded automatically. If your plan supports skills, zip each skill folder and upload it in Claude Desktop settings (Capabilities / Skills).
7. The server sends its MCP `instructions` on connect, but whether Claude Desktop uses them is unverified.
8. Transport panel: ask Claude "show the transport panel". Claude Desktop renders it inline in the chat (back to start, back a bar, one play/stop toggle, forward a bar, and a line with the position, tempo and time signature). If the host offers a floating (picture-in-picture) mode, a float button appears and keeps the panel on screen while you scroll; the dock button returns it to the chat. It needs no setup and makes no network connection; its buttons call `get_transport`, `control_transport` and `set_song_position` through Claude. When Live is closed it says "Live not connected" and recovers by itself when Live is back. Claude Code does not render MCP Apps: `show_transport_panel` there returns the transport report as text; for Claude Code, use the transport bar plugin below.

## Claude Code transport bar

`clients/claude-code/` is a local Claude Code marketplace (`batuta`) with the `batuta-transport` plugin. It draws a bar above the prompt with back to start, back a bar, play/stop and forward a bar buttons, and a status line with the position and tempo. Install it with the two commands the installer prints (it never runs them):

```sh
claude plugin marketplace add '<abs path of this checkout>/clients/claude-code'
claude plugin install batuta-transport@batuta --scope user
```

- The bar needs the BatutaMCP server registered in the session and Live answering. It shows only while Live answers and hides when Live closes.
- `/transport` shows it again after you hide it. After updating the plugin, run `/reload-plugins`.
- One Live client at a time (see [Several Claude sessions](#several-claude-sessions)): close other BatutaMCP clients (for example Claude Desktop) before relying on the bar.

## Several Claude sessions

Live accepts one BatutaMCP client at a time, and every Claude session starts its own server. The session that holds Live keeps it; another session's tool call is refused with `busy` (`details.reason: held_by_other_session`) and the message says when to try again. Nothing is taken over.

- The server connects on the first tool call that needs Live, not when the session starts. `batuta_status` works without connecting and reports `connection.state` as `idle` (never connected) or `released`.
- After `live.idle_release_s` seconds without tool calls (default 120; `0` never releases) the holder closes the connection, which frees the slot at once. Work in flight and a running `batuta_ears` job keep it.
- While idle or released there is no automatic reconnect and no polling. A refused or released session tries again only on its next tool call.

## Side by side with other Remote Scripts

BatutaMCP uses its own Remote Scripts folder (`BatutaMCP`), its own AF_UNIX socket (`~/Library/Application Support/BatutaMCP/live.sock`, with a token) and its own MCP name (`batutaMCP`), so it can coexist with any other control surface script. Choose BatutaMCP in a free Control Surface slot. If another script also edits the set from a different client, avoid giving both the same instruction in one session. The installer never reads, moves or changes any other folder in `Remote Scripts`.

## Upgrades

Run the one-command install again. From a source checkout, check out the newest release tag (`git fetch --tags`, then `git checkout <tag>`; tags are listed on the Releases page) or unpack its Source code archive, rebuild the server, and re-run `install`. If the installed folder is an unmodified earlier BatutaMCP install, the new version is staged in `~/Music/Ableton/User Library/BatutaMCP-previous/.staging-<random>` (outside `Remote Scripts`, so a failed install never leaves a loadable package there), the old folder is renamed to `BatutaMCP-previous/BatutaMCP-<UTC time>`, and the staged folder is renamed into `Remote Scripts/BatutaMCP`. All three folders are on the same volume, so each step is one atomic rename. The path of the archived version is printed. Old versions are kept outside `Remote Scripts` on purpose: Live would list them as control surfaces, and a second BatutaMCP instance would fight for `live.sock`. Move them to the Trash when you are done. If you edited an installed file, or the folder is not ours, the installer refuses and changes nothing.

## Development: link mode

For work on the Remote Script, so you do not reinstall after every change:

```
node installer/install.mjs link --dry-run
node installer/install.mjs link
```

`Remote Scripts/BatutaMCP` becomes a symlink to this repo's `remote_script/BatutaMCP` (absolute path). An unmodified copy install is first archived to `BatutaMCP-previous/BatutaMCP-<UTC time>`; a modified install, a foreign folder or any other symlink is refused and nothing changes. Running `link` again when already linked changes nothing. Only the final `BatutaMCP` entry may be our link; the parent folders must still be real directories.

Live loads the script's Python modules once per run, so after each change quit Live (Cmd-Q) and reopen it. Reselecting BatutaMCP in Control Surface is not enough: Live reuses the modules already in memory (observed on Lite 12.4.7, 2026-10-28). Live writes `__pycache__` into the repo folder (git-ignored).

Tradeoffs: Live runs whatever is in the repo at that moment, even half-written files; and `verify` cannot detect changes (it prints that it does not apply and exits 0), because the files are the repo itself. Use the normal copy install for daily use and releases. `install` over our link replaces it with a copy and renames the link to `BatutaMCP-previous/BatutaMCP-link-<UTC time>`. `status` shows `linked to <target>`.

## Troubleshooting

- Old versions: `~/Music/Ableton/User Library/BatutaMCP-previous/` holds archived versions and the staging folder of a failed install (`.staging-*`). It is outside `Remote Scripts` on purpose. Move what you do not need to the Trash; the installer never deletes. The installer assumes the default User Library location.

- `Refusing: ... is a symlink / not owned by the current user`: one of `Music`, `Ableton`, `User Library`, `Remote Scripts`, `BatutaMCP`, `BatutaMCP-previous` is a symlink or owned by another user. Fix that yourself; the installer will not follow it.
- `verify` fails after Live ran: check the reported file. `__pycache__` folders created by Live are expected and ignored.
- Script not in Live's list: restart Live; check `Remote Scripts/BatutaMCP/__init__.py` exists.
- Script loaded but the server cannot connect: run `status`; the runtime dir must be 0700 and yours. Live's `Log.txt` has one line saying why the script did not listen.
