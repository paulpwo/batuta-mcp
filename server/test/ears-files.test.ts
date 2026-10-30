import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { liveRecordingRoots, openAudioFile } from "../src/ears/files.js";
import type { AudioFileOptions } from "../src/ears/files.js";
import { ToolError } from "../src/mcp/index.js";
import { aiffBytes, sineChannel, stereoSineWav, wavBytes } from "./helpers/wav.js";

/** File validation before anything is read (docs/01-protocol.md 10.5): one row per refusal. */

const created: string[] = [];
function scratch(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bm-ears-")));
  created.push(dir);
  return dir;
}
after(() => { for (const dir of created) fs.rmSync(dir, { recursive: true, force: true }); });

const uid = process.getuid?.() ?? 0;
const WAV = stereoSineWav(-20, 1, 48000, 16);

/** A home with Music/Proj/Samples/Recorded/take.wav, the shape Live writes. */
function setup(bytes: Buffer = WAV): { home: string; file: string; options: AudioFileOptions } {
  const home = scratch();
  const dir = path.join(home, "Music", "Proj", "Samples", "Recorded");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "take.wav");
  fs.writeFileSync(file, bytes);
  return { home, file, options: { home, roots: [], setRoots: [], maxBytes: 1 << 28 } };
}

function refusal(run: () => unknown): ToolError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof ToolError, `expected a ToolError, got ${String(error)}`);
    return error;
  }
  throw new Error("expected a refusal");
}

function reason(run: () => unknown): string {
  const error = refusal(run);
  assert.equal(error.code === "invalid_args" || error.code === "too_large", true, error.code);
  return String(error.details?.["reason"]);
}

test("a WAV in <home>/.../Samples/Recorded is accepted, with its layout and no copy of the path in messages", () => {
  const { file, options } = setup();
  const opened = openAudioFile(file, options);
  try {
    assert.equal(opened.realPath, file);
    assert.equal(opened.layout?.format, "wav");
    assert.equal(opened.layout?.channels, 2);
    assert.equal(opened.layout?.sampleRate, 48000);
    assert.equal(opened.layout?.bits, 16);
    assert.equal(opened.isComplete(), true);
    assert.equal(opened.readAll().length, WAV.length);
    assert.deepEqual(opened.readAll(), WAV);
  } finally { opened.close(); }
});

test("AIFF and uppercase extensions are accepted", () => {
  const aiff = setup(aiffBytes([sineChannel(1000, -20, 1, 44100)], 44100));
  const renamed = path.join(path.dirname(aiff.file), "take.AIFF");
  fs.renameSync(aiff.file, renamed);
  const opened = openAudioFile(renamed, aiff.options);
  assert.equal(opened.layout?.format, "aiff");
  assert.equal(opened.layout?.channels, 1);
  opened.close();
  const aif = path.join(path.dirname(renamed), "take.aif");
  fs.renameSync(renamed, aif);
  openAudioFile(aif, aiff.options).close();
});

test("roots: Samples/Recorded under home, under set_roots, an extra root, and Live's default recording folder", () => {
  const { home, file, options } = setup();
  const other = scratch();
  const elsewhere = path.join(other, "Set", "Samples", "Recorded");
  fs.mkdirSync(elsewhere, { recursive: true });
  const outside = path.join(elsewhere, "a.wav");
  fs.writeFileSync(outside, WAV);
  assert.equal(reason(() => openAudioFile(outside, options)), "outside_roots");
  openAudioFile(outside, { ...options, setRoots: [other] }).close();
  // any file under an extra root
  const plain = path.join(other, "plain.wav");
  fs.writeFileSync(plain, WAV);
  assert.equal(reason(() => openAudioFile(plain, { ...options, setRoots: [other] })), "outside_roots", "set_roots only admit a Samples/Recorded folder");
  openAudioFile(plain, { ...options, roots: [other] }).close();
  // the default recording folder of Live
  const live = liveRecordingRoots(home)[0] as string;
  fs.mkdirSync(path.join(live, "2026-10-27 120000 Temp Project"), { recursive: true });
  const temp = path.join(live, "2026-10-27 120000 Temp Project", "x.wav");
  fs.writeFileSync(temp, WAV);
  openAudioFile(temp, { ...options, roots: liveRecordingRoots(home) }).close();
  assert.equal(file.startsWith(home), true);
});

