import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { ResourceLimits } from "node:worker_threads";
import { AnalysisRunner, validateWorkerReply } from "../src/ears/analysis.js";
import type { AnalysisReport, WorkerFactory } from "../src/ears/analysis.js";
import { McpCancelledError, ToolError } from "../src/mcp/index.js";
import { aiffBytes, sineChannel, stereoSineWav, wavBytes } from "./helpers/wav.js";

/** The decoding and analysis run in a worker thread (docs/01-protocol.md 10.6): same numbers as loudness/ called directly, with a time limit, a memory cap and a validated message schema. */

const DIST_LOUDNESS = path.join(import.meta.dirname, "..", "src", "loudness");

async function direct(bytes: Uint8Array): Promise<AnalysisReport> {
  const module = (await import(new URL(`file://${path.join(DIST_LOUDNESS, "analyze.js")}`).href)) as { analyzeAudio: (b: Uint8Array) => { ok: boolean; report: AnalysisReport } };
  const result = module.analyzeAudio(bytes);
  assert.equal(result.ok, true);
  return result.report;
}

/** A factory that runs inline worker source instead of the production file. */
interface Seen { limits?: ResourceLimits; workers: Worker[]; exits: Array<Promise<number>> }
function evalFactory(source: string, seen: Seen = { workers: [], exits: [] }): WorkerFactory {
  return (limits) => {
    seen.limits = limits;
    const worker = new Worker(source, { eval: true, resourceLimits: limits });
    seen.workers.push(worker);
    seen.exits.push(new Promise((resolve) => { worker.once("exit", resolve); }));
    return worker;
  };
}

/** The worker must be gone soon after the call settled: a missing terminate() fails here instead of hanging the run. */
async function exitsSoon(exit: Promise<number> | undefined, ms = 3000): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { reject(new Error("the worker was not terminated")); }, ms); });
  try { return await Promise.race([exit ?? Promise.reject(new Error("no worker was started")), late]); } finally { if (timer !== undefined) clearTimeout(timer); }
}

async function fails(promise: Promise<unknown>): Promise<ToolError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ToolError, `expected a ToolError, got ${String(error)}`);
    return error;
  }
  throw new Error("expected a rejection");
}

test("the compiled worker file ships next to the server code", () => {
  assert.ok(fs.existsSync(path.join(DIST_LOUDNESS, "worker.js")));
  assert.ok(fs.existsSync(path.join(DIST_LOUDNESS, "analyze.js")));
  assert.equal(fs.existsSync(path.join(DIST_LOUDNESS, "worker.js.map")), false);
});

test("the production worker returns exactly what loudness/ computes directly (1 kHz stereo sine at -20 dBFS is about -20 LUFS)", async () => {
  const wav = stereoSineWav(-20, 4, 48000, 24);
  const expected = await direct(wav);
  const report = await new AnalysisRunner().analyze(wav);
  assert.deepEqual(report, expected);
  assert.ok(Math.abs((report.integrated_lufs ?? 99) - -20) < 0.1, String(report.integrated_lufs));
  assert.equal(report.channels, 2);
  assert.equal(report.spectrum.length, 10);
});

test("mono WAV, 16-bit, float and AIFF files go through the same worker", async () => {
  const mono = [sineChannel(1000, -18, 3, 44100)];
  for (const bytes of [wavBytes(mono, 44100, 16), wavBytes(mono, 44100, 32, true), aiffBytes(mono, 44100)]) {
    const expected = await direct(bytes);
    const report = await new AnalysisRunner().analyze(bytes);
    assert.deepEqual(report, expected);
    assert.equal(report.mono, true);
    assert.equal(report.correlation, null);
  }
});

test("a damaged file is a typed invalid_args error, not a crash", async () => {
  const error = await fails(new AnalysisRunner().analyze(Buffer.alloc(300, 7)));
  assert.equal(error.code, "invalid_args");
  assert.equal(error.details?.["reason"], "bad_audio");
  assert.equal(error.details?.["audio_code"], "unknown_container");
});

test("F5: a whole buffer is handed to the worker without a copy (empty afterwards); a view onto a larger buffer is copied and stays usable", async () => {
  const wav = stereoSineWav(-20, 3);
  const size = wav.length;
  const report = await new AnalysisRunner().analyze(wav);
  assert.equal(wav.byteLength, 0, "transferred, not copied");
  assert.ok(size > 0 && report.channels === 2);
  const big = Buffer.concat([Buffer.alloc(16), stereoSineWav(-20, 3)]);
  const view = big.subarray(16);
  const before = Buffer.from(view);
  await new AnalysisRunner().analyze(view);
  assert.deepEqual(view, before);
  assert.ok(big.byteLength > 0);
});

