import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EarsDeclined, runEarsJob } from "../src/ears/job.js";
import type { EarsJobOptions, EarsRequest } from "../src/ears/job.js";
import { AnalysisRunner } from "../src/ears/analysis.js";
import type { AnalysisReport } from "../src/ears/analysis.js";
import { McpCancelledError, ToolError } from "../src/mcp/index.js";
import { EarsWorld, WorldHost, track, virtualClock } from "./helpers/ears-world.js";
import type { VClock } from "./helpers/ears-world.js";
import { stereoSineWav } from "./helpers/wav.js";

/** The ears flow of docs/01-protocol.md section 10 against a stateful model of the script, without sockets and on a virtual clock. */

const created: string[] = [];
after(() => { for (const dir of created) fs.rmSync(dir, { recursive: true, force: true }); });

const REPORT: AnalysisReport = {
  duration_s: 2, sample_rate: 48000, channels: 2, bit_depth: 24, mono: false, integrated_lufs: -20, short_term_max_lufs: null, momentary_max_lufs: -19.9, lra_lu: null,
  true_peak_dbtp: -19.9, true_peak_dbtp_per_channel: [-19.9, -19.9], sample_peak_dbfs: -20, rms_dbfs: -23, crest_db: 3, correlation: 1, warnings: ["too_short_for_lra"],
  spectrum: [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000].map((center_hz) => ({ center_hz, level_db: -60 })),
};

interface Rig {
  home: string; world: EarsWorld; host: WorldHost; clock: VClock; options: EarsJobOptions; file: string; analyzed: number;
}

function rig(configure?: (r: Rig) => void): Rig {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bm-job-")));
  created.push(home);
  const world = new EarsWorld();
  const file = path.join(home, "Music", "Proj", "Samples", "Recorded", "Audio 0001.wav");
  world.filePath = file;
  world.recording = stereoSineWav(-20, 2, 48000, 24);
  const host = new WorldHost(world);
  const clock = virtualClock();
  const r: Rig = {
    home, world, host, clock, file, analyzed: 0,
    options: {
      host, clock,
      config: { enabled: true, maxBytes: 1 << 28, maxBeats: 64, roots: [], setRoots: [] },
      files: { home },
      analyzer: { analyze: () => { r.analyzed += 1; return Promise.resolve({ ...REPORT, warnings: [...REPORT.warnings] }); } },
    },
  };
  configure?.(r);
  return r;
}

const REQUEST: EarsRequest = { source: { kind: "track", index: 0 }, beats: 4 };
const run = (r: Rig, request: EarsRequest = REQUEST, signal: AbortSignal = new AbortController().signal) => runEarsJob(request, r.options, signal);
const mutationNames = (r: Rig): string[] => r.world.mutations().map((c) => c.cmd);
const EARS = { kind: "track", index: 3, expect_name: "batuta-ears" };

async function fails(promise: Promise<unknown>): Promise<ToolError> {
  try { await promise; } catch (error) {
    assert.ok(error instanceof ToolError, `expected a ToolError, got ${String(error)}`);
    return error;
  }
  throw new Error("expected a rejection");
}

function assertCleanSet(r: Rig, tracks = 3): void {
  assert.equal(r.world.hasEarsTrack(), false, "the temporary track is gone");
  assert.equal(r.world.tracks.length, tracks);
  assert.equal(r.world.isPlaying, false, "transport restored");
  assert.equal(r.world.time, 12.5, "playhead restored");
  assert.deepEqual(r.world.selected, { kind: "track", index: 1 }, "selection restored");
}

// ------------------------------------------------------------------ the happy path

test("happy path: the exact command sequence of section 10.2, the report, and a set that looks untouched", async () => {
  const r = rig();
  const outcome = await run(r);
  assert.deepEqual(mutationNames(r), ["track_create", "routing_set", "routing_set", "batch", "transport", "slot_fire", "slot_stop", "track_select", "transport", "song_set_time", "track_delete"]);
  const m = r.world.mutations();
  assert.deepEqual(m[0]?.args, { type: "audio", name: "batuta-ears", index: -1, ears_internal: true });
  assert.deepEqual(m[1]?.args, { track: EARS, input_type: "Drums", input_channel: "Post Mixer" });
  assert.deepEqual(m[2]?.args, { track: EARS, output_type: "No Output" });
  assert.deepEqual(m[3]?.args, { ops: [{ cmd: "track_set", args: { track: EARS, mute: true, monitoring_state: 2 } }, { cmd: "track_set", args: { track: EARS, arm: true } }], stop_on_error: true });
  assert.deepEqual(m[4]?.args, { action: "start" });
  assert.deepEqual(m[5]?.args, { track: EARS, slot: 0, record_length: 4, launch_quantization: 0 });
  assert.deepEqual(m[6]?.args, { track: EARS, slot: 0 });
  assert.deepEqual(m[7]?.args, { track: { kind: "track", index: 1 } });
  assert.deepEqual(m[8]?.args, { action: "stop" });
  assert.deepEqual(m[9]?.args, { time: 12.5 });
  assert.deepEqual(m[10]?.args, { track: EARS, expect_name: "batuta-ears" });
  assertCleanSet(r);
  assert.equal(outcome.cleanup, "ok");
  assert.equal(outcome.beats, 4);
  assert.deepEqual(outcome.source, { kind: "track", index: 0, name: "Drums" });
  assert.equal(outcome.report.integrated_lufs, -20);
  assert.equal(outcome.file.path, r.file);
  assert.equal(r.host.prepared, 1);
  assert.equal(r.analyzed, 1);
  // the recording file is never touched
  assert.equal(fs.existsSync(r.file), true);
});

