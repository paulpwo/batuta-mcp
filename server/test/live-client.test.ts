import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { LiveClient, LiveError, backoffDelayMs, defaultTimeoutMs } from "../src/live/index.js";
import type { LiveClientOptions } from "../src/live/index.js";
import { createLogger } from "../src/log.js";
import { FakeScript, GOOD_TOKEN, frame, waitFor } from "./helpers/fake-script.js";
import type { Reply, FakeScriptOptions } from "./helpers/fake-script.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function script(options: FakeScriptOptions = {}, writeToken = true): Promise<FakeScript> {
  const s = await FakeScript.create(options, writeToken);
  cleanups.push(() => s.close());
  return s;
}

function make(s: FakeScript, overrides: Partial<LiveClientOptions> = {}) {
  const logs: string[] = [];
  const client = new LiveClient({
    runtimeDir: s.dir,
    flags: { allowPlugins: false, allowUserPresets: false, allowAudioImport: false, allowMaxForLive: false, allowExternalDevices: false },
    clientName: "batuta-mcp/0.1.0",
    logger: createLogger({ sink: (l) => logs.push(l), level: "debug" }),
    delaysMs: [10, 20, 40],
    jitter: 0,
    slowRetryMs: 80,
    helloTimeoutMs: 150,
    connectWaitMs: 400,
    ...overrides,
  });
  cleanups.push(() => client.close());
  return { client, logs };
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

// ------------------------------------------------------------------ handshake

test("handshake sends a minimal hello with the config flags and stores the welcome", async () => {
  const s = await script();
  const { client } = make(s, { flags: { allowPlugins: true, allowUserPresets: false, allowAudioImport: true, allowMaxForLive: true, allowExternalDevices: true }, editionHint: "lite" });
  client.start();
  const welcome = await client.ready(1000);
  assert.equal(client.state, "ready");
  assert.equal(welcome.edition, "lite");
  assert.equal(welcome.scriptVersion, "0.1.0");
  assert.equal(welcome.liveVersion, "12.4.7");
  assert.equal(welcome.protocol, 1);
  assert.equal(s.hellos.length, 1);
  assert.deepEqual(s.hellos[0], {
    type: "hello", protocol: 1, token: GOOD_TOKEN, client: "batuta-mcp/0.1.0", edition_hint: "lite",
    allow_plugins: true, allow_user_presets: false, allow_audio_import: true,
    allow_max_for_live: true, allow_external_devices: true,
  });
});

test("flags default to false and edition_hint is omitted when unset", async () => {
  const s = await script();
  const { client } = make(s);
  client.start();
  await client.ready(1000);
  assert.equal(s.hellos[0].allow_plugins, false);
  assert.equal(s.hellos[0].allow_user_presets, false);
  assert.equal(s.hellos[0].allow_audio_import, false);
  assert.equal(s.hellos[0].allow_max_for_live, false);
  assert.equal(s.hellos[0].allow_external_devices, false);
  assert.equal("edition_hint" in s.hellos[0], false);
});

test("auth_failed is reported, retried slowly, and the token never reaches the log or the error", async () => {
  const s = await script();
  fs.writeFileSync(s.tokenPath, "f".repeat(64), { mode: 0o600 });
  const { client, logs } = make(s);
  client.start();
  const error = await expectLiveError(client.ready(500), "auth_failed");
  assert.equal(error.retryable, false);
  assert.ok(!error.message.includes("f".repeat(64)));
  await waitFor(() => s.connectionCount >= 2, 600); // slow retry, not a tight loop
  assert.ok(s.connectionCount <= 8, `retries must be slow (saw ${s.connectionCount})`);
  assert.ok(logs.every((l) => !l.includes("f".repeat(64)) && !l.includes(GOOD_TOKEN)));
});

test("a welcome with another protocol number is a protocol mismatch with the spec message", async () => {
  const s = await script({ welcome: { protocol: 2 } });
  const { client } = make(s);
  client.start();
  const error = await expectLiveError(client.ready(500), "protocol_mismatch");
  assert.match(error.message, /protocol mismatch: server speaks 1, Remote Script speaks 2/i);
});

test("a bad_request unsupported-protocol error at hello is a protocol mismatch", async () => {
  const s = await script({
    onHello: (_hello, reply) => {
      reply.send({ type: "error", error: { code: "bad_request", message: "unsupported protocol", details: { supported: [3] } } });
      reply.conn.end();
      return true;
    },
  });
  const { client } = make(s);
  client.start();
  await expectLiveError(client.ready(500), "protocol_mismatch");
});

test("an older Remote Script than min_script_version is refused with the reinstall message", async () => {
  const s = await script();
  const { client } = make(s, { minScriptVersion: "0.2.0" });
  client.start();
  const error = await expectLiveError(client.ready(500), "script_too_old");
  assert.match(error.message, /Remote Script 0\.1\.0 is older than required 0\.2\.0: reinstall BatutaMCP from the same release/);
});

test("a malformed welcome is rejected", async () => {
  for (const welcome of [{ script_version: 5 }, { edition: "pro" }, { limits: "x" }, { max_frame: 5 }]) {
    const s = await script({ welcome });
    const { client } = make(s);
    client.start();
    await expectLiveError(client.ready(400), "bad_response");
    await client.close();
  }
});

test("no welcome within the hello timeout closes the connection and retries", async () => {
  const s = await script({ onHello: () => true });
  const { client } = make(s);
  client.start();
  await waitFor(() => s.connectionCount >= 2, 1000);
  assert.notEqual(client.state, "ready");
});

test("busy at connect time is retried with backoff until the slot frees", async () => {
  let seen = 0;
  const s = await script({
    onConnection: (conn) => {
      seen += 1;
      if (seen <= 2) {
        conn.write(frame({ type: "error", error: { code: "busy", message: "another client is connected" } }));
        conn.end();
        return true;
      }
      return false;
    },
  });
  const { client } = make(s);
  client.start();
  await client.ready(1000);
  assert.ok(seen >= 3);
});

test("a successful handshake resets the backoff sequence", async () => {
  let seen = 0;
  const s = await script({
    onConnection: (conn) => {
      seen += 1;
      if (seen === 1) {
        conn.write(frame({ type: "error", error: { code: "busy", message: "another client is connected" } }));
        conn.end();
        return true;
      }
      return false;
    },
  });
  const { client } = make(s, { delaysMs: [10, 20_000] });
  client.start();
  await client.ready(1000);
  s.dropAll();
  await waitFor(() => client.state !== "ready", 500);
  await client.ready(1000); // would take 20 s if the attempt counter had not been reset
  assert.equal(client.status().reconnectAttempts, 0);
});

test("runtime file violations block the connection attempt entirely", async () => {
  const s = await script();
  fs.chmodSync(s.dir, 0o755);
  const { client } = make(s);
  client.start();
  const error = await expectLiveError(client.ready(300), "runtime_files");
  assert.match(error.message, /must not be accessible to group or others/);
  assert.equal(s.connectionCount, 0);
  fs.chmodSync(s.dir, 0o700);
  await client.ready(1500); // recovers once the owner fixes it
});

test("the token is re-read on every connection attempt", async () => {
  const s = await script();
  const { client } = make(s);
  client.start();
  await client.ready(1000);
  fs.rmSync(s.tokenPath);
  s.dropAll();
  await waitFor(() => client.lastError?.code === "runtime_files", 1000);
  fs.writeFileSync(s.tokenPath, GOOD_TOKEN, { mode: 0o600 });
  await client.ready(1500);
});

// ------------------------------------------------------------------ calls

test("call sends id, cmd, args and timeout_ms and resolves with the result", async () => {
  const s = await script();
  const { client } = make(s);
  client.start();
  await client.ready(1000);
  const result = await client.call("track_list", { limit: 3 });
  assert.deepEqual(result, { echo: "track_list", args: { limit: 3 } });
  const sent = s.requests[0];
  assert.equal(Number.isInteger(sent.id), true);
  assert.equal(sent.cmd, "track_list");
  assert.deepEqual(sent.args, { limit: 3 });
  assert.equal(sent.timeout_ms, 5000);
  assert.deepEqual(Object.keys(sent).sort(), ["args", "cmd", "id", "timeout_ms"]);
});

test("default and explicit timeouts follow the spec and are clamped to 100..30000", async () => {
  assert.equal(defaultTimeoutMs("browser_search"), 15_000);
  assert.equal(defaultTimeoutMs("batch"), 10_000);
  assert.equal(defaultTimeoutMs("song_info"), 5_000);
  const s = await script();
  const { client } = make(s);
  client.start();
  await client.ready(1000);
  await client.call("a", {}, { timeoutMs: 5 });
  await client.call("b", {}, { timeoutMs: 999_999 });
  await client.call("browser_search", {});
  assert.deepEqual(s.requests.map((r) => r.timeout_ms), [100, 30_000, 15_000]);
});

test("wire errors become typed LiveErrors with details; unknown codes become bad_response", async () => {
  const s = await script({
    onRequest: (req, reply) => {
      if (req.cmd === "nf") reply.fail("not_found", "Track 9 does not exist", { what: "track", index: 9 });
      else if (req.cmd === "weird") reply.fail("totally_new_code", "?");
      else if (req.cmd === "partial") reply.fail("lom_error", "Live raised", { exception: "RuntimeError", partial: true });
      else reply.fail("edition_limit", "limit", { resource: "tracks", limit: 8, current: 8, edition: "lite" });
    },
  });
  const { client } = make(s);
  client.start();
  await client.ready(1000);
  const nf = await expectLiveError(client.call("nf", {}), "not_found");
  assert.deepEqual(nf.details, { what: "track", index: 9 });
  assert.equal(nf.message, "Track 9 does not exist");
  assert.equal(nf.retryable, false);
  await expectLiveError(client.call("weird", {}), "bad_response");
  const partial = await expectLiveError(client.call("partial", {}), "lom_error");
  assert.equal((partial.details as any).partial, true);
  assert.equal(partial.outcomeUnknown, false);
  const edition = await expectLiveError(client.call("x", {}), "edition_limit");
  assert.equal((edition.details as any).limit, 8);
});

test("responses are correlated by id even when they arrive out of order", async () => {
  const held: Array<{ req: any; reply: Reply }> = [];
  const s = await script({ onRequest: (req, reply) => { held.push({ req, reply }); } });
  const { client } = make(s);
  client.start();
  await client.ready(1000);
  const calls = [client.call("a", { n: 1 }), client.call("b", { n: 2 }), client.call("c", { n: 3 })];
  await waitFor(() => held.length === 3);
  assert.equal(new Set(held.map((h) => h.req.id)).size, 3);
  for (const h of [...held].reverse()) h.reply.ok({ n: h.req.args.n });
  assert.deepEqual(await Promise.all(calls), [{ n: 1 }, { n: 2 }, { n: 3 }]);
});

test("at most 16 requests are in flight; the rest wait for a free slot", async () => {
  const held: Array<{ req: any; reply: Reply }> = [];
  // The script advertises 64; the client still never exceeds 16 (the script's own cap).
  const s = await script({ welcome: { limits: { max_inflight: 64, rate_per_s: 50, burst: 100 } }, onRequest: (req, reply) => { held.push({ req, reply }); } });
  const { client } = make(s);
  client.start();
  await client.ready(1000);
  const calls = Array.from({ length: 20 }, (_, i) => client.call("c", { i }, { timeoutMs: 5000 }));
  await waitFor(() => held.length === 16);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(held.length, 16, "no 17th request before a slot frees");
  held[0]!.reply.ok({ i: 0 });
  await waitFor(() => held.length === 17);
  for (const h of held.slice(1)) h.reply.ok({});
  await waitFor(() => held.length === 20);
  for (const h of held.slice(17)) h.reply.ok({});
  await Promise.all(calls);
});

test("the welcome's max_inflight can only lower the cap", async () => {
  const held: Array<{ req: any; reply: Reply }> = [];
  const s = await script({ welcome: { limits: { max_inflight: 2, rate_per_s: 50, burst: 100 } }, onRequest: (req, reply) => { held.push({ req, reply }); } });
  const { client } = make(s);
  client.start();
  await client.ready(1000);
  const calls = [1, 2, 3].map((i) => client.call("c", { i }));
  await waitFor(() => held.length === 2);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(held.length, 2);
  held[0]!.reply.ok({});
  await waitFor(() => held.length === 3);
  held[1]!.reply.ok({});
  held[2]!.reply.ok({});
  await Promise.all(calls);
});

test("a local timeout reports an unknown outcome, keeps its slot, and ignores the late answer", async () => {
  let hold: Reply | undefined;
  const s = await script({
    onRequest: (req, reply) => { if (req.cmd === "slow") hold = reply; else reply.ok({ fine: true }); },
  });
  const { client, logs } = make(s, { timeoutGraceMs: 20 });
  client.start();
  await client.ready(1000);
  const error = await expectLiveError(client.call("slow", {}, { timeoutMs: 100 }), "timeout");
  assert.equal(error.outcomeUnknown, true);
  assert.equal((error.details as any).stage, "client");
  assert.equal(s.requests[0].timeout_ms, 100);
  hold!.ok({ late: true });
  assert.deepEqual(await client.call("fast", {}), { fine: true });
  assert.ok(!logs.some((l) => /\[error\]/.test(l)), "a late answer to an abandoned call is not an error");
});

test("a timed-out call keeps its in-flight slot until the script answers", async () => {
  const held: Array<{ req: any; reply: Reply }> = [];
  const s = await script({ welcome: { limits: { max_inflight: 1, rate_per_s: 50, burst: 100 } }, onRequest: (req, reply) => { held.push({ req, reply }); } });
  const { client } = make(s, { timeoutGraceMs: 20 });
  client.start();
  await client.ready(1000);
  await expectLiveError(client.call("a", {}, { timeoutMs: 100 }), "timeout");
  const second = client.call("b", {}, { timeoutMs: 2000 });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(held.length, 1, "the script still counts the first request as in flight");
  held[0]!.reply.ok({ late: true });
  await waitFor(() => held.length === 2);
  held[1]!.reply.ok({ b: true });
  assert.deepEqual(await second, { b: true });
});

test("a call that times out while still queued is reported as not sent", async () => {
  const held: Reply[] = [];
  const s = await script({ onRequest: (_req, reply) => { held.push(reply); } });
  const { client } = make(s);
  client.start();
  await client.ready(1000);
  const filler = Array.from({ length: 16 }, () => client.call("c", {}, { timeoutMs: 30_000 }).catch(() => undefined));
  await waitFor(() => held.length === 16);
  const error = await expectLiveError(client.call("queued", {}, { timeoutMs: 100 }), "timeout");
  assert.equal(error.outcomeUnknown, false);
  assert.equal((error.details as any).sent, false);
  assert.equal(s.requests.length, 16);
  await client.close();
  await Promise.all(filler);
});

test("an abort signal cancels a queued or running call locally", async () => {
  const s = await script({ onRequest: () => undefined });
  const { client } = make(s);
  client.start();
  await client.ready(1000);
  const controller = new AbortController();
  const pending = client.call("c", {}, { signal: controller.signal });
  await waitFor(() => s.requests.length === 1);
  controller.abort();
  const error = await expectLiveError(pending, "cancelled");
  assert.equal(error.outcomeUnknown, true);
});

test("oversized requests are refused locally and the connection stays up", async () => {
  const s = await script();
  const { client } = make(s);
  client.start();
  await client.ready(1000);
  await expectLiveError(client.call("big", { s: "a".repeat(2 * 1024 * 1024) }), "too_large");
  assert.equal(s.requests.length, 0);
  assert.equal(client.state, "ready");
  await client.call("ok", {});
});

test("an oversized response header drops the connection, fails pending calls, and reconnects", async () => {
  const s = await script({
    onRequest: (req, reply) => {
      if (req.cmd === "evil") {
        const header = Buffer.alloc(4);
        header.writeUInt32BE(2 * 1024 * 1024);
        reply.raw(header);
      } else reply.ok({ fine: true });
    },
  });
  const { client } = make(s);
  client.start();
  await client.ready(1000);
  const error = await expectLiveError(client.call("evil", {}), "connection_lost");
  assert.equal(error.outcomeUnknown, true);
  await client.ready(1000);
  assert.ok(s.connectionCount >= 2);
  assert.deepEqual(await client.call("again", {}), { fine: true });
});

test("garbage frames from the peer drop the connection", async () => {
  const s = await script({
    onRequest: (req, reply) => {
      if (req.cmd === "evil") {
        const body = Buffer.from("not json");
        const header = Buffer.alloc(4);
        header.writeUInt32BE(body.length);
        reply.raw(Buffer.concat([header, body]));
      }
    },
  });
  const { client } = make(s);
  client.start();
  await client.ready(1000);
  await expectLiveError(client.call("evil", {}), "connection_lost");
  await client.ready(1000);
});

test("losing the connection fails in-flight calls as unknown-outcome and reconnects with backoff", async () => {
  const s = await script({ onRequest: (req, reply) => { if (req.cmd !== "quick") return; reply.ok({}); } });
  const { client } = make(s);
  client.start();
  await client.ready(1000);
  const inflight = client.call("hang", {});
  await waitFor(() => s.requests.length === 1);
  s.dropAll();
  const error = await expectLiveError(inflight, "connection_lost");
  assert.equal(error.outcomeUnknown, true);
  assert.equal(error.retryable, false);
  await client.ready(1500);
  assert.equal(s.connectionCount, 2);
  await client.call("quick", {});
});

async function dropWithQueuedCall(options: { requeueOnReconnect?: boolean }) {
  const held: Reply[] = [];
  const s = await script({ onRequest: (_req, reply) => { held.push(reply); } });
  const { client } = make(s);
  client.start();
  await client.ready(1000);
  const first = Array.from({ length: 16 }, () => client.call("c", {}).catch((e: unknown) => e));
  await waitFor(() => held.length === 16);
  const queued = client.call("queued", {}, { timeoutMs: 3000, ...options });
  s.dropAll();
  const lost = await Promise.all(first);
  assert.ok(lost.every((e) => e instanceof LiveError && e.code === "connection_lost" && e.outcomeUnknown));
  return { s, client, queued };
}

test("a call that was only queued when the connection dropped fails as not sent by default", async () => {
  const { s, client, queued } = await dropWithQueuedCall({});
  const error = await expectLiveError(queued, "not_connected");
  assert.equal((error.details as any).sent, false);
  assert.equal(error.outcomeUnknown, false);
  await client.ready(1500);
  assert.equal(s.requests.filter((r) => r.cmd === "queued").length, 0, "it was never transmitted, now or later");
});

test("with requeueOnReconnect a queued call waits for the new connection and is sent exactly once", async () => {
  const { s, queued } = await dropWithQueuedCall({ requeueOnReconnect: true });
  s.options.onRequest = (req, reply) => reply.ok({ echo: req.cmd });
  assert.deepEqual(await queued, { echo: "queued" });
  assert.equal(s.requests.filter((r) => r.cmd === "queued").length, 1, "never transmitted twice");
});

test("requeueOnReconnect never replays a call that was already sent", async () => {
  const s = await script({ onRequest: () => undefined });
  const { client } = make(s);
  client.start();
  await client.ready(1000);
  const sent = client.call("mutating", {}, { requeueOnReconnect: true });
  await waitFor(() => s.requests.length === 1);
  s.dropAll();
  const error = await expectLiveError(sent, "connection_lost");
  assert.equal(error.outcomeUnknown, true);
  s.options.onRequest = (req, reply) => reply.ok({ echo: req.cmd });
  await client.ready(1500);
  assert.equal(s.requests.filter((r) => r.cmd === "mutating").length, 1);
});

test("a call made while connecting waits for the connection", async () => {
  const s = await script();
  const { client } = make(s);
  client.start();
  assert.deepEqual(await client.call("early", {}), { echo: "early", args: {} });
});

test("when Live is not reachable, call fails with not_connected naming the cause", async () => {
  const s = await script();
  await s.stopListening();
  fs.rmSync(s.sockPath, { force: true });
  const { client } = make(s, { connectWaitMs: 100 });
  client.start();
  const error = await expectLiveError(client.call("x", {}), "not_connected");
  assert.match(error.message, /live\.sock|socket/i);
  assert.equal(error.retryable, true);
});

test("rate_limited and busy rejections are retried a bounded number of times; other errors are not", async () => {
  let attempts = 0;
  const s = await script({
    onRequest: (req, reply) => {
      if (req.cmd === "rl") {
        attempts += 1;
        if (attempts === 1) reply.fail("rate_limited", "slow down", { retry_after_ms: 20 });
        else reply.ok({ attempt: attempts });
      } else if (req.cmd === "busy") {
        reply.fail("busy", "queue full", { reason: "queue_full" });
      } else if (req.cmd === "nf") {
        reply.fail("not_found", "no");
      }
    },
  });
  const { client } = make(s);
  client.start();
  await client.ready(1000);
  assert.deepEqual(await client.call("rl", {}), { attempt: 2 });
  assert.notEqual(s.requests[0].id, s.requests[1].id);
  const busy = await expectLiveError(client.call("busy", {}, { timeoutMs: 3000 }), "busy");
  assert.equal(busy.retryable, true);
  assert.equal(s.requests.filter((r) => r.cmd === "busy").length, 4, "1 try + 3 retries");
  await expectLiveError(client.call("nf", {}), "not_found");
  assert.equal(s.requests.filter((r) => r.cmd === "nf").length, 1);
});

test("a timeout error from the script itself is passed on as timeout (not retried)", async () => {
  const s = await script({ onRequest: (_req, reply) => reply.fail("timeout", "deadline passed in queue", { stage: "queue" }) });
  const { client } = make(s);
  client.start();
  await client.ready(1000);
  const error = await expectLiveError(client.call("x", {}), "timeout");
  assert.equal(error.outcomeUnknown, true, "the script may have been executing when its deadline passed");
  assert.equal((error.details as any).stage, "queue");
  assert.equal(s.requests.length, 1);
});

test("idle keepalive pings are sent and a silent peer is dropped", async () => {
  const s = await script();
  const { client } = make(s, { pingIntervalMs: 30, pongTimeoutMs: 60 });
  client.start();
  await client.ready(1000);
  await waitFor(() => s.pings >= 2, 1000);
  s.ignorePings = true;
  await waitFor(() => s.connectionCount >= 2, 1500);
});

test("backpressure: large writes to a slow reader are queued, not lost or thrown", async () => {
  let paused: import("node:net").Socket | undefined;
  const s = await script({ onConnection: (conn) => { paused = conn; conn.pause(); return false; } });
  const { client } = make(s);
  client.start();
  // Reads are paused on the fake side, so the hello itself cannot be processed yet.
  await waitFor(() => paused !== undefined);
  paused!.resume();
  await client.ready(1000);
  paused!.pause();
  // 150 strings of 4000 bytes: about 600 KB per frame while staying inside the script's per-string cap.
  const big = Array.from({ length: 150 }, () => "x".repeat(4000));
  const calls = Array.from({ length: 8 }, (_, i) => client.call("big", { i, big }, { timeoutMs: 10_000 }));
  await new Promise((r) => setTimeout(r, 100));
  paused!.resume();
  const results = await Promise.all(calls);
  assert.equal(results.length, 8);
  assert.deepEqual(s.requests.map((r) => r.args.i).sort(), [0, 1, 2, 3, 4, 5, 6, 7]);
});

test("close() fails pending calls, stops reconnecting, and rejects later calls", async () => {
  const s = await script({ onRequest: () => undefined });
  const { client } = make(s);
  client.start();
  await client.ready(1000);
  const pending = client.call("hang", {});
  await waitFor(() => s.requests.length === 1);
  await client.close();
  await expectLiveError(pending, "closed");
  await expectLiveError(client.call("x", {}), "closed");
  const count = s.connectionCount;
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(s.connectionCount, count);
  assert.equal(client.state, "closed");
});

test("status() reports connection state without any secret", async () => {
  const s = await script();
  const { client } = make(s);
  client.start();
  await client.ready(1000);
  const status = client.status();
  assert.equal(status.state, "ready");
  assert.equal(status.edition, "lite");
  assert.equal(status.scriptVersion, "0.1.0");
  assert.equal(status.protocol, 1);
  assert.ok(!JSON.stringify(status).includes(GOOD_TOKEN));
});

test("backoffDelayMs follows 0.5,1,2,4,8,15 s with +/-20% jitter and a 15 s cap", () => {
  const options = { delaysMs: [500, 1000, 2000, 4000, 8000, 15000], jitter: 0.2 };
  const zero = (n: number) => backoffDelayMs(n, { ...options, random: () => 0.5 });
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 50].map(zero), [500, 1000, 2000, 4000, 8000, 15000, 15000, 15000]);
  assert.equal(backoffDelayMs(0, { ...options, random: () => 0 }), 400);
  assert.equal(backoffDelayMs(0, { ...options, random: () => 1 }), 600);
  assert.ok(backoffDelayMs(5, { ...options, random: () => 1 }) <= 18000);
});

