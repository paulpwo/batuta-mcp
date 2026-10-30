import { test } from "node:test";
import assert from "node:assert/strict";
import { compileSchema, validate, formatIssues, SchemaError } from "../src/validate/index.js";
import type { Schema } from "../src/validate/index.js";

function check(schema: Schema, value: unknown) {
  return validate(compileSchema(schema), value);
}
function keywords(schema: Schema, value: unknown): string[] {
  return check(schema, value).map((issue) => issue.keyword);
}

test("type: string, integer, number, boolean, array, object are strict", () => {
  assert.deepEqual(keywords({ type: "string" }, "x"), []);
  assert.deepEqual(keywords({ type: "string" }, 1), ["type"]);
  assert.deepEqual(keywords({ type: "integer" }, 3), []);
  assert.deepEqual(keywords({ type: "integer" }, 3.5), ["type"]);
  assert.deepEqual(keywords({ type: "integer" }, "3"), ["type"]);
  assert.deepEqual(keywords({ type: "integer" }, true), ["type"]);
  assert.deepEqual(keywords({ type: "number" }, 3.5), []);
  assert.deepEqual(keywords({ type: "number" }, "3.5"), ["type"]);
  assert.deepEqual(keywords({ type: "number" }, false), ["type"]);
  assert.deepEqual(keywords({ type: "boolean" }, false), []);
  assert.deepEqual(keywords({ type: "boolean" }, 0), ["type"]);
  assert.deepEqual(keywords({ type: "boolean" }, "true"), ["type"]);
  assert.deepEqual(keywords({ type: "array", items: { type: "integer" } }, []), []);
  assert.deepEqual(keywords({ type: "array", items: { type: "integer" } }, {}), ["type"]);
  assert.deepEqual(keywords({ type: "object", additionalProperties: false }, []), ["type"]);
  assert.deepEqual(keywords({ type: "object", additionalProperties: false }, null), ["type"]);
});

test("numbers: non-finite and unsafe integers are rejected", () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.deepEqual(keywords({ type: "number" }, bad), ["type"]);
    assert.deepEqual(keywords({ type: "integer" }, bad), ["type"]);
  }
  assert.deepEqual(keywords({ type: "integer" }, 2 ** 53), ["type"]);
  assert.deepEqual(keywords({ type: "integer" }, -(2 ** 53)), ["type"]);
  assert.deepEqual(keywords({ type: "integer" }, 2 ** 53 - 1), []);
});

test("minimum / maximum are inclusive", () => {
  const s: Schema = { type: "integer", minimum: 0, maximum: 7 };
  assert.deepEqual(keywords(s, 0), []);
  assert.deepEqual(keywords(s, 7), []);
  assert.deepEqual(keywords(s, -1), ["minimum"]);
  assert.deepEqual(keywords(s, 8), ["maximum"]);
  const issue = check(s, 8)[0]!;
  assert.equal(issue.expected, 7);
  assert.equal(issue.actual, 8);
});

test("minLength / maxLength count code points", () => {
  const s: Schema = { type: "string", minLength: 1, maxLength: 3 };
  assert.deepEqual(keywords(s, "abc"), []);
  assert.deepEqual(keywords(s, ""), ["minLength"]);
  assert.deepEqual(keywords(s, "abcd"), ["maxLength"]);
  // Three emoji are 6 UTF-16 units but 3 code points.
  assert.deepEqual(keywords(s, "\u{1F600}\u{1F600}\u{1F600}"), []);
  assert.deepEqual(keywords(s, "\u{1F600}\u{1F600}\u{1F600}\u{1F600}"), ["maxLength"]);
});

test("enum and const", () => {
  assert.deepEqual(keywords({ type: "string", enum: ["a", "b"] }, "a"), []);
  assert.deepEqual(keywords({ type: "string", enum: ["a", "b"] }, "c"), ["enum"]);
  assert.deepEqual(keywords({ enum: [1, "x"] }, 1), []);
  assert.deepEqual(keywords({ enum: [1, "x"] }, "1"), ["enum"]);
  assert.deepEqual(keywords({ const: "live" }, "live"), []);
  assert.deepEqual(keywords({ const: "live" }, "other"), ["const"]);
});

