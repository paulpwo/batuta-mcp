import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolError } from "../src/mcp/index.js";
import { specFor } from "../src/tools/catalog.js";
import { applyCompat } from "../src/tools/compat.js";
import { FakeWorld } from "./helpers/fake-world.js";
import { startRig } from "./helpers/tools-harness.js";
import type { Rig } from "./helpers/tools-harness.js";
import type { Json } from "./helpers/mcp-client.js";

/** Broad tools that take the compatibility argument names too (docs/03-tool-names.md, "argument aliases"). */

const T = (index: number): Json => ({ kind: "track", index });
const SLOT = (track: number, slot: number): Json => ({ kind: "session", track: T(track), slot });
const NOTE = { pitch: 60, start_time: 0, duration: 1, velocity: 100, mute: false };

interface Case { tool: string; compat: Json; broad: Json }

const CASES: Case[] = [
  { tool: "get_track_info", compat: { track_index: 1 }, broad: { track: T(1) } },
  { tool: "delete_track", compat: { track_index: 1, expect_name: "Bass" }, broad: { track: T(1), expect_name: "Bass" } },
  { tool: "duplicate_track", compat: { track_index: 0 }, broad: { track: T(0) } },
  { tool: "delete_scene", compat: { scene_index: 1 }, broad: { scene: 1 } },
  { tool: "fire_scene", compat: { scene_index: 2 }, broad: { scene: 2 } },
  { tool: "delete_clip", compat: { track_index: 0, clip_index: 2 }, broad: { clip: SLOT(0, 2) } },
  { tool: "duplicate_clip", compat: { track_index: 0, clip_index: 1 }, broad: { from: { track: T(0), slot: 1 } } },
  { tool: "get_clip_notes", compat: { track_index: 0, clip_index: 1 }, broad: { clip: SLOT(0, 1) } },
  { tool: "add_notes_to_clip", compat: { track_index: 0, clip_index: 1, notes: [NOTE] }, broad: { clip: SLOT(0, 1), notes: [NOTE] } },
  { tool: "remove_notes_from_clip", compat: { track_index: 0, clip_index: 1, from_pitch: 60, pitch_span: 1 }, broad: { clip: SLOT(0, 1), from_pitch: 60, pitch_span: 1 } },
  { tool: "create_clip", compat: { track_index: 0, clip_index: 3, length: 8 }, broad: { track: T(0), slot: 3, length: 8 } },
  { tool: "fire_clip", compat: { track_index: 2, clip_index: 0 }, broad: { track: T(2), slot: 0 } },
  { tool: "stop_clip", compat: { track_index: 2, clip_index: 0 }, broad: { track: T(2), slot: 0 } },
  { tool: "get_arrangement_clips", compat: { track_index: 1 }, broad: { track: T(1) } },
  { tool: "duplicate_to_arrangement", compat: { track_index: 1, clip_index: 2, destination_time: 8 }, broad: { source: SLOT(1, 2), track: T(1), time: 8 } },
  { tool: "get_device_parameters", compat: { track_index: 0, device_index: 0 }, broad: { device: { track: T(0), path: [0] } } },
  { tool: "set_device_enabled", compat: { track_index: 0, device_index: 1, on: false }, broad: { device: { track: T(0), path: [1] }, enabled: false } },
  { tool: "delete_device", compat: { track_index: 0, device_index: 0 }, broad: { device: { track: T(0), path: [0] } } },
  { tool: "set_device_parameter", compat: { track_index: 0, device_index: 0, parameter_index: 1, value: 0.25 }, broad: { param: { device: { track: T(0), path: [0] }, index: 1 }, value: 0.25 } },
  { tool: "set_device_parameter", compat: { track_index: 0, device_index: 0, parameter: "Dry/Wet", value: 0.25 }, broad: { param: { device: { track: T(0), path: [0] }, name: "Dry/Wet" }, value: 0.25 } },
  { tool: "load_instrument_or_effect", compat: { track_index: 0, uri: "query:Synths#Operator" }, broad: { track: T(0), uri: "query:Synths#Operator" } },
  // T9q F-T9-30: every tool with a single track, scene or clip selector also takes track_index / scene_index / clip_index
  { tool: "get_mixer", compat: { track_index: 1 }, broad: { track: T(1) } },
  { tool: "set_mixer", compat: { track_index: 1, pan: 0.2 }, broad: { track: T(1), pan: 0.2 } },
  { tool: "get_routing", compat: { track_index: 1 }, broad: { track: T(1) } },
  { tool: "set_routing", compat: { track_index: 1, output_type: "Master" }, broad: { track: T(1), output_type: "Master" } },
  { tool: "set_track_properties", compat: { track_index: 1, mute: true }, broad: { track: T(1), mute: true } },
  { tool: "select_track", compat: { track_index: 1 }, broad: { track: T(1) } },
  { tool: "stop_track_clips", compat: { track_index: 1 }, broad: { track: T(1) } },
  { tool: "list_clip_slots", compat: { track_index: 1, include_empty: true }, broad: { track: T(1), include_empty: true } },
  { tool: "get_slot_status", compat: { track_index: 1, clip_index: 2 }, broad: { track: T(1), slot: 2 } },
  { tool: "create_arrangement_clip", compat: { track_index: 0, start: 0, length: 4 }, broad: { track: T(0), start: 0, length: 4 } },
  { tool: "duplicate_scene", compat: { scene_index: 1 }, broad: { scene: 1 } },
  { tool: "set_scene_properties", compat: { scene_index: 1, name: "Verse" }, broad: { scene: 1, name: "Verse" } },
  { tool: "commit_scene_to_arrangement", compat: { scene_index: 1, time: 8 }, broad: { scene: 1, time: 8 } },
  { tool: "list_devices", compat: { track_index: 0 }, broad: { container: { track: T(0), path: [] } } },
  { tool: "insert_device", compat: { track_index: 0, name: "Compressor" }, broad: { container: { track: T(0), path: [] }, name: "Compressor" } },
  { tool: "get_clip_info", compat: { track_index: 0, clip_index: 1 }, broad: { clip: SLOT(0, 1) } },
  { tool: "set_clip_properties", compat: { track_index: 0, clip_index: 1, muted: true }, broad: { clip: SLOT(0, 1), muted: true } },
  { tool: "crop_clip", compat: { track_index: 0, clip_index: 1 }, broad: { clip: SLOT(0, 1) } },
  { tool: "duplicate_clip_loop", compat: { track_index: 0, clip_index: 1 }, broad: { clip: SLOT(0, 1) } },
  { tool: "quantize_clip_notes", compat: { track_index: 0, clip_index: 1, grid: "1/8" }, broad: { clip: SLOT(0, 1), grid: "1/8" } },
  { tool: "modify_clip_notes", compat: { track_index: 0, clip_index: 1, notes: [{ note_id: 1, pitch: 61 }] }, broad: { clip: SLOT(0, 1), notes: [{ note_id: 1, pitch: 61 }] } },
  { tool: "list_clip_envelopes", compat: { track_index: 0, clip_index: 1 }, broad: { clip: SLOT(0, 1) } },
  { tool: "clear_all_clip_envelopes", compat: { track_index: 0, clip_index: 1 }, broad: { clip: SLOT(0, 1) } },
  { tool: "get_parameter", compat: { track_index: 0, device_index: 0, parameter_index: 1 }, broad: { param: { device: { track: T(0), path: [0] }, index: 1 } } },
  { tool: "get_rack", compat: { track_index: 0, device_index: 0 }, broad: { device: { track: T(0), path: [0] } } },
  { tool: "list_drum_pads", compat: { track_index: 0, device_index: 0 }, broad: { device: { track: T(0), path: [0] } } },
  { tool: "set_drum_pad", compat: { track_index: 0, device_index: 0, note: 36, mute: true }, broad: { device: { track: T(0), path: [0] }, note: 36, mute: true } },
];