test("the whole frame body must arrive within the body timeout, not each chunk", async () => {
  let trickle: NodeJS.Timeout | undefined;
  const s = await script({
    onRequest: (req, reply) => {
      if (req.cmd !== "slow") { reply.ok({ fine: true }); return; }
      const header = Buffer.alloc(4);
      header.writeUInt32BE(2000);
      reply.raw(header);
      let sent = 0;
      trickle = setInterval(() => { if (++sent > 100 || reply.conn.destroyed) clearInterval(trickle); else reply.raw(Buffer.from("x")); }, 15);
    },
  });
  cleanups.push(async () => clearInterval(trickle));
  const { client } = make(s, { bodyTimeoutMs: 150 });
  client.start();
  await client.ready(1000);
  const started = Date.now();
  const error = await expectLiveError(client.call("slow", {}, { timeoutMs: 5000 }), "connection_lost");
  assert.ok(Date.now() - started < 1000, "dropped by the body timer long before the call deadline");
  assert.match(error.message, /middle of a frame/);
  await client.ready(1500);
  assert.deepEqual(await client.call("again", {}), { fine: true });
});

test("a frame that arrives in several chunks inside the body timeout is accepted", async () => {
  const s = await script({
    onRequest: (req, reply) => {
      const body = Buffer.from(JSON.stringify({ id: req.id, ok: true, result: { text: "z".repeat(300) } }));
      const header = Buffer.alloc(4);
      header.writeUInt32BE(body.length);
      const all = Buffer.concat([header, body]);
      let at = 0;
      const timer = setInterval(() => {
        reply.raw(all.subarray(at, at + 100));
        at += 100;
        if (at >= all.length) clearInterval(timer);
      }, 20);
    },
  });
  const { client } = make(s, { bodyTimeoutMs: 400 });
  client.start();
  await client.ready(1000);
  assert.deepEqual(await client.call("chunky", {}), { text: "z".repeat(300) });
});

