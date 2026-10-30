import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ToolError, ToolRegistry } from "../src/mcp/index.js";
import { specFor, toolNameFor } from "../src/tools/catalog.js";
import { OVERWRITE_NOTE } from "../src/tools/specs-clips.js";
import { ALIAS_SPECS } from "../src/tools/aliases.js";
import { applyCompat } from "../src/tools/compat.js";
import { compositeStep } from "../src/tools/composites.js";
import { validateMapped } from "../src/tools/index.js";
import { FakeWorld } from "./helpers/fake-world.js";
import type { FakeDevice } from "./helpers/fake-world.js";
import { registryFor, startRig } from "./helpers/tools-harness.js";
import type { Rig, RigOptions } from "./helpers/tools-harness.js";
import type { Json } from "./helpers/mcp-client.js";

/** T5c-4: browser_load targets, capture alias, rack macros, composite caps and the review follow-ups. */

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

// ---------------------------------------------------------------- A. browser_load onto returns and master

test("load_instrument_or_effect accepts returns and the master, pinned like any other track", async () => {
  const r = await startRig({ answers: new FakeWorld().answers(), echo: true });
  const ret = await r.call("load_instrument_or_effect", { track: { kind: "return", index: 0 }, uri: "u:fx" });
  assert.equal(ret.isError, false, JSON.stringify(ret.structuredContent));
  const master = await r.call("load_instrument_or_effect", { track: { kind: "master" }, uri: "u:fx" });
  assert.equal(master.isError, false, JSON.stringify(master.structuredContent));
  const named = await r.call("load_instrument_or_effect", { track: { name: "A Reverb", kind: "return" }, uri: "u:fx" });
  assert.equal(named.isError, false, JSON.stringify(named.structuredContent));
  const loads = r.seen().filter((c) => c.cmd === "browser_load").map((c) => c.args);
  assert.deepEqual(loads, [
    { track: { kind: "return", index: 0, expect_name: "A Reverb" }, uri: "u:fx" },
    { track: { kind: "master" }, uri: "u:fx" },
    { track: { kind: "return", index: 0, expect_name: "A Reverb" }, uri: "u:fx" },
  ]);
  await r.close();
});

test("load_instrument_or_effect: the compat track_index still means a regular track", async () => {
  const r = await startRig({ answers: new FakeWorld().answers(), echo: true });
  const regular = await r.call("load_instrument_or_effect", { track_index: 1, uri: "u:fx" });
  assert.equal(regular.isError, false);
  assert.deepEqual(r.seen().filter((c) => c.cmd === "browser_load").map((c) => c.args), [{ track: { kind: "track", index: 1, expect_name: "Bass" }, uri: "u:fx" }]);
  const both = await r.call("load_instrument_or_effect", { track_index: 1, track: { kind: "return", index: 0 }, uri: "u:fx" });
  assert.equal(both.isError, true, "track_index and track together are refused");
  assert.equal(r.seen().filter((c) => c.cmd === "browser_load").length, 1);
  await r.close();
});

test("the browser_load description says it loads onto a track, a return or the master", () => {
  const description = specFor("browser_load")!.description;
  assert.match(description, /regular track, a return track or the master/);
  assert.doesNotMatch(description, /onto a regular track\./);
});

// ---------------------------------------------------------------- B. capture_session_to_arrangement

test("capture_session_to_arrangement is a thin alias of commit_scene_to_arrangement and says it does not record in real time", async () => {
  const a = await startRig({ answers: new FakeWorld().answers(), echo: true });
  const viaAlias = await a.call("capture_session_to_arrangement", { scene_index: 1, destination_time: 16 });
  assert.equal(viaAlias.isError, false, JSON.stringify(viaAlias.structuredContent));
  const b = await startRig({ answers: new FakeWorld().answers(), echo: true });
  await b.call("commit_scene_to_arrangement", { scene: 1, time: 16 });
  assert.deepEqual(a.seen(), b.seen());
  assert.deepEqual(a.seen().filter((c) => c.cmd === "arrangement_commit_scene").map((c) => c.args), [{ scene: 1, time: 16 }]);
  const description = a.registry.get("capture_session_to_arrangement")!.tool.description;
  assert.match(description, /does not record in real time/);
  assert.match(description, /one undo step/);
  const overwrite = await a.call("capture_session_to_arrangement", { scene_index: 0, destination_time: 0, allow_overwrite: true });
  assert.equal(overwrite.isError, false);
  assert.deepEqual(a.seen().filter((c) => c.cmd === "arrangement_commit_scene").at(-1)?.args, { scene: 0, time: 0, allow_overwrite: true });
  for (const args of [{ scene_index: 0 }, { destination_time: 0 }, { scene_index: 0, destination_time: 0, user_prompt: "x" }, { scene_index: -1, destination_time: 0 }]) {
    assert.equal((await a.call("capture_session_to_arrangement", args)).isError, true, JSON.stringify(args));
  }
  await Promise.all([a.close(), b.close()]);
});

