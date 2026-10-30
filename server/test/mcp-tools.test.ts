import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry, ToolError } from "../src/mcp/index.js";
import type { Tool } from "../src/mcp/index.js";
import { startServer } from "./helpers/mcp-client.js";

function echoTool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: "dummy_echo",
    title: "Echo",
    description: "Echo a number back.",
    inputSchema: {
      type: "object",
      properties: { n: { type: "integer", minimum: 0, maximum: 7 } },
      required: ["n"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async (args) => ({ content: [{ type: "text", text: `n=${(args as { n: number }).n}` }], structuredContent: { n: (args as { n: number }).n } }),
    ...overrides,
  };
}

test("registry rejects bad names, duplicate names and bad schemas", () => {
  const registry = new ToolRegistry();
  registry.register(echoTool());
  assert.throws(() => registry.register(echoTool()), /already registered/);
  assert.throws(() => registry.register(echoTool({ name: "has space" })), /name/);
  assert.throws(() => registry.register(echoTool({ name: "" })), /name/);
  assert.throws(() => registry.register(echoTool({ name: "x".repeat(129) })), /name/);
  assert.throws(() => registry.register(echoTool({ name: "bad_schema", inputSchema: { type: "object" } as never })), /additionalProperties/);
  assert.throws(() => registry.register(echoTool({ name: "str_root", inputSchema: { type: "string" } })), /object/);
});

test("tools/list publishes the validator's schema and annotations", async () => {
  const registry = new ToolRegistry();
  registry.register(echoTool());
  const { client } = startServer({}, registry);
  await client.initialize();
  const { result } = await client.request(2, "tools/list", {});
  assert.equal(result.tools.length, 1);
  const tool = result.tools[0];
  assert.equal(tool.name, "dummy_echo");
  assert.equal(tool.inputSchema.type, "object");
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(result.nextCursor, undefined);
});

test("tools/list works without params and with an empty registry", async () => {
  const { client } = startServer();
  await client.initialize();
  const { result } = await client.request(2, "tools/list");
  assert.deepEqual(result, { tools: [] });
});

test("tools/list paginates with opaque cursors and rejects bad ones", async () => {
  const registry = new ToolRegistry();
  for (let i = 0; i < 5; i += 1) registry.register(echoTool({ name: `t${i}` }));
  const { client } = startServer({ pageSize: 2 }, registry);
  await client.initialize();
  const seen: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const { result } = await client.request(10 + pages, "tools/list", cursor === undefined ? {} : { cursor });
    seen.push(...result.tools.map((t: { name: string }) => t.name));
    cursor = result.nextCursor;
    pages += 1;
  } while (cursor !== undefined && pages < 10);
  assert.deepEqual(seen, ["t0", "t1", "t2", "t3", "t4"]);
  assert.equal(pages, 3);
  for (const bad of ["garbage", "", 5, "bzoxMDA="]) {
    const response = await client.request(50, "tools/list", { cursor: bad });
    assert.equal(response.error.code, -32602, String(bad));
  }
});

test("tools/call returns content, structuredContent and isError:false", async () => {
  const registry = new ToolRegistry();
  registry.register(echoTool());
  const { client } = startServer({}, registry);
  await client.initialize();
  const { result } = await client.request(2, "tools/call", { name: "dummy_echo", arguments: { n: 3 } });
  assert.deepEqual(result.content, [{ type: "text", text: "n=3" }]);
  assert.deepEqual(result.structuredContent, { n: 3 });
  assert.equal(result.isError, false);
});

test("structuredContent without text content gets a serialized text block (spec SHOULD)", async () => {
  const registry = new ToolRegistry();
  registry.register(echoTool({ handler: async () => ({ structuredContent: { a: 1 } }) }));
  const { client } = startServer({}, registry);
  await client.initialize();
  const { result } = await client.request(2, "tools/call", { name: "dummy_echo", arguments: { n: 1 } });
  assert.deepEqual(result.content, [{ type: "text", text: '{"a":1}' }]);
  assert.deepEqual(result.structuredContent, { a: 1 });
});

test("unknown tool and malformed call params are protocol errors (-32602)", async () => {
  const registry = new ToolRegistry();
  registry.register(echoTool());
  const { client } = startServer({}, registry);
  await client.initialize();
  assert.equal((await client.request(2, "tools/call", { name: "nope", arguments: {} })).error.code, -32602);
  assert.equal((await client.request(3, "tools/call", { name: 5 })).error.code, -32602);
  assert.equal((await client.request(4, "tools/call", undefined)).error.code, -32602);
  assert.equal((await client.request(5, "tools/call", { name: "dummy_echo", arguments: [] })).error.code, -32602);
  assert.equal((await client.request(6, "tools/call", { name: "dummy_echo", arguments: 5 })).error.code, -32602);
});