test("the real analysis worker measures the recorded file (1 kHz sine at -20 dBFS)", async () => {
  const r = rig();
  r.options.analyzer = new AnalysisRunner();
  const outcome = await run(r);
  assert.ok(Math.abs((outcome.report.integrated_lufs ?? 99) - -20) < 0.1);
  assert.equal(outcome.report.channels, 2);
});

test("only allowlisted commands are ever sent", async () => {
  const r = rig();
  await run(r);
  const allowed = new Set(["song_info", "track_list", "track_create", "routing_get", "routing_set", "batch", "track_set", "transport", "slot_fire", "slot_status", "clip_get", "slot_stop", "song_set_time", "track_select", "track_delete"]);
  assert.deepEqual(r.world.names().filter((name) => !allowed.has(name)), []);
});

test("a transport that was already playing keeps playing and the playhead is not moved", async () => {
  const r = rig((x) => { x.world.isPlaying = true; });
  await run(r);
  assert.deepEqual(mutationNames(r), ["track_create", "routing_set", "routing_set", "batch", "slot_fire", "slot_stop", "track_select", "track_delete"]);
  assert.equal(r.world.isPlaying, true);
  assert.equal(r.world.time, 16.5, "playback carried on through the recording");
});

test("master is recorded through Resampling with the channel left alone", async () => {
  const r = rig();
  await run(r, { source: { kind: "master" }, beats: 4 });
  assert.deepEqual(r.world.mutations()[1]?.args, { track: EARS, input_type: "Resampling" });
  assertCleanSet(r);
});

test("a return is selected by the form Live lists it in", async () => {
  const r = rig((x) => { x.world.returnPrefix = true; x.world.returns[0]!.name = "Reverb"; });
  const outcome = await run(r, { source: { kind: "return", index: 0 }, beats: 4 });
  assert.deepEqual(r.world.mutations()[1]?.args, { track: EARS, input_type: "A-Reverb", input_channel: "Post Mixer" });
  assert.deepEqual(outcome.source, { kind: "return", index: 0, name: "Reverb" });
  const plain = rig();
  await run(plain, { source: { kind: "return", index: 0 }, beats: 4 });
  assert.deepEqual(plain.world.mutations()[1]?.args, { track: EARS, input_type: "A-Reverb", input_channel: "Post Mixer" });
});

test("a source given by name is resolved and pinned with expect_name", async () => {
  const r = rig();
  const outcome = await run(r, { source: { name: "bass" }, beats: 4 });
  assert.deepEqual(outcome.source, { kind: "track", index: 1, name: "Bass" });
  assert.equal((r.world.mutations()[1]?.args as { input_type: string }).input_type, "Bass");
});

test("a wrong expect_name on the source stops before anything changes", async () => {
  const r = rig();
  const error = await fails(run(r, { source: { kind: "track", index: 0, expect_name: "Nope" }, beats: 4 }));
  assert.equal(error.code, "not_found");
  assert.deepEqual(mutationNames(r), []);
});

test("Post FX is used when there is no Post Mixer; with neither the job stops and cleans up", async () => {
  const r = rig((x) => { x.world.channels = ["Pre FX", "Post FX"]; });
  await run(r);
  const routing = r.world.mutations().filter((c) => c.cmd === "routing_set").map((c) => c.args);
  assert.deepEqual(routing.slice(0, 2), [{ track: EARS, input_type: "Drums", input_channel: "Post Mixer" }, { track: EARS, input_channel: "Post FX" }]);
  const none = rig((x) => { x.world.channels = ["Pre FX"]; });
  const error = await fails(run(none));
  assert.equal(error.code, "not_supported");
  assert.equal(error.details?.["reason"], "no_post_mixer");
  assertCleanSet(none);
});

