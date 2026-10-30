import type { Schema } from "../validate/index.js";
import { COLOR, NAME, bool, enumOf, int, num, oneOf, str } from "./schemas.js";
import { OVERWRITE_NOTE } from "./specs-clips.js";
import { QUANTIZATION_LABELS } from "./specs-session.js";
import { invalidArgs } from "./util.js";
import type { Json } from "./util.js";

/**
 * Narrow compatibility tools that stand for one field or one fixed form of a
 * broad tool (docs/03-tool-names.md). Each alias only rewrites its arguments onto the broad tool's
 * and runs the same executor path, so every guard (gain, edition, recording safety, expect_name
 * pins, confirmation policy, catalog gate) applies unchanged. Static text; nothing from Live.
 */

export interface AliasSpec {
  /** Public tool name. */
  name: string;
  /** Wire command of the broad tool this alias runs. */
  command: string;
  /** compat: a compatibility name and argument shape; normalized: a new verb_object name. */
  source: "compat" | "normalized";
  title: string;
  description: string;
  properties: Record<string, Schema>;
  required?: string[];
  /** Rewrite the alias arguments into the broad tool's arguments. */
  map: (args: Json) => Json;
}

const TRACK_INDEX = int(0);
const CLIP_INDEX = int(0);
/** Compatibility `track`: an index, "master" or "return:N". */
const TRACK_ID: Schema = oneOf(int(0), { type: "string", maxLength: 12, pattern: "^(master|return:[0-9]{1,3})$" });
TRACK_ID.description = '"master", "return:N" or an index; wins over track_index.';

const track = (index: unknown): Json => ({ kind: "track", index });
const slotClip = (a: Json): Json => ({ kind: "session", track: track(a["track_index"]), slot: a["clip_index"] });

/** track_index, or the compatibility `track` ("master", "return:N", an index) which wins over it. */
function trackOf(a: Json): Json {
  const id = a["track"];
  if (typeof id === "number") return track(id);
  if (id === "master") return { kind: "master" };
  if (typeof id === "string") return { kind: "return", index: Number(id.slice("return:".length)) };
  if (a["track_index"] === undefined) throw invalidArgs("Give track_index (or track).", { reason: "missing", field: "track_index" });
  return track(a["track_index"]);
}

const on = (description = "true or false."): Schema => bool(description);
const TRACK_PROPS = { track_index: TRACK_INDEX };
const MIX_TRACK_PROPS = { track_index: TRACK_INDEX, track: TRACK_ID };

function volumeOf(a: Json): Json {
  const raw = [a["value"], a["value_normalized"]].filter((v) => v !== undefined);
  if (raw.length + (a["volume_db"] === undefined ? 0 : 1) !== 1) throw invalidArgs("Give exactly one of value (raw fader 0..1), value_normalized (same) or volume_db.", { reason: "selector" });
  return a["volume_db"] !== undefined ? { volume_db: a["volume_db"] } : { volume: raw[0] };
}

function simple(name: string, source: AliasSpec["source"], command: string, title: string, description: string, properties: Record<string, Schema>, required: string[], map: AliasSpec["map"]): AliasSpec {
  return { name, source, command, title, description, properties, required, map };
}

const CATEGORY_NAMES = ["instruments", "drums", "sounds", "audio_effects", "midi_effects", "packs", "user_library", "samples", "current_project", "plugins", "max_for_live"];

function browserPath(a: Json): Json {
  const parts = String(a["path"]).split("/").map((part) => part.trim()).filter((part) => part.length > 0);
  const category = (parts[0] ?? "").toLowerCase().replace(/[ -]+/g, "_");
  if (!CATEGORY_NAMES.includes(category)) throw invalidArgs(`The path must start with a browser category: ${CATEGORY_NAMES.join(", ")}.`, { reason: "category", categories: CATEGORY_NAMES });
  return { category, ...(parts.length > 1 ? { path: parts.slice(1) } : {}), ...(a["limit"] === undefined ? {} : { limit: a["limit"] }), ...(a["offset"] === undefined ? {} : { offset: a["offset"] }) };
}

const meter = (ref: Json): Json => ({ tracks: [ref] });