test("invalid arguments become an isError result listing the issues; the handler never runs", async () => {
  let called = 0;
  const registry = new ToolRegistry();
  registry.register(echoTool({ handler: async () => { called += 1; return { content: [] }; } }));
  const { client } = startServer({}, registry);
  await client.initialize();
  const { result } = await client.request(2, "tools/call", { name: "dummy_echo", arguments: { n: 9, extra: true } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /\/n: must be <= 7/);
  assert.match(result.content[0].text, /\/extra: unknown property/);
  assert.equal(result.structuredContent.code, "invalid_args");
  assert.ok(Array.isArray(result.structuredContent.details.issues));
  const missing = await client.request(3, "tools/call", { name: "dummy_echo" });
  assert.equal(missing.result.isError, true);
  assert.match(missing.result.content[0].text, /\/n: required/);
  assert.equal(called, 0);
});

test("a ToolError becomes a structured isError result; other exceptions are masked", async () => {
  const registry = new ToolRegistry();
  registry.register(echoTool({ name: "typed", handler: async () => { throw new ToolError("not_found", "Track 9 does not exist", { what: "track", index: 9 }); } }));
  registry.register(echoTool({ name: "boom", handler: async () => { throw new Error("secret path /Users/x/token"); } }));
  const { client, logs } = startServer({}, registry);
  await client.initialize();
  const typed = (await client.request(2, "tools/call", { name: "typed", arguments: { n: 1 } })).result;
  assert.equal(typed.isError, true);
  assert.deepEqual(typed.structuredContent, { code: "not_found", message: "Track 9 does not exist", details: { what: "track", index: 9 } });
  assert.match(typed.content[0].text, /not_found/);
  const boom = (await client.request(3, "tools/call", { name: "boom", arguments: { n: 1 } })).result;
  assert.equal(boom.isError, true);
  assert.equal(boom.structuredContent.code, "internal_error");
  assert.doesNotMatch(JSON.stringify(boom), /secret path/);
  assert.ok(logs.some((l) => l.includes("secret path")), "the detail goes to the stderr log only");
});

test("results that exceed the output cap are replaced by an error result", async () => {
  const registry = new ToolRegistry();
  registry.register(echoTool({ handler: async () => ({ content: [{ type: "text", text: "a".repeat(5000) }] }) }));
  const { client } = startServer({ maxOutputBytes: 1000 }, registry);
  await client.initialize();
  const { result } = await client.request(2, "tools/call", { name: "dummy_echo", arguments: { n: 1 } });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.code, "too_large");
});

test("a handler returning a malformed result yields an internal error result", async () => {
  const registry = new ToolRegistry();
  registry.register(echoTool({ handler: (async () => "nope") as never }));
  const { client } = startServer({}, registry);
  await client.initialize();
  const { result } = await client.request(2, "tools/call", { name: "dummy_echo", arguments: { n: 1 } });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.code, "internal_error");
});

test("concurrent calls are capped", async () => {
  const registry = new ToolRegistry();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  registry.register(echoTool({ handler: async () => { await gate; return { content: [] }; } }));
  const { client } = startServer({ maxConcurrentCalls: 1 }, registry);
  await client.initialize();
  client.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "dummy_echo", arguments: { n: 1 } } });
  client.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "dummy_echo", arguments: { n: 1 } } });
  const second = await client.nextResponse(3);
  assert.equal(second.result.isError, true);
  assert.equal(second.result.structuredContent.code, "busy");
  release();
  assert.equal((await client.nextResponse(2)).result.isError, false);
});

test("cancellation aborts the handler and suppresses the response", async () => {
  const registry = new ToolRegistry();
  let aborted = false;
  registry.register(echoTool({
    handler: (_args, ctx) => new Promise((_resolve, reject) => {
      ctx.signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); });
    }),
  }));
  const { client } = startServer({}, registry);
  await client.initialize();
  client.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "dummy_echo", arguments: { n: 1 } } });
  await new Promise((r) => setTimeout(r, 20));
  client.notify("notifications/cancelled", { requestId: 2, reason: "user" });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(aborted, true);
  await client.expectSilence();
  assert.deepEqual((await client.request(3, "ping")).result, {});
});