test("two inputs with the source's display name make the job stop (the script never picks one)", async () => {
  const r = rig((x) => { x.world.tracks.push(track("Bass")); });
  const error = await fails(run(r, { source: { kind: "track", index: 1 }, beats: 4 }));
  assert.equal(error.code, "invalid_args");
  assert.equal(error.details?.["reason"], "ambiguous_input");
  assert.equal(r.world.hasEarsTrack(), false);
  const named = rig((x) => { x.world.tracks.push(track("Bass")); });
  assert.equal((await fails(run(named, { source: { name: "Bass" }, beats: 4 }))).details?.["reason"], "ambiguous_name");
  assert.deepEqual(mutationNames(named), []);
});

// ------------------------------------------------------------------ preconditions

test("preconditions stop the job before the first change", async () => {
  const stale = rig((x) => { x.world.tracks.push(track("batuta-ears", true)); });
  const e1 = await fails(run(stale));
  assert.equal(e1.code, "invalid_args");
  assert.equal(e1.details?.["reason"], "stale_ears_track");
  assert.deepEqual(mutationNames(stale), []);
  assert.ok(e1.message.includes("batuta-ears"));

  for (const flag of ["recordMode", "sessionRecord"] as const) {
    const r = rig((x) => { x.world[flag] = true; });
    const error = await fails(run(r));
    assert.equal(error.code, "not_supported");
    assert.equal(error.details?.["reason"], "record_mode_on");
    assert.deepEqual(mutationNames(r), []);
  }
});

test("ears are disabled by configuration: nothing is sent, not even the connect check", async () => {
  const r = rig();
  r.options.config.enabled = false;
  const error = await fails(run(r));
  assert.equal(error.code, "not_supported");
  assert.equal(error.details?.["reason"], "disabled_by_config");
  assert.equal(r.host.prepared, 0);
  assert.deepEqual(r.world.calls, []);
});

test("ears gate, server side: an armed audio track with an external input refuses before anything is created", async () => {
  const r = rig((x) => { const vox = x.world.tracks[2]!; vox.arm = true; });
  const error = await fails(run(r));
  assert.equal(error.code, "not_supported");
  assert.equal(error.details?.["reason"], "external_input_live");
  assert.deepEqual(mutationNames(r), []);
  const monitoring = rig((x) => { x.world.tracks[2]!.monitoring = 0; });
  assert.equal((await fails(run(monitoring))).details?.["reason"], "external_input_live");
  // an armed audio track fed by another track is safe; so is a MIDI track that is armed
  const safe = rig((x) => { const vox = x.world.tracks[2]!; vox.arm = true; vox.inputType = "Bass"; x.world.tracks[0]!.arm = true; });
  await run(safe);
});

test("ears gate: with a confirmation hook the owner is asked once, naming the tracks; accept goes on and every later command carries the acknowledgement", async () => {
  const asked: string[][] = [];
  const r = rig((x) => { x.world.tracks[2]!.arm = true; x.options.confirmExternal = (tracks) => { asked.push(tracks); return Promise.resolve(true); }; });
  const before = (): number => r.host.acks.length;
  await run(r);
  assert.deepEqual(asked, [[r.world.tracks[2]!.name]]);
  assert.ok(before() > 3);
  const firstAcked = r.host.acks.indexOf(true);
  assert.ok(firstAcked > 0, "the reads before the question are not acknowledged");
  const later = r.host.acks.map((ack, i) => ({ ack, cmd: r.host.cmds[i]! })).slice(firstAcked).filter((c) => c.cmd !== "track_delete");
  assert.ok(later.every((c) => c.ack), "everything after the accept is acknowledged (the cleanup delete needs none)");
});

test("R2 ears: a track that holds an External device is named too, and the job's acknowledgement is bound to exactly those ids", async () => {
  const asked: string[][] = [];
  const r = rig((x) => { x.world.externalDevices = [0]; x.world.tracks[2]!.arm = true; x.options.confirmExternal = (tracks) => { asked.push(tracks); return Promise.resolve(true); }; });
  await run(r);
  assert.deepEqual(asked, [["Drums", "Vox"]], "the device case and the armed input case are both shown, once");
  const sent = r.host.ackIds.filter((ids) => ids !== undefined);
  assert.ok(sent.length > 3);
  assert.ok(sent.every((ids) => JSON.stringify(ids) === JSON.stringify(["t0", "t2"])));
});

test("R2 ears: only an External device (nothing armed) still asks, and without a hook it refuses", async () => {
  const asked: string[][] = [];
  const ask = rig((x) => { x.world.externalDevices = [1]; x.options.confirmExternal = (tracks) => { asked.push(tracks); return Promise.resolve(true); }; });
  await run(ask);
  assert.deepEqual(asked, [["Bass"]]);
  const none = rig((x) => { x.world.externalDevices = [1]; });
  const error = await fails(run(none));
  assert.equal(error.code, "not_supported");
  assert.equal(error.details?.["reason"], "external_input_live");
  assert.deepEqual(mutationNames(none), []);
});

