import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectedCatalog, startRig } from "./helpers/tools-harness.js";
import type { Rig, RigOptions } from "./helpers/tools-harness.js";
import { EarsWorld, track, virtualClock } from "./helpers/ears-world.js";
import { sineChannel, stereoSineWav, wavBytes } from "./helpers/wav.js";
import type { Json } from "./helpers/mcp-client.js";
import { ToolError } from "../src/mcp/index.js";

/** The ears tools through the whole stack: MCP client, tool registry, real LiveClient, fake script socket. */

const created: string[] = [];
after(() => { for (const dir of created) fs.rmSync(dir, { recursive: true, force: true }); });

interface Ctx { r: Rig; world: EarsWorld; home: string; file: string }

async function setup(options: RigOptions = {}, configure?: (world: EarsWorld, home: string) => void, wrap?: (answers: ReturnType<EarsWorld["answers"]>, world: EarsWorld) => void): Promise<Ctx> {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bm-tools-")));
  created.push(home);
  const world = new EarsWorld();
  const file = path.join(home, "Music", "Proj", "Samples", "Recorded", "Audio 0001.wav");
  world.filePath = file;
  world.recording = stereoSineWav(-20, 2, 48000, 24);
  configure?.(world, home);
  const answers = world.answers();
  wrap?.(answers, world);
  const r = await startRig({ welcome: { edition: "suite" }, answers, ...options, ears: { home, clock: virtualClock(), ...(options.ears ?? {}) } });
  return { r, world, home, file };
}

const sc = (result: Json): Json => result.structuredContent as Json;