test("cancelling an unknown, finished or initialize request is ignored", async () => {
  const registry = new ToolRegistry();
  registry.register(echoTool());
  const { client } = startServer({}, registry);
  await client.initialize();
  client.notify("notifications/cancelled", { requestId: 12345 });
  client.notify("notifications/cancelled", { requestId: 1 }); // the initialize request
  client.notify("notifications/cancelled", {});
  client.notify("notifications/cancelled");
  await client.request(2, "tools/call", { name: "dummy_echo", arguments: { n: 1 } });
  client.notify("notifications/cancelled", { requestId: 2 });
  await client.expectSilence();
});

test("closing stdin aborts in-flight handlers and run() resolves", async () => {
  const registry = new ToolRegistry();
  let aborted = false;
  registry.register(echoTool({
    handler: (_args, ctx) => new Promise((resolve) => {
      ctx.signal.addEventListener("abort", () => { aborted = true; resolve({ content: [] }); });
    }),
  }));
  const { client, done } = startServer({}, registry);
  await client.initialize();
  client.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "dummy_echo", arguments: { n: 1 } } });
  await new Promise((r) => setTimeout(r, 20));
  client.end();
  await done;
  assert.equal(aborted, true);
});

test("a handler that ignores abort cannot block shutdown beyond the grace period", async () => {
  const registry = new ToolRegistry();
  registry.register(echoTool({ handler: () => new Promise(() => {}) }));
  const { client, done } = startServer({ shutdownGraceMs: 50 }, registry);
  await client.initialize();
  client.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "dummy_echo", arguments: { n: 1 } } });
  await new Promise((r) => setTimeout(r, 20));
  client.end();
  await done;
});

test("a second request with an id that is still in flight is refused with -32600", async () => {
  const registry = new ToolRegistry();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let runs = 0;
  registry.register(echoTool({ handler: async () => { runs += 1; await gate; return { content: [{ type: "text", text: "done" }] }; } }));
  const { client } = startServer({}, registry);
  await client.initialize();
  client.send({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "dummy_echo", arguments: { n: 1 } } });
  await new Promise((r) => setTimeout(r, 20));
  client.send({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "dummy_echo", arguments: { n: 2 } } });
  const duplicate = await client.nextResponse(7);
  assert.equal(duplicate.error.code, -32600);
  assert.match(duplicate.error.message, /duplicate/i);
  release();
  const first = await client.nextResponse(7);
  assert.equal(first.result.content[0].text, "done");
  assert.equal(runs, 1, "the duplicate never ran");
  // Once finished, the id may be reused.
  client.send({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "dummy_echo", arguments: { n: 3 } } });
  assert.equal((await client.nextResponse(7)).result.content[0].text, "done");
});

test("T9q: an error's details follow the code: message line as one compact JSON line, bounded; invalid_args and detail-less errors keep their text", async () => {
  const registry = new ToolRegistry();
  registry.register(echoTool({ name: "limit", handler: async () => { throw new ToolError("edition_limit", "Live lite allows at most 8 tracks; there are already 8.", { resource: "tracks", limit: 8, current: 8, edition: "lite" }); } }));
  registry.register(echoTool({ name: "plain", handler: async () => { throw new ToolError("busy", "Another job is running."); } }));
  registry.register(echoTool({ name: "huge", handler: async () => { throw new ToolError("not_supported", "Too much detail.", { reason: "big", blob: "x".repeat(5000) }); } }));
  const { client } = startServer({}, registry);
  await client.initialize();
  const limit = (await client.request(2, "tools/call", { name: "limit", arguments: { n: 1 } })).result;
  assert.equal(limit.content[0].text, 'edition_limit: Live lite allows at most 8 tracks; there are already 8.\n{"details":{"resource":"tracks","limit":8,"current":8,"edition":"lite"}}');
  const plain = (await client.request(3, "tools/call", { name: "plain", arguments: { n: 1 } })).result;
  assert.equal(plain.content[0].text, "busy: Another job is running.");
  const huge = (await client.request(4, "tools/call", { name: "huge", arguments: { n: 1 } })).result;
  const lines = huge.content[0].text.split("\n");
  assert.equal(lines[0], "not_supported: Too much detail.");
  assert.ok(huge.content[0].text.length < 700, "bounded");
  assert.match(lines[1], /"reason":"big"/);
  const bad = (await client.request(5, "tools/call", { name: "limit", arguments: { n: "x" } })).result;
  assert.equal(bad.content[0].text.includes('{"details"'), false, "invalid_args already lists its issues in the message");
});
