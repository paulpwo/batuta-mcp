# Tool names and argument aliases

This document is the public naming table of the BatutaMCP server (T5c-2). The owner's decision of 2026-10-27 is: "use the same names, be normalizers". Music skills written against these names must keep working by name and by argument, and the server still starts from scratch on security. The table below is generated from the code; a test fails when the two differ.

## Naming rules

1. Where a compatibility name already exists for a tool, that is the public name (`get_session_info`, `fire_clip`, `add_notes_to_clip`, ...).
2. Narrow compatibility names (`create_return_track`, `set_track_mute`, `get_transport`, `health`, ...) are kept as they are.
3. Otherwise a new `verb_object` snake_case name in the same style (`get_`, `set_`, `list_`, `create_`, `delete_`, `duplicate_`, `fire_`, `stop_`, `load_`, `show_`, ...).
4. No `batuta_` prefix, except the server tools `batuta_confirm`, `batuta_status` and (with the ears task) `batuta_ears`; `show_transport_panel` is a server tool without the prefix because the user asks for it by name.
5. Names, descriptions and schemas are static text. Nothing read from Live ever becomes part of one.

Wire commands in the Remote Script (`track_set`, `notes_add`, ...) keep their names; only the MCP tool names are normalized. `batch` ops name their command by the public tool name of the broad tool (`{"cmd": "set_track_properties", "args": {...}}`); the server sends the wire command name to the script.

## Four families

| Family | What it is |
|---|---|
| Broad tool | One tool per Remote Script command, with the selectors and options of the protocol (docs/01-protocol.md section 7.16). Named by rule 1 to 3. |
| Broad tool with compat arguments | A broad tool whose compatibility form covers the whole command (for example `delete_track`, `fire_clip`, `add_notes_to_clip`). It publishes the compatibility argument names next to its own. |
| Narrow alias | A compatibility tool that stands for one field or one fixed form of a broad tool (`set_track_name`, `set_tempo`, `start_playback`, ...). It rewrites its arguments and runs the broad tool's path. |
| Composite | A server-side tool built from several broad calls (`get_session_snapshot`, `load_drum_kit`, `create_locator`, `get_browser_tree`, `get_transport`, `get_macros`, `set_macro`) or a report from cached state (`health`, `get_remote_script_info`). |

## Argument aliases

Compat arguments are optional properties of the broad tool, mapped onto the internal selectors before anything else happens:

| Compat argument | Becomes |
|---|---|
| `track_index` | `track: {kind: "track", index}` (regular tracks only) |
| `clip_index` | the session slot: `slot`, or inside `clip: {kind: "session", track, slot}` / `from` / `source`, depending on the tool |
| `scene_index` | `scene` (every tool with a scene selector: `delete_scene`, `fire_scene`, `duplicate_scene`, `set_scene_properties`, `commit_scene_to_arrangement`) |
| `device_index` | `path: [device_index]` of a device selector; the track comes from `track_index` or from a `track` selector (so returns and master work) |
| `parameter_index` / `parameter` | the parameter `index`, or its `name` when `parameter` is a string |
| `on` | `enabled` (`set_device_enabled`) or the field the narrow alias stands for (`mute`, `solo`, `arm`, `metronome`, `record_mode`) |
| `destination_time` | `time` (`duplicate_to_arrangement`) |
| `path` | `file_path` (`create_audio_clip`); for `get_browser_items_at_path` it is `category/folder/subfolder` |
| `beats` | `time` (`set_song_position`) |
| `numerator`, `denominator` | `signature_numerator`, `signature_denominator` |
| `value`, `value_normalized` | the raw `volume` / `pan` / send value (`set_track_volume`, `set_track_pan`, `set_track_send`); `volume_db` is the BatutaMCP addition |
| `track` as `"master"`, `"return:N"` or an index | compatibility form on `set_track_volume`, `set_track_pan` and `get_track_meter`; when both `track` and `track_index` are given, `track` wins (compatibility rule) |

Rules that hold for every alias:

- A compat argument and the broad argument it replaces cannot be given together (`invalid_args`, `reason: "mutually_exclusive"`). A half-given form is refused, and what the broad tool requires is still required.
- Every tool with a single track, scene, clip or device selector takes the index form as well as the selector (exactly one of the two). `list_devices` and `insert_device` take `track_index` alone for the track's own device chain; rack chains still need `container`.
- Unknown arguments are refused (`additionalProperties: false` everywhere). There is no accept-and-ignore: `user_prompt` is rejected like any other unknown argument.
- Extra BatutaMCP options stay available as optional arguments (`expect_name`, `allow_overwrite`, `limit`, `volume_db`, ...).
- Notes use `[{pitch, start_time, duration, velocity, mute}]`, in beats relative to the clip start.
- A compat argument never reaches the Remote Script: the wire carries the broad form only.

## Guards apply identically

Compat arguments are mapped inside the planner, before the first rule runs; narrow aliases call the same `Executor.run` as the broad tool; composites call it for every step. So through any name: the catalog gate and `version_mismatch`, edition limits (Lite), the gain guard (`set_track_volume` is `mixer_set`; `set_device_parameter` is `param_set`), recording safety in the script, `expect_name` pinning and auto-filled pins, the reserved `batuta-ears` name, the destructive classification and the confirmation policy of section 9.1a (including `batuta_confirm`), `destructive: "disabled"` (a hidden broad tool hides its aliases), the sample-folder gate for audio import, and the browser rules (blocked items, plugins, user presets, Max for Live). Tests prove it table by table: every alias row compares the wire commands, listings and pins of the alias call with the broad call.

## Composites

