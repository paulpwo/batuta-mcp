import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { FakeWorld } from "./helpers/fake-world.js";
import { startRig } from "./helpers/tools-harness.js";
import type { Json } from "./helpers/mcp-client.js";
import { FakeScript } from "./helpers/fake-script.js";
import { FakeRunner } from "./helpers/fake-host.js";
import { makeApp } from "./helpers/fake-apps.js";
import { LiveClient } from "../src/live/index.js";
import { ToolRegistry } from "../src/mcp/index.js";
import { defaultConfig } from "../src/config/index.js";
import { createLogger } from "../src/log.js";
import { registerBatutaTools } from "../src/tools/index.js";

/** Edition prechecks (docs/01-protocol.md section 8), server side, before anything is sent. */

const names = (n: number, prefix: string): Array<{ name: string }> => Array.from({ length: n }, (_, i) => ({ name: `${prefix}${i}` }));

async function rig(world: FakeWorld, options: { edition?: string; config?: Json } = {}) {
  return startRig({
    ...(options.edition === undefined ? {} : { welcome: { edition: options.edition } }),
    config: (options.config ?? {}) as never,
    answers: world.answers(),
    echo: true,
  });
}

const sentMutations = (r: Awaited<ReturnType<typeof rig>>): string[] => r.seen().filter((c) => !["song_info", "track_list", "scene_list"].includes(c.cmd)).map((c) => c.cmd);

test("Lite: the ninth track is refused with edition_limit details and nothing is sent", async () => {
  const world = new FakeWorld();
  world.tracks = names(8, "T");
  const r = await rig(world);
  const result = await r.call("create_track", { type: "midi" });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.code, "edition_limit");
  assert.deepEqual(result.structuredContent.details, { resource: "tracks", limit: 8, current: 8, edition: "lite" });
  assert.deepEqual(sentMutations(r), []);
  await r.close();
});

test("Lite: using the last free slot is allowed", async () => {
  const world = new FakeWorld();
  world.tracks = names(7, "T");
  const r = await rig(world);
  assert.equal((await r.call("create_track", { type: "audio" })).isError, false);
  assert.deepEqual(sentMutations(r), ["track_create"]);
  await r.close();
});

test("Lite: returns are limited to 2 and counted separately from tracks", async () => {
  const world = new FakeWorld();
  world.tracks = names(8, "T");
  world.returns = names(1, "R");
  const r = await rig(world);
  assert.equal((await r.call("create_track", { type: "return" })).isError, false, "one return slot is free");
  world.returns = names(2, "R");
  const full = await r.call("create_track", { type: "return" });
  assert.deepEqual(full.structuredContent.details, { resource: "returns", limit: 2, current: 2, edition: "lite" });
  await r.close();
});

test("Lite: scene_create, scene_duplicate, scene_capture and clip_duplicate without a target stop at 16 scenes", async () => {
  const world = new FakeWorld();
  world.scenes = Array.from({ length: 16 }, (_, i) => `S${i}`);
  const r = await rig(world);
  for (const [tool, args] of [
    ["create_scene", {}], ["duplicate_scene", { scene: 0 }], ["capture_scene", {}],
    ["duplicate_clip", { from: { track: { kind: "track", index: 0 }, slot: 0 } }],
  ] as Array<[string, Json]>) {
    const result = await r.call(tool, args);
    assert.equal(result.structuredContent.code, "edition_limit", tool);
    assert.deepEqual(result.structuredContent.details, { resource: "scenes", limit: 16, current: 16, edition: "lite" }, tool);
  }
  // With a target slot no scene is created.
  const withTarget = await r.call("duplicate_clip", { from: { track: { kind: "track", index: 0 }, slot: 0 }, to: { track: { kind: "track", index: 1 }, slot: 0 } });
  assert.equal(withTarget.isError, false);
  assert.deepEqual(sentMutations(r), ["clip_duplicate"]);
  await r.close();
});

test("Lite: duplicating a group track counts its children (and grandchildren)", async () => {
  const world = new FakeWorld();
  world.tracks = [
    { name: "Group", foldable: true }, { name: "Kick", group: 0 }, { name: "Sub", foldable: true, group: 0 }, { name: "Sub kick", group: 2 },
    { name: "Solo" }, { name: "Lead" },
  ];
  const r = await rig(world);
  const blocked = await r.call("duplicate_track", { track: { kind: "track", index: 0 } });
  assert.deepEqual(blocked.structuredContent.details, { resource: "tracks", limit: 8, current: 6, edition: "lite", projected: 10 });
  assert.equal((await r.call("duplicate_track", { track: { kind: "track", index: 4 } })).isError, false, "a plain track needs one slot");
  assert.deepEqual(sentMutations(r), ["track_duplicate"]);
  await r.close();
});

test("Standard and Suite: no track or scene limit, returns up to 12", async () => {
  const world = new FakeWorld();
  world.tracks = names(40, "T");
  world.scenes = Array.from({ length: 40 }, (_, i) => `S${i}`);
  world.returns = names(11, "R");
  const r = await rig(world, { edition: "suite" });
  assert.equal((await r.call("create_track", { type: "midi" })).isError, false);
  assert.equal((await r.call("create_scene", {})).isError, false);
  assert.equal((await r.call("create_track", { type: "return" })).isError, false);
  world.returns = names(12, "R");
  const full = await r.call("create_track", { type: "return" });
  assert.deepEqual(full.structuredContent.details, { resource: "returns", limit: 12, current: 12, edition: "suite" });
  await r.close();
});

