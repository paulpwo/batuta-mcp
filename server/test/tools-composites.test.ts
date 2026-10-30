import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeWorld } from "./helpers/fake-world.js";
import { startRig } from "./helpers/tools-harness.js";
import type { Rig, RigOptions } from "./helpers/tools-harness.js";
import type { Json } from "./helpers/mcp-client.js";
import { KIT_WAIT } from "../src/tools/composites.js";

KIT_WAIT.intervalMs = 5;
KIT_WAIT.maxRetries = 2;

/** Server-side composites: they only call the broad tools' executor path, so every guard still applies. */

const T = (index: number, name?: string): Json => ({ kind: "track", index, ...(name === undefined ? {} : { expect_name: name }) });
const MUTATING = new Set(["track_create", "track_set", "browser_load", "cue_create", "cue_set", "clip_set", "param_set", "notes_add", "notes_remove", "batch"]);

// ---------------------------------------------------------------- get_transport, health, script info

test("get_transport reads song_info only and projects the transport fields", async () => {
  const w = new FakeWorld();
  w.songInfoExtra = { signature: [6, 8], is_playing: true, current_song_time: 12.5, loop: { on: true, start: 0, length: 16 }, metronome: true, record_mode: false, session_record: false, arrangement_overdub: false, clip_trigger_quantization: { index: 4, label: "1 bar" }, can_undo: true };
  const r = await startRig({ answers: w.answers(), echo: true });
  const out = await r.call("get_transport");
  assert.equal(out.isError, false);
  assert.deepEqual(out.structuredContent, {
    is_playing: true, current_song_time: 12.5, tempo: 120, signature: [6, 8], loop: { on: true, start: 0, length: 16 }, metronome: true,
    record_mode: false, session_record: false, arrangement_overdub: false, clip_trigger_quantization: { index: 4, label: "1 bar" },
  });
  assert.deepEqual(r.seen().map((c) => c.cmd), ["song_info"]);
  await r.close();
});

test("health is batuta_status under its compatibility name, and get_remote_script_info reports the script", async () => {
  const r = await startRig({ answers: new FakeWorld().answers(), echo: true });
  const status = await r.call("batuta_status");
  const health = await r.call("health");
  assert.equal(health.isError, false);
  assert.deepEqual(health.structuredContent, status.structuredContent);
  const info = await r.call("get_remote_script_info");
  assert.equal(info.isError, false);
  assert.equal(info.structuredContent.script_version, status.structuredContent.connection.script_version);
  assert.equal(info.structuredContent.connected, true);
  assert.deepEqual(r.seen(), [], "cached state only, no command is sent");
  await r.close();
});

// ---------------------------------------------------------------- create_locator

function cueRig(cues: Array<{ name: string; time: number }>, playing: boolean, options: RigOptions = {}): Promise<Rig> {
  const w = new FakeWorld();
  w.songInfoExtra = { is_playing: playing };
  return startRig({
    answers: { ...w.answers(), cue_list: () => ({ items: cues.map((c, index) => ({ index, ...c })), total: cues.length, next_offset: null }), ...(options.answers ?? {}) },
    echo: true,
  });
}
const sent = (r: Rig): string[] => r.seen().map((c) => c.cmd);

test("create_locator creates a cue point when none is at that time (transport stopped)", async () => {
  const r = await cueRig([{ name: "Intro", time: 0 }], false);
  const out = await r.call("create_locator", { name: "Chorus", time: 32 });
  assert.equal(out.isError, false, JSON.stringify(out.structuredContent));
  assert.equal(out.structuredContent.action, "created");
  assert.deepEqual(r.seen().filter((c) => c.cmd === "cue_create"), [{ cmd: "cue_create", args: { time: 32, name: "Chorus" } }]);
  assert.equal(sent(r).includes("cue_set"), false);
  await r.close();
});

test("create_locator renames the cue point that already sits at that time (within 1e-3 beats), even while playing", async () => {
  for (const playing of [false, true]) {
    const r = await cueRig([{ name: "Intro", time: 0 }, { name: "Verse", time: 16 }], playing);
    const out = await r.call("create_locator", { name: "Verse 1", time: 16.0004 });
    assert.equal(out.isError, false, JSON.stringify(out.structuredContent));
    assert.equal(out.structuredContent.action, "renamed");
    assert.deepEqual(r.seen().filter((c) => c.cmd === "cue_set"), [{ cmd: "cue_set", args: { index: 1, name: "Verse 1" } }]);
    assert.equal(sent(r).includes("cue_create"), false);
    await r.close();
  }
});