test("outside every root is refused: elsewhere in home, a folder called Recorded without Samples, a sibling with the same prefix", () => {
  const { home, options } = setup();
  const cases = [path.join(home, "Music", "loose.wav"), path.join(home, "Music", "Proj", "Recorded", "x.wav"), path.join(home, "Music", "Proj", "Samples", "Recorded", "deeper", "x.wav"), path.join(home, "Music", "Proj", "Samples", "Recorded2", "x.wav"), path.join(home, "Music", "Proj", "Samples", "Imported", "x.wav")];
  for (const file of cases) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, WAV);
    assert.equal(reason(() => openAudioFile(file, options)), "outside_roots", file);
  }
  assert.equal(reason(() => openAudioFile("/etc/hosts.wav", options)), "outside_roots", "existence outside the folders is not probed");
  assert.equal(reason(() => openAudioFile(path.join(home, "Music", "Proj", "Samples", "Recorded", "missing.wav"), options)), "file_not_found");
  const tmp = scratch();
  fs.writeFileSync(path.join(tmp, "x.wav"), WAV);
  assert.equal(reason(() => openAudioFile(path.join(tmp, "x.wav"), options)), "outside_roots");
});

test("a directory symlink that leads out of the roots is refused through its real path", () => {
  const { home, options } = setup();
  const target = scratch();
  fs.mkdirSync(path.join(target, "Samples", "Recorded"), { recursive: true });
  fs.writeFileSync(path.join(target, "Samples", "Recorded", "x.wav"), WAV);
  fs.symlinkSync(target, path.join(home, "Music", "link"));
  assert.equal(reason(() => openAudioFile(path.join(home, "Music", "link", "Samples", "Recorded", "x.wav"), options)), "outside_roots");
});

test("a symlink as the file itself is refused, whether it points inside or outside", () => {
  const { file, options } = setup();
  const inside = path.join(path.dirname(file), "alias.wav");
  fs.symlinkSync(file, inside);
  assert.equal(reason(() => openAudioFile(inside, options)), "symlink");
  const outside = path.join(path.dirname(file), "evil.wav");
  fs.symlinkSync("/etc/hosts", outside);
  assert.equal(reason(() => openAudioFile(outside, options)), "symlink");
  const dangling = path.join(path.dirname(file), "gone.wav");
  fs.symlinkSync("/nonexistent/none.wav", dangling);
  assert.equal(reason(() => openAudioFile(dangling, options)), "symlink");
});

test("a hard-linked file is refused (it may also live somewhere else)", () => {
  const { file, options } = setup();
  const twin = path.join(path.dirname(file), "twin.wav");
  fs.linkSync(file, twin);
  assert.equal(reason(() => openAudioFile(file, options)), "hard_linked");
  assert.equal(reason(() => openAudioFile(twin, options)), "hard_linked");
});

test("a FIFO named like a WAV is refused without blocking; so are directories", () => {
  const { file, options } = setup();
  const fifo = path.join(path.dirname(file), "pipe.wav");
  const made = spawnSync("/usr/bin/mkfifo", [fifo]);
  assert.equal(made.status, 0);
  const started = Date.now();
  assert.equal(reason(() => openAudioFile(fifo, options)), "not_regular_file");
  assert.ok(Date.now() - started < 1000, "must not wait for a writer");
  const dir = path.join(path.dirname(file), "folder.wav");
  fs.mkdirSync(dir);
  assert.equal(reason(() => openAudioFile(dir, options)), "not_regular_file");
});

test("size limits: too big, empty and header-sized files", () => {
  const { file, options } = setup();
  assert.equal(reason(() => openAudioFile(file, { ...options, maxBytes: WAV.length - 1 })), "file_too_large");
  openAudioFile(file, { ...options, maxBytes: WAV.length }).close();
  const empty = path.join(path.dirname(file), "empty.wav");
  fs.writeFileSync(empty, Buffer.alloc(0));
  assert.equal(reason(() => openAudioFile(empty, options)), "too_small");
  const tiny = path.join(path.dirname(file), "tiny.wav");
  fs.writeFileSync(tiny, WAV.subarray(0, 44));
  assert.equal(reason(() => openAudioFile(tiny, options)), "too_small");
});

test("the extension decides first: mp3, flac, none, double extensions", () => {
  const { file, options } = setup();
  for (const name of ["a.mp3", "a.flac", "a", "a.wav.exe", "a.wavx", ".wav.bak", "a.aif.txt"]) {
    const target = path.join(path.dirname(file), name);
    fs.writeFileSync(target, WAV);
    assert.equal(reason(() => openAudioFile(target, options)), "bad_extension", name);
  }
});

