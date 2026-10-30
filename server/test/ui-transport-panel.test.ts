import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { TRANSPORT_PANEL_HTML } from "../src/ui/transport-panel.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------- static properties of the page

test("the panel loads nothing and talks to nobody but its host", () => {
  const html = TRANSPORT_PANEL_HTML;
  assert.ok(html.length > 500 && html.length < 24_000, "small page");
  assert.doesNotMatch(html, /https?:|\/\/|\bsrc\s*=|\bhref\s*=|@import|url\(/i, "no external reference of any kind");
  for (const banned of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "fetch(", "XMLHttpRequest", "WebSocket", "EventSource", "sendBeacon", "eval(", "new Function", "importScripts", "localStorage"]) {
    assert.equal(html.includes(banned), false, banned);
  }
  assert.equal((html.match(/<script/g) ?? []).length, 1, "one inline script");
});

test("the panel speaks the MCP Apps handshake and checks who is talking", () => {
  const html = TRANSPORT_PANEL_HTML;
  for (const needle of ["ui/initialize", "ui/notifications/initialized", "ui/notifications/size-changed", "ui/resource-teardown", "ui/notifications/tool-result", "ui/notifications/host-context-changed", "event.source", "window.parent"]) {
    assert.ok(html.includes(needle), needle);
  }
});

test("the buttons are real, labelled buttons", () => {
  const buttons = TRANSPORT_PANEL_HTML.match(/<button\b[^>]*>/g) ?? [];
  assert.equal(buttons.length, 6, "four transport buttons (play and stop share one toggle) plus float and dock");
  for (const tag of buttons) assert.match(tag, /aria-label="[^"]+"/, tag);
  assert.match(TRANSPORT_PANEL_HTML, /<meta charset="utf-8">/);
  assert.doesNotMatch(TRANSPORT_PANEL_HTML, /\uFE0F/, "text glyphs only, no emoji presentation selector");
  assert.doesNotMatch(TRANSPORT_PANEL_HTML, /id="stop"|id="play"/, "no separate play or stop button");
  assert.match(TRANSPORT_PANEL_HTML, /font-variant-emoji:\s*text/, "buttons ask for text presentation");
  assert.match(TRANSPORT_PANEL_HTML, /Segoe UI Symbol/, "symbol-capable font stack");
});

// ---------------------------------------------------------------- behaviour in a fake browser

class FakeEl {
  textContent = "";
  disabled = false;
  hidden = false;
  attrs: Record<string, string> = {};
  handlers: Record<string, Array<(e?: unknown) => void>> = {};
  style = { props: {} as Record<string, string>, setProperty(key: string, value: string) { this.props[key] = value; } };
  addEventListener(type: string, fn: (e?: unknown) => void): void { (this.handlers[type] ??= []).push(fn); }
  setAttribute(key: string, value: string): void { this.attrs[key] = value; }
  click(): void { if (!this.disabled) for (const fn of this.handlers["click"] ?? []) fn(); }
}

interface Timer { fn: () => void; ms: number }

function makePanel(options: { dark?: boolean } = {}) {
  const script = /<script>([\s\S]*)<\/script>/.exec(TRANSPORT_PANEL_HTML)?.[1];
  assert.ok(script, "inline script present");
  const sent: any[] = [];
  const listeners: Array<(e: unknown) => void> = [];
  const timers = new Map<number, Timer>();
  let nextTimer = 1;
  const elements: Record<string, FakeEl> = {};
  const el = (id: string): FakeEl => (elements[id] ??= new FakeEl());
  const parent = { postMessage: (message: unknown) => { sent.push(JSON.parse(JSON.stringify(message))); } /* structured clone, as a real postMessage */ };
  const window = { parent, addEventListener: (_type: string, fn: (e: unknown) => void) => { listeners.push(fn); }, matchMedia: () => ({ matches: options.dark === true }) };
  const document = { elements, getElementById: el, documentElement: new FakeEl(), body: { getBoundingClientRect: () => ({ width: 320, height: 120 }) } };
  const sandbox = {
    window, document, parent,
    setTimeout: (fn: () => void, ms: number) => { timers.set(nextTimer, { fn, ms }); return nextTimer++; },
    clearTimeout: (id: number) => { timers.delete(id); },
  };
  vm.runInNewContext(script, sandbox, { timeout: 1000 });
  const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
  const deliver = (data: unknown, source: unknown = parent): void => { for (const fn of listeners) fn({ source, data }); };
  const requests = (method: string): any[] => sent.filter((m) => m.method === method && m.id !== undefined);
  const reply = (request: any, result: unknown): void => deliver({ jsonrpc: "2.0", id: request.id, result });
  const handshake = async (hostContext: Record<string, unknown> = { theme: "dark" }): Promise<void> => {
    reply(requests("ui/initialize")[0], { protocolVersion: "2026-01-26", hostCapabilities: {}, hostInfo: { name: "h", version: "1" }, hostContext });
    await flush();
  };
  const transport = (over: Record<string, unknown> = {}) => ({ content: [{ type: "text", text: "Transport: ok." }], structuredContent: { is_playing: false, current_song_time: 8, tempo: 95, signature: [4, 4], ...over } });
  return { sent, timers, el, document, deliver, requests, reply, handshake, flush, transport, parent };
}

