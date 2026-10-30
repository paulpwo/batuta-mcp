# BatutaMCP

<p align="center"><img src="docs/assets/batuta-banner.png" alt="BatutaMCP: an MCP server for Ableton Live" width="100%"></p>

An MCP server for Ableton Live. It lets an MCP client (such as Claude Code) read and edit a Live 12 set: transport, tracks, mixer, scenes, clips and notes, devices, racks, browser loading, arrangement, and "ears" (loudness and spectrum measurements of a track or the master).

BatutaMCP is an independent project and is not affiliated with, endorsed by or sponsored by Ableton. Ableton and Live are trademarks of Ableton AG. Claude is a trademark of Anthropic; ChatGPT and Codex are trademarks of OpenAI. BatutaMCP is not affiliated with, endorsed by or sponsored by Anthropic or OpenAI either.

## Status

This project is in development and has not yet been tested inside Live. Do not rely on it with sets you cannot afford to lose.

Early (v0.1.0). The Remote Script and its tests are complete, but several behaviors depend on Live internals that could only be checked once Live runs the script (listed as assumptions A1 to A41 in [docs/01-protocol.md](docs/01-protocol.md) section 12). Expect to find surprises on first use and read "Known limitations" below.

Quickstart: [SETUP.md](SETUP.md). Also see [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) and the [CHANGELOG](CHANGELOG.md). Licensed under the MIT [LICENSE](LICENSE).

## Requirements

- macOS.
- Ableton Live 12.4 or later: Lite, Standard or Suite.
- Node.js 22.14 or later (for the server and the installer).
- pnpm 12 only to build from source: `npm install --global pnpm@12.1.0` (the corepack bundled with Node 22 cannot activate pnpm 12).

## Install

The short version is in [SETUP.md](SETUP.md).

One command installs BatutaMCP, and the same command upgrades it:

```sh
curl -fsSL https://github.com/paulpwo/batuta-mcp/releases/latest/download/install.sh | bash
```

It downloads the latest release, checks its SHA-256, unpacks it into `~/.batuta-mcp` (the previous copy is kept as `~/.batuta-mcp.previous`), installs the Remote Script for Live, and registers the server with Claude Code (`claude`) and Claude Desktop when they are installed. It needs macOS and Node.js 22.14 or later; no pnpm, no build, no sudo. Claude Desktop's config gets only the `batutaMCP` entry (backup first; a config that is not valid JSON is left alone and the entry is printed instead).

- Preview without writing anything: end the command with `bash -s -- --dry-run` instead of `bash`.
- A specific release: `bash -s -- --version v0.1.0`.
- Read the script first: [install.sh](install.sh) (short and commented).

One manual step remains: in Live, Settings > Link, Tempo & MIDI > Control Surface: choose **BatutaMCP** (Input and Output: None), and restart Live. Then restart Claude Code (fully quit and reopen Claude Desktop) and ask for `batuta_status`.

### From source

For development, or to build it yourself.

