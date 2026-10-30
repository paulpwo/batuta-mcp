import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { defaultConfig } from "../src/config/index.js";
import type { ServerConfig } from "../src/config/index.js";
import { MENU_SCRIPT, SAVE_AS_SCRIPT } from "../src/host/scripts.js";
import { HOST_TOOL_NAMES } from "../src/tools/host.js";
import { FakeRunner } from "./helpers/fake-host.js";
import { makeApp } from "./helpers/fake-apps.js";
import { readLastApp } from "../src/host/last-app.js";
import { NO_HOST, registryFor, startRig } from "./helpers/tools-harness.js";
import type { Rig } from "./helpers/tools-harness.js";
import type { Json } from "./helpers/mcp-client.js";

/** The six host tools through the whole MCP stack, with a fake runner: schemas, confirmation policy, status, action log. */

const UID = process.getuid?.() ?? 0;
const HOST_CONFIG = (extra: Partial<ServerConfig["host"]> = {}): ServerConfig["host"] => ({ enabled: true, liveApp: "auto", setRoots: [], ...extra });

interface World { base: string; apps: string; root: string; set: string; suite: string; runner: FakeRunner; cleanup(): void }

function world(): World {
  const base = fs.realpathSync(fs.mkdtempSync("/tmp/bm-host-"));
  const apps = path.join(base, "Applications");
  const root = path.join(base, "Music", "Ableton");
  fs.mkdirSync(apps, { recursive: true });
  const suite = makeApp(apps, "Ableton Live 12 Suite.app");
  fs.mkdirSync(root, { recursive: true });
  const set = path.join(root, "song.als");
  fs.writeFileSync(set, "x");
  const runner = new FakeRunner();
  runner.running = [suite];
  return { base, apps, root, set, suite, runner, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

const hostDeps = (w: World) => ({ runner: w.runner.run, applicationsDir: w.apps, home: w.base, uid: UID, platform: "darwin" });

async function rig(w: World, options: { config?: Partial<ServerConfig>; elicitation?: boolean; noWait?: boolean } = {}): Promise<Rig> {
  return startRig({
    config: { host: HOST_CONFIG({ setRoots: [w.root] }), ...(options.config ?? {}) }, host: hostDeps(w), echo: true,
    ...(options.elicitation === true ? { capabilities: { elicitation: { form: {} } } } : {}),
    ...(options.noWait === true ? { noWait: true } : {}),
  });
}

let nextId = 9000;
function start(r: Rig, name: string, args: Json): number {
  const id = nextId++;
  r.client.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  return id;
}
const ask = (r: Rig): Promise<Json> => r.client.next((m: Json) => m.method === "elicitation/create");

test("the six tools are listed with static schemas and annotations; a disabled or non-macOS host lists none", () => {
  const names = (reg: ReturnType<typeof registryFor>): string[] => reg.list().map((t) => t.name).filter((n) => (HOST_TOOL_NAMES as readonly string[]).includes(n));
  const on = registryFor();
  assert.deepEqual(names(on).sort(), [...HOST_TOOL_NAMES].sort());
  const byName = new Map(on.list().map((t) => [t.name, t]));
  const flags = (n: string): unknown[] => { const a = byName.get(n)?.annotations; return [a?.readOnlyHint, a?.destructiveHint, a?.idempotentHint, a?.openWorldHint]; };
  assert.deepEqual(flags("launch_live"), [false, false, true, false]);
  assert.deepEqual(flags("open_set"), [false, true, false, false]);
  assert.deepEqual(flags("new_set"), [false, true, false, false]);
  assert.deepEqual(flags("save_set"), [false, false, true, false]);
  assert.deepEqual(flags("save_set_as"), [false, true, false, false]);
  assert.deepEqual(flags("export_audio"), [false, false, true, false]);
  const schema = (n: string): Json => byName.get(n)?.inputSchema as unknown as Json;
  assert.deepEqual(schema("save_set_as")["required"], ["path"]);
  assert.deepEqual(schema("open_set")["required"], ["path"]);
  assert.equal(schema("launch_live")["required"], undefined);
  assert.deepEqual(((schema("launch_live")["properties"] as Json)["app"] as Json)["enum"], ["suite", "standard", "lite", "intro", "trial", "beta"]);
  for (const n of HOST_TOOL_NAMES) assert.equal(schema(n)["additionalProperties"], false);
  assert.match(byName.get("open_set")?.description ?? "", /own 'save changes\?' dialog/);
  assert.match(byName.get("new_set")?.description ?? "", /own dialog/);
  assert.deepEqual(names(registryFor({ host: HOST_CONFIG({ enabled: false }) })), []);
  assert.deepEqual(names(registryFor({}, { ...NO_HOST, platform: "linux" })), []);
});

test("launch_live works without a Remote Script connection and reports what happened", async () => {
  const w = world();
  try {
    const r = await rig(w, { noWait: true });
    const out = await r.call("launch_live", {});
    assert.equal(out.isError, false);
    assert.deepEqual(out.structuredContent, { action: "activated", app: { name: "Ableton Live 12 Suite", variant: "suite", path: w.suite }, was_running: true, chosen_by: "running" });
    assert.deepEqual(w.runner.actions().map((c) => [c.binary, c.args]), [["/usr/bin/open", ["-a", w.suite]]]);
    assert.deepEqual(r.seen(), [], "nothing was sent to the Remote Script");
    const bad = await r.call("launch_live", { app: "mini" });
    assert.equal(bad.isError, true);
    assert.equal(bad.structuredContent.code, "invalid_args");
    assert.equal((await r.call("launch_live", { app: "suite", extra: 1 })).structuredContent.code, "invalid_args");
    await r.close();
  } finally {
    w.cleanup();
  }
});

test("new_set, save_set and export_audio run the menu script with only the action id; none asks in the default policy", async () => {
  const w = world();
  try {
    const r = await rig(w);
    for (const [tool, action] of [["new_set", "new"], ["save_set", "save"], ["export_audio", "export"]] as const) {
      const out = await r.call(tool, {});
      assert.equal(out.isError, false, tool);
      assert.deepEqual(w.runner.actions().at(-1)?.args, ["-e", MENU_SCRIPT, action], tool);
    }
    assert.equal((await r.call("save_set", {})).structuredContent.result, "saved");
    w.runner.answer = (c) => (c.args[1] === MENU_SCRIPT ? { stdout: "dialog_open" } : undefined);
    const first = await r.call("save_set", {});
    assert.equal(first.structuredContent.result, "save_dialog_open");
    assert.match(first.content[0].text, /Save dialog/);
    assert.equal((await r.call("export_audio", {})).structuredContent.action, "export_dialog_requested");
    await r.close();
  } finally {
    w.cleanup();
  }
});

test("open_set: no prompt by default (Live's own dialog protects the open set); the path travels in argv", async () => {
  const w = world();
  try {
    const r = await rig(w);
    const out = await r.call("open_set", { path: w.set });
    assert.equal(out.isError, false);
    assert.equal(out.structuredContent.action, "open_requested");
    assert.deepEqual(w.runner.actions().map((c) => c.args), [["-a", w.suite, w.set]]);
    await r.close();
  } finally {
    w.cleanup();
  }
});

test("path errors are invalid_args or not_found with the rule named, and nothing reaches the runner", async () => {
  const w = world();
  try {
    const r = await rig(w);
    const cases: Array<[string, Json, string, string]> = [
      ["open_set", { path: "song.als" }, "invalid_args", "not_absolute"],
      ["open_set", { path: `${w.root}/../song.als` }, "invalid_args", "not_normalized"],
      ["open_set", { path: path.join(w.root, "song.txt") }, "invalid_args", "wrong_extension"],
      ["open_set", { path: "/etc/song.als" }, "invalid_args", "outside_roots"],
      ["open_set", { path: path.join(w.root, "missing.als") }, "not_found", ""],
      ["save_set_as", { path: path.join(w.root, "nope", "x.als") }, "not_found", ""],
      ["save_set_as", { path: "/etc/x.als" }, "invalid_args", "outside_roots"],
    ];
    for (const [tool, args, code, reason] of cases) {
      const out = await r.call(tool, args);
      assert.equal(out.isError, true, `${tool} ${JSON.stringify(args)}`);
      assert.equal(out.structuredContent.code, code);
      if (reason !== "") assert.equal(out.structuredContent.details.reason, reason);
    }
    assert.equal((await r.call("open_set", { path: 5 })).structuredContent.code, "invalid_args");
    assert.equal((await r.call("open_set", {})).structuredContent.code, "invalid_args");
    assert.equal((await r.call("open_set", { path: "x".repeat(1025) })).structuredContent.code, "invalid_args");
    assert.equal(w.runner.calls.length, 0);
    await r.close();
  } finally {
    w.cleanup();
  }
});

test("save_set_as onto a new file runs without a question; the replace flag is 0", async () => {
  const w = world();
  try {
    const r = await rig(w, { elicitation: true });
    const target = path.join(w.root, "fresh.als");
    const out = await r.call("save_set_as", { path: target });
    assert.equal(out.isError, false);
    assert.deepEqual(w.runner.actions().map((c) => c.args), [["-e", SAVE_AS_SCRIPT, target, "0"]]);
    assert.deepEqual(out.structuredContent, { action: "save_as_requested", app: { name: "Ableton Live 12 Suite", variant: "suite", path: w.suite }, path: target, replaced: false, result: "saved" });
    await r.close();
  } finally {
    w.cleanup();
  }
});

test("save_set_as onto an existing file asks (elicitation) with the path in the summary; only accept runs it", async () => {
  const w = world();
  try {
    const r = await rig(w, { elicitation: true });
    const id = start(r, "save_set_as", { path: w.set });
    const question = await ask(r);
    assert.equal(question.params.message, `Save the Live set as ${JSON.stringify(w.set)}: this REPLACES the existing file and cannot be undone.`);
    assert.deepEqual(w.runner.calls, [], "nothing runs before the answer");
    r.client.send({ jsonrpc: "2.0", id: question.id, result: { action: "accept", content: { confirm: true } } });
    const done = (await r.client.nextResponse(id)).result;
    assert.equal(done.isError, false);
    assert.deepEqual(w.runner.actions().map((c) => c.args), [["-e", SAVE_AS_SCRIPT, w.set, "1"]]);
    // decline, cancel and accept-without-confirm all stop
    for (const answer of [{ action: "decline" }, { action: "cancel" }, { action: "accept", content: { confirm: false } }]) {
      const before: number = w.runner.calls.length;
      const next = start(r, "save_set_as", { path: w.set });
      const q = await ask(r);
      r.client.send({ jsonrpc: "2.0", id: q.id, result: answer });
      assert.deepEqual((await r.client.nextResponse(next)).result.structuredContent, { cancelled: true });
      assert.equal(w.runner.calls.length, before);
    }
    await r.close();
  } finally {
    w.cleanup();
  }
});

test("without elicitation the existing-file save goes through batuta_confirm, even with Live not connected, and the stored action is re-checked", async () => {
  const w = world();
  try {
    const r = await rig(w, { noWait: true });
    const first = await r.call("save_set_as", { path: w.set });
    assert.equal(first.structuredContent.confirmation_required, true);
    assert.equal(w.runner.calls.length, 0);
    await r.script.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const summary = first.structuredContent.summary as string;
    assert.ok(summary.includes(w.set));
    const wrong = await r.call("batuta_confirm", { confirm_id: first.structuredContent.confirm_id, summary: "something else" });
    assert.equal(wrong.structuredContent.details.reason, "confirm_summary_mismatch");
    const ok = await r.call("batuta_confirm", { confirm_id: first.structuredContent.confirm_id, summary });
    assert.equal(ok.isError, false);
    assert.deepEqual(w.runner.actions().map((c) => c.args), [["-e", SAVE_AS_SCRIPT, w.set, "1"]]);
    const again = await r.call("batuta_confirm", { confirm_id: first.structuredContent.confirm_id, summary });
    assert.equal(again.isError, true, "a used id is refused (here with the Remote Script gone, the connection error comes first)");
    // the file disappears between the question and the confirmation
    const second = await r.call("save_set_as", { path: w.set });
    fs.rmSync(w.set);
    const before = w.runner.calls.length;
    const gone = await r.call("batuta_confirm", { confirm_id: second.structuredContent.confirm_id, summary: second.structuredContent.summary });
    assert.equal(gone.isError, true);
    assert.equal(gone.structuredContent.details.reason, "target_changed");
    assert.equal(w.runner.calls.length, before);
    await r.close();
  } finally {
    w.cleanup();
  }
});

test("a file that appears after planning is never replaced without its question", async () => {
  const w = world();
  try {
    const r = await rig(w, { noWait: true });
    const target = path.join(w.root, "late.als");
    // plan for an absent file, then create it before it runs: the service refuses (target_changed)
    const out = await r.call("save_set_as", { path: target });
    assert.equal(out.isError, false, "absent target ran at once");
    fs.writeFileSync(target, "x");
    const second = await r.call("save_set_as", { path: target });
    assert.equal(second.structuredContent.confirmation_required, true);
    await r.close();
  } finally {
    w.cleanup();
  }
});

test("confirm \"destructive\" also asks for open_set and new_set, but not for the safe tools or a new file", async () => {
  const w = world();
  try {
    const r = await rig(w, { elicitation: true, config: { confirm: "destructive" } });
    const id = start(r, "open_set", { path: w.set });
    const q = await ask(r);
    assert.equal(q.params.message, `Open the Live set ${JSON.stringify(w.set)}: Live leaves the current set (it asks first if there are unsaved changes).`);
    r.client.send({ jsonrpc: "2.0", id: q.id, result: { action: "decline" } });
    assert.deepEqual((await r.client.nextResponse(id)).result.structuredContent, { cancelled: true });
    const idNew = start(r, "new_set", {});
    const q2 = await ask(r);
    assert.match(q2.params.message, /^Start a new Live set/);
    r.client.send({ jsonrpc: "2.0", id: q2.id, result: { action: "accept", content: { confirm: true } } });
    assert.equal((await r.client.nextResponse(idNew)).result.isError, false);
    assert.equal(w.runner.actions().length, 1, "only the accepted new_set ran");
    for (const tool of ["launch_live", "save_set", "export_audio"]) assert.equal((await r.call(tool, {})).isError, false, tool);
    assert.equal((await r.call("save_set_as", { path: path.join(w.root, "new.als") })).isError, false);
    await r.close();
  } finally {
    w.cleanup();
  }
});

test("destructive \"disabled\" refuses replacing an existing set before any question, but still saves to new names", async () => {
  const w = world();
  try {
    const r = await rig(w, { elicitation: true, config: { destructive: "disabled" } });
    const out = await r.call("save_set_as", { path: w.set });
    assert.equal(out.isError, true);
    assert.equal(out.structuredContent.code, "not_supported");
    assert.equal(out.structuredContent.details.reason, "disabled_by_config");
    assert.equal(w.runner.calls.length, 0);
    assert.equal((await r.call("save_set_as", { path: path.join(w.root, "ok.als") })).isError, false);
    assert.equal((await r.call("open_set", { path: w.set })).isError, false);
    await r.close();
  } finally {
    w.cleanup();
  }
});

test("a very long path keeps its file name in the confirmation and the summary stays within 500 characters", async () => {
  const w = world();
  try {
    let dir = w.root;
    for (let i = 0; i < 6; i++) { dir = path.join(dir, "d".repeat(100)); fs.mkdirSync(dir); }
    const set = path.join(dir, "the-song.als");
    fs.writeFileSync(set, "x");
    assert.ok(set.length > 600 && Buffer.byteLength(set) <= 1024);
    const r = await rig(w, { noWait: true });
    const out = await r.call("save_set_as", { path: set });
    const summary = out.structuredContent.summary as string;
    assert.ok(summary.length <= 500, String(summary.length));
    assert.ok(summary.includes('/the-song.als"'));
    assert.ok(summary.includes("REPLACES"));
    await r.close();
  } finally {
    w.cleanup();
  }
});

test("macOS permission errors reach the model as permission_required with the instructions", async () => {
  const w = world();
  try {
    w.runner.answer = (c) => (c.args[1] === MENU_SCRIPT ? { code: 1, stderr: "execution error: osascript is not allowed assistive access. (-25211)" } : undefined);
    const r = await rig(w);
    const out = await r.call("export_audio", {});
    assert.equal(out.isError, true);
    assert.equal(out.structuredContent.code, "permission_required");
    assert.equal(out.structuredContent.details.permission, "accessibility");
    assert.match(out.structuredContent.details.instructions, /Privacy & Security > Accessibility/);
    const status = (await r.call("batuta_status")).structuredContent.host;
    assert.equal(status.accessibility, "denied");
    await r.close();
  } finally {
    w.cleanup();
  }
});

test("Live not running: UI tools say so and name launch_live; open_set still works and launches Live with the set", async () => {
  const w = world();
  try {
    w.runner.running = [];
    const r = await rig(w);
    const out = await r.call("new_set", {});
    assert.equal(out.structuredContent.code, "not_supported");
    assert.equal(out.structuredContent.details.reason, "live_not_running");
    assert.equal(w.runner.actions().length, 0);
    const opened = await r.call("open_set", { path: w.set });
    assert.equal(opened.isError, false);
    assert.equal(opened.structuredContent.was_running, false);
    assert.deepEqual(w.runner.actions().map((c) => c.args), [["-a", w.suite, w.set]]);
    await r.close();
  } finally {
    w.cleanup();
  }
});

test("batuta_status and health report cached host facts and never start a process", async () => {
  const w = world();
  try {
    const r = await rig(w);
    const status = (await r.call("batuta_status")).structuredContent;
    assert.deepEqual(status.host, {
      enabled: true, live_app: "auto", apps: [{ variant: "suite", name: "Ableton Live 12 Suite", path: w.suite }],
      selected: "Ableton Live 12 Suite", last_used: null, running: null, accessibility: "unknown", set_roots_count: 1,
    });
    assert.deepEqual((await r.call("health")).structuredContent, status);
    assert.equal(w.runner.calls.length, 0);
    await r.call("new_set", {});
    const after = (await r.call("batuta_status")).structuredContent.host;
    assert.deepEqual([after.running, after.accessibility], [["Ableton Live 12 Suite"], "granted"]);
    await r.close();
    const off = await startRig({ config: { host: HOST_CONFIG({ enabled: false }) }, host: hostDeps(w), echo: true });
    assert.deepEqual((await off.call("batuta_status")).structuredContent.host, { enabled: false });
    assert.equal(off.registry.get("launch_live"), undefined, "the tool does not exist");
    await off.close();
  } finally {
    w.cleanup();
  }
});

test("every host call that ran is in the action log with its tool and path, never contents", async () => {
  const w = world();
  try {
    const r = await rig(w);
    await r.call("launch_live", {});
    await r.call("open_set", { path: w.set });
    await r.call("save_set", {});
    await r.call("save_set_as", { path: path.join(w.root, "copy.als") });
    const refused = await r.call("open_set", { path: "/etc/x.als" });
    assert.equal(refused.isError, true);
    const recent = (await r.call("batuta_status")).structuredContent.recent_actions as Array<{ tool: string; targets: string[]; undoable: boolean; outcome?: string }>;
    assert.deepEqual(recent.map((a) => [a.tool, a.targets, a.undoable, a.outcome]).reverse(), [
      ["launch_live", [], false, "ok"], ["open_set", [w.set], false, "ok"], ["save_set", [], false, "ok"], ["save_set_as", [path.join(w.root, "copy.als")], false, "ok"],
    ]);
    assert.ok(!JSON.stringify(recent).includes("not a real set"));
    await r.close();
  } finally {
    w.cleanup();
  }
});

test("a failed host call is logged with the error code as its outcome", async () => {
  const w = world();
  try {
    w.runner.answer = (c) => (c.args[1] === MENU_SCRIPT ? { code: 1, stderr: "execution error: x (-25211)" } : undefined);
    const r = await rig(w);
    assert.equal((await r.call("new_set", {})).isError, true);
    w.runner.running = [];
    assert.equal((await r.call("save_set", {})).isError, true);
    const recent = (await r.call("batuta_status")).structuredContent.recent_actions as Array<{ tool: string; outcome?: string }>;
    assert.deepEqual(recent.map((a) => [a.tool, a.outcome]).reverse(), [["new_set", "permission_required"], ["save_set", "not_supported"]]);
    await r.close();
  } finally {
    w.cleanup();
  }
});

test("the host tools are not part of the Remote Script catalog: no command is ever sent to it", async () => {
  const w = world();
  try {
    const r = await rig(w);
    for (const [tool, args] of [["launch_live", {}], ["open_set", { path: w.set }], ["new_set", {}], ["save_set", {}], ["export_audio", {}], ["save_set_as", { path: path.join(w.root, "z.als") }]] as const) await r.call(tool, args);
    assert.deepEqual(r.seen(), []);
    await r.close();
  } finally {
    w.cleanup();
  }
});

// ------------------------------------------------------------------ config

test("host config keys: defaults, parsing and rejection", async () => {
  const { parseConfig, defaultConfig: defaults, ConfigError } = await import("../src/config/index.js");
  assert.deepEqual(defaults().host, { enabled: true, liveApp: "auto", setRoots: [] });
  assert.deepEqual(defaultConfig().host, { enabled: true, liveApp: "auto", setRoots: [] });
  assert.deepEqual(parseConfig({ host: { enabled: false, live_app: "lite", set_roots: ["/Users/x/Music/Ableton"] } }).host, { enabled: false, liveApp: "lite", setRoots: ["/Users/x/Music/Ableton"] });
  assert.deepEqual(parseConfig({ host: {} }).host, defaults().host);
  for (const bad of [{ host: [] }, { host: { enabled: "yes" } }, { host: { live_app: "pro" } }, { host: { live_app: 1 } }, { host: { set_roots: ["rel"] } }, { host: { set_roots: ["/"] } }, { host: { set_roots: ["/a/../b"] } }, { host: { set_roots: "/a" } }, { host: { nope: 1 } }, { host: { set_roots: Array.from({ length: 17 }, (_, i) => `/r${i}`) } }]) {
    assert.throws(() => parseConfig(bad), ConfigError, JSON.stringify(bad));
  }
  for (const app of ["auto", "suite", "standard", "lite", "intro", "trial", "beta"]) assert.equal(parseConfig({ host: { live_app: app } }).host.liveApp, app);
});

test("save_set_as over an existing <name> Project/<name>.als asks about that exact file", async () => {
  const w = world();
  try {
    const file = path.join(w.root, "song Project", "song.als");
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, "x");
    fs.unlinkSync(w.set);
    const r = await rig(w, { elicitation: true });
    const id = start(r, "save_set_as", { path: w.set });
    const question = await ask(r);
    assert.equal(question.params.message, `Save the Live set as ${JSON.stringify(file)}: this REPLACES the existing file and cannot be undone.`);
    r.client.send({ jsonrpc: "2.0", id: question.id, result: { action: "decline" } });
    await r.client.nextResponse(id);
    await r.close();
  } finally {
    w.cleanup();
  }
});

test("a successful connection remembers its edition, and the next launch_live with Live closed starts it (F-T9-26)", async () => {
  const w = world();
  makeApp(w.apps, "Ableton Live 12 Lite.app");
  const runtimeDir = path.join(w.base, "runtime");
  fs.mkdirSync(runtimeDir, { mode: 0o700 });
  fs.chmodSync(runtimeDir, 0o700);
  try {
    w.runner.running = [];
    const r = await startRig({ config: { host: HOST_CONFIG({ setRoots: [w.root] }) }, host: { ...hostDeps(w), runtimeDir }, echo: true }); // the fake script welcomes as Lite
    assert.equal(readLastApp(runtimeDir, { expectedUid: UID }), "lite");
    const out = await r.call("launch_live", {});
    assert.equal(out.structuredContent.app.variant, "lite");
    assert.equal(out.structuredContent.chosen_by, "last_used");
    assert.deepEqual(w.runner.actions().map((c) => c.args), [["-a", path.join(w.apps, "Ableton Live 12 Lite.app")]]);
    await r.close();
  } finally {
    w.cleanup();
  }
});