test("handshake: ui/initialize first, initialized only after the host answered", async () => {
  const p = makePanel();
  assert.equal(p.sent.length, 1);
  const init = p.sent[0];
  assert.equal(init.jsonrpc, "2.0");
  assert.equal(init.method, "ui/initialize");
  assert.equal(init.params.protocolVersion, "2026-01-26");
  assert.deepEqual(init.params.appCapabilities, { availableDisplayModes: ["inline", "pip"] });
  assert.equal(typeof init.params.appInfo.name, "string");
  await p.flush();
  assert.equal(p.sent.some((m) => m.method === "ui/notifications/initialized"), false, "not before the reply");
  await p.handshake();
  const methods = p.sent.map((m) => m.method);
  assert.ok(methods.indexOf("ui/notifications/initialized") > 0);
  assert.equal(p.sent.find((m) => m.method === "ui/notifications/initialized").id, undefined, "a notification has no id");
  const size = p.sent.find((m) => m.method === "ui/notifications/size-changed");
  assert.deepEqual(size.params, { width: 320, height: 120 });
  assert.equal(p.document.documentElement.attrs["data-theme"], "dark", "theme from hostContext");
});

test("a tool result renders the position line from the structured content", async () => {
  const p = makePanel();
  await p.handshake();
  p.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: p.transport() });
  assert.equal(p.el("status").textContent, "Stopped  bar 3.1  95.0 BPM  4/4");
  p.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: p.transport({ is_playing: true, current_song_time: 9.5, signature: [6, 8], tempo: 120 }) });
  assert.equal(p.el("status").textContent, "Playing  bar 4.2  120.0 BPM  6/8"); /* 6/8: 3 quarter-beats per bar, so 9.5 is half a quarter into bar 4 (starts at 9); beat unit 0.5 */
});

test("the play/stop toggle sends start while stopped and stop while playing", async () => {
  const p = makePanel();
  await p.handshake();
  p.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: p.transport({ is_playing: false }) });
  assert.equal(p.el("playstop").textContent, "\u25B6\uFE0E");
  assert.equal(p.el("playstop").attrs["aria-label"], "Play");
  p.el("playstop").click();
  assert.deepEqual(p.requests("tools/call")[0].params, { name: "control_transport", arguments: { action: "start" } });
  p.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: p.transport({ is_playing: true }) });
  assert.equal(p.el("playstop").textContent, "\u23F9\uFE0E");
  assert.equal(p.el("playstop").attrs["aria-label"], "Stop");
  assert.equal(p.el("playstop").attrs["aria-pressed"], "true");
  p.el("playstop").click();
  assert.deepEqual(p.requests("tools/call")[1].params, { name: "control_transport", arguments: { action: "stop" } });
});

test("the toggle follows a poll answer and there is no separate stop button", async () => {
  const p = makePanel();
  await p.handshake();
  p.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: p.transport() });
  p.el("playstop").click();
  const call = p.requests("tools/call")[0];
  p.reply(call, {});
  await p.flush();
  const poll = p.requests("tools/call").at(-1);
  assert.deepEqual(poll.params, { name: "get_transport", arguments: {} });
  p.reply(poll, p.transport({ is_playing: true }));
  await p.flush();
  assert.equal(p.el("playstop").textContent, "\u23F9\uFE0E");
  assert.equal(p.el("playstop").attrs["aria-label"], "Stop");
  assert.equal(Object.keys(p.document.elements).includes("stop"), false, "no stop element is ever looked up");
  assert.equal(Object.keys(p.document.elements).includes("play"), false);
});

