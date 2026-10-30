import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeWorld } from "./helpers/fake-world.js";
import { startRig } from "./helpers/tools-harness.js";
import type { Rig } from "./helpers/tools-harness.js";
import type { Json } from "./helpers/mcp-client.js";
import { specFor } from "../src/tools/catalog.js";
import { summarize } from "../src/tools/summary.js";
import type { OpPlan } from "../src/tools/plan.js";
import { quoted } from "../src/tools/util.js";
import { ToolError } from "../src/mcp/index.js";
import { LiveError } from "../src/live/index.js";
import { liveToToolError } from "../src/tools/errors.js";

/** Confirmation summaries (docs/01-protocol.md section 9.3): what is destructive comes first and is never cut. */

function plan(command: string, targets: string[], overrides: Partial<OpPlan> = {}): OpPlan {
  const spec = specFor(command)!;
  return { spec, wire: {}, targets, reasons: [], gain: [], irreversible: false, destructive: false, warnings: [], ...overrides };
}
function batch(children: OpPlan[]): OpPlan {
  return {
    spec: specFor("batch")!, wire: {}, children, targets: [], reasons: [], gain: [], irreversible: false, destructive: children.some((c) => c.destructive), warnings: [],
  };
}
const del = (label: string): OpPlan => plan("track_delete", [label], { destructive: true });
const mute = (label: string): OpPlan => plan("track_set", [label]);

test("MAJOR 2: destructive children come first, with their targets, and non-destructive ones follow", () => {
  const text = summarize(batch([mute("track 0"), mute("track 1"), del('track 2 "Pad"'), mute("track 3")]));
  assert.ok(text.indexOf("Delete track") < text.indexOf("Change a track"), text);
  assert.match(text, /op 2/);
  assert.match(text, /Delete track: track 2 "Pad" \(destructive\)/);
  assert.match(text, /^Run a batch: 4 operation\(s\)/);
});

test("MAJOR 2: a gain trip is listed first with its reason, in full", () => {
  const trip = plan("mixer_set", ["track 0"], { destructive: true, reasons: ["volume: raises the level from -10.0 dB to -2.0 dB (+8.0 dB, limit 6.0 dB)"], gain: ["x"] });
  const text = summarize(batch([mute("track 1"), mute("track 2"), trip]));
  assert.match(text, /op 2: .*raises the level from -10\.0 dB to -2\.0 dB \(\+8\.0 dB, limit 6\.0 dB\)/);
  assert.ok(text.indexOf("raises the level") < text.indexOf("Change a track"), text);
});

test("MAJOR 2: filler never pushes a destructive child out: 40 ordinary ops and a delete last", () => {
  const children = [...Array.from({ length: 40 }, (_, i) => mute(`track ${i} "A fairly long track name ${i}"`)), del('track 40 "Lead"')];
  const text = summarize(batch(children));
  assert.ok([...text].length <= 500);
  assert.match(text, /Delete track: track 40 "Lead"/);
  assert.ok(text.indexOf("Delete track") < text.indexOf("Change a track"));
  assert.match(text, /and \d+ more/, "the rest is counted, not listed");
});

test("MAJOR 2: when the destructive part alone does not fit in 500 characters the call is refused with too_large", () => {
  const children = Array.from({ length: 12 }, (_, i) => del(`track ${i} "${"N".repeat(64)}"`));
  assert.throws(() => summarize(batch(children)), (error: unknown) => error instanceof ToolError && error.code === "too_large");
  // Exactly at the limit is accepted.
  let n = 1;
  let last = "";
  for (; n < 12; n += 1) {
    try { last = summarize(batch(Array.from({ length: n }, (_, i) => del(`track ${i} "${"N".repeat(64)}"`)))); } catch { break; }
  }
  assert.ok(n > 1 && [...last].length <= 500);
});

test("MAJOR 2: a single call keeps its reasons whole; targets give way first; reasons that cannot fit refuse", () => {
  const reason = "volume: raises the level from -10.0 dB to -2.0 dB (+8.0 dB, limit 6.0 dB)";
  const text = summarize(plan("mixer_set", [`track 0 "${"N".repeat(64)}"`, `track 1 "${"M".repeat(64)}"`, `track 2 "${"K".repeat(64)}"`, `track 3 "${"L".repeat(64)}"`, `track 4 "${"J".repeat(64)}"`, `track 5 "${"H".repeat(64)}"`, `track 6 "${"G".repeat(64)}"`, `track 7 "${"F".repeat(64)}"`], { destructive: true, reasons: [reason], gain: [reason] }));
  assert.ok([...text].length <= 500);
  assert.ok(text.endsWith(`(${reason})`), text);
  const huge = Array.from({ length: 12 }, () => reason);
  assert.throws(() => summarize(plan("mixer_set", ["track 0"], { destructive: true, reasons: huge, gain: huge })), (e: unknown) => e instanceof ToolError && e.code === "too_large");
});

