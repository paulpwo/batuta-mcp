import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeWorld, rawForDb } from "./helpers/fake-world.js";
import { toolNameFor } from "../src/tools/catalog.js";
import { startRig } from "./helpers/tools-harness.js";
import type { Json } from "./helpers/mcp-client.js";

/**
 * Gain guard (docs/01-protocol.md section 9.4). A trip makes the call destructive; these tests run with
 * destructive:"disabled", where a trip is a visible refusal (not_supported / gain_limit) and nothing
 * reaches the script. The confirmation flow itself is covered in tools-confirm.test.ts.
 */

async function rig(world: FakeWorld, config: Json = {}) {
  return startRig({ config: { destructive: "disabled", ...config } as never, answers: world.answers(), echo: true });
}
type Rig = Awaited<ReturnType<typeof rig>>;

const writes = (r: Rig): string[] => r.seen().map((c) => c.cmd).filter((c) => !["mixer_get", "param_get", "device_get", "rack_get", "track_list", "scene_list", "song_info", "device_list"].includes(c));
const tripped = (result: Json): boolean => result.isError === true && result.structuredContent.code === "not_supported" && result.structuredContent.details.reason === "gain_limit";

const TRACK = { kind: "track", index: 0 };

test("mixer_set volume_db: a 7 dB increase trips, 5 dB and exactly 6 dB do not, decreases never do", async () => {
  const world = new FakeWorld();
  world.volumeDb["track0"] = -10;
  const r = await rig(world);
  assert.equal(tripped(await r.call("set_mixer", { track: TRACK, volume_db: -3 })), true, "+7");
  assert.deepEqual(writes(r), []);
  for (const target of [-5, -4, -30, -10, -70]) {
    assert.equal((await r.call("set_mixer", { track: TRACK, volume_db: target })).isError, false, `${target}`);
  }
  assert.equal(writes(r).length, 5);
  await r.close();
});

test("mixer_set raw volume: the target dB comes from param_get at_value", async () => {
  const world = new FakeWorld();
  world.volumeDb["track0"] = 0;
  const r = await rig(world, { gainGuard: { maxJumpDb: 3, maxMasterDb: 0 } });
  assert.equal(tripped(await r.call("set_mixer", { track: TRACK, volume: rawForDb(4) })), true, "+4 > 3");
  assert.equal((await r.call("set_mixer", { track: TRACK, volume: rawForDb(2) })).isError, false, "+2 <= 3");
  const reads = r.seen().filter((c) => c.cmd === "param_get");
  assert.equal(reads.length, 2);
  assert.deepEqual((reads[0]!.args as Json)["param"], { mixer: "volume", track: { ...TRACK, expect_name: "Drums" } });
  await r.close();
});

test("the jump limit applies to returns too; sends, pan and other fields never read the mixer", async () => {
  const world = new FakeWorld();
  world.volumeDb["return0"] = -20;
  const r = await rig(world);
  assert.equal(tripped(await r.call("set_mixer", { track: { kind: "return", index: 0 }, volume_db: -5 })), true);
  await r.call("set_mixer", { track: TRACK, sends: [{ index: 0, value: 1 }], pan: 0.5, crossfade_assign: 1 });
  assert.deepEqual(r.seen().map((c) => c.cmd).filter((c) => c !== "track_list"), ["mixer_get", "mixer_set"]);
  await r.close();
});

test("master: a target above max_master_db trips even for a small step, at the ceiling it does not", async () => {
  const world = new FakeWorld();
  world.volumeDb["master"] = -0.5;
  const r = await rig(world);
  assert.equal(tripped(await r.call("set_mixer", { track: { kind: "master" }, volume_db: 1 })), true, "+1 dB master");
  assert.equal((await r.call("set_mixer", { track: { kind: "master" }, volume_db: 0 })).isError, false, "exactly the ceiling");
  world.volumeDb["master"] = -10;
  assert.equal((await r.call("set_mixer", { track: { kind: "master" }, volume_db: -5 })).isError, false);
  // A decrease passes even while the master is above the ceiling.
  world.volumeDb["master"] = 3;
  assert.equal((await r.call("set_mixer", { track: { kind: "master" }, volume_db: 2 })).isError, false);
  // The ceiling is configurable.
  const high = await rig(new FakeWorld(), { gainGuard: { maxJumpDb: 60, maxMasterDb: 3 } });
  assert.equal((await high.call("set_mixer", { track: { kind: "master" }, volume_db: 2.5 })).isError, false);
  assert.equal(tripped(await high.call("set_mixer", { track: { kind: "master" }, volume_db: 3.5 })), true);
  await r.close();
  await high.close();
});

