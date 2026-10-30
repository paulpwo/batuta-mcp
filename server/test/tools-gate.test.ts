import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeWorld } from "./helpers/fake-world.js";
import { expectedCatalog, startRig } from "./helpers/tools-harness.js";
import type { Rig } from "./helpers/tools-harness.js";
import type { Json } from "./helpers/mcp-client.js";
import { waitFor } from "./helpers/fake-script.js";

/** Startup catalog check (docs/01-protocol.md sections 9.1 and 11): the server compares the script's catalog with its own table. */

interface CatalogEntry { name: string; mutating: boolean; destructive: string; conditions: string[] }

function catalogWith(edit: (entries: CatalogEntry[]) => CatalogEntry[]): Json {
  const base = expectedCatalog() as { commands: CatalogEntry[]; script_version: string };
  return { ...base, commands: edit(base.commands.map((entry) => ({ ...entry }))) };
}

async function rig(catalog?: unknown, config: Json = {}): Promise<Rig> {
  const w = new FakeWorld();
  return startRig({ answers: w.answers(), echo: true, config: config as never, ...(catalog === undefined ? {} : { catalog }) });
}

const catalogCalls = (r: Rig): number => r.script.requests.filter((request) => request.cmd === "catalog").length;

test("the catalog is read once per connection, before the first command, and again after a reconnect", async () => {
  const r = await rig();
  await r.call("get_session_info");
  await r.call("get_track_info", { track: { kind: "track", index: 0 } });
  assert.equal(catalogCalls(r), 1);
  assert.equal(r.script.requests[0]!.cmd, "catalog", "the check precedes every command");
  r.script.dropAll();
  await waitFor(() => r.live.state === "ready" && r.script.connectionCount >= 2, 3000);
  await r.call("get_session_info");
  assert.equal(catalogCalls(r), 2);
  await r.close();
});

test("concurrent first calls share one catalog check", async () => {
  const r = await rig();
  const ids = [1, 2, 3].map((n) => { const id = 800 + n; r.client.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "get_session_info", arguments: {} } }); return id; });
  for (const id of ids) assert.equal((await r.client.nextResponse(id)).result.isError, false);
  assert.equal(catalogCalls(r), 1);
  await r.close();
});

test("a matching catalog changes nothing; extra commands in the script are not exposed", async () => {
  const extra = catalogWith((entries) => [...entries, { name: "save_set", mutating: true, destructive: "never", conditions: [] }]);
  const r = await rig(extra);
  assert.equal((await r.call("get_session_info")).isError, false);
  assert.equal(r.registry.get("batuta_save_set"), undefined);
  assert.equal((await r.call("batuta_status")).structuredContent.catalog.unreviewed[0], "save_set");
  await r.close();
});

test("a command the script lacks makes only its tool fail, with a clear version error", async () => {
  const r = await rig(catalogWith((entries) => entries.filter((entry) => entry.name !== "clip_crop")));
  const clip = { kind: "session", track: { kind: "track", index: 0 }, slot: 0 };
  const result = await r.call("crop_clip", { clip });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.code, "version_mismatch");
  assert.match(result.structuredContent.message, /clip_crop/);
  assert.match(result.structuredContent.message, /Reinstall BatutaMCP/);
  assert.equal(result.structuredContent.details.command, "clip_crop");
  assert.deepEqual(r.seen(), [], "nothing was sent, no confirmation was asked");
  assert.equal((await r.call("get_session_info")).isError, false, "other tools keep working");
  await r.close();
});

test("a mutating flag that differs disables that tool", async () => {
  const r = await rig(catalogWith((entries) => entries.map((entry) => (entry.name === "song_info" ? { ...entry, mutating: true } : entry))));
  const result = await r.call("get_session_info");
  assert.equal(result.structuredContent.code, "version_mismatch");
  assert.match(result.structuredContent.details.problem, /mutating/);
  await r.close();
});

test("a stricter classification in the script wins (token path asks, disabled mode refuses)", async () => {
  const stricter = catalogWith((entries) => entries.map((entry) => (entry.name === "track_set" ? { ...entry, destructive: "always" } : entry)));
  const r = await rig(stricter, { confirm: "destructive" });
  const first = await r.call("set_track_properties", { track: { kind: "track", index: 0 }, mute: true });
  assert.equal(first.structuredContent.confirmation_required, true);
  assert.deepEqual(r.seen().filter((c) => c.cmd === "track_set"), []);
  await r.close();

  const refused = await rig(stricter, { destructive: "disabled" });
  const result = await refused.call("set_track_properties", { track: { kind: "track", index: 0 }, mute: true });
  assert.equal(result.structuredContent.code, "not_supported");
  assert.equal(result.structuredContent.details.reason, "disabled_by_config");
  // The refusal comes before any name lookup.
  const named = await refused.call("set_track_properties", { track: { name: "Bass" }, mute: true });
  assert.equal(named.structuredContent.details.reason, "disabled_by_config");
  assert.deepEqual(refused.seen().map((c) => c.cmd), []);
  await refused.close();
});