test("capture_session_to_arrangement asks like the broad tool when it would overwrite, and is hidden with it", async () => {
  const d = await startRig({ answers: new FakeWorld().answers(), echo: true, config: { confirm: "destructive" } });
  const ask = await d.call("capture_session_to_arrangement", { scene_index: 0, destination_time: 0, allow_overwrite: true });
  assert.equal(ask.structuredContent.confirmation_required, true);
  assert.deepEqual(d.seen().filter((c) => c.cmd === "arrangement_commit_scene"), []);
  await d.close();
  const off = registryFor({ destructive: "disabled" });
  assert.ok(off.get("capture_session_to_arrangement"), "commit_scene is only conditionally destructive, so it stays");
});

test("docs/03 says capture_session_to_arrangement copies without playing", () => {
  const doc = fs.readFileSync(path.join(ROOT, "docs", "03-tool-names.md"), "utf8");
  assert.match(doc, /capture_session_to_arrangement[^\n]*does not record in real time/);
});

// ---------------------------------------------------------------- alias parity (annotations)

test("every alias carries exactly the annotations of the broad tool it runs", () => {
  const registry = registryFor({ allowAudioImport: true, sampleRoots: ["/tmp/x"] });
  for (const alias of ALIAS_SPECS) {
    const broad = registry.get(toolNameFor(alias.command));
    assert.ok(broad, alias.name);
    assert.deepEqual(registry.get(alias.name)?.tool.annotations, broad.tool.annotations, alias.name);
  }
  assert.equal(registry.get("clear_notes_from_clip")?.tool.annotations?.destructiveHint, true);
  assert.equal(registry.get("set_tempo")?.tool.annotations?.destructiveHint, false);
});

// ---------------------------------------------------------------- validateMapped and composite steps

test("validateMapped refuses arguments the target schema rejects and lets valid ones through", () => {
  const registry = registryFor();
  const target = specFor("song_set")!;
  assert.throws(() => validateMapped(registry, target, { tempo: 5000 }), (error: unknown) => error instanceof ToolError && error.code === "invalid_args");
  assert.throws(() => validateMapped(registry, target, { tempo: 100, extra: 1 }), (error: unknown) => error instanceof ToolError && error.code === "invalid_args");
  assert.doesNotThrow(() => validateMapped(registry, target, { tempo: 100 }));
  assert.doesNotThrow(() => validateMapped(new ToolRegistry(), target, { tempo: 5000 }), "a target that is not registered has no schema to check");
});

test("a composite step that needs a confirmation fails instead of going on", async () => {
  const pending = { run: async () => ({ content: [], structuredContent: { confirmation_required: true, confirm_id: "x" } }) };
  const declined = { run: async () => ({ content: [], structuredContent: { cancelled: true } }) };
  const fine = { run: async () => ({ content: [], structuredContent: { items: [1] } }) };
  const context = {} as never;
  for (const executor of [pending, declined]) {
    await assert.rejects(compositeStep(executor as never, "track_get", {}, context), (error: unknown) => error instanceof ToolError && error.code === "confirmation_failed" && error.details?.["reason"] === "inner_confirmation" && error.details?.["command"] === "track_get");
  }
  assert.deepEqual(await compositeStep(fine as never, "track_get", {}, context), { items: [1] });
  await assert.rejects(compositeStep(fine as never, "no_such_command", {}, context), (error: unknown) => error instanceof ToolError && error.code === "internal_error");
});

// ---------------------------------------------------------------- compat_incomplete

test("compat_incomplete names only the missing arguments", () => {
  const fire = specFor("slot_fire")!;
  try {
    applyCompat(fire, { track_index: 0 });
    assert.fail("should throw");
  } catch (error) {
    assert.ok(error instanceof ToolError);
    assert.equal(error.details?.["reason"], "compat_incomplete");
    assert.deepEqual(error.details?.["missing"], ["clip_index"]);
    assert.match(error.message, /clip_index/);
    assert.doesNotMatch(error.message, /track_index/);
  }
  const dup = specFor("arrangement_duplicate")!;
  try {
    applyCompat(dup, { track_index: 0 });
    assert.fail("should throw");
  } catch (error) {
    assert.ok(error instanceof ToolError);
    assert.deepEqual(error.details?.["missing"], ["clip_index", "destination_time"]);
    assert.match(error.message, /clip_index/);
    assert.match(error.message, /destination_time/);
    assert.doesNotMatch(error.message, /track_index/);
  }
  try {
    applyCompat(dup, { clip_index: 0, track_index: 0, destination_time: 4 }, 3);
  } catch {
    assert.fail("complete form must pass");
  }
  try {
    applyCompat(fire, { clip_index: 0 }, 2);
    assert.fail("should throw");
  } catch (error) {
    assert.ok(error instanceof ToolError);
    assert.equal(error.details?.["op"], 2);
    assert.deepEqual(error.details?.["missing"], ["track_index"]);
  }
});

// ---------------------------------------------------------------- C. get_macros / set_macro

const MACRO_COUNT = 8;
function macroDevice(names?: string[], display = (n: number) => `${n * 10}`): FakeDevice {
  const params = [{ name: "Device On", value: 1, display: "On", min: 0, max: 1 }];
  for (let k = 1; k <= 16; k += 1) params.push({ name: names?.[k - 1] ?? `Macro ${k}`, value: k * 10, display: display(k), min: 0, max: 127 });
  return { name: "Rack", params, chains: [] };
}