test("pattern: anchored, compiled once, requires maxLength", () => {
  const s: Schema = { type: "string", pattern: "^[a-f0-9]{4}$", maxLength: 4 };
  assert.deepEqual(keywords(s, "ab12"), []);
  assert.deepEqual(keywords(s, "zz12"), ["pattern"]);
  assert.throws(() => compileSchema({ type: "string", pattern: "[a-z]+", maxLength: 10 }), SchemaError);
  assert.throws(() => compileSchema({ type: "string", pattern: "^[a-z]+$" }), SchemaError, "pattern needs maxLength");
  assert.throws(() => compileSchema({ type: "string", pattern: "^(a+)+$", maxLength: 10 }), SchemaError, "nested quantifier");
  assert.throws(() => compileSchema({ type: "string", pattern: "^(", maxLength: 10 }), SchemaError, "invalid regex");
  assert.throws(() => compileSchema({ type: "string", pattern: "^a$", maxLength: 5000 }), SchemaError, "maxLength cap for patterns");
});

test("required and additionalProperties:false", () => {
  const s: Schema = {
    type: "object",
    properties: { a: { type: "integer" }, b: { type: "string" } },
    required: ["a"],
    additionalProperties: false,
  };
  assert.deepEqual(keywords(s, { a: 1 }), []);
  assert.deepEqual(keywords(s, {}), ["required"]);
  assert.deepEqual(keywords(s, { a: 1, c: 2 }), ["additionalProperties"]);
  assert.deepEqual(keywords(s, { a: "x" }), ["type"]);
  const issue = check(s, { a: 1, c: 2 })[0]!;
  assert.equal(issue.path, "/c");
});

test("object schemas must declare additionalProperties:false", () => {
  assert.throws(() => compileSchema({ type: "object", properties: {} }), SchemaError);
  assert.throws(() => compileSchema({ type: "object", additionalProperties: true as never }), SchemaError);
});

test("__proto__ own key from JSON.parse is an unknown property, not a prototype write", () => {
  const value = JSON.parse('{"a":1,"__proto__":{"polluted":true}}');
  const s: Schema = { type: "object", properties: { a: { type: "integer" } }, additionalProperties: false };
  assert.deepEqual(keywords(s, value), ["additionalProperties"]);
  assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
});

test("inherited properties are not read (toString is not a property)", () => {
  const s: Schema = { type: "object", properties: { toString: { type: "string" as const } }, required: ["toString"], additionalProperties: false };
  assert.deepEqual(keywords(s, {}), ["required"]);
});

test("items, minItems, maxItems report the failing index path", () => {
  const s: Schema = { type: "array", items: { type: "integer", minimum: 0 }, minItems: 1, maxItems: 3 };
  assert.deepEqual(keywords(s, [1, 2]), []);
  assert.deepEqual(keywords(s, []), ["minItems"]);
  assert.deepEqual(keywords(s, [1, 2, 3, 4]), ["maxItems"]);
  const issues = check(s, [1, -5]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.path, "/1");
  assert.equal(issues[0]!.keyword, "minimum");
});

test("oneOf: exactly one branch must match (refs)", () => {
  const trackRef: Schema = {
    oneOf: [
      { type: "integer", minimum: 0 },
      { type: "object", properties: { name: { type: "string", minLength: 1, maxLength: 128 } }, required: ["name"], additionalProperties: false },
    ],
  };
  assert.deepEqual(keywords(trackRef, 3), []);
  assert.deepEqual(keywords(trackRef, { name: "Bass" }), []);
  assert.deepEqual(keywords(trackRef, "Bass"), ["oneOf"]);
  assert.deepEqual(keywords(trackRef, { name: "" }), ["oneOf"]);
  // Overlapping branches: matching two is also a failure.
  const overlap: Schema = { oneOf: [{ type: "number" }, { type: "integer" }] };
  assert.deepEqual(keywords(overlap, 3), ["oneOf"]);
  assert.deepEqual(keywords(overlap, 3.5), []);
  const issue = check(trackRef, "Bass")[0]!;
  assert.ok(Array.isArray(issue.branches) && issue.branches.length === 2);
});

