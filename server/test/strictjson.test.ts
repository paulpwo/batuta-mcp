import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStrictJson, JsonParseError } from "../src/util/strictjson.js";

test("parses ordinary JSON, including strings that contain brackets, quotes and braces", () => {
  assert.deepEqual(parseStrictJson('{"a":"[{\\"x\\":1}]","b":[1,2,{"c":null}]}'), { a: '[{"x":1}]', b: [1, 2, { c: null }] });
});

test("rejects duplicate keys in the same object, also through escapes, but allows them across objects", () => {
  assert.throws(() => parseStrictJson('{"a":1,"a":2}'), JsonParseError);
  assert.throws(() => parseStrictJson('{"a":1,"\\u0061":2}'), JsonParseError);
  assert.throws(() => parseStrictJson('{"o":{"k":1,"k":2}}'), JsonParseError);
  assert.deepEqual(parseStrictJson('{"a":{"k":1},"b":{"k":2},"c":[{"k":1},{"k":2}]}'), { a: { k: 1 }, b: { k: 2 }, c: [{ k: 1 }, { k: 2 }] });
  // A string VALUE equal to an earlier key is not a duplicate.
  assert.deepEqual(parseStrictJson('{"a":"a","b":"a"}'), { a: "a", b: "a" });
});

test("rejects depth over the limit, non-finite numbers, BOM, bad UTF-8 and trailing garbage", () => {
  assert.throws(() => parseStrictJson("[".repeat(33) + "]".repeat(33)), JsonParseError);
  assert.doesNotThrow(() => parseStrictJson("[".repeat(32) + "]".repeat(32)));
  assert.throws(() => parseStrictJson('{"n":1e999}'), JsonParseError);
  assert.throws(() => parseStrictJson(Buffer.from("﻿{}")), JsonParseError);
  assert.throws(() => parseStrictJson(Buffer.from([0x22, 0xff, 0x22])), JsonParseError);
  assert.throws(() => parseStrictJson("{} x"), JsonParseError);
});