test("headers: truncated, garbage, too many channels, 8-bit, tiny sample rate, extreme duration", () => {
  const { file, options } = setup();
  const put = (name: string, bytes: Buffer): string => { const f = path.join(path.dirname(file), name); fs.writeFileSync(f, bytes); return f; };
  const cut = Buffer.alloc(8);
  cut.write("LIST", 0, "latin1");
  cut.writeUInt32LE(1000, 4);
  assert.equal(reason(() => openAudioFile(put("trunc.wav", Buffer.concat([WAV.subarray(0, 36), cut, Buffer.alloc(20)])), options)), "bad_header", "a chunk that runs past the end of the file");
  assert.equal(reason(() => openAudioFile(put("junk.wav", Buffer.alloc(200, 9)), options)), "bad_header");
  const surround = Buffer.from(WAV);
  surround.writeUInt16LE(6, 22);
  assert.equal(reason(() => openAudioFile(put("six.wav", surround), options)), "bad_format");
  const eight = Buffer.from(WAV);
  eight.writeUInt16LE(8, 34);
  assert.equal(reason(() => openAudioFile(put("eight.wav", eight), options)), "bad_format");
  const slow = Buffer.from(WAV);
  slow.writeUInt32LE(4000, 24);
  assert.equal(reason(() => openAudioFile(put("slow.wav", slow), options)), "bad_format");
  const long = Buffer.from(WAV);
  long.writeUInt32LE(48000 * 4 * 400, 40);
  assert.equal(reason(() => openAudioFile(put("long.wav", long), options)), "too_long");
});

test("a header that declares more data than the file holds is incomplete, not accepted", () => {
  const { file, options } = setup();
  fs.truncateSync(file, WAV.length - 1000);
  assert.equal(reason(() => openAudioFile(file, options)), "truncated");
  const deferred = openAudioFile(file, { ...options, deferHeader: true });
  assert.equal(deferred.isComplete(), false);
  assert.equal(refusal(() => deferred.readAll()).details?.["reason"], "truncated");
  fs.writeFileSync(file, WAV);
  assert.equal(deferred.isComplete(), true, "the same descriptor sees the file finish");
  assert.deepEqual(deferred.readAll(), WAV);
  deferred.close();
});

test("the decoded size of a huge header is refused before any worker could allocate it", () => {
  const { file, options } = setup();
  const big = Buffer.from(WAV);
  big.writeUInt32LE(384000, 24);
  big.writeUInt32LE(384000 * 4, 28);
  const dataBytes = 384000 * 290 * 4; // 290 s of 16-bit stereo at 384 kHz: within the duration cap, 1.7 GB once decoded
  big.writeUInt32LE(dataBytes, 40);
  const bigFile = path.join(path.dirname(file), "big.wav");
  fs.writeFileSync(bigFile, big);
  fs.truncateSync(bigFile, 44 + dataBytes); // sparse
  const error = refusal(() => openAudioFile(bigFile, { ...options, maxBytes: 1 << 30 }));
  assert.equal(error.code, "too_large");
  assert.equal(error.details?.["reason"], "decoded_too_large");
});

test("paths: relative, NUL, invisible and direction characters, controls, too long, not a string", () => {
  const { file, options } = setup();
  assert.equal(reason(() => openAudioFile("take.wav", options)), "not_absolute");
  const hostile = ["\u0000", "​", "‮", "⁦", "﻿", "\u0007", "\u0085", "­", " "];
  for (const char of hostile) {
    assert.equal(reason(() => openAudioFile(file.replace("take", `ta${char}ke`), options)), "bad_path", JSON.stringify(char));
  }
  assert.equal(reason(() => openAudioFile(`/${"a".repeat(1100)}.wav`, options)), "bad_path");
  assert.equal(reason(() => openAudioFile(42 as unknown as string, options)), "bad_path");
  assert.equal(reason(() => openAudioFile("", options)), "bad_path");
});

test("decomposed (NFD) spellings of a real path open the real file; the path reported is the file system's own", () => {
  const home = scratch();
  const nfc = "Proyecto éño";
  const dir = path.join(home, "Music", nfc, "Samples", "Recorded");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "take.wav");
  fs.writeFileSync(file, WAV);
  const options = { home, roots: [], setRoots: [], maxBytes: 1 << 28 };
  openAudioFile(file, options).close();
  const decomposed = file.normalize("NFD");
  assert.notEqual(decomposed, file);
  if (!fs.existsSync(decomposed)) return; // a case/normalization-sensitive volume: nothing to prove here
  const opened = openAudioFile(decomposed, options);
  assert.equal(opened.realPath.normalize("NFC"), file);
  opened.close();
  // and a root configured in the other spelling still matches
  openAudioFile(file, { home, roots: [path.join(home, "Music", nfc.normalize("NFD"))], setRoots: [], maxBytes: 1 << 28 }).close();
});