export const ALIAS_SPECS: readonly AliasSpec[] = Object.freeze([
  // ---- tracks
  simple("create_midi_track", "compat", "track_create", "Create a MIDI track", "Create a MIDI track; index -1 (default) appends. Same as create_track with type midi.", { index: int(-1), name: NAME }, [], (a) => ({ type: "midi", ...(a["index"] === undefined ? {} : { index: a["index"] }), ...(a["name"] === undefined ? {} : { name: a["name"] }) })),
  simple("create_audio_track", "compat", "track_create", "Create an audio track", "Create an audio track; index -1 (default) appends. Same as create_track with type audio.", { index: int(-1), name: NAME }, [], (a) => ({ type: "audio", ...(a["index"] === undefined ? {} : { index: a["index"] }), ...(a["name"] === undefined ? {} : { name: a["name"] }) })),
  simple("create_return_track", "compat", "track_create", "Create a return track", "Create a return track (appended). Same as create_track with type return.", { name: NAME }, [], (a) => ({ type: "return", ...(a["name"] === undefined ? {} : { name: a["name"] }) })),
  simple("set_track_name", "compat", "track_set", "Rename a track", "Rename a regular track. Same as set_track_properties with name.", { ...TRACK_PROPS, name: NAME }, ["track_index", "name"], (a) => ({ track: track(a["track_index"]), name: a["name"] })),
  simple("set_track_mute", "compat", "track_set", "Mute a track", "Mute (on true) or unmute a track. Same as set_track_properties with mute.", { ...TRACK_PROPS, on: on() }, ["track_index", "on"], (a) => ({ track: track(a["track_index"]), mute: a["on"] })),
  simple("set_track_solo", "compat", "track_set", "Solo a track", "Solo (on true) or unsolo a track. Same as set_track_properties with solo.", { ...TRACK_PROPS, on: on() }, ["track_index", "on"], (a) => ({ track: track(a["track_index"]), solo: a["on"] })),
  simple("set_track_arm", "compat", "track_set", "Arm a track", "Arm (on true) or disarm a MIDI track. Same as set_track_properties with arm.", { ...TRACK_PROPS, on: on() }, ["track_index", "on"], (a) => ({ track: track(a["track_index"]), arm: a["on"] })),
  simple("set_track_color", "compat", "track_set", "Color a track", "Set a track's color as 0xRRGGBB. Same as set_track_properties with color.", { ...TRACK_PROPS, color: COLOR }, ["track_index", "color"], (a) => ({ track: track(a["track_index"]), color: a["color"] })),
  // ---- mixer
  simple("set_track_volume", "compat", "mixer_set", "Set a track's volume", "Set the volume fader: value (or value_normalized) is the raw 0..1 position (0.85 is about 0 dB); volume_db is -70..6. track 'master' targets the master. Same as set_mixer; the gain guard applies.", { ...MIX_TRACK_PROPS, value: num(0, 1), value_normalized: num(0, 1), volume_db: num(-70, 6, "dB") }, [], (a) => ({ track: trackOf(a), ...volumeOf(a) })),
  simple("set_track_pan", "compat", "mixer_set", "Set a track's pan", "Set pan, -1 (left) .. 1 (right). Same as set_mixer with pan.", { ...MIX_TRACK_PROPS, value: num(-1, 1) }, ["value"], (a) => ({ track: trackOf(a), pan: a["value"] })),
  simple("set_track_send", "compat", "mixer_set", "Set a track's send", "Set send send_index (0 = A) to a raw value. Same as set_mixer with sends.", { ...TRACK_PROPS, send_index: int(0), value: num(), value_normalized: num() }, ["track_index", "send_index"], (a) => {
    if ((a["value"] === undefined) === (a["value_normalized"] === undefined)) throw invalidArgs("Give exactly one of value or value_normalized.", { reason: "selector" });
    return { track: track(a["track_index"]), sends: [{ index: a["send_index"], value: a["value"] ?? a["value_normalized"] }] };
  }),
  // ---- clips and notes
  simple("set_clip_name", "compat", "clip_set", "Rename a clip", "Rename a session clip. Same as set_clip_properties with name.", { ...TRACK_PROPS, clip_index: CLIP_INDEX, name: NAME }, ["track_index", "clip_index", "name"], (a) => ({ clip: slotClip(a), name: a["name"] })),
  simple("set_arrangement_clip_name", "compat", "clip_set", "Rename an arrangement clip", "Rename an arrangement clip; clip_index is its index in get_arrangement_clips. Same as set_clip_properties with an arrangement clip.", { ...TRACK_PROPS, clip_index: int(0, undefined, "Arrangement clip index (get_arrangement_clips)."), name: NAME }, ["track_index", "clip_index", "name"], (a) => ({ clip: { kind: "arrangement", track: track(a["track_index"]), index: a["clip_index"] }, name: a["name"] })),
  simple("set_clip_color", "compat", "clip_set", "Color a clip", "Set a session clip's color as 0xRRGGBB. Same as set_clip_properties with color.", { ...TRACK_PROPS, clip_index: CLIP_INDEX, color: COLOR }, ["track_index", "clip_index", "color"], (a) => ({ clip: slotClip(a), color: a["color"] })),
  simple("set_clip_loop", "compat", "clip_set", "Set a clip's loop", "Set looping, loop_start, loop_end, start_marker, end_marker of a session clip, in beats (in SECONDS for an audio clip with warping off, Live's unit for unwarped audio). Same as set_clip_properties.", { ...TRACK_PROPS, clip_index: CLIP_INDEX, looping: bool(), loop_start: num(0, 1_000_000), loop_end: num(0, 1_000_000), start_marker: num(0, 1_000_000), end_marker: num(0, 1_000_000) }, ["track_index", "clip_index"], (a) => {
    const { track_index: _t, clip_index: _c, ...rest } = a;
    if (Object.keys(rest).length === 0) throw invalidArgs("Give at least one of looping, loop_start, loop_end, start_marker, end_marker.", { reason: "at_least_one" });
    return { clip: slotClip(a), ...rest };
  }),
  simple("clear_notes_from_clip", "compat", "notes_remove", "Clear all notes of a clip", "Remove every note from a session MIDI clip. Destructive but undoable. Same as remove_notes_from_clip with no filter.", { ...TRACK_PROPS, clip_index: CLIP_INDEX }, ["track_index", "clip_index"], (a) => ({ clip: slotClip(a) })),
  // ---- scenes
  simple("set_scene_name", "compat", "scene_set", "Rename a scene", "Rename a scene. Same as set_scene_properties with name.", { scene_index: int(0), name: NAME }, ["scene_index", "name"], (a) => ({ scene: a["scene_index"], name: a["name"] })),
  // ---- song and transport
  simple("set_tempo", "compat", "song_set", "Set the tempo", "Set the tempo in BPM (20..999). Same as set_song_properties with tempo.", { tempo: num(20, 999, "BPM") }, ["tempo"], (a) => ({ tempo: a["tempo"] })),
  simple("set_time_signature", "compat", "song_set", "Set the time signature", "Set the song time signature, e.g. numerator 6, denominator 8. Same as set_song_properties.", { numerator: int(1, 99), denominator: enumOf(1, 2, 4, 8, 16) }, ["numerator", "denominator"], (a) => ({ signature_numerator: a["numerator"], signature_denominator: a["denominator"] })),
  simple("set_metronome", "compat", "song_set", "Switch the metronome", "Turn the metronome on or off. Same as set_song_properties with metronome.", { on: on() }, ["on"], (a) => ({ metronome: a["on"] })),
  simple("set_song_position", "compat", "song_set_time", "Move the playhead", "Move the playhead to a position in beats. Same as set_arrangement_time (time).", { beats: num(0, undefined, "Position in beats.") }, ["beats"], (a) => ({ time: a["beats"] })),
  simple("set_arrangement_record", "compat", "song_set", "Arm arrangement record", "Switch Arrangement Record (record_mode) on (default) or off. Asks the owner once while an external audio input is live. Same as set_song_properties with record_mode.", { on: on() }, [], (a) => ({ record_mode: a["on"] ?? true })),
  simple("set_clip_trigger_quantization", "compat", "song_set", "Set launch quantization", "Set the global clip launch quantization: 0..13 (0 = none) or a label (none, 8 bars ... 1/32). Same as set_song_properties.", { value: oneOf(int(0, 13), enumOf(...QUANTIZATION_LABELS)) }, ["value"], (a) => ({ clip_trigger_quantization: a["value"] })),
  simple("start_playback", "compat", "transport", "Start playback", "Start playback. Same as control_transport start.", {}, [], () => ({ action: "start" })),
  simple("stop_playback", "compat", "transport", "Stop playback", "Stop playback. Same as control_transport stop.", {}, [], () => ({ action: "stop" })),
  simple("continue_playback", "normalized", "transport", "Continue playback", "Continue playback from the current position. Same as control_transport continue.", {}, [], () => ({ action: "continue" })),
  // ---- views and browser
  simple("switch_to_arrangement_view", "compat", "view_show", "Show the arrangement", "Show the Arrangement view (UI only). Same as show_view arrangement.", {}, [], () => ({ view: "arrangement" })),
  simple("switch_to_session_view", "normalized", "view_show", "Show the session view", "Show the Session view (UI only). Same as show_view session.", {}, [], () => ({ view: "session" })),
  simple("capture_session_to_arrangement", "compat", "arrangement_commit_scene", "Copy a scene to the arrangement", `Copy the session clips of scene scene_index to the arrangement at destination_time (beats), all tracks, in one undo step. It copies; it does not record in real time and does not play. An overlap is an error unless allow_overwrite:true. ${OVERWRITE_NOTE} Same as commit_scene_to_arrangement.`, { scene_index: int(0), destination_time: num(0, undefined, "Beat on the arrangement timeline."), allow_overwrite: bool("Overwrite arrangement clips in the way (destructive but undoable).") }, ["scene_index", "destination_time"], (a) => ({ scene: a["scene_index"], time: a["destination_time"], ...(a["allow_overwrite"] === undefined ? {} : { allow_overwrite: a["allow_overwrite"] }) })),
  simple("get_browser_items_at_path", "compat", "browser_list", "List browser items at a path", "List the browser at a path 'category/folder/subfolder' (category: instruments, drums, sounds, audio_effects, midi_effects, packs, user_library, samples, current_project, plugins). Same as list_browser_items; uris come from here.", { path: str(512, 1, "category/folder/subfolder"), limit: int(1, 200), offset: int(0) }, ["path"], browserPath),
  // ---- meters
  simple("get_track_meter", "compat", "meters_get", "Read a track meter", "Read one track's output meter (0..1). track is an index (default 0), 'master' or 'return:N'. Same as get_meters.", { track: TRACK_ID }, [], (a) => meter(a["track"] === undefined ? track(0) : trackOf(a))),
  simple("get_master_meter", "compat", "meters_get", "Read the master meter", "Read the master output meter (0..1). Same as get_meters for the master.", {}, [], () => meter({ kind: "master" })),
]);