test("a dB value that cannot be read trips: current display, raw target, -inf as the starting point", async () => {
  const unreadable = new FakeWorld();
  unreadable.volumeDb["track0"] = "no number here";
  const a = await rig(unreadable);
  assert.equal(tripped(await a.call("set_mixer", { track: TRACK, volume_db: -30 })), true, "unreadable current");
  const silent = new FakeWorld();
  silent.volumeDb["track0"] = "-inf dB";
  const b = await rig(silent);
  assert.equal(tripped(await b.call("set_mixer", { track: TRACK, volume_db: -20 })), true, "raising from -inf is an unbounded jump");
  assert.equal((await b.call("set_mixer", { track: TRACK, pan: 0.1 })).isError, false);
  await a.close();
  await b.close();
});

test("param_set on the master volume or any track volume ({mixer:'volume'}) is guarded like mixer_set", async () => {
  const world = new FakeWorld();
  world.volumeDb["master"] = 0;
  world.volumeDb["track1"] = 0;
  const r = await rig(world);
  assert.equal(tripped(await r.call("set_device_parameter", { param: { mixer: "volume", track: { kind: "master" } }, value: rawForDb(2) })), true, "master +2 above the ceiling");
  assert.equal((await r.call("set_device_parameter", { param: { mixer: "volume", track: { kind: "track", index: 1 } }, value: rawForDb(2) })).isError, false, "track +2 is below the jump limit");
  assert.equal(tripped(await r.call("set_device_parameter", { param: { mixer: "volume", track: { kind: "track", index: 1 } }, value: rawForDb(8) })), true);
  assert.equal((await r.call("set_device_parameter", { param: { mixer: "pan", track: { kind: "master" } }, value: 0.2 })).isError, false);
  await r.close();
});

function utilityWorld(): FakeWorld {
  const world = new FakeWorld();
  world.tracks = [{ name: "Bass", devices: [{ name: "Utility", params: [
    { name: "Gain", value: 0.5, display: "0.0 dB" },
    { name: "Mid/Side", value: 0, display: "off" },
    { name: "Output Level", value: 0.5, display: "-3.0 dB" },
    { name: "Frequency", value: 0.5, display: "-2.0 dB" },
    { name: "Level", value: 0.5, display: "50 %" },
  ] }] }];
  world.displayAt = (param, value) => (value > 0.9 ? "+8.0 dB" : value > 0.6 ? "+5.0 dB" : value > 0.3 ? param.display : "garbage");
  return world;
}
const UTILITY = { track: { kind: "track", index: 0 }, path: [0] };

test("param_set on dB parameters named gain/volume/level/output/makeup: the jump limit applies", async () => {
  const r = await rig(utilityWorld());
  assert.equal(tripped(await r.call("set_device_parameter", { param: { device: UTILITY, index: 0 }, value: 0.95 })), true, "Gain +8 dB");
  assert.equal((await r.call("set_device_parameter", { param: { device: UTILITY, index: 0 }, value: 0.7 })).isError, false, "Gain +5 dB");
  assert.equal(tripped(await r.call("set_device_parameter", { param: { device: UTILITY, index: 2 }, value: 0.95 })), true, "Output Level from -3 to +8 dB");
  assert.equal(tripped(await r.call("set_device_parameter", { param: { device: UTILITY, index: 0 }, value: 0.1 })), true, "the target display cannot be read");
  await r.close();
});

test("param_set ignores parameters whose name does not match or whose display is not in dB", async () => {
  const r = await rig(utilityWorld());
  for (const index of [1, 3, 4]) {
    assert.equal((await r.call("set_device_parameter", { param: { device: UTILITY, index }, value: 0.95 })).isError, false, `index ${index}`);
  }
  assert.equal(r.seen().filter((c) => c.cmd === "param_get" && "at_value" in (c.args as Json)).length, 0, "no at_value reads for unguarded parameters");
  await r.close();
});

