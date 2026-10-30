import type { Schema } from "../validate/index.js";

/**
 * Schema fragments shared by the tool definitions. Tool schemas accept, wherever the wire needs a
 * reference (docs/01-protocol.md section 6.1), either the reference itself or a name selector
 * (section 7.16); the server turns names into indices with fresh listings before it sends anything.
 */

export const int = (minimum?: number, maximum?: number, description?: string): Schema => ({
  type: "integer", ...(minimum === undefined ? {} : { minimum }), ...(maximum === undefined ? {} : { maximum }),
  ...(description === undefined ? {} : { description }),
});
export const num = (minimum?: number, maximum?: number, description?: string): Schema => ({
  type: "number", ...(minimum === undefined ? {} : { minimum }), ...(maximum === undefined ? {} : { maximum }),
  ...(description === undefined ? {} : { description }),
});
export const str = (maxLength = 128, minLength?: number, description?: string): Schema => ({
  type: "string", maxLength, ...(minLength === undefined ? {} : { minLength }), ...(description === undefined ? {} : { description }),
});
export const bool = (description?: string): Schema => ({ type: "boolean", ...(description === undefined ? {} : { description }) });
export const enumOf = (...values: Array<string | number>): Schema => ({ enum: values });
export const literal = (value: string): Schema => ({ type: "string", const: value });
export const arr = (items: Schema, minItems: number | undefined, maxItems: number, description?: string): Schema => ({
  type: "array", items, ...(minItems === undefined ? {} : { minItems }), maxItems, ...(description === undefined ? {} : { description }),
});
export const obj = (properties: Record<string, Schema>, required: string[] = [], description?: string): Schema => ({
  type: "object", properties, ...(required.length === 0 ? {} : { required }), additionalProperties: false,
  ...(description === undefined ? {} : { description }),
});
export const oneOf = (...branches: Schema[]): Schema => ({ oneOf: branches });
export const nullValue: Schema = { const: null };

export const COLOR = int(0, 0xffffff, "Color as 0xRRGGBB integer (0..16777215).");
export const NAME = str(128, undefined, "Name, up to 128 characters.");
export const SLOT = int(0, undefined, "Clip slot index (0-based).");

export const PAGING: Record<string, Schema> = {
  limit: int(1, 500, "Page size, default 100, maximum 500."),
  offset: int(0, undefined, "Items to skip (use next_offset from the previous page)."),
};

const BY_NAME = obj({ name: str(128, 1) }, ["name"]);

/** TrackSel: a track, return or master reference, or a name selector. */
export const TRACK_SEL: Schema = oneOf(
  obj({ kind: enumOf("track", "return"), index: int(0), expect_name: str(128) }, ["kind", "index"]),
  obj({ kind: literal("master"), expect_name: str(128) }, ["kind"]),
  obj({ name: str(128, 1), kind: enumOf("track", "return", "master") }, ["name"]),
);
TRACK_SEL.description = 'Track selector: {"kind":"track"|"return","index":n}, {"kind":"master"}, or {"name":"..."} (optionally with kind). Optional expect_name guards against shifted indices.';

/** TrackSel restricted to regular tracks (session clips and arrangement exist only there). */
export const TRACK_ONLY_SEL: Schema = oneOf(
  obj({ kind: literal("track"), index: int(0), expect_name: str(128) }, ["kind", "index"]),
  obj({ name: str(128, 1) }, ["name"]),
);
TRACK_ONLY_SEL.description = 'Regular track (not a return or master): {"kind":"track","index":n} or {"name":"..."}.';

/** A regular track or a return (no master), for commands that cannot act on the master. */
export const TRACK_RETURN_SEL: Schema = oneOf(
  obj({ kind: enumOf("track", "return"), index: int(0), expect_name: str(128) }, ["kind", "index"]),
  obj({ name: str(128, 1), kind: enumOf("track", "return") }, ["name"]),
);
TRACK_RETURN_SEL.description = 'Track or return: {"kind":"track"|"return","index":n} or {"name":"...","kind"?}.';