test("a peer that closes during the handshake is reported as another client or lockout, not as Live being down", async () => {
  const s = await script({ onConnection: (conn) => { conn.destroy(); return true; } });
  const { client } = make(s);
  client.start();
  await waitFor(() => s.connectionCount >= 2, 1000);
  const error = client.lastError!;
  assert.equal(error.code, "not_connected");
  assert.match(error.message, /another client|lockout/i);
  assert.doesNotMatch(error.message, /Is Live running/);
  assert.equal((error.details as any).cause, "peer_closed");
  assert.equal(error.retryable, true);
});

test("a missing socket still says Live may not be running", async () => {
  const s = await script();
  await s.stopListening();
  fs.rmSync(s.sockPath, { force: true });
  const { client } = make(s);
  client.start();
  await expectLiveError(client.ready(200), "runtime_files");
  assert.match(client.lastError!.message, /Is Live running/);
});

// ------------------------------------------------------------------ edition provider

test("an edition provider's answer goes into the hello as edition_hint", async () => {
  const s = await script();
  const { client } = make(s, { helloTimeoutMs: 3000 });
  let asked = 0;
  client.setEditionHintProvider(async () => { asked += 1; return "lite"; });
  client.start();
  await client.ready(2000);
  assert.equal(asked, 1);
  assert.equal(s.hellos[0].edition_hint, "lite");
});