test("create_locator only renames within 0.001 beat: a cue 0.01 beat away is not the same one", async () => {
  const r = await cueRig([{ name: "Verse", time: 16 }], false);
  const out = await r.call("create_locator", { name: "Pre", time: 16.01 });
  assert.equal(out.structuredContent.action, "created");
  assert.deepEqual(r.seen().filter((c) => c.cmd === "cue_create"), [{ cmd: "cue_create", args: { time: 16.01, name: "Pre" } }]);
  assert.equal(sent(r).includes("cue_set"), false);
  await r.close();
});

test("create_locator while the transport is running and no cue exists there: a clear error, nothing sent", async () => {
  const r = await cueRig([{ name: "Intro", time: 0 }], true);
  const out = await r.call("create_locator", { name: "Drop", time: 64 });
  assert.equal(out.isError, true);
  assert.equal(out.structuredContent.code, "invalid_args");
  assert.equal(out.structuredContent.details.reason, "transport_running");
  assert.match(out.structuredContent.message, /stop_playback/);
  assert.match(out.structuredContent.message, /playhead/);
  assert.equal(sent(r).some((c) => MUTATING.has(c)), false);
  await r.close();
});

test("create_locator passes the script's own nearby-cue refusal through and validates its arguments", async () => {
  const r = await cueRig([], false, { answers: { cue_create: (_a, _q, reply) => { reply.fail("invalid_args", "another cue point is too close to this time", { reason: "cue_nearby" }); return undefined; } } });
  const near = await r.call("create_locator", { name: "X", time: 8 });
  assert.equal(near.isError, true);
  assert.equal(near.structuredContent.details.reason, "cue_nearby");
  for (const args of [{ time: 1 }, { name: "x" }, { name: "x", time: -1 }, { name: "x", time: 1, user_prompt: "p" }]) {
    assert.equal((await r.call("create_locator", args)).isError, true, JSON.stringify(args));
  }
  await r.close();
});

// ---------------------------------------------------------------- load_drum_kit

function item(name: string, uri: string, extra: Json = {}): Json {
  return { name, uri, is_folder: false, is_loadable: true, is_device: false, blocked: null, ...extra };
}
const BROWSER: Record<string, Json[]> = {
  "drums|": [item("Drum Rack", "u:rack", { is_device: true }), item("Acoustic", "u:acoustic", { is_folder: true, is_loadable: false })],
  "drums|Acoustic": [item("Kit A", "u:kitA"), item("Kit B", "u:kitB")],
};
function browserAnswers(table: Record<string, Json[]>): RigOptions["answers"] {
  return {
    browser_list: (args, _q, reply) => {
      const key = `${String(args["category"])}|${((args["path"] as string[] | undefined) ?? []).join("/")}`;
      const items = Object.entries(table).find(([k]) => k === key)?.[1];
      if (items === undefined) { reply.fail("not_found", "browser item not found", { reason: "path_not_found" }); return undefined; }
      return { items, total: items.length, total_capped: false, next_offset: null };
    },
    browser_load: (args) => ({ loaded: { name: "x", uri: args["uri"] }, verified: true }),
  };
}
async function kitRig(table = BROWSER, config: Json = {}, extra: NonNullable<RigOptions["answers"]> = {}, devices: Json[] = []): Promise<Rig> {
  const track_get = (args: Json): Json => ({ track: { kind: "track", index: (args["track"] as Json)["index"] }, devices, slots: null });
  return startRig({ answers: { ...new FakeWorld().answers(), track_get, ...browserAnswers(table), ...extra }, echo: true, config: config as never });
}
const device = (name: string, class_name: string, type: string, i = 0): Json => ({ path: [i], name, class_name, type, is_active: true });
const DRUM_RACK = device("Drum Rack", "DrumGroupDevice", "instrument");
const loads = (r: Rig): Json[] => r.seen().filter((c) => c.cmd === "browser_load").map((c) => c.args);

