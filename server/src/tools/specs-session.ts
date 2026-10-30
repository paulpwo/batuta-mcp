import { COLOR, NAME, PAGING, SCENE_SEL, TRACK_ONLY_SEL, TRACK_RETURN_SEL, TRACK_SEL, arr, bool, enumOf, int, nullValue, num, obj, oneOf, str } from "./schemas.js";
import type { CommandSpec } from "./types.js";

/** Song, transport, tracks, mixer, routing, scenes and cue points (docs/01-protocol.md sections 7.1 to 7.5). */

const BEATS = "Times and lengths are in beats (quarter note = 1.0).";
const LITE = "On Live Lite the limits are 8 tracks, 16 scenes and 2 returns (edition_limit error).";
const RECORD_NOTE = "confirmed with the owner once while a track with a live external audio input exists (the recording may capture a microphone); a decline cancels it with nothing done.";
const VOLUME_NOTE = "volume is the raw value 0.0..1.0 (0.85 is about 0 dB); volume_db is -70..6 dB. Give only one of them. A large increase (more than the configured jump limit) or a master level above the configured ceiling trips the gain guard and asks the user to confirm.";

/** Live's global clip launch quantization, index order of Live.Song.Quantization. */
export const QUANTIZATION_LABELS = ["none", "8 bars", "4 bars", "2 bars", "1 bar", "1/2", "1/2T", "1/4", "1/4T", "1/8", "1/8T", "1/16", "1/16T", "1/32"] as const;
const VIEWS = enumOf("session", "arrangement", "detail_clip", "detail_device", "browser");