test("ears gate: a declined confirmation stops with EarsDeclined before anything is created", async () => {
  const r = rig((x) => { x.world.tracks[2]!.arm = true; x.options.confirmExternal = () => Promise.resolve(false); });
  await assert.rejects(run(r), EarsDeclined);
  assert.deepEqual(mutationNames(r), []);
  assert.ok(r.host.acks.every((ack) => !ack));
});

test("ears gate, script side: the arm is refused while an external input is live, the job stops and removes its track", async () => {
  const r = rig((x) => { x.world.externalLive = true; });
  const error = await fails(run(r));
  assert.equal(error.code, "not_supported");
  assert.equal(error.details?.["reason"], "external_input_live");
  assert.deepEqual(mutationNames(r), ["track_create", "routing_set", "routing_set", "batch", "track_select", "track_delete"], "the transport is never started and nothing records; the selection the new track took is given back");
  assertCleanSet(r);
});

test("edition limit: Lite with 8 tracks has no slot for the ears track; other editions do", async () => {
  const lite = rig((x) => { x.world.edition = "lite"; while (x.world.tracks.length < 8) x.world.tracks.push(track(`T${x.world.tracks.length}`)); });
  const error = await fails(run(lite));
  assert.equal(error.code, "edition_limit");
  assert.deepEqual(error.details, { resource: "tracks", limit: 8, current: 8, edition: "lite" });
  assert.deepEqual(mutationNames(lite), []);
  const seven = rig((x) => { x.world.edition = "lite"; while (x.world.tracks.length < 7) x.world.tracks.push(track(`T${x.world.tracks.length}`)); });
  await run(seven);
  assertCleanSet(seven, 7);
  const suite = rig((x) => { x.world.edition = "suite"; while (x.world.tracks.length < 20) x.world.tracks.push(track(`T${x.world.tracks.length}`)); });
  await run(suite);
});

test("edition limit raised by the script itself (edition unknown to the server) is cleaned up", async () => {
  const r = rig((x) => { x.world.edition = "unknown"; x.world.trackLimit = 3; });
  const error = await fails(run(r));
  assert.equal(error.code, "edition_limit");
  assert.equal(r.world.hasEarsTrack(), false);
  assert.equal(r.world.tracks.length, 3);
});

test("beats, bars and the configured maximum", async () => {
  for (const request of [{ source: { kind: "track", index: 0 }, beats: 0 }, { source: { kind: "track", index: 0 }, beats: 65 }, { source: { kind: "track", index: 0 }, beats: 4, bars: 1 }, { source: { kind: "track", index: 0 }, beats: Number.NaN }, { source: { kind: "track", index: 0 }, bars: 17 }] as EarsRequest[]) {
    const r = rig();
    const error = await fails(run(r, request));
    assert.equal(error.code, "invalid_args", JSON.stringify(request));
    assert.deepEqual(mutationNames(r), []);
  }
  const capped = rig();
  capped.options.config.maxBeats = 8;
  assert.equal((await fails(run(capped, { source: { kind: "track", index: 0 }, beats: 9 }))).code, "invalid_args");
  const bars = rig((x) => { x.world.signature = [3, 4]; });
  await run(bars, { source: { kind: "track", index: 0 }, bars: 2 });
  assert.equal((bars.world.mutations().find((c) => c.cmd === "slot_fire")?.args as { record_length: number }).record_length, 6);
  const compound = rig((x) => { x.world.signature = [6, 8]; });
  await run(compound, { source: { kind: "track", index: 0 }, bars: 2 });
  assert.equal((compound.world.mutations().find((c) => c.cmd === "slot_fire")?.args as { record_length: number }).record_length, 6, "6/8 is 3 quarter notes per bar");
  const dflt = rig();
  await run(dflt, { source: { kind: "track", index: 0 } });
  assert.equal((dflt.world.mutations().find((c) => c.cmd === "slot_fire")?.args as { record_length: number }).record_length, 16);
});

test("warnings: a muted source and a solo elsewhere can leave the Post Mixer tap silent", async () => {
  const r = rig((x) => { x.world.tracks[0]!.mute = true; x.world.tracks[1]!.solo = true; });
  const outcome = await run(r);
  assert.ok(outcome.warnings.includes("source_muted"));
  assert.ok(outcome.warnings.includes("solo_active"));
  const quiet = rig();
  assert.deepEqual((await run(quiet)).warnings, []);
  const soloSource = rig((x) => { x.world.tracks[0]!.solo = true; });
  assert.ok(!(await run(soloSource)).warnings.includes("solo_active"));
});