test("back, back-to-start and forward move by bars and never below zero", async () => {
  const p = makePanel();
  await p.handshake();
  const at = async (time: number, button: string): Promise<unknown> => {
    p.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: p.transport({ current_song_time: time }) });
    const before = p.requests("tools/call").length;
    p.el(button).click();
    return p.requests("tools/call")[before]?.params;
  };
  assert.deepEqual(await at(8, "back"), { name: "set_song_position", arguments: { beats: 4 } }, "on a bar line: one bar earlier");
  assert.deepEqual(await at(9.5, "back"), { name: "set_song_position", arguments: { beats: 8 } }, "inside a bar: snap to its start");
  assert.deepEqual(await at(8.005, "back"), { name: "set_song_position", arguments: { beats: 4 } }, "within 0.01 beat of the line counts as on it");
  assert.deepEqual(await at(2, "back"), { name: "set_song_position", arguments: { beats: 0 } });
  assert.deepEqual(await at(0, "back"), { name: "set_song_position", arguments: { beats: 0 } });
  assert.deepEqual(await at(9.5, "fwd"), { name: "set_song_position", arguments: { beats: 12 } });
  assert.deepEqual(await at(8, "fwd"), { name: "set_song_position", arguments: { beats: 12 } });
  assert.deepEqual(await at(50, "start"), { name: "set_song_position", arguments: { beats: 0 } });
});

test("an error result shows Live not connected, disables the buttons and recovers on the next good poll", async () => {
  const p = makePanel();
  await p.handshake();
  p.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: p.transport() });
  assert.equal(p.el("playstop").disabled, false);
  p.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { isError: true, content: [{ type: "text", text: "not_connected: Live is not running" }] } });
  assert.equal(p.el("status").textContent, "Live not connected");
  for (const id of ["start", "back", "playstop", "fwd"]) assert.equal(p.el(id).disabled, true, id);
  const timer = [...p.timers.values()].find((t) => t.ms === 5000);
  assert.ok(timer, "probes every 5 s while not connected");
  timer.fn();
  const poll = p.requests("tools/call").at(-1);
  assert.deepEqual(poll.params, { name: "get_transport", arguments: {} });
  p.reply(poll, p.transport({ current_song_time: 4 }));
  await p.flush();
  assert.equal(p.el("status").textContent, "Stopped  bar 2.1  95.0 BPM  4/4");
  assert.equal(p.el("playstop").disabled, false);
});

test("a JSON-RPC error from the host also means not connected", async () => {
  const p = makePanel();
  await p.handshake();
  p.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: p.transport() });
  p.el("playstop").click();
  const call = p.requests("tools/call")[0];
  p.deliver({ jsonrpc: "2.0", id: call.id, error: { code: -32603, message: "boom" } });
  await p.flush();
  const poll = p.requests("tools/call").at(-1);
  p.deliver({ jsonrpc: "2.0", id: poll.id, error: { code: -32603, message: "boom" } });
  await p.flush();
  assert.equal(p.el("status").textContent, "Live not connected");
});

test("polling runs every second while playing and every four while stopped", async () => {
  const p = makePanel();
  await p.handshake();
  p.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: p.transport({ is_playing: true }) });
  p.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: p.transport({ is_playing: false }) });
  const delays = [...p.timers.values()].map((t) => t.ms);
  assert.ok(delays.includes(4000) && !delays.includes(1000) && !delays.includes(8000), JSON.stringify(delays));
  assert.equal(delays.filter((ms) => ms === 4000).length, 1, "one poll timer at a time");
  p.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: p.transport({ is_playing: true }) });
  assert.deepEqual([...p.timers.values()].map((t) => t.ms), [1000]);
});

test("messages that do not come from the host window or are malformed are ignored", async () => {
  const p = makePanel();
  await p.handshake();
  p.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: p.transport() }, { other: true });
  assert.equal(p.el("status").textContent === "Stopped  bar 3.1  95.0 BPM  4/4", false);
  for (const junk of [null, 5, "x", [], { method: "ui/notifications/tool-result", params: p.transport() }, { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: { is_playing: "yes" } } }]) {
    p.deliver(junk);
  }
  assert.equal(p.el("status").textContent === "Stopped  bar 3.1  95.0 BPM  4/4", false);
});

test("a request that never gets an answer times out after 8 s and a late answer is ignored", async () => {
  const p = makePanel();
  await p.handshake();
  p.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: p.transport() });
  p.el("playstop").click();
  const call = p.requests("tools/call")[0];
  const entry = [...p.timers.entries()].find(([, t]) => t.ms === 8000);
  assert.ok(entry, "a timeout timer exists for the pending request");
  entry[1].fn();
  p.timers.delete(entry[0]);
  await p.flush();
  p.reply(call, p.transport());
  await p.flush();
  assert.equal([...p.timers.values()].filter((t) => t.ms === 8000).length <= 1, true);
});

