import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeWorld } from "./helpers/fake-world.js";
import { startRig } from "./helpers/tools-harness.js";
import type { Rig } from "./helpers/tools-harness.js";
import type { Json } from "./helpers/mcp-client.js";

/**
 * Recording with a live external input (docs/01-protocol.md 5.6): the script refuses with acknowledgeable:true,
 * the server asks the owner once and re-sends with external_input_ack on accept. Nothing a client sends can set it.
 */

const REFUSAL = { reason: "external_input_live", acknowledgeable: true, tracks: ["Mic \"Vox\""], track_ids: ["t2"], command: "song_set" };
const ACK = { tracks: ["t2"] };

interface Calls { refused: number; acked: number; ackFlags: unknown[] }

/** `covers` decides whether an acknowledgement is enough; the default accepts exactly the ids of REFUSAL. */
async function rig(options: { elicitation?: boolean; timeoutMs?: number; acknowledgeable?: boolean; refusals?: Json[]; covers?: (ack: unknown) => boolean } = {}): Promise<{ r: Rig; calls: Calls }> {
  const queue = [...(options.refusals ?? [REFUSAL])];
  const refusal = (): Json => (queue.length > 1 ? queue.shift()! : queue[0]!);
  const covers = options.covers ?? ((ack: unknown): boolean => JSON.stringify(ack) === JSON.stringify(ACK));
  const w = new FakeWorld();
  const calls: Calls = { refused: 0, acked: 0, ackFlags: [] };
  const base = w.answers();
  const r = await startRig({
    answers: {
      ...base,
      song_set: (_args, request, reply) => {
        calls.ackFlags.push(request["external_input_ack"]);
        if (covers(request["external_input_ack"])) { calls.acked += 1; return {}; }
        calls.refused += 1;
        reply.fail("not_supported", "an external input is live; recording is refused", options.acknowledgeable === false ? { reason: "external_input_live", tracks: ["Mic"] } : refusal());
        return undefined;
      },
      batch: (_args, request, reply) => {
        if (covers(request["external_input_ack"])) { calls.acked += 1; return { results: [{ ok: true, result: {} }] }; }
        calls.refused += 1;
        reply.fail("not_supported", "an external input is live; recording is refused", refusal());
        return undefined;
      },
    },
    echo: true,
    ...(options.elicitation === true ? { capabilities: { elicitation: { form: {} } } } : {}),
    ...(options.timeoutMs === undefined ? {} : { server: { elicitationTimeoutMs: options.timeoutMs } as never }),
  });
  return { r, calls };
}

let nextId = 9000;
function start(r: Rig, name: string, args: Json): number {
  const id = nextId++;
  r.client.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  return id;
}
const ask = (r: Rig): Promise<Json> => r.client.next((m: Json) => m.method === "elicitation/create");

test("accept: one question names the tracks and the microphone risk; the same command is sent again with the acknowledgement", async () => {
  const { r, calls } = await rig({ elicitation: true });
  const id = start(r, "set_song_properties", { record_mode: true });
  const question = await ask(r);
  assert.match(question.params.message, /"Mic Vox"/, "track names are shown without quotes that could break the text");
  assert.match(question.params.message, /microphone/);
  assert.equal(calls.refused, 1);
  assert.equal(calls.acked, 0, "nothing is sent with the acknowledgement before the answer");
  r.client.send({ jsonrpc: "2.0", id: question.id, result: { action: "accept", content: { confirm: true } } });
  const result = (await r.client.nextResponse(id)).result;
  assert.equal(result.isError, false);
  assert.equal(calls.acked, 1);
  assert.deepEqual(calls.ackFlags, [undefined, ACK], "the ack carries exactly the ids the question named");
  await r.close();
});

test("decline and cancel give a cancelled result and the command is never re-sent", async () => {
  const { r, calls } = await rig({ elicitation: true });
  for (const answer of [{ action: "decline" }, { action: "cancel" }, { action: "accept", content: { confirm: false } }]) {
    const id = start(r, "set_song_properties", { record_mode: true });
    const question = await ask(r);
    r.client.send({ jsonrpc: "2.0", id: question.id, result: answer });
    const result = (await r.client.nextResponse(id)).result;
    assert.equal(result.isError, false);
    assert.deepEqual(result.structuredContent, { cancelled: true });
  }
  assert.equal(calls.acked, 0);
  await r.close();
});

test("no answer in time is the existing confirmation timeout error and nothing is re-sent", async () => {
  const { r, calls } = await rig({ elicitation: true, timeoutMs: 150 });
  const id = start(r, "set_song_properties", { record_mode: true });
  await ask(r);
  const result = (await r.client.nextResponse(id)).result;
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.code, "confirmation_failed");
  assert.equal(result.structuredContent.details.reason, "timeout");
  assert.equal(calls.acked, 0);
  await r.close();
});

test("R1: a client that cannot ask never gets a stored plan: the call is refused and nothing is acknowledged", async () => {
  const { r, calls } = await rig();
  const first = await r.call("set_song_properties", { record_mode: true });
  assert.equal(first.isError, true);
  assert.equal(first.structuredContent.confirmation_required, undefined);
  assert.equal(first.structuredContent.confirm_id, undefined);
  assert.equal(first.structuredContent.code, "not_supported");
  assert.equal(first.structuredContent.details.reason, "external_input_live");
  assert.notEqual(first.structuredContent.details.acknowledgeable, true);
  assert.match(String(first.structuredContent.message), /needs your confirmation and this client cannot ask/);
  assert.equal(calls.acked, 0);
  const forged = await r.call("batuta_confirm", { confirm_id: "anything", summary: "x" });
  assert.equal(forged.isError, true);
  assert.equal(calls.acked, 0);
  await r.close();
});

