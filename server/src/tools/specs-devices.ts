import { CONTAINER_SEL, DEVICE_SEL, PAGING, PARAM_SEL, TRACK_SEL, arr, bool, enumOf, int, num, obj, oneOf, str } from "./schemas.js";
import type { CommandSpec } from "./types.js";

/** Devices, parameters, racks, drum pads and the browser (docs/01-protocol.md sections 7.8 to 7.10). */

const GAIN_NOTE = "Raising a gain/volume/level/output parameter (display in dB) by more than the configured jump limit trips the gain guard and asks the user to confirm.";
const CHAIN_VOLUME_NOTE = "volume_db is -70..6 dB; a raw chain volume cannot be checked against the gain limit and always trips the guard (asks the user to confirm). A large increase (more than the configured jump limit) trips the gain guard and asks the user to confirm.";
const CATEGORIES = enumOf("instruments", "drums", "sounds", "audio_effects", "midi_effects", "packs", "user_library", "samples", "current_project", "plugins", "max_for_live");
const PARAM_ITEM = oneOf(
  obj({ index: int(0), value: num() }, ["index", "value"]),
  obj({ name: str(128, 1), value: num() }, ["name", "value"]),
);

export const DEVICE_SPECS: CommandSpec[] = [
  {
    command: "device_list", summary: "List devices", mutating: false, destructive: "never", conditions: [],
    description: `List the devices in a device chain (container): path [] is the track's own chain; a rack chain can be named as the last hop. Each device has its path (reusable as a device selector), name, class_name, type, is_active and parameter_count. Paged.`,
    properties: { container: CONTAINER_SEL, ...PAGING }, required: ["container"], refs: { container: "container" },
  },
  {
    command: "device_get", summary: "Read a device", mutating: false, destructive: "never", conditions: [],
    description: `Read a device with its parameters (up to 128 per page): index, name, value (raw), min, max, default, display text, is_quantized, value_items, is_enabled and automation_state.`,
    properties: { device: DEVICE_SEL, limit: int(1, 128), offset: int(0) }, required: ["device"], refs: { device: "device" },
  },
  {
    command: "param_get", summary: "Read a parameter", mutating: false, destructive: "never", conditions: [],
    description: `Read one parameter (raw value, min, max, default and display text). With at_value the result adds display_at_value: how Live would display that raw value, without changing anything.`,
    properties: { param: PARAM_SEL, at_value: num() }, required: ["param"], refs: { param: "param" },
  },
  {
    command: "param_set", summary: "Set parameters", mutating: true, destructive: "conditional", conditions: ["value", "items"], idempotent: true,
    description: `Set parameters to raw values within [min, max] (see device_get/param_get): either {param, value} or {device, items:[{index|name, value}]} (1..64 items). Quantized parameters take integer values; disabled parameters are refused. ${GAIN_NOTE} The same applies to the master volume ({mixer:"volume", track:{kind:"master"}}).`,
    properties: { device: DEVICE_SEL, items: arr(PARAM_ITEM, 1, 64), param: PARAM_SEL, value: num() },
    refs: { device: "device", param: "param", items: "paramItems" },
  },
  {
    command: "device_enable", summary: "Switch a device on or off", mutating: true, destructive: "never", conditions: [], idempotent: true,
    description: `Switch a device on or off (its Device On parameter).`,
    properties: { device: DEVICE_SEL, enabled: bool() }, required: ["device", "enabled"], refs: { device: "device" },
  },
  {
    command: "device_delete", summary: "Delete device", mutating: true, destructive: "always", conditions: [],
    description: `Delete a device. expect_name guards against the wrong device. Destructive but undoable (one undo step: Cmd-Z in Live, or the undo tool).`,
    properties: { device: DEVICE_SEL, expect_name: str(128, undefined, "Guard: the device must have this name.") }, required: ["device"], refs: { device: "device" },
  },
  {
    command: "device_insert", summary: "Insert a device", mutating: true, destructive: "never", conditions: [],
    description: `Insert a built-in Live device by name (for example "Compressor" or "EQ Eight") into a device chain at index (-1 appends). Max for Live and External devices are inserted only while browser.allow_max_for_live and browser.allow_external_devices are on (both default on); plugins are refused. For presets and samples use browser_list and browser_load.`,
    properties: {
      container: CONTAINER_SEL,
      name: { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9 '&+()./-]{1,64}$", description: "Device name, letters, digits and basic punctuation." },
      index: int(-1),
    },
    required: ["container", "name"], refs: { container: "container" },
  },

  // ---- racks and drum pads
  {
    command: "rack_get", summary: "Read a rack", mutating: false, destructive: "never", conditions: [],
    description: `Read an Instrument/Audio/Drum Rack: chains and return chains (name, color, mute, solo, device_count, volume with volume_db, pan), macro_count, variation_count, selected_variation and can_have_drum_pads.`,
    properties: { device: DEVICE_SEL }, required: ["device"], refs: { device: "device" },
  },
  {
    command: "chain_set", summary: "Change a rack chain", mutating: true, destructive: "conditional", conditions: ["volume", "volume_db"], idempotent: true,
    description: `Change a rack chain's name, color, mute, solo, volume/volume_db or pan (-1..1). chain is {kind:"chain"|"return_chain", index}. Give only one of volume and volume_db. ${CHAIN_VOLUME_NOTE}`,
    properties: {
      device: DEVICE_SEL, chain: obj({ kind: enumOf("chain", "return_chain"), index: int(0) }, ["kind", "index"]),
      name: str(128), color: int(0, 0xffffff), mute: bool(), solo: bool(), volume: num(), volume_db: num(-70, 6, "dB"), pan: num(-1, 1),
    },
    required: ["device", "chain"], exclusive: [["volume", "volume_db"]], refs: { device: "device" },
  },
  {
    command: "rack_insert_chain", summary: "Add a rack chain", mutating: true, destructive: "never", conditions: [],
    description: `Add an empty chain to a rack at index (-1 appends).`,
    properties: { device: DEVICE_SEL, index: int(-1) }, required: ["device"], refs: { device: "device" },
  },
  {
    command: "rack_variation", summary: "Change rack variations", mutating: true, destructive: "conditional", conditions: ["action"],
    description: `Macro variations of a rack: action store, recall, delete or randomize; recall and delete need index (0..variation_count-1). Deleting a variation is destructive but undoable (one undo step).`,
    properties: { device: DEVICE_SEL, action: enumOf("store", "recall", "delete", "randomize"), index: int(0) }, required: ["device", "action"], refs: { device: "device" },
    condition: (args) => (args["action"] === "delete" ? "deletes a rack variation" : null),
  },
  {
    command: "drum_pads_list", summary: "List drum pads", mutating: false, destructive: "never", conditions: [],
    description: `List the pads of a Drum Rack (note, name, mute, solo, chain_count). By default only pads that hold chains; all:true lists all 128. Paged.`,
    properties: { device: DEVICE_SEL, all: bool(), ...PAGING }, required: ["device"], refs: { device: "device" },
  },
  {
    command: "drum_pad_set", summary: "Change a drum pad", mutating: true, destructive: "never", conditions: [], idempotent: true,
    description: `Mute or solo one drum pad of a Drum Rack (note 0..127).`,
    properties: { device: DEVICE_SEL, note: int(0, 127), mute: bool(), solo: bool() }, required: ["device", "note"], refs: { device: "device" },
  },
  {
    command: "drum_pad_copy", summary: "Copy drum pad", mutating: true, destructive: "always", conditions: [],
    description: `Copy one drum pad onto another (from_note to to_note, 0..127); the target pad's content is overwritten. Destructive but undoable (one undo step: Cmd-Z in Live, or the undo tool).`,
    properties: { device: DEVICE_SEL, from_note: int(0, 127), to_note: int(0, 127) }, required: ["device", "from_note", "to_note"], refs: { device: "device" },
  },
  {
    command: "drum_pad_clear", summary: "Clear drum pad", mutating: true, destructive: "always", conditions: [],
    description: `Remove all chains from one drum pad (note 0..127). Destructive but undoable (one undo step: Cmd-Z in Live, or the undo tool).`,
    properties: { device: DEVICE_SEL, note: int(0, 127) }, required: ["device", "note"], refs: { device: "device" },
  },

  // ---- browser
  {
    command: "browser_list", summary: "List browser items", mutating: false, destructive: "never", conditions: [],
    description: `List Live's browser: a category (${"instruments, drums, sounds, audio_effects, midi_effects, packs, user_library, samples, current_project, plugins, max_for_live"}) and an optional path of folder names (up to 8). Items have name, uri, is_folder, is_loadable, is_device and blocked (max_for_live, live_set, plugin, external_device, user_content or null). Blocked items cannot be loaded. Paged (limit up to 200). Plugins are listed only when browser.allow_plugins is on; the max_for_live category is served while browser.allow_max_for_live is on (the default).`,
    properties: { category: CATEGORIES, path: arr(str(128), undefined, 8), limit: int(1, 200), offset: int(0) }, required: ["category"],
  },
  {
    command: "browser_search", summary: "Search the browser", mutating: false, destructive: "never", conditions: [],
    description: `Search browser item names (case-insensitive substring, 1..64 characters) in one category or all, visiting at most 3000 nodes; loadable_only (default true) hides folders. Returns up to 50 items {name, uri, path, is_loadable, blocked}, truncated:true when the search stopped early. Slow (up to 15 s).`,
    properties: { query: str(64, 1), category: CATEGORIES, loadable_only: bool(), limit: int(1, 50) }, required: ["query"],
  },
  {
    command: "browser_load", summary: "Load a browser item", mutating: true, destructive: "never", conditions: [],
    description: `Load a browser item onto a regular track, a return track or the master (track: {kind:"track"|"return",index} or {kind:"master"} or {name}; Live loads onto the selected track, so the Remote Script selects the target for the call and puts the previous selection back). An instrument is not expected to load onto the master or a return; if nothing lands the result reports verified:false. The uri must come from browser_list or browser_search in this session. Live sets (.als) are never loaded; Max for Live (.amxd) items and External devices load while browser.allow_max_for_live and browser.allow_external_devices are on (both default on, set false to block them); presets from the user library or packs need browser.allow_user_presets, plugins need browser.allow_plugins. After loading, the Remote Script checks the track for devices the configuration does not allow and removes them. The result has verified (false means Live loaded asynchronously and a safety sweep is still pending: wait a few seconds and check song_info pending_sweeps and track_get), sweep_pending and previous_sweep (the outcome of an earlier sweep). Live may create a new MIDI track when an instrument is loaded onto an audio track (and arm it): the result then lists it in new_tracks (kind, index, name, arm) with landed_on, and it is left in place.`,
    properties: { track: TRACK_SEL, uri: str(1024, 1, "uri from browser_list or browser_search.") }, required: ["track", "uri"], refs: { track: "track" },
  },
];
