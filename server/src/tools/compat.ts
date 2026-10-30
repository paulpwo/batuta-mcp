import { enumOf, int, literal, num, obj, oneOf, str } from "./schemas.js";
import type { CommandSpec, CompatSpec } from "./types.js";
import { asObject, field, invalidArgs } from "./util.js";
import type { Schema } from "../validate/index.js";
import type { Json } from "./util.js";

/**
 * Compat argument sets (docs/03-tool-names.md, "Argument aliases"): the compatibility names
 * (track_index, clip_index, scene_index, device_index, parameter_index, destination_time, path, on)
 * and their relatives, mapped onto the broad selectors before planning. Index arguments
 * mean regular tracks and session slots, as in those servers.
 */

const trackIndex = int(0);
const clipIndex = int(0);
const deviceIndex = int(0);

const trackRef = (index: unknown): Json => ({ kind: "track", index });
const sessionClip = (given: Json): Json => ({ kind: "session", track: trackRef(given["track_index"]), slot: given["clip_index"] });

/** The track of a device call: track_index, or a full track selector for returns and master. */
export function deviceTrack(given: Json): unknown {
  const byIndex = given["track_index"];
  const bySelector = given["track"];
  if ((byIndex === undefined) === (bySelector === undefined)) throw invalidArgs("Give either track_index or track to say where the device is.", { reason: "selector" });
  return byIndex === undefined ? bySelector : trackRef(byIndex);
}
const devicePath = (given: Json): Json => ({ track: deviceTrack(given), path: [given["device_index"]] });

/** Short track reference for returns and master (the long selector with names stays on the broad tools). */
export const TRACK_REF: Schema = oneOf(obj({ kind: literal("master") }, ["kind"]), obj({ kind: enumOf("track", "return"), index: int(0) }, ["kind", "index"]));
TRACK_REF.description = "Instead of track_index: returns and master.";

const DEVICE_PROPS = { track_index: trackIndex, track: TRACK_REF, device_index: deviceIndex };

function clipForm(supplies: string[], build: (given: Json) => Json): CompatSpec {
  return { properties: { track_index: trackIndex, clip_index: clipIndex }, supplies, together: ["track_index", "clip_index"], build };
}
const trackOnly = (supplies: string[] = ["track"]): CompatSpec => ({ properties: { track_index: trackIndex }, supplies, build: (g) => ({ track: trackRef(g["track_index"]) }) });

const sceneOnly = (): CompatSpec => ({ properties: { scene_index: int(0) }, supplies: ["scene"], build: (g) => ({ scene: g["scene_index"] }) });
/** A clip selector given as track_index + clip_index (session clips). */
const sessionClipForm = (): CompatSpec => clipForm(["clip"], (g) => ({ clip: sessionClip(g) }));
/** The device chain of a regular track (empty path) given as track_index. */
const trackChain = (): CompatSpec => ({ properties: { track_index: trackIndex }, supplies: ["container"], build: (g) => ({ container: { track: trackRef(g["track_index"]), path: [] } }) });
/** A device given as track_index (or a track selector) + device_index. */
const deviceForm = (): CompatSpec => ({ properties: DEVICE_PROPS, supplies: ["device"], together: ["device_index"], build: (g) => ({ device: devicePath(g) }) });

function paramForm(supplies: string[] = []): CompatSpec {
  return {
    properties: { ...DEVICE_PROPS, parameter_index: int(0), parameter: oneOf(int(0), str(128, 1)) }, supplies, together: ["device_index"],
    build: (g) => {
      const byIndex = g["parameter_index"];
      const byAny = g["parameter"];
      if ((byIndex === undefined) === (byAny === undefined)) throw invalidArgs("Give either parameter_index or parameter.", { reason: "selector" });
      const which = byIndex !== undefined ? { index: byIndex } : typeof byAny === "number" ? { index: byAny } : { name: byAny };
      return { param: { device: devicePath(g), ...which } };
    },
  };
}