function macroRig(devices: FakeDevice[], options: { count?: number | null; world?: FakeWorld; config?: Json } = {}): Promise<Rig> {
  const w = options.world ?? new FakeWorld();
  w.tracks[1]!.devices = devices;
  const answers: NonNullable<RigOptions["answers"]> = {
    ...w.answers(),
    rack_get: (args, _q, reply) => {
      const dev = args["device"] as Json;
      const device = w.locate(dev["track"] as Json, dev["path"] as unknown[], false) as FakeDevice | undefined;
      if (device?.chains === undefined) { reply.fail("invalid_args", "this device is not a rack", { reason: "not_a_rack" }); return undefined; }
      return { chains: [], return_chains: [], macro_count: options.count === undefined ? MACRO_COUNT : options.count, variation_count: 0, selected_variation: 0, can_have_drum_pads: false };
    },
  };
  return startRig({ answers, echo: true, ...(options.config === undefined ? {} : { config: options.config as never }) });
}
const plainDevice: FakeDevice = { name: "EQ Eight", params: [{ name: "Device On", value: 1, display: "On" }] };

test("get_macros lists the rack's macros with 1-based macro_index, read-only", async () => {
  const r = await macroRig([plainDevice, macroDevice()]);
  const out = await r.call("get_macros", { track_index: 1, device_index: 1 });
  assert.equal(out.isError, false, JSON.stringify(out.structuredContent));
  const s = out.structuredContent;
  assert.equal(s.macro_count, MACRO_COUNT);
  assert.equal(s.macros.length, MACRO_COUNT);
  assert.deepEqual(s.macros[0], { macro_index: 1, parameter_index: 1, name: "Macro 1", value: 10, min: 0, max: 127, display: "10" });
  assert.equal(s.macros[7].macro_index, 8);
  assert.equal(s.macros[7].parameter_index, 8);
  assert.deepEqual(r.seen().map((c) => c.cmd).filter((c) => c !== "track_list"), ["rack_get", "device_get"]);
  assert.equal(r.registry.get("get_macros")?.tool.annotations?.readOnlyHint, true);
  await r.close();
});

test("get_macros follows macro_count, keeps renamed macros, and works on returns and the master through track", async () => {
  const r = await macroRig([macroDevice(["Cutoff", "Reso"])], { count: 4 });
  const four = await r.call("get_macros", { track_index: 1, device_index: 0 });
  assert.deepEqual(four.structuredContent.macros.map((m: Json) => m.name), ["Cutoff", "Reso", "Macro 3", "Macro 4"]);
  const w = new FakeWorld();
  w.returns[0]!.devices = [macroDevice()];
  w.masterDevices = [macroDevice()];
  const r2 = await macroRig([], { world: w });
  const ret = await r2.call("get_macros", { track: { kind: "return", index: 0 }, device_index: 0 });
  assert.equal(ret.isError, false, JSON.stringify(ret.structuredContent));
  assert.equal(ret.structuredContent.macros.length, MACRO_COUNT);
  const master = await r2.call("get_macros", { track: { kind: "master" }, device_index: 0 });
  assert.equal(master.isError, false, JSON.stringify(master.structuredContent));
  assert.deepEqual(r2.seen().filter((c) => c.cmd === "rack_get").map((c) => c.args["device"]), [
    { track: { kind: "return", index: 0 }, path: [0] },
    { track: { kind: "master" }, path: [0] },
  ]);
  await Promise.all([r.close(), r2.close()]);
});

test("get_macros without a macro_count falls back to the leading default-named Macro parameters", async () => {
  const r = await macroRig([macroDevice()], { count: null });
  const out = await r.call("get_macros", { track_index: 1, device_index: 0 });
  assert.equal(out.isError, false, JSON.stringify(out.structuredContent));
  assert.equal(out.structuredContent.macros.length, 16);
  await r.close();
});

test("get_macros never reports more than the 16 macros Live has", async () => {
  const r = await macroRig([macroDevice()], { count: 40 });
  const out = await r.call("get_macros", { track_index: 1, device_index: 0 });
  assert.equal(out.isError, false, JSON.stringify(out.structuredContent));
  assert.equal(out.structuredContent.macro_count, 16);
  assert.equal(out.structuredContent.macros.length, 16);
  assert.equal(out.structuredContent.macros[15].macro_index, 16);
  await r.close();
});

test("get_macros and set_macro fail clearly on a device that is not a rack, and refuse a surprising layout", async () => {
  const r = await macroRig([plainDevice, macroDevice(["Macro 1", "Macro 3"])]);
  for (const [tool, extra] of [["get_macros", {}], ["set_macro", { macro_index: 1, value: 5 }]] as Array<[string, Json]>) {
    const out = await r.call(tool, { track_index: 1, device_index: 0, ...extra });
    assert.equal(out.isError, true, tool);
    assert.equal(out.structuredContent.details.reason, "not_a_rack", tool);
    assert.match(out.structuredContent.message, /not a rack/, tool);
    const odd = await r.call(tool, { track_index: 1, device_index: 1, ...extra });
    assert.equal(odd.isError, true, tool);
    assert.equal(odd.structuredContent.details.reason, "macro_layout", tool);
  }
  assert.deepEqual(r.seen().filter((c) => c.cmd === "param_set"), []);
  await r.close();
});