- `get_session_snapshot`: read-only. `song_info`, `track_list`, then per regular track `track_get` (devices and clip slots), optionally `device_get` (parameters), `notes_get` (MIDI notes) and `arrangement_clips`. Defaults: (notes, params and arrangement on). Caps: `max_tracks` (64), `max_notes_per_clip` (200), `max_params_per_device` (64), at most 600 inner calls and 400 KB of output. The call count and the size are checked before each inner call, and a result that does not fit is dropped, so the output never exceeds the cap. `truncated: true` and the `*_total` fields say what was cut; every track carries `params_truncated`, `notes_truncated` and `arrangement_truncated` (true when that part of the track is missing or incomplete, whether a per-item limit or the call or size cap cut it), and an item that was skipped carries its own `params_truncated` / `notes_truncated` without the data. Nothing is recorded or sent anywhere.
- `load_drum_kit {track_index, rack_uri?, kit_path}`: first resolves the kit (the first loadable, unblocked item of the folder at `kit_path`, or the item the path names) and the rack, then calls `browser_load` for the rack and for the kit. Live's own Drum Rack is listed under `instruments`, so the rack is looked up there first: `rack_uri` defaults to `instruments/Drum Rack`; a browser uri is used as given; a path such as `instruments/Drum Rack` is tried as written and, when it is not found, in the other of `instruments` and `drums`; a bare name is searched in `instruments`, then in `drums`. Nothing is loaded when a lookup fails. The script still loads only uris it listed in this session.
- `create_locator {name, time}`: upsert. The cue point nearest to `time` within 0.001 beat is renamed (`cue_set`, allowed while playing); otherwise one is created (`cue_create`). Creating needs the transport stopped: while it is running the call fails with `invalid_args`, `reason: "transport_running"`, and the message says to call `stop_playback` first. The script's nearby-cue refusal (`cue_nearby`) is passed through.
- `get_macros {track_index | track, device_index}`: the macros of the rack at `device_index` on a regular track (`track_index`) or on a return or the master (`track`: `{kind:"return",index}` or `{kind:"master"}`). It reads `rack_get` (macro count) and `device_get` and returns `macros: [{macro_index, parameter_index, name, value, min, max, display}]`. `macro_index` is 1-based, like Live's labels (`Macro 1` to `Macro 16`); `parameter_index` is where the macro sits in the device's parameter list. A device that is not a rack fails with `invalid_args`, `reason: "not_a_rack"`. A rack that reports no readable macros fails with `not_supported`, `reason: "macro_layout"`. Assumption [A]: macro k is device parameter k (parameter 0 is Device On); a default-named `Macro n` at any other index makes the tool stop with `not_supported`, `reason: "macro_layout"` instead of guessing. Renamed macros keep their custom name.
- `set_macro {track_index | track, device_index, macro_index, value}`: sets macro `macro_index` (1-based) to the raw `value` (inside the macro's min..max, see `get_macros`) by running `set_device_parameter` on its parameter. Every guard of that tool applies (gain guard for a dB macro named like a gain, catalog gate, expect_name pins, confirmation, `destructive: "disabled"`); a confirmation it needs is returned to the caller as for the single tool.
- `get_browser_tree {category_type}`: the top level of one category or of `instruments`, `sounds`, `drums`, `audio_effects`, `midi_effects` (`list_browser_items` with a limit of 100).
- `get_transport`: the transport fields of `song_info`, including `clip_trigger_quantization` (`{index, label}`).
- `health`: the same report as `batuta_status`. `get_remote_script_info`: connection, script version, protocol, Live version and edition from cached state; it sends nothing.

## Application views and launch quantization

`show_view`, `focus_view` and `get_view` run the script commands `view_show`, `view_focus` and `view_get` (views `session`, `arrangement`, `detail_clip`, `detail_device`, `browser`; they move the UI only and are allowed in a batch). `switch_to_arrangement_view` and `switch_to_session_view` are aliases of `show_view`. The global clip launch quantization is `clip_trigger_quantization` of `set_song_properties` (index 0..13 or a label such as `"1 bar"`, `"1/16T"`) and of the compatibility alias `set_clip_trigger_quantization`; `get_session_info` and `get_transport` report it as `{index, label}`.

## The table

The table is generated (`namingTable()` in `server/test/helpers/naming-table.ts`) and checked by `server/test/tools-docs.test.ts`.

<!-- naming-table:start -->
### Broad tools (one per Remote Script command)

| Tool | Command | Also accepts (compatibility argument names) |
|---|---|---|
| `get_session_info` | `song_info` | - |
| `set_song_properties` | `song_set` | - |
| `control_transport` | `transport` | - |
| `set_arrangement_time` | `song_set_time` | - |
| `stop_all_clips` | `stop_all_clips` | - |
| `back_to_arrangement` | `back_to_arranger` | - |
| `capture_midi` | `capture_midi` | - |
| `trigger_session_record` | `trigger_session_record` | - |
| `re_enable_automation` | `re_enable_automation` | - |
| `get_undo_state` | `undo_state` | - |
| `undo` | `undo` | - |
| `redo` | `redo` | - |
| `list_tracks` | `track_list` | - |
| `get_track_info` | `track_get` | `track_index` |
| `create_track` | `track_create` | - |
| `delete_track` | `track_delete` | `track_index` |
| `duplicate_track` | `track_duplicate` | `track_index` |
| `set_track_properties` | `track_set` | `track_index` |
| `select_track` | `track_select` | `track_index` |
| `stop_track_clips` | `track_stop_clips` | `track_index` |
| `get_meters` | `meters_get` | - |
| `get_mixer` | `mixer_get` | `track_index` |
| `set_mixer` | `mixer_set` | `track_index` |
| `get_routing` | `routing_get` | `track_index` |
| `set_routing` | `routing_set` | `track_index` |
| `list_scenes` | `scene_list` | - |
| `create_scene` | `scene_create` | - |
| `delete_scene` | `scene_delete` | `scene_index` |
| `duplicate_scene` | `scene_duplicate` | `scene_index` |
| `set_scene_properties` | `scene_set` | `scene_index` |
| `fire_scene` | `scene_fire` | `scene_index` |
| `capture_scene` | `scene_capture` | - |
| `list_cue_points` | `cue_list` | - |
| `create_cue_point` | `cue_create` | - |
| `delete_cue_point` | `cue_delete` | - |
| `set_cue_point` | `cue_set` | - |
| `jump_to_cue_point` | `cue_jump` | - |
| `show_view` | `view_show` | - |
| `focus_view` | `view_focus` | - |
| `get_view` | `view_get` | - |
| `list_clip_slots` | `clip_list` | `track_index` |
| `get_clip_info` | `clip_get` | `track_index`, `clip_index` |
| `get_slot_status` | `slot_status` | `track_index`, `clip_index` |
| `create_clip` | `clip_create` | `track_index`, `clip_index` |
| `create_audio_clip` | `audio_clip_create` | `track_index`, `clip_index`, `path` |
| `delete_clip` | `clip_delete` | `track_index`, `clip_index` |
| `duplicate_clip` | `clip_duplicate` | `track_index`, `clip_index` |
| `set_clip_properties` | `clip_set` | `track_index`, `clip_index` |
| `crop_clip` | `clip_crop` | `track_index`, `clip_index` |
| `duplicate_clip_loop` | `clip_duplicate_loop` | `track_index`, `clip_index` |
| `fire_clip` | `slot_fire` | `track_index`, `clip_index` |
| `stop_clip` | `slot_stop` | `track_index`, `clip_index` |
| `get_clip_notes` | `notes_get` | `track_index`, `clip_index` |
| `add_notes_to_clip` | `notes_add` | `track_index`, `clip_index` |
| `remove_notes_from_clip` | `notes_remove` | `track_index`, `clip_index` |
| `modify_clip_notes` | `notes_modify` | `track_index`, `clip_index` |
| `quantize_clip_notes` | `notes_quantize` | `track_index`, `clip_index` |
| `list_clip_envelopes` | `envelope_list` | `track_index`, `clip_index` |
| `get_clip_envelope` | `envelope_get` | - |
| `set_clip_envelope` | `envelope_set` | - |
| `clear_clip_envelope` | `envelope_clear` | - |
| `clear_all_clip_envelopes` | `envelope_clear_all` | `track_index`, `clip_index` |
| `get_arrangement_clips` | `arrangement_clips` | `track_index` |
| `create_arrangement_clip` | `arrangement_clip_create` | `track_index` |
| `duplicate_to_arrangement` | `arrangement_duplicate` | `track_index`, `clip_index`, `destination_time` |
| `commit_scene_to_arrangement` | `arrangement_commit_scene` | `scene_index` |
| `list_devices` | `device_list` | `track_index` |
| `get_device_parameters` | `device_get` | `track_index`, `track`, `device_index` |
| `get_parameter` | `param_get` | `track_index`, `track`, `device_index`, `parameter_index`, `parameter` |
| `set_device_parameter` | `param_set` | `track_index`, `track`, `device_index`, `parameter_index`, `parameter` |
| `set_device_enabled` | `device_enable` | `track_index`, `track`, `device_index`, `on` |
| `delete_device` | `device_delete` | `track_index`, `track`, `device_index` |
| `insert_device` | `device_insert` | `track_index` |
| `get_rack` | `rack_get` | `track_index`, `track`, `device_index` |
| `set_chain_properties` | `chain_set` | `track_index`, `track`, `device_index` |
| `insert_rack_chain` | `rack_insert_chain` | `track_index`, `track`, `device_index` |
| `set_rack_variation` | `rack_variation` | `track_index`, `track`, `device_index` |
| `list_drum_pads` | `drum_pads_list` | `track_index`, `track`, `device_index` |
| `set_drum_pad` | `drum_pad_set` | `track_index`, `track`, `device_index` |
| `copy_drum_pad` | `drum_pad_copy` | `track_index`, `track`, `device_index` |
| `clear_drum_pad` | `drum_pad_clear` | `track_index`, `track`, `device_index` |
| `list_browser_items` | `browser_list` | - |
| `search_browser` | `browser_search` | - |
| `load_instrument_or_effect` | `browser_load` | `track_index` |
| `batch` | `batch` | - |

### Narrow aliases (same executor path and guards as the broad tool)

| Tool | Origin | Runs | Arguments |
|---|---|---|---|
| `create_midi_track` | compat | `create_track` | `index`, `name` |
| `create_audio_track` | compat | `create_track` | `index`, `name` |
| `create_return_track` | compat | `create_track` | `name` |
| `set_track_name` | compat | `set_track_properties` | `track_index`, `name` |
| `set_track_mute` | compat | `set_track_properties` | `track_index`, `on` |
| `set_track_solo` | compat | `set_track_properties` | `track_index`, `on` |
| `set_track_arm` | compat | `set_track_properties` | `track_index`, `on` |
| `set_track_color` | compat | `set_track_properties` | `track_index`, `color` |
| `set_track_volume` | compat | `set_mixer` | `track_index`, `track`, `value`, `value_normalized`, `volume_db` |
| `set_track_pan` | compat | `set_mixer` | `track_index`, `track`, `value` |
| `set_track_send` | compat | `set_mixer` | `track_index`, `send_index`, `value`, `value_normalized` |
| `set_clip_name` | compat | `set_clip_properties` | `track_index`, `clip_index`, `name` |
| `set_arrangement_clip_name` | compat | `set_clip_properties` | `track_index`, `clip_index`, `name` |
| `set_clip_color` | compat | `set_clip_properties` | `track_index`, `clip_index`, `color` |
| `set_clip_loop` | compat | `set_clip_properties` | `track_index`, `clip_index`, `looping`, `loop_start`, `loop_end`, `start_marker`, `end_marker` |
| `clear_notes_from_clip` | compat | `remove_notes_from_clip` | `track_index`, `clip_index` |
| `set_scene_name` | compat | `set_scene_properties` | `scene_index`, `name` |
| `set_tempo` | compat | `set_song_properties` | `tempo` |
| `set_time_signature` | compat | `set_song_properties` | `numerator`, `denominator` |
| `set_metronome` | compat | `set_song_properties` | `on` |
| `set_song_position` | compat | `set_arrangement_time` | `beats` |
| `set_arrangement_record` | compat | `set_song_properties` | `on` |
| `set_clip_trigger_quantization` | compat | `set_song_properties` | `value` |
| `start_playback` | compat | `control_transport` | - |
| `stop_playback` | compat | `control_transport` | - |
| `continue_playback` | normalized | `control_transport` | - |
| `switch_to_arrangement_view` | compat | `show_view` | - |
| `switch_to_session_view` | normalized | `show_view` | - |
| `capture_session_to_arrangement` | compat | `commit_scene_to_arrangement` | `scene_index`, `destination_time`, `allow_overwrite` |
| `get_browser_items_at_path` | compat | `list_browser_items` | `path`, `limit`, `offset` |
| `get_track_meter` | compat | `get_meters` | `track` |
| `get_master_meter` | compat | `get_meters` | - |

### Composites (server side, built on the broad tools)

| Tool | Origin | Uses |
|---|---|---|
| `get_session_snapshot` | compat | `get_session_info`, `list_tracks`, `get_track_info`, `get_device_parameters`, `get_clip_notes`, `get_arrangement_clips` |
| `load_drum_kit` | compat | `get_track_info`, `list_browser_items`, `search_browser`, `load_instrument_or_effect` |
| `get_macros` | normalized | `get_rack`, `get_device_parameters` |
| `set_macro` | normalized | `get_rack`, `get_device_parameters`, `set_device_parameter` |
| `create_locator` | compat | `list_cue_points`, `set_cue_point`, `create_cue_point`, `get_session_info` |
| `get_browser_tree` | compat | `list_browser_items` |
| `get_remote_script_info` | compat | `cached connection state` |
| `get_transport` | compat | `get_session_info` |
| `health` | compat | `batuta_status` |

### Host tools (server only, no Remote Script command; docs/04-host-automation.md)

| Tool | Arguments | Changes or discards work (destructiveHint) |
|---|---|---|
| `launch_live` | `app` | no |
| `open_set` | `path` | yes (asks only when it cannot be undone, or in confirm "destructive") |
| `new_set` | - | yes (asks only when it cannot be undone, or in confirm "destructive") |
| `save_set` | - | no |
| `save_set_as` | `path` | yes (asks only when it cannot be undone, or in confirm "destructive") |
| `export_audio` | - | no |

### Ears tools (server only, no Remote Script command of their own; docs/01-protocol.md section 10)

| Tool | Arguments | Changes the set (readOnlyHint false) |
|---|---|---|
| `batuta_ears` | `source`, `beats`, `bars`, `spectrum` | yes (its own temporary track, removed again; never asks) |
| `record_and_analyze` | `track_index`, `source`, `beats`, `bars`, `spectrum` | yes (its own temporary track, removed again; never asks) |
| `analyze_audio` | `path` | no |
| `compare_audio` | `a`, `b` | no |

### Server tools

| Tool | Purpose |
|---|---|
| `batuta_confirm` | second step of a confirmation |
| `batuta_status` | connection, versions, effective safety configuration |
| `show_transport_panel` | transport state; renders the transport panel in hosts that show MCP Apps |
<!-- naming-table:end -->

## Scene capture and loading onto returns and master

`capture_session_to_arrangement {scene_index, destination_time, allow_overwrite?}` is a thin alias of `commit_scene_to_arrangement`: it copies the session clips of a scene to the arrangement at `destination_time` in one undo step. It does not record in real time and does not play anything; overlaps are an error unless `allow_overwrite` is true, which replaces existing content and is destructive but undoable, as for the broad tool. `load_instrument_or_effect` (`browser_load`) takes a regular track, a return or the master in `track`; `track_index` still means a regular track. The Remote Script selects the target for the load and puts the previous selection back, and every browser rule and the post-load cleanup apply to these targets as to any track.

## Host automation

`launch_live`, `open_set`, `new_set`, `save_set`, `save_set_as` and `export_audio` are server-only tools (no Remote Script command), specified in `docs/04-host-automation.md`. They are listed only when `host.enabled` is true and the platform is macOS. They do not need the Remote Script connection. Compatibility names for the same actions (`launch_ableton`, `new_live_set`, `open_export_dialog`) are not provided; the six names above are the only ones.

## Ears (measuring loudness and spectrum)

`batuta_ears`, `record_and_analyze`, `analyze_audio` and `compare_audio` are server tools (no Remote Script command of their own; flow and report in `docs/01-protocol.md` section 10). They are listed only when `ears.enabled` is true (default).

- `batuta_ears {source, beats?, bars?, spectrum?}` records the source inside Live on a temporary track named `batuta-ears`, analyzes the file Live wrote and removes the track again. `source` is a track, return or master selector (`{"kind":"track","index":0}`, `{"kind":"master"}` or `{"name":"Bass"}`); `beats` is 1..64 (default 16) or `bars` 1..16 (not both); `spectrum:false` leaves the octave bands out. The result carries `result_id`, `source`, `beats`, `report`, `file`, `warnings` and `cleanup`.
- `record_and_analyze` is the same tool under a compatibility name, with `track_index` (a regular track) as an alternative to `source`; exactly one of the two.
- `analyze_audio {path}` analyzes an existing WAV or AIFF file and never writes. The path has to be inside a `sample_roots` folder (an extra read root for ears, not needed for `create_audio_clip`), Live's recording folders, `ears.roots`, or a `Samples/Recorded` folder under the home or `ears.set_roots`, and passes the same file checks as a recording (no symlinks, no hard links, regular file of yours, size cap, readable header).
- `compare_audio {a, b}` takes two paths or two `result_id`s (of this session, the last eight are kept) and returns the metric by metric difference, b minus a.
- One ears job or analysis runs at a time; a second call gets `busy` (`details.reason` `job_running`).
- None of them ever asks for confirmation, in any `confirm` mode: `batuta_ears` only creates and removes its own temporary track and puts the transport, playhead, selection and armed tracks back. `destructive: "disabled"` does not hide them, for the same reason (section 9.3 item 4).
- `record_audio` (record without analyzing) is not provided: the recorded file cannot be handed to the model, and a recording nobody measures is not useful. Use `batuta_ears`.

## Excluded on purpose

| Excluded tool | Why |
|---|---|
| `submit_intent`, `rate_last_action`, `reject_last_action`, `prefer_candidate`, `record_audition`, `set_dataset_consent` | Telemetry and dataset collection. Not implemented, not forwarded. |
| `user_prompt` (argument of those tools) | It carries the user's prompt to a telemetry server. No tool accepts it; supplying it is an `invalid_args` error like any unknown argument. |

Also excluded by the owner: microphone and line-in recording.
