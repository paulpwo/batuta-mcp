import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import type net from "node:net";
import { LiveClient, LiveError } from "../src/live/index.js";
import type { LiveClientOptions } from "../src/live/index.js";
import { createLogger } from "../src/log.js";
import { ToolRegistry } from "../src/mcp/index.js";
import { registerStatusTool } from "../src/tools/status.js";
import { defaultConfig, parseConfig } from "../src/config/index.js";
import { FakeScript, frame, waitFor } from "./helpers/fake-script.js";

/* Session ownership (F-T9-6): the session holding Live keeps it, others are refused until it releases. */
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

/** A fake Remote Script that keeps the real single-client rule: a second client gets a busy frame and a close. */
async function singleClientScript(): Promise<FakeScript> {
  let holder: net.Socket | null = null;
  const s = await FakeScript.create({
    onConnection: (conn) => {
      if (holder !== null && !holder.destroyed) {
        conn.write(frame({ type: "error", error: { code: "busy", message: "another client is connected" } }));
        conn.end();
        return true;
      }
      holder = conn;
      conn.on("close", () => { if (holder === conn) holder = null; });
      return false;
    },
  });
  cleanups.push(() => s.close());
  return s;
}

function session(s: FakeScript, overrides: Partial<LiveClientOptions> = {}): LiveClient {
  const client = new LiveClient({
    runtimeDir: s.dir,
    flags: { allowPlugins: false, allowUserPresets: false, allowAudioImport: false, allowMaxForLive: false, allowExternalDevices: false },
    clientName: "batuta-mcp/0.1.0",
    logger: createLogger({ sink: () => undefined }),
    delaysMs: [10, 20, 40], jitter: 0, slowRetryMs: 80, helloTimeoutMs: 150, connectWaitMs: 400,
    onDemand: true, idleReleaseMs: 5000,
    ...overrides,
  });
  cleanups.push(() => client.close());
  return client;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("an on-demand client does not connect until a call needs Live, and status works meanwhile", async () => {
  const s = await singleClientScript();
  const client = session(s);
  await sleep(150);
  assert.equal(s.connectionCount, 0);
  assert.equal(client.state, "idle");
  assert.equal(client.status().state, "idle");
  await client.call("ping", {});
  assert.equal(s.connectionCount, 1);
  assert.equal(client.state, "ready");
});

test("the batuta_status tool answers without connecting and says the connection is idle", async () => {
  const s = await singleClientScript();
  const client = session(s);
  const registry = new ToolRegistry();
  registerStatusTool(registry, { live: client, config: defaultConfig() });
  const registered = registry.get("batuta_status");
  assert.ok(registered);
  const result = await registered.tool.handler({}, { signal: new AbortController().signal } as never);
  assert.equal((result.structuredContent as { connection: { state: string } }).connection.state, "idle");
  assert.match((result.content?.[0] as { text: string }).text, /idle|next tool call/i);
  assert.equal(s.connectionCount, 0);
});

test("a second session is refused with held_by_other_session and never takes the slot", async () => {
  const s = await singleClientScript();
  const holder = session(s);
  const other = session(s);
  await holder.call("ping", {});
  const error = await other.call("ping", {}).then(() => null, (e: unknown) => e as LiveError);
  assert.ok(error instanceof LiveError);
  assert.equal(error.code, "busy");
  assert.equal(error.details?.["reason"], "held_by_other_session");
  assert.match(error.message, /another Claude session/);
  assert.match(error.message, /5 s/);
  await sleep(300); // a refused session does not retry or poll on its own
  assert.equal(s.connectionCount, 2);
  assert.notEqual(other.state, "ready");
  assert.notEqual(other.state, "backoff");
  assert.equal(holder.state, "ready");
  await holder.call("ping", {}); // the holder keeps working
});

test("the holder releases after the idle period; the other session then connects on its next call", async () => {
  const s = await singleClientScript();
  const holder = session(s, { idleReleaseMs: 100 });
  const other = session(s, { idleReleaseMs: 5000 });
  await holder.call("ping", {});
  await waitFor(() => holder.state === "released", 1500);
  await waitFor(() => s.connections.size === 0, 500); // the slot is free at once
  await other.call("ping", {});
  assert.equal(other.state, "ready");
  await sleep(300);
  assert.equal(s.connectionCount, 2, "the released session does not reconnect by itself");
  const error = await holder.call("ping", {}).then(() => null, (e: unknown) => e as LiveError);
  assert.equal(error?.code, "busy");
  assert.equal(error?.details?.["reason"], "held_by_other_session");
});

test("no reconnect or polling while idle after the connection is lost", async () => {
  const s = await singleClientScript();
  const client = session(s);
  await client.call("ping", {});
  s.dropAll();
  await waitFor(() => client.state !== "ready", 500);
  await sleep(400);
  assert.equal(s.connectionCount, 1);
  assert.ok(client.state === "idle" || client.state === "released", client.state);
  await client.call("ping", {}); // the next tool call connects again
  assert.equal(s.connectionCount, 2);
});

test("a request in flight and a hold keep the connection; idle_release 0 never releases", async () => {
  const s = await singleClientScript();
  s.options.onRequest = (request, reply) => { setTimeout(() => reply.ok({ slow: request.cmd === "slow" }), request.cmd === "slow" ? 300 : 0); };
  const client = session(s, { idleReleaseMs: 100 });
  const slow = client.call("slow", {}, { timeoutMs: 2000 });
  await sleep(220);
  assert.equal(client.state, "ready", "in-flight work keeps the slot");
  await slow;
  const release = client.hold();
  await sleep(250);
  assert.equal(client.state, "ready", "a running job keeps the slot");
  release();
  await waitFor(() => client.state === "released", 1500);

  const never = session(s, { idleReleaseMs: 0 });
  await sleep(10);
  await waitFor(() => s.connections.size === 0, 500);
  await never.call("ping", {});
  await sleep(300);
  assert.equal(never.state, "ready");
});

test("config live.idle_release_s defaults to 120 and accepts 0 to 86400", () => {
  assert.equal(defaultConfig().live.idleReleaseS, 120);
  assert.equal(parseConfig({ live: { idle_release_s: 0 } }).live.idleReleaseS, 0);
  assert.equal(parseConfig({ live: { idle_release_s: 30 } }).live.idleReleaseS, 30);
  assert.throws(() => parseConfig({ live: { idle_release_s: -1 } }), /idle_release_s/);
  assert.throws(() => parseConfig({ live: { nope: 1 } }), /live\.nope/);
});
