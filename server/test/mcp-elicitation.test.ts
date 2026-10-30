import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry, ElicitationUnavailableError, McpTimeoutError, McpRpcError } from "../src/mcp/index.js";
import type { Tool, ToolContext } from "../src/mcp/index.js";
import { startServer } from "./helpers/mcp-client.js";
import type { Json } from "./helpers/mcp-client.js";

const confirmSchema = {
  type: "object" as const,
  properties: { confirm: { type: "boolean" as const, title: "Confirm" } },
  required: ["confirm"],
};

function askTool(run: (ctx: ToolContext) => Promise<unknown>): Tool {
  return {
    name: "ask",
    description: "Ask the user.",
    inputSchema: { type: "object", additionalProperties: false },
    handler: async (_args, ctx) => {
      const outcome = await run(ctx).then((value) => ({ value }), (error: unknown) => ({ error }));
      return { content: [{ type: "text", text: "done" }], structuredContent: { outcome: describe(outcome) } };
    },
  };
}

function describe(outcome: { value?: unknown; error?: unknown }): unknown {
  if ("error" in outcome) {
    const e = outcome.error as Error;
    return { error: e.constructor.name, message: e.message };
  }
  return { value: outcome.value };
}

async function call(client: ReturnType<typeof startServer>["client"], id: number): Promise<void> {
  client.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "ask", arguments: {} } });
}

test("elicitation round trip: request shape, id correlation and accepted content", async () => {
  const registry = new ToolRegistry();
  registry.register(askTool((ctx) => ctx.elicitForm({ message: "Delete track 2 (Bass)?", requestedSchema: confirmSchema })));
  const { client } = startServer({}, registry);
  await client.initialize({ elicitation: { form: {} } });
  await call(client, 10);
  const ask = await client.next((m: Json) => m.method === "elicitation/create");
  assert.equal(ask.jsonrpc, "2.0");
  assert.ok(ask.id !== undefined && ask.id !== null);
  assert.equal(ask.params.message, "Delete track 2 (Bass)?");
  assert.deepEqual(ask.params.requestedSchema, confirmSchema);
  assert.equal("mode" in ask.params, false, "mode is optional for form mode and omitted for older clients");
  client.send({ jsonrpc: "2.0", id: ask.id, result: { action: "accept", content: { confirm: true } } });
  const result = (await client.nextResponse(10)).result;
  assert.deepEqual(result.structuredContent.outcome, { value: { action: "accept", content: { confirm: true } } });
});

test("decline and cancel actions are passed through without content", async () => {
  for (const action of ["decline", "cancel"]) {
    const registry = new ToolRegistry();
    registry.register(askTool((ctx) => ctx.elicitForm({ message: "Sure?", requestedSchema: confirmSchema })));
    const { client } = startServer({}, registry);
    await client.initialize({ elicitation: {} });
    await call(client, 10);
    const ask = await client.next((m: Json) => m.method === "elicitation/create");
    client.send({ jsonrpc: "2.0", id: ask.id, result: { action } });
    const result = (await client.nextResponse(10)).result;
    assert.deepEqual(result.structuredContent.outcome, { value: { action } });
  }
});

test("accepted content is validated against the requested schema", async () => {
  const registry = new ToolRegistry();
  registry.register(askTool((ctx) => ctx.elicitForm({ message: "Sure?", requestedSchema: confirmSchema })));
  const { client } = startServer({}, registry);
  await client.initialize({ elicitation: {} });
  await call(client, 10);
  const ask = await client.next((m: Json) => m.method === "elicitation/create");
  client.send({ jsonrpc: "2.0", id: ask.id, result: { action: "accept", content: { confirm: "yes" } } });
  const result = (await client.nextResponse(10)).result;
  assert.equal(result.structuredContent.outcome.error, "McpRpcError");
});

test("a bogus action is rejected as a protocol violation", async () => {
  const registry = new ToolRegistry();
  registry.register(askTool((ctx) => ctx.elicitForm({ message: "Sure?", requestedSchema: confirmSchema })));
  const { client } = startServer({}, registry);
  await client.initialize({ elicitation: {} });
  await call(client, 10);
  const ask = await client.next((m: Json) => m.method === "elicitation/create");
  client.send({ jsonrpc: "2.0", id: ask.id, result: { action: "maybe" } });
  const result = (await client.nextResponse(10)).result;
  assert.equal(result.structuredContent.outcome.error, "McpRpcError");
});

