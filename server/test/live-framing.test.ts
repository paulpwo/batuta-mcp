import { test } from "node:test";
import assert from "node:assert/strict";
import { FrameDecoder, FrameError, encodeFrame, parseFrameBody, MAX_FRAME_BYTES } from "../src/live/framing.js";

function raw(obj: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(obj));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

test("encodeFrame writes a 4-byte big-endian length and a compact UTF-8 body", () => {
  const f = encodeFrame({ id: 1, cmd: "ping", args: { name: "café" } });
  assert.equal(f.readUInt32BE(0), f.length - 4);
  assert.deepEqual(JSON.parse(f.subarray(4).toString("utf8")), { id: 1, cmd: "ping", args: { name: "café" } });
});

test("encodeFrame refuses non-finite numbers and oversized bodies", () => {
  for (const bad of [NaN, Infinity, -Infinity]) assert.throws(() => encodeFrame({ v: bad }), FrameError);
  assert.throws(() => encodeFrame({ s: "a".repeat(MAX_FRAME_BYTES) }), (e: unknown) => e instanceof FrameError && e.code === "too_large");
  // Exactly at the cap is fine.
  const overhead = Buffer.byteLength(JSON.stringify({ s: "" }));
  assert.doesNotThrow(() => encodeFrame({ s: "a".repeat(MAX_FRAME_BYTES - overhead) }));
  assert.throws(() => encodeFrame({ s: "a".repeat(MAX_FRAME_BYTES - overhead + 1) }), FrameError);
});

test("encodeFrame refuses values JSON cannot represent faithfully", () => {
  assert.throws(() => encodeFrame(undefined as never), FrameError);
  assert.throws(() => encodeFrame(10n as never), FrameError);
  const cyclic: Record<string, unknown> = {};
  cyclic["self"] = cyclic;
  assert.throws(() => encodeFrame(cyclic), FrameError);
});

test("decoder reassembles frames split at every byte boundary", () => {
  const data = Buffer.concat([raw({ a: 1 }), raw({ b: "two" })]);
  const decoder = new FrameDecoder();
  const bodies: Buffer[] = [];
  for (const byte of data) bodies.push(...decoder.feed(Buffer.from([byte])));
  assert.deepEqual(bodies.map((b) => JSON.parse(b.toString())), [{ a: 1 }, { b: "two" }]);
  assert.equal(decoder.hasPartial, false);
});

test("decoder yields several frames from one chunk and tracks partial state", () => {
  const decoder = new FrameDecoder();
  const data = Buffer.concat([raw({ a: 1 }), raw({ b: 2 }).subarray(0, 6)]);
  assert.equal(decoder.feed(data).length, 1);
  assert.equal(decoder.hasPartial, true);
});

test("a zero length or oversized header is rejected from the header alone", () => {
  const zero = Buffer.alloc(4);
  assert.throws(() => new FrameDecoder().feed(zero), (e: unknown) => e instanceof FrameError && e.code === "bad_request");
  const huge = Buffer.alloc(4);
  huge.writeUInt32BE(MAX_FRAME_BYTES + 1);
  assert.throws(() => new FrameDecoder().feed(huge), (e: unknown) => e instanceof FrameError && e.code === "too_large");
  const max = Buffer.alloc(4);
  max.writeUInt32BE(MAX_FRAME_BYTES);
  assert.doesNotThrow(() => new FrameDecoder().feed(max));
  const big = Buffer.alloc(4);
  big.writeUInt32BE(0xffffffff);
  assert.throws(() => new FrameDecoder().feed(big), FrameError);
});

test("parseFrameBody requires a strict JSON object", () => {
  assert.deepEqual(parseFrameBody(Buffer.from('{"ok":true}')), { ok: true });
  for (const bad of ["[]", "42", '"s"', "null", "{", '{"n":1e999}', "ÿ"]) {
    assert.throws(() => parseFrameBody(Buffer.from(bad, "latin1")), FrameError, bad);
  }
  assert.throws(() => parseFrameBody(Buffer.from(`${"[".repeat(40)}${"]".repeat(40)}`)), FrameError);
  assert.throws(() => parseFrameBody(Buffer.from([0x7b, 0xff, 0x7d])), FrameError);
});