const COMPAT: Record<string, CompatSpec> = {
  track_get: trackOnly(),
  track_set: trackOnly(),
  track_select: trackOnly(),
  track_stop_clips: trackOnly(),
  mixer_get: trackOnly(),
  mixer_set: trackOnly(),
  routing_get: trackOnly(),
  routing_set: trackOnly(),
  clip_list: trackOnly(),
  slot_status: clipForm(["track", "slot"], (g) => ({ track: trackRef(g["track_index"]), slot: g["clip_index"] })),
  arrangement_clip_create: trackOnly(),
  scene_duplicate: sceneOnly(),
  scene_set: sceneOnly(),
  arrangement_commit_scene: sceneOnly(),
  device_list: trackChain(),
  device_insert: trackChain(),
  clip_get: sessionClipForm(),
  clip_set: sessionClipForm(),
  clip_crop: sessionClipForm(),
  clip_duplicate_loop: sessionClipForm(),
  notes_modify: sessionClipForm(),
  notes_quantize: sessionClipForm(),
  envelope_list: sessionClipForm(),
  envelope_clear_all: sessionClipForm(),
  rack_get: deviceForm(),
  chain_set: deviceForm(),
  rack_insert_chain: deviceForm(),
  rack_variation: deviceForm(),
  drum_pads_list: deviceForm(),
  drum_pad_set: deviceForm(),
  drum_pad_copy: deviceForm(),
  drum_pad_clear: deviceForm(),
  track_delete: trackOnly(),
  track_duplicate: trackOnly(),
  scene_delete: sceneOnly(),
  scene_fire: sceneOnly(),
  clip_delete: clipForm(["clip"], (g) => ({ clip: sessionClip(g) })),
  clip_duplicate: clipForm(["from"], (g) => ({ from: { track: trackRef(g["track_index"]), slot: g["clip_index"] } })),
  notes_get: clipForm(["clip"], (g) => ({ clip: sessionClip(g) })),
  notes_add: clipForm(["clip"], (g) => ({ clip: sessionClip(g) })),
  notes_remove: clipForm(["clip"], (g) => ({ clip: sessionClip(g) })),
  clip_create: clipForm(["track", "slot"], (g) => ({ track: trackRef(g["track_index"]), slot: g["clip_index"] })),
  audio_clip_create: {
    properties: { track_index: trackIndex, clip_index: clipIndex, path: str(1024, 1, "Absolute path of the audio file (same as file_path).") },
    supplies: ["track", "file_path"],
    build: (g) => ({ ...(g["track_index"] === undefined ? {} : { track: trackRef(g["track_index"]) }), ...(g["clip_index"] === undefined ? {} : { slot: g["clip_index"] }), ...(g["path"] === undefined ? {} : { file_path: g["path"] }) }),
  },
  slot_fire: clipForm(["track", "slot"], (g) => ({ track: trackRef(g["track_index"]), slot: g["clip_index"] })),
  slot_stop: clipForm(["track", "slot"], (g) => ({ track: trackRef(g["track_index"]), slot: g["clip_index"] })),
  arrangement_clips: trackOnly(),
  arrangement_duplicate: {
    properties: { track_index: trackIndex, clip_index: clipIndex, destination_time: num(0, undefined, "Beat on the arrangement timeline.") },
    supplies: ["source", "track", "time"], together: ["track_index", "clip_index", "destination_time"],
    build: (g) => ({ source: sessionClip(g), track: trackRef(g["track_index"]), time: g["destination_time"] }),
  },
  browser_load: trackOnly(),
  device_get: { properties: DEVICE_PROPS, supplies: ["device"], together: ["device_index"], build: (g) => ({ device: devicePath(g) }) },
  device_enable: {
    properties: { ...DEVICE_PROPS, on: { type: "boolean" } }, supplies: ["device", "enabled"], together: ["device_index"],
    build: (g) => ({ device: devicePath(g), ...(g["on"] === undefined ? {} : { enabled: g["on"] }) }),
  },
  device_delete: { properties: DEVICE_PROPS, supplies: ["device"], together: ["device_index"], build: (g) => ({ device: devicePath(g) }) },
  param_set: paramForm(),
  param_get: paramForm(["param"]),
};

/** Attach the compat sets to the base specs. */
export function withCompat(specs: CommandSpec[]): CommandSpec[] {
  return specs.map((spec) => {
    const compat = Object.entries(COMPAT).find(([command]) => command === spec.command)?.[1];
    return compat === undefined ? spec : { ...spec, compat };
  });
}

/** Properties and required list a tool publishes: the broad ones plus the compat names. */
export function publishedShape(spec: CommandSpec): { properties: Record<string, Schema>; required: string[] } {
  const supplied = new Set(spec.compat?.supplies ?? []);
  return {
    properties: { ...spec.properties, ...(spec.compat?.properties ?? {}) },
    required: (spec.required ?? []).filter((name) => !supplied.has(name)),
  };
}

/**
 * Map compat arguments onto the broad ones and check what the broad form requires. The result has
 * no compat key, so everything after this point (guards, wire, confirmation) sees the broad call.
 */
export function applyCompat(spec: CommandSpec, args: Json, op?: number): Json {
  const compat = spec.compat;
  if (compat === undefined) return args;
  const where: Json = op === undefined ? {} : { op };
  const names = Object.keys(compat.properties);
  const given = Object.fromEntries(Object.entries(args).filter(([key, value]) => names.includes(key) && value !== undefined));
  const rest = Object.fromEntries(Object.entries(args).filter(([key]) => !(key in given)));
  let out = rest;
  if (Object.keys(given).length > 0) {
    const missing = (compat.together ?? []).filter((key) => !(key in given));
    if (missing.length > 0) {
      // Broad arguments are already there: the caller mixed the two forms, so point at the broad name.
      const broad = compat.supplies.filter((key) => field(rest, key) !== undefined);
      const hint = broad.length === 0 ? "" : ` With ${broad.join(" and ")} use the broad arguments (${compat.supplies.join(", ")}) instead of ${Object.keys(given).join(", ")}${"destination_time" in given ? " (use time, not destination_time)" : ""}.`;
      throw invalidArgs(`Also give ${missing.join(" and ")}: these compatibility arguments only work together.${hint}`, { reason: "compat_incomplete", missing, ...where });
    }
    const built = compat.build(given);
    for (const key of Object.keys(built)) {
      if (field(rest, key) !== undefined) throw invalidArgs(`${Object.keys(given).join(", ")} cannot be combined with ${key}.`, { reason: "mutually_exclusive", fields: [...Object.keys(given), key], ...where });
    }
    out = { ...rest, ...built };
  }
  for (const name of spec.required ?? []) {
    if (field(out, name) === undefined) throw invalidArgs(`${name} is required${compat.supplies.includes(name) ? ` (or its compat form: ${names.join(", ")})` : ""}.`, { reason: "missing", field: name, ...where });
  }
  return asObject(out);
}
