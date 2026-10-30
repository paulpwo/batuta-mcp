import { CLIP_SEL, COLOR, NAME, PAGING, PARAM_SEL, SCENE_SEL, SLOT, SLOT_REF, TRACK_ONLY_SEL, arr, bool, enumOf, int, num, obj, str } from "./schemas.js";
import type { CommandSpec } from "./types.js";

/** Clips, notes, envelopes and arrangement (docs/01-protocol.md sections 7.6, 7.7 and 7.11). */

const BEATS = "Times and lengths are in beats (quarter note = 1.0).";
/** Clip markers are the exception: Live reports them in seconds for an audio clip with warping off. */
const CLIP_BEATS = `${BEATS} Exception: for an audio clip with warping off, Live reports loop_start, loop_end, start_marker and end_marker in SECONDS (a 0.9 s file has loop_end 0.9); length stays in beats.`;
export const OVERWRITE_NOTE = "allow_overwrite:true replaces existing content and is destructive but undoable (one undo step).";
const overwrite = (args: Record<string, unknown>): string | null => (args["allow_overwrite"] === true ? "overwrites existing content (allow_overwrite)" : null);

const NOTE_FIELDS = {
  pitch: int(0, 127, "MIDI pitch 0..127 (60 = middle C)."),
  start_time: num(0, undefined, "Start in beats, relative to the clip start."),
  duration: num(0.0001, undefined, "Length in beats (> 0)."),
  velocity: num(1, 127, "1..127, default 100."),
  mute: bool(),
  probability: num(0, 1, "0..1, default 1."),
  velocity_deviation: num(-127, 127),
  release_velocity: num(0, 127, "Default 64."),
};