// ------------------------------------------------------------------ restoring the owner's state

test("tracks that were armed are re-armed after the ears track took the arm; a refusal is a warning", async () => {
  const r = rig((x) => { x.world.tracks[0]!.arm = true; x.world.exclusiveArm = true; });
  const outcome = await run(r, { source: { kind: "track", index: 1 }, beats: 4 });
  assert.equal(r.world.tracks[0]!.arm, true);
  const rearm = r.world.mutations().filter((c) => c.cmd === "track_set");
  assert.deepEqual(rearm.map((c) => c.args), [{ track: { kind: "track", index: 0, expect_name: "Drums" }, arm: true }]);
  assert.deepEqual(outcome.warnings, []);
  const refused = rig((x) => {
    x.world.tracks[0]!.arm = true; x.world.exclusiveArm = true;
    x.world.failures.push({ cmd: "track_set", match: (a) => a["arm"] === true, error: { code: "not_supported", details: { reason: "audio_arm_blocked" } } });
  });
  const out = await run(refused, { source: { kind: "track", index: 1 }, beats: 4 });
  assert.ok(out.warnings.some((w) => w.startsWith("rearm_failed")));
  assert.equal(out.cleanup, "ok");
});

test("the transport and the selection are restored even when the job fails after starting them", async () => {
  const r = rig((x) => { x.world.recordPolls = 1_000_000; });
  const error = await fails(run(r));
  assert.equal(error.code, "timeout");
  assertCleanSet(r);
});

test("a set whose selection Live cannot name is left alone (no track_select with an empty reference)", async () => {
  const r = rig((x) => { x.world.selected = {}; });
  const outcome = await run(r);
  assert.equal(outcome.cleanup, "ok");
  assert.equal(r.world.names("track_select").length, 0);
});

// ------------------------------------------------------------------ failure at every stage cleans up

test("recording never finishes: timeout (recording), the slot is stopped, everything is restored", async () => {
  const r = rig((x) => { x.world.recordPolls = 1_000_000; });
  const error = await fails(run(r));
  assert.equal(error.code, "timeout");
  assert.equal(error.details?.["stage"], "recording");
  assert.equal(error.details?.["cleanup"], "ok");
  assert.ok(r.world.names("slot_stop").length >= 1);
  assertCleanSet(r);
  // 4 beats at 120 BPM: 2 s * 1.5 + 5 s
  assert.ok(r.clock.now() >= 8000 && r.clock.now() < 12000, String(r.clock.now()));
});

test("the recording deadline follows the tempo: 64 beats at 20 BPM is 293 s, under the 300 s cap", async () => {
  const r = rig((x) => { x.world.recordPolls = 1_000_000; x.world.tempo = 20; });
  const error = await fails(run(r, { source: { kind: "track", index: 0 }, beats: 64 }));
  assert.equal(error.code, "timeout");
  assert.ok(r.clock.now() >= 293_000 && r.clock.now() < 300_000, String(r.clock.now()));
});

test("the connection drops during polling and comes back: the job carries on and succeeds", async () => {
  const r = rig((x) => { x.world.failures.push({ cmd: "slot_status", drop: true, times: 3 }); });
  const outcome = await run(r);
  assert.equal(outcome.cleanup, "ok");
  assertCleanSet(r);
  assert.ok(r.world.names("slot_status").length >= 6);
});

test("clip_get is retried after a lost connection too", async () => {
  const r = rig((x) => { x.world.failures.push({ cmd: "clip_get", drop: true, times: 2 }); });
  await run(r);
  assert.equal(r.world.names("clip_get").length, 3);
});

test("time spent without a connection does not eat the recording deadline", async () => {
  // 30 failed polls of 250 ms+backoff would pass the 8 s deadline of this recording if outages counted
  const r = rig((x) => { x.world.failures.push({ cmd: "slot_status", drop: true, times: 12 }); });
  const outcome = await run(r);
  assert.equal(outcome.cleanup, "ok");
  assert.ok(r.clock.now() > 8000, "the outage was longer than the plain deadline");
});

test("a connection that never comes back ends at the 600 s job deadline, then the track is removed", async () => {
  const r = rig((x) => { x.world.failures.push({ cmd: "slot_status", drop: true, times: 1_000_000 }); });
  const error = await fails(run(r));
  assert.equal(error.code, "timeout");
  assert.equal(error.details?.["stage"], "job");
  assert.ok(r.clock.now() >= 600_000 && r.clock.now() < 700_000, String(r.clock.now()));
  assert.equal(r.world.hasEarsTrack(), false);
});