test("get_macros and set_macro validate the track and device selection", async () => {
  const r = await macroRig([macroDevice()]);
  const cases: Array<[string, Json]> = [
    ["get_macros", { device_index: 0 }],
    ["get_macros", { track_index: 1, track: { kind: "master" }, device_index: 0 }],
    ["get_macros", { track_index: 1 }],
    ["get_macros", { track_index: 1, device_index: 0, user_prompt: "x" }],
    ["set_macro", { track_index: 1, device_index: 0, value: 5 }],
    ["set_macro", { track_index: 1, device_index: 0, macro_index: 0, value: 5 }],
    ["set_macro", { track_index: 1, device_index: 0, macro_index: 17, value: 5 }],
    ["set_macro", { track_index: 1, device_index: 0, macro_index: 1 }],
    ["set_macro", { track_index: 1, device_index: 0, macro_index: 1, value: 5, user_prompt: "x" }],
  ];
  for (const [tool, args] of cases) assert.equal((await r.call(tool, args)).isError, true, `${tool} ${JSON.stringify(args)}`);
  assert.deepEqual(r.seen(), [], "nothing reaches the script");
  await r.close();
});

test("set_macro sets the macro's parameter through param_set with the resolved, pinned device", async () => {
  const r = await macroRig([plainDevice, macroDevice()]);
  const out = await r.call("set_macro", { track_index: 1, device_index: 1, macro_index: 3, value: 64 });
  assert.equal(out.isError, false, JSON.stringify(out.structuredContent));
  assert.deepEqual(r.seen().filter((c) => c.cmd === "param_set").map((c) => c.args), [{ param: { device: { track: { kind: "track", index: 1, expect_name: "Bass" }, path: [1] }, index: 3 }, value: 64 }]);
  assert.equal(out.structuredContent.macro_index, 3);
  assert.equal(out.structuredContent.name, "Macro 3");
  const high = await r.call("set_macro", { track_index: 1, device_index: 1, macro_index: 9, value: 1 });
  assert.equal(high.isError, true, "only macro_count macros exist");
  assert.equal(high.structuredContent.details.reason, "macro_index");
  const range = await r.call("set_macro", { track_index: 1, device_index: 1, macro_index: 1, value: 200 });
  assert.equal(range.isError, true);
  assert.equal(range.structuredContent.code, "out_of_range");
  assert.equal(r.seen().filter((c) => c.cmd === "param_set").length, 1);
  assert.deepEqual(r.registry.get("set_macro")?.tool.annotations, r.registry.get("set_device_parameter")?.tool.annotations);
  await r.close();
});

test("set_macro keeps every guard: a dB macro that jumps up asks for confirmation, a decrease does not", async () => {
  const gainRig = async (): Promise<Rig> => {
    const device = macroDevice(["Output Gain"], (n) => (n === 1 ? "-20.0 dB" : String(n)));
    const first = device.params![1]!;
    Object.assign(first, { value: -20, min: -70, max: 6 });
    return macroRig([device]);
  };
  const r = await gainRig();
  const trip = await r.call("set_macro", { track_index: 1, device_index: 0, macro_index: 1, value: 0 });
  assert.equal(trip.structuredContent.confirmation_required, true, JSON.stringify(trip.structuredContent));
  assert.deepEqual(r.seen().filter((c) => c.cmd === "param_set"), []);
  const done = await r.call("batuta_confirm", { confirm_id: trip.structuredContent.confirm_id, summary: trip.structuredContent.summary });
  assert.equal(done.isError, false);
  assert.equal(r.seen().filter((c) => c.cmd === "param_set").length, 1);
  const down = await r.call("set_macro", { track_index: 1, device_index: 0, macro_index: 1, value: -30 });
  assert.equal(down.isError, false);
  assert.equal(r.seen().filter((c) => c.cmd === "param_set").length, 2);
  await r.close();
  const off = await macroRig([macroDevice(["Output Gain"], () => "-20.0 dB")], { config: { destructive: "disabled" } });
  const refused = await off.call("set_macro", { track_index: 1, device_index: 0, macro_index: 1, value: 0 });
  assert.equal(refused.isError, true);
  assert.equal(refused.structuredContent.details.reason, "gain_limit");
  await off.close();
});

// ---------------------------------------------------------------- D. load_drum_kit looks in instruments first

function item(name: string, uri: string, extra: Json = {}): Json {
  return { name, uri, is_folder: false, is_loadable: true, is_device: false, blocked: null, ...extra };
}
const KITS: Record<string, Json[]> = {
  "drums|Acoustic": [item("Kit A", "u:kitA")],
  "drums|": [item("Drum Rack", "u:drums-rack", { is_device: true }), item("Acoustic", "u:acoustic", { is_folder: true, is_loadable: false })],
  "instruments|": [item("Drum Rack", "u:rack", { is_device: true }), item("Operator", "u:op", { is_device: true })],
};
function kitRig(table: Record<string, Json[]>, searchable: Record<string, Json[]> = {}): Promise<Rig> {
  return startRig({
    answers: {
      ...new FakeWorld().answers(),
      browser_list: (args, _q, reply) => {
        const key = `${String(args["category"])}|${((args["path"] as string[] | undefined) ?? []).join("/")}`;
        const items = Object.entries(table).find(([k]) => k === key)?.[1];
        if (items === undefined) { reply.fail("not_found", "browser item not found", { reason: "path_not_found" }); return undefined; }
        return { items, total: items.length, total_capped: false, next_offset: null };
      },
      browser_search: (args) => ({ items: Object.entries(searchable).find(([k]) => k === args["category"])?.[1] ?? [], truncated: false }),
      browser_load: (args) => ({ loaded: { name: "x", uri: args["uri"] }, verified: true }),
    },
    echo: true,
  });
}
const loaded = (r: Rig): unknown[] => r.seen().filter((c) => c.cmd === "browser_load").map((c) => c.args["uri"]);