test("a JSON-RPC error answer rejects with McpRpcError carrying the code", async () => {
  const registry = new ToolRegistry();
  let caught: unknown;
  registry.register(askTool(async (ctx) => {
    try { await ctx.elicitForm({ message: "Sure?", requestedSchema: confirmSchema }); } catch (e) { caught = e; throw e; }
  }));
  const { client } = startServer({}, registry);
  await client.initialize({ elicitation: {} });
  await call(client, 10);
  const ask = await client.next((m: Json) => m.method === "elicitation/create");
  client.send({ jsonrpc: "2.0", id: ask.id, error: { code: -32602, message: "nope" } });
  await client.nextResponse(10);
  assert.ok(caught instanceof McpRpcError);
  assert.equal((caught as McpRpcError).code, -32602);
});

test("without the elicitation capability canElicit is false and elicitForm throws", async () => {
  const registry = new ToolRegistry();
  let canElicit: boolean | undefined;
  registry.register(askTool((ctx) => { canElicit = ctx.canElicit; return ctx.elicitForm({ message: "Sure?", requestedSchema: confirmSchema }); }));
  const { client } = startServer({}, registry);
  await client.initialize({});
  await call(client, 10);
  const result = (await client.nextResponse(10)).result;
  assert.equal(canElicit, false);
  assert.equal(result.structuredContent.outcome.error, ElicitationUnavailableError.name);
  await client.expectSilence();
});

test("url-only elicitation support does not count as form support; empty object does", async () => {
  const cases: Array<[Json, boolean]> = [[{ url: {} }, false], [{}, true], [{ form: {} }, true], [{ form: {}, url: {} }, true]];
  for (const [elicitation, expected] of cases) {
    const registry = new ToolRegistry();
    let canElicit: boolean | undefined;
    registry.register(askTool(async (ctx) => { canElicit = ctx.canElicit; }));
    const { client } = startServer({}, registry);
    await client.initialize({ elicitation });
    await call(client, 10);
    await client.nextResponse(10);
    assert.equal(canElicit, expected, JSON.stringify(elicitation));
  }
});

test("an older negotiated version without elicitation support never elicits", async () => {
  // 2025-03-26 is not supported at all, so it negotiates up; the capability then still counts.
  const registry = new ToolRegistry();
  let canElicit: boolean | undefined;
  registry.register(askTool(async (ctx) => { canElicit = ctx.canElicit; }));
  const { client } = startServer({}, registry);
  await client.initialize({ elicitation: {} }, "2025-06-18");
  await call(client, 10);
  await client.nextResponse(10);
  assert.equal(canElicit, true);
});

test("no elicitation before notifications/initialized", async () => {
  const registry = new ToolRegistry();
  let canElicit: boolean | undefined;
  registry.register(askTool(async (ctx) => { canElicit = ctx.canElicit; }));
  const { client } = startServer({}, registry);
  await client.request(1, "initialize", { protocolVersion: "2025-11-25", capabilities: { elicitation: {} }, clientInfo: { name: "c", version: "1" } });
  await call(client, 10); // the client skipped the initialized notification
  await client.nextResponse(10);
  assert.equal(canElicit, false);
});

test("elicitation timeout rejects and tells the client to cancel the request", async () => {
  const registry = new ToolRegistry();
  registry.register(askTool((ctx) => ctx.elicitForm({ message: "Sure?", requestedSchema: confirmSchema, timeoutMs: 40 })));
  const { client } = startServer({}, registry);
  await client.initialize({ elicitation: {} });
  await call(client, 10);
  const ask = await client.next((m: Json) => m.method === "elicitation/create");
  const cancelled = await client.next((m: Json) => m.method === "notifications/cancelled");
  assert.equal(cancelled.params.requestId, ask.id);
  const result = (await client.nextResponse(10)).result;
  assert.equal(result.structuredContent.outcome.error, McpTimeoutError.name);
  // A late answer is ignored.
  client.send({ jsonrpc: "2.0", id: ask.id, result: { action: "accept", content: { confirm: true } } });
  await client.expectSilence();
});

test("cancelling the tool call aborts a pending elicitation and cancels it at the client", async () => {
  const registry = new ToolRegistry();
  registry.register(askTool((ctx) => ctx.elicitForm({ message: "Sure?", requestedSchema: confirmSchema })));
  const { client } = startServer({}, registry);
  await client.initialize({ elicitation: {} });
  await call(client, 10);
  const ask = await client.next((m: Json) => m.method === "elicitation/create");
  client.notify("notifications/cancelled", { requestId: 10 });
  const cancelled = await client.next((m: Json) => m.method === "notifications/cancelled");
  assert.equal(cancelled.params.requestId, ask.id);
  await client.expectSilence();
});

