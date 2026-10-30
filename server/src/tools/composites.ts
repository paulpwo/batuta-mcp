import type { ToolAnnotations, ToolContext, ToolRegistry, ToolResult } from "../mcp/index.js";
import { ToolError } from "../mcp/index.js";
import { annotationsFor, specFor } from "./catalog.js";
import type { CommandSpec } from "./types.js";
import { TRACK_REF, deviceTrack } from "./compat.js";
import type { Executor } from "./exec.js";
import { bool, enumOf, int, num, obj, str } from "./schemas.js";
import type { Schema } from "../validate/index.js";
import { asArray, asNumber, asObject, asString, field, invalidArgs, notFound } from "./util.js";
import type { Json } from "./util.js";

/**
 * Server-side composites with compatibility names (docs/03-tool-names.md). They
 * need no script command of their own: every step goes through `Executor.run` on a broad command,
 * so catalog gate, edition, recording safety, expect_name pins and browser rules apply to each
 * step exactly as for a direct call. Nothing here records or sends anything anywhere (no telemetry).
 */

const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITES: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

function plain(text: string, structured: Json): ToolResult {
  const json = JSON.stringify(structured);
  return { content: [{ type: "text", text: json.length <= 6000 ? `${text}\n${json}` : `${text}\nThe full result is in structuredContent.` }], structuredContent: structured };
}

/** One broad command through the executor; an inner confirmation prompt can never be answered from inside a composite. */
export async function compositeStep(executor: Pick<Executor, "run">, command: string, args: Json, context: ToolContext): Promise<Json> {
  const spec = specFor(command);
  if (spec === undefined) throw new ToolError("internal_error", `unknown command ${command}`);
  const result = await executor.run(spec, args, context);
  const out = asObject(result.structuredContent);
  if (out["confirmation_required"] === true || out["cancelled"] === true) {
    throw new ToolError("confirmation_failed", "A step of this tool needed a confirmation, which a combined tool cannot ask for. Use the single tools instead.", { reason: "inner_confirmation", command });
  }
  return out;
}

const step = compositeStep;

/** Every item of a paged listing, up to a cap. */
async function allItems(executor: Pick<Executor, "run">, command: string, args: Json, context: ToolContext, cap = 2000): Promise<Json[]> {
  const items: Json[] = [];
  let offset = 0;
  for (;;) {
    const page = await step(executor, command, { ...args, limit: 500, offset }, context);
    items.push(...asArray(page["items"]).map(asObject));
    const next = asNumber(page["next_offset"]);
    if (next === undefined || next <= offset || items.length >= cap) return items;
    offset = next;
  }
}

const trackRef = (index: number): Json => ({ kind: "track", index });

/** The cue point closest to `time` within the window the script treats as the same place (1e-3 beat); the first one on a tie. */
function nearestCue(cues: Json[], time: number): Json | undefined {
  let best: Json | undefined;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const cue of cues) {
    const gap = Math.abs((asNumber(cue["time"]) ?? Number.NaN) - time);
    if (gap <= 1e-3 && gap < bestGap) { best = cue; bestGap = gap; }
  }
  return best;
}
const CATEGORIES = ["instruments", "sounds", "drums", "audio_effects", "midi_effects", "packs", "user_library", "samples", "current_project"] as const;
const TREE_DEFAULT = ["instruments", "sounds", "drums", "audio_effects", "midi_effects"];

/** "category/folder/sub" or "Audio Effects/..." into a browser_list category and folder path. */
export function parseBrowserPath(text: string): { category: string; folders: string[] } {
  const parts = text.split("/").map((part) => part.trim()).filter((part) => part.length > 0);
  const category = (parts[0] ?? "").toLowerCase().replace(/[ -]+/g, "_");
  if (!(CATEGORIES as readonly string[]).includes(category)) throw invalidArgs(`The path must start with a browser category: ${CATEGORIES.join(", ")}.`, { reason: "category", categories: [...CATEGORIES] });
  return { category, folders: parts.slice(1) };
}

const DEFAULT_RACK = "instruments/Drum Rack";
/**
 * How load_drum_kit waits for the script's sweep of its own rack load (the sweep lasts about 2 s). Each kit attempt
 * already makes four tries inside the Live client (about 0.6 s), so a few more attempts cover the sweep. Mutable for tests only.
 */