test("a connection lost for good: cleanup_failed carries the manual instruction", async () => {
  const r = rig((x) => { x.world.afterCall = (cmd) => { if (cmd === "slot_fire") x.world.down = true; }; });
  const error = await fails(run(r));
  assert.equal(error.code, "cleanup_failed");
  assert.match(String(error.details?.["manual"]), /delete the track named batuta-ears/);
  assert.equal((error.details?.["original"] as { code: string }).code, "timeout");
  assert.equal(r.world.hasEarsTrack(), true, "nothing could be done from here");
});

test("file missing after the recording: file_not_found, then cleanup", async () => {
  const r = rig((x) => { x.world.afterCall = (cmd) => { if (cmd === "clip_get") fs.rmSync(x.file); }; });
  const error = await fails(run(r));
  assert.equal(error.code, "invalid_args");
  assert.equal(error.details?.["reason"], "file_not_found");
  assert.equal(error.details?.["cleanup"], "ok");
  assertCleanSet(r);
});

test("a recording outside the allowed folders is never opened or analyzed", async () => {
  const r = rig((x) => { x.world.filePath = path.join(x.home, "Documents", "evil.wav"); });
  const error = await fails(run(r));
  assert.equal(error.details?.["reason"], "outside_roots");
  assert.equal(r.analyzed, 0);
  assertCleanSet(r);
});

test("the recording folder named by the configuration is accepted", async () => {
  const r = rig((x) => { x.world.filePath = path.join(x.home, "Documents", "rec", "ok.wav"); x.options.config.roots = [path.join(x.home, "Documents", "rec")]; });
  await run(r);
  assertCleanSet(r);
});

test("analysis failure: the error is reported and the set is cleaned", async () => {
  const r = rig((x) => { x.options.analyzer = { analyze: () => Promise.reject(new ToolError("timeout", "slow", { stage: "analysis" })) }; });
  const error = await fails(run(r));
  assert.equal(error.code, "timeout");
  assert.equal(error.details?.["stage"], "analysis");
  assert.equal(error.details?.["cleanup"], "ok");
  assertCleanSet(r);
});

test("a routing failure after the track exists cleans up", async () => {
  const r = rig((x) => { x.world.failures.push({ cmd: "routing_set", times: 1, error: { code: "lom_error", message: "Live said no" } }); });
  const error = await fails(run(r));
  assert.equal(error.code, "lom_error");
  assertCleanSet(r);
});

test("cancellation while recording: the job rejects as cancelled after it has cleaned up", async () => {
  const controller = new AbortController();
  const r = rig((x) => { x.world.recordPolls = 50; x.world.afterCall = (cmd) => { if (cmd === "slot_fire") controller.abort(); }; });
  await assert.rejects(run(r, REQUEST, controller.signal), McpCancelledError);
  assertCleanSet(r);
  assert.ok(r.world.names("slot_stop").length >= 1);
});

test("a cancellation that comes before the first command changes nothing", async () => {
  const controller = new AbortController();
  controller.abort();
  const r = rig();
  await assert.rejects(run(r, REQUEST, controller.signal), McpCancelledError);
  assert.deepEqual(mutationNames(r), []);
});

test("create_track outcome unknown (connection dropped after it applied): cleanup finds the track by where it must be and removes it", async () => {
  const applied = rig((x) => { x.world.failures.push({ cmd: "track_create", drop: true, applied: true }); });
  const error = await fails(run(applied));
  assert.equal(error.code, "connection_lost");
  assert.equal(applied.world.hasEarsTrack(), false);
  assert.equal(applied.world.mutations().filter((c) => c.cmd === "track_delete").length, 1);
  const notApplied = rig((x) => { x.world.failures.push({ cmd: "track_create", drop: true, applied: false }); });
  await fails(run(notApplied));
  assert.equal(notApplied.world.mutations().filter((c) => c.cmd === "track_delete").length, 0);
  assert.equal(notApplied.world.tracks.length, 3);
});

// ------------------------------------------------------------------ identity re-check before deleting

test("a user track renamed batuta-ears is never deleted in place of ours", async () => {
  const r = rig((x) => {
    x.world.afterCall = (cmd) => { if (cmd === "clip_get") { x.world.tracks[3]!.name = "kept by user"; x.world.tracks[1]!.name = "batuta-ears"; } };
  });
  const outcome = await run(r);
  assert.equal(outcome.cleanup, "failed");
  assert.ok(outcome.warnings.includes("cleanup_identity_mismatch"));
  assert.match(outcome.manual ?? "", /batuta-ears/);
  assert.equal(r.world.mutations().filter((c) => c.cmd === "track_delete").length, 0);
  assert.equal(r.world.tracks[1]!.name, "batuta-ears", "the user's track is untouched");
  assert.equal(r.world.tracks.length, 4);
});