test("a provider that never answers is cut off before the hello timeout: the hello goes out without edition_hint", async () => {
  const s = await script();
  const { client } = make(s, { helloTimeoutMs: 2500 });
  client.setEditionHintProvider(() => new Promise(() => undefined));
  const started = Date.now();
  client.start();
  await client.ready(2000);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 1400, `the bound is min(2000, hello timeout - 1000) = 1500 ms (took ${elapsed})`);
  assert.equal("edition_hint" in s.hellos[0], false);
});

test("a static editionHint wins and the provider is not asked; a provider that answers nothing or throws leaves the hello unchanged", async () => {
  const s = await script();
  const { client } = make(s, { editionHint: "suite", helloTimeoutMs: 3000 });
  let asked = 0;
  client.setEditionHintProvider(async () => { asked += 1; return "lite"; });
  client.start();
  await client.ready(2000);
  assert.equal(s.hellos[0].edition_hint, "suite");
  assert.equal(asked, 0);
  await client.close();

  for (const provider of [async () => undefined, async (): Promise<"lite"> => { throw new Error("probe broke"); }]) {
    const other = await script();
    const { client: next } = make(other, { helloTimeoutMs: 3000 });
    next.setEditionHintProvider(provider);
    next.start();
    await next.ready(2000);
    assert.equal("edition_hint" in other.hellos[0], false);
  }
});

