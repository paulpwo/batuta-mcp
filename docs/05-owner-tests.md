# Owner tests in Live (T9)

Run this list once in **Live 12 Lite (12.4.7)** and once in **Live 12 Suite (12.4.3)**. Each step has a checkbox per edition: `[ ]` = to do, `[x]` = passed as expected, `[!]` = differs (write what happened in the Record column), `n/a` = does not apply to that edition.

Every `[A]` id (A1 to A41) is an assumption from `docs/01-protocol.md` section 12; `H1` to `H15` are the host-automation assumptions from `docs/04-host-automation.md` section 10. The "Confirms" column says which one a step settles. Section 12 at the end indexes them and lists the ones with no step.

Section 10 (ears) needs T7; run it last, after it lands. Sections 0 to 9 and 11 can be run now.

## Before you start

- Use a **scratch set**, never one you care about. Run File > Save a Copy of anything open first.
- Lower the speaker and headphone volume. Sections 3, 4 and 10 deliberately raise levels or arm tracks.
- Keep Live's log open: `tail -f` the newest `~/Library/Preferences/Ableton/Live 12.*/Log.txt` and look for lines mentioning BatutaMCP.
- Prompts below are written for Claude Code with the `batutaMCP` server registered. You may also name the tool directly ("call `create_midi_track` with ..."); the tool name and arguments are what is being tested.
- "Ask" = the confirmation prompt (an MCP dialog, or the two-step `batuta_confirm`). Note which of the two you saw.
- Cmd-Z is Live's own undo (Edit menu shows what it will undo).
- Do not paste real passwords, tokens or the contents of `~/Library/Application Support/BatutaMCP/token` anywhere.
- One edition at a time: quit Live, start the other edition, change the control surface only if Live forgot it. The sets in the scratch folder can be shared by both.

---

## 0. Install and connect

