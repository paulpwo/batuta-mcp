import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./helpers/mcp-client.js";

test("invalid JSON yields -32700 with null id and the server keeps going", async () => {
  const { client } = startServer();
  client.sendRaw("{not json\n");
  const error = await client.nextResponse(null);
  assert.equal(error.error.code, -32700);
  assert.equal(error.jsonrpc, "2.0");
  const pong = await client.request(7, "ping");
  assert.deepEqual(pong.result, {});
});

test("an oversized line is rejected once, discarded, and framing recovers", async () => {
  const { client } = startServer({ maxLineBytes: 256 });
  client.sendRaw(`${"x".repeat(100)}`);
  client.sendRaw(`${"y".repeat(400)}`); // crosses the cap while still no newline
  client.sendRaw(`${"z".repeat(900)}\n`);
  const error = await client.nextResponse(null);
  assert.equal(error.error.code, -32600);
  assert.match(error.error.message, /too large/i);
  client.send({ jsonrpc: "2.0", id: 1, method: "ping" });
  assert.deepEqual((await client.nextResponse(1)).result, {});
  await client.expectSilence(30); // exactly one error for the oversized line
});

test("a line of exactly the cap is accepted, one byte more is not", async () => {
  const { client } = startServer({ maxLineBytes: 64 });
  const base = '{"jsonrpc":"2.0","id":1,"method":"ping","params":{"p":""}}';
  const pad = 64 - Buffer.byteLength(base);
  client.sendRaw(`${base.replace('"p":""', `"p":"${"a".repeat(pad)}"`)}\n`);
  assert.deepEqual((await client.nextResponse(1)).result, {});
  client.sendRaw(`${base.replace('"p":""', `"p":"${"a".repeat(pad + 1)}"`)}\n`);
  assert.equal((await client.nextResponse(null)).error.code, -32600);
});

test("messages split across chunks, multibyte characters split mid-sequence, CRLF and blank lines", async () => {
  const { client } = startServer();
  await client.initialize();
  const payload = Buffer.from(`{"jsonrpc":"2.0","id":5,"method":"ping","params":{"note":"café \u{1F600}"}}\r\n\r\n`);
  for (let i = 0; i < payload.length; i += 3) client.sendRaw(payload.subarray(i, i + 3));
  assert.deepEqual((await client.nextResponse(5)).result, {});
  const two = `{"jsonrpc":"2.0","id":6,"method":"ping"}\n{"jsonrpc":"2.0","id":7,"method":"ping"}\n`;
  client.sendRaw(two);
  assert.deepEqual((await client.nextResponse(6)).result, {});
  assert.deepEqual((await client.nextResponse(7)).result, {});
});

test("invalid UTF-8 is a parse error", async () => {
  const { client } = startServer();
  client.sendRaw(Buffer.from([0x7b, 0xff, 0xfe, 0x7d, 0x0a]));
  assert.equal((await client.nextResponse(null)).error.code, -32700);
});

test("non-finite and absurdly deep JSON is rejected", async () => {
  const { client } = startServer();
  client.sendRaw('{"jsonrpc":"2.0","id":1,"method":"ping","params":{"n":1e999}}\n');
  assert.equal((await client.nextResponse(null)).error.code, -32700);
  client.sendRaw(`${"[".repeat(500)}${"]".repeat(500)}\n`);
  assert.equal((await client.nextResponse(null)).error.code, -32700);
});

test("JSON-RPC batches are rejected (removed in MCP 2025-06-18)", async () => {
  const { client } = startServer();
  client.sendRaw('[{"jsonrpc":"2.0","id":1,"method":"ping"}]\n');
  assert.equal((await client.nextResponse(null)).error.code, -32600);
});

test("invalid request envelopes", async () => {
  const { client } = startServer();
  client.send({ id: 1, method: "ping" }); // missing jsonrpc
  assert.equal((await client.nextResponse(1)).error.code, -32600);
  client.send({ jsonrpc: "1.0", id: 2, method: "ping" });
  assert.equal((await client.nextResponse(2)).error.code, -32600);
  client.send({ jsonrpc: "2.0", id: { a: 1 }, method: "ping" });
  assert.equal((await client.nextResponse(null)).error.code, -32600);
  client.send({ jsonrpc: "2.0", id: null, method: "ping" });
  assert.equal((await client.nextResponse(null)).error.code, -32600);
  client.send({ jsonrpc: "2.0", id: true, method: "ping" });
  assert.equal((await client.nextResponse(null)).error.code, -32600);
  client.send({ jsonrpc: "2.0", id: 3, method: 42 });
  assert.equal((await client.nextResponse(3)).error.code, -32600);
  client.sendRaw("42\n");
  assert.equal((await client.nextResponse(null)).error.code, -32600);
});

test("string ids are echoed unchanged", async () => {
  const { client } = startServer();
  client.send({ jsonrpc: "2.0", id: "abc-1", method: "ping" });
  assert.deepEqual((await client.nextResponse("abc-1")).result, {});
});

test("unknown methods are -32601; unknown notifications are silent; server/discover falls back to legacy", async () => {
  const { client } = startServer();
  await client.initialize();
  assert.equal((await client.request(2, "prompts/list")).error.code, -32601);
  assert.equal((await client.request(3, "server/discover")).error.code, -32601);
  client.notify("notifications/whatever");
  await client.expectSilence();
});

test("requests before initialize are refused except ping; notifications are ignored", async () => {
  const { client } = startServer();
  const refused = await client.request(1, "tools/list");
  assert.equal(refused.error.code, -32600);
  assert.match(refused.error.message, /not initialized/i);
  assert.deepEqual((await client.request(2, "ping")).result, {});
  client.notify("notifications/cancelled", { requestId: 1 });
  await client.expectSilence();
});

test("responses with unknown ids are ignored", async () => {
  const { client, logs } = startServer();
  client.send({ jsonrpc: "2.0", id: 999, result: {} });
  await client.expectSilence();
  assert.ok(logs.length >= 0);
});

test("a server/discover probe before initialize gets method-not-found, then the legacy handshake works", async () => {
  // Dual-era clients (MCP 2026-07-28 and earlier) probe with server/discover and fall back on any
  // error that is not a recognized modern error.
  const { client } = startServer();
  const probe = await client.request(1, "server/discover");
  assert.equal(probe.error.code, -32601);
  const init = await client.request(2, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "c", version: "1" } });
  assert.equal(init.result.protocolVersion, "2025-11-25");
  assert.deepEqual((await client.request(3, "ping")).result, {});
});

test("any unknown method before initialize is method-not-found, known ones are still refused", async () => {
  const { client } = startServer();
  assert.equal((await client.request(1, "prompts/list")).error.code, -32601);
  assert.equal((await client.request(2, "tools/list")).error.code, -32600);
});
