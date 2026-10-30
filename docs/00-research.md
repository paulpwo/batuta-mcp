# Research notes (2026-10-27)

[V] = verified, [A] = assumption to test in Live.

## Remote Script runtime
- Live 12.4 (Lite 12.4.7, Suite 12.4.3) embeds CPython 3.11 [V: `.pyc` magic `a70d0d0a`] with a full stdlib (`socket`, `selectors`, `hmac`, `secrets`, `threading`) at `Live.app/Contents/App-Resources/Python/lib`. No sandbox [V].
- Folder: `~/Music/Ableton/User Library/Remote Scripts/<Name>/__init__.py`. Other scripts may exist there; never touch them.
- Do not vendor or copy decompiled `_Framework` / `ableton.v3` (Ableton EULA §5(1)). Use a plain object from `create_instance(c_instance)` exposing `update_display`, `disconnect`, `refresh_state`, `build_midi_map`, `receive_midi`, `can_lock_to_devices`, `connect_script_instances`, `suggest_input_port`, `suggest_output_port`; `import Live`; song via `c_instance.song()` [A: plain object accepted; fallback runtime import of `_Framework.ControlSurface`].
- LOM only on the main thread. `update_display()` ticks about every 100 ms. Socket thread: accept/read/parse only, push to `queue.Queue`; drain in `update_display` with ~20 ms budget; close listeners in `disconnect()`. Never touch the LOM from the socket thread, not even for reads (race).

## LOM coverage (Cycling '74 LOM, documents Live 12.4.5: https://docs.cycling74.com/apiref/lom/)
- Song: `create_audio_track/create_midi_track/create_return_track(index)`, `delete_track`, `delete_return_track`, `duplicate_track`, `master_track`, `return_tracks`, `tracks`, `scenes`, `create_scene/delete_scene/duplicate_scene`, `capture_and_insert_scene`, `capture_midi`, `trigger_session_record`, `session_record`, `record_mode`, `arrangement_overdub`, `back_to_arranger`, `cue_points`, `set_or_delete_cue` (toggles at current position; set `current_song_time` first), `jump_to_next_cue/jump_to_prev_cue`, `undo`, `redo`, `can_undo`, `can_redo`, `tempo`, `signature_numerator/denominator`, `loop`, `loop_start`, `loop_length`, `scale_name`, `root_note`, `re_enable_automation`, `is_playing`, `start_playing`, `stop_playing`, `continue_playing`, `current_song_time`, `metronome`.
- Python-only: `song.begin_undo_step()` / `song.end_undo_step()` (used by Push), `clip.automation_envelope(param)`, `clip.create_automation_envelope(param)`, `envelope.insert_step(time, duration, value)`, `envelope.value_at_time(t)`, `Live.Application.get_application().browser.load_item(item)` (loads onto selected track). No documented save API: never expose one.
- CuePoint: `name` (settable), `time` (read-only), `jump()`.
- Track: `name`, `color`, `mute`, `solo`, `arm`, `can_be_armed`, `has_midi_input`, `has_audio_input`, `input_routing_type/input_routing_channel` (get/set), `available_input_routing_types/channels`, `output_routing_type/channel`, `output_meter_left/right` (smoothed momentary peak 0..1), `output_meter_level` (hold peak, 1 s), `clip_slots`, `arrangement_clips` (11.0+), `duplicate_clip_to_arrangement(clip, time)`, `create_midi_clip(start, length)` (arrangement), `create_audio_clip(file_path, position)`, `delete_clip(clip)`, `duplicate_clip_slot(i)`, `stop_all_clips()`, `devices`, `insert_device(name, index)` (12.3+, built-in devices), `delete_device(i)`, `mixer_device`, `is_foldable`, `fold_state`, `group_track`.
- MixerDevice: `volume`, `panning`, `sends[]`, `track_activator`, `panning_mode`, `crossfade_assign`; master only: `crossfader`, `cue_volume`, `song_tempo`.
- Scene: `name`, `color`, `color_index`, `tempo`, `tempo_enabled`, `time_signature_numerator/denominator`, `fire(force_legato, can_select_scene_on_launch)`, `fire_as_selected`, `clip_slots`.
- ClipSlot: `has_clip`, `clip`, `create_clip(length)` (MIDI tracks), `create_audio_clip(path)`, `delete_clip()`, `duplicate_clip_to(target_slot)`, `fire(record_length, launch_quantization)`, `stop()`, `is_recording`, `is_playing`, `is_triggered`.
- Clip: `name`, `color`, `length`, `loop_start`, `loop_end`, `looping`, `start_marker`, `end_marker`, `is_midi_clip`, `is_audio_clip`, `is_arrangement_clip`, `start_time`, `get_notes_extended(from_pitch, pitch_span, from_time, time_span)`, `get_all_notes_extended()` (11.1), `add_new_notes(spec)`, `remove_notes_extended(...)`, `apply_note_modifications(notes)`, `quantize`, `crop`, `duplicate_loop`, `clear_envelope(param)`, `clear_all_envelopes`, `file_path` (audio only, read-only), `fire`, `stop`.
- Session clip envelopes are writable; arrangement track automation is not [A: plan session clip envelopes only].
- Device: `name`, `class_name`, `type`, `is_active`, `parameters`, `can_have_chains`, `can_have_drum_pads`. DeviceParameter: `name`, `value`, `display_value`, `min`, `max`, `default_value`, `is_quantized`, `value_items`, `is_enabled`, `state`, `str_for_value(v)`.
- RackDevice: `chains`, `return_chains`, `drum_pads` (128), `visible_drum_pads`, `copy_pad`, `insert_chain` (12.3+), macro variations (11.0+).

