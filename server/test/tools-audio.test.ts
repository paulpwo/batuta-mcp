import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { validateSampleFile } from "../src/tools/audio-path.js";
import { ToolError } from "../src/mcp/index.js";
import { FakeWorld } from "./helpers/fake-world.js";
import { startRig } from "./helpers/tools-harness.js";
import type { Json } from "./helpers/mcp-client.js";

/** audio_clip_create: the server validates the file and sends only its own realpath (docs/01-protocol.md sections 7.6 and 10.5). */

const made: string[] = [];
after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });

/** A short real directory under /tmp (macOS: /tmp is a symlink to /private/tmp, which the realpath logic must handle). */
function tmpDir(prefix = "bm-au-"): string {
  const dir = fs.mkdtempSync(`/tmp/${prefix}`);
  fs.chmodSync(dir, 0o755);
  made.push(dir);
  return dir;
}

function wav(seconds: number, rate = 44100, channels = 1, bits = 16): Buffer {
  const frames = Math.round(seconds * rate);
  const block = channels * (bits / 8);
  const data = Buffer.alloc(frames * block);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(36 + data.length, 4); head.write("WAVE", 8);
  head.write("fmt ", 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(channels, 22);
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * block, 28); head.writeUInt16LE(block, 32); head.writeUInt16LE(bits, 34);
  head.write("data", 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

/** AIFF with an 80-bit extended sample rate. */
function aiff(seconds: number, rate = 48000, channels = 2, bits = 16): Buffer {
  const frames = Math.round(seconds * rate);
  const comm = Buffer.alloc(8 + 18);
  comm.write("COMM", 0); comm.writeUInt32BE(18, 4); comm.writeUInt16BE(channels, 8); comm.writeUInt32BE(frames, 10); comm.writeUInt16BE(bits, 14);
  const exponent = Math.floor(Math.log2(rate));
  comm.writeUInt16BE(16383 + exponent, 16);
  const mantissa = BigInt(Math.round(rate * 2 ** (63 - exponent)));
  comm.writeBigUInt64BE(mantissa, 18);
  const ssnd = Buffer.alloc(8 + 8 + frames * channels * (bits / 8));
  ssnd.write("SSND", 0); ssnd.writeUInt32BE(ssnd.length - 8, 4);
  const form = Buffer.alloc(12);
  form.write("FORM", 0); form.writeUInt32BE(4 + comm.length + ssnd.length, 4); form.write("AIFF", 8);
  return Buffer.concat([form, comm, ssnd]);
}

function reject(call: () => unknown, reason: string): void {
  try {
    call();
  } catch (error) {
    assert.ok(error instanceof ToolError, String(error));
    assert.equal(error.details?.["reason"], reason, `${error.message}`);
    return;
  }
  assert.fail(`expected a ToolError with reason ${reason}`);
}

function setup(): { root: string; elsewhere: string } {
  const root = tmpDir();
  const elsewhere = tmpDir("bm-out-");
  return { root, elsewhere };
}

// ---------------------------------------------------------------- the validator

test("a plain file under a root validates: realpath, extension, size and the header duration", () => {
  const { root } = setup();
  const file = path.join(root, "kick.wav");
  fs.writeFileSync(file, wav(2));
  const found = validateSampleFile(file, { roots: [root] });
  assert.equal(found.realPath, fs.realpathSync(file));
  assert.equal(found.extension, ".wav");
  assert.ok(Math.abs((found.durationSeconds ?? 0) - 2) < 1e-6);
  assert.equal(found.size, 44 + 88200 * 2);
});

test("AIFF headers (80-bit sample rate) and uppercase extensions are understood", () => {
  const { root } = setup();
  const file = path.join(root, "loop.AIF");
  fs.writeFileSync(file, aiff(1.5, 48000));
  const found = validateSampleFile(file, { roots: [root] });
  assert.equal(found.extension, ".aif");
  assert.ok(Math.abs((found.durationSeconds ?? 0) - 1.5) < 1e-6);
});

test("flac and mp3 are accepted without a header (length unknown)", () => {
  const { root } = setup();
  for (const name of ["a.flac", "b.mp3"]) {
    fs.writeFileSync(path.join(root, name), Buffer.from("not parsed"));
    assert.equal(validateSampleFile(path.join(root, name), { roots: [root] }).durationSeconds, null);
  }
});

test("paths outside the roots are refused: elsewhere, traversal, and a symlink that leads out", () => {
  const { root, elsewhere } = setup();
  fs.writeFileSync(path.join(elsewhere, "secret.wav"), wav(1));
  reject(() => validateSampleFile(path.join(elsewhere, "secret.wav"), { roots: [root] }), "outside_sample_roots");
  reject(() => validateSampleFile(`${root}/../${path.basename(elsewhere)}/secret.wav`, { roots: [root] }), "outside_sample_roots");
  fs.symlinkSync(path.join(elsewhere, "secret.wav"), path.join(root, "link.wav"));
  reject(() => validateSampleFile(path.join(root, "link.wav"), { roots: [root] }), "outside_sample_roots");
  fs.symlinkSync(elsewhere, path.join(root, "dirlink"));
  reject(() => validateSampleFile(path.join(root, "dirlink", "secret.wav"), { roots: [root] }), "outside_sample_roots");
});

test("a symlink that stays inside the root is followed and the REAL path is what is sent on", () => {
  const { root } = setup();
  fs.mkdirSync(path.join(root, "real"));
  fs.writeFileSync(path.join(root, "real", "a.wav"), wav(1));
  fs.symlinkSync(path.join(root, "real", "a.wav"), path.join(root, "alias.wav"));
  const found = validateSampleFile(path.join(root, "alias.wav"), { roots: [root] });
  assert.equal(found.realPath, fs.realpathSync(path.join(root, "real", "a.wav")));
});

test("a root with a name prefix of another directory does not leak (/x/Samples vs /x/Samples-private)", () => {
  const { root } = setup();
  const sibling = `${root}-private`;
  fs.mkdirSync(sibling);
  made.push(sibling);
  fs.chmodSync(sibling, 0o755);
  fs.writeFileSync(path.join(sibling, "a.wav"), wav(1));
  reject(() => validateSampleFile(path.join(sibling, "a.wav"), { roots: [root] }), "outside_sample_roots");
});

test("roots must be real directories owned by the user without group or other write access", () => {
  const { root, elsewhere } = setup();
  fs.writeFileSync(path.join(root, "a.wav"), wav(1));
  fs.chmodSync(root, 0o775);
  reject(() => validateSampleFile(path.join(root, "a.wav"), { roots: [root] }), "sample_root_unsafe");
  fs.chmodSync(root, 0o757);
  reject(() => validateSampleFile(path.join(root, "a.wav"), { roots: [root] }), "sample_root_unsafe");
  fs.chmodSync(root, 0o755);
  assert.ok(validateSampleFile(path.join(root, "a.wav"), { roots: [root] }));
  reject(() => validateSampleFile(path.join(root, "a.wav"), { roots: [root], uid: (process.getuid?.() ?? 0) + 1 }), "sample_root_unsafe");
  fs.symlinkSync(root, path.join(elsewhere, "rootlink"));
  reject(() => validateSampleFile(path.join(elsewhere, "rootlink", "a.wav"), { roots: [path.join(elsewhere, "rootlink")] }), "sample_root_unsafe");
  reject(() => validateSampleFile(path.join(root, "a.wav"), { roots: [path.join(root, "missing")] }), "sample_root_unsafe");
  assert.ok(validateSampleFile(path.join(root, "a.wav"), { roots: [] }), "no roots means no root restriction");
});

test("the file must be a regular file owned by the user with an allowed extension and size", () => {
  const { root } = setup();
  fs.mkdirSync(path.join(root, "dir.wav"));
  reject(() => validateSampleFile(path.join(root, "dir.wav"), { roots: [root] }), "not_regular_file");
  fs.writeFileSync(path.join(root, "a.wav"), wav(1));
  reject(() => validateSampleFile(path.join(root, "a.wav"), { roots: [root], uid: (process.getuid?.() ?? 0) + 1 }), "sample_root_unsafe");
  for (const name of ["x.txt", "x.als", "x.amxd", "x", "x.wav.exe"]) {
    fs.writeFileSync(path.join(root, name), Buffer.from("data"));
    reject(() => validateSampleFile(path.join(root, name), { roots: [root] }), "bad_extension");
  }
  reject(() => validateSampleFile(path.join(root, "a.wav"), { roots: [root], maxBytes: 100 }), "file_too_large");
  fs.writeFileSync(path.join(root, "empty.flac"), Buffer.alloc(0));
  reject(() => validateSampleFile(path.join(root, "empty.flac"), { roots: [root] }), "empty_file");
  reject(() => validateSampleFile(path.join(root, "gone.wav"), { roots: [root] }), "file_not_found");
});

test("the file itself must belong to the user, and a symlink swapped in before the open is not followed", () => {
  const { root } = setup();
  const file = path.join(root, "a.wav");
  fs.writeFileSync(file, wav(1));
  reject(() => validateSampleFile(file, { roots: [root], fileUid: (process.getuid?.() ?? 0) + 1 }), "not_owned");
  const other = path.join(root, "b.wav");
  fs.writeFileSync(other, wav(1));
  reject(() => validateSampleFile(file, {
    roots: [root],
    hooks: { beforeOpen: () => { fs.rmSync(file); fs.symlinkSync(other, file); } },
  }), "not_regular_file");
});

test("path shape: absolute, no NUL, at most 1024 bytes", () => {
  const { root } = setup();
  reject(() => validateSampleFile("relative/a.wav", { roots: [root] }), "not_absolute");
  reject(() => validateSampleFile(`${root}/a\u0000.wav`, { roots: [root] }), "bad_path");
  reject(() => validateSampleFile(`${root}/${"a".repeat(1100)}.wav`, { roots: [root] }), "bad_path");
});

test("malformed WAV and AIFF headers are refused", () => {
  const { root } = setup();
  const good = wav(1);
  const cases: Array<[string, Buffer]> = [
    ["short.wav", good.subarray(0, 20)],
    ["noriff.wav", Buffer.concat([Buffer.from("XXXX"), good.subarray(4)])],
    ["nofmt.wav", Buffer.concat([good.subarray(0, 12), Buffer.from("junk"), Buffer.alloc(40)])],
    ["zero.aif", Buffer.from("FORM\u0000\u0000\u0000\u0004AIFF")],
  ];
  for (const [name, bytes] of cases) {
    fs.writeFileSync(path.join(root, name), bytes);
    reject(() => validateSampleFile(path.join(root, name), { roots: [root] }), "bad_header");
  }
  const zeroRate = Buffer.from(good);
  zeroRate.writeUInt32LE(0, 24);
  fs.writeFileSync(path.join(root, "rate.wav"), zeroRate);
  reject(() => validateSampleFile(path.join(root, "rate.wav"), { roots: [root] }), "bad_header");
});

test("a file swapped between open and the final check is refused (dev/ino of the open file must match the path)", () => {
  const { root } = setup();
  const file = path.join(root, "a.wav");
  fs.writeFileSync(file, wav(1));
  reject(() => validateSampleFile(file, {
    roots: [root],
    hooks: { afterOpen: () => { fs.renameSync(file, path.join(root, "old.wav")); fs.writeFileSync(file, wav(1)); } },
  }), "file_changed");
});

// ---------------------------------------------------------------- correction round T5b-fix

const fifo = (file: string): void => { execFileSync("/usr/bin/mkfifo", [file]); };

test("MINOR 5: a FIFO named x.wav is refused as not a regular file, without ever blocking on an open", () => {
  const { root } = setup();
  const file = path.join(root, "x.wav");
  fifo(file);
  reject(() => validateSampleFile(file, { roots: [root] }), "not_regular_file");
  // A named pipe behind a symlink inside the root is the same thing once resolved.
  fs.symlinkSync(file, path.join(root, "alias.wav"));
  reject(() => validateSampleFile(path.join(root, "alias.wav"), { roots: [root] }), "not_regular_file");
});

test("MINOR 5: a regular file swapped for a FIFO between the check and the open is refused (O_NONBLOCK), not waited on", () => {
  const { root } = setup();
  const file = path.join(root, "x.wav");
  fs.writeFileSync(file, wav(1));
  reject(() => validateSampleFile(file, {
    roots: [root],
    hooks: { beforeOpen: () => { fs.rmSync(file); fifo(file); } },
  }), "not_regular_file");
});

test("MINOR 6: every directory between the root and the file must be owned by the user without group or other write", () => {
  const { root } = setup();
  fs.mkdirSync(path.join(root, "a"));
  fs.mkdirSync(path.join(root, "a", "b"));
  const file = path.join(root, "a", "b", "kick.wav");
  fs.writeFileSync(file, wav(1));
  assert.ok(validateSampleFile(file, { roots: [root] }));
  for (const dir of [path.join(root, "a"), path.join(root, "a", "b")]) {
    for (const mode of [0o775, 0o757, 0o777]) {
      fs.chmodSync(dir, mode);
      reject(() => validateSampleFile(file, { roots: [root] }), "directory_unsafe");
    }
    fs.chmodSync(dir, 0o755);
  }
  assert.ok(validateSampleFile(file, { roots: [root] }));
  reject(() => validateSampleFile(file, { roots: [root], dirUid: (process.getuid?.() ?? 0) + 1 }), "directory_unsafe");
  // A file directly in the root has no directory in between.
  fs.writeFileSync(path.join(root, "top.wav"), wav(1));
  assert.ok(validateSampleFile(path.join(root, "top.wav"), { roots: [root], dirUid: (process.getuid?.() ?? 0) + 1 }));
});

test("MINOR 6: the path must still resolve to the same place after the open (a directory swapped for a symlink)", () => {
  const { root } = setup();
  fs.mkdirSync(path.join(root, "sub"));
  const file = path.join(root, "sub", "a.wav");
  fs.writeFileSync(file, wav(1));
  reject(() => validateSampleFile(file, {
    roots: [root],
    hooks: { afterOpen: () => { fs.renameSync(path.join(root, "sub"), path.join(root, "sub2")); fs.symlinkSync(path.join(root, "sub2"), path.join(root, "sub")); } },
  }), "file_changed");
});

test("MINOR 6: a file with more than one hard link is refused", () => {
  const { root } = setup();
  const file = path.join(root, "a.wav");
  fs.writeFileSync(file, wav(1));
  fs.linkSync(file, path.join(root, "b.wav"));
  reject(() => validateSampleFile(file, { roots: [root] }), "hard_linked");
  reject(() => validateSampleFile(path.join(root, "b.wav"), { roots: [root] }), "hard_linked");
  fs.rmSync(path.join(root, "b.wav"));
  assert.ok(validateSampleFile(file, { roots: [root] }));
});

test("M22: the identity of the file is checked again after the header was parsed", () => {
  const { root } = setup();
  const file = path.join(root, "a.wav");
  fs.writeFileSync(file, wav(1));
  reject(() => validateSampleFile(file, {
    roots: [root],
    hooks: { afterParse: () => { fs.renameSync(file, path.join(root, "old.wav")); fs.writeFileSync(file, wav(1)); } },
  }), "file_changed");
  // And the same swap after the open is caught by the first check.
  const other = path.join(root, "b.wav");
  fs.writeFileSync(other, wav(1));
  reject(() => validateSampleFile(other, {
    roots: [root],
    hooks: { afterOpen: () => { fs.renameSync(other, path.join(root, "old2.wav")); fs.writeFileSync(other, wav(1)); } },
  }), "file_changed");
});

// ---------------------------------------------------------------- the tool

async function rig(root: string, extra: Json = {}) {
  const w = new FakeWorld();
  w.tempo = 120;
  return startRig({
    config: { sampleRoots: [root], allowAudioImport: true, ...extra } as never,
    answers: { ...w.answers(), audio_clip_create: (_args: Json) => ({ clip: { name: "ok" } }) },
    echo: true,
  });
}

const AUDIO_TRACK = { kind: "track", index: 1 };

test("hello tells the script that audio import is enabled by default, with or without sample roots", async () => {
  const { root } = setup();
  const on = await rig(root);
  assert.equal(on.script.hellos[0].allow_audio_import, true);
  await on.close();
  const plain = await startRig({ answers: {}, echo: true });
  assert.equal(plain.script.hellos[0].allow_audio_import, true);
  await plain.close();
});

test("without sample roots any audio file anywhere is accepted, other checks still apply", () => {
  const { root, elsewhere } = setup();
  fs.writeFileSync(path.join(elsewhere, "free.wav"), wav(1));
  const found = validateSampleFile(path.join(elsewhere, "free.wav"), { roots: [] });
  assert.equal(found.realPath, fs.realpathSync(path.join(elsewhere, "free.wav")));
  fs.writeFileSync(path.join(elsewhere, "notes.txt"), "x");
  reject(() => validateSampleFile(path.join(elsewhere, "notes.txt"), { roots: [] }), "bad_extension");
  reject(() => validateSampleFile("relative/free.wav", { roots: [] }), "not_absolute");
  fs.mkdirSync(path.join(elsewhere, "dir.wav"));
  reject(() => validateSampleFile(path.join(elsewhere, "dir.wav"), { roots: [] }), "not_regular_file");
  reject(() => validateSampleFile(path.join(elsewhere, "gone.wav"), { roots: [] }), "file_not_found");
  fs.writeFileSync(path.join(elsewhere, "bad.wav"), Buffer.from("not a wav file at all"));
  reject(() => validateSampleFile(path.join(elsewhere, "bad.wav"), { roots: [] }), "bad_header");
  // With a root set, the same file outside it is still refused.
  reject(() => validateSampleFile(path.join(elsewhere, "free.wav"), { roots: [root] }), "outside_sample_roots");
});

test("session form: the script receives the validated realpath, never the model's string", async () => {
  const { root } = setup();
  fs.mkdirSync(path.join(root, "real"));
  fs.writeFileSync(path.join(root, "real", "kick.wav"), wav(1));
  fs.symlinkSync(path.join(root, "real"), path.join(root, "alias"));
  const r = await rig(root);
  const result = await r.call("create_audio_clip", { track: AUDIO_TRACK, slot: 2, file_path: path.join(root, "alias", "kick.wav") });
  assert.equal(result.isError, false, JSON.stringify(result.structuredContent));
  assert.deepEqual(r.seen().filter((c) => c.cmd === "audio_clip_create").map((c) => c.args), [
    { track: { ...AUDIO_TRACK, expect_name: "Bass" }, slot: 2, file_path: fs.realpathSync(path.join(root, "real", "kick.wav")) },
  ]);
  await r.close();
});

test("arrangement form: expected_length_beats is computed from the header duration and the tempo", async () => {
  const { root } = setup();
  fs.writeFileSync(path.join(root, "loop.wav"), wav(2, 44100, 2));
  fs.writeFileSync(path.join(root, "bar.aiff"), aiff(1.5, 48000));
  const r = await rig(root);
  await r.call("create_audio_clip", { track: AUDIO_TRACK, position: 16, file_path: path.join(root, "loop.wav") });
  await r.call("create_audio_clip", { track: AUDIO_TRACK, position: 0, file_path: path.join(root, "bar.aiff") });
  const sent = r.seen().filter((c) => c.cmd === "audio_clip_create").map((c) => c.args);
  assert.equal(sent[0]!["expected_length_beats"], 4, "2 s at 120 BPM");
  assert.equal(sent[1]!["expected_length_beats"], 3, "1.5 s at 120 BPM");
  assert.equal(sent[0]!["position"], 16);
  assert.equal("allow_overwrite" in sent[0]!, false);
  await r.close();
});

test("arrangement form with a format whose length is unknown needs allow_overwrite, which is destructive", async () => {
  const { root } = setup();
  fs.writeFileSync(path.join(root, "song.mp3"), Buffer.from("mp3"));
  const r = await rig(root, { confirm: "destructive" });
  const refused = await r.call("create_audio_clip", { track: AUDIO_TRACK, position: 0, file_path: path.join(root, "song.mp3") });
  assert.equal(refused.structuredContent.code, "invalid_args");
  assert.equal(refused.structuredContent.details.reason, "length_unknown");
  const withFlag = await r.call("create_audio_clip", { track: AUDIO_TRACK, position: 0, file_path: path.join(root, "song.mp3"), allow_overwrite: true });
  assert.equal(withFlag.structuredContent.confirmation_required, true, "overwriting needs confirmation");
  assert.deepEqual(r.seen().filter((c) => c.cmd === "audio_clip_create"), []);
  await r.close();
});

test("allow_overwrite on a header format needs confirmation too, and a plain call does not", async () => {
  const { root } = setup();
  fs.writeFileSync(path.join(root, "loop.wav"), wav(1));
  const r = await rig(root, { confirm: "destructive" });
  assert.equal((await r.call("create_audio_clip", { track: AUDIO_TRACK, position: 0, file_path: path.join(root, "loop.wav") })).isError, false);
  const pending = await r.call("create_audio_clip", { track: AUDIO_TRACK, position: 0, file_path: path.join(root, "loop.wav"), allow_overwrite: true });
  assert.equal(pending.structuredContent.confirmation_required, true);
  assert.match(pending.structuredContent.summary, /^Import an audio file as a clip: .*position=0.*\(overwrites existing content/);
  assert.ok(!pending.structuredContent.summary.includes(root), "the summary does not carry the model's path string");
  await r.close();
});

test("invalid paths are refused before anything is sent, with a reason", async () => {
  const { root, elsewhere } = setup();
  fs.writeFileSync(path.join(elsewhere, "x.wav"), wav(1));
  const r = await rig(root);
  const outside = await r.call("create_audio_clip", { track: AUDIO_TRACK, slot: 0, file_path: path.join(elsewhere, "x.wav") });
  assert.equal(outside.structuredContent.code, "invalid_args");
  assert.equal(outside.structuredContent.details.reason, "outside_sample_roots");
  assert.doesNotMatch(JSON.stringify(outside.structuredContent), new RegExp(elsewhere.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the refusal does not echo the path");
  const both = await r.call("create_audio_clip", { track: AUDIO_TRACK, slot: 0, position: 1, file_path: path.join(root, "x.wav") });
  assert.equal(both.structuredContent.details.reason, "form");
  const sessionOverwrite = await r.call("create_audio_clip", { track: AUDIO_TRACK, slot: 0, allow_overwrite: false, file_path: path.join(root, "x.wav") });
  assert.equal(sessionOverwrite.structuredContent.details.reason, "form", "allow_overwrite belongs to the arrangement form");
  const neither = await r.call("create_audio_clip", { track: AUDIO_TRACK, file_path: path.join(root, "x.wav") });
  assert.equal(neither.structuredContent.details.reason, "form");
  assert.deepEqual(r.seen().filter((c) => c.cmd === "audio_clip_create"), []);
  await r.close();
});

test("create_audio_clip takes the compatibility names (track_index, clip_index, path) with the same path validation", async () => {
  const { root, elsewhere } = setup();
  fs.writeFileSync(path.join(elsewhere, "x.wav"), wav(1));
  fs.writeFileSync(path.join(root, "ok.wav"), wav(1));
  const r = await rig(root);
  const bad = await r.call("create_audio_clip", { track_index: 0, clip_index: 0, path: path.join(elsewhere, "x.wav") });
  assert.equal(bad.structuredContent.details.reason, "outside_sample_roots");
  assert.deepEqual(r.seen().filter((c) => c.cmd === "audio_clip_create"), []);
  const good = await r.call("create_audio_clip", { track_index: 0, clip_index: 2, path: path.join(root, "ok.wav") });
  assert.equal(good.isError, false, JSON.stringify(good.structuredContent));
  const wire = r.seen().find((c) => c.cmd === "audio_clip_create")!.args;
  assert.equal(wire["file_path"], fs.realpathSync(path.join(root, "ok.wav")), "only the validated realpath is sent");
  assert.equal(wire["slot"], 2);
  assert.equal("path" in wire || "track_index" in wire || "clip_index" in wire, false, "no compat name reaches the script");
  const mixed = await r.call("create_audio_clip", { track_index: 0, clip_index: 0, path: path.join(root, "ok.wav"), file_path: path.join(root, "ok.wav") });
  assert.equal(mixed.isError, true);
  await r.close();
});

test("batch ops go through the same path validation", async () => {
  const { root, elsewhere } = setup();
  fs.writeFileSync(path.join(elsewhere, "x.wav"), wav(1));
  fs.writeFileSync(path.join(root, "ok.wav"), wav(1));
  const r = await rig(root);
  const bad = await r.call("batch", { ops: [{ cmd: "create_audio_clip", args: { track: AUDIO_TRACK, slot: 0, file_path: path.join(elsewhere, "x.wav") } }] });
  assert.equal(bad.structuredContent.details.reason, "outside_sample_roots");
  const good = await r.call("batch", { ops: [{ cmd: "create_audio_clip", args: { track: AUDIO_TRACK, slot: 0, file_path: path.join(root, "ok.wav") } }] });
  assert.equal(good.isError, false);
  const op = (r.seen().find((c) => c.cmd === "batch")!.args["ops"] as Json[])[0]!;
  assert.equal((op["args"] as Json)["file_path"], fs.realpathSync(path.join(root, "ok.wav")));
  await r.close();
});