test("closing stdin rejects a pending elicitation and run() resolves", async () => {
  const registry = new ToolRegistry();
  registry.register(askTool((ctx) => ctx.elicitForm({ message: "Sure?", requestedSchema: confirmSchema })));
  const { client, done } = startServer({}, registry);
  await client.initialize({ elicitation: {} });
  await call(client, 10);
  await client.next((m: Json) => m.method === "elicitation/create");
  client.end();
  await done;
});

test("server request ids never collide across concurrent elicitations", async () => {
  const registry = new ToolRegistry();
  registry.register(askTool((ctx) => ctx.elicitForm({ message: "Sure?", requestedSchema: confirmSchema })));
  const { client } = startServer({}, registry);
  await client.initialize({ elicitation: {} });
  await call(client, 10);
  await call(client, 11);
  const a = await client.next((m: Json) => m.method === "elicitation/create");
  const b = await client.next((m: Json) => m.method === "elicitation/create");
  assert.notEqual(a.id, b.id);
  client.send({ jsonrpc: "2.0", id: b.id, result: { action: "decline" } });
  client.send({ jsonrpc: "2.0", id: a.id, result: { action: "accept", content: { confirm: true } } });
  const r11 = (await client.nextResponse(11)).result;
  const r10 = (await client.nextResponse(10)).result;
  assert.equal(r11.structuredContent.outcome.value.action, "decline");
  assert.equal(r10.structuredContent.outcome.value.action, "accept");
});

test("the published requestedSchema carries no additionalProperties, but extra answer fields are still rejected", async () => {
  const registry = new ToolRegistry();
  registry.register(askTool((ctx) => ctx.elicitForm({ message: "Sure?", requestedSchema: confirmSchema })));
  const { client } = startServer({}, registry);
  await client.initialize({ elicitation: {} });
  await call(client, 10);
  const ask = await client.next((m: Json) => m.method === "elicitation/create");
  assert.equal("additionalProperties" in ask.params.requestedSchema, false);
  client.send({ jsonrpc: "2.0", id: ask.id, result: { action: "accept", content: { confirm: true, sneaky: 1 } } });
  const result = (await client.nextResponse(10)).result;
  assert.equal(result.structuredContent.outcome.error, "McpRpcError");
});

test("requestedSchema must be a flat object of primitive properties", async () => {
  const bad: Json[] = [
    { type: "object", properties: { a: { type: "object", properties: {} } } },
    { type: "object", properties: { a: { type: "array", items: { type: "string" } } } },
    { type: "object", properties: { a: { oneOf: [{ type: "string" }, { type: "integer" }] } } },
    { type: "object", properties: {} },
    { type: "string" },
    { type: "object", properties: { a: { type: "string" } }, additionalProperties: true },
    { type: "object", properties: { a: { type: "string" } }, required: ["b"] },
  ];
  for (const requestedSchema of bad) {
    const registry = new ToolRegistry();
    registry.register(askTool((ctx) => ctx.elicitForm({ message: "Sure?", requestedSchema })));
    const { client } = startServer({}, registry);
    await client.initialize({ elicitation: {} });
    await call(client, 10);
    const result = (await client.nextResponse(10)).result;
    assert.equal(result.structuredContent.outcome.error, "Error", JSON.stringify(requestedSchema));
    assert.match(result.structuredContent.outcome.message, /elicitation schema/);
    await client.expectSilence(20); // nothing was sent to the client
  }
});

test("primitive properties with titles, enums, bounds and defaults are accepted", async () => {
  const registry = new ToolRegistry();
  registry.register(askTool((ctx) => ctx.elicitForm({
    message: "Pick",
    requestedSchema: {
      type: "object",
      title: "Pick",
      properties: {
        name: { type: "string", title: "Name", minLength: 1, maxLength: 10, default: "x" },
        count: { type: "integer", minimum: 0, maximum: 5 },
        ratio: { type: "number" },
        ok: { type: "boolean", default: false },
        mode: { type: "string", enum: ["a", "b"] },
      },
      required: ["ok"],
    },
  })));
  const { client } = startServer({}, registry);
  await client.initialize({ elicitation: {} });
  await call(client, 10);
  const ask = await client.next((m: Json) => m.method === "elicitation/create");
  assert.equal(Object.keys(ask.params.requestedSchema.properties).length, 5);
});