test("a script that is less strict does not relax the server's own table", async () => {
  const laxer = catalogWith((entries) => entries.map((entry) => (entry.name === "track_delete" ? { ...entry, destructive: "never" } : entry)));
  const r = await rig(laxer, { confirm: "destructive" });
  const result = await r.call("delete_track", { track: { kind: "track", index: 1 } });
  assert.equal(result.structuredContent.confirmation_required, true);
  await r.close();
});

test("a script without a catalog command, or with an unreadable one, fails every tool clearly", async () => {
  const old = await rig(new Error("no catalog"));
  const a = await old.call("get_session_info");
  assert.equal(a.structuredContent.code, "version_mismatch");
  assert.match(a.structuredContent.message, /catalog/);
  await old.close();
  const garbled = await rig({ commands: "nope" });
  const b = await garbled.call("get_session_info");
  assert.equal(b.structuredContent.code, "version_mismatch");
  await garbled.close();
});

test("a failed catalog call is not cached: the next call checks again", async () => {
  let attempts = 0;
  const w = new FakeWorld();
  const r = await startRig({
    answers: w.answers(), echo: true,
    intercept: (request, reply) => {
      if (request.cmd === "catalog" && attempts++ === 0) { reply.fail("lom_error", "hiccup"); return true; }
      return false;
    },
  });
  const first = await r.call("get_session_info");
  assert.equal(first.isError, true);
  const second = await r.call("get_session_info");
  assert.equal(second.isError, false);
  await r.close();
});

test("batch ops are checked against the catalog too", async () => {
  const r = await rig(catalogWith((entries) => entries.filter((entry) => entry.name !== "track_set")));
  const result = await r.call("batch", { ops: [{ cmd: "set_track_properties", args: { track: { kind: "track", index: 0 }, mute: true } }] });
  assert.equal(result.structuredContent.code, "version_mismatch");
  await r.close();
});

test("batuta_status reports the catalog check without calling the script", async () => {
  const r = await rig();
  const before = (await r.call("batuta_status")).structuredContent;
  assert.equal(before.catalog.state, "pending");
  assert.equal(catalogCalls(r), 0);
  await r.call("get_session_info");
  const after = (await r.call("batuta_status")).structuredContent;
  assert.equal(after.catalog.state, "ok");
  assert.deepEqual(after.catalog.problems, []);
  const bad = await rig(catalogWith((entries) => entries.filter((entry) => entry.name !== "clip_crop")));
  await bad.call("get_session_info");
  const status = (await bad.call("batuta_status")).structuredContent;
  assert.equal(status.catalog.state, "mismatch");
  assert.equal(status.catalog.problems[0].command, "clip_crop");
  await r.close();
  await bad.close();
});

test("M25: batuta_confirm re-runs the catalog gate: after a reconnect to a script that lost the command, the stored action is refused and never sent", async () => {
  const r = await rig(undefined, { confirm: "destructive" });
  const first = await r.call("delete_track", { track: { kind: "track", index: 1 } });
  assert.equal(first.structuredContent.confirmation_required, true);
  assert.equal(catalogCalls(r), 1);
  r.catalogState.value = catalogWith((entries) => entries.filter((entry) => entry.name !== "track_delete"));
  r.script.dropAll();
  await waitFor(() => r.live.state === "ready" && r.script.connectionCount >= 2, 3000);
  const done = await r.call("batuta_confirm", { confirm_id: first.structuredContent.confirm_id, summary: first.structuredContent.summary });
  assert.equal(done.isError, true);
  assert.equal(done.structuredContent.code, "version_mismatch");
  assert.equal(catalogCalls(r), 2, "the catalog of the new connection was read before anything ran");
  assert.deepEqual(r.seen().filter((c) => c.cmd === "track_delete"), []);
  await r.close();
});

test("M25: after a reconnect to a matching script the catalog is read again and the stored action runs", async () => {
  const r = await rig(undefined, { confirm: "destructive" });
  const first = await r.call("delete_track", { track: { kind: "track", index: 1 } });
  r.script.dropAll();
  await waitFor(() => r.live.state === "ready" && r.script.connectionCount >= 2, 3000);
  const done = await r.call("batuta_confirm", { confirm_id: first.structuredContent.confirm_id, summary: first.structuredContent.summary });
  assert.equal(done.isError, false);
  assert.equal(catalogCalls(r), 2);
  assert.equal(r.seen().filter((c) => c.cmd === "track_delete").length, 1);
  await r.close();
});

test("M25: a mutating-flag mismatch found after a reconnect also refuses the stored action", async () => {
  const r = await rig(undefined, { confirm: "destructive" });
  const first = await r.call("delete_track", { track: { kind: "track", index: 1 } });
  r.catalogState.value = catalogWith((entries) => entries.map((entry) => (entry.name === "track_delete" ? { ...entry, mutating: false } : entry)));
  r.script.dropAll();
  await waitFor(() => r.live.state === "ready" && r.script.connectionCount >= 2, 3000);
  const done = await r.call("batuta_confirm", { confirm_id: first.structuredContent.confirm_id, summary: first.structuredContent.summary });
  assert.equal(done.structuredContent.code, "version_mismatch");
  assert.match(done.structuredContent.details.problem, /mutating/);
  await r.close();
});
