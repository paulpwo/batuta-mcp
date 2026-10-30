import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeWorld } from "./helpers/fake-world.js";
import { startRig } from "./helpers/tools-harness.js";
import type { Rig } from "./helpers/tools-harness.js";
import type { Json } from "./helpers/mcp-client.js";
import { COMMAND_SPECS } from "../src/tools/catalog.js";

/** Confirmation policy (docs/01-protocol.md section 9.1a): by default only gain guard trips (and later host actions) ask. */

async function rig(options: { elicitation?: boolean; config?: Json; world?: FakeWorld } = {}): Promise<Rig> {
  const w = options.world ?? new FakeWorld();
  return startRig({
    config: (options.config ?? {}) as never, answers: w.answers(), echo: true,
    ...(options.elicitation === true ? { capabilities: { elicitation: { form: {} } } } : {}),
  });
}

const READS = ["track_list", "scene_list", "song_info", "mixer_get", "param_get", "device_get", "device_list", "rack_get", "clip_get", "cue_list"];
const mutations = (r: Rig): Array<{ cmd: string; args: Json }> => r.seen().filter((c) => !READS.includes(c.cmd));
const REVERT = "Cmd-Z in Live, or the undo tool";
const questions = (r: Rig): number => r.client.rawLines.filter((line) => line.includes("elicitation/create")).length;

test("default mode (irreversible): a delete runs without a prompt, even for a client that can ask, and reports undoable with a revert hint", async () => {
  const r = await rig({ elicitation: true });
  const result = await r.call("delete_track", { track: { kind: "track", index: 1 } });
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.confirmation_required, undefined);
  assert.equal(result.structuredContent.undoable, true);
  assert.equal(result.structuredContent.revert, REVERT);
  assert.match(result.content[0].text, /Cmd-Z in Live, or the undo tool/);
  assert.equal(questions(r), 0);
  assert.deepEqual(mutations(r), [{ cmd: "track_delete", args: { track: { kind: "track", index: 1, expect_name: "Bass" }, expect_name: "Bass" } }]);
  await r.close();
});

test("default mode: the default config really is irreversible", async () => {
  const r = await rig();
  assert.equal(r.config.confirm, "irreversible");
  await r.close();
});

test("default mode: every always-destructive command runs without a prompt and is marked undoable", async () => {
  const r = await rig({ elicitation: true });
  const clip = { kind: "session", track: { kind: "track", index: 0 }, slot: 0 };
  const device = { track: { kind: "track", index: 0 }, path: [0] };
  const calls: Array<[string, Json]> = [
    ["delete_track", { track: { kind: "track", index: 1 } }], ["delete_scene", { scene: 0 }], ["delete_cue_point", { index: 0 }],
    ["delete_clip", { clip }], ["crop_clip", { clip }], ["remove_notes_from_clip", { clip }],
    ["clear_clip_envelope", { clip, param: { mixer: "pan", track: { kind: "track", index: 0 } } }], ["clear_all_clip_envelopes", { clip }],
    ["delete_device", { device }], ["copy_drum_pad", { device, from_note: 36, to_note: 37 }], ["clear_drum_pad", { device, note: 36 }],
  ];
  for (const [tool, args] of calls) {
    const result = await r.call(tool, args);
    assert.equal(result.isError, false, tool);
    assert.equal(result.structuredContent.undoable, true, tool);
  }
  assert.equal(questions(r), 0);
  assert.equal(mutations(r).length, calls.length);
  await r.close();
});

test("default mode: overwrite, replace and variation delete run without a prompt and are undoable", async () => {
  const r = await rig({ elicitation: true });
  const slot = (index: number) => ({ track: { kind: "track", index }, slot: 0 });
  const dup = await r.call("duplicate_clip", { from: slot(0), to: slot(1), allow_overwrite: true });
  assert.equal(dup.structuredContent.undoable, true);
  const plain = await r.call("duplicate_clip", { from: slot(0), to: slot(1) });
  assert.equal(plain.structuredContent.undoable, undefined, "a non-destructive call carries no undoable flag");
  assert.deepEqual(mutations(r).map((c) => c.cmd), ["clip_duplicate", "clip_duplicate"]);
  assert.equal(questions(r), 0);
  await r.close();
});