| # | Do | Expect | Record | Confirms | Lite | Suite |
|---|---|---|---|---|---|---|
| 0.1 | Terminal: `node installer/install.mjs install --dry-run`, read the plan, then `install`, then `verify` and `status`. Use the absolute path of the repo. | Plan lists only new files under `~/Music/Ableton/User Library/Remote Scripts/BatutaMCP/`. Nothing deleted. Other folders in Remote Scripts untouched. `verify` OK. | Any warning text. | - | [ ] | [ ] |
| 0.2 | `cd server && pnpm install --frozen-lockfile && pnpm run build`. Then `ls -l server/dist/src/bin.js`. | Build OK, no install-script prompts. `bin.js` is `-rwxr-xr-x`. | `ls -l` line. | - | [ ] | [ ] |
| 0.3 | In Live: Settings > Link, Tempo & MIDI > Control Surface: pick **BatutaMCP**, Input and Output None. Restart Live. Then `ls -ld "$HOME/Library/Application Support/BatutaMCP"` and `ls -l` inside it. | BatutaMCP is listed (no error dialog). Folder mode `drwx------`, `token` is `-rw-------`, `live.sock` exists. Log.txt has one startup line, no traceback. | Log.txt lines mentioning BatutaMCP. `echo -n "$HOME/Library/Application Support/BatutaMCP/live.sock" \| wc -c` (must be under 104). | A1 (plain `create_instance` accepted), A21 (socket path length) | [ ] | [ ] |
| 0.4 | Register: run the exact `claude mcp add --scope user batutaMCP -- '<node>' --disallow-code-generation-from-strings '<abs>/server/dist/src/bin.js'` line printed by the installer (see `docs/02-install.md` step 5). Start a new Claude Code session, run `/mcp`. | `batutaMCP` shows connected. Keep `batuta_confirm` on "ask" in permissions. | The tool count shown. | - | [ ] | [ ] |
| 0.5 | Prompt: "Call `batuta_status` and show me everything." | Connected, script version, protocol version, Live version, edition `lite` / `suite` with source `hint` (the server's hint from the running app; the version string does not carry the edition on Lite 12.4.7, A3), safety config (`confirm: irreversible`, gain guard 6.0 / 0.0). | Exact `live_version` string and the edition with its source. | A3 (edition from version string, verified false) | [ ] | [ ] |
| 0.6 | Hide Live (Cmd-H) so another app is in front, wait 20 s. Prompt: "Set the tempo to 101, then read it back with `get_session_info`." Then unhide Live. | Tempo changes within a couple of seconds even with Live in the background; Live shows 101 once visible. | Seconds the call took in background. | A2 (`update_display` tick in background) | [ ] | [ ] |
| 0.7 | In Live set the control surface to None, wait 5 s, set it back to BatutaMCP (no restart). Prompt: "`get_session_info`". | The server reconnects (maybe after one error), tool works again. No stale socket error. | Any error text on the first call. | A1 | [ ] | [ ] |
| 0.8 | Prompt: "Call `batuta_status`; show only the `host` block." Leave macOS Accessibility **OFF** for now. | `host.enabled` true, installed Live apps found, selected app is the edition you are running (equal to the running edition from 0.5), `accessibility: unknown`, `set_roots_count` 2 (defaults `~/Music/Ableton` and `~/Documents/PRODUCTION`). | The `apps` list. | H1 (bundle check passes) | [ ] | [ ] |

---

## 1. Read-only

Open a scratch set with a few tracks (one MIDI, one audio, one return).

| # | Do | Expect | Record | Confirms | Lite | Suite |
|---|---|---|---|---|---|---|
| 1.1 | "Call `get_session_info`." | tempo, signature, track/return/scene counts, `can_undo`, `live_version`, `clip_trigger_quantization` as `{index, label}`. Matches what Live shows. Nothing changes in the set (no new undo entry). | Counts, quantization label shown. | - | [ ] | [ ] |
| 1.2 | "Call `list_tracks`, `list_scenes`, `list_cue_points`, `get_undo_state`." | Names/indices match Live. Master and returns are listed. | Any name or order mismatch. | - | [ ] | [ ] |
| 1.3 | "Call `get_session_snapshot`." | One aggregate with tracks, devices, parameters, notes, arrangement clips. `truncated: false` on a small set. No data sent anywhere. | Seconds taken; `truncated` value. | - | [ ] | [ ] |
| 1.4 | "Call `get_browser_tree` once for each: instruments, sounds, drums, audio_effects, midi_effects, packs, user_library, samples, current_project." | Top-level items listed for each category your edition has; absent categories give `not_supported`. | Which categories exist on this edition. | A18 | [ ] | [ ] |
| 1.5 | "Call `get_browser_tree` for `max_for_live`, then for `plugins`. Then call `list_browser_items` for `plugins`." | `get_browser_tree` has a fixed category list that leaves out both, so each answers `invalid_args` from the schema before anything reaches Live (intentional: plugins and Max for Live are only reachable through `list_browser_items`). `list_browser_items` for `plugins`: served with the default config (`browser.allow_plugins` true); with it set to false it answers `not_supported` (`disabled_by_config`). `list_browser_items` for `max_for_live`: served with the default config (`browser.allow_max_for_live` true); with it set to false it answers `not_supported` (`blocked_content`). | Exact error codes and reasons. | (browser rules, section 7.10) | [ ] | [ ] |
| 1.6 | "Call `get_remote_script_info` and `health`." | Connection, versions, edition; `health` equals `batuta_status`. | - | A3 | [ ] | [ ] |
| 1.7 | "Set the tempo to 101 (`set_tempo`)", then "create a clip (`create_clip`)". Then "call `get_session_info`." | After each change Live's status bar (bottom info line) shows a `BatutaMCP: ...` line (for example `BatutaMCP: song_set tempo=101`). `get_session_info` shows nothing new. No track or clip names appear in the line. | The exact lines shown. | - | [ ] | [ ] |

---

## 2. Tracks, clips, notes, scenes, devices

Use a clean scratch set. After each mutating step, look at Live's Edit menu: it must show one undo entry for the step.

| # | Do | Expect | Record | Confirms | Lite | Suite |
|---|---|---|---|---|---|---|
| 2.1 | "Call `create_midi_track` named `T9 MIDI`." | New MIDI track at the end, named correctly. Edit menu shows an undo entry. Cmd-Z removes it; Cmd-Shift-Z brings it back. | Is the new track selected? | A19 | [ ] | [ ] |
| 2.2 | "Call `create_audio_track` named `T9 Audio`." Look at which track is selected in Live. | New audio track at the end. | Selected track after: the new one, or the old one? | A10 | [ ] | [ ] |
| 2.3 | "Call `create_clip` on the MIDI track, `clip_index` 0, length 4 beats." | Empty 4-beat clip appears in slot 1. | - | - | [ ] | [ ] |
| 2.4 | "Add notes with `add_notes_to_clip` (`track_index`, `clip_index` 0): C3 at 0, E3 at 1, G3 at 2, C4 at 3, each 0.5 beats, velocity 100. Then `get_clip_notes`." | 4 notes show in the piano roll; the read returns 4 notes, each with a `note_id`. | Whether `note_id` values are present and stable across two reads. | A12 | [ ] | [ ] |
| 2.5 | "Use `modify_clip_notes` to set the velocity of the E3 note to 40 by its `note_id`. Then `remove_notes_from_clip` with only that `note_id`. Then `clear_notes_from_clip`." | E3 velocity changes to 40; that single note disappears; then all notes disappear. Each is one undo entry. | Any error naming `note_id`, or a fallback to range removal. | A12 | [ ] | [ ] |
| 2.6 | Re-add four off-grid notes (e.g. starts 0.07, 1.13, 2.21, 3.04). "Call `quantize_clip_notes` with grid `1/4`." Cmd-Z. Repeat with grid `1/16`. Then once with `pitch` set to one of the pitches. | `1/4`: notes snap to beats. `1/16`: to sixteenths (not eighths, not thirty-seconds). With `pitch`, only that pitch moves (or `not_supported`). | The grid you actually saw for 1/4 and 1/16; result of the pitch form. | A13, A27 | [ ] | [ ] |
| 2.7 | Re-add notes. "`fire_clip` track 0 clip 0, wait 5 s, `stop_clip`." Then "`start_playback`, then `stop_playback`." | Clip plays from the next launch boundary; stops. Transport starts and stops. | Delay until it started (is it the global quantization?). | - | [ ] | [ ] |
| 2.8 | "Create a scene named `T9 Scene A` (`create_scene`), rename it (`set_scene_name`), set its tempo 90 (`set_scene_properties`), set its time signature 3/4, then set the time signature to null (disabled)." | Scene appears and renames. Tempo and signature show on the scene. Setting null turns the scene signature off, or the tool answers `not_supported`. | Result of the null time signature. | A29 | [ ] | [ ] |
| 2.9 | "`duplicate_clip` the slot-0 clip with no target." Look for a new scene. Then in Live build a **group track** with 2 tracks inside by hand, and call `duplicate_track` on the group. | The first creates a clip in the next free slot, and may append a scene. The second copies the group and its 2 children. | Did a scene get created? Number of tracks created by the group duplicate. | A33 | [ ] | [ ] |
| 2.10 | With the transport **stopped**: "Call `create_locator` at beat 8 named `L1`", then at beat 16 `L2`. Then "`delete_cue_point` the one at beat 8." Then start playback and call `create_locator` at beat 24. | L1 and L2 appear at the right positions. Deleting L1 leaves L2 untouched and the playhead where it was. While playing, the tool refuses with `transport_running` and says to stop playback first. | Positions of the remaining cues; whether the playhead moved. Any case where the neighbouring cue was toggled. | A16 | [ ] | [ ] |
| 2.11 | "Call `duplicate_to_arrangement` for track 0 clip 0 at beat 0." Repeat at beat 2 (overlap) without `allow_overwrite`. Repeat with `allow_overwrite` true. Then "`set_arrangement_clip_name`", "`get_arrangement_clips`", and "`capture_session_to_arrangement` scene 0 at beat 32." | First: arrangement clip at 0. Overlap: refused. With `allow_overwrite`: overlapped region is replaced (check the arrangement), one Cmd-Z undoes it. Scene capture copies the scene's clips at beat 32 without playing. | What `allow_overwrite` actually did to the old clip (replaced / trimmed / left). | A15 | [ ] | [ ] |
| 2.12 | **Audio import** (no configuration needed; optionally set `sample_roots` in `server.json` to test the narrowing, then restart the server). "Call `create_audio_clip` with `file_path` of a short `.wav` (any folder, absolute path), on the audio track, slot 0." Then the arrangement form with `position` 0. Compare the clip length with the file. `ls` the sample folder. | A session clip and an arrangement clip appear. Length in beats matches duration and tempo (or the tool says warping changed it). Live may create `<name>.asd` next to the sample. | Clip length vs file length (with warp on); sample rate shown by `get_clip_info`; whether `.asd` appeared; any `not_supported` on the session form. | A14, A30, A32, A37 | [ ] | [ ] |
| 2.13 | "On the MIDI track call `insert_device` `Reverb`; on the master `Limiter`; on a return `Utility`. Then `list_devices` for each, `get_device_parameters`, `set_device_parameter` (Dry/Wet 50 %), `set_device_enabled` false, `delete_device`." | Devices appear where asked (also on master and return), parameters change, disable works, delete works. Each is one undo entry. | `class_name` of each device from `list_devices` (native devices). | A24, A11 | [ ] | [ ] |
| 2.14 | **Racks.** `insert_device` `Instrument Rack` and `Drum Rack` on a MIDI track. Then: `insert_rack_chain`; `insert_device` into that chain; delete it again; `set_rack_variation` store, recall, randomize, delete; `list_drum_pads`; `copy_drum_pad` and `clear_drum_pad` on a loaded pad. | Each action works or returns a clear `not_supported`. Pad copy overwrites the target; clear empties the pad. | For each of: insert chain, insert device in chain, delete device in chain, variation store/recall/delete/randomize, pad copy, pad clear: worked / `not_supported`. | A11, A17, A28 | [ ] | [ ] |
| 2.15 | In a clip with notes: `set_clip_envelope` on track volume (a short ramp), then `get_clip_envelope`, `clear_clip_envelope`. | Envelope shows in the clip's Envelopes tab; read returns the points; clear removes it. | Any rejected parameter. | - | [ ] | [ ] |

---

## 3. Mixer and gain guard

Speakers low. The master step can produce loud output: decline the first prompt of 3.6.

| # | Do | Expect | Record | Confirms | Lite | Suite |
|---|---|---|---|---|---|---|
| 3.1 | "Set the volume of the MIDI track to -12 dB with `set_track_volume` (`volume_db`)." Then "`get_mixer` for that track." | Live's fader displays -12.0 dB. `volume_db` reads about -12. | Fader display text vs `volume_db`. | A22 | [ ] | [ ] |
| 3.2 | Read `get_mixer` at three fader positions you set by hand: 0 dB, -inf, +6 dB. | `volume_db` numeric for 0 dB and +6 dB; `null` (raw only) for -inf if the display is not parsable. | The three `display` strings and `volume_db` values. | A22 | [ ] | [ ] |
| 3.3 | "Set pan -0.5 (`set_track_pan`), send A to 0.5 (`set_track_send`), mute and solo on and off." | Controls move in Live. | - | - | [ ] | [ ] |
| 3.4 | From -12 dB: "raise it to -5 dB" (7 dB jump). Decline the Ask. Then repeat and accept. Then "raise from -12 to -7" (5 dB). | 7 dB: Ask appears with a summary naming the track and levels. Declined: fader unchanged. Accepted: -5 dB. 5 dB: no Ask. | Ask style (MCP dialog or `batuta_confirm`). | (gain guard, section 9.4) | [ ] | [ ] |
| 3.5 | From -5 dB: "set it to -40 dB." | A large decrease never asks. | - | - | [ ] | [ ] |
| 3.6 | Set the master to 0 dB by hand. Prompt: "set the master volume to +1 dB." **Decline.** Then "set the master to -3 dB." | +1 dB asks (master above its ceiling). Declined: unchanged. -3 dB: no Ask. | - | - | [ ] | [ ] |
| 3.7 | Put a `Utility` on the master (`insert_device`). "Set its Gain to +3 dB." Decline. | Asks (master ceiling applies to dB gain parameters in the master chain). | Parameter name and `display` text. | - | [ ] | [ ] |
| 3.8 | `insert_device` `Instrument Rack` on a MIDI track. "Call `get_macros` for it, then `set_macro` macro 1 to its maximum." Then map Macro 1 to Utility Gain by hand if you can and repeat. | `get_macros` lists `Macro 1` to `Macro 16` and their `display`. Setting works. If a macro's display ends with "dB", a jump over 6 dB asks. | The `display` string of a default macro and of a macro you mapped to a dB parameter; whether macro k is parameter k. | (gain guard `Macro n`, macro layout) | [ ] | [ ] |
| 3.9 | "In one `batch`: create a MIDI track and raise the new track's volume by 8 dB." | The gain-checked op after an index-shifting op trips: Ask appears (or the batch is refused). | Behaviour. | - | [ ] | [ ] |
| 3.10 | Play a clip; "`get_track_meter` for the track and `get_master_meter`." | Non-zero values while playing, near zero when stopped. | - | - | [ ] | [ ] |

---

## 4. Recording safety (no microphone, no line-in)

**Safety:** nothing should be monitored for real here. Unplug the microphone or turn Live's input monitoring off by hand, and keep speaker volume low (feedback).

| # | Do | Expect | Record | Confirms | Lite | Suite |
|---|---|---|---|---|---|---|
| 4.1 | "Arm the MIDI track (`set_track_arm`)." | Arm button lights. | - | - | [ ] | [ ] |
| 4.2 | "Arm the audio track `T9 Audio`." | With the track on an external input (`Ext. In`): the server **asks once** (names the track, says the recording may capture a microphone). Accept: the arm button turns on. Decline: result `cancelled`, the button stays off. With a SAFE input (a track or Resampling): refused, `audio_arm_blocked`. | Exact error text. | (rule 1) | [ ] | [ ] |
| 4.3 | "Set the audio track's monitoring to In (`set_track_properties` `monitoring_state` 0)." Then Auto (1), then Off (2). Read `get_track_info` after each. | In: refused `monitor_in_blocked`. Auto and Off: accepted and the Monitor buttons in Live match. | Which values Live reports for each state, and the property names present in `get_track_info`. | A31 | [ ] | [ ] |
| 4.4 | "Call `get_routing` for the audio track." Also for a return and for a MIDI track. | Input list includes `Ext. In`, `Resampling`, other track names, `No Input`; channel list includes `Post FX` / `Post Mixer` / `Pre FX`. Returns appear as `A-Name` style. | The complete `available_types` and `available_channels` for audio track, return and (Lite vs Suite) any differences; whether a track input exists at all in Lite. | A6, A7, A35 | [ ] | [ ] |
| 4.5 | Rename an audio track to `Ext. In` (`set_track_name`). Then "route the other audio track's input to `Ext. In`" and "arm it". | Routing by that name: refused as ambiguous or non-safe (not silently picked). Arm: `Ext. In` is external, so it asks; decline cancels, accept arms. | Exact error and any candidate list. | A35 | [ ] | [ ] |
| 4.6 | "Route the audio track's input to the MIDI track `T9 MIDI` with channel `Post Mixer`." (leave it **unarmed**) | Accepted (a track source is safe). Arming it by tool is still refused (a track source is SAFE, so there is no question to accept). | Accepted? Channel names offered. | A7, A35 | [ ] | [ ] |
| 4.7 | "Create an audio track named `batuta-ears`." Then "rename `T9 Audio` to `batuta-ears`." | Both refused (reserved name). | Error text. | (spec 5.6) | [ ] | [ ] |
| 4.8 | "Call `insert_device` with name `External Audio Effect`." Then `External Instrument`. | Default config (`browser.allow_external_devices` true): both are inserted. With `browser.allow_external_devices: false`: both refused, `not_supported` (`blocked_content`). | - | A38 | [ ] | [ ] |
| 4.9 | By hand, drag **External Audio Effect** onto a scratch audio track, and **External Instrument** onto a scratch MIDI track. Prompt: "`list_devices` for those tracks and show the raw `class_name` of each." Also for a native device and an Instrument Rack on other tracks. | Devices are listed. | **The exact `class_name` strings** for External Audio Effect, External Instrument, a native effect, a rack (and the device `name`). | A38, A24 | [ ] | [ ] |
| 4.10 | With the External Audio Effect from 4.9 still on its track: "turn on record mode (`set_song_properties` `record_mode` true)", "`trigger_session_record`", "`fire_clip` on an empty slot of an armed MIDI track", "`duplicate_track` of the External track". Then "`start_playback`" with record flags off. | Each record-start command and the duplicate **asks once** naming the track (the recording may capture whatever comes in through the external input). Accept: it proceeds. Decline: `cancelled`, nothing changes. A `batch` holding one of them asks once before anything runs. Plain playback with record flags off is allowed without a question. | The question text and the tracks it names; accept and decline results. | A38 (and spec 5.6 rules 4 and 6) | [ ] | [ ] |
| 4.11 | Delete the External devices by hand. Repeat one record command from 4.10. | The gate clears; the command now works (turn record mode off after). | - | - | [ ] | [ ] |
| 4.12 | By hand arm an audio track (not by tool), then "`duplicate_track` that track". Then duplicate it by hand with Cmd-D and look at the copy's arm button. | Tool: for an armed audio track on an external input it asks once (`external_input_live`; accept duplicates, decline cancels); an armed audio track with a SAFE input is still refused, `audio_arm_blocked`. Hand duplicate: note whether Live copies the arm state. | Does Live copy arm state on duplicate? | A41 | [ ] | [ ] |
| 4.13 | T9s. With the External device from 4.9 on a scratch track, ask for record mode on and accept. Then add a second External device on another track by hand and ask for `trigger_session_record`. Then turn record mode on and ask `insert_device` `External Audio Effect` on a third track. In a client without questions (or with elicitation off), repeat a record command. | The second command asks again naming BOTH tracks (the first answer does not cover the new track). The insert asks naming the target track. Without questions: refused with "needs your confirmation and this client cannot ask", no `confirm_id` is given and `batuta_confirm` cannot release it. With more than 8 external tracks the question ends with "and N more". | The question texts; whether the second question lists both tracks. | spec 5.6 | [ ] | [ ] |

---

## 5. Browser

| # | Do | Expect | Record | Confirms | Lite | Suite |
|---|---|---|---|---|---|---|
| 5.1 | "`get_browser_tree` for `instruments`; pick a Core Library native instrument; `load_instrument_or_effect` onto the MIDI track." Then a native effect from `audio_effects` onto the audio track. | Loads without any opt-in. Device appears; `device_count` goes up. | Device names loaded. | A18 | [ ] | [ ] |
| 5.2 | **URI marker for A39.** "List `sounds` and `drums` (with `list_browser_items`) and show the raw `uri` of: (a) a Core Library preset, (b) a preset from an installed Pack reached in the same view, (c) a User Library preset, (d) a sample." Also `blocked` and `is_loadable` for each. | Items listed. A Core preset should be loadable without opt-in if the script can prove the source; otherwise it is `blocked: user_content` (fail closed). | **Paste the exact URI strings for (a), (b), (c), (d) and each `blocked` value.** Is there a visible Core Library marker in (a) that (b) and (c) lack? | A39 | [ ] | [ ] |
| 5.3 | Try to load the Core preset from 5.2(a). | Loads if the marker was recognized; else refused with `blocked_content`. | Outcome. | A39 | [ ] | [ ] |
| 5.4 | Pack preset: try to load 5.2(b) with the default config (`allow_user_presets` is true by default, so it loads). Then set `browser.allow_user_presets` to `false` in `server.json`, `/mcp` reconnect, try again, then remove the line. | Default: loads. With `false`: refused. | Both outcomes. | A39, A36 | [ ] | [ ] |
| 5.5 | `max_for_live`: list it, search it for anything (`search_browser`). Try to load any `.amxd` you have by URI copied from another view. | Default config: `max_for_live` is served and its devices and `.amxd` files load and stay. With `browser.allow_max_for_live: false`: never served, never loaded, `not_supported` (`blocked_content`). On Lite, no Max category exists at all. | Lite: category absent? Suite: error text. | A36 | [ ] | [ ] |
| 5.6 | **Suite only.** List `instruments`, `audio_effects`, `midi_effects`: look for any item that is Max for Live in disguise (`blocked: max_for_live`, or `class_name` starting with `Max`). If you accept running one M4L device once, load a stock one from a native category. Also load a Suite factory rack that is known to hold Max devices. | Default config: M4L items are listed with `blocked: null`, load, report their real `class_name` and are not removed; a rack holding M4L loads too. To see the block set `browser.allow_max_for_live: false` (restart the MCP server and Live): items are shown as blocked, or removed again right after load, and racks with M4L inside are refused. | Which items matched; for a load: removed or not, and the result fields (`verified`, `sweep_pending`). | A23, A24, A36 | n/a | [ ] |
| 5.7 | Plugins: with default config, try loading an AU/VST (by tool). By hand, put an AU and a VST3 plugin on a scratch track and `list_devices` it. | Tool: refused (`disabled_by_config`). List shows the plugin devices. | The `class_name` strings of each plugin type. | A24 | [ ] | [ ] |
| 5.8 | **Load on master and on a return.** "Load an audio effect onto the master, and onto return A." Then "load an instrument onto the master." Note the selected track before and after. | Effects load on master and return. The instrument does not land (`verified: false`, `sweep_pending`) or is refused. Selected track is restored. | Result fields. Was the selection restored? Where did the effect land (end of chain)? | A18, A23 | [ ] | [ ] |
| 5.9 | **Async load and sweep.** Load a heavy rack or instrument. Immediately show the whole result. Wait 3 s and call `get_session_info`; look for `pending_sweeps` and `recent_sweeps`. | Either `verified: true` right away, or `verified: false` + `sweep_pending: true` followed by an empty `pending_sweeps` and a `recent_sweeps` entry. | `verified`, `sweep_pending`, seconds until the sweep ended; whether `load_item` returned before the device existed; where it landed (appended vs replaced instrument). | A23 | [ ] | [ ] |
| 5.10 | **Sweep interference** (documented risk). Load an effect, and within 2 s add another effect by hand at the end of the same track. Then Cmd-Z once. | The hand-added device may be removed as if it came from the load. One Cmd-Z restores it; two undo the load. | Was the hand-added device removed? | A23 (README risk) | [ ] | [ ] |
| 5.11 | **URI lifetime.** List a folder, load item X, list another folder, load X again by the **same** uri. Then restart the MCP server (`/mcp` reconnect) and try an old uri. | Same uri loads twice in a session. After reconnect an old uri is refused (`not_supported`: list again). | Behaviour of both. | A18 | [ ] | [ ] |
| 5.12 | "Call `load_drum_kit` on a MIDI track with the default rack and a `kit_path` from `drums`." | Drum Rack loads, then a kit. Or a clean `not_found` if the folder is not there. | The `kit_path` that worked; where Live's own Drum Rack was found (`instruments` or `drums`). | A18 | [ ] | [ ] |

---

## 6. Edition limits

Lite: 8 tracks, 16 scenes, 2 returns. Suite: unlimited tracks and scenes, 12 returns. (Count audio + MIDI tracks; returns and master are separate.)

| # | Do | Expect | Record | Confirms | Lite | Suite |
|---|---|---|---|---|---|---|
| 6.1 | **Lite.** Empty set. "Create MIDI tracks until you have 8, then a 9th." | 8th works (last free slot allowed). 9th is refused with `edition_limit` before Live is touched. | The full `details` (resource, limit, current, edition). | A3 | [ ] | n/a |
| 6.2 | **Lite.** With 8 tracks: `duplicate_track`; a `batch` that creates a track; a 17th scene; a 3rd return. | Each refused with `edition_limit` and the right `resource`. | Details for each. | A3, A33 | [ ] | n/a |
| 6.3 | **Suite.** Create 12 tracks, 20 scenes, and returns up to 12; then a 13th return. | All work. No edition error for tracks or scenes. The 13th return is refused (by the tool or by Live). | The error text for the 13th return and who refused it. | A3 | n/a | [ ] |
| 6.4 | **Suite, project that came from Lite.** Open a set with 8 tracks and add 2 more. | Works. | - | - | n/a | [ ] |

---

## 7. Undo and confirmations

| # | Do | Expect | Record | Confirms | Lite | Suite |
|---|---|---|---|---|---|---|
| 7.1 | Make a clip with notes. "Delete the clip (`delete_clip`)." | **No prompt.** Result says `undoable: true` and "Cmd-Z in Live". Cmd-Z restores the clip with notes. | - | A19 | [ ] | [ ] |
| 7.2 | "Delete the track `T9 MIDI` (`delete_track`, with `track_index`)". Then with a wrong `expect_name`. | Runs without a prompt, one Cmd-Z restores it. A wrong `expect_name` is refused. | - | A19 | [ ] | [ ] |
| 7.3 | "In one `batch`: create a MIDI track, create a clip on it, add 4 notes." Look at the Edit menu, press Cmd-Z once. | Exactly one undo entry; one Cmd-Z removes everything. | If it needed more than one Cmd-Z. | A19 | [ ] | [ ] |
| 7.4 | "Use the `undo` tool." Decline, then accept. Then "use `redo`." | `undo` always asks (and so does `redo`). Declined: nothing happens. Accepted: the last action undone. | Ask style (dialog or token). | A19 | [ ] | [ ] |
| 7.5 | If you got the `batuta_confirm` token flow: wait 70 s then confirm. Also repeat a confirmation with an edited summary. | Expired: `confirm_expired`. Summary mismatch: `confirm_summary_mismatch`. | Which flow your Claude Code version used (dialog or token). | - | [ ] | [ ] |
| 7.6 | **Undo history limit.** Prompt: "Call `set_tempo` 100, 101, 102 ... up to 220, each as a separate call; then `get_undo_state`." Then "call `undo` with `steps` 10", accept each prompt, repeat until `undone` is less than 10. Add the totals. | `can_undo` true after the loop. The sum of `undone` is Live's undo depth. | **Total undone** (the history limit this Live keeps); also whether Live had other limits (memory). | A19 | [ ] | [ ] |
| 7.7 | Set `BATUTA_CONFIRM=destructive` (or `confirm: "destructive"` in `server.json`), reconnect. "Delete a clip." Then set it back. | Now asks for every destructive action. | - | - | [ ] | [ ] |
| 7.8 | Set `destructive: "disabled"`, reconnect. Run `tools/list`. Then set it back. | Delete tools are not listed; conditional variants (`allow_overwrite`) are rejected. | - | - | [ ] | [ ] |

---

## 8. Views, quantization, song properties

| # | Do | Expect | Record | Confirms | Lite | Suite |
|---|---|---|---|---|---|---|
| 8.1 | "`switch_to_arrangement_view`", then "`switch_to_session_view`", then `show_view` for each of `session`, `arrangement`. | Live's main view switches each time. | Any view name that errors. | (view names [A]) | [ ] | [ ] |
| 8.2 | "`focus_view` `detail_clip`", then `detail_device`, then `browser`. Select a clip and a device by hand first. | The matching panel gets focus. | **Which of the Live view names worked** (Session, Arranger, Detail/Clip, Detail/DeviceChain, Browser) and which failed. | (view names [A]) | [ ] | [ ] |
| 8.3 | "`get_view` for each view." | Visible/focused flags match what you see. | - | - | [ ] | [ ] |
| 8.4 | "Set `clip_trigger_quantization` to indexes 0 to 13, one by one (`set_clip_trigger_quantization`)." Look at the Control Bar's Global Quantization menu each time. | The reported label equals the menu item. | **The index to menu-label table you observed** (compare to: none, 8 bars, 4 bars, 2 bars, 1 bar, 1/2, 1/2T, 1/4, 1/4T, 1/8, 1/8T, 1/16, 1/16T, 1/32). | (quantization order [A], spec 7.1) | [ ] | [ ] |
| 8.5 | "Set it by label `1 bar` and `1/16`." Fire a clip and note the delay. | Label form works; delay matches the setting. | - | - | [ ] | [ ] |
| 8.6 | "`set_metronome` on/off, `set_time_signature` 3/4, set the song loop (`set_song_properties` `loop` true, start 0, length 8), `set_song_position` 16." | Each is reflected in Live. | - | - | [ ] | [ ] |
| 8.7 | In Claude Desktop: "show the transport panel". | A panel renders inline in the chat with four symbol buttons (⏮ ⏪ ▶ ⏩, drawn as plain text glyphs, no blue emoji boxes) and a line like `Stopped  bar 1.1  120.0 BPM  4/4`. | Whether it rendered, and its look in light and dark mode. | (MCP Apps in Claude Desktop) | [ ] | [ ] |
| 8.8 | Click ▶ (it turns into ⏹), then ⏹, then ⏩ twice, then ⏪ once, then ⏮. Keep Live's Arrangement visible. | Live plays and stops; the playhead moves to the next bar line each `>>`, to the previous one on `<<`, and to the start on `\|<`. The line updates within about 4 s (1 s while playing). | Any button that did nothing, or a position that is off by a bar or a beat. | - | [ ] | [ ] |
| 8.9 | Quit Live with the panel open, wait 10 s, then reopen Live and the set. | The line says "Live not connected" and the buttons are disabled; after Live is back the panel recovers without being reopened (within about 5 s) and the buttons work. | How long recovery took. | - | [ ] | [ ] |
| 8.10 | With the panel in the chat, look for the float button (⧉). Press it, scroll the chat, then press the dock button (⤓). | The float button appears only if the host offers picture-in-picture (a host without it shows neither button). Pressing it floats the panel so it stays visible while the chat scrolls, and the float button is replaced by the dock button; dock returns the panel to the chat and brings the float button back. | Whether the float button was shown, and whether the host floated and docked the panel. | - | [ ] | [ ] |

---

## 9. Host automation

Needs macOS permissions. Order matters: test without Accessibility first. Server config: `host.enabled` true. Create a test folder anywhere, for example `mkdir -p ~/Music/Ableton/T9test` (`host.set_roots` is empty by default: no folder restriction). All `.als` paths below are absolute under it, for example `/Users/<you>/Music/Ableton/T9test/a.als`.

| # | Do | Expect | Record | Confirms | Lite | Suite |
|---|---|---|---|---|---|---|
| 9.1 | Quit Live. "Call `save_set`." Then look: is Live running? | Error `not_supported` (`live_not_running`), hint to call `launch_live`. **Live stays closed.** | Is Live still closed? | H2 | [ ] | [ ] |
| 9.2 | "Call `launch_live`." Then again. | First: Live starts (`action: launched`, `was_running` false). Second: Live comes to the front (`activated`). | Seconds to start. | (`open -a`) | [ ] | [ ] |
| 9.3 | Terminal (read-only): `defaults read "/Applications/Ableton Live 12 Suite.app/Contents/Info" CFBundleIdentifier` (use `Lite` in the name for Lite), and `osascript -e 'tell application "System Events" to get name of every process whose bundle identifier is "com.ableton.live"'`. Also `plutil -p` on the same Info.plist; XML or binary? | Identifier is `com.ableton.live`; the process name comes back (it may ask for permission first); the plist is XML. | Identifier, process name (probably `Live`), plist type. | H1, H15 | [ ] | [ ] |
| 9.4 | Accessibility **off**. "Call `new_set`." | Error `permission_required` with `details.permission: accessibility` and instructions. | **The exact `details.detail` line and its error number** (-25211 or -1719?). | H6, H12 | [ ] | [ ] |
| 9.5 | System Settings > Privacy & Security > Accessibility: enable the app that runs your MCP client (Terminal, iTerm, Claude, ...). Restart that app. | A first UI call may also ask to let it control System Events: allow. `batuta_status` shows `host.accessibility: granted` after one UI action. | Name of the app you enabled. | H6 | [ ] | [ ] |
| 9.6 | Make an edit in Live (set dirty). "Call `new_set`." Then cancel in Live. With a clean set: "`new_set`" again. | Dirty set: Live's own "save changes?" dialog appears (BatutaMCP asks nothing in the default policy). Clean: an untitled set opens. | Did anything fail with a script/env error (the scripts run with only `HOME`, `PATH`, `LANG`)? | H8 | [ ] | [ ] |
| 9.7 | Terminal (read-only): `osascript -e 'tell application "System Events" to tell process "Live" to get name of every menu item of menu 1 of menu bar item "File" of menu bar 1'`. | Lists the File menu titles. | **The exact titles of: New Live Set, Save Live Set, Save Live Set As..., Export Audio/Video...**, and which ellipsis character they use (`...` or `…`). | H3 | [ ] | [ ] |
| 9.8 | In an untitled set: "Call `save_set`." Time the dialog. Cancel it in Live. Then open a saved set, edit it and "`save_set`". | Untitled: result `save_dialog_open` and the dialog is visible within about 1 s. Saved set: saved silently (title bar dirty mark clears). | Seconds until the dialog shows; result strings. | H4 | [ ] | [ ] |
| 9.9 | "Call `save_set_as` with path `<root>/a.als`" (absent file). | The panel is moved to the folder (Go to Folder, Cmd-Shift-G and Return sent only while Live is frontmost; nothing typed into other apps), the name is set, Where: and the name are checked before Save. Result `saved`; `path` is the file written (Live may create `<name> Project/<name>.als`). File exists (`ls -l`). Live's title bar shows `a`. | Did it end in `path_not_applied`? Role and name of the text field and the default button (Save / Guardar). | H5, H9 | [ ] | [ ] |
| 9.10 | Edit the set. "`save_set_as` to the same path." (When the set lives in `<name> Project/<name>.als` the Ask names that file.) **Decline** the Ask, check the file. Repeat and **accept**. Check the file with `stat -f '%Sm %i' file` before and after. | Ask names the path. Declined: file unchanged. Accepted: the panel goes into the `<name> Project` folder, the replace sheet is clicked, result `saved` with `replaced: true`, the file's time moved forward and no `<name>-1 Project` folder appears. | **The exact text of Live's replace sheet** (quotes ASCII or curly?); button names (Replace / Cancel); any `replace_unverified` or `save_unverified` result; mtime vs the moment of the call. | H5, H10, H11, H14 | [ ] | [ ] |
| 9.11 | Path rules: try `open_set` and `save_set_as` with: a relative path, a `.txt` file, a path with `..` (with the default empty `host.set_roots` a set in any folder, such as `~/Desktop/My Sets`, is accepted; set `host.set_roots` to one folder to check that a path outside it gives `outside_roots`). Then `ls -ld` your set folders and `stat -f %l` on a set. | All refused with `invalid_args` and the right `reason`. Your sets are plain files (link count 1, no symlink). | Reasons seen. | H13 | [ ] | [ ] |
| 9.12 | Quit Live. "Call `open_set` with `<root>/a.als`." Then with Live open and a dirty set: "`open_set` b.als" (a second saved file). | Closed: Live starts with the set. Open + dirty: Live's own dialog appears. | Behaviour of both. | H7 | [ ] | [ ] |
| 9.13 | "Call `export_audio`." Close the dialog by hand. | Live's Export Audio/Video dialog opens, nothing is exported. | Dialog opened? Any "disabled item" error. | H3 | [ ] | [ ] |
| 9.14 | Switch Live to **Spanish** (Settings > Display & Input > Language; restart Live). Repeat 9.7 (titles), 9.8, 9.10 (replace/Reemplazar, Guardar, Cancelar) and 9.13. | Same results as English. | **The Spanish menu titles and button names.** Any step failing with `menu_item_not_found`. | H3, H5, H10 | [ ] | [ ] |
| 9.15 | Back to English. System Settings > Privacy & Security > Automation: remove the System Events permission for your client app. "Call `new_set`." Re-enable afterwards. | `permission_required` with `details.permission: automation`. | **The exact error number** (-1743?). | H6, H12 | [ ] | [ ] |
| 9.16 | Set `host.enabled: false` in `server.json`, reconnect, `tools/list`. Set it back. | The six host tools disappear; `batuta_status` shows `host.enabled: false`. | - | - | [ ] | [ ] |

---

## 10. Ears (run after T7 lands)

Prepare: a MIDI track with a looping clip and an instrument, set to a steady tempo; known level. For comparison, keep `ffmpeg` handy (read-only use): `ffmpeg -nostats -i <file> -af ebur128=peak=true -f null -`.

| # | Do | Expect | Record | Confirms | Lite | Suite |
|---|---|---|---|---|---|---|
| 10.1 | Play nothing. "Call `batuta_ears` on the MIDI track for 8 beats." Watch the Live window. | A track `batuta-ears` appears for the recording and is gone afterwards. Report has LUFS (I, short-term max, momentary max), LRA, true peak, sample peak, RMS, crest, spectrum bands, correlation. The source track plays on the master as normal; no doubled sound. | The whole report. | A5, A6, A9, A10, A26, A40 | [ ] | [ ] |
| 10.2 | After 10.1: "`list_tracks`". Then in Terminal look at the file the report names (`ls -l`). | No `batuta-ears` track left. The recorded `.wav` is still on disk (BatutaMCP never deletes files). | **The folder path where Live wrote the file** (Temporary Folder or `Samples/Recorded`); file size. | A8, A20 | [ ] | [ ] |
| 10.3 | "Call `batuta_ears` on the master for 16 beats while a clip plays." | Works through Resampling. Report is plausible. | The input type it used; error if Resampling is missing. | A6, A7 | [ ] | [ ] |
| 10.4 | **Accuracy.** Run `ffmpeg ... ebur128` on the file from 10.3 and compare integrated LUFS, LRA and true peak with the report. | Within 0.1 LU for loudness, 0.5 dB for peak. | Both sets of numbers. | (T6 vs real Live capture) | [ ] | [ ] |
| 10.5 | **Known reference.** Import a reference file of a known loudness (for example the EBU -23 LUFS test tone, or a track you know with a published LUFS) onto an audio track (`create_audio_clip`) and measure it with `batuta_ears` for the whole length. | Reported loudness close to the known value; if Live's own meter shows a level, it agrees within about 0.5 dB. | Known value, reported value, Live's meter if any. | (loudness accuracy) | [ ] | [ ] |
| 10.6 | **Timing.** At 120 BPM request 16 beats. Check `duration_s`. | About 8.0 s (within 0.1 s). | `duration_s`. | A5 | [ ] | [ ] |
| 10.7 | **Restore.** Arm the MIDI track by hand with Live's Exclusive Arm on. Select a different track. Stop the transport and move the playhead to bar 3. Run ears on another track. | Afterward: the MIDI track is armed again, the selection is back, transport stopped, playhead at bar 3. If playing before, playback continues and the playhead is not moved. | What was not restored. Whether Exclusive Arm is on by default in your Live. | A25 | [ ] | [ ] |
| 10.8 | Mute the source, then solo a different track; run ears. | Warnings `source_muted` / `solo_active` appear. | Whether the capture was silent. | A9 | [ ] | [ ] |
| 10.9 | Start a 64-beat ears job, then cancel it from the client (Esc). Look in Live. | The temp track is removed. If not, `cleanup_failed` names the manual instruction. | Was cleanup automatic? | A19 | [ ] | [ ] |
| 10.10 | Put an External Audio Effect on a scratch track by hand (as in 4.9). "Call `batuta_ears` on any track." | The server **asks once**, naming the tracks. Accept: ears runs, creates and removes its `batuta-ears` track. Decline: `cancelled` and no `batuta-ears` track is ever created. | The question text and tracks listed; both answers. | A38 | [ ] | [ ] |
| 10.11 | By hand, arm an audio track whose input is `Ext. In` with the microphone **unplugged** and monitoring Off. Run ears. Then disarm. | The server asks once; decline cancels with nothing created, accept measures (the microphone is unplugged, so the take is silent). | - | A35 | [ ] | [ ] |
| 10.12 | Create a track named `batuta-ears` by hand. Run ears. | Refused (`invalid_args`, hint to delete the stale track). Delete it afterwards. | - | - | [ ] | [ ] |
| 10.13 | **Lite only.** Fill the set to 8 tracks and run ears. | Refused `edition_limit` (`resource: tracks`). Track-to-track input in Lite: either works (10.1) or fails `not_supported`. | The message. | A7 | [ ] | n/a |
| 10.14 | After one ears run, press Edit menu only (do not click Undo) and note its label. Call `get_undo_state`. | Several undo entries from ears; remember the README warning not to undo blindly. | Number of entries added by one ears run (count Cmd-Z until it returns to the earlier state, then redo all). | A19 | [ ] | [ ] |
| 10.15 | "`analyze_audio` on the `.wav` from 10.2; `compare_audio` on two files; `record_and_analyze` on a track." | Same numbers as the ears report for the same file. | Tool names present or missing. | - | [ ] | [ ] |

---

## 11. Compatibility names used by the music skills

Run in a fresh scratch set. These are the names the existing music skills call; each must exist and accept the old argument names.

| # | Do | Expect | Record | Confirms | Lite | Suite |
|---|---|---|---|---|---|---|
| 11.1 | "Using only these tools: `create_midi_track` (name), `set_track_name`, `create_clip` (`track_index`, `clip_index`, length 4), `add_notes_to_clip` (`track_index`, `clip_index`, `notes` with `pitch`, `start_time`, `duration`, `velocity`), `set_clip_name`, `clear_notes_from_clip`, `set_track_volume` (`value_normalized`), `set_track_pan`, `set_track_send`, `set_track_mute`, `set_track_solo`: build a 4-bar bass line, name things, adjust the mixer." | Everything works by name and argument. | Any "unknown tool" or "unknown argument". | (names, spec 7.16) | [ ] | [ ] |
| 11.2 | "Using `set_tempo`, `set_time_signature`, `fire_clip`, `stop_clip`, `start_playback`, `stop_playback`, `duplicate_to_arrangement` (`destination_time`), `set_arrangement_clip_name`, `get_arrangement_clips`, `set_arrangement_time`, `switch_to_arrangement_view`, `create_locator`, `capture_session_to_arrangement`: put the clip into the arrangement twice and add two locators." | All work. | Failures. | - | [ ] | [ ] |
| 11.3 | "Using `get_browser_tree`, `get_browser_items_at_path` (`path` like `drums/Drum Rack`), `load_instrument_or_effect` (`track_index`), `load_drum_kit`, `get_device_parameters`, `set_device_parameter` (`parameter_index`, `value`), `get_macros`, `set_macro`, `get_transport`, `health`: load a drum kit and tweak a parameter." | All work. | Failures. | - | [ ] | [ ] |
| 11.4 | Excluded names: ask for `submit_intent`, `rate_last_action`, `set_dataset_consent`. Pass `user_prompt` to any tool. | These tools are not in the list. `user_prompt` is rejected as an unknown argument. | - | - | [ ] | [ ] |
| 11.5 | Run one real music skill end to end (for example `music-genres-ableton`: "make a 2-bar salsa clave on a new track") with BatutaMCP as the only Ableton server. | The skill completes with no missing tool. | The tool names it called that did not exist. | - | [ ] | [ ] |

---

## 12. Assumption index

Which step settles which `[A]` id.

| Id | Step | Id | Step | Id | Step |
|---|---|---|---|---|---|
| A1 | 0.3, 0.7 | A15 | 2.11 | A29 | 2.8 |
| A2 | 0.6 | A16 | 2.10 | A30 | 2.12 |
| A3 | 0.5, 1.6, 6.1 to 6.3 | A17 | 2.14 | A31 | 4.3 |
| A4 | no step | A18 | 1.4, 5.1, 5.8, 5.11, 5.12 | A32 | 2.12 |
| A5 | 10.1, 10.6 | A19 | 2.1, 7.1 to 7.6, 10.9, 10.14 | A33 | 2.9, 6.2 |
| A6 | 4.4, 10.1, 10.3 | A20 | 10.2 | A34 | superseded (no step) |
| A7 | 4.4, 4.6, 10.3, 10.13 | A21 | 0.3 | A35 | 4.4 to 4.6, 10.11 |
| A8 | 10.2 | A22 | 3.1, 3.2 | A36 | 5.4 to 5.6 |
| A9 | 10.1, 10.8 | A23 | 5.6, 5.8 to 5.10 | A37 | 2.12 |
| A10 | 2.2, 10.1 | A24 | 2.13, 4.9, 5.6, 5.7 | A38 | 4.8 to 4.10, 10.10 |
| A11 | 2.13, 2.14 | A25 | 10.7 | A39 | 5.2 to 5.4 |
| A12 | 2.4, 2.5 | A26 | 10.1 | A40 | 10.1 |
| A13 | 2.6 | A27 | 2.6 | A41 | 4.12 |
| A14 | 2.12 | A28 | 2.14 | | |

Host automation ([A] list in docs/04, section 10):

| Id | Step | Id | Step | Id | Step |
|---|---|---|---|---|---|
| H1 | 0.8, 9.3 | H6 | 9.4, 9.5, 9.15 | H11 | 9.10 |
| H2 | 9.1 | H7 | 9.12 | H12 | 9.4, 9.15 |
| H3 | 9.7, 9.13, 9.14 | H8 | 9.6 | H13 | 9.11 |
| H4 | 9.8 | H9 | 9.9 | H14 | 9.10 |
| H5 | 9.9, 9.10, 9.14 | H10 | 9.10, 9.14 | H15 | 9.3 |

## What to send back

One message with, per edition: the list of `[!]` steps and what happened, plus the values asked for in the Record column, in particular:

1. Live version strings and detected editions (0.5).
2. The real `class_name` values: External Audio Effect, External Instrument, native devices, racks, plugins (2.13, 4.9, 5.7).
3. Core Library, Pack, User Library and sample URIs and `blocked` values (5.2).
4. Load behaviour: `verified`, `sweep_pending`, sweep seconds, landing position, load onto master and return (5.8, 5.9).
5. Router display names and channels (4.4); monitoring values (4.3).
6. Quantization index-to-label table and the Live view names that worked (8.2, 8.4).
7. Undo history depth (7.6).
8. Host automation: error numbers for Accessibility and Automation, menu titles in English and Spanish, replace sheet text and buttons, save dialog timing (9.4, 9.7, 9.8, 9.10, 9.14, 9.15).
9. Ears: report, recorded file folder, `ffmpeg` comparison, restore behaviour (10.1 to 10.7).
