/**
 * The MCP App transport panel (MCP Apps extension `io.modelcontextprotocol/ui`, spec 2026-01-26): one
 * self-contained HTML page the host shows in a sandboxed iframe. No dependency, no external load and
 * no network of its own: it talks only to its host over postMessage (JSON-RPC 2.0), and the host
 * proxies its tool calls to this server. Data reaches the DOM only through textContent.
 *
 * Comments inside the page use block syntax only: the static test forbids two slashes in a row anywhere in it.
 */

export const TRANSPORT_PANEL_URI = "ui://batuta/transport-panel-v3.html";

const PANEL_SCRIPT = String.raw`
"use strict";
var PROTOCOL = "2026-01-26";
var REQUEST_TIMEOUT_MS = 8000;
var POLL_PLAYING_MS = 1000;
var POLL_STOPPED_MS = 4000;
var POLL_OFFLINE_MS = 5000;
var BAR_EPSILON = 1e-9;
var SNAP_TOLERANCE = 0.01;

var state = { connected: false, known: false, playing: false, time: 0, tempo: 0, num: 4, den: 4 };
var pending = {};
var nextId = 1;
var pollTimer = null;
var stopped = false;
var polling = false;
var ready = false;
var displayMode = "inline";
var hostModes = [];
var TEXT = "\uFE0E";
var GLYPH_PLAY = "\u25B6" + TEXT;
var GLYPH_STOP = "\u23F9" + TEXT;
var LABELS = { start: "\u23EE" + TEXT, back: "\u23EA" + TEXT, playstop: GLYPH_PLAY, fwd: "\u23E9" + TEXT, float: "\u29C9", dock: "\u2913" };

function $(id) { return document.getElementById(id); }

/* ---- pure transport maths: positions are beats of 1/4 note, as Live reports them */
function beatsPerBar(s) { return s.num * 4 / s.den; }
function barStart(s) { var bar = beatsPerBar(s); return Math.floor(s.time / bar + BAR_EPSILON) * bar; }
function backTarget(s) {
  var start = barStart(s);
  return s.time - start > SNAP_TOLERANCE ? start : Math.max(0, start - beatsPerBar(s));
}
function forwardTarget(s) { return barStart(s) + beatsPerBar(s); }
function describe(s) {
  if (!s.connected) return s.known ? "Live not connected" : "Connecting...";
  var offset = s.time - barStart(s);
  var bar = Math.floor(s.time / beatsPerBar(s) + BAR_EPSILON) + 1;
  var beat = Math.floor(offset / (4 / s.den) + BAR_EPSILON) + 1;
  return (s.playing ? "Playing" : "Stopped") + "  bar " + bar + "." + beat + "  " + s.tempo.toFixed(1) + " BPM  " + s.num + "/" + s.den;
}

/* ---- rendering */
var BUTTONS = ["start", "back", "playstop", "fwd"];
function render() {
  $("status").textContent = describe(state);
  for (var i = 0; i < BUTTONS.length; i++) $(BUTTONS[i]).disabled = !state.connected;
  var playing = state.connected && state.playing;
  var toggle = $("playstop");
  toggle.textContent = playing ? GLYPH_STOP : GLYPH_PLAY;
  toggle.setAttribute("aria-label", playing ? "Stop" : "Play");
  toggle.setAttribute("title", playing ? "Stop" : "Play");
  toggle.setAttribute("aria-pressed", playing ? "true" : "false");
  renderModes();
  reportSize();
}
/* float and dock show only when the host offers the target mode, as the spec requires before any request */
function offers(mode) { return hostModes.indexOf(mode) >= 0; }
function renderModes() {
  $("float").hidden = !(offers("pip") && displayMode !== "pip");
  $("dock").hidden = !(offers("inline") && displayMode === "pip");
}
function requestMode(mode) {
  if (stopped || !ready || !offers(mode)) return;
  request("ui/request-display-mode", { mode: mode }).then(function (result) {
    if (result && typeof result.mode === "string") displayMode = result.mode;
    render();
  }, function () {});
}
function setOffline() { state.connected = false; state.known = true; render(); }

function isTransport(x) {
  return !!x && typeof x === "object" && typeof x.is_playing === "boolean" && typeof x.current_song_time === "number" && isFinite(x.current_song_time) &&
    typeof x.tempo === "number" && isFinite(x.tempo) && Array.isArray(x.signature) && x.signature.length === 2 &&
    x.signature[0] > 0 && x.signature[1] > 0 && isFinite(x.signature[0]) && isFinite(x.signature[1]);
}
function applyResult(result) {
  if (!result || typeof result !== "object" || result.isError === true || !isTransport(result.structuredContent)) { setOffline(); return; }
  var t = result.structuredContent;
  state = { connected: true, known: true, playing: t.is_playing, time: t.current_song_time, tempo: t.tempo, num: t.signature[0], den: t.signature[1] };
  render();
}

/* ---- JSON-RPC over postMessage */
function post(message) { window.parent.postMessage(message, "*"); }
function notify(method, params) { post({ jsonrpc: "2.0", method: method, params: params }); }
function request(method, params) {
  return new Promise(function (resolve, reject) {
    var id = nextId++;
    var timer = setTimeout(function () { delete pending[id]; reject(new Error("timeout")); }, REQUEST_TIMEOUT_MS);
    pending[id] = { resolve: resolve, reject: reject, timer: timer };
    post({ jsonrpc: "2.0", id: id, method: method, params: params });
  });
}
function callTool(name, args) { return request("tools/call", { name: name, arguments: args }); }

/* ---- polling: one timer at a time, started again after each answer */
function pollDelay() { return !state.connected ? POLL_OFFLINE_MS : state.playing ? POLL_PLAYING_MS : POLL_STOPPED_MS; }
function schedule() {
  if (pollTimer !== null) clearTimeout(pollTimer);
  pollTimer = stopped ? null : setTimeout(refresh, pollDelay());
}
function refresh() {
  if (stopped) return;
  if (pollTimer !== null) { clearTimeout(pollTimer); pollTimer = null; }
  if (polling) { schedule(); return; }
  polling = true;
  callTool("get_transport", {}).then(applyResult, setOffline).then(function () { polling = false; schedule(); });
}
function act(name, args) {
  if (!state.connected || stopped) return;
  callTool(name, args).then(null, function () {}).then(refresh);
}

/* ---- host context: theme and the host's CSS variables */
function applyContext(ctx) {
  if (!ctx || typeof ctx !== "object") return;
  var root = document.documentElement;
  if (ctx.theme === "light" || ctx.theme === "dark") root.setAttribute("data-theme", ctx.theme);
  if (typeof ctx.displayMode === "string") displayMode = ctx.displayMode;
  if (Array.isArray(ctx.availableDisplayModes)) hostModes = ctx.availableDisplayModes.filter(function (m) { return typeof m === "string"; });
  renderModes();
  var vars = ctx.styles && ctx.styles.variables;
  if (vars && typeof vars === "object") {
    for (var key in vars) {
      var value = vars[key];
      if (/^--[a-z0-9-]{1,64}$/.test(key) && typeof value === "string" && /^[^;{}<>]{0,200}$/.test(value)) root.style.setProperty(key, value);
    }
  }
}

/* ---- size reporting */
var lastSize = "";
function reportSize() {
  if (stopped || !ready) return;
  var box = document.body.getBoundingClientRect();
  var size = { width: Math.ceil(box.width), height: Math.ceil(box.height) };
  var key = size.width + "x" + size.height;
  if (key === lastSize) return;
  lastSize = key;
  notify("ui/notifications/size-changed", size);
}

/* ---- inbound messages: only from the host window, only well-formed JSON-RPC 2.0 */
function teardown() {
  stopped = true;
  if (pollTimer !== null) { clearTimeout(pollTimer); pollTimer = null; }
  for (var id in pending) { clearTimeout(pending[id].timer); delete pending[id]; }
}
window.addEventListener("message", function (event) {
  if (event.source !== window.parent) return;
  var m = event.data;
  if (!m || typeof m !== "object" || Array.isArray(m) || m.jsonrpc !== "2.0") return;
  if (typeof m.method === "string") {
    var isRequest = m.id !== undefined && m.id !== null;
    if (m.method === "ui/resource-teardown") {
      teardown();
      if (isRequest) post({ jsonrpc: "2.0", id: m.id, result: {} });
    } else if (stopped) {
      return;
    } else if (m.method === "ui/notifications/tool-result") {
      applyResult(m.params);
      schedule();
    } else if (m.method === "ui/notifications/host-context-changed") {
      applyContext(m.params);
    } else if (isRequest) {
      post({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } });
    }
    return;
  }
  var entry = typeof m.id === "number" ? pending[m.id] : undefined;
  if (!entry) return;
  delete pending[m.id];
  clearTimeout(entry.timer);
  if (m.error !== undefined) entry.reject(new Error("rpc error")); else entry.resolve(m.result);
});

/* ---- buttons */
$("start").addEventListener("click", function () { act("set_song_position", { beats: 0 }); });
$("back").addEventListener("click", function () { act("set_song_position", { beats: backTarget(state) }); });
$("playstop").addEventListener("click", function () { act("control_transport", { action: state.playing ? "stop" : "start" }); });
$("fwd").addEventListener("click", function () { act("set_song_position", { beats: forwardTarget(state) }); });

$("float").addEventListener("click", function () { requestMode("pip"); });
$("dock").addEventListener("click", function () { requestMode("inline"); });

/* ---- start: handshake first, then the first state comes from the tool result or from the first poll */
var prefersDark = typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
document.documentElement.setAttribute("data-theme", prefersDark ? "dark" : "light");
for (var label in LABELS) $(label).textContent = LABELS[label];
render();
if (typeof ResizeObserver === "function") new ResizeObserver(reportSize).observe(document.body);
request("ui/initialize", {
  protocolVersion: PROTOCOL,
  appInfo: { name: "batuta-transport-panel", version: "1.0.0" },
  appCapabilities: { availableDisplayModes: ["inline", "pip"] }
}).then(function (result) {
  applyContext(result && result.hostContext);
  ready = true;
  notify("ui/notifications/initialized", {});
  reportSize();
  schedule();
}, function () { setOffline(); schedule(); });
`;

