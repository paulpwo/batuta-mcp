import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeWorld } from "./helpers/fake-world.js";
import { startRig } from "./helpers/tools-harness.js";
import type { Json } from "./helpers/mcp-client.js";

/** Name resolution (docs/01-protocol.md section 6.1 and 7.16): fresh listings, expect_name on every resolved ref. */

async function rig(world = new FakeWorld(), extra: Record<string, (args: Json) => unknown> = {}) {
  return startRig({ answers: { ...world.answers(), ...extra }, echo: true });
}

const commandsSent = (r: Awaited<ReturnType<typeof rig>>): Json[] => r.seen().filter((c) => c.cmd !== "track_list" && c.cmd !== "scene_list" && c.cmd !== "device_list" && c.cmd !== "rack_get" && c.cmd !== "device_get" && c.cmd !== "param_get" && c.cmd !== "song_info");

test("a unique track name becomes an index reference with expect_name", async () => {
  const r = await rig();
  const result = await r.call("get_track_info", { track: { name: "Bass" } });
  assert.equal(result.isError, false);
  const sent = commandsSent(r);
  assert.deepEqual(sent, [{ cmd: "track_get", args: { track: { kind: "track", index: 1, expect_name: "Bass" } } }]);
  await r.close();
});

test("matching is exact first, then case-insensitive", async () => {
  const world = new FakeWorld();
  world.tracks = [{ name: "bass" }, { name: "Bass" }, { name: "Lead" }];
  const r = await rig(world);
  await r.call("get_track_info", { track: { name: "Bass" } });
  await r.call("get_track_info", { track: { name: "bass" } });
  await r.call("get_track_info", { track: { name: "LEAD" } });
  assert.deepEqual(commandsSent(r).map((c) => (c.args as Json)["track"]), [
    { kind: "track", index: 1, expect_name: "Bass" },
    { kind: "track", index: 0, expect_name: "bass" },
    { kind: "track", index: 2, expect_name: "Lead" },
  ]);
  await r.close();
});

test("an ambiguous name is invalid_args with candidates and nothing reaches the script", async () => {
  const world = new FakeWorld();
  world.tracks = [{ name: "Pad" }, { name: "Bass" }, { name: "Pad" }];
  const r = await rig(world);
  const result = await r.call("set_track_properties", { track: { name: "Pad" }, mute: true });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.code, "invalid_args");
  assert.equal(result.structuredContent.details.reason, "ambiguous_name");
  assert.deepEqual(result.structuredContent.details.candidates, [{ kind: "track", index: 0, name: "Pad" }, { kind: "track", index: 2, name: "Pad" }]);
  assert.equal(commandsSent(r).length, 0);
  await r.close();
});

test("ambiguity lists at most 10 candidates", async () => {
  const world = new FakeWorld();
  world.tracks = Array.from({ length: 14 }, () => ({ name: "Take" }));
  const r = await rig(world);
  const result = await r.call("get_track_info", { track: { name: "Take" } });
  assert.equal(result.structuredContent.details.candidates.length, 10);
  await r.close();
});

test("a missing name is not_found and nothing reaches the script", async () => {
  const r = await rig();
  const result = await r.call("get_track_info", { track: { name: "Nope" } });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.code, "not_found");
  assert.equal(result.structuredContent.details.what, "track");
  assert.equal(commandsSent(r).length, 0);
  await r.close();
});

test("the optional kind narrows a name between tracks, returns and the master", async () => {
  const world = new FakeWorld();
  world.tracks = [{ name: "Verb" }];
  world.returns = [{ name: "Verb" }];
  const r = await rig(world);
  const both = await r.call("get_track_info", { track: { name: "Verb" } });
  assert.equal(both.structuredContent.details.reason, "ambiguous_name");
  assert.deepEqual(both.structuredContent.details.candidates.map((c: Json) => c["kind"]), ["track", "return"]);
  await r.call("get_track_info", { track: { name: "Verb", kind: "return" } });
  await r.call("get_track_info", { track: { name: "Master" } });
  assert.deepEqual(commandsSent(r).map((c) => (c.args as Json)["track"]), [
    { kind: "return", index: 0, expect_name: "Verb" },
    { kind: "master", expect_name: "Master" },
  ]);
  await r.close();
});