export const CLIP_SPECS: CommandSpec[] = [
  {
    command: "clip_list", summary: "List clip slots", mutating: false, destructive: "never", conditions: [],
    description: `List the clip slots of a regular track (session view) with clip summaries. include_empty adds empty slots. Paged.`,
    properties: { track: TRACK_ONLY_SEL, include_empty: bool(), ...PAGING }, required: ["track"], refs: { track: "trackOnly" },
  },
  {
    command: "clip_get", summary: "Read a clip", mutating: false, destructive: "never", conditions: [],
    description: `Read a session or arrangement clip: name, color, length, start/end, loop and markers (beats), signature, play state, gain, pitch, warping, and for audio clips file_path and sample_rate. ${CLIP_BEATS}`,
    properties: { clip: CLIP_SEL }, required: ["clip"], refs: { clip: "clip" },
  },
  {
    command: "slot_status", summary: "Read a clip slot", mutating: false, destructive: "never", conditions: [],
    description: `Read one clip slot: has_clip, is_playing, is_recording, is_triggered and the clip summary.`,
    properties: { track: TRACK_ONLY_SEL, slot: SLOT }, required: ["track", "slot"], refs: { track: "trackOnly" },
  },
  {
    command: "clip_create", summary: "Create a clip", mutating: true, destructive: "never", conditions: [],
    description: `Create an empty MIDI clip in an empty slot of a MIDI track. length is in beats (0.25..1024; ${BEATS}).`,
    properties: { track: TRACK_ONLY_SEL, slot: SLOT, length: num(0.25, 1024, "Clip length in beats."), name: NAME, color: COLOR },
    required: ["track", "slot", "length"], refs: { track: "trackOnly" },
  },
  {
    command: "audio_clip_create", summary: "Import an audio file as a clip", mutating: true, destructive: "conditional", conditions: ["allow_overwrite"],
    description: `Import an audio file (.wav .aif .aiff .flac .mp3) onto an audio track. Session form: {track, slot, file_path} into an empty slot. Arrangement form: {track, position (beats), file_path, allow_overwrite?}; overlapping existing clips is refused unless allow_overwrite is true (destructive but undoable as one undo step). The file must be an absolute path to an existing regular audio file (and inside a configured sample folder, if the user set any); the server checks the path and sends only its own validated copy. Live may write an .asd analysis file next to the sample. ${CLIP_BEATS}`,
    properties: { track: TRACK_ONLY_SEL, slot: SLOT, position: num(0), file_path: str(1024, 1, "Absolute path of the audio file."), allow_overwrite: bool() },
    required: ["track", "file_path"], refs: { track: "trackOnly" }, condition: overwrite,
  },
  {
    command: "clip_delete", summary: "Delete clip", mutating: true, destructive: "always", conditions: [],
    description: `Delete a session or arrangement clip. expect_name guards against the wrong clip. Destructive but undoable (one undo step: Cmd-Z in Live, or the undo tool).`,
    properties: { clip: CLIP_SEL, expect_name: str(128, undefined, "Guard: the clip must have this name.") }, required: ["clip"], refs: { clip: "clip" },
  },
  {
    command: "clip_duplicate", summary: "Duplicate a clip", mutating: true, destructive: "conditional", conditions: ["allow_overwrite"],
    description: `Duplicate a session clip from one slot to another slot (to), or without to into a new scene below (may create a scene; on Live Lite at most 16 scenes). An occupied target needs allow_overwrite:true. ${OVERWRITE_NOTE}`,
    properties: { from: SLOT_REF, to: SLOT_REF, allow_overwrite: bool() }, required: ["from"], refs: { from: "slotref", to: "slotref" }, condition: overwrite,
  },
  {
    command: "clip_set", summary: "Change a clip", mutating: true, destructive: "never", conditions: [], idempotent: true,
    description: `Change a clip's name, color, muted, looping, loop_start, loop_end, start_marker, end_marker (beats, 0..1000000), gain (audio, 0..1), pitch_coarse (-48..48 semitones), pitch_fine (-50..50 cents) or warping. ${CLIP_BEATS} The same unit applies when you set the markers.`,
    properties: {
      clip: CLIP_SEL, name: NAME, color: COLOR, muted: bool(), looping: bool(), loop_start: num(0, 1_000_000), loop_end: num(0, 1_000_000),
      start_marker: num(0, 1_000_000), end_marker: num(0, 1_000_000), gain: num(0, 1), pitch_coarse: int(-48, 48), pitch_fine: num(-50, 50), warping: bool(),
    },
    required: ["clip"], refs: { clip: "clip" },
  },
  {
    command: "clip_crop", summary: "Crop clip", mutating: true, destructive: "always", conditions: [],
    description: `Crop a clip to its loop: material outside the loop is discarded. Destructive but undoable (one undo step: Cmd-Z in Live, or the undo tool).`,
    properties: { clip: CLIP_SEL }, required: ["clip"], refs: { clip: "clip" },
  },
  {
    command: "clip_duplicate_loop", summary: "Duplicate a clip's loop", mutating: true, destructive: "never", conditions: [],
    description: `Double the clip's loop: the loop content is duplicated and the loop length doubles.`,
    properties: { clip: CLIP_SEL }, required: ["clip"], refs: { clip: "clip" },
  },
  {
    command: "slot_fire", summary: "Launch a clip slot", mutating: true, destructive: "never", conditions: [],
    description: `Launch a clip slot. On an empty slot of an armed MIDI track it starts recording; record_length (0.25..256 beats) limits the recording. launch_quantization 0..13 overrides the quantization (0 = none). It asks the owner once (a decline cancels) when it would record while an external audio input is live. ${BEATS}`,
    properties: { track: TRACK_ONLY_SEL, slot: SLOT, record_length: num(0.25, 256), launch_quantization: int(0, 13) },
    required: ["track", "slot"], refs: { track: "trackOnly" },
  },
  {
    command: "slot_stop", summary: "Stop a clip slot", mutating: true, destructive: "never", conditions: [],
    description: `Stop the clip playing in one clip slot of a regular track (it stops at the next launch quantization).`,
    properties: { track: TRACK_ONLY_SEL, slot: SLOT }, required: ["track", "slot"], refs: { track: "trackOnly" },
  },
  {
    command: "notes_get", summary: "Read notes", mutating: false, destructive: "never", conditions: [],
    description: `Read the notes of a MIDI clip sorted by start_time then pitch. Defaults cover every note. Filter with from_pitch/pitch_span and from_time/time_span (beats, relative to the clip start). Each note has note_id, pitch, start_time, duration, velocity, mute, probability, velocity_deviation, release_velocity. Paged (limit up to 5000, also byte-limited; follow next_offset). ${BEATS}`,
    properties: {
      clip: CLIP_SEL, from_pitch: int(0, 127), pitch_span: int(1, 128), from_time: num(-1_000_000), time_span: num(0),
      limit: int(1, 5000), offset: int(0),
    },
    required: ["clip"], refs: { clip: "clip" },
  },
  {
    command: "notes_add", summary: "Add notes", mutating: true, destructive: "never", conditions: [],
    description: `Add 1..2000 notes to a MIDI clip. start_time and duration are in beats relative to the clip start (quarter note = 1.0); pitch 0..127; velocity 1..127 (default 100); probability 0..1.`,
    properties: { clip: CLIP_SEL, notes: arr(obj(NOTE_FIELDS, ["pitch", "start_time", "duration"]), 1, 2000) }, required: ["clip", "notes"], refs: { clip: "clip" },
  },
  {
    command: "notes_remove", summary: "Remove notes", mutating: true, destructive: "always", conditions: [],
    description: `Remove notes from a MIDI clip: by note_ids, or by a pitch/time range (from_pitch, pitch_span, from_time, time_span in beats), or all notes when no filter is given. Destructive but undoable (one undo step: Cmd-Z in Live, or the undo tool).`,
    properties: {
      clip: CLIP_SEL, from_pitch: int(0, 127), pitch_span: int(1, 128), from_time: num(-1_000_000), time_span: num(0),
      note_ids: arr(int(0), 1, 2000),
    },
    required: ["clip"], refs: { clip: "clip" },
    exclusive: [["note_ids", "from_pitch"], ["note_ids", "pitch_span"], ["note_ids", "from_time"], ["note_ids", "time_span"]],
  },
  {
    command: "notes_modify", summary: "Modify notes", mutating: true, destructive: "never", conditions: [],
    description: `Change existing notes by note_id (get ids from notes_get); give only the fields to change. Times are in beats. Unknown ids are an error.`,
    properties: { clip: CLIP_SEL, notes: arr(obj({ note_id: int(0), ...NOTE_FIELDS }, ["note_id"]), 1, 2000) }, required: ["clip", "notes"], refs: { clip: "clip" },
  },
  {
    command: "notes_quantize", summary: "Quantize notes", mutating: true, destructive: "never", conditions: [],
    description: `Quantize the notes of a MIDI clip to a grid (1/4, 1/8, 1/16 or 1/32). amount 0..1 (default 1) is the strength; pitch limits it to one pitch.`,
    properties: { clip: CLIP_SEL, grid: enumOf("1/4", "1/8", "1/16", "1/32"), amount: num(0, 1), pitch: int(0, 127) }, required: ["clip", "grid"], refs: { clip: "clip" },
  },

  // ---- envelopes
  {
    command: "envelope_list", summary: "List envelopes", mutating: false, destructive: "never", conditions: [],
    description: `List which parameters of a session clip's track (mixer volume, pan, sends and up to 1000 device parameters) have an automation envelope on that clip. Not supported for arrangement clips.`,
    properties: { clip: CLIP_SEL }, required: ["clip"], refs: { clip: "clip" },
  },
  {
    command: "envelope_get", summary: "Read an envelope", mutating: false, destructive: "never", conditions: [],
    description: `Sample a clip envelope: points (2..512, default 128) of {time, value} between from and to (beats, default the whole clip). Values are raw parameter values. ${BEATS}`,
    properties: { clip: CLIP_SEL, param: PARAM_SEL, from: num(0), to: num(0), points: int(2, 512) }, required: ["clip", "param"], refs: { clip: "clip", param: "param" },
  },
  {
    command: "envelope_set", summary: "Write an envelope", mutating: true, destructive: "conditional", conditions: ["replace"],
    description: `Write automation steps {time, duration, value} (1..1024) into a session clip's envelope. time and duration are in beats within the clip length; value is the raw parameter value within the parameter's min/max. replace:true first clears the existing envelope and is destructive but undoable (one undo step). ${BEATS}`,
    properties: {
      clip: CLIP_SEL, param: PARAM_SEL,
      steps: arr(obj({ time: num(0), duration: num(0.0001), value: num() }, ["time", "duration", "value"]), 1, 1024), replace: bool(),
    },
    required: ["clip", "param", "steps"], refs: { clip: "clip", param: "param" },
    condition: (args) => (args["replace"] === true ? "replaces the existing envelope (replace)" : null),
  },
  {
    command: "envelope_clear", summary: "Clear envelope", mutating: true, destructive: "always", conditions: [],
    description: `Remove the automation envelope of one parameter from a session clip. Destructive but undoable (one undo step: Cmd-Z in Live, or the undo tool).`,
    properties: { clip: CLIP_SEL, param: PARAM_SEL }, required: ["clip", "param"], refs: { clip: "clip", param: "param" },
  },
  {
    command: "envelope_clear_all", summary: "Clear all envelopes", mutating: true, destructive: "always", conditions: [],
    description: `Remove every automation envelope from a session clip. Destructive but undoable (one undo step: Cmd-Z in Live, or the undo tool).`,
    properties: { clip: CLIP_SEL }, required: ["clip"], refs: { clip: "clip" },
  },

  // ---- arrangement
  {
    command: "arrangement_clips", summary: "List arrangement clips", mutating: false, destructive: "never", conditions: [],
    description: `List the arrangement clips of a regular track with index, name, start_time, end_time, length (timeline extent) and loop_length, in beats; from/to limit the time range. The index is what clip selectors with kind "arrangement" use. ${BEATS} Paged.`,
    properties: { track: TRACK_ONLY_SEL, from: num(0), to: num(0), ...PAGING }, required: ["track"], refs: { track: "trackOnly" },
  },
  {
    command: "arrangement_clip_create", summary: "Create an arrangement clip", mutating: true, destructive: "never", conditions: [],
    description: `Create an empty MIDI clip on the arrangement timeline of a MIDI track: start >= 0 and length 0.25..4096, both in beats. Overlap with existing clips is an error. ${BEATS}`,
    properties: { track: TRACK_ONLY_SEL, start: num(0), length: num(0.25, 4096), name: NAME }, required: ["track", "start", "length"], refs: { track: "trackOnly" },
  },
  {
    command: "arrangement_duplicate", summary: "Copy a clip to the arrangement", mutating: true, destructive: "conditional", conditions: ["allow_overwrite"],
    description: `Copy a session or arrangement clip (source) onto the arrangement timeline of a track at time (beats). Overlap with existing clips is an error unless allow_overwrite:true. ${OVERWRITE_NOTE} ${BEATS}`,
    properties: { source: CLIP_SEL, track: TRACK_ONLY_SEL, time: num(0), allow_overwrite: bool() }, required: ["source", "track", "time"],
    refs: { source: "clip", track: "trackOnly" }, condition: overwrite,
  },
  {
    command: "arrangement_commit_scene", summary: "Commit a scene to the arrangement", mutating: true, destructive: "conditional", conditions: ["allow_overwrite"],
    description: `Copy a scene's session clips to the arrangement at time (beats), for all tracks or only the listed tracks (one undo step). Overlap is an error unless allow_overwrite:true. ${OVERWRITE_NOTE} ${BEATS}`,
    properties: { scene: SCENE_SEL, time: num(0), tracks: arr(TRACK_ONLY_SEL, 1, 256), allow_overwrite: bool() }, required: ["scene", "time"],
    refs: { scene: "scene", tracks: "trackOnlyList" }, condition: overwrite,
  },
];