test("same for the error path: the original error comes back as cleanup_failed with the manual step", async () => {
  const r = rig((x) => {
    x.options.analyzer = { analyze: () => Promise.reject(new ToolError("internal_error", "boom", { stage: "analysis" })) };
    x.world.afterCall = (cmd) => { if (cmd === "clip_get") { x.world.tracks[3]!.name = "kept by user"; x.world.tracks[1]!.name = "batuta-ears"; } };
  });
  const error = await fails(run(r));
  assert.equal(error.code, "cleanup_failed");
  assert.equal((error.details?.["original"] as { code: string }).code, "internal_error");
  assert.equal(r.world.mutations().filter((c) => c.cmd === "track_delete").length, 0);
});

test("our track renamed by the user, or two tracks with the name: nothing is deleted and the owner is told", async () => {
  const renamed = rig((x) => { x.world.afterCall = (cmd) => { if (cmd === "clip_get") x.world.tracks[3]!.name = "mine now"; }; });
  const a = await run(renamed);
  assert.equal(a.cleanup, "failed");
  assert.equal(renamed.world.mutations().filter((c) => c.cmd === "track_delete").length, 0);
  const twins = rig((x) => { x.world.afterCall = (cmd) => { if (cmd === "clip_get") { x.world.tracks.push(track("batuta-ears", true)); } }; });
  const b = await run(twins);
  assert.equal(b.cleanup, "failed");
  assert.equal(twins.world.mutations().filter((c) => c.cmd === "track_delete").length, 0);
});

test("a track at the right index that is not an empty audio track is not deleted either", async () => {
  const r = rig((x) => { x.world.afterCall = (cmd) => { if (cmd === "clip_get") { x.world.tracks[3]!.audio = false; } }; });
  assert.equal((await run(r)).cleanup, "failed");
  const loaded = rig((x) => { x.world.afterCall = (cmd) => { if (cmd === "clip_get") { x.world.tracks[3]!.devices = 2; } }; });
  assert.equal((await run(loaded)).cleanup, "failed");
  assert.equal(loaded.world.mutations().filter((c) => c.cmd === "track_delete").length, 0);
});

test("the delete is retried once after a Live error, with a fresh listing in between", async () => {
  const r = rig((x) => { x.world.failures.push({ cmd: "track_delete", times: 1, error: { code: "lom_error" } }); });
  const outcome = await run(r);
  assert.equal(outcome.cleanup, "ok");
  assert.equal(r.world.names("track_delete").length, 2);
  assert.equal(r.world.hasEarsTrack(), false);
});

test("when the delete keeps failing the report still comes back, with cleanup failed and the manual step", async () => {
  const r = rig((x) => { x.world.failures.push({ cmd: "track_delete", times: 5, error: { code: "lom_error" } }); });
  const outcome = await run(r);
  assert.equal(outcome.cleanup, "failed");
  assert.match(outcome.manual ?? "", /delete the track named batuta-ears/);
  assert.equal(r.world.names("track_delete").length, 2, "exactly one retry");
  assert.equal(outcome.report.integrated_lufs, -20);
});

// ------------------------------------------------------------------ waiting for the file to settle

test("the job waits until the file stops growing and its size agrees with the header", async () => {
  const full = stereoSineWav(-20, 2, 48000, 24);
  const r = rig((x) => { x.world.recording = full.subarray(0, 20000); });
  r.clock.onSleep = (_ms, count) => { if (count > 0 && fs.existsSync(r.file) && fs.statSync(r.file).size < full.length) fs.writeFileSync(r.file, full.subarray(0, Math.min(full.length, fs.statSync(r.file).size + 60000))); };
  const outcome = await run(r);
  assert.equal(outcome.file.size, full.length);
  assert.equal(outcome.cleanup, "ok");
});

test("a complete-looking file is only accepted after two equal sizes in a row (a trailing chunk written late is included)", async () => {
  const r = rig();
  const full = stereoSineWav(-20, 2, 48000, 24);
  let appended = false;
  r.clock.onSleep = (ms) => { if (ms === 200 && !appended) { appended = true; fs.appendFileSync(r.file, Buffer.alloc(8, 1)); } };
  const outcome = await run(r);
  assert.equal(outcome.file.size, full.length + 8);
});

test("a file that never settles is timeout (finalize) after 5 s, then cleanup", async () => {
  const full = stereoSineWav(-20, 2, 48000, 24);
  const r = rig((x) => { x.world.recording = full.subarray(0, 20000); });
  const error = await fails(run(r));
  assert.equal(error.code, "timeout");
  assert.equal(error.details?.["stage"], "finalize");
  assertCleanSet(r);
});