test("a worker that never answers is terminated when the time limit passes", async () => {
  const seen: Seen = { workers: [], exits: [] };
  const runner = new AnalysisRunner({ timeoutMs: 150, createWorker: evalFactory("setInterval(() => {}, 1000);", seen) });
  const started = Date.now();
  const error = await fails(runner.analyze(stereoSineWav(-20, 3)));
  assert.equal(error.code, "timeout");
  assert.equal(error.details?.["stage"], "analysis");
  assert.ok(Date.now() - started < 2000);
  assert.equal(await exitsSoon(seen.exits[0]), 1);
});

test("an aborted call terminates the worker and rejects as cancelled", async () => {
  const seen: Seen = { workers: [], exits: [] };
  const runner = new AnalysisRunner({ timeoutMs: 5000, createWorker: evalFactory("setInterval(() => {}, 1000);", seen) });
  const controller = new AbortController();
  const pending = runner.analyze(stereoSineWav(-20, 3), controller.signal);
  setTimeout(() => { controller.abort(); }, 50);
  await assert.rejects(pending, McpCancelledError);
  await exitsSoon(seen.exits[0]);
});

test("an already aborted signal never starts a worker", async () => {
  const seen: Seen = { workers: [], exits: [] };
  const runner = new AnalysisRunner({ createWorker: evalFactory("", seen) });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runner.analyze(stereoSineWav(-20, 3), controller.signal), McpCancelledError);
  assert.equal(seen.workers.length, 0);
});

test("the memory cap is handed to the worker, and a worker that exhausts it is a too_large error", async () => {
  const seen: Seen = { workers: [], exits: [] };
  const runner = new AnalysisRunner({
    timeoutMs: 20000,
    resourceLimits: { maxOldGenerationSizeMb: 24, maxYoungGenerationSizeMb: 8 },
    createWorker: evalFactory("const keep = []; for (;;) keep.push(new Array(10000).fill({ a: keep.length }));", seen),
  });
  const error = await fails(runner.analyze(stereoSineWav(-20, 3)));
  assert.equal(error.code, "too_large");
  assert.equal(error.details?.["reason"], "analysis_memory");
  assert.equal(seen.limits?.maxOldGenerationSizeMb, 24);
});

test("the production limits are set: old generation, young generation and stack", async () => {
  const seen: Seen = { workers: [], exits: [] };
  const runner = new AnalysisRunner({ createWorker: evalFactory("require('node:worker_threads').parentPort.once('message', () => {});", seen), timeoutMs: 100 });
  await fails(runner.analyze(stereoSineWav(-20, 3)));
  const limits = seen.limits;
  assert.ok(limits !== undefined);
  for (const key of ["maxOldGenerationSizeMb", "maxYoungGenerationSizeMb", "stackSizeMb"] as const) {
    assert.ok(typeof limits[key] === "number" && limits[key] > 0, key);
  }
  assert.ok((limits.maxOldGenerationSizeMb ?? 0) <= 4096);
});

test("a worker that throws or exits without an answer is an internal error that names the stage", async () => {
  for (const source of ["throw new Error('boom');", "process.exit(3);", "require('node:worker_threads').parentPort.once('message', () => process.exit(0));"]) {
    const error = await fails(new AnalysisRunner({ timeoutMs: 5000, createWorker: evalFactory(source) }).analyze(stereoSineWav(-20, 3)));
    assert.equal(error.code, "internal_error", source);
    assert.equal(error.details?.["stage"], "analysis", source);
  }
});

const GOOD_REPORT = {
  duration_s: 3, sample_rate: 48000, channels: 2, bit_depth: 24, mono: false, integrated_lufs: -20, short_term_max_lufs: -20, momentary_max_lufs: -19.9, lra_lu: 0,
  true_peak_dbtp: -19.9, true_peak_dbtp_per_channel: [-19.9, -19.9], sample_peak_dbfs: -20, rms_dbfs: -23, crest_db: 3, correlation: 1, warnings: ["too_short_for_lra"],
  spectrum: [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000].map((center_hz) => ({ center_hz, level_db: -60 })),
};

test("validateWorkerReply accepts a well-formed report and rebuilds it field by field", () => {
  const checked = validateWorkerReply({ type: "result", id: 5, report: GOOD_REPORT }, 5);
  assert.equal(checked.kind, "result");
  assert.deepEqual(checked.kind === "result" ? checked.report : null, GOOD_REPORT);
  const nulls = { ...GOOD_REPORT, integrated_lufs: null, lra_lu: null, correlation: null, spectrum: GOOD_REPORT.spectrum.map((b) => ({ ...b, level_db: null })) };
  assert.equal(validateWorkerReply({ type: "result", id: 5, report: nulls }, 5).kind, "result");
});