test("load_drum_kit resolves the rack and the first loadable kit through the browser, then loads both on the track", async () => {
  const r = await kitRig();
  const out = await r.call("load_drum_kit", { track_index: 0, rack_uri: "drums/Drum Rack", kit_path: "drums/Acoustic" });
  assert.equal(out.isError, false, JSON.stringify(out.structuredContent));
  assert.deepEqual(loads(r), [{ track: T(0, "Drums"), uri: "u:rack" }, { track: T(0, "Drums"), uri: "u:kitA" }]);
  assert.deepEqual(out.structuredContent.rack, { name: "Drum Rack", uri: "u:rack" });
  assert.deepEqual(out.structuredContent.kit, { name: "Kit A", uri: "u:kitA" });
  const order = r.seen().map((c) => c.cmd);
  assert.ok(order.lastIndexOf("browser_list") < order.indexOf("browser_load"), "everything is resolved before anything is loaded");
  await r.close();
});

test("load_drum_kit takes a uri as it is for the rack, and a kit path that names the kit itself", async () => {
  const r = await kitRig();
  const out = await r.call("load_drum_kit", { track_index: 1, rack_uri: "u:rack", kit_path: "drums/Acoustic/Kit B" });
  assert.equal(out.isError, false, JSON.stringify(out.structuredContent));
  assert.deepEqual(loads(r), [{ track: T(1, "Bass"), uri: "u:rack" }, { track: T(1, "Bass"), uri: "u:kitB" }]);
  await r.close();
});

test("load_drum_kit changes nothing when the kit cannot be found, is empty or is blocked", async () => {
  const cases: Array<[string, Record<string, Json[]>, string]> = [
    ["drums/Missing", BROWSER, "not_found"],
    ["drums/Acoustic", { ...BROWSER, "drums|Acoustic": [item("Folder", "u:f", { is_folder: true, is_loadable: false })] }, "not_found"],
    ["drums/Acoustic", { ...BROWSER, "drums|Acoustic": [item("Plug", "u:p", { blocked: "plugin" })] }, "not_found"],
  ];
  for (const [kit_path, table, code] of cases) {
    const r = await kitRig(table);
    const out = await r.call("load_drum_kit", { track_index: 0, rack_uri: "drums/Drum Rack", kit_path });
    assert.equal(out.isError, true, kit_path);
    assert.equal(out.structuredContent.code, code);
    assert.deepEqual(loads(r), [], "nothing was loaded");
    await r.close();
  }
});

test("load_drum_kit skips blocked items, honors browser rules and validates the path category", async () => {
  const table = { ...BROWSER, "drums|Acoustic": [item("Locked", "u:l", { blocked: "user_content" }), item("Kit C", "u:kitC")] };
  const r = await kitRig(table);
  const out = await r.call("load_drum_kit", { track_index: 0, rack_uri: "drums/Drum Rack", kit_path: "drums/Acoustic" });
  assert.equal(out.isError, false);
  assert.deepEqual(loads(r).map((a) => a["uri"]), ["u:rack", "u:kitC"]);
  const bad = await r.call("load_drum_kit", { track_index: 0, rack_uri: "drums/Drum Rack", kit_path: "nonsense/x" });
  assert.equal(bad.isError, true);
  assert.equal(bad.structuredContent.code, "invalid_args");
  assert.equal((await r.call("load_drum_kit", { track_index: 0, rack_uri: "drums/Drum Rack", kit_path: "drums/Acoustic", user_prompt: "p" })).isError, true);
  await r.close();
});

test("load_drum_kit skips the rack load when the track already has a top-level Drum Rack instrument and loads only the kit", async () => {
  const r = await kitRig(BROWSER, {}, {}, [device("Auto Filter", "AutoFilter", "audio_effect", 0), { ...DRUM_RACK, path: [1] }]);
  const out = await r.call("load_drum_kit", { track_index: 0, kit_path: "drums/Acoustic" });
  assert.equal(out.isError, false, JSON.stringify(out.structuredContent));
  assert.deepEqual(loads(r).map((a) => a["uri"]), ["u:kitA"]);
  assert.deepEqual(out.structuredContent.rack_load, { skipped: true, reason: "drum_rack_present" });
  assert.equal(out.structuredContent.kit_load.loaded.uri, "u:kitA");
  await r.close();
});