test("an unknown edition runs no precheck and does not even read the counts", async () => {
  const world = new FakeWorld();
  world.tracks = names(30, "T");
  const r = await rig(world, { edition: "unknown" });
  assert.equal((await r.call("create_track", { type: "midi" })).isError, false);
  assert.deepEqual(r.seen().map((c) => c.cmd), ["track_create"]);
  await r.close();
});

test("the configured edition wins over the detected one, in both directions", async () => {
  const world = new FakeWorld();
  world.tracks = names(8, "T");
  const forcedLite = await rig(world, { edition: "suite", config: { edition: "lite" } });
  assert.equal((await forcedLite.call("create_track", { type: "midi" })).structuredContent.code, "edition_limit");
  await forcedLite.close();
  const forcedSuite = await rig(world, { edition: "lite", config: { edition: "suite" } });
  assert.equal((await forcedSuite.call("create_track", { type: "midi" })).isError, false);
  await forcedSuite.close();
});

test("commands without resource effects never read the counts", async () => {
  const r = await rig(new FakeWorld());
  await r.call("set_track_properties", { track: { kind: "track", index: 0 }, mute: true });
  // Only the name listing that pins the index ref; no song_info or other count read.
  assert.deepEqual(r.seen().map((c) => c.cmd), ["track_list", "track_set"]);
  await r.close();
});

test("batch: counts are projected across ops and the failing op is named", async () => {
  const world = new FakeWorld();
  world.tracks = names(7, "T");
  const r = await rig(world);
  const result = await r.call("batch", { ops: [
    { cmd: "create_track", args: { type: "midi" } },
    { cmd: "create_track", args: { type: "audio" } },
  ] });
  assert.equal(result.structuredContent.code, "edition_limit");
  assert.deepEqual(result.structuredContent.details, { resource: "tracks", limit: 8, current: 8, edition: "lite", op: 1 });
  assert.deepEqual(sentMutations(r), []);
  const fine = await r.call("batch", { ops: [{ cmd: "create_track", args: { type: "midi" } }, { cmd: "create_scene", args: {} }] });
  assert.equal(fine.isError, false);
  assert.deepEqual(sentMutations(r), ["batch"]);
  await r.close();
});

test("batch: scenes are projected too, and deletes in earlier ops free their slot", async () => {
  const scenes = new FakeWorld();
  scenes.scenes = Array.from({ length: 15 }, (_, i) => `S${i}`);
  const r = await rig(scenes);
  const twice = await r.call("batch", { ops: [{ cmd: "create_scene", args: {} }, { cmd: "create_scene", args: {} }] });
  assert.deepEqual(twice.structuredContent.details, { resource: "scenes", limit: 16, current: 16, edition: "lite", op: 1 });
  await r.close();

  const full = new FakeWorld();
  full.tracks = names(8, "T");
  const r2 = await rig(full, { config: { confirm: "destructive" } });
  const swap = await r2.call("batch", { ops: [
    { cmd: "delete_track", args: { track: { kind: "track", index: 7 } } },
    { cmd: "create_track", args: { type: "midi" } },
  ] });
  // Without the delete the create would be refused; with it the batch only waits for confirmation.
  assert.equal(swap.structuredContent.confirmation_required, true, JSON.stringify(swap.structuredContent));
  const reverse = await r2.call("batch", { ops: [
    { cmd: "create_track", args: { type: "midi" } },
    { cmd: "delete_track", args: { track: { kind: "track", index: 7 } } },
  ] });
  assert.equal(reverse.structuredContent.code, "edition_limit", "order matters: the create comes first");
  await r2.close();
});

test("auto edition with the host enabled: the running Live bundle reaches the Remote Script as edition_hint, before its first hello", async () => {
  const base = fs.realpathSync(fs.mkdtempSync("/tmp/bm-edition-"));
  const apps = path.join(base, "Applications");
  fs.mkdirSync(apps);
  makeApp(apps, "Ableton Live 12 Lite.app");
  const runner = new FakeRunner();
  runner.running = [path.join(apps, "Ableton Live 12 Lite.app")];
  const script = await FakeScript.create();
  const live = new LiveClient({
    runtimeDir: script.dir, flags: { allowPlugins: false, allowUserPresets: false, allowAudioImport: false, allowMaxForLive: false, allowExternalDevices: false },
    clientName: "batuta-mcp/test", logger: createLogger({ sink: () => undefined }), expectedUid: process.getuid?.() ?? 0,
  });
  const registry = new ToolRegistry();
  registerBatutaTools(registry, {
    live, config: defaultConfig(), logger: createLogger({ sink: () => undefined }),
    host: { runner: runner.run, applicationsDir: apps, home: base, uid: process.getuid?.() ?? 0, platform: "darwin" },
  });
  live.start();
  try {
    await live.ready(3000);
    assert.equal(script.hellos[0]?.edition_hint, "lite");
    assert.equal(runner.actions().length, 0, "the probe only asks which app runs");
  } finally {
    await live.close();
    await script.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});