test("load_drum_kit without rack_uri loads instruments/Drum Rack, then the kit", async () => {
  const r = await kitRig(KITS);
  const out = await r.call("load_drum_kit", { track_index: 0, kit_path: "drums/Acoustic" });
  assert.equal(out.isError, false, JSON.stringify(out.structuredContent));
  assert.deepEqual(loaded(r), ["u:rack", "u:kitA"]);
  assert.deepEqual(out.structuredContent.rack, { name: "Drum Rack", uri: "u:rack" });
  assert.match(r.registry.get("load_drum_kit")!.tool.description, /instruments/);
  assert.equal(r.registry.get("load_drum_kit")!.tool.inputSchema.required?.includes("rack_uri"), false);
  await r.close();
});

test("load_drum_kit falls back to drums when the rack is not in instruments, for paths and for names", async () => {
  const noInstrumentRack = { ...KITS, "instruments|": [item("Operator", "u:op", { is_device: true })] };
  const byPath = await kitRig(noInstrumentRack);
  assert.equal((await byPath.call("load_drum_kit", { track_index: 0, kit_path: "drums/Acoustic" })).isError, false);
  assert.deepEqual(loaded(byPath), ["u:drums-rack", "u:kitA"]);
  const blocked = await kitRig({ ...KITS, "instruments|": [item("Drum Rack", "u:locked", { blocked: "user_content" })] });
  assert.equal((await blocked.call("load_drum_kit", { track_index: 0, rack_uri: "instruments/Drum Rack", kit_path: "drums/Acoustic" })).isError, false);
  assert.deepEqual(loaded(blocked), ["u:drums-rack", "u:kitA"]);
  const byName = await kitRig(KITS, { instruments: [], drums: [item("Drum Rack", "u:found-in-drums")] });
  assert.equal((await byName.call("load_drum_kit", { track_index: 0, rack_uri: "Drum Rack", kit_path: "drums/Acoustic" })).isError, false);
  assert.deepEqual(loaded(byName), ["u:found-in-drums", "u:kitA"]);
  await Promise.all([byPath.close(), blocked.close(), byName.close()]);
});

test("load_drum_kit searches instruments before drums for a bare rack name, and honors an explicit drums path", async () => {
  const search = await kitRig(KITS, { instruments: [item("Drum Rack", "u:search-instruments")], drums: [item("Drum Rack", "u:search-drums")] });
  await search.call("load_drum_kit", { track_index: 0, rack_uri: "drum rack", kit_path: "drums/Acoustic" });
  assert.deepEqual(search.seen().filter((c) => c.cmd === "browser_search").map((c) => c.args["category"]), ["instruments"]);
  assert.deepEqual(loaded(search), ["u:search-instruments", "u:kitA"]);
  const explicit = await kitRig(KITS);
  await explicit.call("load_drum_kit", { track_index: 0, rack_uri: "drums/Drum Rack", kit_path: "drums/Acoustic" });
  assert.deepEqual(loaded(explicit), ["u:drums-rack", "u:kitA"]);
  const none = await kitRig({ ...KITS, "instruments|": [], "drums|": [] });
  const out = await none.call("load_drum_kit", { track_index: 0, kit_path: "drums/Acoustic" });
  assert.equal(out.isError, true);
  assert.equal(out.structuredContent.code, "not_found");
  assert.deepEqual(loaded(none), []);
  await Promise.all([search.close(), explicit.close(), none.close()]);
});

// ---------------------------------------------------------------- D. create_locator takes the nearest cue

test("create_locator renames the nearest cue point inside the window, whatever the listing order", async () => {
  for (const cues of [[{ name: "A", time: 16 }, { name: "B", time: 16.0004 }], [{ name: "B", time: 16.0004 }, { name: "A", time: 16 }]]) {
    const w = new FakeWorld();
    const r = await startRig({ answers: { ...w.answers(), cue_list: () => ({ items: cues.map((c, index) => ({ index, ...c })), total: 2, next_offset: null }) }, echo: true });
    const out = await r.call("create_locator", { name: "X", time: 16.0005 });
    assert.equal(out.structuredContent.action, "renamed");
    const wanted = cues.findIndex((c) => c.name === "B");
    assert.deepEqual(r.seen().filter((c) => c.cmd === "cue_set").map((c) => c.args), [{ index: wanted, name: "X" }]);
    await r.close();
  }
});

// ---------------------------------------------------------------- D. get_session_snapshot caps