// ------------------------------------------------------------------ script shape caps
// Mirrors remote_script/BatutaMCP/jsonframes.py (_check_shape, parse_int, _check_depth) and Appendix A.

import { assertScriptShape, encodeRequestFrame } from "../src/live/framing.js";

function shapeError(value: unknown): FrameError | undefined {
  try {
    assertScriptShape(value);
  } catch (error) {
    assert.ok(error instanceof FrameError);
    return error;
  }
  return undefined;
}

function nested(depth: number): unknown {
  let value: unknown = 1;
  for (let i = 0; i < depth; i += 1) value = [value];
  return value;
}

test("strings are capped at 4096 UTF-8 bytes (not characters), keys too", () => {
  assert.equal(shapeError({ s: "a".repeat(4096) }), undefined);
  assert.equal(shapeError({ s: "a".repeat(4097) })?.code, "bad_request");
  assert.equal(shapeError({ s: "é".repeat(2048) }), undefined, "2048 two-byte characters are exactly 4096 bytes");
  assert.equal(shapeError({ s: "é".repeat(2049) })?.code, "bad_request");
  assert.equal(shapeError({ s: "\u{1F600}".repeat(1025) })?.code, "bad_request");
  assert.equal(shapeError({ ["k".repeat(4097)]: 1 })?.code, "bad_request");
  assert.equal(shapeError({ ["k".repeat(4096)]: 1 }), undefined);
  assert.equal(shapeError({ ["\u00e9".repeat(2049)]: 1 })?.code, "bad_request", "key length is in bytes, not characters");
  assert.equal(shapeError({ ["\u00e9".repeat(2048)]: 1 }), undefined);
});

test("integers beyond 2^53 are refused, including integer-valued floats up to 1e21 and beyond", () => {
  assert.equal(shapeError({ n: 2 ** 53 }), undefined);
  assert.equal(shapeError({ n: -(2 ** 53) }), undefined);
  for (const n of [2 ** 53 + 2, -(2 ** 53) - 2, 1e16, 1e20, 1e21, 1e300, -1e20]) {
    assert.equal(shapeError({ n })?.code, "bad_request", String(n));
  }
  assert.equal(shapeError({ n: 0.5 }), undefined);
  assert.equal(shapeError({ n: 1e-7 }), undefined);
  assert.equal(shapeError({ n: 123456789.125 }), undefined);
});

test("arrays are capped at 10000 items and objects at 256 keys", () => {
  assert.equal(shapeError({ a: new Array(10_000).fill(0) }), undefined);
  assert.equal(shapeError({ a: new Array(10_001).fill(0) })?.code, "bad_request");
  const keys = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i]));
  assert.equal(shapeError(keys(256)), undefined);
  assert.equal(shapeError(keys(257))?.code, "bad_request");
});

test("nesting is capped at 32 levels counting the top-level object", () => {
  assert.equal(shapeError({ a: nested(31) }), undefined, "1 + 31 = 32");
  assert.equal(shapeError({ a: nested(32) })?.code, "bad_request", "33 levels");
  assert.equal(shapeError(nested(32)), undefined);
  assert.equal(shapeError(nested(33))?.code, "bad_request");
});

test("encodeRequestFrame applies the shape caps on top of encodeFrame", () => {
  assert.doesNotThrow(() => encodeRequestFrame({ id: 1, cmd: "x", args: { s: "ok" }, timeout_ms: 5000 }));
  assert.throws(() => encodeRequestFrame({ id: 1, cmd: "x", args: { s: "a".repeat(5000) }, timeout_ms: 5000 }), (e: unknown) => e instanceof FrameError && e.code === "bad_request");
  assert.throws(() => encodeRequestFrame({ id: 1, cmd: "x", args: { s: "a".repeat(MAX_FRAME_BYTES) }, timeout_ms: 5000 }), (e: unknown) => e instanceof FrameError && e.code === "too_large");
  // The args object is nested under the frame object: 31 more levels fit, 32 do not.
  assert.doesNotThrow(() => encodeRequestFrame({ id: 1, cmd: "x", args: { a: nested(30) }, timeout_ms: 5000 }));
  assert.throws(() => encodeRequestFrame({ id: 1, cmd: "x", args: { a: nested(31) }, timeout_ms: 5000 }), FrameError);
});