test("param_set items form: one device_get, at_value reads only for matching dB parameters", async () => {
  const r = await rig(utilityWorld());
  const ok = await r.call("set_device_parameter", { device: UTILITY, items: [{ index: 3, value: 0.95 }, { index: 1, value: 1 }, { index: 0, value: 0.7 }] });
  assert.equal(ok.isError, false);
  assert.equal(r.seen().filter((c) => c.cmd === "device_get").length, 1);
  assert.equal(r.seen().filter((c) => c.cmd === "param_get").length, 1, "only the Gain item needs an at_value read");
  const bad = await r.call("set_device_parameter", { device: UTILITY, items: [{ index: 0, value: 0.7 }, { name: "Output Level", value: 0.95 }] });
  assert.equal(tripped(bad), true);
  assert.equal(writes(r).filter((c) => c === "param_set").length, 1);
  await r.close();
});

function rackWorld(): FakeWorld {
  const world = new FakeWorld();
  world.tracks = [{ name: "Bass", devices: [{ name: "Rack", chains: [
    { name: "Low", devices: [], volumeDb: -10 },
    { name: "Broken", devices: [], volumeDb: null, volumeDisplay: "?" },
    { name: "Silent", devices: [], volumeDb: null, volumeDisplay: "-inf dB" },
  ] }] }];
  return world;
}
const RACK = { track: { kind: "track", index: 0 }, path: [0] };

test("chain_set: a raw volume always trips, volume_db uses the chain's current dB", async () => {
  const r = await rig(rackWorld());
  assert.equal(tripped(await r.call("set_chain_properties", { device: RACK, chain: { kind: "chain", index: 0 }, volume: 0.1 })), true, "raw volume, even a decrease");
  assert.equal(tripped(await r.call("set_chain_properties", { device: RACK, chain: { kind: "chain", index: 0 }, volume_db: -2 })), true, "+8 dB");
  assert.equal((await r.call("set_chain_properties", { device: RACK, chain: { kind: "chain", index: 0 }, volume_db: -5 })).isError, false, "+5 dB");
  assert.equal((await r.call("set_chain_properties", { device: RACK, chain: { kind: "chain", index: 0 }, volume_db: -40, pan: 0.2 })).isError, false, "decrease");
  assert.equal(tripped(await r.call("set_chain_properties", { device: RACK, chain: { kind: "chain", index: 1 }, volume_db: -60 })), true, "current unreadable");
  assert.equal(tripped(await r.call("set_chain_properties", { device: RACK, chain: { kind: "chain", index: 2 }, volume_db: -30 })), true, "raising from -inf");
  assert.equal((await r.call("set_chain_properties", { device: RACK, chain: { kind: "chain", index: 0 }, mute: true })).isError, false);
  await r.close();
});

test("batch: each op is checked against the state the earlier ops leave, and the tripping op is named", async () => {
  const world = new FakeWorld();
  world.volumeDb["track0"] = -10;
  const r = await rig(world);
  const down_up = await r.call("batch", { ops: [
    { cmd: "set_mixer", args: { track: TRACK, volume_db: -30 } },
    { cmd: "set_mixer", args: { track: TRACK, volume_db: -10 } },
  ] });
  assert.equal(tripped(down_up), true, "-30 then -10 is +20 relative to the first op");
  assert.equal(down_up.structuredContent.details.op, 1);
  assert.deepEqual(writes(r), []);
  const steps = await r.call("batch", { ops: [
    { cmd: "set_mixer", args: { track: TRACK, volume_db: -8 } },
    { cmd: "set_mixer", args: { track: TRACK, volume_db: -4 } },
  ] });
  assert.equal(steps.isError, false, "-10 -> -8 -> -4 is +6 in total, within the limit");
  assert.deepEqual(writes(r), ["batch"]);
  await r.close();
});

test("the trip message says why", async () => {
  const world = new FakeWorld();
  world.volumeDb["track0"] = -10;
  const r = await rig(world);
  const result = await r.call("set_mixer", { track: TRACK, volume_db: -2.5 });
  assert.match(result.structuredContent.message, /7\.5 dB/);
  assert.match(result.structuredContent.message, /6\.0 dB/);
  assert.ok(Array.isArray(result.structuredContent.details.trips));
  await r.close();
});

