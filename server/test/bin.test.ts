import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { VERSION, MIN_SCRIPT_VERSION } from "../src/version.js";
import { ToolRegistry } from "../src/mcp/index.js";
import { registerStatusTool } from "../src/tools/status.js";
import { defaultConfig } from "../src/config/index.js";
import { FakeClient } from "./helpers/mcp-client.js";
import { McpServer } from "../src/mcp/index.js";
import { createLogger } from "../src/log.js";
import { LiveClient } from "../src/live/index.js";
import { FakeScript } from "./helpers/fake-script.js";

const BIN = path.resolve(import.meta.dirname, "..", "src", "bin.js");

test("version constants match package.json", () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "..", "package.json"), "utf8")) as { version: string };
  assert.equal(VERSION, pkg.version);
  assert.match(MIN_SCRIPT_VERSION, /^\d+\.\d+\.\d+$/);
});

test("batuta_status reports connection state and a config summary without calling the script", async () => {
  const script = await FakeScript.create();
  const live = new LiveClient({
    runtimeDir: script.dir, flags: { allowPlugins: false, allowUserPresets: false, allowAudioImport: false, allowMaxForLive: false, allowExternalDevices: false },
    clientName: "batuta-mcp/test", logger: createLogger({ sink: () => undefined }),
  });
  live.start();
  await live.ready(1000);
  const registry = new ToolRegistry();
  registerStatusTool(registry, { live, config: defaultConfig() });
  const client = new FakeClient();
  const server = new McpServer({ input: client.toServer, output: client.fromServer, registry, serverInfo: { name: "t", version: "1" }, logger: createLogger({ sink: () => undefined }) });
  const done = server.run();
  await client.initialize();
  const list = (await client.request(2, "tools/list")).result.tools;
  assert.deepEqual(list.map((t: { name: string }) => t.name), ["batuta_status", "health", "get_remote_script_info"], "the status report, its compatibility name and the script info");
  assert.equal(list[0].annotations.readOnlyHint, true);
  const requestsBefore = script.requests.length;
  const result = (await client.request(3, "tools/call", { name: "batuta_status", arguments: {} })).result;
  assert.equal(result.isError, false);
  const status = result.structuredContent;
  assert.equal(status.connection.state, "ready");
  assert.equal(status.connection.edition, "lite");
  assert.equal(status.connection.script_version, "0.1.0");
  assert.equal(status.server.version, VERSION);
  assert.equal(status.config.destructive, "confirm");
  assert.equal(status.config.sample_roots_count, 0);
  assert.equal(script.requests.length, requestsBefore, "status must not send a command to the script");
  assert.ok(!JSON.stringify(result).includes(script.token));
  client.end();
  await done;
  await live.close();
  await script.close();
});

function runBin(env: Record<string, string>, lines: string[], closeAfterMs = 300): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN], { env: { PATH: process.env["PATH"] ?? "", ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
    for (const line of lines) child.stdin.write(`${line}\n`);
    setTimeout(() => child.stdin.end(), closeAfterMs);
  });
}

