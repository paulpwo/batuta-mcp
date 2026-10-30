# Addressing

Source: docs/01-protocol.md section 6.1 and 7.16, docs/03-tool-names.md.

## Compatibility arguments (simplest form)

| Argument | Meaning |
|---|---|
| `track_index` | Regular track, 0-based. Not for returns or master |
| `clip_index` | Session slot (clip slot) index on that track |
| `scene_index` | Scene, 0-based |
| `device_index` | Device index on the track (top level); track from `track_index` or `track` |
| `parameter_index` / `parameter` | Parameter index, or its name when `parameter` is a string |
| `on` | Boolean for mute, solo, arm, metronome, `set_device_enabled` |
| `destination_time` | Arrangement position in beats |

A compat argument and the broad argument it replaces cannot be given together (`invalid_args`, `mutually_exclusive`).

## Full selectors

- Track: `{"kind":"track","index":n}`, `{"kind":"return","index":n}`, `{"kind":"master"}`, or `{"name":"Bass"}`. Add `"expect_name":"..."` to pin the track; a mismatch returns `not_found` (`name_mismatch`).
- Use `track` (not `track_index`) for returns and master, e.g. `set_track_volume`, `set_track_pan`, `get_track_meter` accept `"master"`, `"return:N"` or an index.
- Scene: an index or `{"name":...}`.
- Session clip: `{"kind":"session","track":TrackRef,"slot":n}`. Arrangement clip: `{"kind":"arrangement","track":TrackRef,"index":n}` (index into `get_arrangement_clips`).
- Device: `{"track":TrackRef,"path":[d0, {"chain":c,"device":d}, ...]}`. Parameter: `{"index":p}` or `{"name":"..."}`.
- Name selectors are resolved with a fresh listing. An ambiguous name returns `invalid_args` (`ambiguous_name`, with `candidates`): use an index.

## Values

- Notes: `[{pitch, start_time, duration, velocity, mute}]`, beats relative to the clip start.
- `set_track_volume` accepts raw `value` or `volume_db`. Device parameters use raw Live units: read min/max with `get_device_parameters` first.
- Macros: `get_macros` / `set_macro` (1-based `macro_index`).

## Views and launch quantization

`show_view` (session, arrangement, detail_clip, detail_device, browser) moves the UI only; `switch_to_session_view` and `switch_to_arrangement_view` are aliases. Global clip launch quantization is `clip_trigger_quantization` (index 0..13 or a label such as `"1 bar"`) via `set_song_properties` or `set_clip_trigger_quantization`; read it from `get_session_info` or `get_transport`. Do not change it unless asked.