test("makeup, volume and other gain-like names are guarded; the master at or above the ceiling may stay where it is", async () => {
  const world = new FakeWorld();
  world.tracks = [{ name: "Bass", devices: [{ name: "Compressor", params: [
    { name: "Makeup", value: 0.5, display: "0.0 dB" },
    { name: "Track Volume", value: 0.5, display: "0.0 dB" },
    { name: "Threshold", value: 0.5, display: "-10.0 dB" },
  ] }] }];
  world.displayAt = () => "+8.0 dB";
  world.volumeDb["master"] = 3;
  const r = await rig(world);
  const device = { track: { kind: "track", index: 0 }, path: [0] };
  assert.equal(tripped(await r.call("set_device_parameter", { param: { device, index: 0 }, value: 0.9 })), true, "Makeup");
  assert.equal(tripped(await r.call("set_device_parameter", { param: { device, index: 1 }, value: 0.9 })), true, "Track Volume");
  assert.equal((await r.call("set_device_parameter", { param: { device, index: 2 }, value: 0.9 })).isError, false, "Threshold is not a gain");
  // Setting the master to the level it already has (above the ceiling) is not an increase.
  assert.equal((await r.call("set_mixer", { track: { kind: "master" }, volume_db: 3 })).isError, false);
  assert.equal(tripped(await r.call("set_mixer", { track: { kind: "master" }, volume_db: 3.5 })), true, "a real increase still trips");
  await r.close();
});

// ---------------------------------------------------------------- correction round T5b-fix

import { parseDb } from "../src/tools/gain.js";

/** A rig with the default policy: only a gain trip asks, so `confirmation_required` marks a trip and nothing else. */
async function askRig(world: FakeWorld, config: Json = {}) {
  return startRig({ config: config as never, answers: world.answers(), echo: true });
}
const asks = (result: Json): boolean => result.structuredContent?.confirmation_required === true;

test("MAJOR 1: a batch cannot shift an index under a checked ref: create at 0 then raise 'track 1' trips (repro)", async () => {
  const world = new FakeWorld();
  world.volumeDb["track0"] = -70;
  world.volumeDb["track1"] = 0;
  const r = await rig(world);
  const result = await r.call("batch", { ops: [
    { cmd: "create_track", args: { type: "midi", index: 0 } },
    { cmd: "set_mixer", args: { track: { kind: "track", index: 1 }, volume_db: 6 } },
  ] });
  assert.equal(tripped(result), true, JSON.stringify(result.structuredContent));
  assert.equal(result.structuredContent.details.op, 1);
  assert.match(result.structuredContent.details.trips.join(" "), /shift/);
  assert.deepEqual(writes(r), []);
  await r.close();
});

const SHIFTERS: Array<[string, Json]> = [
  ["track_create", { type: "midi" }],
  ["track_duplicate", { track: { kind: "track", index: 2 } }],
  ["track_delete", { track: { kind: "track", index: 2 } }],
  ["device_insert", { container: { track: { kind: "track", index: 0 }, path: [] }, name: "Compressor" }],
  ["device_delete", { device: { track: { kind: "track", index: 0 }, path: [0] } }],
  ["browser_load", { track: { kind: "track", index: 0 }, uri: "query:Synths#Operator" }],
  ["scene_create", {}],
  ["scene_duplicate", { scene: 0 }],
  ["scene_delete", { scene: 2 }],
];
const CHECKED: Array<[string, Json]> = [
  ["mixer_set", { track: { kind: "track", index: 0 }, volume_db: -30 }],
  ["mixer_set", { track: { kind: "track", index: 0 }, volume: 0.5 }],
  ["param_set", { param: { mixer: "volume", track: { kind: "track", index: 0 } }, value: 0.5 }],
  ["param_set", { device: { track: { kind: "track", index: 0 }, path: [0] }, items: [{ index: 0, value: 0.5 }] }],
  ["chain_set", { device: { track: { kind: "track", index: 0 }, path: [0] }, chain: { kind: "chain", index: 0 }, volume_db: -30 }],
];