function world(): FakeWorld {
  const w = new FakeWorld();
  w.tracks[0]!.devices = [{ name: "EQ Eight", params: [{ name: "Device On", value: 1, display: "On" }, { name: "Dry/Wet", value: 1, display: "100 %" }] }, { name: "Compressor" }];
  return w;
}
async function rig(): Promise<Rig> { return startRig({ answers: world().answers(), echo: true }); }
const lastWire = (r: Rig): Json | undefined => r.seen().at(-1);

for (const c of CASES) {
  test(`compat: ${c.tool} ${Object.keys(c.compat).join("+")} reaches the same wire command as the broad arguments`, async () => {
    const a = await rig();
    const viaCompat = await a.call(c.tool, c.compat);
    assert.equal(viaCompat.isError, false, JSON.stringify(viaCompat.structuredContent));
    const b = await rig();
    const viaBroad = await b.call(c.tool, c.broad);
    assert.equal(viaBroad.isError, false, JSON.stringify(viaBroad.structuredContent));
    assert.deepEqual(lastWire(a), lastWire(b));
    assert.deepEqual(a.seen(), b.seen(), "same listings and guards too");
    await a.close();
    await b.close();
  });
}

test("compat: a compat argument and the broad selector it replaces cannot be mixed", async () => {
  const r = await rig();
  const result = await r.call("delete_track", { track_index: 1, track: T(1) });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.code, "invalid_args");
  assert.deepEqual(r.seen(), [], "nothing reaches the script");
  await r.close();
});

test("compat: a half-given compat form (clip_index without track_index) is invalid and the target is still required", async () => {
  const r = await rig();
  for (const [tool, args] of [["delete_clip", { clip_index: 2 }], ["delete_track", {}], ["fire_clip", { track_index: 1 }], ["set_device_enabled", { track_index: 0, on: true }], ["set_device_parameter", { track_index: 0, device_index: 0, value: 1 }]] as Array<[string, Json]>) {
    const result = await r.call(tool, args);
    assert.equal(result.isError, true, tool);
    assert.equal(result.structuredContent.code, "invalid_args", tool);
  }
  assert.deepEqual(r.seen(), []);
  await r.close();
});

