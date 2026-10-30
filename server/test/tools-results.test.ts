import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeWorld } from "./helpers/fake-world.js";
import { commandForTool } from "../src/tools/catalog.js";
import { startRig } from "./helpers/tools-harness.js";
import type { Rig, RigOptions } from "./helpers/tools-harness.js";
import type { Json } from "./helpers/mcp-client.js";

/** Live call options, error mapping, outcome-unknown messaging, result shaping and the browser/sweep facts. */

async function rig(options: RigOptions = {}, world = new FakeWorld()): Promise<Rig> {
  return startRig({ answers: { ...world.answers(), ...(options.answers ?? {}) }, echo: true, ...options, ...(options.answers === undefined ? {} : { answers: { ...world.answers(), ...options.answers } }) });
}

// ---------------------------------------------------------------- requeue policy

test("requeueOnReconnect is true for read-only commands (tools, listings, guards, catalog) and false for every mutation", async () => {
  const w = new FakeWorld();
  w.volumeDb["track0"] = -10;
  const r = await rig({}, w);
  await r.call("get_session_info");
  await r.call("get_track_info", { track: { name: "Bass" } });
  await r.call("set_track_properties", { track: { name: "Bass" }, mute: true });
  await r.call("set_mixer", { track: { kind: "track", index: 0 }, volume_db: -8 });
  await r.call("batch", { ops: [{ cmd: "set_track_properties", args: { track: { kind: "track", index: 0 }, mute: false } }] });
  const byCommand = (cmd: string): boolean[] => r.callLog.filter((c) => c.cmd === cmd).map((c) => c.options.requeueOnReconnect === true);
  for (const read of ["song_info", "track_get", "track_list", "mixer_get"]) {
    assert.ok(byCommand(read).length > 0, read);
    assert.ok(byCommand(read).every(Boolean), `${read} may be replayed`);
  }
  for (const write of ["track_set", "mixer_set", "batch"]) {
    assert.ok(byCommand(write).length > 0, write);
    assert.ok(byCommand(write).every((flag) => !flag), `${write} must never be replayed`);
  }
  assert.ok(r.callLog.filter((c) => c.cmd !== "catalog").every((c) => c.options.signal !== undefined), "every call carries the tool call's cancellation signal (the shared catalog check aside)");
  await r.close();
});

test("every mutating command is sent without requeue and every read-only one with it", async () => {
  const r = await startRig({ echo: true, answers: {} });
  const { COMMAND_SPECS } = await import("../src/tools/catalog.js");
  const executor = r.tools.executor as unknown as { send(spec: unknown, cmd: string, args: Json, signal: AbortSignal): Promise<unknown> };
  for (const spec of COMMAND_SPECS) {
    r.callLog.length = 0;
    await executor.send(spec, spec.command, {}, new AbortController().signal).catch(() => undefined);
    assert.equal(r.callLog.at(-1)?.options.requeueOnReconnect, !spec.mutating, spec.command);
  }
  await r.close();
});

// ---------------------------------------------------------------- outcome unknown

test("a mutating call that loses the connection after sending tells the model to re-read state and never retries", async () => {
  const r = await rig({ intercept: (request, reply) => { if (request.cmd === "track_set") { reply.conn.destroy(); return true; } return false; } });
  const result = await r.call("set_track_properties", { track: { kind: "track", index: 0 }, mute: true });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.code, "connection_lost");
  assert.equal(result.structuredContent.details.outcome_unknown, true);
  assert.match(result.structuredContent.message, /may or may not have been applied/);
  assert.match(result.structuredContent.message, /re-read/i);
  assert.equal(r.seen().filter((c) => c.cmd === "track_set").length, 1, "not retried");
  await r.close();
});

test("a script-side timeout of a mutating command is outcome-unknown, of a read-only command it is not", async () => {
  const r = await rig({ intercept: (request, reply) => { if (request.cmd === "track_set" || request.cmd === "track_get") { reply.fail("timeout", "deadline passed"); return true; } return false; } });
  const write = await r.call("set_track_properties", { track: { kind: "track", index: 0 }, mute: true });
  assert.equal(write.structuredContent.code, "timeout");
  assert.equal(write.structuredContent.details.outcome_unknown, true);
  const read = await r.call("get_track_info", { track: { kind: "track", index: 0 } });
  assert.equal(read.structuredContent.code, "timeout");
  assert.equal(read.structuredContent.details?.outcome_unknown, undefined);
  assert.doesNotMatch(read.structuredContent.message, /may or may not/);
  await r.close();
});