interface SnapshotShape { tracks: number; devices: number; params: number; clips: number; notes: number; paramPad?: number; deviceNamePad?: number }
function snapshotRig(shape: SnapshotShape, log: Array<{ cmd: string; args: Json }>): Promise<Rig> {
  const w = new FakeWorld();
  w.tracks = Array.from({ length: shape.tracks }, (_, i) => ({ name: `T${i}` }));
  const pad = "x".repeat(shape.paramPad ?? 0);
  const note = (id: number): Json => ({ pitch: 36 + (id % 40), start_time: id, duration: 0.5, velocity: 100, mute: false });
  const record = (cmd: string, args: Json): void => { log.push({ cmd, args }); };
  return startRig({
    answers: {
      ...w.answers(),
      track_get: (args) => {
        record("track_get", args);
        return {
          devices: Array.from({ length: shape.devices }, (_, d) => ({ path: [d], name: `D${d}${"n".repeat(shape.deviceNamePad ?? 0)}`, class_name: "Eq8", type: "audio_effect", is_active: true, parameter_count: shape.params })),
          slots: Array.from({ length: shape.clips }, (_, s) => ({ slot: s, has_clip: true, is_playing: false, clip: { name: `c${s}`, is_midi: true, is_audio: false, length: 4 } })),
        };
      },
      device_get: (args) => {
        record("device_get", args);
        const count = Math.min(shape.params, args["limit"] as number);
        return { parameters: Array.from({ length: count }, (_, i) => ({ index: i, name: `P${i}`, value: 0.5, min: 0, max: 1, display: `${i}${pad}` })), total: shape.params, next_offset: null };
      },
      notes_get: (args) => {
        record("notes_get", args);
        const count = Math.min(shape.notes, args["limit"] as number);
        return { items: Array.from({ length: count }, (_, i) => note(i)), total: shape.notes, next_offset: null };
      },
      arrangement_clips: (args) => { record("arrangement_clips", args); return { items: [{ index: 0, name: "Arr", start_time: 0, end_time: 8, length: 8 }], total: 1, next_offset: null }; },
    },
    echo: true,
  });
}
const INNER = new Set(["track_get", "device_get", "notes_get", "arrangement_clips"]);

test("get_session_snapshot defaults: 64 tracks", async () => {
  const log: Array<{ cmd: string; args: Json }> = [];
  const r = await snapshotRig({ tracks: 70, devices: 0, params: 0, clips: 0, notes: 0 }, log);
  const out = await r.call("get_session_snapshot");
  assert.equal(out.isError, false, JSON.stringify(out.structuredContent).slice(0, 300));
  const s = out.structuredContent;
  assert.equal(s.tracks.length, 64);
  assert.equal(s.tracks_total, 70);
  assert.equal(s.truncated, true);
  assert.deepEqual(s.limits, { max_tracks: 64, max_notes_per_clip: 200, max_params_per_device: 64 });
  await r.close();
});

test("get_session_snapshot defaults: 200 notes per clip and 64 parameters per device, flagged on the track", async () => {
  const log: Array<{ cmd: string; args: Json }> = [];
  const r = await snapshotRig({ tracks: 3, devices: 1, params: 100, clips: 1, notes: 300 }, log);
  const out = await r.call("get_session_snapshot");
  assert.equal(out.isError, false, JSON.stringify(out.structuredContent).slice(0, 300));
  const s = out.structuredContent;
  assert.equal(log.find((c) => c.cmd === "notes_get")?.args["limit"], 200);
  assert.equal(log.find((c) => c.cmd === "device_get")?.args["limit"], 64);
  assert.equal(s.tracks[0].devices[0].parameters.length, 64);
  assert.equal(s.tracks[0].clips[0].notes.length, 200);
  assert.equal(s.tracks[0].params_truncated, true);
  assert.equal(s.tracks[0].notes_truncated, true);
  assert.equal(s.tracks[0].arrangement_truncated, false);
  assert.equal(s.truncated, true);
  await r.close();
});

test("get_session_snapshot makes at most 600 inner calls, checks before each one and flags what it skipped on the track", async () => {
  const log: Array<{ cmd: string; args: Json }> = [];
  // 1 track_get + 3 device_get + 1 notes_get + 1 arrangement_clips = 6 inner calls per track.
  const r = await snapshotRig({ tracks: 128, devices: 3, params: 2, clips: 1, notes: 2 }, log);
  const out = await r.call("get_session_snapshot", { max_tracks: 128 });
  assert.equal(out.isError, false, JSON.stringify(out.structuredContent).slice(0, 300));
  assert.equal(log.filter((c) => INNER.has(c.cmd)).length, 600);
  const s = out.structuredContent;
  assert.equal(s.truncated, true);
  assert.equal(s.tracks.length, 100);
  assert.equal(s.tracks_total, 128);
  assert.equal(s.tracks[99].params_truncated, false);
  const odd = await snapshotRig({ tracks: 128, devices: 3, params: 2, clips: 1, notes: 2 }, []);
  const cut = (await odd.call("get_session_snapshot", { max_tracks: 128, include_arrangement: false })).structuredContent;
  assert.equal(cut.tracks.length, 120, "5 calls per track: 120 tracks use all 600 calls");
  await Promise.all([r.close(), odd.close()]);
});