test("the batuta-mcp binary speaks MCP on stdout only, logs to stderr, and exits 0 when stdin closes", async () => {
  const home = fs.mkdtempSync("/tmp/bm-");
  try {
    const result = await runBin({ HOME: home }, [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "batuta_status", arguments: {} } }),
    ]);
    assert.equal(result.code, 0, result.stderr);
    const messages = result.stdout.trim().split("\n").map((l) => JSON.parse(l) as Record<string, any>); // every stdout line is JSON
    assert.equal(messages.length, 3);
    assert.equal(messages[0]!["result"].serverInfo.name, "batuta-mcp");
    assert.match(messages[0]!["result"].instructions, /get_clip_notes/, "the binary sends the BatutaMCP instructions");
    const toolNames = (messages[1]!["result"].tools as Array<{ name: string }>).map((tool) => tool.name);
    assert.ok(toolNames.includes("batuta_status") && toolNames.includes("batuta_confirm") && toolNames.includes("list_tracks"));
    assert.equal(new Set(toolNames).size, toolNames.length);
    assert.ok(toolNames.length > 120 && toolNames.includes("create_audio_clip"), "the whole surface is in one page; create_audio_clip needs no sample_roots");
    assert.ok(toolNames.includes("get_session_info") && toolNames.includes("fire_clip") && toolNames.includes("health") && !toolNames.some((n) => n.startsWith("batuta_") && n !== "batuta_status" && n !== "batuta_confirm" && n !== "batuta_ears"));
    const status = messages[2]!["result"].structuredContent;
    assert.equal(status.connection.state, "idle", "no Live in this test, and the server does not connect until a tool needs Live");
    assert.equal(status.config.live.idle_release_s, 120);
    assert.match(result.stderr, /batuta-mcp \[info\]/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("an invalid config file stops the binary before it speaks MCP", async () => {
  const home = fs.mkdtempSync("/tmp/bm-");
  try {
    const dir = path.join(home, "Library", "Application Support", "BatutaMCP");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, "server.json"), '{"edtion":"lite"}', { mode: 0o600 });
    const result = await runBin({ HOME: home }, [], 100);
    assert.equal(result.code, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /unknown key "edtion"/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("an invalid BATUTA_LOG_LEVEL stops the binary before it speaks MCP", async () => {
  const home = fs.mkdtempSync("/tmp/bm-");
  try {
    const result = await runBin({ HOME: home, BATUTA_LOG_LEVEL: "loud" }, [], 100);
    assert.equal(result.code, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /BATUTA_LOG_LEVEL/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("a BATUTA_CONFIG that points at a missing file stops the binary", async () => {
  const home = fs.mkdtempSync("/tmp/bm-");
  try {
    const result = await runBin({ HOME: home, BATUTA_CONFIG: path.join(home, "nope.json") }, [], 100);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /does not exist/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("the bin's shebang forbids code generation from strings, and that flag really blocks Function()", () => {
  const firstLine = fs.readFileSync(BIN, "utf8").split("\n")[0] as string;
  assert.equal(firstLine, "#!/usr/bin/env -S node --disallow-code-generation-from-strings");
  const probe = "const out = []; for (const f of [() => Function('return 1')(), () => eval('1'), () => new Function('return 2')()]) { try { f(); out.push('ran'); } catch (e) { out.push(e.name); } } console.log(out.join(','));";
  // Run exactly the interpreter command the shebang names.
  const [command, ...flags] = firstLine.slice(2).split(" ") as [string, ...string[]];
  const guarded = spawnSync(command, [...flags, "-e", probe], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "" } });
  assert.equal(guarded.status, 0, guarded.stderr);
  assert.equal(guarded.stdout.trim(), "EvalError,EvalError,EvalError");
  // Control: without the flag the same code runs, so the assertion above is not vacuous.
  const unguarded = spawnSync(process.execPath, ["-e", probe], { encoding: "utf8" });
  assert.equal(unguarded.stdout.trim(), "ran,ran,ran");
});

async function statusVia(env: Record<string, string>): Promise<{ status: Record<string, any>; stderr: string; code: number | null }> {
  const home = fs.mkdtempSync("/tmp/bm-");
  try {
    const result = await runBin({ HOME: home, ...env }, [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "batuta_status", arguments: {} } }),
    ]);
    const lines = result.stdout.trim() === "" ? [] : result.stdout.trim().split("\n").map((l) => JSON.parse(l) as Record<string, any>);
    return { status: lines[1]?.["result"]?.structuredContent ?? {}, stderr: result.stderr, code: result.code };
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

test("binary level: every documented BATUTA_* config variable reaches the effective config shown by batuta_status", async () => {
  const base = await statusVia({});
  assert.equal(base.status.config.confirm, "irreversible");
  assert.equal(base.status.config.edition, "auto");
  assert.equal(base.status.config.destructive, "confirm");
  assert.deepEqual(base.status.config.gain_guard, { max_jump_db: 6, max_master_db: 0 });
  const cases: Array<[Record<string, string>, (config: Record<string, any>) => void]> = [
    [{ BATUTA_CONFIRM: "destructive" }, (c) => assert.equal(c.confirm, "destructive")],
    [{ BATUTA_EDITION: "lite" }, (c) => assert.equal(c.edition, "lite")],
    [{ BATUTA_DESTRUCTIVE: "disabled" }, (c) => assert.equal(c.destructive, "disabled")],
    [{ BATUTA_MAX_JUMP_DB: "2.5" }, (c) => assert.equal(c.gain_guard.max_jump_db, 2.5)],
    [{ BATUTA_MAX_MASTER_DB: "-3" }, (c) => assert.equal(c.gain_guard.max_master_db, -3)],
  ];
  for (const [env, check] of cases) {
    const result = await statusVia(env);
    assert.equal(result.code, 0, result.stderr);
    check(result.status.config);
  }
});

test("binary level: BATUTA_CONFIG selects the config file, and a variable set to a bad value stops the binary", async () => {
  const dir = fs.mkdtempSync("/tmp/bm-");
  try {
    const file = path.join(dir, "cfg.json");
    fs.writeFileSync(file, '{"edition":"suite","confirm":"destructive"}', { mode: 0o600 });
    fs.chmodSync(dir, 0o700);
    const result = await statusVia({ BATUTA_CONFIG: file });
    assert.equal(result.status.config.edition, "suite");
    assert.equal(result.status.config.confirm, "destructive");
    const overridden = await statusVia({ BATUTA_CONFIG: file, BATUTA_CONFIRM: "irreversible" });
    assert.equal(overridden.status.config.confirm, "irreversible", "the variable wins over the file");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const badValues: Array<Record<string, string>> = [{ BATUTA_CONFIRM: "nope" }, { BATUTA_EDITION: "pro" }, { BATUTA_DESTRUCTIVE: "x" }, { BATUTA_MAX_JUMP_DB: "abc" }, { BATUTA_MAX_MASTER_DB: "99" }];
  for (const bad of badValues) {
    const result = await statusVia(bad);
    assert.equal(result.code, 2, JSON.stringify(bad));
    assert.match(result.stderr, new RegExp(Object.keys(bad)[0] as string));
  }
});

test("binary level: BATUTA_LOG_LEVEL controls what the binary logs to stderr", async () => {
  const info = await statusVia({});
  assert.match(info.stderr, /\[info\]/);
  const quiet = await statusVia({ BATUTA_LOG_LEVEL: "error" });
  assert.doesNotMatch(quiet.stderr, /\[info\]/);
});

test("the Live connection starts only after the tools are registered, so the first hello can use the edition provider", () => {
  const text = fs.readFileSync(path.resolve(import.meta.dirname, "..", "..", "src", "bin.ts"), "utf8");
  const registered = text.indexOf("registerBatutaTools(registry");
  const started = text.indexOf("live.start()");
  assert.ok(registered > 0 && started > 0, "both calls are present");
  assert.ok(registered < started, "registerBatutaTools comes before live.start()");
});