// ------------------------------------------------------------------ socket watch during a backoff (F-T9-27)

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("a Live restart is noticed within the socket poll, not after the rest of a long backoff delay", async () => {
  const s = await script();
  const { client } = make(s, { delaysMs: [20_000], socketPollMs: 20 });
  client.start();
  await client.ready(1000);
  s.dropAll();
  await s.stopListening(); // Live quit: the socket file is gone
  await waitFor(() => client.state === "backoff", 1000);
  await pause(120); // the client keeps failing with socket_missing and its backoff would now be long
  assert.equal(client.state, "backoff");
  const before = s.connectionCount;
  await s.startListening(); // Live is back
  await waitFor(() => client.state === "ready", 1000);
  assert.equal(s.connectionCount, before + 1);
  assert.equal(client.status().reconnectAttempts, 0);
});

test("a socket that does not change is not retried early: the backoff delay still decides, and only lstat runs in between", async () => {
  const s = await script();
  const { client } = make(s, { delaysMs: [150], socketPollMs: 10 });
  client.start();
  await client.ready(1000);
  s.dropAll();
  await s.stopListening();
  await waitFor(() => client.state === "backoff", 1000);
  await pause(400);
  const attempts = client.status().reconnectAttempts;
  assert.ok(attempts >= 1 && attempts <= 4, `expected about one attempt per 150 ms, saw ${attempts}`);
});