const PANEL_STYLE = `
:root { color-scheme: light dark; --bg: #ffffff; --fg: #1d1d1f; --muted: #6e6e73; --btn: #f0f0f3; --btn-hover: #e2e2e8; --accent: #0a7d50; --line: #d2d2d7; }
:root[data-theme="dark"] { --bg: #1c1c1e; --fg: #f5f5f7; --muted: #a1a1a6; --btn: #2c2c2e; --btn-hover: #3a3a3c; --accent: #34c98b; --line: #3a3a3c; }
:root[data-theme="light"] { color-scheme: light; }
:root[data-theme="dark"] { color-scheme: dark; }
body { margin: 0; padding: 12px; background: var(--color-background-primary, var(--bg)); color: var(--color-text-primary, var(--fg)); font: 14px/1.4 var(--font-sans, system-ui, sans-serif); }
.row { display: flex; gap: 8px; flex-wrap: wrap; }
button { min-width: 52px; min-height: 44px; padding: 0 14px; border: 1px solid var(--line); border-radius: 8px; background: var(--btn); color: inherit; font: 600 16px/1 ui-sans-serif, system-ui, -apple-system, "Segoe UI Symbol", sans-serif; font-variant-emoji: text; cursor: pointer; }
button:hover:not(:disabled) { background: var(--btn-hover); }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
button[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
button[hidden] { display: none; }
button:disabled { opacity: 0.45; cursor: default; }
#status { margin-top: 10px; white-space: pre; font: 13px/1.4 ui-monospace, monospace; color: var(--color-text-secondary, var(--muted)); }
`;

export const TRANSPORT_PANEL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ableton transport</title>
<style>${PANEL_STYLE}</style>
</head>
<body>
<div class="row" role="group" aria-label="Ableton transport">
<button id="start" type="button" aria-label="Back to start" title="Back to start" disabled></button>
<button id="back" type="button" aria-label="Back one bar" title="Back one bar" disabled></button>
<button id="playstop" type="button" aria-label="Play" title="Play" aria-pressed="false" disabled></button>
<button id="fwd" type="button" aria-label="Forward one bar" title="Forward one bar" disabled></button>
<button id="float" type="button" aria-label="Float the panel" title="Float the panel" hidden></button>
<button id="dock" type="button" aria-label="Back to the chat" title="Back to the chat" hidden></button>
</div>
<div id="status" role="status" aria-live="polite">Connecting...</div>
<script>${PANEL_SCRIPT}</script>
</body>
</html>
`;
