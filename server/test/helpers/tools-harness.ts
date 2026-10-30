import fs from "node:fs";
import { after } from "node:test";
import path from "node:path";
import { LiveClient } from "../../src/live/index.js";
import type { CallOptions } from "../../src/live/index.js";
import { ToolRegistry } from "../../src/mcp/index.js";
import type { McpServerOptions } from "../../src/mcp/index.js";
import { defaultConfig } from "../../src/config/index.js";
import type { ServerConfig } from "../../src/config/index.js";
import { createLogger } from "../../src/log.js";
import { registerBatutaTools } from "../../src/tools/index.js";
import type { BatutaTools, EarsDeps, HostDeps } from "../../src/tools/index.js";
import type { HostRunner } from "../../src/host/runner.js";
import { FakeScript } from "./fake-script.js";
import type { Reply } from "./fake-script.js";
import { startServer } from "./mcp-client.js";
import type { FakeClient, Json } from "./mcp-client.js";

/** The default host wiring of every test: any attempt to start a process fails the test, so a real osascript or open can never run by accident. */
export const DENY_RUNNER: HostRunner = () => Promise.reject(new Error("a test tried to run a host program without injecting a fake runner"));
export const NO_HOST: HostDeps = { runner: DENY_RUNNER, applicationsDir: "/nonexistent/batuta-apps", home: "/nonexistent/batuta-home", platform: "darwin" };

/** A LiveClient that never connects (enough to register tools and list them). */
export function makeLive(): LiveClient {
  return new LiveClient({
    runtimeDir: "/nonexistent/batuta-test", flags: { allowPlugins: false, allowUserPresets: false, allowAudioImport: false, allowMaxForLive: false, allowExternalDevices: false },
    clientName: "batuta-mcp/test",
  });
}

export function registryFor(overrides: Partial<ServerConfig> = {}, host: HostDeps = NO_HOST): ToolRegistry {
  const registry = new ToolRegistry();
  registerBatutaTools(registry, { live: makeLive(), config: { ...defaultConfig(), ...overrides }, logger: createLogger({ sink: () => undefined }), host });
  return registry;
}

/** Catalog entries the fake script reports: exactly what the server expects unless a test edits them. */
export type Handler = (request: Json, reply: Reply) => boolean | void;

export interface Rig {
  script: FakeScript;
  live: LiveClient;
  registry: ToolRegistry;
  tools: BatutaTools;
  client: FakeClient;
  config: ServerConfig;
  /** Commands the fake script received, in order (hello/ping excluded). */
  seen(): Array<{ cmd: string; args: Json }>;
  /** Every call the tool layer made to the client, with its options. */
  callLog: Array<{ cmd: string; args: Json; options: CallOptions }>;
  call(name: string, args?: Json, id?: number): Promise<Json>;
  close(): Promise<void>;
  clock: { now: number };
  /** The catalog the fake script answers with; tests replace `value` to simulate another script version. */
  catalogState: { value: unknown };
}

export interface RigOptions {
  config?: Partial<ServerConfig>;
  welcome?: Record<string, unknown>;
  /** Answers per command: return a result object to answer ok, or handle the reply yourself and return undefined. */
  answers?: Record<string, (args: Json, request: Json, reply: Reply) => unknown>;
  /** Called first for every request; return true if handled. */
  intercept?: Handler;
  capabilities?: Json;
  server?: Partial<McpServerOptions>;
  /** Skip the catalog answer (to test a missing catalog). */
  catalog?: unknown;
  /** Answer every command without a fake answer with an empty result. */
  echo?: boolean;
  /** Do not wait for the connection. */
  noWait?: boolean;
  /** Host automation wiring; the default refuses to start any process. */
  host?: HostDeps;
  /** Ears wiring (home folder, clock, timing, analyzer); the default is the real thing. */
  ears?: EarsDeps;
}