test("MINOR 7: quoted() escapes quotes and backslashes so a name cannot close the quote and inject text", () => {
  const evil = 'Bass" (rename only…) "';
  assert.equal(quoted(evil), '"Bass\\" (rename only…) \\""');
  assert.equal(quoted("a\\b"), '"a\\\\b"');
  assert.equal(quoted("Bass"), '"Bass"');
  assert.equal(quoted("x".repeat(100)), `"${"x".repeat(64)}..."`);
});

async function rig(world: FakeWorld, extra: Json = {}, answers: Json = {}): Promise<Rig> {
  return startRig({
    config: { confirm: "destructive", ...extra } as never, answers: { ...world.answers(), ...answers }, echo: true,
    capabilities: { elicitation: { form: {} } },
  });
}
async function summaryOf(r: Rig, tool: string, args: Json): Promise<string> {
  const id = 7000 + Math.floor(Math.random() * 100000);
  r.client.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: tool, arguments: args } });
  const question = await r.client.next((m: Json) => m.method === "elicitation/create");
  r.client.send({ jsonrpc: "2.0", id: question.id, result: { action: "decline" } });
  await r.client.nextResponse(id);
  return question.params.message;
}

test("MINOR 7: a track named to look like part of the summary stays inside its escaped quotes", async () => {
  const world = new FakeWorld();
  world.tracks = [{ name: 'Bass" (rename only, harmless) "' }];
  const r = await rig(world);
  const text = await summaryOf(r, "delete_track", { track: { kind: "track", index: 0 } });
  assert.equal(text, 'Delete track: track 0 "Bass\\" (rename only, harmless) \\""');
  assert.ok(!text.replaceAll('\\"', "").includes('" (rename'), "no unescaped quote followed by injected text");
  await r.close();
});

test("MINOR 8: notes_remove says all notes, or how many ids; ranges keep their numbers", async () => {
  const r = await rig(new FakeWorld());
  const clip = { kind: "session", track: { kind: "track", index: 0 }, slot: 0 };
  assert.match(await summaryOf(r, "remove_notes_from_clip", { clip }), /^Remove notes: clip in slot 0 of track 0 "Drums", all notes$/);
  assert.match(await summaryOf(r, "remove_notes_from_clip", { clip, note_ids: [1, 2, 3] }), /^Remove notes: .*, 3 note ids$/);
  assert.match(await summaryOf(r, "remove_notes_from_clip", { clip, note_ids: [7] }), /, 1 note id$/);
  const range = await summaryOf(r, "remove_notes_from_clip", { clip, from_pitch: 60, pitch_span: 12 });
  assert.match(range, /from_pitch=60, pitch_span=12$/);
  assert.doesNotMatch(range, /all notes/);
  await r.close();
});

test("MINOR 8: cue_delete shows the listed name and time of the cue point, and refuses an index the listing does not have", async () => {
  const cues = { cue_list: () => ({ items: [{ index: 0, name: "Intro", time: 0 }, { index: 1, name: 'Ver"se', time: 16.5 }], total: 2, next_offset: null }) };
  const r = await rig(new FakeWorld(), {}, cues);
  assert.equal(await summaryOf(r, "delete_cue_point", { index: 1 }), 'Delete cue point: cue point #1 "Ver\\"se" at beat 16.5, index=1');
  const missing = await r.call("delete_cue_point", { index: 5 });
  assert.equal(missing.structuredContent.code, "not_found");
  assert.deepEqual(r.seen().filter((c) => c.cmd === "cue_delete"), []);
  await r.close();
});

test("MINOR 8: an error message that ends without a period gets one before the unknown-outcome advice", () => {
  const plain = liveToToolError(new LiveError("connection_lost", "connection to Live lost", { outcomeUnknown: true }), true);
  assert.match(plain.message, /^connection to Live lost\. The command may or may not have been applied: re-read the current state before retrying\.$/);
  const dotted = liveToToolError(new LiveError("connection_lost", "connection to Live lost.", { outcomeUnknown: true }), true);
  assert.match(dotted.message, /^connection to Live lost\. The command may/);
  assert.doesNotMatch(dotted.message, /\.\./);
  const question = liveToToolError(new LiveError("timeout", "did it run?", { outcomeUnknown: true }), true);
  assert.match(question.message, /^did it run\? The command may/);
});