test("files owned by someone else are refused", () => {
  const { file, options } = setup();
  assert.equal(reason(() => openAudioFile(file, { ...options, uid: uid + 1 })), "not_owned");
});

test("the file must stay the same file between the checks (swap after open is caught)", () => {
  const { file, options } = setup();
  const other = path.join(path.dirname(file), "other.wav");
  fs.writeFileSync(other, WAV);
  const opened = openAudioFile(file, options);
  fs.renameSync(other, file);
  assert.equal(refusal(() => opened.readAll()).details?.["reason"], "file_changed");
  assert.equal(refusal(() => opened.sizeNow()).details?.["reason"], "file_changed");
  opened.close();
  const { file: second, options: second_options } = setup();
  assert.equal(reason(() => openAudioFile(second, { ...second_options, hooks: { afterOpen: () => { fs.rmSync(second); fs.writeFileSync(second, WAV); } } })), "file_changed");
});

test("F4: the folder swapped for a symlink right after the open is caught by the real path recheck", () => {
  const { file, options } = setup();
  const dir = path.dirname(file);
  const hooks = { afterOpen: () => { fs.renameSync(dir, `${dir}.moved`); fs.symlinkSync(`${dir}.moved`, dir); } };
  assert.equal(reason(() => openAudioFile(file, { ...options, hooks })), "file_changed");
});

test("a file that does not exist is file_not_found and the error never repeats the path", () => {
  const { file, options } = setup();
  const error = refusal(() => openAudioFile(`${file}.nope.wav`, options));
  assert.equal(error.details?.["reason"], "file_not_found");
  assert.equal(error.message.includes(path.dirname(file)), false);
});

test("sizeNow follows a growing file on the same descriptor", () => {
  const { file, options } = setup(WAV.subarray(0, 4000));
  const opened = openAudioFile(file, { ...options, deferHeader: true });
  assert.equal(opened.sizeNow(), 4000);
  fs.appendFileSync(file, WAV.subarray(4000));
  assert.equal(opened.sizeNow(), WAV.length);
  opened.refreshLayout();
  assert.equal(opened.isComplete(), true);
  opened.close();
});

test("float and 32-bit files are accepted formats", () => {
  const { file, options } = setup();
  const mono = [sineChannel(500, -12, 1, 96000)];
  for (const [name, bytes] of [["f.wav", wavBytes(mono, 96000, 32, true)], ["i32.wav", wavBytes(mono, 96000, 32, false)], ["i24.wav", wavBytes(mono, 96000, 24, false)]] as const) {
    const target = path.join(path.dirname(file), name);
    fs.writeFileSync(target, bytes);
    openAudioFile(target, options).close();
  }
});

test("anyFolder: a file outside every folder opens, but every other check still applies", () => {
  const { options } = setup();
  const other = scratch();
  const plain = path.join(other, "plain.wav");
  fs.writeFileSync(plain, WAV);
  assert.equal(reason(() => openAudioFile(plain, options)), "outside_roots");
  const open = { ...options, anyFolder: true };
  openAudioFile(plain, open).close();
  assert.equal(reason(() => openAudioFile("/etc/hosts", open)), "bad_extension");
  assert.equal(reason(() => openAudioFile("relative.wav", open)), "not_absolute");
  assert.equal(reason(() => openAudioFile(path.join(other, "missing.wav"), open)), "file_not_found");
  fs.symlinkSync(plain, path.join(other, "link.wav"));
  assert.equal(reason(() => openAudioFile(path.join(other, "link.wav"), open)), "symlink");
  fs.linkSync(plain, path.join(other, "hard.wav"));
  assert.equal(reason(() => openAudioFile(plain, open)), "hard_linked");
  fs.mkdirSync(path.join(other, "dir.wav"));
  assert.equal(reason(() => openAudioFile(path.join(other, "dir.wav"), open)), "not_regular_file");
  fs.writeFileSync(path.join(other, "tiny.wav"), Buffer.alloc(10));
  assert.equal(reason(() => openAudioFile(path.join(other, "tiny.wav"), open)), "too_small");
  fs.writeFileSync(path.join(other, "big.wav"), WAV);
  assert.equal(reason(() => openAudioFile(path.join(other, "big.wav"), { ...open, maxBytes: 100 })), "file_too_large");
  fs.writeFileSync(path.join(other, "bad\u202e.wav"), WAV);
  assert.equal(reason(() => openAudioFile(path.join(other, "bad\u202e.wav"), open)), "bad_path");
});