1. Get the latest release (a version tag; `main` may hold unreleased work):

   ```sh
   git clone https://github.com/paulpwo/batuta-mcp.git
   cd batuta-mcp
   git checkout "$(git describe --tags --abbrev=0)"
   ```

   Or download the Source code archive of the [latest release](https://github.com/paulpwo/batuta-mcp/releases/latest) and unpack it.

2. Copy the Remote Script (dry run first):

   ```sh
   node installer/install.mjs install --dry-run
   node installer/install.mjs install
   ```

   This copies the `.py` files of `remote_script/BatutaMCP/` into
   `~/Music/Ableton/User Library/Remote Scripts/BatutaMCP/` and writes a `BATUTA_MANIFEST.json` with SHA-256 hashes. It never deletes anything and never touches other Remote Scripts (other control surfaces). The new version is staged outside `Remote Scripts` and goes live with one rename. On upgrade the old folder is renamed to `~/Music/Ableton/User Library/BatutaMCP-previous/BatutaMCP-<UTC time>`, never left inside `Remote Scripts` (Live would list it, and a second copy would fight for the socket). Move old versions to the Trash when you no longer need them. The installer assumes Live's default User Library location (`~/Music/Ableton/User Library`); if you moved your User Library, copy the folder by hand. It refuses to run if the target exists with foreign or hand-edited content, or if a path component is a symlink or not yours.

   Development: `node installer/install.mjs link` symlinks the Remote Script to this checkout instead of copying it (see [docs/02-install.md](docs/02-install.md#development-link-mode)).

   Other commands: `verify` (re-hash the install against its manifest and the package), `status`, `uninstall-instructions`.

3. In Live: Settings > Link, Tempo & MIDI > Control Surface: choose **BatutaMCP** (Input and Output: None). Restart Live if it was running. On load the script creates `~/Library/Application Support/BatutaMCP/` (mode 0700) with the socket and a random token.

4. Build the server (dev dependencies are `typescript` and `@types/node` only; nothing is installed at runtime):

   ```sh
   cd server && pnpm install --frozen-lockfile && pnpm run build
   ```

5. Register it with your MCP client. For Claude Code:

   ```sh
   claude mcp add --scope user batutaMCP -- '/absolute/path/to/node' --disallow-code-generation-from-strings '/absolute/path/to/server/dist/src/bin.js'
   ```

   The installer prints this command with your paths filled in: the absolute path of the `node` that ran the installer (`process.execPath`) and of the built `bin.js`. Using the absolute node path means the server starts even when `node` is not on the PATH of Claude Code (nvm, fnm, asdf), and it guarantees the hardening flag `--disallow-code-generation-from-strings`, which a plain `node dist/src/bin.js` registration would not pass. Paths containing spaces or quotes are shell-quoted for you.

   Fallback: if `node` is on your MCP client's PATH you can register the binary itself, `claude mcp add --scope user batutaMCP -- /absolute/path/to/server/dist/src/bin.js`. Its shebang passes the same flag. The build makes `bin.js` executable; if it is not (`ls -l` shows no `x`), run `chmod 755 /absolute/path/to/server/dist/src/bin.js` first.

   For Claude Desktop (macOS) the installer also prints a JSON block to merge into `~/Library/Application Support/Claude/claude_desktop_config.json`; see [docs/02-install.md](docs/02-install.md#claude-desktop).

   For Claude Code, an optional transport bar plugin ships in `clients/claude-code/`; the installer prints its two install commands, see [docs/02-install.md](docs/02-install.md#claude-code-transport-bar).

BatutaMCP installs side by side with other Ableton control-surface scripts (its own folder and its own socket). See [docs/02-install.md](docs/02-install.md).

## Tool names

Tool names are normalized `verb_object` names, and a set of compatibility names and argument shapes is kept so existing music skills keep working (`get_session_info`, `fire_clip`, `add_notes_to_clip`, `set_tempo`, `set_track_mute`, `load_drum_kit`, `create_locator`, `capture_session_to_arrangement`, `get_macros`, `set_macro`, `get_transport`, `health`, ...; arguments such as `track_index`, `clip_index`, `notes` as `[{pitch, start_time, duration, velocity, mute}]`, `path`, `destination_time`). Every safety rule (gain guard, edition limits, `expect_name` pinning, confirmation policy, sample and browser gates) applies the same through every name. There is no telemetry or dataset tool and no `user_prompt` argument. Only `batuta_confirm`, `batuta_status` and `batuta_ears` keep the `batuta_` prefix. The full table, the argument aliases and the list of names not yet available are in [docs/03-tool-names.md](docs/03-tool-names.md).

## Configuration

Server settings live in `~/Library/Application Support/BatutaMCP/server.json` (mode 0600) or in environment variables (`BATUTA_*`). `BATUTA_CONFIG` points to another config file (absolute path, mode 0600, owned by you, in a directory that is not writable by group or others). `BATUTA_LOG_LEVEL` is one of `debug`, `info`, `warn`, `error` (default `info`). The Remote Script never reads any of this.

| Key | Default | Meaning |
|---|---|---|
| `edition` | `auto` | `auto`, `lite`, `standard`, `suite`. Lite limits (8 tracks, 16 scenes, 2 returns) are prechecked. Env `BATUTA_EDITION`. |
| `destructive` | `confirm` | `confirm` allows destructive actions; `disabled` hides them and rejects conditional variants (it wins over `confirm`). Env `BATUTA_DESTRUCTIVE`. |
| `confirm` | `irreversible` | When you are asked. `irreversible`: only for what Live's undo cannot reverse, for gain guard trips, and for every `undo` or `redo` the model calls; deletes and other undoable destructive actions run and report `undoable: true` (Cmd-Z in Live, or the undo tool). `destructive`: ask for every destructive action. Env `BATUTA_CONFIRM`. |
| `gain_guard.max_jump_db` | `6.0` | A volume or gain increase larger than this (in total, per target, within one call) asks for confirmation. Env `BATUTA_MAX_JUMP_DB`. |
| `gain_guard.max_master_db` | `0.0` | A master level above this (master volume, master cue volume, dB gain parameters of devices on the master) asks for confirmation. Env `BATUTA_MAX_MASTER_DB`. |
| `browser.allow_plugins` | `false` | Allow loading VST/AU plugins through the browser tool. |
| `browser.allow_max_for_live` | `true` | Max for Live devices you have installed load and stay (`.amxd`, the `max_for_live` category, stock M4L devices, racks holding them). Set `false` to block them: they are listed as blocked, refused on load, removed right after a load that brings them in, and racks holding them are refused. |
| `browser.allow_external_devices` | `true` | External Audio Effect and External Instrument load and stay. Recording while an external input is live (an armed audio track on a microphone or interface, or an External device) asks you once first. Set `false` to block the devices and refuse such recordings. |
| `browser.allow_user_presets` | `true` | Allow presets from User Library, Packs and the current project, and factory presets that Live lists as plain files (Sounds, Drums). Set `false` to block them (third-party content, see risks). |
| `sample_roots` | `[]` | Optional. Audio import works without it; when set, imports are limited to these directories. |
| `ears.enabled` | `true` | Enable loudness measurement. |
| `ears.max_bytes` / `ears.max_beats` | 256 MiB / 64 | Limits of one measurement (hard max 1 GiB / 64). |
| `ears.roots` / `ears.set_roots` | `[]` / `[]` | Extra directories accepted for Live's temporary and `Samples/Recorded` folders. When `sample_roots` or `ears.roots` is set, `analyze_audio` and `compare_audio` are limited to those and Live's recording folders; with neither set they read any absolute `.wav`/`.aif`/`.aiff` path (regular files only, no symlinks or hard links). |
| `live.idle_release_s` | `120` | Seconds without tool calls after which this session gives Live's single client slot back; `0` never releases. The server connects on the first tool call that needs Live (not at start), and while Live is controlled by another Claude session its calls are refused with `busy` (`details.reason: held_by_other_session`) until that session releases it. See [docs/02-install.md](docs/02-install.md#several-claude-sessions). Config file only. |
| `host.enabled` | `true` | Host automation: `launch_live`, `open_set`, `new_set`, `save_set`, `save_set_as`, `export_audio` ([docs/04-host-automation.md](docs/04-host-automation.md)). `false` removes the six tools. Config file only, no environment variable. |
| `host.live_app` | `auto` | Which installed Live to start: `auto` (the running one, else the edition that connected last, else Suite, Standard, Lite), `suite`, `standard`, `lite`, `intro`, `trial`, `beta`. A second Live is never started. |
| `host.set_roots` | `[]` | Optional: directories where sets may be opened or written. Empty means any folder (the other path rules still apply). |

## Security model

- The server talks to the Remote Script only over a local AF_UNIX socket inside a 0700 directory owned by you, authenticated with a random 32-byte token (file mode 0600). There is no TCP or HTTP listener at all, so web pages and other machines cannot reach it. The MCP side is stdio only.
- Zero runtime dependencies: the server uses Node built-ins only and the Remote Script uses the Python standard library only. The server makes no network calls and sends no telemetry. The only process it can start is in one isolated module (`server/src/host/runner.ts`): `/usr/bin/open` and `/usr/bin/osascript`, with an argv array (no shell), constant AppleScript text and a timeout, for the host automation tools described below.
- No microphone or line-in capture without your say-so. The script refuses to arm audio tracks (except its own temporary measurement track), to monitor "In" on audio tracks and to start recording while an external input is live. When the input is external (a microphone, an interface, an External device), the server asks you **once**, naming the tracks and saying the recording may capture whatever comes in; accept proceeds, decline cancels with nothing done. The acknowledgement is set only by the server, never by a tool argument. Audio tracks with a track or Resampling input stay unarmable, and the temporary measurement track keeps its rules. Measuring Live's own output (ears) records on its own temporary track; with an external input live it asks the same question.
- The Remote Script has no save, open or export command and starts no programs. Host automation lives only in the server, in one isolated module ([docs/04-host-automation.md](docs/04-host-automation.md)): launch Live, open a set, new set, save, save as and open the export dialog. The server writes no files itself: Live saves, from its own menu or Save As dialog. Sets must be inside `host.set_roots`, must end in `.als`, and are never read by BatutaMCP; Save As onto a file that already exists asks you first (and is refused with `destructive: "disabled"`). Opening a set or starting a new one is protected by Live's own "save changes?" dialog. The UI actions need macOS Accessibility permission for the app that runs your MCP client (System Settings > Privacy & Security > Accessibility); without it they fail with `permission_required`. (Live itself writes the ears recordings and its own `.asd` analysis files next to samples; that is Live's normal behavior, not something BatutaMCP does.)
- `.als` sets are never loadable. Max for Live and External devices load by default (`browser.allow_max_for_live`, `browser.allow_external_devices`); with a flag set to `false`, that content is blocked and anything that arrives inside racks or presets, or that Suite shows in native categories, is removed right after loading, possibly after its code already ran. Plugins need `browser.allow_plugins`; user and Pack presets need `browser.allow_user_presets`.
- Confirmation policy: by default (`confirm: "irreversible"`) you are asked only about gain guard trips (large level jumps, a master above its ceiling) and about actions Live's undo cannot reverse. Deletes, note removal and overwriting duplicates run without a prompt because each one is a single Live undo step; the result says `undoable: true` and how to revert (Cmd-Z in Live, or the undo tool). Undo is yours: the model's `undo` and `redo` tools always ask first, whatever the number of steps, because Live's undo stack also holds your own manual edits and any later change drops the redo stack, so a model undo could erase your work for good. Set `confirm: "destructive"` to be asked about every destructive action, or `destructive: "disabled"` to hide and refuse them. When asked, confirmation uses an MCP prompt when the client supports it, otherwise a separate tool `batuta_confirm` with a 60 s single-use token. For unattended sessions, or when the model reads untrusted input (web pages, files, other people's messages), set `confirm: "destructive"` (or `BATUTA_CONFIRM=destructive`) so every destructive action asks. Before a long session, save a copy of the set (File > Save a Copy) so you can always go back. `batuta_status` lists the last 50 destructive actions that ran in this session (time, tool, targets, undoable); it lives in memory only and nothing is written to disk. A confirmation summary lists destructive steps first and in full; if they cannot be described in 500 characters the call is refused (`too_large`) and must be split.
- Honest limit of confirmation: a model can call `batuta_confirm` itself. Keep `batuta_confirm` on "ask" in your client's permissions while other tools are allowed, so you see the summary. If you choose "always allow" for it, that gate is gone. The hard stop is `destructive: "disabled"`. Confirmation protects against accidents and unreviewed model calls, not against you approving something.
- Anything running as your user and able to read the token file is equivalent to you; that is out of scope.

Details: threat model in [docs/01-protocol.md](docs/01-protocol.md) section 1.

## Ears (loudness measurement)

Status: implemented, not yet tested inside a real Live (the owner's test list covers it).

`ears` measures LUFS (momentary, short-term, integrated, loudness range), true peak and spectrum bands for a track or the master, using the BS.1770 / EBU R128 method implemented in pure TypeScript. It records inside Live, without plugins:

- A temporary audio track named `batuta-ears` is created, fed from the source track (post mixer) or from Resampling for the master, recorded for N beats in real time, then removed in one undo step.
- The set is marked as modified, and the undo stack gains several entries. Do not press Undo blindly afterwards.
- The recording is written by Live itself and stays on disk in Live's temporary or `Samples/Recorded` folder. BatutaMCP's server writes nothing and never deletes files.
- On Lite the temporary track uses one of the 8 track slots; with 8 tracks already present the measurement is refused.
- Tools: `batuta_ears {source, beats?, bars?, spectrum?}` (also under the name `record_and_analyze`), `analyze_audio {path}` for an existing WAV or AIFF file inside a configured sample folder or Live's recording folders (read-only), and `compare_audio {a, b}` for the difference between two files or two earlier results. They never ask for confirmation (the only thing they create is their own temporary track, which they remove again) and `destructive: "disabled"` does not hide them. One measurement runs at a time.
- It refuses to run while any track with an external audio input (a microphone or interface) is armed or monitored, and it never records from one.
- The analysis runs in a worker thread of the server (time limit and memory cap), started from a file that ships in the package; the loudness engine is compiled into the server, so there is still nothing to install at runtime.

## Known limitations and risks

- Browser loading sweep window: after loading content, a cleanup pass of about 2 seconds removes Max for Live devices, plugins (unless allowed) and External devices that appeared. During that window a Max for Live device you add by hand at the end of the target track, or a plugin on a track you create by hand next to it, is removed as if it came from the load. One Cmd-Z after a sweep restores the removed device; two undo the load itself.
- Cleanup is not prevention: Suite shows some Max for Live devices in native categories, and these are only removed after they load. Code that already ran during loading cannot be stopped.
- Presets from User Library or Packs (`browser.allow_user_presets`, on by default so factory presets load without setup) are third-party content and can contain Max for Live or plugin devices.
- Gain guard does not cover gain changes made through clip envelopes, loaded presets, or device parameters whose names do not look like gain or volume.
- Cmd-Z: each mutation is one undo step, but a few operations (the ears flow, sweeps) produce several. Check what Undo will do before using it.
- A-items to verify in Live: the script has not yet run inside Live. Items such as how Live reports the edition, track-to-track routing in Lite, and where loaded devices land are assumptions listed in [docs/01-protocol.md](docs/01-protocol.md) section 12.
- Host automation UI scripting (menu titles in English and Spanish, Live's Save dialog, the Live bundle identifier) is unverified until the owner test in Live (docs/04-host-automation.md section 10). A path is checked before use, but Live opens it later: someone who can write inside your set folders could swap it in between.
- macOS only. MCP protocol revisions 2025-11-25 and 2025-06-18 are supported; the stateless 2026-07-28 revision is not.

## Uninstall

```sh
node installer/install.mjs uninstall-instructions
```

prints the manual steps: set the control surface to None, quit Live, move `~/Music/Ableton/User Library/Remote Scripts/BatutaMCP` to the Trash (and `~/Music/Ableton/User Library/BatutaMCP-previous`, the archive of older versions, if present), run `claude mcp remove batutaMCP --scope user`. The installer never deletes anything itself.

## Roadmap

- **OpenAI Codex CLI**: planned. Register BatutaMCP from the installer (Codex runs local MCP servers over stdio like Claude Code). To verify: confirmation prompts (elicitation) and server instructions.
- **ChatGPT**: planned. It needs a remote (HTTP) transport, because ChatGPT connects to MCP servers over the network rather than starting a local process. It will get its own security design (authentication, a local-only listener behind a tunnel) before it ships.

## License

MIT, Copyright (c) 2026 Paul Osinga. See [LICENSE](LICENSE).