test("load_drum_kit still loads the rack when the track holds another instrument, an effect named Drum Rack, or a different rack is requested", async () => {
  const cases: Array<[Json[], Json]> = [
    [[device("Operator", "Operator", "instrument")], {}],
    [[device("Drum Rack", "AudioEffectGroupDevice", "audio_effect")], {}],
    [[DRUM_RACK], { rack_uri: "u:other" }],
  ];
  for (const [devices, extra] of cases) {
    const r = await kitRig(BROWSER, {}, {}, devices);
    const out = await r.call("load_drum_kit", { track_index: 0, kit_path: "drums/Acoustic", rack_uri: "drums/Drum Rack", ...extra });
    assert.equal(out.isError, false, JSON.stringify(out.structuredContent));
    assert.equal(loads(r).length, 2);
    assert.equal(out.structuredContent.rack_load.skipped, undefined);
    await r.close();
  }
});

test("load_drum_kit waits for the sweep of its own rack load before loading the kit", async () => {
  let kitTries = 0;
  const r = await kitRig(BROWSER, {}, {
    browser_load: (args, _q, reply) => {
      if (args["uri"] === "u:rack") return { loaded: { name: "Drum Rack", uri: "u:rack" }, verified: false, sweep_pending: true };
      kitTries += 1;
      if (kitTries < 6) { reply.fail("busy", "an earlier load on this track or too many loads are still being swept", { reason: "sweep_pending" }); return undefined; }
      return { loaded: { name: "Kit A", uri: args["uri"] }, verified: true };
    },
  });
  const out = await r.call("load_drum_kit", { track_index: 0, kit_path: "drums/Acoustic" });
  assert.equal(out.isError, false, JSON.stringify(out.structuredContent));
  assert.equal(kitTries, 6, "the live client retries four times, then the composite waits and asks again");
  assert.equal(out.structuredContent.kit_load.verified, true);
  await r.close();
});

test("load_drum_kit says the rack is loaded and to call again when the sweep does not finish in time", async () => {
  const r = await kitRig(BROWSER, {}, {
    browser_load: (args, _q, reply) => {
      if (args["uri"] === "u:rack") return { loaded: { name: "Drum Rack", uri: "u:rack" }, verified: false, sweep_pending: true };
      reply.fail("busy", "an earlier load on this track or too many loads are still being swept", { reason: "sweep_pending" });
      return undefined;
    },
  });
  const out = await r.call("load_drum_kit", { track_index: 0, kit_path: "drums/Acoustic" });
  assert.equal(out.isError, true);
  assert.equal(out.structuredContent.code, "busy");
  assert.equal(out.structuredContent.details.rack_loaded, true);
  assert.match(out.structuredContent.message, /call load_drum_kit again/);
  await r.close();
});

// ---------------------------------------------------------------- get_session_snapshot

function snapshotAnswers(w: FakeWorld, calls: string[]): NonNullable<RigOptions["answers"]> {
  const note = (id: number): Json => ({ note_id: id, pitch: 36 + id, start_time: id, duration: 0.5, velocity: 100, mute: false });
  return {
    ...w.answers(),
    track_get: (args) => {
      calls.push("track_get");
      const index = ((args["track"] as Json)["index"]) as number;
      return { track: { kind: "track", index, name: w.tracks[index]!.name }, devices: [{ path: [0], name: "EQ Eight", class_name: "Eq8", type: "audio_effect", is_active: true, parameter_count: 3 }], slots: [{ slot: 0, has_clip: true, clip: { name: `clip${index}`, length: 4, is_midi: true, is_audio: false } }, { slot: 1, has_clip: false, clip: null }] };
    },
    notes_get: (args) => { calls.push("notes_get"); return { items: Array.from({ length: Math.min(5, args["limit"] as number) }, (_, i) => note(i)), total: 5, next_offset: null }; },
    device_get: (args) => { calls.push("device_get"); return { device: { path: [0], name: "EQ Eight" }, parameters: Array.from({ length: Math.min(3, args["limit"] as number) }, (_, i) => ({ index: i, name: i === 0 ? "Gain" : `P${i}`, value: 0.5, display: "0 dB" })), total: 3, next_offset: null }; },
    arrangement_clips: () => { calls.push("arrangement_clips"); return { items: [{ index: 0, name: "Arr", start_time: 0, end_time: 8, length: 8 }], total: 1, next_offset: null }; },
  };
}