test("script errors arrive as isError results with code, message and details", async () => {
  const r = await rig({ answers: { mixer_set: (_args, _req, reply) => { reply.fail("out_of_range", "volume must be 0..1", { min: 0, max: 1, value: 2 }); return undefined; } } });
  const result = await r.call("set_mixer", { track: { kind: "track", index: 0 }, pan: 0.5 });
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, { code: "out_of_range", message: "volume must be 0..1", details: { min: 0, max: 1, value: 2 } });
  await r.close();
});

test("not connected: the tool says so and nothing is queued for later", async () => {
  const r = await startRig({ noWait: true, answers: {}, echo: true });
  await r.script.close();
  const result = await r.call("get_session_info");
  assert.equal(result.isError, true);
  assert.equal(typeof result.structuredContent.code, "string");
  assert.ok(result.structuredContent.message.length > 0);
  assert.deepEqual(r.script.requests, []);
  await r.close();
});

// ---------------------------------------------------------------- results

test("structuredContent is the script result; content starts with a short summary and carries small results as JSON", async () => {
  const r = await rig({ answers: { song_info: () => ({ tempo: 123.5, pending_sweeps: 0, recent_sweeps: [] }) } });
  const result = await r.call("get_session_info");
  assert.deepEqual(result.structuredContent, { tempo: 123.5, pending_sweeps: 0, recent_sweeps: [] });
  assert.equal(result.content[0].type, "text");
  assert.match(result.content[0].text, /^Read song info: ok\./);
  assert.ok(result.content[0].text.includes('"tempo":123.5'));
  await r.close();
});

test("paged results say how many items there are and how to continue", async () => {
  const w = new FakeWorld();
  w.maxPage = 2;
  w.tracks = [{ name: "A" }, { name: "B" }, { name: "C" }];
  const r = await rig({}, w);
  const result = await r.call("list_tracks", { limit: 2 });
  assert.match(result.content[0].text, /^List tracks: 2 item\(s\) of 5; more available, continue with offset 2\./);
  assert.equal(result.structuredContent.next_offset, 2);
  await r.close();
});

test("large results keep the text short and point to structuredContent", async () => {
  const big = { items: Array.from({ length: 400 }, (_, i) => ({ index: i, name: `Track ${i} with a longish name` })), total: 400, next_offset: null };
  const r = await rig({ answers: { track_list: () => big } });
  const result = await r.call("list_tracks");
  assert.ok(result.content[0].text.length < 400);
  assert.match(result.content[0].text, /structuredContent/);
  assert.equal(result.structuredContent.items.length, 400);
  await r.close();
});

// ---------------------------------------------------------------- browser and sweeps

test("browser_load keeps new_tracks and landed_on and warns that Live created a track", async () => {
  const created = { kind: "track", index: 4, name: "5-Drum Rack", arm: true };
  const loaded = { loaded: { name: "Drum Rack", uri: "query:Drums#Drum%20Rack" }, device_count: 0, verified: true, sweep_pending: false, previous_sweep: null, new_tracks: [created], landed_on: { kind: "track", index: 4 } };
  const r = await rig({ answers: { browser_load: () => loaded } });
  const res = await r.call("load_instrument_or_effect", { track: { kind: "track", index: 3 }, uri: "query:Drums#Drum%20Rack" });
  assert.deepEqual(res.structuredContent.new_tracks, [created]);
  assert.deepEqual(res.structuredContent.landed_on, { kind: "track", index: 4 });
  assert.equal(res.structuredContent.warnings.length, 1);
  assert.match(res.structuredContent.warnings[0], /created a new track/);
  assert.match(res.content[0].text, /Warning: .*new_tracks/);
  await r.close();

  const swept = { ...loaded, new_tracks: undefined, landed_on: undefined, previous_sweep: { state: "clean", removed: [], verified: true, new_tracks: [created], landed_on: { kind: "track", index: 4 } } };
  const r2 = await rig({ answers: { browser_load: () => swept } });
  const late = await r2.call("load_instrument_or_effect", { track: { kind: "track", index: 3 }, uri: "query:Drums#Drum%20Rack" });
  assert.ok(late.structuredContent.warnings.some((w: string) => /created a new track/.test(w)));
  await r2.close();
});