test("track-only selectors never match returns or the master", async () => {
  const world = new FakeWorld();
  world.returns = [{ name: "A Reverb" }];
  const r = await rig(world);
  const result = await r.call("duplicate_track", { track: { name: "A Reverb" } });
  assert.equal(result.structuredContent.code, "not_found");
  await r.close();
});

test("explicit references pass through unchanged and need no listing", async () => {
  const r = await rig();
  await r.call("get_track_info", { track: { kind: "track", index: 2, expect_name: "Pad" } });
  await r.call("get_mixer", { track: { kind: "master" } });
  assert.deepEqual(r.seen(), [
    { cmd: "track_get", args: { track: { kind: "track", index: 2, expect_name: "Pad" } } },
    { cmd: "mixer_get", args: { track: { kind: "master" } } },
  ]);
  await r.close();
});

test("listings are followed across pages", async () => {
  const world = new FakeWorld();
  world.tracks = Array.from({ length: 7 }, (_, i) => ({ name: `T${i}` }));
  world.maxPage = 3;
  const r = await rig(world);
  await r.call("get_track_info", { track: { name: "T6" } });
  assert.equal(r.seen().filter((c) => c.cmd === "track_list").length, 3);
  assert.deepEqual(commandsSent(r)[0]!.args, { track: { kind: "track", index: 6, expect_name: "T6" } });
  await r.close();
});

test("scene names resolve to indices", async () => {
  const r = await rig();
  await r.call("set_scene_properties", { scene: { name: "verse" }, name: "Verse 2" });
  await r.call("fire_scene", { scene: { name: "Chorus" } });
  assert.deepEqual(commandsSent(r), [{ cmd: "scene_set", args: { scene: 1, name: "Verse 2" } }, { cmd: "scene_fire", args: { scene: 2 } }]);
  await r.close();
});

test("devices resolve by name through device_list and rack_get, and parameters through device_get", async () => {
  const world = new FakeWorld();
  world.tracks = [{ name: "Drums" }, {
    name: "Bass",
    devices: [
      { name: "Operator" },
      { name: "Audio Effect Rack", chains: [{ name: "Dry", devices: [{ name: "EQ Eight" }] }, { name: "Wet", devices: [{ name: "Reverb", params: [{ name: "Dry/Wet", value: 0.3, display: "30 %" }, { name: "Decay", value: 0.5, display: "2 s" }] }] }] },
    ],
  }];
  const r = await rig(world);
  await r.call("set_device_enabled", { device: { track: { name: "Bass" }, path: [{ name: "operator" }] }, enabled: false });
  await r.call("set_device_parameter", { param: { device: { track: { name: "Bass" }, path: [{ name: "Audio Effect Rack" }, { chain: { name: "Wet" }, device: { name: "Reverb" } }] }, name: "decay" }, value: 0.7 });
  const sent = commandsSent(r);
  assert.deepEqual(sent[0], { cmd: "device_enable", args: { device: { track: { kind: "track", index: 1, expect_name: "Bass" }, path: [0] }, enabled: false } });
  assert.deepEqual(sent[1]!.args, {
    param: { device: { track: { kind: "track", index: 1, expect_name: "Bass" }, path: [1, { chain: 1, device: 0 }] }, index: 1 },
    value: 0.7,
  });
  await r.close();
});