test("compat: unknown arguments are still refused (no accept-and-ignore, no user_prompt)", async () => {
  const r = await rig();
  for (const tool of ["get_track_info", "fire_clip", "add_notes_to_clip"]) {
    const result = await r.call(tool, { track_index: 0, clip_index: 0, notes: [NOTE], user_prompt: "make a beat" });
    assert.equal(result.isError, true, tool);
  }
  assert.deepEqual(r.seen(), []);
  await r.close();
});

test("compat: the guards apply through the compat arguments (expect_name pin, gain trip, destructive disabled)", async () => {
  const r = await rig();
  const pinned = await r.call("delete_track", { track_index: 1, expect_name: "Drums" });
  assert.equal(pinned.isError, true);
  assert.equal(pinned.structuredContent.details.reason, "name_mismatch");
  assert.deepEqual(r.seen().filter((c) => c.cmd === "track_delete"), []);
  const w = world();
  w.tracks[0]!.devices = [{ name: "Utility", params: [{ name: "Gain", value: 0, display: "0.0 dB" }] }];
  const g = await startRig({ answers: w.answers(), echo: true });
  const trip = await g.call("set_device_parameter", { track_index: 0, device_index: 0, parameter_index: 0, value: 12 });
  assert.equal(trip.structuredContent.confirmation_required, true, "a large gain jump asks, as with the broad form");
  assert.deepEqual(g.seen().filter((c) => c.cmd === "param_set"), []);
  const off = await startRig({ answers: world().answers(), echo: true, config: { destructive: "disabled" } });
  assert.equal(off.registry.get("delete_track"), undefined, "hidden when destructive actions are disabled");
  assert.equal(off.registry.get("remove_notes_from_clip"), undefined);
  const refused = await off.call("duplicate_clip", { track_index: 0, clip_index: 0, to: { track: T(1), slot: 0 }, allow_overwrite: true });
  assert.equal(refused.isError, true);
  assert.equal(refused.structuredContent.details.reason, "disabled_by_config");
  assert.deepEqual(off.seen().filter((c) => c.cmd === "clip_duplicate"), []);
  await Promise.all([r.close(), g.close(), off.close()]);
});

test("compat: arguments work inside a batch op too", async () => {
  const r = await rig();
  const result = await r.call("batch", { ops: [{ cmd: "fire_clip", args: { track_index: 1, clip_index: 0 } }, { cmd: "set_device_enabled", args: { track_index: 0, device_index: 0, on: false } }] });
  assert.equal(result.isError, false, JSON.stringify(result.structuredContent));
  const sent = r.seen().find((c) => c.cmd === "batch");
  assert.deepEqual(sent?.args["ops"], [
    { cmd: "slot_fire", args: { track: { kind: "track", index: 1, expect_name: "Bass" }, slot: 0 } },
    { cmd: "device_enable", args: { device: { track: { kind: "track", index: 0, expect_name: "Drums" }, path: [0] }, enabled: false } },
  ]);
  await r.close();
});

test("T9j F-T9-13: destination_time with the broad source says to use time instead", () => {
  const dup = specFor("arrangement_duplicate")!;
  const source = { kind: "session", track: { kind: "track", index: 0 }, slot: 0 };
  assert.throws(
    () => applyCompat(dup, { source, track: { kind: "track", index: 0 }, destination_time: 8 }),
    (error: unknown) => error instanceof ToolError && error.details?.["reason"] === "compat_incomplete" && /use time/.test(error.message) && /instead of destination_time/.test(error.message),
  );
  // the broad form itself still works, and the compat-only message is unchanged
  assert.equal(applyCompat(dup, { source, track: { kind: "track", index: 0 }, time: 8 })["time"], 8);
});

test("T9j descriptions: unwarped audio clip markers are in seconds; cue create/delete cannot run in batch", () => {
  for (const command of ["clip_get", "clip_set", "audio_clip_create"]) {
    assert.match(specFor(command)!.description, /SECONDS/, command);
    assert.match(specFor(command)!.description, /warping off/, command);
  }
  for (const command of ["cue_create", "cue_delete"]) assert.match(specFor(command)!.description, /inside batch.*needs_ticks/, command);
});

test("T9q F-T9-30: the new index forms are refused like the old ones when mixed, half given or missing", async () => {
  const r = await rig();
  for (const [tool, args] of [
    ["get_mixer", { track_index: 1, track: T(1) }], ["get_mixer", {}], ["duplicate_scene", { scene_index: 1, scene: 1 }], ["duplicate_scene", {}],
    ["get_slot_status", { clip_index: 2 }], ["get_slot_status", { track_index: 1 }], ["get_clip_info", { clip_index: 1 }], ["list_clip_slots", {}],
  ] as Array<[string, Json]>) {
    const result = await r.call(tool, args);
    assert.equal(result.isError, true, tool);
    assert.equal(result.structuredContent.code, "invalid_args", tool);
  }
  assert.deepEqual(r.seen(), [], "nothing reaches the script");
  await r.close();
});