test("MAJOR 1: every shifting command makes every later gain-checked op trip (even a decrease)", async () => {
  for (const [shifter, shiftArgs] of SHIFTERS) {
    for (const [checked, checkArgs] of CHECKED) {
      const r = await askRig(new FakeWorld());
      const result = await r.call("batch", { ops: [{ cmd: toolNameFor(shifter), args: shiftArgs }, { cmd: toolNameFor(checked), args: checkArgs }] });
      assert.equal(asks(result), true, `${shifter} then ${checked}: ${JSON.stringify(result.structuredContent)}`);
      assert.match(result.structuredContent.summary, /shift/, `${shifter} then ${checked}`);
      assert.deepEqual(writes(r), [], `${shifter} then ${checked}`);
      await r.close();
    }
  }
});

test("MAJOR 1: a shifter AFTER the gain op, a non-shifting op before it, or a non-gain op after the shifter do not trip", async () => {
  const world = new FakeWorld();
  world.volumeDb["track0"] = -10;
  const r = await askRig(world);
  const ok = [
    [{ cmd: "set_mixer", args: { track: { kind: "track", index: 0 }, volume_db: -20 } }, { cmd: "create_track", args: { type: "midi" } }],
    [{ cmd: "set_track_properties", args: { track: { kind: "track", index: 1 }, mute: true } }, { cmd: "set_scene_properties", args: { scene: 0, name: "x" } }, { cmd: "set_mixer", args: { track: { kind: "track", index: 0 }, volume_db: -20 } }],
    [{ cmd: "create_track", args: { type: "midi" } }, { cmd: "set_mixer", args: { track: { kind: "track", index: 0 }, pan: 0.2 } }, { cmd: "set_mixer", args: { track: { kind: "track", index: 0 }, sends: [{ index: 0, value: 0.5 }] } }],
  ];
  for (const ops of ok) assert.equal((await r.call("batch", { ops })).isError, false, JSON.stringify(ops));
  assert.equal(writes(r).length, 3);
  await r.close();
});

test("MAJOR 1: every index ref of a mutating op gets expect_name from the listing; a disagreeing model value is refused", async () => {
  const r = await askRig(new FakeWorld());
  await r.call("set_track_properties", { track: { kind: "track", index: 1 }, mute: true });
  await r.call("set_track_properties", { track: { kind: "return", index: 0 }, mute: true });
  await r.call("set_track_properties", { track: { kind: "track", index: 2, expect_name: "Pad" }, mute: true });
  await r.call("set_track_properties", { track: { kind: "master" }, mute: true });
  assert.deepEqual(r.seen().filter((c) => c.cmd === "track_set").map((c) => c.args["track"]), [
    { kind: "track", index: 1, expect_name: "Bass" }, { kind: "return", index: 0, expect_name: "A Reverb" },
    { kind: "track", index: 2, expect_name: "Pad" }, { kind: "master" },
  ]);
  const wrong = await r.call("set_track_properties", { track: { kind: "track", index: 1, expect_name: "Drums" }, mute: true });
  assert.equal(wrong.structuredContent.code, "not_found");
  assert.equal(wrong.structuredContent.details.reason, "name_mismatch");
  assert.equal(r.seen().filter((c) => c.cmd === "track_set").length, 4, "the mismatch never reaches the script");
  await r.close();
});

test("MAJOR 1: nested refs (param mixer track, clip track, device track) are filled too; reads are not", async () => {
  const world = new FakeWorld();
  world.tracks = [{ name: "Drums", devices: [{ name: "Utility", params: [{ name: "Gain", value: 0.5, display: "0.0 dB" }] }] }, { name: "Bass" }];
  const r = await askRig(world);
  await r.call("set_device_parameter", { param: { mixer: "pan", track: { kind: "track", index: 1 } }, value: 0.1 });
  await r.call("delete_clip", { clip: { kind: "session", track: { kind: "track", index: 0 }, slot: 0 } });
  await r.call("set_device_enabled", { device: { track: { kind: "track", index: 1 }, path: [0] }, enabled: false });
  const sent = r.seen().filter((c) => ["param_set", "clip_delete", "device_enable"].includes(c.cmd));
  assert.deepEqual((sent[0]!.args["param"] as Json)["track"], { kind: "track", index: 1, expect_name: "Bass" });
  assert.deepEqual(((sent[1]!.args["clip"] as Json)["track"]), { kind: "track", index: 0, expect_name: "Drums" });
  assert.deepEqual(((sent[2]!.args["device"] as Json)["track"]), { kind: "track", index: 1, expect_name: "Bass" });
  const before = r.seen().length;
  await r.call("get_track_info", { track: { kind: "track", index: 1 } });
  assert.deepEqual(r.seen().slice(before), [{ cmd: "track_get", args: { track: { kind: "track", index: 1 } } }], "a read adds no listing and no expect_name");
  await r.close();
});