test("spec 9.1a: undo and redo called by the model ALWAYS ask in the default mode, whatever steps, by elicitation", async () => {
  const r = await rig({ elicitation: true });
  const cases: Array<[string, Json]> = [["undo", {}], ["undo", { steps: 1 }], ["undo", { steps: 4 }], ["redo", {}], ["redo", { steps: 3 }]];
  for (const [tool, args] of cases) {
    r.client.send({ jsonrpc: "2.0", id: 9100, method: "tools/call", params: { name: tool, arguments: args } });
    const question = await r.client.next((m: Json) => m.method === "elicitation/create");
    assert.match(question.params.message, /manual edits/i, `${tool} ${JSON.stringify(args)}`);
    r.client.send({ jsonrpc: "2.0", id: question.id, result: { action: "decline" } });
    assert.deepEqual((await r.client.nextResponse(9100)).result.structuredContent, { cancelled: true });
  }
  assert.deepEqual(mutations(r), []);
  // Accepting runs it, once.
  r.client.send({ jsonrpc: "2.0", id: 9101, method: "tools/call", params: { name: "undo", arguments: {} } });
  const q = await r.client.next((m: Json) => m.method === "elicitation/create");
  r.client.send({ jsonrpc: "2.0", id: q.id, result: { action: "accept", content: { confirm: true } } });
  assert.equal((await r.client.nextResponse(9101)).result.isError, false);
  assert.deepEqual(mutations(r).map((c) => c.cmd), ["undo"]);
  await r.close();
});

test("spec 9.1a: undo and redo use the token path when the client cannot ask, and the stored call runs once", async () => {
  const r = await rig();
  for (const tool of ["undo", "redo"]) {
    const first = await r.call(tool, {});
    assert.equal(first.structuredContent.confirmation_required, true, tool);
  }
  assert.deepEqual(mutations(r), []);
  const first = await r.call("undo", { steps: 2 });
  const done = await r.call("batuta_confirm", { confirm_id: first.structuredContent.confirm_id, summary: first.structuredContent.summary });
  assert.equal(done.isError, false);
  assert.match(done.structuredContent.revert, /^Redo in Live/);
  assert.deepEqual(mutations(r), [{ cmd: "undo", args: { steps: 2 } }]);
  await r.close();
});

test("spec 9.1a: strict mode asks for undo and redo too; destructive: disabled still refuses steps>1 but a single undo or redo still asks", async () => {
  const strict = await rig({ config: { confirm: "destructive" } });
  assert.equal((await strict.call("undo", {})).structuredContent.confirmation_required, true);
  assert.equal((await strict.call("redo", {})).structuredContent.confirmation_required, true);
  await strict.close();
  const off = await rig({ config: { destructive: "disabled" } });
  assert.equal((await off.call("undo", { steps: 2 })).structuredContent.details.reason, "disabled_by_config");
  assert.equal((await off.call("undo", {})).structuredContent.confirmation_required, true);
  assert.deepEqual(mutations(off), []);
  await off.close();
});

test("default mode: a batch with deletes and no gain trip runs without a prompt and is undoable", async () => {
  const r = await rig({ elicitation: true });
  const result = await r.call("batch", { ops: [
    { cmd: "set_track_properties", args: { track: { kind: "track", index: 0 }, mute: true } },
    { cmd: "delete_track", args: { track: { kind: "track", index: 2 } } },
  ] });
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.undoable, true);
  assert.deepEqual(mutations(r).map((c) => c.cmd), ["batch"]);
  assert.equal(questions(r), 0);
  await r.close();
});