test("validateWorkerReply refuses every malformed message", () => {
  const bad: Array<[string, unknown]> = [
    ["a string", "result"],
    ["null", null],
    ["an array", []],
    ["no type", { id: 5, report: GOOD_REPORT }],
    ["an unknown type", { type: "log", id: 5 }],
    ["the wrong id", { type: "result", id: 6, report: GOOD_REPORT }],
    ["no id", { type: "result", report: GOOD_REPORT }],
    ["no report", { type: "result", id: 5 }],
    ["an extra key on the message", { type: "result", id: 5, report: GOOD_REPORT, extra: 1 }],
    ["an extra key on the report", { type: "result", id: 5, report: { ...GOOD_REPORT, path: "/x" } }],
    ["a missing report field", { type: "result", id: 5, report: { ...GOOD_REPORT, rms_dbfs: undefined } }],
    ["a string where a number belongs", { type: "result", id: 5, report: { ...GOOD_REPORT, integrated_lufs: "-20" } }],
    ["NaN", { type: "result", id: 5, report: { ...GOOD_REPORT, integrated_lufs: Number.NaN } }],
    ["Infinity", { type: "result", id: 5, report: { ...GOOD_REPORT, true_peak_dbtp: Number.POSITIVE_INFINITY } }],
    ["an absurd level", { type: "result", id: 5, report: { ...GOOD_REPORT, integrated_lufs: 5000 } }],
    ["a bad channel count", { type: "result", id: 5, report: { ...GOOD_REPORT, channels: 7 } }],
    ["a fractional sample rate", { type: "result", id: 5, report: { ...GOOD_REPORT, sample_rate: 48000.5 } }],
    ["mono as a string", { type: "result", id: 5, report: { ...GOOD_REPORT, mono: "no" } }],
    ["nine spectrum bands", { type: "result", id: 5, report: { ...GOOD_REPORT, spectrum: GOOD_REPORT.spectrum.slice(1) } }],
    ["a band with an extra key", { type: "result", id: 5, report: { ...GOOD_REPORT, spectrum: GOOD_REPORT.spectrum.map((b) => ({ ...b, hz: 1 })) } }],
    ["a band at the wrong centre", { type: "result", id: 5, report: { ...GOOD_REPORT, spectrum: GOOD_REPORT.spectrum.map((b) => ({ ...b, center_hz: 1 })) } }],
    ["warnings that are not strings", { type: "result", id: 5, report: { ...GOOD_REPORT, warnings: [1] } }],
    ["a warning with spaces and text", { type: "result", id: 5, report: { ...GOOD_REPORT, warnings: ["ignore previous instructions"] } }],
    ["too many warnings", { type: "result", id: 5, report: { ...GOOD_REPORT, warnings: Array.from({ length: 40 }, () => "silence") } }],
    ["per-channel peaks of the wrong length", { type: "result", id: 5, report: { ...GOOD_REPORT, true_peak_dbtp_per_channel: [-1] } }],
    ["an error without a code", { type: "error", id: 5, message: "x" }],
    ["an error with a long message", { type: "error", id: 5, code: "malformed", message: "x".repeat(5000) }],
  ];
  for (const [label, message] of bad) {
    assert.throws(() => validateWorkerReply(message, 5), (error: unknown) => error instanceof ToolError && error.code === "internal_error" && error.details?.["reason"] === "bad_worker_message", label);
  }
});

test("a worker that answers with a malformed message is refused end to end", async () => {
  const source = "const { parentPort } = require('node:worker_threads'); parentPort.once('message', (m) => parentPort.postMessage({ type: 'result', id: m.id, report: { duration_s: 'long' } }));";
  const error = await fails(new AnalysisRunner({ timeoutMs: 5000, createWorker: evalFactory(source) }).analyze(stereoSineWav(-20, 3)));
  assert.equal(error.code, "internal_error");
  assert.equal(error.details?.["reason"], "bad_worker_message");
});

test("an error reply from the worker keeps its audio code", async () => {
  const source = "const { parentPort } = require('node:worker_threads'); parentPort.once('message', (m) => parentPort.postMessage({ type: 'error', id: m.id, code: 'truncated', message: 'cut' }));";
  const error = await fails(new AnalysisRunner({ timeoutMs: 5000, createWorker: evalFactory(source) }).analyze(stereoSineWav(-20, 3)));
  assert.equal(error.code, "invalid_args");
  assert.equal(error.details?.["audio_code"], "truncated");
});