test("browser_load surfaces verified, sweep_pending and previous_sweep, and warns when verified is false", async () => {
  const loaded = { loaded: { name: "Wavetable", uri: "query:Synths#Wavetable" }, device_count: 1, verified: true, sweep_pending: false, previous_sweep: null };
  const r = await rig({ answers: { browser_load: () => loaded } });
  const ok = await r.call("load_instrument_or_effect", { track: { kind: "track", index: 0 }, uri: "query:Synths#Wavetable" });
  assert.deepEqual(ok.structuredContent, loaded);
  assert.equal(ok.structuredContent.warnings, undefined);
  await r.close();

  const pending = { ...loaded, verified: false, sweep_pending: true, previous_sweep: { track: 1, removed: ["Max Instrument"] } };
  const r2 = await rig({ answers: { browser_load: () => pending } });
  const bad = await r2.call("load_instrument_or_effect", { track: { kind: "track", index: 0 }, uri: "query:Synths#Wavetable" });
  assert.equal(bad.isError, false);
  assert.equal(bad.structuredContent.verified, false);
  assert.equal(bad.structuredContent.sweep_pending, true);
  assert.deepEqual(bad.structuredContent.previous_sweep, pending.previous_sweep);
  assert.equal(bad.structuredContent.warnings.length, 2);
  assert.match(bad.structuredContent.warnings[0], /verified is false/);
  assert.match(bad.content[0].text, /Warning: verified is false/);
  await r2.close();
});

test("song_info exposes pending_sweeps and recent_sweeps and warns while sweeps are pending", async () => {
  const info = { tempo: 120, pending_sweeps: 2, recent_sweeps: [{ track: 0, outcome: "clean" }] };
  const r = await rig({ answers: { song_info: () => info } });
  const result = await r.call("get_session_info");
  assert.equal(result.structuredContent.pending_sweeps, 2);
  assert.deepEqual(result.structuredContent.recent_sweeps, info.recent_sweeps);
  assert.match(result.structuredContent.warnings[0], /2 safety sweep/);
  await r.close();
});

test("a partial batch result is flagged", async () => {
  const r = await rig({ answers: { batch: () => ({ results: [{ ok: true, result: {} }, { ok: false, error: { code: "not_found", message: "x" } }], executed: 2, partial: true }) } });
  const result = await r.call("batch", { ops: [{ cmd: "set_track_properties", args: { track: { kind: "track", index: 0 }, mute: true } }, { cmd: "set_track_properties", args: { track: { kind: "track", index: 9 }, mute: true } }] });
  assert.equal(result.isError, false);
  assert.match(result.structuredContent.warnings[0], /partial:true/);
  await r.close();
});

// ---------------------------------------------------------------- schema validation per group

const TR = { kind: "track", index: 0 };
const CLIP = { kind: "session", track: TR, slot: 0 };
const DEV = { track: TR, path: [0] };