export const SCENE_SEL: Schema = oneOf(int(0), BY_NAME);
SCENE_SEL.description = 'Scene index (0-based) or {"name":"..."}.';

const IDX_OR_NAME: Schema = oneOf(int(0), BY_NAME);
const STEP_CHAIN = obj({ chain: IDX_OR_NAME, device: IDX_OR_NAME }, ["chain", "device"]);
const STEP_RETURN = obj({ return_chain: IDX_OR_NAME, device: IDX_OR_NAME }, ["return_chain", "device"]);
const STEP_PAD = obj({ drum_pad: int(0, 127), chain: IDX_OR_NAME, device: IDX_OR_NAME }, ["drum_pad", "chain", "device"]);
const HOP_DEVICE = oneOf(int(0), BY_NAME, STEP_CHAIN, STEP_RETURN, STEP_PAD);
const HOP_CONTAINER = oneOf(
  int(0), BY_NAME, STEP_CHAIN, STEP_RETURN, STEP_PAD,
  obj({ chain: IDX_OR_NAME }, ["chain"]),
  obj({ return_chain: IDX_OR_NAME }, ["return_chain"]),
  obj({ drum_pad: int(0, 127), chain: IDX_OR_NAME }, ["drum_pad", "chain"]),
);

/** DeviceSel: a device on a track; the path starts with the device index (or name) on the track. */
export const DEVICE_SEL: Schema = obj({
  track: TRACK_SEL,
  path: arr(HOP_DEVICE, 1, 8, 'First hop: device index or {"name"} on the track; further hops go into racks: {"chain":c,"device":d}, {"return_chain":c,"device":d}, {"drum_pad":note,"chain":c,"device":d} (c and d are indices or {"name"}).'),
}, ["track", "path"], "A device. Example: {track:{kind:\"track\",index:0}, path:[1]} is the second device of track 0.");

/** ContainerSel: a device chain (empty path = the track's own chain) or a rack chain. */
export const CONTAINER_SEL: Schema = obj({
  track: TRACK_SEL,
  path: arr(HOP_CONTAINER, 0, 8, "Empty path = the track's own device chain. The last hop may name a rack chain: {\"chain\":c}, {\"return_chain\":c}, {\"drum_pad\":note,\"chain\":c}."),
}, ["track", "path"], "A device chain that holds devices.");

/** ParamSel: a device parameter (by index or name) or a mixer parameter. */
export const PARAM_SEL: Schema = oneOf(
  obj({ device: DEVICE_SEL, index: int(0) }, ["device", "index"]),
  obj({ device: DEVICE_SEL, name: str(128, 1) }, ["device", "name"]),
  obj({ mixer: enumOf("volume", "pan", "send"), track: TRACK_SEL, index: int(0, undefined, "Send index (0 = send A); only for mixer \"send\".") }, ["mixer", "track"]),
);
PARAM_SEL.description = 'A parameter: {device, index} or {device, name}, or a mixer parameter {mixer:"volume"|"pan"|"send", track, index?}.';

/** ClipSel: a session clip (track + slot) or an arrangement clip (track + index into arrangement_clips). */
export const CLIP_SEL: Schema = oneOf(
  obj({ kind: literal("session"), track: TRACK_ONLY_SEL, slot: SLOT }, ["kind", "track", "slot"]),
  obj({ kind: literal("arrangement"), track: TRACK_ONLY_SEL, index: int(0), expect_start: num(undefined, undefined, "Guard: the clip must start at this beat (tolerance 1e-6).") }, ["kind", "track", "index"]),
);
CLIP_SEL.description = 'A clip: {"kind":"session","track","slot"} or {"kind":"arrangement","track","index","expect_start"?}.';

export const SLOT_REF: Schema = obj({ track: TRACK_ONLY_SEL, slot: SLOT }, ["track", "slot"], "A clip slot on a regular track.");