export const SESSION_SPECS: CommandSpec[] = [
  {
    command: "song_info", summary: "Read song info", mutating: false, destructive: "never", conditions: [],
    description: `Read the song state: tempo (BPM), time signature, play state, playhead (current_song_time, beats), loop, metronome, record flags, key and scale, clip_trigger_quantization ({index,label}), counts of tracks/returns/scenes/cue points, undo availability, selected track and Live version. Also reports pending_sweeps and recent_sweeps: the safety clean-up that runs shortly after browser_load. ${BEATS}`,
    properties: {},
  },
  {
    command: "song_set", summary: "Change song settings", mutating: true, destructive: "never", conditions: [], idempotent: true,
    description: `Change song settings; give at least one field. tempo is BPM 20..999; signature_denominator is 1, 2, 4, 8 or 16; loop_start and loop_length are in beats; clip_trigger_quantization is the global launch quantization, 0..13 or a label (none, 8 bars ... 1/32). ${BEATS} Enabling record_mode, session_record or arrangement_overdub is ${RECORD_NOTE}`,
    properties: {
      tempo: num(20, 999, "BPM"), signature_numerator: int(1, 99), signature_denominator: enumOf(1, 2, 4, 8, 16),
      metronome: bool(), loop: bool(), loop_start: num(0), loop_length: num(0), record_mode: bool(),
      arrangement_overdub: bool(), session_record: bool(), root_note: int(0, 11, "0 = C"), scale_name: str(64),
      clip_trigger_quantization: oneOf(int(0, 13), enumOf(...QUANTIZATION_LABELS)),
    },
    atLeastOne: true,
  },
  {
    command: "transport", summary: "Control transport", mutating: true, destructive: "never", conditions: [],
    description: `Start, continue or stop playback. Returns is_playing and current_song_time (beats). While a record mode is on and an external audio input is live, start and continue ask the owner once; a decline cancels.`,
    properties: { action: enumOf("start", "continue", "stop") }, required: ["action"],
  },
  {
    command: "song_set_time", summary: "Move the playhead", mutating: true, destructive: "never", conditions: [], idempotent: true,
    description: `Move the arrangement playhead to a position in beats (quarter note = 1.0, >= 0).`,
    properties: { time: num(0, undefined, "Position in beats.") }, required: ["time"],
  },
  {
    command: "stop_all_clips", summary: "Stop all clips", mutating: true, destructive: "never", conditions: [],
    description: `Stop every playing session clip. quantized (default true) waits for the launch quantization.`,
    properties: { quantized: bool() },
  },
  {
    command: "back_to_arranger", summary: "Back to arrangement", mutating: true, destructive: "never", conditions: [],
    description: `Make the arrangement play again after session clips took over (the Back to Arrangement button).`,
    properties: {},
  },
  {
    command: "capture_midi", summary: "Capture MIDI", mutating: true, destructive: "never", conditions: [],
    description: `Capture the MIDI the user recently played into a new clip (Live's Capture MIDI). Creates a clip only when notes were played.`,
    properties: {},
  },
  {
    command: "trigger_session_record", summary: "Start session recording", mutating: true, destructive: "never", conditions: [],
    description: `Start session recording on armed tracks, optionally for record_length beats (1..256). It is ${RECORD_NOTE}`,
    properties: { record_length: num(1, 256, "Length in beats.") },
  },
  {
    command: "re_enable_automation", summary: "Re-enable automation", mutating: true, destructive: "never", conditions: [],
    description: `Re-enable all automation that was overridden by manual parameter changes.`,
    properties: {},
  },
  {
    command: "undo_state", summary: "Read undo state", mutating: false, destructive: "never", conditions: [],
    description: `Report whether undo and redo are available.`,
    properties: {},
  },
  {
    command: "undo", summary: "Undo", mutating: true, destructive: "conditional", conditions: ["steps"],
    description: `Undo the last step in Live (steps 1..10, default 1; stops early when nothing is left). Called by the model this always asks the user to confirm, whatever steps: Live's undo stack also holds the owner's manual edits, and any later change drops the redo stack, so a model undo can erase the owner's work for good.`,
    properties: { steps: int(1, 10) },
    condition: (args) => (typeof args["steps"] === "number" && args["steps"] > 1 ? `undoes ${args["steps"]} steps` : null),
  },
  {
    command: "redo", summary: "Redo", mutating: true, destructive: "never", conditions: [],
    description: `Redo the last undone step in Live (steps 1..10, default 1). Called by the model this always asks the user to confirm, because it also moves over the owner's manual edits in Live's undo stack (manual edits made after an undo are lost for good).`,
    properties: { steps: int(1, 10) },
  },

  // ---- tracks
  {
    command: "track_list", summary: "List tracks", mutating: false, destructive: "never", conditions: [],
    description: `List tracks, returns and the master track with name, color, mute, solo, arm, monitoring (0 in, 1 auto, 2 off) and device count. Indices of tracks exclude returns and master. Paged.`,
    properties: { include_returns: bool(), include_master: bool(), ...PAGING },
  },
  {
    command: "track_get", summary: "Read a track", mutating: false, destructive: "never", conditions: [],
    description: `Read one track with its devices and, with include_clips, its clip slots.`,
    properties: { track: TRACK_SEL, include_clips: bool() }, required: ["track"], refs: { track: "track" },
  },
  {
    command: "track_create", summary: "Create a track", mutating: true, destructive: "never", conditions: [],
    description: `Create a MIDI, audio or return track. index -1 (default) appends; it is ignored for returns. ${LITE} The name batuta-ears is reserved.`,
    properties: { type: enumOf("midi", "audio", "return"), index: int(-1), name: NAME, color: COLOR }, required: ["type"],
  },
  {
    command: "track_delete", summary: "Delete track", mutating: true, destructive: "always", conditions: [],
    description: `Delete a track or return (with its devices and clips). Destructive but undoable (one undo step: Cmd-Z in Live, or the undo tool).`,
    properties: { track: TRACK_RETURN_SEL, expect_name: str(128, undefined, "Guard: the track must have this name.") }, required: ["track"], refs: { track: "track" },
  },
  {
    command: "track_duplicate", summary: "Duplicate a track", mutating: true, destructive: "never", conditions: [],
    description: `Duplicate a regular track (a group track also copies its children). ${LITE}`,
    properties: { track: TRACK_ONLY_SEL }, required: ["track"], refs: { track: "trackOnly" },
  },
  {
    command: "track_set", summary: "Change a track", mutating: true, destructive: "never", conditions: [], idempotent: true,
    description: `Change a track's name, color, mute, solo, arm, fold_state or monitoring_state (0 in, 1 auto, 2 off). Not for the master (use mixer_set). arm works on MIDI tracks; arming or monitoring In (0) an audio track whose input is external (a microphone, an interface) asks the owner once and a decline cancels; other audio tracks cannot be armed or monitored In. The name batuta-ears is reserved.`,
    properties: { track: TRACK_SEL, name: NAME, color: COLOR, mute: bool(), solo: bool(), arm: bool(), fold_state: bool(), monitoring_state: int(0, 2) },
    required: ["track"], refs: { track: "track" },
  },
  {
    command: "track_select", summary: "Select a track", mutating: true, destructive: "never", conditions: [], idempotent: true,
    description: `Select a track in Live's UI (the selected track is the target of some Live actions).`,
    properties: { track: TRACK_SEL }, required: ["track"], refs: { track: "track" },
  },
  {
    command: "track_stop_clips", summary: "Stop a track's clips", mutating: true, destructive: "never", conditions: [],
    description: `Stop all session clips on a regular track.`,
    properties: { track: TRACK_ONLY_SEL }, required: ["track"], refs: { track: "trackOnly" },
  },
  {
    command: "meters_get", summary: "Read meters", mutating: false, destructive: "never", conditions: [],
    description: `Read output meters (0.0..1.0 linear peak-smoothed UI values, not dB) of up to 32 tracks, or all with all:true. For liveness and rough clipping checks only, never loudness.`,
    properties: { tracks: arr(TRACK_SEL, 1, 32), all: bool() }, exclusive: [["tracks", "all"]], refs: { tracks: "trackList" },
  },

  // ---- mixer and routing
  {
    command: "mixer_get", summary: "Read the mixer", mutating: false, destructive: "never", conditions: [],
    description: `Read a track's mixer: volume (raw 0..1 with min, max, display and volume_db), pan (-1..1), sends (A = index 0), crossfade assign; the master also has cue_volume and crossfader.`,
    properties: { track: TRACK_SEL }, required: ["track"], refs: { track: "track" },
  },
  {
    command: "mixer_set", summary: "Change the mixer", mutating: true, destructive: "conditional", conditions: ["volume", "volume_db"], idempotent: true,
    description: `Set volume, pan, sends, crossfade_assign (0..2), cue_volume or crossfader (master). pan is -1..1; each send is {index, value} (raw). Out-of-range values are errors (no clamping). ${VOLUME_NOTE}`,
    properties: {
      track: TRACK_SEL, volume: num(), volume_db: num(-70, 6, "dB"), pan: num(-1, 1),
      sends: arr(obj({ index: int(0), value: num() }, ["index", "value"]), 1, 12), crossfade_assign: int(0, 2),
      cue_volume: num(), crossfader: num(),
    },
    required: ["track"], exclusive: [["volume", "volume_db"]], refs: { track: "track" },
  },
  {
    command: "routing_get", summary: "Read routing", mutating: false, destructive: "never", conditions: [],
    description: `Read a track's input and output routing (type and channel, plus the available options by display name). The master has no input.`,
    properties: { track: TRACK_SEL }, required: ["track"], refs: { track: "track" },
  },
  {
    command: "routing_set", summary: "Change routing", mutating: true, destructive: "never", conditions: [], idempotent: true,
    description: `Set input/output routing by display name, applied in the order input_type, input_channel, output_type, output_channel. Names must match the available options (see routing_get). Routing an audio track to an external input is refused when that track is armed or monitoring In (arm it or monitor it In afterwards with set_track_properties, which asks the owner).`,
    properties: { track: TRACK_SEL, input_type: str(128), input_channel: str(128), output_type: str(128), output_channel: str(128) },
    required: ["track"], refs: { track: "track" },
  },

  // ---- scenes
  {
    command: "scene_list", summary: "List scenes", mutating: false, destructive: "never", conditions: [],
    description: `List scenes with name, color, tempo, time signature and trigger state. Paged.`,
    properties: { ...PAGING },
  },
  {
    command: "scene_create", summary: "Create a scene", mutating: true, destructive: "never", conditions: [],
    description: `Create a scene. index -1 (default) appends. tempo is BPM 20..999. ${LITE}`,
    properties: { index: int(-1), name: NAME, color: COLOR, tempo: num(20, 999) },
  },
  {
    command: "scene_delete", summary: "Delete scene", mutating: true, destructive: "always", conditions: [],
    description: `Delete a scene with its clips. Destructive but undoable (one undo step: Cmd-Z in Live, or the undo tool).`,
    properties: { scene: SCENE_SEL, expect_name: str(128, undefined, "Guard: the scene must have this name.") }, required: ["scene"], refs: { scene: "scene" },
  },
  {
    command: "scene_duplicate", summary: "Duplicate a scene", mutating: true, destructive: "never", conditions: [],
    description: `Duplicate a scene with its clips. ${LITE}`,
    properties: { scene: SCENE_SEL }, required: ["scene"], refs: { scene: "scene" },
  },
  {
    command: "scene_set", summary: "Change a scene", mutating: true, destructive: "never", conditions: [], idempotent: true,
    description: `Change a scene's name, color, tempo (BPM 20..999, or null to disable) or time_signature ([numerator, denominator] or null to disable).`,
    properties: {
      scene: SCENE_SEL, name: NAME, color: COLOR, tempo: oneOf(num(20, 999), nullValue),
      time_signature: oneOf(arr(int(), 2, 2), nullValue),
    },
    required: ["scene"], refs: { scene: "scene" },
  },
  {
    command: "scene_fire", summary: "Launch a scene", mutating: true, destructive: "never", conditions: [],
    description: `Launch a scene (all its clips). as_selected launches the selected scene instead of firing this one. It asks the owner once (a decline cancels) when it would start recording on an armed track while an external audio input is live.`,
    properties: { scene: SCENE_SEL, force_legato: bool(), can_select_scene_on_launch: bool(), as_selected: bool() },
    required: ["scene"], refs: { scene: "scene" },
  },
  {
    command: "scene_capture", summary: "Capture a scene", mutating: true, destructive: "never", conditions: [],
    description: `Capture the currently playing clips into a new scene inserted after the selected scene. ${LITE}`,
    properties: {},
  },

  // ---- cue points
  {
    command: "cue_list", summary: "List cue points", mutating: false, destructive: "never", conditions: [],
    description: `List arrangement cue points (locators) with index, name and time in beats. ${BEATS} Paged.`,
    properties: { ...PAGING },
  },
  {
    command: "cue_create", summary: "Create a cue point", mutating: true, destructive: "never", conditions: [],
    description: `Create a cue point at a time in beats (>= 0). Fails while the transport is playing or when a cue point already exists there. It waits for Live's ticks, so inside batch it is refused (not_supported, reason needs_ticks): call it on its own. ${BEATS}`,
    properties: { time: num(0), name: NAME }, required: ["time"],
  },
  {
    command: "cue_delete", summary: "Delete cue point", mutating: true, destructive: "always", conditions: [],
    description: `Delete a cue point by index. Fails while playing. expect_time (beats) guards against shifted indices. Cannot run inside batch (refused not_supported, reason needs_ticks): call it on its own. Destructive but undoable (one undo step: Cmd-Z in Live, or the undo tool).`,
    properties: { index: int(0), expect_time: num() }, required: ["index"],
  },
  {
    command: "cue_set", summary: "Rename a cue point", mutating: true, destructive: "never", conditions: [], idempotent: true,
    description: `Rename an arrangement cue point (locator) identified by its index.`,
    properties: { index: int(0), name: NAME }, required: ["index", "name"],
  },
  {
    command: "cue_jump", summary: "Jump to a cue point", mutating: true, destructive: "never", conditions: [],
    description: `Move the playhead to a cue point by index, or to the next/prev cue point. Give index or direction. Returns current_song_time in beats.`,
    properties: { index: int(0), direction: enumOf("next", "prev") }, exclusive: [["index", "direction"]],
  },

  // ---- application views (move Live's UI only; the set is never written)
  {
    command: "view_show", summary: "Show a view", mutating: false, destructive: "never", conditions: [],
    description: `Show a Live view: session, arrangement, detail_clip, detail_device or browser. Only moves the UI. Returns {view, visible}.`,
    properties: { view: VIEWS }, required: ["view"],
  },
  {
    command: "view_focus", summary: "Focus a view", mutating: false, destructive: "never", conditions: [],
    description: `Give keyboard focus to a Live view (session, arrangement, detail_clip, detail_device or browser). Only moves the UI.`,
    properties: { view: VIEWS }, required: ["view"],
  },
  {
    command: "view_get", summary: "Read the views", mutating: false, destructive: "never", conditions: [],
    description: `Report which main view is shown (session or arrangement) and which panels are visible.`,
    properties: {},
  },
];
