import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./helpers/mcp-client.js";
import { FakeWorld } from "./helpers/fake-world.js";
import { startRig } from "./helpers/tools-harness.js";
import { TRANSPORT_PANEL_HTML, TRANSPORT_PANEL_URI } from "../src/ui/transport-panel.js";

/** MCP Apps: the transport panel is a ui:// resource linked from the show_transport_panel tool. */

const URI = "ui://batuta/transport-panel-v3.html";
const MIME = "text/html;profile=mcp-app";

test("the panel URI is the versioned ui:// constant", () => {
  assert.equal(TRANSPORT_PANEL_URI, URI);
});

test("initialize advertises resources next to tools", async () => {
  const { client } = startServer();
  const { result } = await client.request(1, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "c", version: "1" } });
  assert.deepEqual(result.capabilities, { tools: { listChanged: false }, resources: {} });
});

test("resources/list lists exactly the transport panel", async () => {
  const { client } = startServer();
  await client.initialize();
  const { result } = await client.request(2, "resources/list");
  assert.equal(result.resources.length, 1);
  const [panel] = result.resources;
  assert.equal(panel.uri, URI);
  assert.equal(panel.mimeType, MIME);
  assert.equal(typeof panel.name, "string");
  assert.equal(typeof panel.description, "string");
  assert.equal(result.nextCursor, undefined);
});

test("resources/read returns the HTML with the MCP Apps mime type and a border preference", async () => {
  const { client } = startServer();
  await client.initialize();
  const { result } = await client.request(2, "resources/read", { uri: URI });
  assert.equal(result.contents.length, 1);
  const [content] = result.contents;
  assert.equal(content.uri, URI);
  assert.equal(content.mimeType, MIME);
  assert.equal(content.text, TRANSPORT_PANEL_HTML);
  assert.deepEqual(content._meta, { ui: { prefersBorder: true } });
  assert.equal("csp" in content._meta.ui, false, "no csp: the spec default (no network) applies");
});

test("resources/read refuses an unknown URI and invalid params", async () => {
  const { client } = startServer();
  await client.initialize();
  const unknown = await client.request(2, "resources/read", { uri: "ui://batuta/other.html" });
  assert.equal(unknown.error.code, -32002);
  for (const [id, params] of [[3, undefined], [4, {}], [5, { uri: 7 }], [6, []]] as const) {
    const bad = await client.request(id, "resources/read", params);
    assert.equal(bad.error.code, -32602, JSON.stringify(params));
  }
});

test("resources/templates/list is empty", async () => {
  const { client } = startServer();
  await client.initialize();
  assert.deepEqual((await client.request(2, "resources/templates/list")).result, { resourceTemplates: [] });
});

test("resources/* before initialize fail like tools/*", async () => {
  for (const method of ["resources/list", "resources/read", "resources/templates/list"]) {
    const { client } = startServer();
    const response = await client.request(1, method, method === "resources/read" ? { uri: URI } : undefined);
    assert.equal(response.error.code, -32600, method);
    assert.equal(response.error.message, "Server not initialized");
  }
});

test("tools/list links show_transport_panel to the panel for MCP Apps and ChatGPT", async () => {
  const r = await startRig({ answers: new FakeWorld().answers(), echo: true });
  const { result } = await r.client.request(7, "tools/list");
  const tool = result.tools.find((t: { name: string }) => t.name === "show_transport_panel");
  assert.ok(tool, "show_transport_panel is listed");
  assert.deepEqual(tool._meta, { ui: { resourceUri: URI }, "openai/outputTemplate": URI });
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.deepEqual(tool.inputSchema.properties, {});
  assert.match(tool.description, /MCP Apps/);
  const linked = result.tools.filter((t: { _meta?: unknown }) => t._meta !== undefined);
  assert.deepEqual(linked.map((t: { name: string }) => t.name), ["show_transport_panel"], "no other tool carries _meta");
  await r.close();
});

test("show_transport_panel answers like get_transport so hosts without MCP Apps get the full text", async () => {
  const w = new FakeWorld();
  w.songInfoExtra = { signature: [3, 4], is_playing: true, current_song_time: 6.5 };
  const r = await startRig({ answers: w.answers(), echo: true });
  const panel = await r.call("show_transport_panel");
  const plain = await r.call("get_transport");
  assert.equal(panel.isError, false);
  assert.deepEqual(panel.structuredContent, plain.structuredContent);
  assert.deepEqual(panel.content, plain.content);
  assert.equal(panel.structuredContent.current_song_time, 6.5);
  assert.deepEqual(r.seen().map((c) => c.cmd), ["song_info", "song_info"]);
  await r.close();
});
