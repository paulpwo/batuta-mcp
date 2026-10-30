import { test } from "node:test";
import assert from "node:assert/strict";
import { ALIAS_SPECS } from "../src/tools/aliases.js";
import { toolNameFor } from "../src/tools/catalog.js";
import { FakeWorld } from "./helpers/fake-world.js";
import { startRig } from "./helpers/tools-harness.js";
import type { Rig } from "./helpers/tools-harness.js";
import type { Json } from "./helpers/mcp-client.js";

/** Narrow compatibility tools are thin aliases: they must reach the same executor path as the broad tool they stand for. */

const T = (index: number): Json => ({ kind: "track", index });
const MASTER: Json = { kind: "master" };
const SLOT = (track: number, slot: number): Json => ({ kind: "session", track: T(track), slot });

/** alias call, and the broad tool call it must be equivalent to. */
const TABLE: Array<[alias: string, args: Json, broad: string, broadArgs: Json]> = [
  ["create_midi_track", { index: 1 }, "create_track", { type: "midi", index: 1 }],
  ["create_midi_track", {}, "create_track", { type: "midi" }],
  ["create_audio_track", { index: 0 }, "create_track", { type: "audio", index: 0 }],
  ["create_return_track", {}, "create_track", { type: "return" }],
  ["set_track_name", { track_index: 1, name: "Lead" }, "set_track_properties", { track: T(1), name: "Lead" }],
  ["set_track_mute", { track_index: 1, on: true }, "set_track_properties", { track: T(1), mute: true }],
  ["set_track_solo", { track_index: 1, on: false }, "set_track_properties", { track: T(1), solo: false }],
  ["set_track_arm", { track_index: 0, on: true }, "set_track_properties", { track: T(0), arm: true }],
  ["set_track_color", { track_index: 2, color: 255 }, "set_track_properties", { track: T(2), color: 255 }],
  ["set_track_volume", { track_index: 1, value: 0.5 }, "set_mixer", { track: T(1), volume: 0.5 }],
  ["set_track_volume", { track_index: 1, value_normalized: 0.5 }, "set_mixer", { track: T(1), volume: 0.5 }],
  ["set_track_volume", { track_index: 1, volume_db: -6 }, "set_mixer", { track: T(1), volume_db: -6 }],
  ["set_track_volume", { track_index: 0, track: "master", value: 0.4 }, "set_mixer", { track: MASTER, volume: 0.4 }],
  ["set_track_pan", { track_index: 1, value: -0.5 }, "set_mixer", { track: T(1), pan: -0.5 }],
  ["set_track_pan", { track_index: 0, track: "return:0", value: 0.2 }, "set_mixer", { track: { kind: "return", index: 0 }, pan: 0.2 }],
  ["set_track_send", { track_index: 1, send_index: 0, value: 0.5 }, "set_mixer", { track: T(1), sends: [{ index: 0, value: 0.5 }] }],
  ["set_clip_name", { track_index: 0, clip_index: 1, name: "A" }, "set_clip_properties", { clip: SLOT(0, 1), name: "A" }],
  ["set_arrangement_clip_name", { track_index: 0, clip_index: 2, name: "B" }, "set_clip_properties", { clip: { kind: "arrangement", track: T(0), index: 2 }, name: "B" }],
  ["set_clip_color", { track_index: 0, clip_index: 1, color: 65280 }, "set_clip_properties", { clip: SLOT(0, 1), color: 65280 }],
  ["set_clip_loop", { track_index: 0, clip_index: 1, looping: true, loop_start: 0, loop_end: 4 }, "set_clip_properties", { clip: SLOT(0, 1), looping: true, loop_start: 0, loop_end: 4 }],
  ["clear_notes_from_clip", { track_index: 0, clip_index: 1 }, "remove_notes_from_clip", { clip: SLOT(0, 1) }],
  ["set_scene_name", { scene_index: 1, name: "Drop" }, "set_scene_properties", { scene: 1, name: "Drop" }],
  ["set_tempo", { tempo: 98 }, "set_song_properties", { tempo: 98 }],
  ["set_time_signature", { numerator: 6, denominator: 8 }, "set_song_properties", { signature_numerator: 6, signature_denominator: 8 }],
  ["set_metronome", { on: true }, "set_song_properties", { metronome: true }],
  ["set_song_position", { beats: 16 }, "set_arrangement_time", { time: 16 }],
  ["set_arrangement_record", { on: true }, "set_song_properties", { record_mode: true }],
  ["set_arrangement_record", {}, "set_song_properties", { record_mode: true }],
  ["set_clip_trigger_quantization", { value: 0 }, "set_song_properties", { clip_trigger_quantization: 0 }],
  ["set_clip_trigger_quantization", { value: "1 bar" }, "set_song_properties", { clip_trigger_quantization: "1 bar" }],
  ["start_playback", {}, "control_transport", { action: "start" }],
  ["stop_playback", {}, "control_transport", { action: "stop" }],
  ["continue_playback", {}, "control_transport", { action: "continue" }],
  ["switch_to_arrangement_view", {}, "show_view", { view: "arrangement" }],
  ["switch_to_session_view", {}, "show_view", { view: "session" }],
  ["capture_session_to_arrangement", { scene_index: 1, destination_time: 16 }, "commit_scene_to_arrangement", { scene: 1, time: 16 }],
  ["get_browser_items_at_path", { path: "drums/Acoustic/Kit 1" }, "list_browser_items", { category: "drums", path: ["Acoustic", "Kit 1"] }],
  ["get_browser_items_at_path", { path: "Audio Effects" }, "list_browser_items", { category: "audio_effects" }],
  ["get_track_meter", { track: 1 }, "get_meters", { tracks: [T(1)] }],
  ["get_track_meter", {}, "get_meters", { tracks: [T(0)] }],
  ["get_track_meter", { track: "master" }, "get_meters", { tracks: [MASTER] }],
  ["get_master_meter", {}, "get_meters", { tracks: [MASTER] }],
];