export const KIT_WAIT = { intervalMs: 250, maxRetries: 4 };
const SNAPSHOT_MAX_STEPS = 600;
const SNAPSHOT_MAX_BYTES = 400_000;
const MAX_MACROS = 16;
const MACRO_NAME = /^Macro (\d{1,2})$/;
/** The rack to load is Live's Drum Rack: its name, or the last segment of its (percent-encoded) uri, is "Drum Rack". */
function isDrumRackItem(rack: Json): boolean {
  if (sameName(rack["name"], "Drum Rack")) return true;
  let uri = String(rack["uri"] ?? "");
  try { uri = decodeURIComponent(uri); } catch { /* keep the raw text */ }
  return /(^|[#:/])drum rack$/i.test(uri);
}
const sameName = (a: unknown, b: string): boolean => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
const usable = (item: Json): boolean => item["is_loadable"] === true && (item["blocked"] === null || item["blocked"] === undefined);

/** What the composite and report tools are built on (docs/03-tool-names.md is generated from this). */
export const COMPOSITE_INFO: ReadonlyArray<{ name: string; source: string; uses: string[] }> = [
  { name: "get_session_snapshot", source: "compat", uses: ["get_session_info", "list_tracks", "get_track_info", "get_device_parameters", "get_clip_notes", "get_arrangement_clips"] },
  { name: "load_drum_kit", source: "compat", uses: ["get_track_info", "list_browser_items", "search_browser", "load_instrument_or_effect"] },
  { name: "get_macros", source: "normalized", uses: ["get_rack", "get_device_parameters"] },
  { name: "set_macro", source: "normalized", uses: ["get_rack", "get_device_parameters", "set_device_parameter"] },
  { name: "create_locator", source: "compat", uses: ["list_cue_points", "set_cue_point", "create_cue_point", "get_session_info"] },
  { name: "get_browser_tree", source: "compat", uses: ["list_browser_items"] },
  { name: "get_remote_script_info", source: "compat", uses: ["cached connection state"] },
  { name: "get_transport", source: "compat", uses: ["get_session_info"] },
  { name: "health", source: "compat", uses: ["batuta_status"] },
];

export interface CompositeDeps {
  registry: ToolRegistry;
  executor: Executor;
}

export function registerComposites({ registry, executor }: CompositeDeps): void {
  const reg = (name: string, title: string, description: string, properties: Record<string, Schema>, required: string[], annotations: ToolAnnotations, handler: (args: Json, context: ToolContext) => Promise<ToolResult>): void => {
    registry.register({ name, title, description, inputSchema: obj(properties, required) as never, annotations, handler });
  };

  // ---- get_transport (compatibility name)
  reg("get_transport", "Read the transport", "Report transport and record state from the song: is_playing, current_song_time (beats), tempo, signature, loop, metronome, record_mode (Arrangement Record), session_record, arrangement_overdub and clip_trigger_quantization ({index,label}). Read-only.", {}, [], READ_ONLY, async (_args, context) => {
    const song = await step(executor, "song_info", {}, context);
    const keys = ["is_playing", "current_song_time", "tempo", "signature", "loop", "metronome", "record_mode", "session_record", "arrangement_overdub", "clip_trigger_quantization"];
    return plain("Transport: ok.", Object.fromEntries(keys.map((key) => [key, field(song, key) ?? null])));
  });

  // ---- create_locator (compatibility name): upsert on top of cue_list / cue_set / cue_create
  reg("create_locator", "Create or rename a locator", "Create a locator (cue point) named name at time (beats). If a locator already exists at that time (within 0.001 beat) it is renamed instead; that also works while playing. Creating a new one needs the transport stopped (Live moves the playhead to do it): while playing the call fails with transport_running, so call stop_playback first. A cue too close to another one is refused by the script. Creating or deleting locators cannot run inside batch (not_supported, reason needs_ticks).", { name: str(128, 1, "Locator label."), time: num(0, undefined, "Beat position.") }, ["name", "time"], WRITES, async (args, context) => {
    const time = args["time"] as number;
    const name = String(args["name"]);
    const cues = await allItems(executor, "cue_list", {}, context);
    const existing = nearestCue(cues, time);
    if (existing !== undefined) {
      const done = await step(executor, "cue_set", { index: existing["index"], name }, context);
      return plain(`Locator renamed at beat ${String(existing["time"])}.`, { action: "renamed", cue: { index: existing["index"], name, time: existing["time"] }, result: done });
    }
    const song = await step(executor, "song_info", {}, context);
    if (song["is_playing"] === true) {
      throw invalidArgs(`The transport is running and no locator exists at beat ${time}. Live can only create a locator while stopped (creating one moves the playhead): call stop_playback, then create_locator again. An existing locator at that beat could be renamed while playing.`, { reason: "transport_running", time });
    }
    const created = await step(executor, "cue_create", { time, name }, context);
    return plain(`Locator created at beat ${time}.`, { action: "created", cue: created["cue"] ?? { name, time }, result: created });
  });

  // ---- load_drum_kit (compatibility name): resolve everything first, then load the rack and the kit
  reg("load_drum_kit", "Load a drum rack and a kit", "Load a drum rack on a track, then the first loadable kit found at kit_path, in one call. rack_uri is optional and defaults to 'instruments/Drum Rack' (Live's own Drum Rack is listed under instruments): a uri from the browser (list_browser_items / get_browser_items_at_path), a path like 'instruments/Drum Rack' (if it is not found there the same name is tried in drums, and the other way round), or a bare rack name (searched in instruments first, then in drums). kit_path is a browser path like 'drums/Acoustic' (a folder: its first loadable item is used, or the kit itself). If the track already has a Drum Rack instrument, the rack load is skipped (rack_load: {skipped:true, reason:'drum_rack_present'}) and only the kit is loaded. Everything is looked up before anything is loaded; every browser rule applies (blocked items, Max for Live, plugins, user presets).", { track_index: int(0, undefined, "Track index (0-based)."), rack_uri: str(1024, 1, "Rack uri, browser path or name; default 'instruments/Drum Rack'."), kit_path: str(512, 1, "Browser path of the kit or its folder.") }, ["track_index", "kit_path"], WRITES, async (args, context) => {
    const track = trackRef(args["track_index"] as number);
    const hasDrumRack = async (ref: Json, ctx: ToolContext): Promise<boolean> =>
      asArray((await step(executor, "track_get", { track: ref }, ctx))["devices"]).map(asObject).some((d) => d["class_name"] === "DrumGroupDevice" && d["type"] === "instrument");
    const kitPath = parseBrowserPath(String(args["kit_path"]));
    const listAt = async (category: string, folders: string[]): Promise<Json[]> => asArray((await step(executor, "browser_list", { category, ...(folders.length > 0 ? { path: folders } : {}), limit: 200 }, context))["items"]).map(asObject);
    /** The usable item called `wanted` in a folder, or undefined when the folder or the item does not exist. */
    const findIn = async (category: string, folders: string[], wanted: string): Promise<Json | undefined> => {
      try {
        return (await listAt(category, folders)).find((item) => usable(item) && sameName(item["name"], wanted));
      } catch (error) {
        if (error instanceof ToolError && error.code === "not_found") return undefined;
        throw error;
      }
    };

    // kit: list the path and takes the first loadable item; a path naming the item itself works too.
    let kit: Json | undefined;
    try {
      kit = (await listAt(kitPath.category, kitPath.folders)).find(usable);
    } catch (error) {
      if (!(error instanceof ToolError) || error.code !== "not_found" || kitPath.folders.length === 0) throw error;
    }
    if (kit === undefined && kitPath.folders.length > 0) {
      kit = await findIn(kitPath.category, kitPath.folders.slice(0, -1), kitPath.folders.at(-1) ?? "");
    }
    if (kit === undefined) throw notFound(`No loadable drum kit found at '${String(args["kit_path"]).slice(0, 80)}'. Nothing was loaded.`, { what: "drum kit", kit_path: String(args["kit_path"]).slice(0, 120) });

    // rack: a uri is used as it is (the script only loads uris it listed this session); a path or name is looked up in instruments first.
    const rackText = args["rack_uri"] === undefined ? DEFAULT_RACK : String(args["rack_uri"]);
    let rack: Json | undefined;
    if (rackText.includes(":")) {
      rack = { name: null, uri: rackText };
    } else if (rackText.includes("/")) {
      const where = parseBrowserPath(rackText);
      const wanted = where.folders.at(-1);
      if (wanted === undefined) throw invalidArgs("rack_uri must name the rack, e.g. 'instruments/Drum Rack'.", { reason: "rack" });
      const parent = where.folders.slice(0, -1);
      rack = await findIn(where.category, parent, wanted);
      const other = where.category === "instruments" ? "drums" : where.category === "drums" ? "instruments" : undefined;
      if (rack === undefined && other !== undefined) rack = await findIn(other, parent, wanted);
    } else {
      for (const category of ["instruments", "drums"]) {
        const hits = asArray((await step(executor, "browser_search", { query: rackText.slice(0, 64), category, limit: 50 }, context))["items"]).map(asObject);
        rack = hits.find((item) => usable(item) && sameName(item["name"], rackText));
        if (rack !== undefined) break;
      }
    }
    if (rack === undefined) throw notFound(`No loadable rack named '${rackText.slice(0, 64)}' found in instruments or drums. Nothing was loaded.`, { what: "drum rack" });

    // A top-level Drum Rack instrument already on the track: loading another rack changes nothing visible, the
    // script's sweep then waits for a device change that never comes (timeout) and refuses the kit load as busy.
    // "Any top-level Drum Rack" (not only the first device): a MIDI effect may sit in front of the instrument.
    // Only a Drum Rack request is skipped; asking for another rack still loads it.
    let rackLoad: Json;
    if (isDrumRackItem(rack) && (await hasDrumRack(track, context))) {
      rackLoad = { skipped: true, reason: "drum_rack_present" };
    } else {
      rackLoad = await step(executor, "browser_load", { track, uri: rack["uri"] }, context);
    }
    const rackPending = rackLoad["sweep_pending"] === true;
    let kitLoad: Json;
    let retries = 0;
    for (;;) {
      try {
        kitLoad = await step(executor, "browser_load", { track, uri: kit["uri"] }, context);
        break;
      } catch (error) {
        if (!(error instanceof ToolError)) throw error;
        const sweeping = error.code === "busy" && asObject(error.details)["reason"] === "sweep_pending";
        if (rackPending && sweeping && retries < KIT_WAIT.maxRetries) {
          retries += 1;
          await new Promise((resolve) => setTimeout(resolve, KIT_WAIT.intervalMs));
          continue;
        }
        if (rackLoad["skipped"] === true) throw error;
        const hint = rackPending && sweeping ? "The drum rack is loaded on this track but Live had not finished checking it in time; call load_drum_kit again (the rack is then skipped and only the kit is loaded)." : "The drum rack was already loaded on this track (undo in Live to remove it).";
        throw new ToolError(error.code, `${error.message} ${hint}`, { ...(error.details ?? {}), partial: true, rack_loaded: true });
      }
    }
    const rackName = asString(rack["name"]) ?? asString(asObject(rackLoad["loaded"])["name"]) ?? null;
    return plain(`Loaded ${rackName ?? "the rack"} and kit ${String(kit["name"])} on track ${String(args["track_index"])}.`, {
      track_index: args["track_index"], rack: { name: rackName, uri: rack["uri"] }, kit: { name: kit["name"], uri: kit["uri"] }, rack_load: rackLoad, kit_load: kitLoad,
    });
  });

  // ---- get_browser_tree (compatibility name): top level of one or every category
  reg("get_browser_tree", "Read the browser's top level", "List the top level of Live's browser: category_type 'all' (default: instruments, sounds, drums, audio_effects, midi_effects) or one category. Items carry uris you can load; go deeper with get_browser_items_at_path.", { category_type: enumOf("all", ...CATEGORIES) }, [], READ_ONLY, async (args, context) => {
    const wanted = args["category_type"] === undefined || args["category_type"] === "all" ? TREE_DEFAULT : [String(args["category_type"])];
    const categories: Json = {};
    for (const category of wanted) {
      const page = await step(executor, "browser_list", { category, limit: 100 }, context);
      Object.assign(categories, { [category]: { items: page["items"] ?? [], total: page["total"] ?? null, next_offset: page["next_offset"] ?? null } });
    }
    return plain(`Browser: ${wanted.length} categor${wanted.length === 1 ? "y" : "ies"}.`, { categories });
  });

  // ---- get_session_snapshot (compatibility name): read-only aggregate with caps; no telemetry
  reg("get_session_snapshot", "Snapshot the session", "Read-only snapshot of the set: song state, every regular track with its devices, session clips (and arrangement clips), optionally MIDI notes and device parameters, plus returns and master. Capped: max_tracks, max_notes_per_clip, max_params_per_device, at most 600 inner calls and 400 KB of output; truncated:true says something was cut (notes_total / params_total / tracks_total show the full size) and every track carries params_truncated, notes_truncated and arrangement_truncated for what is missing or incomplete on it. Nothing is recorded or sent anywhere.", {
    include_notes: bool("Include MIDI notes of MIDI clips (default true)."), include_params: bool("Include device parameters (default true)."), include_arrangement: bool("Include arrangement clips (default true)."),
    max_tracks: int(1, 128, "Regular tracks to include, default 64."), max_notes_per_clip: int(1, 2000, "Default 200."), max_params_per_device: int(1, 128, "Default 64."),
  }, [], READ_ONLY, async (args, context) => {
    const includeNotes = args["include_notes"] !== false;
    const includeParams = args["include_params"] !== false;
    const includeArrangement = args["include_arrangement"] !== false;
    const maxTracks = (args["max_tracks"] as number | undefined) ?? 64;
    const maxNotes = (args["max_notes_per_clip"] as number | undefined) ?? 200;
    const maxParams = (args["max_params_per_device"] as number | undefined) ?? 64;
    const song = await step(executor, "song_info", {}, context);
    const listed = await allItems(executor, "track_list", { include_returns: true, include_master: true }, context);
    const regular = listed.filter((t) => t["kind"] === "track");
    const brief = (t: Json): Json => ({ index: t["index"], name: t["name"], color: t["color"], mute: t["mute"], solo: t["solo"], arm: t["arm"], device_count: t["device_count"] });
    const songKeys = ["tempo", "signature", "is_playing", "current_song_time", "loop", "metronome", "record_mode", "clip_trigger_quantization", "root_note", "scale_name", "track_count", "return_count", "scene_count", "cue_count", "live_version"];
    const limits = { max_tracks: maxTracks, max_notes_per_clip: maxNotes, max_params_per_device: maxParams };
    const snapshot: Json = {
      song: Object.fromEntries(songKeys.map((key) => [key, field(song, key) ?? null])),
      tracks: [], tracks_total: regular.length,
      returns: listed.filter((t) => t["kind"] === "return").map(brief),
      master: listed.filter((t) => t["kind"] === "master").map(brief)[0] ?? null,
      truncated: regular.length > maxTracks,
      limits,
    };
    const tracks = snapshot["tracks"] as Json[];
    // Budget: the call count and the size of the output are checked BEFORE each inner call; a result that
    // does not fit is dropped (and flagged), and once one did not fit nothing more is asked for.
    let steps = 0;
    let used = JSON.stringify(snapshot).length;
    let full = false;
    const canCall = (): boolean => !full && steps < SNAPSHOT_MAX_STEPS;
    const fits = (piece: unknown): boolean => {
      const size = JSON.stringify(piece).length + 1;
      if (full || used + size > SNAPSHOT_MAX_BYTES) { full = true; return false; }
      used += size;
      return true;
    };
    /** Something of the track (and of one of its entries) is missing or incomplete: say so on both. */
    const cut = (track: Json, flag: "params_truncated" | "notes_truncated" | "arrangement_truncated", entry?: Json): void => {
      snapshot["truncated"] = true;
      if (flag === "params_truncated") track["params_truncated"] = true;
      else if (flag === "notes_truncated") track["notes_truncated"] = true;
      else track["arrangement_truncated"] = true;
      if (entry !== undefined && flag === "params_truncated") entry["params_truncated"] = true;
      if (entry !== undefined && flag === "notes_truncated") entry["notes_truncated"] = true;
    };
    for (const listing of regular.slice(0, maxTracks)) {
      if (!canCall()) { snapshot["truncated"] = true; break; }
      const ref = trackRef(listing["index"] as number);
      const detail = await step(executor, "track_get", { track: ref, include_clips: true }, context);
      steps += 1;
      const devices: Json[] = asArray(detail["devices"]).map(asObject).map((device) => ({ path: device["path"], name: device["name"], class_name: device["class_name"], type: device["type"], is_active: device["is_active"], parameter_count: device["parameter_count"] }));
      const slots = asArray(detail["slots"]).map(asObject).filter((slot) => slot["has_clip"] === true);
      const clips: Json[] = slots.map((slot) => ({ is_playing: slot["is_playing"], ...asObject(slot["clip"]), slot: slot["slot"] }));
      const track: Json = { ...brief(listing), devices, clips, params_truncated: false, notes_truncated: false, arrangement_truncated: false };
      if (!fits(track)) { snapshot["truncated"] = true; break; }
      tracks.push(track);
      if (includeParams) {
        for (const entry of devices) {
          if (!canCall()) { cut(track, "params_truncated", entry); continue; }
          const page = await step(executor, "device_get", { device: { track: ref, path: entry["path"] }, limit: maxParams }, context);
          steps += 1;
          const params = asArray(page["parameters"]).map(asObject).map((p) => ({ index: p["index"], name: p["name"], value: p["value"], min: p["min"], max: p["max"], display: p["display"] }));
          const total = asNumber(page["total"]) ?? params.length;
          if (!fits(params)) { cut(track, "params_truncated", entry); continue; }
          Object.assign(entry, { parameters: params, params_total: total, params_truncated: total > params.length });
          if (total > params.length) cut(track, "params_truncated");
        }
      }
      if (includeNotes) {
        for (const entry of clips) {
          if (entry["is_midi"] !== true) continue;
          if (!canCall()) { cut(track, "notes_truncated", entry); continue; }
          const page = await step(executor, "notes_get", { clip: { kind: "session", track: ref, slot: entry["slot"] }, limit: maxNotes }, context);
          steps += 1;
          const notes = asArray(page["items"]).map(asObject).map((n) => ({ pitch: n["pitch"], start_time: n["start_time"], duration: n["duration"], velocity: n["velocity"], mute: n["mute"] }));
          const total = asNumber(page["total"]) ?? notes.length;
          if (!fits(notes)) { cut(track, "notes_truncated", entry); continue; }
          Object.assign(entry, { notes, notes_total: total, notes_truncated: total > notes.length });
          if (total > notes.length) cut(track, "notes_truncated");
        }
      }
      if (includeArrangement) {
        if (!canCall()) {
          cut(track, "arrangement_truncated");
        } else {
          const page = await step(executor, "arrangement_clips", { track: ref, limit: 100 }, context);
          steps += 1;
          const items = asArray(page["items"]).map(asObject).map((c) => ({ index: c["index"], name: c["name"], start_time: c["start_time"], end_time: c["end_time"], length: c["length"] }));
          if (!fits(items)) cut(track, "arrangement_truncated");
          else {
            track["arrangement_clips"] = items;
            if (asNumber(page["next_offset"]) !== undefined) cut(track, "arrangement_truncated");
          }
        }
      }
    }
    const truncated = snapshot["truncated"] === true;
    return plain(`Session snapshot: ${tracks.length} of ${regular.length} track(s)${truncated ? " (truncated)" : ""}.`, snapshot);
  });

  // ---- get_macros / set_macro: the macros of a rack as device parameters
  const MACRO_TRACK = { track_index: int(0, undefined, "Regular track index (0-based)."), track: TRACK_REF, device_index: int(0, undefined, "Index of the rack on that track (0-based).") };
  const macroDevice = (given: Json): Json => ({ track: deviceTrack(given), path: [given["device_index"]] });

  /** Rack, macro count and the parameter list of one rack; fails clearly when it is not a rack or the layout is not the expected one. */
  const readMacros = async (given: Json, context: ToolContext): Promise<{ device: Json; count: number; params: Json[] }> => {
    const device = macroDevice(given);
    let rack: Json;
    try {
      rack = await step(executor, "rack_get", { device }, context);
    } catch (error) {
      if (error instanceof ToolError && asObject(error.details)["reason"] === "not_a_rack") {
        throw new ToolError("invalid_args", `The device at index ${String(given["device_index"])} of that track is not a rack, so it has no macros. Use get_device_parameters for its parameters.`, { ...(error.details ?? {}), reason: "not_a_rack" });
      }
      throw error;
    }
    const params = asArray((await step(executor, "device_get", { device, limit: 128 }, context))["parameters"]).map(asObject);
    const named = (param: Json | undefined): number | undefined => {
      const found = param === undefined ? null : MACRO_NAME.exec(String(param["name"] ?? ""));
      return found?.[1] === undefined ? undefined : Number(found[1]);
    };
    // Macro k is the parameter at index k (index 0 is Device On) [A]. A default-named macro anywhere else means the layout is not what this tool assumes.
    for (const param of params) {
      const label = named(param);
      if (label !== undefined && label !== asNumber(param["index"])) {
        throw new ToolError("not_supported", `The macro parameters of this rack are not laid out as expected (parameter ${String(param["index"])} is named "Macro ${label}"), so no macro was read or changed.`, { reason: "macro_layout" });
      }
    }
    let reported = asNumber(rack["macro_count"]);
    if (reported === undefined) {
      reported = 0;
      while (named(params.find((param) => param["index"] === reported! + 1)) === reported + 1) reported += 1;
    }
    const count = Math.min(reported, MAX_MACROS);
    if (count < 1 || params.filter((param) => (asNumber(param["index"]) ?? 0) >= 1 && (asNumber(param["index"]) ?? 0) <= count).length < count) {
      throw new ToolError("not_supported", "This rack reports no macros that can be read.", { reason: "macro_layout" });
    }
    return { device, count, params };
  };
  const macroAt = (params: Json[], macro: number): Json => asObject(params.find((param) => param["index"] === macro));

  reg("get_macros", "Read a rack's macros", "Read the macros of an Instrument, Audio or Drum Rack: macro_index (1-based, as in Live's Macro 1..16), parameter_index, name (custom names are kept), value, min, max and display. Give track_index (regular track) or track ({kind:\"return\",index} / {kind:\"master\"}) and device_index (the rack on that track). Fails with not_a_rack for any other device. Read-only. A macro is device parameter macro_index of the rack (parameter 0 is Device On) [A].", MACRO_TRACK, ["device_index"], READ_ONLY, async (args, context) => {
    const { count, params } = await readMacros(args, context);
    const macros = Array.from({ length: count }, (_, position) => {
      const param = macroAt(params, position + 1);
      return { macro_index: position + 1, parameter_index: param["index"], name: param["name"], value: param["value"], min: param["min"], max: param["max"], display: param["display"] };
    });
    return plain(`Rack has ${count} macro(s).`, { track: macroDevice(args)["track"], device_index: args["device_index"], macro_count: count, macros });
  });

  reg("set_macro", "Set a rack macro", "Set one macro of a rack to a raw value within its min..max (see get_macros). macro_index is 1-based (Live's Macro 1..16). Give track_index or track, and device_index. It runs set_device_parameter on the macro's parameter, so every guard applies: a macro whose display is in dB asks for confirmation when it jumps up or pushes the master above its ceiling (gain guard; default-named macros are always checked), quantized macros take integers.", { ...MACRO_TRACK, macro_index: int(1, MAX_MACROS, "Macro number, 1-based (Macro 1 is 1)."), value: num(undefined, undefined, "Raw value within the macro's min..max.") }, ["device_index", "macro_index", "value"], { ...annotationsFor(specFor("param_set") as CommandSpec) }, async (args, context) => {
    const macro = args["macro_index"] as number;
    const value = args["value"] as number;
    const { device, count, params } = await readMacros(args, context);
    if (macro > count) throw invalidArgs(`The rack has ${count} macro(s); macro_index ${macro} does not exist.`, { reason: "macro_index", macro_count: count });
    const param = macroAt(params, macro);
    const min = asNumber(param["min"]);
    const max = asNumber(param["max"]);
    if ((min !== undefined && value < min) || (max !== undefined && value > max)) {
      throw new ToolError("out_of_range", `value ${value} is outside the macro's range ${String(min)}..${String(max)}.`, { field: "value", min: min ?? null, max: max ?? null, value });
    }
    const spec = specFor("param_set");
    if (spec === undefined) throw new ToolError("internal_error", "unknown command param_set");
    // The last step is the change itself, so a confirmation it needs (gain guard) goes back to the caller as it is.
    const done = await executor.run(spec, { param: { device, index: macro }, value }, context);
    const out = asObject(done.structuredContent);
    if (out["confirmation_required"] === true || out["cancelled"] === true) return done;
    return { ...done, structuredContent: { ...out, macro_index: macro, name: param["name"] ?? null, value } };
  });
}