test("host context changes re-apply the theme; teardown answers and stops every timer", async () => {
  const p = makePanel();
  await p.handshake();
  p.deliver({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { theme: "light", styles: { variables: { "--color-text-primary": "#111", "bad name": "x", "--evil": "a;b{" } } } });
  assert.equal(p.document.documentElement.attrs["data-theme"], "light");
  assert.deepEqual(p.document.documentElement.style.props, { "--color-text-primary": "#111" });
  p.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: p.transport() });
  assert.ok(p.timers.size > 0);
  p.deliver({ jsonrpc: "2.0", id: 77, method: "ui/resource-teardown", params: { reason: "done" } });
  assert.deepEqual(p.sent.at(-1), { jsonrpc: "2.0", id: 77, result: {} });
  assert.equal(p.timers.size, 0);
  p.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: p.transport({ is_playing: true }) });
  assert.equal(p.timers.size, 0, "stays stopped after teardown");
});

// ---------------------------------------------------------------- symbols and display modes

test("the buttons carry transport symbols as text glyphs", async () => {
  const p = makePanel();
  const labels: Record<string, string> = { start: "\u23EE\uFE0E", back: "\u23EA\uFE0E", playstop: "\u25B6\uFE0E", fwd: "\u23E9\uFE0E" };
  for (const [id, glyph] of Object.entries(labels)) assert.equal(p.el(id).textContent, glyph, id);
  for (const id of ["float", "dock"]) {
    assert.ok(p.el(id).textContent.length > 0, id);
    assert.doesNotMatch(p.el(id).textContent, /\uFE0F/);
  }
});

test("float shows only when the host offers pip; pressing it requests pip and dock brings it back", async () => {
  const none = makePanel();
  await none.handshake({ theme: "dark", displayMode: "inline", availableDisplayModes: ["inline"] });
  assert.equal(none.el("float").hidden, true, "host without pip: no float");
  assert.equal(none.el("dock").hidden, true);

  const p = makePanel();
  await p.handshake({ displayMode: "inline", availableDisplayModes: ["inline", "pip"] });
  assert.equal(p.el("float").hidden, false);
  assert.equal(p.el("dock").hidden, true);
  p.el("float").click();
  const ask = p.requests("ui/request-display-mode")[0];
  assert.deepEqual(ask.params, { mode: "pip" });
  p.reply(ask, { mode: "pip" });
  await p.flush();
  assert.equal(p.el("float").hidden, true);
  assert.equal(p.el("dock").hidden, false);
  p.el("dock").click();
  const back = p.requests("ui/request-display-mode")[1];
  assert.deepEqual(back.params, { mode: "inline" });
  p.reply(back, { mode: "inline" });
  await p.flush();
  assert.equal(p.el("float").hidden, false);
  assert.equal(p.el("dock").hidden, true);
});

test("a host-context-changed displayMode updates the buttons; a refused or failed request leaves the mode alone", async () => {
  const p = makePanel();
  await p.handshake({ displayMode: "pip", availableDisplayModes: ["inline", "pip"] });
  assert.equal(p.el("float").hidden, true);
  assert.equal(p.el("dock").hidden, false);
  p.deliver({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { displayMode: "inline" } });
  assert.equal(p.el("float").hidden, false);
  assert.equal(p.el("dock").hidden, true);
  p.deliver({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { availableDisplayModes: ["inline"] } });
  assert.equal(p.el("float").hidden, true, "host stopped offering pip");
  p.deliver({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { availableDisplayModes: ["inline", "pip"] } });
  p.el("float").click();
  const ask = p.requests("ui/request-display-mode")[0];
  p.deliver({ jsonrpc: "2.0", id: ask.id, error: { code: -32000, message: "no" } });
  await p.flush();
  assert.equal(p.el("float").hidden, false, "error: still inline");
  p.el("float").click();
  const second = p.requests("ui/request-display-mode")[1];
  p.reply(second, { mode: "inline" });
  await p.flush();
  assert.equal(p.el("float").hidden, false, "host kept inline");
});

test("a host that offers neither mode hides both buttons", async () => {
  const p = makePanel();
  await p.handshake({ theme: "light" });
  assert.equal(p.el("float").hidden, true);
  assert.equal(p.el("dock").hidden, true);
});