test("unknown keywords and bad schema shapes are rejected at compile time", () => {
  assert.throws(() => compileSchema({ type: "string", format: "email" } as never), SchemaError);
  assert.throws(() => compileSchema({ type: "string", $ref: "#/x" } as never), SchemaError);
  assert.throws(() => compileSchema({ type: "null" } as never), SchemaError);
  assert.throws(() => compileSchema({ type: "array" } as never), SchemaError, "array needs items");
  assert.throws(() => compileSchema({ type: "integer", minimum: Number.NaN }), SchemaError);
  assert.throws(() => compileSchema({ type: "string", minLength: -1 }), SchemaError);
  assert.throws(() => compileSchema({ type: "object", required: ["x"], properties: {}, additionalProperties: false }), SchemaError, "required must be declared");
  assert.throws(() => compileSchema({ type: "string", enum: [] }), SchemaError);
});

test("annotation keywords are allowed and pass through to the published schema", () => {
  const raw: Schema = { type: "integer", description: "Track index", title: "Track", default: 0, minimum: 0 };
  const compiled = compileSchema(raw);
  assert.deepEqual(compiled.schema, raw);
  assert.ok(Object.isFrozen(compiled.schema));
});

test("validation depth is bounded", () => {
  let deep: unknown = 1;
  for (let i = 0; i < 100; i += 1) deep = [deep];
  let schema: Schema = { type: "integer" };
  for (let i = 0; i < 100; i += 1) schema = { type: "array", items: schema, maxItems: 1 };
  assert.throws(() => compileSchema(schema), SchemaError, "schema nesting cap");
  const loose = compileSchema({ type: "array", items: { type: "integer" } });
  assert.deepEqual(validate(loose, deep).map((i) => i.keyword), ["type"]);
});

test("formatIssues is compact, model-readable and capped", () => {
  const s: Schema = {
    type: "object",
    properties: { index: { type: "integer", minimum: 0, maximum: 7 } },
    required: ["index"],
    additionalProperties: false,
  };
  const text = formatIssues(check(s, { index: 9, extra: 1 }));
  assert.match(text, /\/index: must be <= 7 \(got 9\)/);
  assert.match(text, /\/extra: unknown property/);
  const many = formatIssues(check({ type: "array", items: { type: "integer" } }, Array.from({ length: 100 }, () => "x")));
  assert.ok(many.split("\n").length <= 21);
  assert.match(many, /more issue/);
  const long = formatIssues(check({ type: "integer" }, "y".repeat(500)));
  assert.ok(long.length < 200);
});

test("validate reports all issues, not just the first", () => {
  const s: Schema = {
    type: "object",
    properties: { a: { type: "integer" }, b: { type: "boolean" } },
    required: ["a", "b"],
    additionalProperties: false,
  };
  assert.equal(check(s, { a: "x", b: 1 }).length, 2);
});

test("issue collection is capped during the walk, not after", () => {
  const compiled = compileSchema({ type: "array", items: { type: "integer" } });
  const issues = validate(compiled, Array.from({ length: 200_000 }, () => "x"));
  assert.ok(issues.length <= 100, `collected ${issues.length}`);
  assert.ok(issues.length >= 20);
  const objectSchema = compileSchema({ type: "object", additionalProperties: false });
  const wide = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`k${i}`, i]));
  assert.ok(validate(objectSchema, wide).length <= 100);
  assert.match(formatIssues(issues), /more issue/);
});

test("pattern lint rejects adjacent unbounded quantifiers and top-level alternation", () => {
  const reject = (pattern: string, why: string) => assert.throws(() => compileSchema({ type: "string", pattern, maxLength: 64 }), SchemaError, `${pattern}: ${why}`);
  reject("^\\d*\\d*\\d*$", "adjacent star quantifiers");
  reject("^\\d+\\w+$", "two unbounded quantifiers");
  reject("^a*[ab]{1,}$", "{n,} counts as unbounded");
  reject("^a|b$", "top-level alternation breaks the anchors");
  reject("^a|^b$", "top-level alternation");
  const accept = (pattern: string) => assert.doesNotThrow(() => compileSchema({ type: "string", pattern, maxLength: 64 }), pattern);
  accept("^[a-z]+$");
  accept("^\\d{1,3}\\.\\d{1,3}$");
  accept("^[a-f0-9]{4}$");
  accept("^(a|b)c$");
  accept("^[|]x\\|y$");
  accept("^\\d?\\d?\\d+$");
});