test("get_session_snapshot marks a track whose parameters, notes or arrangement were cut by the call cap in the middle", async () => {
  const log: Array<{ cmd: string; args: Json }> = [];
  // 7 calls per track: track_get + 4 device_get + notes_get + arrangement_clips; 600 = 85 tracks + 5 calls of track 86.
  const r = await snapshotRig({ tracks: 90, devices: 4, params: 2, clips: 1, notes: 2 }, log);
  const out = await r.call("get_session_snapshot", { max_tracks: 90 });
  const s = out.structuredContent;
  assert.equal(log.filter((c) => INNER.has(c.cmd)).length, 600);
  const last = s.tracks.at(-1);
  assert.equal(s.tracks.length, 86);
  assert.equal(last.devices.filter((d: Json) => d.parameters !== undefined).length, 4, "the 4 devices of the last track were read");
  assert.equal(last.notes_truncated, true, "the notes call did not fit");
  assert.equal(last.clips[0].notes_truncated, true);
  assert.equal(last.clips[0].notes, undefined);
  assert.equal(last.arrangement_truncated, true);
  assert.equal(last.arrangement_clips, undefined);
  assert.equal(last.params_truncated, false);
  assert.equal(s.tracks[0].notes_truncated, false);
  await r.close();
});

test("get_session_snapshot: when the call cap hits between two devices, the rest of that track's parameters are flagged and no more calls are made", async () => {
  const log: Array<{ cmd: string; args: Json }> = [];
  // 9 calls per track (track_get + 6 device_get + notes_get + arrangement_clips): 600 = 66 tracks + track_get and 5 device_get of track 67.
  const r = await snapshotRig({ tracks: 70, devices: 6, params: 2, clips: 1, notes: 2 }, log);
  const s = (await r.call("get_session_snapshot", { max_tracks: 70 })).structuredContent;
  assert.equal(log.filter((c) => INNER.has(c.cmd)).length, 600);
  assert.equal(s.tracks.length, 67);
  const last = s.tracks.at(-1);
  assert.equal(last.devices.filter((d: Json) => d.parameters !== undefined).length, 5);
  assert.equal(last.devices[5].parameters, undefined);
  assert.equal(last.devices[5].params_truncated, true);
  assert.equal(last.devices[4].params_truncated, false);
  assert.equal(last.params_truncated, true);
  assert.equal(last.notes_truncated, true);
  assert.equal(last.clips[0].notes_truncated, true);
  assert.equal(last.arrangement_truncated, true);
  assert.equal(s.tracks[65].params_truncated, false);
  assert.equal(s.truncated, true);
  await r.close();
});

test("get_session_snapshot keeps its output under 400 KB and stops calling once the budget is gone", async () => {
  const log: Array<{ cmd: string; args: Json }> = [];
  const r = await snapshotRig({ tracks: 128, devices: 3, params: 64, clips: 1, notes: 2, paramPad: 200 }, log);
  const out = await r.call("get_session_snapshot", { max_tracks: 128, include_notes: false, include_arrangement: false });
  assert.equal(out.isError, false);
  const size = JSON.stringify(out.structuredContent).length;
  assert.ok(size <= 400_000, `size ${size}`);
  assert.ok(size > 330_000, `size ${size}: the budget is used, not a smaller one`);
  const s = out.structuredContent;
  assert.equal(s.truncated, true);
  assert.ok(s.tracks.length < 128);
  const last = s.tracks.at(-1);
  assert.equal(last.params_truncated, true, "the byte cap hit inside the last track");
  assert.ok(last.devices.some((d: Json) => d.parameters === undefined && d.params_truncated === true));
  assert.ok(log.filter((c) => c.cmd === "device_get").length <= (s.tracks.length - 1) * 3 + 3, "no call is made once a result did not fit");
  await r.close();
});

// ---------------------------------------------------------------- review round: gain guard on macros, descriptions, caps

test("the gain guard also covers parameters named Macro n whose display is in dB", async () => {
  const world = new FakeWorld();
  const macro = (display: string, value: number): FakeDevice => ({ name: "Rack", chains: [], params: [{ name: "Device On", value: 1, display: "On" }, { name: "Macro 1", value, display, min: -70, max: 6 }, { name: "Macro 2", value: 64, display: "64", min: 0, max: 127 }, { name: "Macro 12", value: -20, display: "-20.0 dB", min: -70, max: 6 }] });
  world.masterDevices = [macro("-1.0 dB", -1)];
  world.tracks[1]!.devices = [macro("-20.0 dB", -20)];
  const r = await startRig({ config: { destructive: "disabled" } as never, answers: world.answers(), echo: true });
  const tripped = (result: Json): boolean => result.isError === true && result.structuredContent.details?.reason === "gain_limit";
  const masterDevice = { track: { kind: "master" }, path: [0] };
  const trackDevice = { track: { kind: "track", index: 1 }, path: [0] };
  assert.equal(tripped(await r.call("set_device_parameter", { device: masterDevice, items: [{ index: 1, value: 1 }] })), true, "master ceiling, items form");
  assert.equal(tripped(await r.call("set_device_parameter", { param: { device: masterDevice, index: 1 }, value: 1 })), true, "master ceiling, single form");
  assert.equal(tripped(await r.call("set_device_parameter", { device: trackDevice, items: [{ index: 1, value: 0 }] })), true, "+20 dB on a track macro");
  assert.equal(tripped(await r.call("set_device_parameter", { param: { device: trackDevice, index: 1 }, value: 0 })), true);
  assert.equal(tripped(await r.call("set_device_parameter", { device: trackDevice, items: [{ index: 1, value: -15 }] })), false, "+5 dB passes");
  assert.equal(tripped(await r.call("set_device_parameter", { device: trackDevice, items: [{ index: 2, value: 100 }] })), false, "a macro without a dB display is not guarded");
  assert.equal(tripped(await r.call("set_device_parameter", { device: trackDevice, items: [{ index: 3, value: 0 }] })), true, "two-digit macro numbers count");
  assert.equal(r.seen().filter((c) => c.cmd === "param_set").length, 2, "only the two that passed were sent");
  await r.close();
});