test("a stale socket file that Live replaces is noticed too (new inode)", async () => {
  const s = await script();
  const { client } = make(s, { delaysMs: [20_000], socketPollMs: 20 });
  client.start();
  await client.ready(1000);
  s.dropAll();
  await waitFor(() => client.state !== "ready", 1000);
  await s.stopListening();
  await pause(60);
  await s.startListening();
  await waitFor(() => client.state === "ready", 1000);
});

test("the connected listener hears every handshake, and a listener set while already connected hears the current welcome at once", async () => {
  const s = await script();
  const { client } = make(s);
  const heard: string[] = [];
  client.setConnectedListener((welcome) => { heard.push(welcome.edition); });
  client.start();
  await client.ready(1000);
  assert.deepEqual(heard, ["lite"]);
  s.dropAll();
  await waitFor(() => client.state !== "ready", 500);
  await client.ready(1500);
  assert.deepEqual(heard, ["lite", "lite"]);
  const late: string[] = [];
  client.setConnectedListener((welcome) => { late.push(welcome.liveVersion); });
  assert.deepEqual(late, ["12.4.7"]);
  client.setConnectedListener(() => { throw new Error("boom"); }); // a failing listener does not break the client
  assert.equal(client.state, "ready");
});

test("a call with externalInputAck sends external_input_ack on its frame, and others never do", async () => {
  const s = await script();
  const { client } = make(s);
  client.start();
  await client.ready(1000);
  await client.call("song_info", {});
  await client.call("song_set", { record_mode: true }, { externalInputAck: ["t1", "r0"] });
  assert.equal("external_input_ack" in s.requests[0]!, false);
  assert.deepEqual(s.requests[1]!["external_input_ack"], { tracks: ["t1", "r0"] });
});