async function rig(config: Json = {}): Promise<Rig> { return startRig({ answers: new FakeWorld().answers(), echo: true, config: config as never }); }

for (const [alias, args, broad, broadArgs] of TABLE) {
  test(`alias: ${alias} ${JSON.stringify(args)} reaches the same executor path as ${broad}`, async () => {
    const a = await rig();
    const viaAlias = await a.call(alias, args);
    assert.equal(viaAlias.isError, false, JSON.stringify(viaAlias.structuredContent));
    const b = await rig();
    const viaBroad = await b.call(broad, broadArgs);
    assert.equal(viaBroad.isError, false, JSON.stringify(viaBroad.structuredContent));
    assert.ok(a.seen().length > 0);
    assert.deepEqual(a.seen(), b.seen(), "same wire commands, listings and expect_name pins");
    await a.close();
    await b.close();
  });
}

test("alias coverage: every alias in the table of the server is exercised above, and each targets a real command", () => {
  const covered = new Set(TABLE.map(([alias]) => alias));
  const missing = ALIAS_SPECS.map((a) => a.name).filter((name) => !covered.has(name));
  assert.deepEqual(missing, [], "aliases without an equivalence row");
  assert.equal(new Set(ALIAS_SPECS.map((a) => a.name)).size, ALIAS_SPECS.length);
  for (const alias of ALIAS_SPECS) assert.ok(toolNameFor(alias.command), alias.name);
});

test("alias: unknown arguments, user_prompt and wrong types are refused before anything is sent", async () => {
  const r = await rig();
  for (const [tool, args] of [["set_tempo", { tempo: 100, user_prompt: "faster" }], ["set_tempo", { tempo: "fast" }], ["set_track_mute", { track_index: 0 }], ["set_track_volume", { track_index: 0 }], ["set_track_volume", { track_index: 0, value: 0.5, volume_db: -3 }], ["get_browser_items_at_path", { path: "nonsense/x" }], ["set_track_pan", { track: "side:1", value: 0 }]] as Array<[string, Json]>) {
    const result = await r.call(tool, args);
    assert.equal(result.isError, true, `${tool} ${JSON.stringify(args)}`);
    assert.equal(result.structuredContent.code, "invalid_args", tool);
  }
  assert.deepEqual(r.seen(), []);
  await r.close();
});

test("alias guards: gain trip, edition limit, reserved name and expect_name apply exactly as on the broad tool", async () => {
  const w = new FakeWorld();
  w.volumeDb["track1"] = -20;
  const g = await startRig({ answers: w.answers(), echo: true });
  const trip = await g.call("set_track_volume", { track_index: 1, volume_db: 0 });
  assert.equal(trip.structuredContent.confirmation_required, true, "a +20 dB jump through the narrow tool asks");
  assert.deepEqual(g.seen().filter((c) => c.cmd === "mixer_set"), []);
  const master = await g.call("set_track_volume", { track_index: 0, track: "master", volume_db: 3 });
  assert.equal(master.structuredContent.confirmation_required, true, "the master ceiling applies");

  const lite = new FakeWorld();
  lite.tracks = Array.from({ length: 8 }, (_, i) => ({ name: `T${i}` }));
  const l = await startRig({ answers: lite.answers(), echo: true, welcome: { edition: "lite" } });
  for (const tool of ["create_midi_track", "create_audio_track"]) {
    const refused = await l.call(tool, {});
    assert.equal(refused.structuredContent.code, "edition_limit", tool);
  }
  const ears = await l.call("set_track_name", { track_index: 0, name: "batuta-ears" });
  assert.equal(ears.structuredContent.details.reason, "reserved_name");
  assert.deepEqual(l.seen().filter((c) => c.cmd === "track_create" || c.cmd === "track_set"), []);

  const d = await startRig({ answers: new FakeWorld().answers(), echo: true, config: { confirm: "destructive" }, capabilities: {} });
  const ask = await d.call("clear_notes_from_clip", { track_index: 0, clip_index: 0 });
  assert.equal(ask.structuredContent.confirmation_required, true, "destructive notes_remove asks in the strict mode");
  assert.match(ask.structuredContent.summary, /all notes/);
  const off = await rig({ destructive: "disabled" });
  assert.equal(off.registry.get("clear_notes_from_clip"), undefined, "an alias of a hidden tool is hidden too");
  assert.ok(off.registry.get("set_tempo"));
  await Promise.all([g.close(), l.close(), d.close(), off.close()]);
});

test("alias: batuta_confirm releases an alias-initiated destructive action like any other", async () => {
  const d = await startRig({ answers: new FakeWorld().answers(), echo: true, config: { confirm: "destructive" } });
  const ask = await d.call("clear_notes_from_clip", { track_index: 0, clip_index: 0 });
  const done = await d.call("batuta_confirm", { confirm_id: ask.structuredContent.confirm_id, summary: ask.structuredContent.summary });
  assert.equal(done.isError, false);
  assert.deepEqual(d.seen().filter((c) => c.cmd === "notes_remove"), [{ cmd: "notes_remove", args: { clip: { kind: "session", track: { kind: "track", index: 0, expect_name: "Drums" }, slot: 0 } } }]);
  await d.close();
});