test("the ears tools are listed with static schemas and honest annotations", async () => {
  const { r } = await setup();
  const tools = new Map(r.registry.list().map((t) => [t.name, t]));
  for (const name of ["batuta_ears", "record_and_analyze", "analyze_audio", "compare_audio"]) assert.ok(tools.has(name), name);
  assert.deepEqual(tools.get("batuta_ears")?.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
  assert.deepEqual(tools.get("record_and_analyze")?.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
  assert.deepEqual(tools.get("analyze_audio")?.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  assert.deepEqual(tools.get("compare_audio")?.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  const ears = tools.get("batuta_ears");
  assert.deepEqual(Object.keys(ears?.inputSchema.properties ?? {}).sort(), ["bars", "beats", "source", "spectrum"]);
  assert.deepEqual(ears?.inputSchema.required, ["source"]);
  assert.equal(JSON.stringify(ears).includes("ears_internal"), false);
  assert.equal(JSON.stringify([...tools.values()].filter((t) => /ears|analyze|compare|record_and/.test(t.name))).includes("/Users/"), false);
});

test("batuta_ears over MCP: a report, a result id, no prompt, and a set that is as it was", async () => {
  const { r, world } = await setup();
  const result = await r.call("batuta_ears", { source: { kind: "track", index: 0 }, beats: 4 });
  assert.equal(result.isError, false, JSON.stringify(result));
  const out = sc(result);
  assert.match(String(out["result_id"]), /^ears-[0-9a-f]{8}$/);
  assert.equal(out["cleanup"], "ok");
  assert.deepEqual(out["source"], { kind: "track", index: 0, name: "Drums" });
  const report = out["report"] as Json;
  assert.ok(Math.abs((report["integrated_lufs"] as number) - -20) < 0.1);
  assert.equal((report["spectrum"] as unknown[]).length, 10);
  assert.equal(world.hasEarsTrack(), false);
  assert.equal(world.tracks.length, 3);
  const text = (result.content as Array<{ text: string }>)[0]!.text;
  assert.match(text, /-20\.\d? ?LUFS|LUFS/);
});

test("the track is created only with the reserved flag, mutations are never replayed, polls may be", async () => {
  const { r } = await setup();
  await r.call("batuta_ears", { source: { kind: "master" }, beats: 4 });
  const create = r.callLog.find((c) => c.cmd === "track_create");
  assert.deepEqual(create?.args, { type: "audio", name: "batuta-ears", index: -1, ears_internal: true });
  assert.equal(create?.options.requeueOnReconnect, false);
  for (const call of r.callLog.filter((c) => ["slot_status", "clip_get", "song_info", "track_list", "routing_get"].includes(c.cmd))) assert.equal(call.options.requeueOnReconnect, true, call.cmd);
  for (const call of r.callLog.filter((c) => ["track_create", "slot_fire", "transport", "track_delete", "batch", "routing_set"].includes(c.cmd))) assert.equal(call.options.requeueOnReconnect, false, call.cmd);
});

test("ears never asks, even in the strictest confirmation mode and with a client that can be asked", async () => {
  const { r, world } = await setup({ config: { confirm: "destructive" }, capabilities: { elicitation: { form: {} } } });
  const result = await r.call("batuta_ears", { source: { kind: "track", index: 1 }, beats: 4 });
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(sc(result)["confirmation_required"], undefined);
  assert.equal(r.client.rawLines.some((line) => line.includes("elicitation/create")), false);
  assert.equal(world.hasEarsTrack(), false);
});

test("destructive:disabled does not hide ears and its cleanup still removes the temporary track", async () => {
  const { r, world } = await setup({ config: { destructive: "disabled" } });
  assert.ok(r.registry.get("batuta_ears") !== undefined);
  assert.equal(r.registry.get("delete_track"), undefined, "the delete tool itself is hidden in this mode");
  const result = await r.call("batuta_ears", { source: { kind: "track", index: 0 }, beats: 4 });
  assert.equal(result.isError, false);
  assert.equal(sc(result)["cleanup"], "ok");
  assert.equal(world.hasEarsTrack(), false);
});

test("one ears job at a time: a second call gets busy/job_running while the first is running", async () => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const { r } = await setup({}, undefined, (answers, world) => {
    answers["slot_status"] = (args, _request, reply) => { void held.then(() => { reply.ok(world.handle("slot_status", args)); }); return undefined; };
  });
  const first = r.call("batuta_ears", { source: { kind: "track", index: 0 }, beats: 4 });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const second = await r.call("batuta_ears", { source: { kind: "track", index: 1 }, beats: 4 });
  assert.equal(second.isError, true);
  assert.equal(sc(second)["code"], "busy");
  assert.equal((sc(second)["details"] as Json)["reason"], "job_running");
  assert.equal(sc(await r.call("analyze_audio", { path: "/x/y.wav" }))["code"], "busy", "analysis shares the one slot");
  assert.equal((sc(await r.call("batuta_status"))["ears"] as Json)["busy"], true);
  release();
  const done = await first;
  assert.equal(done.isError, false, JSON.stringify(done));
  assert.notEqual(sc(await r.call("analyze_audio", { path: "/x/y.wav" }))["code"], "busy", "the slot is free again");
  assert.equal((sc(await r.call("batuta_status"))["ears"] as Json)["busy"], false);
});

test("record_and_analyze is batuta_ears under another name", async () => {
  const { r, world } = await setup();
  const a = await r.call("record_and_analyze", { track_index: 2, beats: 4 });
  assert.equal(a.isError, false, JSON.stringify(a));
  assert.deepEqual(sc(a)["source"], { kind: "track", index: 2, name: "Vox" });
  assert.equal(world.hasEarsTrack(), false);
  const bad = await r.call("record_and_analyze", { track_index: 0, source: { kind: "master" } });
  assert.equal(bad.isError, true);
  const none = await r.call("record_and_analyze", { beats: 4 });
  assert.equal(none.isError, true);
  const unknown = await r.call("record_and_analyze", { track_index: 0, user_prompt: "x" });
  assert.equal(unknown.isError, true);
});

test("spectrum:false leaves the bands out of the report", async () => {
  const { r } = await setup();
  const result = await r.call("batuta_ears", { source: { kind: "track", index: 0 }, beats: 4, spectrum: false });
  assert.equal((sc(result)["report"] as Json)["spectrum"], undefined);
});

test("bad arguments are schema errors before anything is sent", async () => {
  const { r, world } = await setup();
  for (const args of [{}, { source: { kind: "track", index: 0 }, beats: 0 }, { source: { kind: "track", index: 0 }, beats: 65 }, { source: { kind: "track", index: 0 }, beats: 1.5 }, { source: { kind: "track", index: 0 }, extra: 1 }, { source: "Drums" }]) {
    const result = await r.call("batuta_ears", args);
    assert.equal(result.isError, true, JSON.stringify(args));
  }
  assert.deepEqual(world.calls, []);
});

test("Lite with 8 tracks: edition_limit through the tool, nothing created", async () => {
  const { r, world } = await setup({ welcome: { edition: "lite" } }, (w) => { while (w.tracks.length < 8) w.tracks.push(track(`T${w.tracks.length}`)); });
  const result = await r.call("batuta_ears", { source: { kind: "track", index: 0 }, beats: 4 });
  assert.equal(sc(result)["code"], "edition_limit");
  assert.equal((sc(result)["details"] as Json)["resource"], "tracks");
  assert.equal(world.mutations().length, 0);
});

test("the ears gate: an external input that is live refuses ears and the temporary track is removed", async () => {
  const { r, world } = await setup({}, (w) => { w.externalLive = true; });
  const result = await r.call("batuta_ears", { source: { kind: "track", index: 0 }, beats: 4 });
  assert.equal(sc(result)["code"], "not_supported");
  assert.equal((sc(result)["details"] as Json)["reason"], "external_input_live");
  assert.equal(world.hasEarsTrack(), false);
});

test("the executor's ears channel sends nothing outside its fixed command set, and creates only the reserved track", async () => {
  const { r, world } = await setup();
  const executor = r.tools.executor;
  await executor.earsPrepare();
  const refused = async (cmd: string, args: Json): Promise<void> => {
    await assert.rejects(executor.earsCall(cmd, args, undefined), (error: unknown) => error instanceof ToolError && error.code === "internal_error", cmd);
  };
  for (const cmd of ["track_delete", "track_duplicate", "browser_load", "device_insert", "undo", "catalog", "mixer_set", "audio_clip_create", "clip_delete"]) await refused(cmd, {});
  const reserved = { type: "audio", name: "batuta-ears", index: -1, ears_internal: true };
  for (const args of [{ ...reserved, name: "Other" }, { ...reserved, type: "midi" }, { type: "audio", name: "batuta-ears", index: -1 }, { ...reserved, extra: 1 }, { ...reserved, index: 0 }]) await refused("track_create", args);
  await refused("batch", { ops: [{ cmd: "track_delete", args: {} }] });
  await refused("batch", { ops: "nope" });
  assert.deepEqual(world.calls, [], "nothing reached the script");
  await executor.earsCall("track_create", reserved, undefined);
  assert.equal(world.hasEarsTrack(), true);
});

test("a script without the commands the flow needs is a version_mismatch before any command", async () => {
  const full = expectedCatalog() as { commands: Array<{ name: string }> };
  const { r, world } = await setup({ catalog: { ...full, commands: full.commands.filter((c) => c.name !== "slot_fire") } });
  const result = await r.call("batuta_ears", { source: { kind: "track", index: 0 }, beats: 4 });
  assert.equal(sc(result)["code"], "version_mismatch");
  assert.deepEqual(world.calls, []);
});

test("the reserved track cannot be the source", async () => {
  const { r, world } = await setup({}, (w) => { w.tracks.push(track("batuta-ears", true)); });
  const result = await r.call("batuta_ears", { source: { name: "batuta-ears" }, beats: 4 });
  assert.equal(result.isError, true);
  assert.equal(world.mutations().length, 0);
});

test("ears.enabled=false: the tools are not registered and the status says so", async () => {
  const { r } = await setup({ config: { ears: { enabled: false, maxBytes: 1 << 20, maxBeats: 64, roots: [], setRoots: [] } } });
  for (const name of ["batuta_ears", "record_and_analyze", "analyze_audio", "compare_audio"]) assert.equal(r.registry.get(name), undefined, name);
  const status = sc(await r.call("batuta_status"));
  assert.deepEqual(status["ears"], { enabled: false, busy: false, last_job: null });
});

test("status reports the last job without any path, and a failed job too", async () => {
  const { r, world } = await setup();
  const idle = sc(await r.call("batuta_status"))["ears"] as Json;
  assert.deepEqual(idle, { enabled: true, busy: false, last_job: null });
  await r.call("batuta_ears", { source: { kind: "track", index: 0 }, beats: 4 });
  const done = sc(await r.call("batuta_status"))["ears"] as Json;
  const job = done["last_job"] as Json;
  assert.equal(job["ok"], true);
  assert.equal(job["source_kind"], "track");
  assert.equal(job["beats"], 4);
  assert.equal(job["cleanup"], "ok");
  assert.equal(job["integrated_lufs"], -20);
  assert.equal(JSON.stringify(done).includes("Audio 0001"), false);
  assert.equal(JSON.stringify(done).includes("/"), false);
  world.recordMode = true;
  await r.call("batuta_ears", { source: { kind: "track", index: 0 }, beats: 4 });
  const failed = (sc(await r.call("batuta_status"))["ears"] as Json)["last_job"] as Json;
  assert.equal(failed["ok"], false);
  assert.equal(failed["error_code"], "not_supported");
});

// ------------------------------------------------------------------ analyze_audio and compare_audio

async function withSamples(): Promise<{ r: Rig; dir: string; a: string; b: string }> {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bm-samples-")));
  created.push(dir);
  const a = path.join(dir, "quiet.wav");
  const b = path.join(dir, "loud.wav");
  fs.writeFileSync(a, wavBytes([sineChannel(1000, -26, 3, 48000), sineChannel(1000, -26, 3, 48000)], 48000, 24));
  fs.writeFileSync(b, wavBytes([sineChannel(1000, -20, 3, 48000), sineChannel(1000, -20, 3, 48000)], 48000, 24));
  const { r } = await setup({ config: { sampleRoots: [dir], allowAudioImport: true } });
  return { r, dir, a, b };
}

test("analyze_audio reads a file inside a configured sample folder and never writes", async () => {
  const { r, dir, a } = await withSamples();
  const before = fs.readdirSync(dir).sort();
  const result = await r.call("analyze_audio", { path: a });
  assert.equal(result.isError, false, JSON.stringify(result));
  const report = sc(result)["report"] as Json;
  assert.ok(Math.abs((report["integrated_lufs"] as number) - -26) < 0.1);
  assert.deepEqual(fs.readdirSync(dir).sort(), before);
  assert.equal(JSON.stringify(sc(result)).includes(dir), false, "the path is not echoed back");
});

test("analyze_audio refuses what the ears validation refuses: outside the folders, symlinks, wrong type", async () => {
  const { r, dir, a } = await withSamples();
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bm-out-")));
  created.push(outside);
  fs.writeFileSync(path.join(outside, "x.wav"), fs.readFileSync(a));
  const reasonOf = async (p: string): Promise<unknown> => ((sc(await r.call("analyze_audio", { path: p }))["details"] as Json)["reason"]);
  assert.equal(await reasonOf(path.join(outside, "x.wav")), "outside_roots");
  fs.symlinkSync(path.join(outside, "x.wav"), path.join(dir, "link.wav"));
  assert.equal(await reasonOf(path.join(dir, "link.wav")), "symlink");
  fs.writeFileSync(path.join(dir, "note.txt"), "x");
  assert.equal(await reasonOf(path.join(dir, "note.txt")), "bad_extension");
  assert.equal(await reasonOf("relative.wav"), "not_absolute");
  assert.equal(await reasonOf("/etc/passwd"), "bad_extension");
});

test("compare_audio gives per-metric deltas (b minus a) for two files, and for two earlier results", async () => {
  const { r, a, b } = await withSamples();
  const files = sc(await r.call("compare_audio", { a, b }));
  const deltas = files["deltas"] as Json;
  assert.ok(Math.abs((deltas["integrated_lufs"] as number) - 6) < 0.15, String(deltas["integrated_lufs"]));
  assert.ok(Math.abs((deltas["sample_peak_dbfs"] as number) - 6) < 0.15);
  assert.equal((deltas["spectrum"] as unknown[]).length, 10);
  assert.ok(deltas["lra_lu"] === 0 || deltas["lra_lu"] === null);
  const ears1 = sc(await r.call("batuta_ears", { source: { kind: "track", index: 0 }, beats: 4 }))["result_id"];
  const ears2 = sc(await r.call("batuta_ears", { source: { kind: "track", index: 0 }, beats: 4 }))["result_id"];
  assert.notEqual(ears1, ears2);
  const ids = sc(await r.call("compare_audio", { a: ears1, b: ears2 }));
  assert.equal((ids["deltas"] as Json)["integrated_lufs"], 0);
  const mixed = sc(await r.call("compare_audio", { a: ears1, b }));
  assert.ok(Math.abs(((mixed["deltas"] as Json)["integrated_lufs"] as number) - 0) < 0.15);
});

test("compare_audio: an unknown id or a bad reference is a typed error", async () => {
  const { r, a } = await withSamples();
  const unknown = sc(await r.call("compare_audio", { a: "ears-deadbeef", b: a }));
  assert.equal(unknown["code"], "not_found");
  const bad = sc(await r.call("compare_audio", { a: "not an id", b: a }));
  assert.equal(bad["code"], "invalid_args");
});

test("compare_audio treats an undefined metric as null, never as zero", async () => {
  const { r, dir } = await withSamples();
  const silent = path.join(dir, "silent.wav");
  fs.writeFileSync(silent, wavBytes([new Float64Array(48000 * 3), new Float64Array(48000 * 3)], 48000, 16));
  const out = sc(await r.call("compare_audio", { a: silent, b: path.join(dir, "loud.wav") }));
  assert.equal((out["deltas"] as Json)["integrated_lufs"], null);
});

test("analyze_audio and compare_audio read a file anywhere when no folder is configured, and configured folders still narrow", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bm-anywhere-")));
  created.push(dir);
  const a = path.join(dir, "a.wav");
  fs.writeFileSync(a, wavBytes([sineChannel(1000, -26, 3, 48000), sineChannel(1000, -26, 3, 48000)], 48000, 24));
  const free = (await setup({ config: { allowAudioImport: true } })).r;
  const ok = await free.call("analyze_audio", { path: a });
  assert.equal(ok.isError, false, JSON.stringify(ok));
  const both = await free.call("compare_audio", { a, b: a });
  assert.equal(both.isError, false, JSON.stringify(both));
  const hard = path.join(dir, "hard.wav");
  fs.linkSync(a, hard);
  assert.equal(((sc(await free.call("analyze_audio", { path: a }))["details"] as Json)["reason"]), "hard_linked");
  fs.unlinkSync(hard);
  const narrow = (await setup({ config: { ears: { enabled: true, maxBytes: 1 << 28, maxBeats: 64, roots: [path.join(dir, "sub")], setRoots: [] } } })).r;
  fs.mkdirSync(path.join(dir, "sub"));
  const out = await narrow.call("analyze_audio", { path: a });
  assert.equal(((sc(out)["details"] as Json)["reason"]), "outside_roots");
});

test("T9q F-T9-31: a measurement cancelled by the client reports error_code cancelled in the status and still cleans up", async () => {
  const ctx = await setup({}, (world) => { world.recordPolls = 50; });
  ctx.world.afterCall = (cmd) => { if (cmd === "slot_fire") ctx.r.client.notify("notifications/cancelled", { requestId: 500 }); };
  ctx.r.client.send({ jsonrpc: "2.0", id: 500, method: "tools/call", params: { name: "batuta_ears", arguments: { source: { kind: "track", index: 0 }, beats: 4 } } });
  await new Promise((resolve) => setTimeout(resolve, 600));
  ctx.world.afterCall = undefined;
  const last = (sc(await ctx.r.call("batuta_status"))["ears"] as Json)["last_job"] as Json;
  assert.equal(last["ok"], false);
  assert.equal(last["error_code"], "cancelled");
  assert.equal(((sc(await ctx.r.call("batuta_status"))["ears"] as Json)["busy"]), false);
  assert.ok(ctx.world.names("slot_stop").length >= 1, "the cleanup still ran");
});