test("default mode: a gain guard trip still asks (elicitation), and the batch summary lists the delete before anything else", async () => {
  const w = new FakeWorld();
  w.volumeDb["track0"] = -10;
  const r = await rig({ elicitation: true, world: w });
  r.client.send({ jsonrpc: "2.0", id: 9001, method: "tools/call", params: { name: "batch", arguments: { ops: [
    { cmd: "set_track_properties", args: { track: { kind: "track", index: 1 }, mute: true } },
    { cmd: "set_mixer", args: { track: { kind: "track", index: 0 }, volume_db: -2 } },
    { cmd: "delete_track", args: { track: { kind: "track", index: 2 } } },
  ] } } });
  const question = await r.client.next((m: Json) => m.method === "elicitation/create");
  const text: string = question.params.message;
  assert.ok(text.indexOf("Delete track") >= 0 && text.indexOf("Delete track") < text.indexOf("Change a track"), text);
  assert.match(text, /raises the level from -10\.0 dB to -2\.0 dB/);
  r.client.send({ jsonrpc: "2.0", id: question.id, result: { action: "decline" } });
  assert.deepEqual((await r.client.nextResponse(9001)).result.structuredContent, { cancelled: true });
  assert.deepEqual(mutations(r), []);
  await r.close();
});

test("default mode: a gain guard trip uses the token path when the client cannot ask, and the confirmed result is undoable", async () => {
  const w = new FakeWorld();
  w.volumeDb["track0"] = -10;
  const r = await rig({ world: w });
  const first = await r.call("set_mixer", { track: { kind: "track", index: 0 }, volume_db: -2 });
  assert.equal(first.structuredContent.confirmation_required, true);
  assert.deepEqual(mutations(r), []);
  const done = await r.call("batuta_confirm", { confirm_id: first.structuredContent.confirm_id, summary: first.structuredContent.summary });
  assert.equal(done.isError, false);
  assert.equal(done.structuredContent.undoable, true);
  await r.close();
});

test("strict mode (confirm: destructive) keeps asking for deletes, and the confirmed run reports undoable too", async () => {
  const r = await rig({ config: { confirm: "destructive" } });
  const first = await r.call("delete_track", { track: { kind: "track", index: 1 } });
  assert.equal(first.structuredContent.confirmation_required, true);
  assert.deepEqual(mutations(r), []);
  const done = await r.call("batuta_confirm", { confirm_id: first.structuredContent.confirm_id, summary: first.structuredContent.summary });
  assert.equal(done.structuredContent.undoable, true);
  await r.close();
});

test("strict mode: undo with steps>1 asks, a single undo does not", async () => {
  const r = await rig({ config: { confirm: "destructive" } });
  assert.equal((await r.call("undo", {})).isError, false);
  assert.equal((await r.call("undo", { steps: 2 })).structuredContent.confirmation_required, true);
  await r.close();
});

test("destructive: disabled wins over confirm in both modes: deletes are hidden and conditional variants refused", async () => {
  for (const confirm of ["irreversible", "destructive"]) {
    const r = await rig({ config: { destructive: "disabled", confirm } });
    assert.equal(r.registry.get("delete_track"), undefined, confirm);
    const undo = await r.call("undo", { steps: 2 });
    assert.equal(undo.structuredContent.details.reason, "disabled_by_config", confirm);
    assert.deepEqual(mutations(r), []);
    await r.close();
  }
});

test("descriptions: deletes say they are undoable and never claim to ask for confirmation in the default mode", () => {
  for (const spec of COMMAND_SPECS) {
    if (spec.destructive !== "always") continue;
    assert.doesNotMatch(spec.description, /asks the user to confirm|asks for confirmation|needs confirmation/i, spec.command);
    assert.match(spec.description, /undo/i, spec.command);
  }
  for (const command of ["undo", "redo"]) {
    const spec = COMMAND_SPECS.find((s) => s.command === command)!;
    assert.match(spec.description, /always asks the user to confirm/i, command);
    assert.match(spec.description, /manual edits/i, command);
    assert.doesNotMatch(spec.description, /without a prompt/i, command);
  }
});