test("MAJOR 1: inside a batch, refs before the first shifting op are pinned, refs after it keep only what the model gave", async () => {
  const r = await askRig(new FakeWorld());
  const result = await r.call("batch", { ops: [
    { cmd: "set_track_properties", args: { track: { kind: "track", index: 1 }, mute: true } },
    { cmd: "create_track", args: { type: "midi", index: 0 } },
    { cmd: "set_track_properties", args: { track: { kind: "track", index: 2 }, mute: true } },
    { cmd: "set_track_properties", args: { track: { kind: "track", index: 1, expect_name: "Bass" }, mute: false } },
  ] });
  assert.equal(result.isError, false);
  const ops = r.seen().find((c) => c.cmd === "batch")!.args["ops"] as Json[];
  assert.deepEqual(ops.map((op) => (op["args"] as Json)["track"] ?? null), [
    { kind: "track", index: 1, expect_name: "Bass" }, null, { kind: "track", index: 2 }, { kind: "track", index: 1, expect_name: "Bass" },
  ]);
  await r.close();
});

test("MINOR 3: stepping inside a batch is measured against the level before the call: -12, -6, 0, +6 trips at op 1", async () => {
  const world = new FakeWorld();
  world.volumeDb["track0"] = -12;
  const r = await rig(world);
  const result = await r.call("batch", { ops: [-6, 0, 6].map((db) => ({ cmd: "set_mixer", args: { track: TRACK, volume_db: db } })) });
  assert.equal(tripped(result), true);
  assert.equal(result.structuredContent.details.op, 1);
  assert.deepEqual(writes(r), []);
  // Exactly the limit in total is fine, split or not.
  const fine = await r.call("batch", { ops: [-9, -6].map((db) => ({ cmd: "set_mixer", args: { track: TRACK, volume_db: db } })) });
  assert.equal(fine.isError, false);
  // Other targets are independent.
  world.volumeDb["track1"] = -12;
  const other = await r.call("batch", { ops: [
    { cmd: "set_mixer", args: { track: TRACK, volume_db: -6 } }, { cmd: "set_mixer", args: { track: { kind: "track", index: 1 }, volume_db: -6 } },
  ] });
  assert.equal(other.isError, false);
  await r.close();
});

test("MINOR 3: stepping applies to parameters and chains inside a batch as well", async () => {
  const r = await rig(utilityWorld());
  const device = { track: { kind: "track", index: 0 }, path: [0] };
  // Gain reads 0.0 dB; at_value 0.7 shows +5 dB (ok), then 0.95 shows +8 dB (+8 from the start).
  const steps = await r.call("batch", { ops: [
    { cmd: "set_device_parameter", args: { param: { device, index: 0 }, value: 0.7 } },
    { cmd: "set_device_parameter", args: { param: { device, index: 0 }, value: 0.95 } },
  ] });
  assert.equal(tripped(steps), true);
  assert.equal(steps.structuredContent.details.op, 1);
  const chains = await rig(rackWorld());
  const split = await chains.call("batch", { ops: [-5, 0].map((db) => ({ cmd: "set_chain_properties", args: { device: RACK, chain: { kind: "chain", index: 0 }, volume_db: db } })) });
  assert.equal(tripped(split), true, "-10 -> -5 -> 0 is +10 in total");
  assert.equal(split.structuredContent.details.op, 1);
  await r.close();
  await chains.close();
});