test("only exact Macro n names join the gain guard", async () => {
  const world = new FakeWorld();
  world.tracks[1]!.devices = ["Macro", "Macro 123", "My Macro 1", "Macro x"].map((name) => ({ name: "Rack", chains: [], params: [{ name: "Device On", value: 1, display: "On" }, { name, value: -20, display: "-20.0 dB", min: -70, max: 6 }] }));
  const r = await startRig({ config: { destructive: "disabled" } as never, answers: world.answers(), echo: true });
  for (let d = 0; d < 4; d += 1) {
    const out = await r.call("set_device_parameter", { device: { track: { kind: "track", index: 1 }, path: [d] }, items: [{ index: 1, value: 0 }] });
    assert.equal(out.isError, false, `device ${d}`);
  }
  await r.close();
});

test("the capture_session_to_arrangement description reuses the overwrite wording and never says the user is asked", () => {
  const description = registryFor().get("capture_session_to_arrangement")!.tool.description;
  assert.ok(description.includes(OVERWRITE_NOTE));
  assert.doesNotMatch(description, /user is asked|asks the user/i);
  assert.equal(registryFor().get("capture_session_to_arrangement")!.tool.inputSchema.properties?.["allow_overwrite"] !== undefined, true);
});

test("a rack that reports no macros fails as documented, in get_macros and set_macro", async () => {
  const r = await macroRig([macroDevice()], { count: 0 });
  for (const [tool, extra] of [["get_macros", {}], ["set_macro", { macro_index: 1, value: 5 }]] as Array<[string, Json]>) {
    const out = await r.call(tool, { track_index: 1, device_index: 0, ...extra });
    assert.equal(out.isError, true, tool);
    assert.equal(out.structuredContent.code, "not_supported", tool);
    assert.equal(out.structuredContent.details.reason, "macro_layout", tool);
  }
  assert.deepEqual(r.seen().filter((c) => c.cmd === "param_set"), []);
  const bare = await macroRig([{ name: "Rack", chains: [], params: [{ name: "Device On", value: 1, display: "On" }] }]);
  const none = await bare.call("get_macros", { track_index: 1, device_index: 0 });
  assert.equal(none.structuredContent.details.reason, "macro_layout", "a rack whose macro parameters are missing");
  await Promise.all([r.close(), bare.close()]);
});

test("get_session_snapshot: a track that the 400 KB cap drops sets truncated even when max_tracks covered every track", async () => {
  const log: Array<{ cmd: string; args: Json }> = [];
  const r = await snapshotRig({ tracks: 6, devices: 1, params: 0, clips: 0, notes: 0, deviceNamePad: 90_000 }, log);
  const out = await r.call("get_session_snapshot", { include_params: false, include_notes: false, include_arrangement: false });
  assert.equal(out.isError, false, JSON.stringify(out.structuredContent).slice(0, 200));
  const s = out.structuredContent;
  assert.equal(s.tracks_total, 6);
  assert.ok(s.tracks.length >= 1 && s.tracks.length < 6, `tracks ${s.tracks.length}`);
  assert.equal(s.truncated, true);
  assert.ok(JSON.stringify(s).length <= 400_000);
  await r.close();
});

// ---------------------------------------------------------------- D. repo hygiene: static names, pnpm policy

test("pnpm policy is pinned: no install scripts, 7 days, missing publish times refused, pnpm 12.1.0", () => {
  const text = fs.readFileSync(path.join(ROOT, "server", "pnpm-workspace.yaml"), "utf8");
  const settings = new Map<string, string>();
  for (const line of text.split("\n")) {
    const code = line.replace(/#.*$/, "").trimEnd();
    const found = /^([A-Za-z]+):\s*(.*)$/.exec(code);
    if (found?.[1] !== undefined && found[2] !== undefined) settings.set(found[1], found[2].trim());
  }
  assert.deepEqual(Object.fromEntries(settings), {
    strictDepBuilds: "true", dangerouslyAllowAllBuilds: "false", allowBuilds: "{}", minimumReleaseAge: "10080", minimumReleaseAgeIgnoreMissingTime: "false",
  });
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "server", "package.json"), "utf8")) as { packageManager?: string };
  assert.equal(pkg.packageManager, "pnpm@12.1.0");
});

test("the new tools are registered", () => {
  const registry = registryFor();
  for (const name of ["capture_session_to_arrangement", "get_macros", "set_macro"]) assert.ok(registry.get(name), name);
});