test("MINOR 8: wording of browser_load and song_set descriptions", () => {
  const load = COMMAND_SPECS.find((s) => s.command === "browser_load")!;
  assert.match(load.description, /the Remote Script checks the track for devices the configuration does not allow and removes them/);
  assert.doesNotMatch(load.description, /the server checks the track/);
  const song = COMMAND_SPECS.find((s) => s.command === "song_set")!;
  assert.match(song.description, /Enabling record_mode, session_record or arrangement_overdub is confirmed with the owner once while a track with a live external audio input exists/);
  for (const spec of COMMAND_SPECS) assert.doesNotMatch(spec.description, /(^|\. )Refused \(/, `${spec.command} has a sentence without a subject`);
});

// ---------------------------------------------------------------- action log in batuta_status

const status = async (r: Rig): Promise<Json> => (await r.call("batuta_status")).structuredContent;

test("batuta_status lists recent destructive actions (time, tool, targets from Live listings, undoable), newest first, memory only", async () => {
  const r = await rig();
  assert.deepEqual((await status(r)).recent_actions, []);
  await r.call("set_track_properties", { track: { kind: "track", index: 0 }, mute: true });
  await r.call("delete_track", { track: { kind: "track", index: 1 } });
  await r.call("delete_scene", { scene: 2 });
  const log = (await status(r)).recent_actions;
  assert.equal(log.length, 2, "the plain track_set is not destructive and is not listed");
  assert.deepEqual(log.map((e: Json) => e.tool), ["delete_scene", "delete_track"]);
  assert.deepEqual(log[1].targets, ['track 1 "Bass"']);
  assert.deepEqual(log[0].targets, ['scene 2 "Chorus"']);
  assert.equal(log[0].undoable, true);
  assert.match(log[0].time, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/);
  await r.close();
});

test("the action log records only what ran: declined, refused and failed calls are not in it; batches list their destructive ops", async () => {
  const strict = await rig({ elicitation: true, config: { confirm: "destructive" } });
  strict.client.send({ jsonrpc: "2.0", id: 9200, method: "tools/call", params: { name: "delete_track", arguments: { track: { kind: "track", index: 1 } } } });
  const q = await strict.client.next((m: Json) => m.method === "elicitation/create");
  strict.client.send({ jsonrpc: "2.0", id: q.id, result: { action: "decline" } });
  await strict.client.nextResponse(9200);
  assert.deepEqual((await status(strict)).recent_actions, []);
  await strict.close();

  const r = await rig();
  await r.call("delete_track", { track: { kind: "track", index: 9 } });
  assert.deepEqual((await status(r)).recent_actions, [], "a refused delete (no such track)");
  await r.call("batch", { ops: [
    { cmd: "set_track_properties", args: { track: { kind: "track", index: 0 }, mute: true } },
    { cmd: "delete_track", args: { track: { kind: "track", index: 2 } } },
  ] });
  await r.call("batch", { ops: [{ cmd: "set_track_properties", args: { track: { kind: "track", index: 0 }, mute: false } }] });
  const log = (await status(r)).recent_actions;
  assert.equal(log.length, 1);
  assert.equal(log[0].tool, "batch");
  assert.deepEqual(log[0].targets, ['track 2 "Pad"']);
  await r.close();
});

test("the action log keeps the last 50 only", async () => {
  const w = new FakeWorld();
  w.scenes = Array.from({ length: 60 }, (_, i) => `S${i}`);
  const r = await rig({ world: w });
  for (let i = 0; i < 55; i += 1) await r.call("delete_scene", { scene: i });
  const log = (await status(r)).recent_actions;
  assert.equal(log.length, 50);
  assert.deepEqual(log[0].targets, ['scene 54 "S54"']);
  assert.deepEqual(log[49].targets, ['scene 5 "S5"']);
  await r.close();
});

test("model undo and redo that ran are logged too", async () => {
  const r = await rig({ config: { confirm: "destructive" } });
  const first = await r.call("undo", {});
  await r.call("batuta_confirm", { confirm_id: first.structuredContent.confirm_id, summary: first.structuredContent.summary });
  const log = (await status(r)).recent_actions;
  assert.equal(log.length, 1);
  assert.equal(log[0].tool, "undo");
  await r.close();
});

test("undo and redo keep their schema: steps outside 1..10 are invalid_args before anything is asked or stored", async () => {
  const r = await rig();
  for (const tool of ["undo", "redo"]) {
    for (const steps of [0, 11]) {
      const result = await r.call(tool, { steps });
      assert.equal(result.structuredContent.code, "invalid_args", `${tool} ${steps}`);
    }
  }
  assert.equal(r.tools.confirmations.snapshot().length, 0);
  await r.close();
});
