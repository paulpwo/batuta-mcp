import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { LiveClient, LiveError } from "../src/live/index.js";
import type { LiveClientOptions } from "../src/live/index.js";
import { createLogger } from "../src/log.js";
import { FakeScript, waitFor } from "./helpers/fake-script.js";
import type { FakeScriptOptions, Reply } from "./helpers/fake-script.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function script(options: FakeScriptOptions = {}): Promise<FakeScript> {
  const s = await FakeScript.create(options);
  cleanups.push(() => s.close());
  return s;
}

function make(s: FakeScript, overrides: Partial<LiveClientOptions> = {}): LiveClient {
  const client = new LiveClient({
    runtimeDir: s.dir,
    flags: { allowPlugins: false, allowUserPresets: false, allowAudioImport: false, allowMaxForLive: false, allowExternalDevices: false },
    clientName: "batuta-mcp/0.1.0",
    logger: createLogger({ sink: () => undefined }),
    delaysMs: [10, 20, 40], jitter: 0, slowRetryMs: 80, helloTimeoutMs: 150, connectWaitMs: 600,
    ...overrides,
  });
  cleanups.push(() => client.close());
  return client;
}

async function expectLiveError(promise: Promise<unknown>, code: string): Promise<LiveError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof LiveError, `expected LiveError, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    return error;
  }
  throw new assert.AssertionError({ message: `expected LiveError ${code}` });
}

/** What the real script sends for a frame that fails its shape check after authentication. */
function rejectShape(reply: Reply): void {
  reply.send({ id: null, ok: false, error: { code: "bad_request", message: "frame is not acceptable JSON" } });
}

test("requests the script would reject at shape-check time are refused locally and never sent", async () => {
  const s = await script();
  const client = make(s);
  client.start();
  await client.ready(1000);
  const bad: Array<Record<string, unknown>> = [
    { s: "a".repeat(4097) },
    { n: 1e20 },
    { n: 2 ** 53 + 2 },
    { a: new Array(10_001).fill(0) },
    { a: JSON.parse(`${"[".repeat(40)}1${"]".repeat(40)}`) },
    { ["k".repeat(5000)]: 1 },
  ];
  for (const args of bad) {
    const error = await expectLiveError(client.call("x", args), "invalid_args");
    assert.equal((error.details as any).sent, false);
    assert.equal(error.outcomeUnknown, false);
  }
  assert.equal(s.requests.length, 0);
  assert.equal(client.state, "ready");
  // Twenty refused calls consumed no slot: a normal call still goes through.
  for (let i = 0; i < 20; i += 1) await client.call("x", { s: "a".repeat(5000) }).catch(() => undefined);
  assert.deepEqual(await client.call("fine", {}), { echo: "fine", args: {} });
});

test("an id-less bad_request after the handshake drops the connection instead of wedging a slot", async () => {
  const s = await script({ onRequest: (_req, reply) => rejectShape(reply) });
  const client = make(s);
  client.start();
  await client.ready(1000);
  const error = await expectLiveError(client.call("x", {}), "connection_lost");
  assert.equal(error.outcomeUnknown, true);
  s.options.onRequest = (req, reply) => reply.ok({ echo: req.cmd });
  await client.ready(1500);
  assert.deepEqual(await client.call("after", {}), { echo: "after" });
  assert.ok(s.connectionCount >= 2);
});

test("repeated shape rejections never exhaust the 16 in-flight slots", async () => {
  const s = await script({ welcome: { limits: { max_inflight: 16, rate_per_s: 50, burst: 100 } }, onRequest: (_req, reply) => rejectShape(reply) });
  const client = make(s);
  client.start();
  await client.ready(1000);
  for (let round = 0; round < 20; round += 1) {
    await expectLiveError(client.call("x", {}), "connection_lost");
    await client.ready(1500);
  }
  s.options.onRequest = (req, reply) => reply.ok({ echo: req.cmd });
  assert.deepEqual(await client.call("after", {}), { echo: "after" });
  assert.equal(client.status().inflight, 0);
});

test("a burst of rejected calls fails every in-flight and queued call, then recovers", async () => {
  const s = await script({ onRequest: (_req, reply) => rejectShape(reply) });
  const client = make(s);
  client.start();
  await client.ready(1000);
  const calls = Array.from({ length: 24 }, (_, i) => client.call("x", { i }).then(() => "ok", (e: LiveError) => e.code));
  const outcomes = await Promise.all(calls);
  assert.ok(outcomes.every((o) => o === "connection_lost" || o === "not_connected"), outcomes.join(","));
  s.options.onRequest = (req, reply) => reply.ok({ echo: req.cmd });
  await client.ready(1500);
  assert.deepEqual(await client.call("after", {}), { echo: "after" });
});

test("an answer with an id nobody is waiting for is ignored, not treated as a protocol error", async () => {
  const s = await script({ onRequest: (req, reply) => { reply.send({ id: 987654, ok: true, result: {} }); reply.ok({ echo: req.cmd }); } });
  const client = make(s);
  client.start();
  await client.ready(1000);
  assert.deepEqual(await client.call("a", {}), { echo: "a" });
  assert.equal(s.connectionCount, 1);
});

test("watchdog: a timed-out request the script never answers makes the client reconnect", async () => {
  const s = await script({ onRequest: () => undefined });
  const client = make(s, { timeoutGraceMs: 10, abandonedSlotMs: 100 });
  client.start();
  await client.ready(1000);
  await expectLiveError(client.call("silent", {}, { timeoutMs: 100 }), "timeout");
  await waitFor(() => s.connectionCount >= 2, 1500);
  s.options.onRequest = (req, reply) => reply.ok({ echo: req.cmd });
  await client.ready(1500);
  assert.deepEqual(await client.call("after", {}), { echo: "after" });
});

test("sixteen unanswered calls do not leave the client permanently stuck", async () => {
  const s = await script({ onRequest: () => undefined });
  const client = make(s, { timeoutGraceMs: 10, abandonedSlotMs: 100 });
  client.start();
  await client.ready(1000);
  const calls = Array.from({ length: 16 }, () => client.call("silent", {}, { timeoutMs: 100 }).catch((e: LiveError) => e.code));
  assert.deepEqual(new Set(await Promise.all(calls)), new Set(["timeout"]));
  s.options.onRequest = (req, reply) => reply.ok({ echo: req.cmd });
  // A call made now queues behind the 16 abandoned slots. It must not be lost or replayed
  // silently, but once the watchdog has recycled the connection a new call goes through.
  const queued = client.call("queued", {}, { timeoutMs: 3000, requeueOnReconnect: true });
  assert.deepEqual(await queued, { echo: "queued" });
  assert.deepEqual(await client.call("after", {}, { timeoutMs: 3000 }), { echo: "after" });
});

test("the watchdog does not fire when the late answer arrives in time", async () => {
  let held: Reply | undefined;
  const s = await script({ onRequest: (_req, reply) => { held = reply; } });
  const client = make(s, { timeoutGraceMs: 10, abandonedSlotMs: 400 });
  client.start();
  await client.ready(1000);
  await expectLiveError(client.call("slow", {}, { timeoutMs: 100 }), "timeout");
  held!.ok({ late: true });
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(s.connectionCount, 1);
});