test("the file replaced after it settled is refused before it is read", async () => {
  const r = rig((x) => {
    x.world.afterCall = (cmd) => { if (cmd === "slot_stop") { fs.rmSync(x.file); fs.writeFileSync(x.file, stereoSineWav(-10, 2)); } };
  });
  const error = await fails(run(r));
  assert.equal(error.details?.["reason"], "file_changed");
  assert.equal(error.details?.["cleanup"], "ok");
  assert.equal(r.analyzed, 0);
});

// ------------------------------------------------------------------ review fixes (F1..F7)

test("F1: the connection drops mid-record and returns only during cleanup: the transport, playhead, selection and arms are still restored", async () => {
  const r = rig((x) => {
    x.world.tracks[0]!.arm = true;
    x.world.exclusiveArm = true;
    x.world.afterCall = (cmd) => { if (cmd === "slot_fire") x.world.down = true; };
  });
  // the connection is back when cleanup asks for it, not before the job gave up
  r.host.ready = (ms) => { if ((ms ?? 0) >= 30_000) r.world.down = false; return r.world.down ? Promise.reject(new Error("down")) : Promise.resolve(); }; // only the cleanup waits the long time
  const error = await fails(run(r, { source: { kind: "track", index: 1 }, beats: 4 }));
  assert.equal(error.code, "timeout");
  assert.equal(error.details?.["cleanup"], "ok");
  assert.equal(r.world.isPlaying, false, "transport stopped");
  assert.equal(r.world.time, 12.5, "playhead back");
  assert.deepEqual(r.world.selected, { kind: "track", index: 1 });
  assert.equal(r.world.tracks[0]!.arm, true, "re-armed");
  assert.equal(r.world.hasEarsTrack(), false);
});

test("F2: a source named like one of Live's own inputs is refused, tracks and returns alike", async () => {
  for (const name of ["Ext. In", "Resampling", "No Input"]) {
    const ret = rig((x) => { x.world.returns[0]!.name = name; });
    const e1 = await fails(run(ret, { source: { kind: "return", index: 0 }, beats: 4 }));
    assert.equal(e1.code, "not_supported", name);
    assert.equal(e1.details?.["reason"], "unsafe_source_name", name);
    assertCleanSet(ret);
    const tr = rig((x) => { x.world.tracks[0]!.name = name; });
    assert.equal((await fails(run(tr, { source: { kind: "track", index: 0 }, beats: 4 }))).details?.["reason"], "unsafe_source_name", name);
    assert.equal(tr.world.hasEarsTrack(), false);
  }
});

test("F2: for a return the lettered form is tried first", async () => {
  const r = rig((x) => { x.world.returns[0]!.name = "Reverb"; x.world.returnPrefix = true; x.world.tracks.push(track("Reverb")); });
  await run(r, { source: { kind: "return", index: 0 }, beats: 4 });
  assert.equal((r.world.mutations()[1]?.args as { input_type: string }).input_type, "A-Reverb");
});

test("F3: a track named like the external input, armed on that input, is refused by the server pre-check", async () => {
  const r = rig((x) => { x.world.tracks[2]!.name = "Ext. In"; x.world.tracks[2]!.arm = true; });
  const error = await fails(run(r));
  assert.equal(error.details?.["reason"], "external_input_live");
  assert.deepEqual(mutationNames(r), []);
});

test("F6: the ears track at a shifted index (a track inserted before it): nothing is deleted and the owner is told", async () => {
  const r = rig((x) => { x.world.afterCall = (cmd) => { if (cmd === "clip_get") x.world.tracks.splice(0, 0, track("Inserted")); }; });
  const outcome = await run(r);
  assert.equal(outcome.cleanup, "failed");
  assert.ok(outcome.warnings.includes("cleanup_identity_mismatch"));
  assert.equal(r.world.names("track_delete").length, 0);
  assert.equal(r.world.hasEarsTrack(), true);
});

test("F7: a refusal code that arrives with an unknown outcome still sends cleanup looking for the track", async () => {
  for (const code of ["edition_limit", "invalid_args", "not_supported", "out_of_range"]) {
    const r = rig((x) => { x.world.failures.push({ cmd: "track_create", applied: true, outcomeUnknown: true, error: { code } }); });
    await fails(run(r));
    assert.equal(r.world.hasEarsTrack(), false, code);
    assert.equal(r.world.mutations().filter((c) => c.cmd === "track_delete").length, 1, code);
  }
  const plain = rig((x) => { x.world.failures.push({ cmd: "track_create", error: { code: "edition_limit" } }); });
  await fails(run(plain));
  assert.equal(plain.world.names("track_delete").length, 0, "a plain refusal means nothing was created");
});