test("M08 boundary: with a 6.5 dB limit exactly +6.5 passes (also when float rounding gives 6.500000000000001) and +6.6 trips", async () => {
  const cfg = { gainGuard: { maxJumpDb: 6.5, maxMasterDb: 0 } };
  for (const [from, ok, bad] of [[-10.1, -3.6, -3.5], [-12.3, -5.8, -5.7], [-20.3, -13.8, -13.7]] as const) {
    const world = new FakeWorld();
    world.volumeDb["track0"] = from;
    const r = await rig(world, cfg);
    assert.equal((await r.call("set_mixer", { track: TRACK, volume_db: ok })).isError, false, `${from} -> ${ok}`);
    assert.equal(tripped(await r.call("set_mixer", { track: TRACK, volume_db: bad })), true, `${from} -> ${bad}`);
    await r.close();
  }
  // The master ceiling has the same exact boundary.
  const world = new FakeWorld();
  world.volumeDb["master"] = -5;
  const r = await rig(world, { gainGuard: { maxJumpDb: 60, maxMasterDb: -1.5 } });
  assert.equal((await r.call("set_mixer", { track: { kind: "master" }, volume_db: -1.5 })).isError, false);
  assert.equal(tripped(await r.call("set_mixer", { track: { kind: "master" }, volume_db: -1.4 })), true);
  await r.close();
});

test("M13: each word of the gain name pattern guards a dB parameter on its own", async () => {
  for (const name of ["Gain", "Volume", "Level", "Output", "Makeup", "OUTPUT", "Master Output"]) {
    const world = new FakeWorld();
    world.tracks = [{ name: "Bass", devices: [{ name: "Device", params: [{ name, value: 0.5, display: "0.0 dB" }] }] }];
    world.displayAt = () => "+8.0 dB";
    const r = await rig(world);
    assert.equal(tripped(await r.call("set_device_parameter", { param: { device: UTILITY, index: 0 }, value: 0.9 })), true, name);
    await r.close();
  }
  const world = new FakeWorld();
  world.tracks = [{ name: "Bass", devices: [{ name: "Device", params: [{ name: "Threshold", value: 0.5, display: "0.0 dB" }, { name: "Put", value: 0.5, display: "0.0 dB" }] }] }];
  world.displayAt = () => "+8.0 dB";
  const r = await rig(world);
  for (const index of [0, 1]) assert.equal((await r.call("set_device_parameter", { param: { device: UTILITY, index }, value: 0.9 })).isError, false, `index ${index}`);
  await r.close();
});

test("M28: -inf is negative infinity, never a finite floor: raising from silence to -66 dB still trips", async () => {
  assert.equal(parseDb("-inf dB"), Number.NEGATIVE_INFINITY);
  assert.equal(parseDb("−Inf dB"), Number.NEGATIVE_INFINITY);
  assert.equal(parseDb("- infinity"), Number.NEGATIVE_INFINITY);
  assert.equal(parseDb("-70.0 dB"), -70);
  assert.equal(parseDb("+1,5 dB"), 1.5);
  assert.equal(parseDb("inf dB"), undefined);
  assert.equal(parseDb(undefined), undefined);
  const silent = new FakeWorld();
  silent.volumeDb["track0"] = "-inf dB";
  const r = await rig(silent);
  const result = await r.call("set_mixer", { track: TRACK, volume_db: -66 });
  assert.equal(tripped(result), true);
  assert.match(result.structuredContent.details.trips.join(" "), /-inf dB/);
  await r.close();
});

function masterWorld(): FakeWorld {
  const world = utilityWorld();
  world.masterDevices = [{ name: "Utility", params: [{ name: "Gain", value: 0.5, display: "0.0 dB" }, { name: "Mid/Side", value: 0, display: "off" }] }];
  return world;
}
const MASTER_UTILITY = { track: { kind: "master" }, path: [0] };

test("MINOR 4: the master ceiling also applies to dB gain parameters of devices on the master chain", async () => {
  const r = await rig(masterWorld());
  // +5 dB is below the jump limit but above the 0 dB ceiling.
  assert.equal(tripped(await r.call("set_device_parameter", { param: { device: MASTER_UTILITY, index: 0 }, value: 0.7 })), true, "single form");
  assert.equal(tripped(await r.call("set_device_parameter", { device: MASTER_UTILITY, items: [{ index: 0, value: 0.7 }] })), true, "items form");
  assert.equal((await r.call("set_device_parameter", { param: { device: MASTER_UTILITY, index: 0 }, value: 0.4 })).isError, false, "target at the ceiling (0.0 dB)");
  assert.equal((await r.call("set_device_parameter", { param: { device: MASTER_UTILITY, index: 1 }, value: 1 })).isError, false, "not a gain parameter");
  const ceiling = await rig(masterWorld(), { gainGuard: { maxJumpDb: 6, maxMasterDb: 6 } });
  assert.equal((await ceiling.call("set_device_parameter", { param: { device: MASTER_UTILITY, index: 0 }, value: 0.7 })).isError, false, "+5 is under a 6 dB ceiling");
  // The same +5 dB on an ordinary track is fine.
  assert.equal((await r.call("set_device_parameter", { param: { device: UTILITY, index: 0 }, value: 0.7 })).isError, false, "ordinary track");
  await r.close();
  await ceiling.close();
});