test("R1: the same for a batch", async () => {
  const { r, calls } = await rig();
  const result = await r.call("batch", { ops: [{ cmd: "set_song_properties", args: { record_mode: true } }] });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.confirm_id, undefined);
  assert.equal(calls.acked, 0);
  await r.close();
});

const GROWN = { reason: "external_input_live", acknowledgeable: true, tracks: ["Mic \"Vox\"", "Synth Out"], track_ids: ["t2", "t5"], command: "song_set" };
const both = (ack: unknown): boolean => {
  const ids = (ack as { tracks?: string[] } | undefined)?.tracks ?? [];
  return ids.includes("t2") && ids.includes("t5");
};

test("R2: when the set changed after the answer, the owner is asked once more with the new list, and the new ack carries it", async () => {
  const { r, calls } = await rig({ elicitation: true, refusals: [REFUSAL, GROWN], covers: both });
  const id = start(r, "set_song_properties", { record_mode: true });
  const first = await ask(r);
  assert.doesNotMatch(first.params.message, /Synth Out/);
  r.client.send({ jsonrpc: "2.0", id: first.id, result: { action: "accept", content: { confirm: true } } });
  const second = await ask(r);
  assert.match(second.params.message, /"Mic Vox", "Synth Out"/);
  assert.deepEqual(calls.ackFlags, [undefined, ACK], "the first ack carried only what the first question named");
  r.client.send({ jsonrpc: "2.0", id: second.id, result: { action: "accept", content: { confirm: true } } });
  const result = (await r.client.nextResponse(id)).result;
  assert.equal(result.isError, false);
  assert.deepEqual(calls.ackFlags[2], { tracks: ["t2", "t5"] });
  await r.close();
});

test("R2: a second refusal after the second answer is an error, never a third question", async () => {
  const { r, calls } = await rig({ elicitation: true, refusals: [REFUSAL, GROWN], covers: () => false });
  const id = start(r, "set_song_properties", { record_mode: true });
  for (let round = 0; round < 2; round += 1) {
    const question = await ask(r);
    r.client.send({ jsonrpc: "2.0", id: question.id, result: { action: "accept", content: { confirm: true } } });
  }
  const result = (await r.client.nextResponse(id)).result;
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.code, "not_supported");
  assert.equal(calls.acked, 0);
  await r.close();
});

test("R2: a refusal without track ids cannot be acknowledged: nobody is asked", async () => {
  const { r, calls } = await rig({ elicitation: true, refusals: [{ reason: "external_input_live", acknowledgeable: true, tracks: ["Mic"], command: "song_set" }] });
  const result = await r.call("set_song_properties", { record_mode: true });
  assert.equal(result.isError, true);
  assert.equal(calls.acked, 0);
  await r.close();
});

test("low: more than eight tracks are cut with 'and N more' while the ack keeps every id", async () => {
  const ids = Array.from({ length: 12 }, (_unused, i) => `t${i}`);
  const names = ids.map((id) => `Track ${id}`);
  const { r, calls } = await rig({ elicitation: true, refusals: [{ ...REFUSAL, tracks: names, track_ids: ids }], covers: (ack) => (ack as { tracks?: string[] } | undefined)?.tracks?.length === 12 });
  const id = start(r, "set_song_properties", { record_mode: true });
  const question = await ask(r);
  assert.match(question.params.message, /"Track t7"/);
  assert.doesNotMatch(question.params.message, /Track t8/);
  assert.match(question.params.message, /and 4 more/);
  r.client.send({ jsonrpc: "2.0", id: question.id, result: { action: "accept", content: { confirm: true } } });
  assert.equal((await r.client.nextResponse(id)).result.isError, false);
  assert.equal(calls.acked, 1);
  await r.close();
});

test("a refusal that is not acknowledgeable stays a refusal and nobody is asked", async () => {
  const { r, calls } = await rig({ elicitation: true, acknowledgeable: false });
  const result = await r.call("set_song_properties", { record_mode: true });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.details.reason, "external_input_live");
  assert.equal(calls.acked, 0);
  await r.close();
});

test("a batch refused up front is asked about once and re-sent as a whole with the acknowledgement", async () => {
  const { r, calls } = await rig({ elicitation: true });
  const id = start(r, "batch", { ops: [{ cmd: "set_song_properties", args: { record_mode: true } }] });
  const question = await ask(r);
  r.client.send({ jsonrpc: "2.0", id: question.id, result: { action: "accept", content: { confirm: true } } });
  const result = (await r.client.nextResponse(id)).result;
  assert.equal(result.isError, false);
  assert.equal(calls.refused, 1);
  assert.equal(calls.acked, 1);
  await r.close();
});

test("the acknowledgement can never come from the client: tool arguments and batch ops that carry it are rejected unsent", async () => {
  const { r, calls } = await rig({ elicitation: true });
  for (const [name, args] of [
    ["set_song_properties", { record_mode: true, external_input_ack: true }],
    ["batch", { ops: [{ cmd: "set_song_properties", args: { record_mode: true, external_input_ack: true } }] }],
    ["batch", { ops: [{ cmd: "set_song_properties", args: { record_mode: true } }], external_input_ack: true }],
  ] as Array<[string, Json]>) {
    const result = await r.call(name, args);
    assert.equal(result.isError, true, name);
    assert.equal(result.structuredContent.code, "invalid_args", name);
  }
  assert.equal(calls.refused + calls.acked, 0, "nothing reached the script");
  await r.close();
});