## Live 12 Lite limits (https://www.ableton.com/en/products/live-lite/features/)
8 audio/MIDI tracks, 16 scenes, 2 send/return tracks, 8 mono in/out, no Max for Live. Standard/Suite: unlimited tracks/scenes, 12 returns. Over-limit LOM behaviour undocumented [A]: precheck and return a typed `edition_limit` error. Edition is not readable from the LOM: configure it, or detect from the app bundle name.

## Ears without a plugin
- Chosen: in-Live recording. Temporary audio track, `input_routing_type` = source track, `input_routing_channel` = "Post Mixer" (or "Post FX"); master via "Resampling". Arm, `clip_slot.fire(record_length=beats, launch_quantization=0)`, wait until `is_recording` is false, read `clip.file_path`. Recordings live in the Temporary Folder until the set is saved, then `Samples/Recorded`. Real-time with transport running; uses one track slot (Lite: refuse when 8 are used); dirties the set [A]; wrap in one undo step; never delete files. [A] track-to-track routing and Resampling available in Lite.
- Rejected: BlackHole (driver install, needs Microphone TCC, master only); Core Audio process taps (macOS 14.2+, master only, signed helper; possible later add-on).
- Output meters: peak only, UI rate; liveness and rough clip checks only.

## Loudness (BS.1770-5, EBU R128 / Tech 3341, 3342)
- K-weighting coefficients published only for 48 kHz; derive any rate by bilinear transform as MIT libebur128 does: shelf f0 = 1681.974450955533, G = 3.999843853973347 dB, Q = 0.7071752369554196; RLB high-pass f0 = 38.13547087602444, Q = 0.5003270373238773 (https://github.com/jiixyj/libebur128/blob/master/ebur128/ebur128.c).
- Momentary 400 ms; short-term 3 s; integrated: 400 ms blocks, 75 % overlap, gate −70 LUFS absolute then −10 LU relative; channel weights L/R 1.0. LRA: short-term values, −70 absolute and −20 relative gate, P95 − P10. True peak: 4× oversampling below 96 kHz, 2× below 192 kHz (polyphase FIR).
- Test set: EBU Loudness Test Set v5 (https://tech.ebu.ch/files/live/sites/tech/files/shared/testmaterial/ebu-loudness-test-setv05.zip, 87 MB). Fetch by pinned sha256; never commit the files.
- Test-only oracles: `ebur128-wasm` 3.0.0 (Apache-2.0, unmaintained since 2022) or ffmpeg `ebur128`.

## Security
- AF_UNIX socket in a 0700 dir `~/Library/Application Support/BatutaMCP/` (sun_path < 104 bytes); 32-byte token (`secrets.token_hex`), file 0600, checked with `hmac.compare_digest` on the first frame. Length-prefixed frames ≤ 1 MiB, JSON depth cap, one client, rate limit.
- Remote Script: command allowlist dispatching to fixed functions, no `getattr` on client strings, no file access except the token, no subprocess, no eval. Node validates every `file_path` (realpath under Temp or `Samples/Recorded`, .wav/.aif, size cap) before reading.
- No host automation, no save, no mic.
- Destructive tools: MCP elicitation (`elicitation/create`, supported by Claude Code; hooks can auto-answer, so it is UX, not a boundary), fallback single-use confirm token bound to a hash of operation + args, 60 s expiry.

## Distribution and name
- npm trusted publishing (OIDC, npm ≥ 11.5.1, Node ≥ 22.14, `id-token: write`, public repo) with provenance; "disallow tokens"; `npm sbom --sbom-format cyclonedx`; `actions/attest-build-provenance`; exact pins incl. `@modelcontextprotocol/sdk`.
- Installer copies into a new `Remote Scripts/BatutaMCP/`, atomically; refuses if the target exists with foreign content; never deletes.
- Trademarks (https://www.ableton.com/en/legal/branding-trademark-guidelines/): no "Ableton" or "Live" in the product name; "for Ableton Live" allowed less prominently; notice "Ableton and Live are trademarks of Ableton AG"; no logos.
- 2026-10-27: `batuta-mcp`, `batutamcp`, `@paulpwo/batuta-mcp` free on npm; `paulpwo/batuta-mcp` free on GitHub; unrelated `vorluno/batuta-mcp` exists; Fundación Nacional Batuta is a Colombian music brand.