test("MINOR 4: chain_set volume_db on a rack in the master chain is held to the ceiling", async () => {
  const world = new FakeWorld();
  world.masterDevices = [{ name: "Rack", chains: [{ name: "A", devices: [], volumeDb: -3 }] }];
  const r = await rig(world);
  const rack = { track: { kind: "master" }, path: [0] };
  assert.equal(tripped(await r.call("set_chain_properties", { device: rack, chain: { kind: "chain", index: 0 }, volume_db: 1 })), true, "+4 stays under the jump limit, above the ceiling");
  assert.equal((await r.call("set_chain_properties", { device: rack, chain: { kind: "chain", index: 0 }, volume_db: 0 })).isError, false);
  await r.close();
});

test("MINOR 4: master cue_volume is converted like the master volume and held to the ceiling", async () => {
  const world = new FakeWorld();
  world.cueDb = -0.5;
  const r = await rig(world);
  const master = { kind: "master" };
  assert.equal(tripped(await r.call("set_mixer", { track: master, cue_volume: rawForDb(1) })), true, "+1 dB above the ceiling");
  assert.equal((await r.call("set_mixer", { track: master, cue_volume: rawForDb(0) })).isError, false, "exactly the ceiling");
  assert.equal((await r.call("set_mixer", { track: master, cue_volume: rawForDb(-20) })).isError, false, "decrease");
  assert.equal((await r.call("set_mixer", { track: master, crossfader: 0.5 })).isError, false, "crossfader is not a level");
  // Volume and cue in one call: both are checked and the cue reason is named.
  const both = await r.call("set_mixer", { track: master, volume_db: -3, cue_volume: rawForDb(2) });
  assert.equal(tripped(both), true);
  assert.match(both.structuredContent.details.trips.join(" "), /cue volume/);
  const jump = new FakeWorld();
  jump.cueDb = -30;
  const j = await rig(jump, { gainGuard: { maxJumpDb: 6, maxMasterDb: 6 } });
  assert.equal(tripped(await j.call("set_mixer", { track: master, cue_volume: rawForDb(-20) })), true, "+10 dB jump");
  const unreadable = new FakeWorld();
  unreadable.cueDb = "???";
  const u = await rig(unreadable);
  assert.equal(tripped(await u.call("set_mixer", { track: master, cue_volume: rawForDb(-20) })), true, "unreadable current cue level");
  await r.close();
  await j.close();
  await u.close();
});

test("a parameter name is quoted and escaped in the trip reason", async () => {
  const world = new FakeWorld();
  world.tracks = [{ name: "Bass", devices: [{ name: "Device", params: [{ name: 'Gain" (all fine) "', value: 0.5, display: "0.0 dB" }] }] }];
  world.displayAt = () => "+8.0 dB";
  const r = await rig(world);
  const result = await r.call("set_device_parameter", { param: { device: UTILITY, index: 0 }, value: 0.9 });
  assert.equal(tripped(result), true);
  assert.match(result.structuredContent.details.trips.join(" "), /parameter "Gain\\" \(all fine\) \\""/);
  await r.close();
});

test("minor: the trip message after an index shift is generic ('this change'), whatever the op", async () => {
  const r = await askRig(new FakeWorld());
  const result = await r.call("batch", { ops: [
    { cmd: "create_track", args: { type: "midi" } },
    { cmd: "set_device_parameter", args: { param: { mixer: "pan", track: { kind: "track", index: 0 } }, value: 0.2 } },
  ] });
  assert.equal(asks(result), true);
  assert.match(result.structuredContent.summary, /this change cannot be checked/);
  assert.doesNotMatch(result.structuredContent.summary, /level change/);
  await r.close();
});