test("an ambiguous device or parameter name lists candidates; a missing one is not_found", async () => {
  const world = new FakeWorld();
  world.tracks = [{ name: "Bass", devices: [{ name: "EQ Eight" }, { name: "EQ Eight", params: [{ name: "Gain", value: 0, display: "0 dB" }, { name: "Gain", value: 0, display: "0 dB" }] }] }];
  const r = await rig(world);
  const dup = await r.call("set_device_enabled", { device: { track: { name: "Bass" }, path: [{ name: "EQ Eight" }] }, enabled: true });
  assert.equal(dup.structuredContent.details.reason, "ambiguous_name");
  assert.deepEqual(dup.structuredContent.details.candidates.map((c: Json) => c["index"]), [0, 1]);
  const dupParam = await r.call("get_parameter", { param: { device: { track: { name: "Bass" }, path: [1] }, name: "Gain" } });
  assert.equal(dupParam.structuredContent.details.reason, "ambiguous_name");
  const none = await r.call("get_parameter", { param: { device: { track: { name: "Bass" }, path: [1] }, name: "Nothing" } });
  assert.equal(none.structuredContent.code, "not_found");
  const noDevice = await r.call("set_device_enabled", { device: { track: { name: "Bass" }, path: [{ name: "Reverb" }] }, enabled: true });
  assert.equal(noDevice.structuredContent.details.what, "device");
  await r.close();
});

test("param_set items resolve parameter names against the resolved device", async () => {
  const world = new FakeWorld();
  world.tracks = [{ name: "Bass", devices: [{ name: "Compressor", params: [{ name: "Threshold", value: 0.5, display: "-12 dB" }, { name: "Ratio", value: 0.4, display: "4:1" }] }] }];
  const r = await rig(world);
  await r.call("set_device_parameter", { device: { track: { name: "Bass" }, path: [{ name: "Compressor" }] }, items: [{ name: "ratio", value: 0.5 }, { index: 0, value: 0.2 }] });
  assert.deepEqual(commandsSent(r)[0]!.args, {
    device: { track: { kind: "track", index: 0, expect_name: "Bass" }, path: [0] },
    items: [{ index: 1, value: 0.5 }, { index: 0, value: 0.2 }],
  });
  await r.close();
});

test("clip, slot and track lists resolve names inside nested arguments", async () => {
  const r = await rig();
  await r.call("get_clip_info", { clip: { kind: "session", track: { name: "Pad" }, slot: 3 } });
  await r.call("duplicate_clip", { from: { track: { name: "Drums" }, slot: 0 }, to: { track: { name: "Bass" }, slot: 1 } });
  await r.call("get_meters", { tracks: [{ name: "Drums" }, { kind: "master" }, { name: "A Reverb" }] });
  await r.call("commit_scene_to_arrangement", { scene: { name: "Chorus" }, time: 16, tracks: [{ name: "Bass" }] });
  const sent = commandsSent(r).map((c) => c.args);
  assert.deepEqual(sent[0], { clip: { kind: "session", track: { kind: "track", index: 2, expect_name: "Pad" }, slot: 3 } });
  assert.deepEqual(sent[1], { from: { track: { kind: "track", index: 0, expect_name: "Drums" }, slot: 0 }, to: { track: { kind: "track", index: 1, expect_name: "Bass" }, slot: 1 } });
  assert.deepEqual(sent[2], { tracks: [{ kind: "track", index: 0, expect_name: "Drums" }, { kind: "master" }, { kind: "return", index: 0, expect_name: "A Reverb" }] });
  assert.deepEqual(sent[3], { scene: 2, time: 16, tracks: [{ kind: "track", index: 1, expect_name: "Bass" }] });
  await r.close();
});

test("names with control characters or long text are shown sanitized in errors", async () => {
  const r = await rig();
  const result = await r.call("get_track_info", { track: { name: `x${"y".repeat(200)}` } });
  assert.equal(result.structuredContent.code, "invalid_args", "over-long names fail schema validation");
  const odd = await r.call("get_track_info", { track: { name: "Missing‮track" } });
  assert.equal(odd.structuredContent.code, "not_found");
  assert.doesNotMatch(odd.content[0].text, /‮/);
  await r.close();
});
