import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./helpers/mcp-client.js";
import { BATUTA_INSTRUCTIONS } from "../src/instructions.js";

const clientInfo = { name: "c", version: "1" };

test("initialize echoes a supported protocol version", async () => {
  for (const version of ["2025-11-25", "2025-06-18"]) {
    const { client } = startServer();
    const response = await client.request(1, "initialize", { protocolVersion: version, capabilities: {}, clientInfo });
    assert.equal(response.result.protocolVersion, version);
  }
});

test("initialize answers an unsupported version with the latest supported one", async () => {
  for (const version of ["2024-11-05", "1900-01-01", "2026-07-28", "banana"]) {
    const { client } = startServer();
    const response = await client.request(1, "initialize", { protocolVersion: version, capabilities: {}, clientInfo });
    assert.equal(response.result.protocolVersion, "2025-11-25", version);
  }
});

test("initialize result carries tools and resources capabilities, serverInfo, and no logging capability", async () => {
  const { client } = startServer({ instructions: "Use batuta tools." });
  const { result } = await client.request(1, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo });
  assert.deepEqual(result.capabilities, { tools: { listChanged: false }, resources: {} });
  assert.equal(result.serverInfo.name, "batuta-mcp-test");
  assert.equal(result.serverInfo.version, "9.9.9");
  assert.equal(result.instructions, "Use batuta tools.");
});

test("initialize validates its params", async () => {
  const bad: unknown[] = [
    undefined,
    {},
    { protocolVersion: 5, capabilities: {}, clientInfo },
    { protocolVersion: "2025-11-25", capabilities: [], clientInfo },
    { protocolVersion: "2025-11-25", capabilities: {} },
    { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: 1, version: "1" } },
  ];
  for (const params of bad) {
    const { client } = startServer();
    const response = await client.request(1, "initialize", params);
    assert.equal(response.error.code, -32602, JSON.stringify(params));
  }
});

test("a second initialize is refused", async () => {
  const { client } = startServer();
  await client.initialize();
  const again = await client.request(2, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo });
  assert.equal(again.error.code, -32600);
});

test("ping works before and after initialize", async () => {
  const { client } = startServer();
  assert.deepEqual((await client.request(1, "ping")).result, {});
  await client.initialize();
  assert.deepEqual((await client.request(3, "ping")).result, {});
});

test("shutdown: closing stdin resolves run()", async () => {
  const { client, done } = startServer();
  await client.initialize();
  client.end();
  await done;
});

test("initialize carries the BatutaMCP instructions with the core rules", async () => {
  const { client } = startServer({ instructions: BATUTA_INSTRUCTIONS });
  const { result } = await client.request(1, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo });
  assert.equal(typeof result.instructions, "string");
  assert.ok(result.instructions.length > 0 && result.instructions.length <= 1200, `length ${result.instructions.length}`);
  assert.match(result.instructions, /get_clip_notes/);
  assert.match(result.instructions, /confirm/i);
  assert.match(result.instructions, /gain guard/i);
  assert.match(result.instructions, /undo/i);
  assert.match(result.instructions, /batuta-ears/);
  assert.doesNotMatch(result.instructions, /[^\x20-\x7e\n]/, "plain ASCII text");
});
