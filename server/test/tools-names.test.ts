import { test } from "node:test";
import assert from "node:assert/strict";
import { COMMAND_SPECS, commandForTool, toolNameFor } from "../src/tools/catalog.js";
import { PUBLIC_NAMES } from "../src/tools/names.js";
import { FakeWorld } from "./helpers/fake-world.js";
import { registryFor, startRig } from "./helpers/tools-harness.js";

/** Public tool names (docs/03-tool-names.md): normalized verb_object names; the batuta_ prefix survives only on the three server tools. */

const SNAKE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const SERVER_TOOLS = new Set(["batuta_confirm", "batuta_status", "batuta_ears"]);

test("every command has one unique snake_case public name without the batuta_ prefix", () => {
  const names = COMMAND_SPECS.map((spec) => toolNameFor(spec.command));
  assert.equal(new Set(names).size, COMMAND_SPECS.length);
  for (const name of names) {
    assert.match(name, SNAKE);
    assert.ok(!name.startsWith("batuta_"), name);
  }
  assert.deepEqual(Object.keys(PUBLIC_NAMES).sort(), COMMAND_SPECS.map((s) => s.command).sort(), "the table covers exactly the commands");
});

test("commandForTool reverses toolNameFor and knows nothing else", () => {
  for (const spec of COMMAND_SPECS) assert.equal(commandForTool(toolNameFor(spec.command)), spec.command);
  assert.equal(commandForTool("batuta_track_set"), undefined);
  assert.equal(commandForTool("nope"), undefined);
});

test("the compatibility names that map one to one are the public names of the broad tools", () => {
  const expected: Record<string, string> = {
    song_info: "get_session_info", track_get: "get_track_info", arrangement_clips: "get_arrangement_clips", arrangement_duplicate: "duplicate_to_arrangement",
    notes_get: "get_clip_notes", notes_add: "add_notes_to_clip", clip_create: "create_clip", audio_clip_create: "create_audio_clip", clip_delete: "delete_clip",
    slot_fire: "fire_clip", slot_stop: "stop_clip", browser_load: "load_instrument_or_effect", song_set_time: "set_arrangement_time",
    device_get: "get_device_parameters", param_set: "set_device_parameter",
  };
  for (const [command, name] of Object.entries(expected)) assert.equal(toolNameFor(command), name);
});

test("no registered tool name starts with batuta_ except the server tools", () => {
  for (const definition of registryFor({ sampleRoots: ["/tmp/x"], allowAudioImport: true }).list()) {
    if (definition.name.startsWith("batuta_")) assert.ok(SERVER_TOOLS.has(definition.name), definition.name);
  }
});

test("batch ops name commands by their public tool name", async () => {
  const r = await startRig({ answers: new FakeWorld().answers(), echo: true });
  const ok = await r.call("batch", { ops: [{ cmd: "set_track_properties", args: { track: { kind: "track", index: 0 }, mute: true } }] });
  assert.equal(ok.isError, false);
  assert.deepEqual(r.seen().filter((c) => c.cmd === "batch").map((c) => (c.args["ops"] as Array<{ cmd: string }>).map((o) => o.cmd)), [["track_set"]], "the wire still carries the command name");
  const old = await r.call("batch", { ops: [{ cmd: "track_set", args: { track: { kind: "track", index: 0 }, mute: true } }] });
  assert.equal(old.isError, true);
  await r.close();
});