interface Case { tool: string; valid: Json; invalid: Json; group: string }
const CASES: Case[] = [
  { group: "session", tool: "set_song_properties", valid: { tempo: 128 }, invalid: { tempo: 5 } },
  { group: "session", tool: "control_transport", valid: { action: "start" }, invalid: { action: "rewind" } },
  { group: "session", tool: "set_arrangement_time", valid: { time: 4 }, invalid: { time: -1 } },
  { group: "session", tool: "trigger_session_record", valid: { record_length: 4 }, invalid: { record_length: 0.5 } },
  { group: "tracks", tool: "create_track", valid: { type: "midi", name: "Keys" }, invalid: { type: "video" } },
  { group: "tracks", tool: "set_track_properties", valid: { track: TR, mute: true }, invalid: { track: TR, monitoring_state: 3 } },
  { group: "tracks", tool: "get_meters", valid: { all: true }, invalid: { tracks: [] } },
  { group: "mixer", tool: "set_mixer", valid: { track: TR, pan: 0.5 }, invalid: { track: TR, volume_db: 7 } },
  { group: "mixer", tool: "set_routing", valid: { track: TR, input_type: "Ext. In" }, invalid: { track: TR, input_type: 5 } },
  { group: "scenes", tool: "create_scene", valid: { name: "Bridge", tempo: 90 }, invalid: { color: 16777216 } },
  { group: "scenes", tool: "set_scene_properties", valid: { scene: 0, tempo: null, time_signature: null }, invalid: { scene: 0, time_signature: [4] } },
  { group: "cues", tool: "create_cue_point", valid: { time: 8 }, invalid: { time: -0.5 } },
  { group: "clips", tool: "create_clip", valid: { track: TR, slot: 0, length: 4 }, invalid: { track: TR, slot: 0, length: 0.1 } },
  { group: "clips", tool: "set_clip_properties", valid: { clip: CLIP, pitch_coarse: 12 }, invalid: { clip: CLIP, pitch_coarse: 60 } },
  { group: "clips", tool: "fire_clip", valid: { track: TR, slot: 1 }, invalid: { track: TR, slot: -1 } },
  { group: "notes", tool: "add_notes_to_clip", valid: { clip: CLIP, notes: [{ pitch: 60, start_time: 0, duration: 1 }] }, invalid: { clip: CLIP, notes: [{ pitch: 60, start_time: 0, duration: 1, velocity: 0 }] } },
  { group: "notes", tool: "get_clip_notes", valid: { clip: CLIP, limit: 10 }, invalid: { clip: CLIP, limit: 6000 } },
  { group: "notes", tool: "quantize_clip_notes", valid: { clip: CLIP, grid: "1/16" }, invalid: { clip: CLIP, grid: "1/3" } },
  { group: "envelopes", tool: "get_clip_envelope", valid: { clip: CLIP, param: { mixer: "pan", track: TR }, points: 64 }, invalid: { clip: CLIP, param: { mixer: "pan", track: TR }, points: 1 } },
  { group: "envelopes", tool: "set_clip_envelope", valid: { clip: CLIP, param: { mixer: "pan", track: TR }, steps: [{ time: 0, duration: 1, value: 0 }] }, invalid: { clip: CLIP, param: { mixer: "pan", track: TR }, steps: [] } },
  { group: "devices", tool: "insert_device", valid: { container: { track: TR, path: [] }, name: "EQ Eight" }, invalid: { container: { track: TR, path: [] }, name: "Evil; rm -rf" } },
  { group: "devices", tool: "set_device_parameter", valid: { param: { device: DEV, index: 1 }, value: 0.5 }, invalid: { param: { device: DEV, index: -1 }, value: 0.5 } },
  { group: "devices", tool: "get_device_parameters", valid: { device: DEV, limit: 64 }, invalid: { device: DEV, limit: 200 } },
  { group: "racks", tool: "set_chain_properties", valid: { device: DEV, chain: { kind: "chain", index: 0 }, pan: 0.5 }, invalid: { device: DEV, chain: { kind: "chain", index: 0 }, pan: 2 } },
  { group: "racks", tool: "set_rack_variation", valid: { device: DEV, action: "store" }, invalid: { device: DEV, action: "explode" } },
  { group: "racks", tool: "set_drum_pad", valid: { device: DEV, note: 36, mute: true }, invalid: { device: DEV, note: 128 } },
  { group: "browser", tool: "list_browser_items", valid: { category: "instruments", path: ["Synths"] }, invalid: { category: "modulators" } },
  { group: "browser", tool: "search_browser", valid: { query: "wave" }, invalid: { query: "" } },
  { group: "browser", tool: "load_instrument_or_effect", valid: { track: TR, uri: "query:Synths#Wavetable" }, invalid: { track: { kind: "group", index: 0 }, uri: "x" } },
  { group: "arrangement", tool: "create_arrangement_clip", valid: { track: TR, start: 0, length: 8 }, invalid: { track: TR, start: 0, length: 5000 } },
  { group: "arrangement", tool: "commit_scene_to_arrangement", valid: { scene: 0, time: 0 }, invalid: { scene: 0, time: 0, tracks: [] } },
  { group: "batch", tool: "batch", valid: { ops: [{ cmd: "set_track_properties", args: { track: TR, mute: true } }] }, invalid: { ops: [] } },
  { group: "selectors", tool: "get_track_info", valid: { track: { name: "Drums" } }, invalid: { track: { name: "Drums", index: 0 } } },
  { group: "selectors", tool: "fire_scene", valid: { scene: { name: "Intro" } }, invalid: { scene: { index: 0 } } },
];