/** The script catalog the server expects, built from the fixture so it can never drift from the test oracle. */
export function expectedCatalog(): Json {
  const root = path.resolve(import.meta.dirname, "..", "..", "..");
  const parsed = JSON.parse(fs.readFileSync(path.join(root, "test", "fixtures", "script-catalog.json"), "utf8")) as { commands: Array<Json> };
  return {
    commands: parsed.commands.map((c) => ({ name: c["name"], mutating: c["mutating"], destructive: c["destructive"], conditions: c["conditions"] })),
    script_version: "0.1.0",
  };
}

const openRigs = new Set<Rig>();
// Every rig is closed when the test file ends, even when a test failed before it could clean up.
after(async () => { await Promise.all([...openRigs].map((rig) => rig.close())); });

/** A complete in-memory stack: fake script, real LiveClient, real tool registry, in-memory MCP client. */
export async function startRig(options: RigOptions = {}): Promise<Rig> {
  const seen: Array<{ cmd: string; args: Json }> = [];
  const catalogState = { value: options.catalog ?? expectedCatalog() };
  const script = await FakeScript.create({
    ...(options.welcome === undefined ? {} : { welcome: options.welcome }),
    onRequest: (request, reply) => {
      seen.push({ cmd: request.cmd, args: request.args });
      if (options.intercept?.(request, reply) === true) return;
      if (request.cmd === "catalog") {
        if (catalogState.value instanceof Error) reply.fail("unknown_command", "unknown command", { cmd: "catalog" }); else reply.ok(catalogState.value);
        return;
      }
      const answer = options.answers?.[request.cmd];
      if (answer === undefined) {
        if (options.echo === true) reply.ok({}); else reply.fail("unknown_command", `no fake answer for ${request.cmd}`);
        return;
      }
      const result = answer(request.args, request, reply);
      if (result !== undefined) reply.ok(result);
    },
  });
  const config: ServerConfig = { ...defaultConfig(), ...(options.config ?? {}) };
  const live = new LiveClient({
    runtimeDir: script.dir, flags: { allowPlugins: false, allowUserPresets: false, allowAudioImport: config.allowAudioImport, allowMaxForLive: false, allowExternalDevices: false },
    clientName: "batuta-mcp/test", logger: createLogger({ sink: () => undefined }), delaysMs: [20, 40], jitter: 0, connectWaitMs: 500, timeoutGraceMs: 50,
    expectedUid: process.getuid?.() ?? 0,
  });
  live.start();
  if (options.noWait !== true) await live.ready(2000);
  const clock = { now: 1_000_000 };
  const registry = new ToolRegistry();
  const callLog: Array<{ cmd: string; args: Json; options: CallOptions }> = [];
  const spy = {
    call: (cmd: string, args: Record<string, unknown>, callOptions: CallOptions = {}) => { callLog.push({ cmd, args, options: callOptions }); return live.call(cmd, args, callOptions); },
    ready: (timeoutMs?: number) => live.ready(timeoutMs),
    get welcome() { return live.welcome; },
    status: () => live.status(),
    setConnectedListener: (listener: Parameters<LiveClient["setConnectedListener"]>[0]) => live.setConnectedListener(listener),
  };
  const tools = registerBatutaTools(registry, {
    live: spy, config, logger: createLogger({ sink: () => undefined }), clock: () => clock.now, host: options.host ?? NO_HOST,
    ...(options.ears === undefined ? {} : { ears: options.ears }),
  });
  const { client } = startServer({ ...(options.server ?? {}) }, registry);
  await client.initialize(options.capabilities ?? {});
  let nextId = 100;
  let closed = false;
  const rig: Rig = {
    script, live, registry, tools, client, config, clock, callLog, catalogState,
    seen: () => seen.filter((entry) => entry.cmd !== "catalog"),
    async call(name, args = {}, id = nextId++) {
      client.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
      return (await client.nextResponse(id, 4000)).result as Json;
    },
    async close() {
      if (closed) return;
      closed = true;
      openRigs.delete(rig);
      client.end();
      await live.close();
      await script.close();
    },
  };
  openRigs.add(rig);
  return rig;
}