test("get_session_snapshot aggregates song, tracks, devices, clips, arrangement, notes and params with read commands only", async () => {
  const w = new FakeWorld();
  const calls: string[] = [];
  const r = await startRig({ answers: snapshotAnswers(w, calls), echo: true });
  const out = await r.call("get_session_snapshot");
  assert.equal(out.isError, false, JSON.stringify(out.structuredContent));
  const s = out.structuredContent;
  assert.equal(s.song.tempo, 120);
  assert.equal(s.tracks.length, 3);
  assert.deepEqual(s.tracks[1].devices.map((d: Json) => d.name), ["EQ Eight"]);
  assert.equal(s.tracks[1].clips.length, 1, "only slots that hold a clip");
  assert.equal(s.tracks[1].clips[0].slot, 0);
  assert.equal(s.tracks[1].clips[0].notes.length, 5);
  assert.equal(s.tracks[1].devices[0].parameters[0].name, "Gain");
  assert.equal(s.tracks[1].arrangement_clips[0].name, "Arr");
  assert.deepEqual(s.returns.map((t: Json) => t.name), ["A Reverb"]);
  assert.equal(s.master.name, "Master");
  assert.equal(s.truncated, false);
  assert.equal(r.seen().some((c) => MUTATING.has(c.cmd)), false, "read-only");
  assert.equal(JSON.stringify(s).includes("user_prompt"), false);
  await r.close();
});

test("get_session_snapshot honors include flags, per-item limits and max_tracks, and says when it cut", async () => {
  const w = new FakeWorld();
  const calls: string[] = [];
  const r = await startRig({ answers: snapshotAnswers(w, calls), echo: true });
  const light = await r.call("get_session_snapshot", { include_notes: false, include_params: false, include_arrangement: false });
  assert.equal(light.isError, false);
  assert.equal(calls.some((c) => c === "notes_get" || c === "device_get" || c === "arrangement_clips"), false);
  assert.equal(light.structuredContent.tracks[0].clips[0].notes, undefined);
  calls.length = 0;
  const cut = await r.call("get_session_snapshot", { max_tracks: 2, max_notes_per_clip: 2, max_params_per_device: 1 });
  assert.equal(cut.structuredContent.tracks.length, 2);
  assert.equal(cut.structuredContent.tracks_total, 3);
  assert.equal(cut.structuredContent.truncated, true);
  assert.equal(cut.structuredContent.tracks[0].clips[0].notes.length, 2);
  assert.equal(cut.structuredContent.tracks[0].clips[0].notes_total, 5);
  assert.equal(cut.structuredContent.tracks[0].clips[0].notes_truncated, true);
  for (const args of [{ max_tracks: 0 }, { max_notes_per_clip: 100000 }, { user_prompt: "x" }]) assert.equal((await r.call("get_session_snapshot", args)).isError, true, JSON.stringify(args));
  await r.close();
});

// ---------------------------------------------------------------- get_browser_tree

test("get_browser_tree lists the top level of one or every category through list_browser_items", async () => {
  const table: Record<string, Json[]> = Object.fromEntries(["instruments", "sounds", "drums", "audio_effects", "midi_effects"].map((c) => [`${c}|`, [item(`${c} root`, `u:${c}`, { is_folder: true, is_loadable: false })]]));
  const r = await kitRig(table);
  const one = await r.call("get_browser_tree", { category_type: "drums" });
  assert.equal(one.isError, false, JSON.stringify(one.structuredContent));
  assert.deepEqual(Object.keys(one.structuredContent.categories), ["drums"]);
  assert.deepEqual(r.seen().filter((c) => c.cmd === "browser_list").map((c) => c.args["category"]), ["drums"]);
  const all = await r.call("get_browser_tree", {});
  assert.deepEqual(Object.keys(all.structuredContent.categories), ["instruments", "sounds", "drums", "audio_effects", "midi_effects"]);
  assert.equal((await r.call("get_browser_tree", { category_type: "plugins" })).isError, true);
  await r.close();
});