test("schema validation: every group has a valid call that reaches the script and an invalid one that does not", async () => {
  const r = await rig();
  const groups = new Set<string>();
  for (const c of CASES) {
    groups.add(c.group);
    const bad = await r.call(c.tool, c.invalid);
    assert.equal(bad.isError, true, `${c.tool} invalid`);
    assert.equal(bad.structuredContent.code, "invalid_args", `${c.tool} invalid`);
    r.callLog.length = 0;
    const good = await r.call(c.tool, c.valid);
    assert.equal(good.isError, false, `${c.tool} valid: ${JSON.stringify(good.structuredContent)}`);
    assert.ok(r.callLog.some((entry) => entry.cmd === commandForTool(c.tool)), `${c.tool} reached the script`);
  }
  assert.deepEqual([...groups].sort(), ["arrangement", "batch", "browser", "clips", "cues", "devices", "envelopes", "mixer", "notes", "racks", "scenes", "selectors", "session", "tracks"]);
  await r.close();
});

test("invalid arguments never reach the script and unknown arguments are rejected", async () => {
  const r = await rig();
  const result = await r.call("set_song_properties", { tempo: 120, user_prompt: "telemetry" });
  assert.equal(result.structuredContent.code, "invalid_args");
  assert.deepEqual(r.seen(), []);
  await r.close();
});

test("combination rules are enforced before anything is sent: exclusive pairs and at-least-one", async () => {
  const r = await rig();
  const both = await r.call("set_mixer", { track: TR, volume: 0.5, volume_db: -3 });
  assert.equal(both.structuredContent.code, "invalid_args");
  assert.equal(both.structuredContent.details.reason, "mutually_exclusive");
  const none = await r.call("set_song_properties", {});
  assert.equal(none.structuredContent.details.reason, "at_least_one");
  const jump = await r.call("jump_to_cue_point", { index: 1, direction: "next" });
  assert.equal(jump.structuredContent.details.reason, "mutually_exclusive");
  const ids = await r.call("remove_notes_from_clip", { clip: CLIP, note_ids: [1], from_pitch: 3 });
  assert.equal(ids.structuredContent.details.reason, "mutually_exclusive");
  assert.deepEqual(r.seen(), []);
  await r.close();
});

test("the reserved ears track name is refused on create, rename and inside a batch", async () => {
  const r = await rig();
  for (const name of ["batuta-ears", "Batuta-Ears", "  batuta-ears "]) {
    const create = await r.call("create_track", { type: "audio", name });
    assert.equal(create.structuredContent.details.reason, "reserved_name", name);
    const rename = await r.call("set_track_properties", { track: TR, name });
    assert.equal(rename.structuredContent.details.reason, "reserved_name", name);
  }
  const batch = await r.call("batch", { ops: [{ cmd: "set_track_properties", args: { track: TR, name: "batuta-ears" } }] });
  assert.equal(batch.structuredContent.details.reason, "reserved_name");
  assert.equal((await r.call("create_track", { type: "audio", name: "batuta-ears-2" })).isError, false);
  assert.deepEqual(r.seen().map((c) => c.cmd).filter((c) => c !== "song_info"), ["track_create"]);
  await r.close();
});

test("batch: ops are validated per command, forbidden commands and unknown ones are named", async () => {
  const r = await rig();
  const forbidden = await r.call("batch", { ops: [{ cmd: "batch", args: { ops: [] } }] });
  assert.equal(forbidden.structuredContent.code, "invalid_args");
  for (const cmd of ["undo", "redo", "search_browser", "catalog", "nonsense"]) {
    const result = await r.call("batch", { ops: [{ cmd, args: {} }] });
    assert.equal(result.isError, true, cmd);
  }
  const badArgs = await r.call("batch", { ops: [{ cmd: "set_track_properties", args: { track: TR, mute: true } }, { cmd: "set_track_properties", args: { track: TR, monitoring_state: 9 } }] });
  assert.equal(badArgs.structuredContent.details.op, 1);
  assert.equal(badArgs.structuredContent.details.reason, "schema");
  assert.deepEqual(r.seen(), []);
  const named = await r.call("batch", { ops: [{ cmd: "set_track_properties", args: { track: { name: "Bass" }, mute: true } }, { cmd: "set_scene_properties", args: { scene: { name: "Chorus" }, name: "Outro" } }], stop_on_error: false });
  assert.equal(named.isError, false);
  assert.deepEqual(r.seen().filter((c) => c.cmd === "batch").map((c) => c.args), [{
    ops: [
      { cmd: "track_set", args: { track: { kind: "track", index: 1, expect_name: "Bass" }, mute: true } },
      { cmd: "scene_set", args: { scene: 2, name: "Outro" } },
    ],
    stop_on_error: false,
  }]);
  assert.equal(r.callLog.filter((c) => c.cmd === "track_list").length, 1, "listings are shared across the ops of one batch");
  await r.close();
});
