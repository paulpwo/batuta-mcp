import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { COMMAND_SPECS, annotationsFor, toolNameFor } from "../src/tools/catalog.js";
import { PUBLIC_NAMES } from "../src/tools/names.js";
import { ALIAS_SPECS } from "../src/tools/aliases.js";
import type { Schema } from "../src/validate/index.js";
import { registryFor } from "./helpers/tools-harness.js";
import { startServer } from "./helpers/mcp-client.js";
import type { Json } from "./helpers/mcp-client.js";

/** The oracle: argument names and catalog flags generated from the real Remote Script (see test/README.md). */
interface ScriptCommand {
  name: string; mutating: boolean; destructive: string; conditions: string[];
  props: string[]; required: string[]; at_least_one: boolean; exclusive: string[][];
}
const ROOT = path.resolve(import.meta.dirname, "..", "..");
const SCRIPT: ScriptCommand[] = (JSON.parse(fs.readFileSync(path.join(ROOT, "test", "fixtures", "script-catalog.json"), "utf8")) as { commands: ScriptCommand[] }).commands;

/** Wire arguments the MCP tools deliberately do not expose. */
const HIDDEN: Record<string, string[]> = { track_create: ["ears_internal"], audio_clip_create: ["expected_length_beats"] };

const SCRIPT_TOOLS = SCRIPT.filter((c) => c.name !== "catalog");

test("every script command except catalog has exactly one spec, and nothing else", () => {
  assert.equal(SCRIPT.length, 86);
  assert.deepEqual(COMMAND_SPECS.map((s) => s.command).sort(), SCRIPT_TOOLS.map((c) => c.name).sort());
  assert.equal(new Set(COMMAND_SPECS.map((s) => s.command)).size, COMMAND_SPECS.length);
  assert.equal(COMMAND_SPECS.length, 85);
});

test("spec flags equal the script catalog (mutating, destructive class, conditions)", () => {
  for (const wire of SCRIPT_TOOLS) {
    const spec = COMMAND_SPECS.find((s) => s.command === wire.name);
    assert.ok(spec, wire.name);
    assert.equal(spec.mutating, wire.mutating, `${wire.name} mutating`);
    assert.equal(spec.destructive, wire.destructive, `${wire.name} destructive`);
    assert.deepEqual([...spec.conditions].sort(), [...wire.conditions].sort(), `${wire.name} conditions`);
  }
});

test("tool arguments match the wire arguments: names, required, exclusive, at-least-one", () => {
  for (const wire of SCRIPT_TOOLS) {
    const spec = COMMAND_SPECS.find((s) => s.command === wire.name)!;
    const hidden = HIDDEN[wire.name] ?? [];
    assert.deepEqual(Object.keys(spec.properties).sort(), wire.props.filter((p) => !hidden.includes(p)).sort(), `${wire.name} properties`);
    assert.deepEqual([...(spec.required ?? [])].sort(), wire.required.filter((p) => !hidden.includes(p)).sort(), `${wire.name} required`);
    assert.equal(spec.atLeastOne === true, wire.at_least_one, `${wire.name} at_least_one`);
    assert.deepEqual((spec.exclusive ?? []).map((pair) => [...pair].sort()), wire.exclusive, `${wire.name} exclusive`);
  }
});

test("one broad tool per command under its public name and annotations derived from the classification", () => {
  const registry = registryFor({ sampleRoots: ["/tmp/x"], allowAudioImport: true });
  const rows: string[] = [];
  for (const spec of COMMAND_SPECS) {
    const name = toolNameFor(spec.command);
    assert.equal(name, PUBLIC_NAMES[spec.command]);
    const tool = registry.get(name)?.tool;
    assert.ok(tool, `${name} is registered`);
    const a = tool.annotations!;
    assert.equal(a.readOnlyHint, !spec.mutating, `${name} readOnlyHint`);
    assert.equal(a.destructiveHint, spec.mutating && spec.destructive !== "never", `${name} destructiveHint`);
    assert.equal(a.openWorldHint, false);
    assert.equal(a.idempotentHint, !spec.mutating || spec.idempotent === true, `${name} idempotentHint`);
    assert.deepEqual(a, annotationsFor(spec));
    rows.push(`${name} -> ${spec.command} ro=${a.readOnlyHint} destructive=${a.destructiveHint} idem=${a.idempotentHint}`);
  }
  assert.equal(rows.length, 85);
  assert.ok(registry.size >= 85 + 2, "85 broad tools + batuta_confirm + batuta_status (+ aliases and composites)");
});

test("pure setters are idempotent, relative or one-shot commands are not", () => {
  const idem = (c: string): boolean => COMMAND_SPECS.find((s) => s.command === c)!.idempotent === true;
  for (const c of ["song_set", "track_set", "mixer_set", "scene_set", "clip_set", "cue_set", "param_set", "chain_set", "device_enable", "routing_set", "drum_pad_set", "song_set_time", "track_select"]) {
    assert.equal(idem(c), true, c);
  }
  for (const c of ["track_create", "track_duplicate", "notes_add", "undo", "redo", "scene_fire", "transport"]) assert.equal(idem(c), false, c);
});

function walk(schema: Schema, visit: (node: Schema, where: string) => void, where = "#"): void {
  visit(schema, where);
  for (const [key, child] of Object.entries(schema.properties ?? {})) walk(child, visit, `${where}/${key}`);
  if (schema.items) walk(schema.items, visit, `${where}/items`);
  (schema.oneOf ?? []).forEach((branch, i) => { walk(branch, visit, `${where}/oneOf/${i}`); });
}

test("every object schema forbids extra properties and every string field is bounded", () => {
  const registry = registryFor({ sampleRoots: ["/tmp/x"], allowAudioImport: true });
  for (const definition of registry.list()) {
    walk(definition.inputSchema, (node, where) => {
      if (node.type === "object") assert.equal(node.additionalProperties, false, `${definition.name} ${where}`);
      if (node.type === "string" && node.const === undefined && node.enum === undefined) assert.ok(node.maxLength !== undefined, `${definition.name} ${where} needs maxLength`);
      if (node.type === "array") assert.ok(node.maxItems !== undefined, `${definition.name} ${where} needs maxItems`);
    });
  }
});

test("track_create and batch do not expose server-only or free-form arguments", () => {
  const registry = registryFor();
  assert.equal("ears_internal" in registry.get("create_track")!.tool.inputSchema.properties!, false);
  assert.equal("expected_length_beats" in (registryFor({ sampleRoots: ["/tmp/x"], allowAudioImport: true }).get("create_audio_clip")?.tool.inputSchema.properties ?? {}), false);
});

test("descriptions are present, concise, static and mention units and destructive behavior where relevant", () => {
  const registry = registryFor({ sampleRoots: ["/tmp/x"], allowAudioImport: true });
  for (const definition of registry.list()) {
    assert.ok(definition.description.length >= 30 && definition.description.length <= 1400, `${definition.name} description length ${definition.description.length}`);
    assert.doesNotMatch(definition.description, /constructor|prototype|__proto__/);
  }
  const desc = (c: string): string => registry.get(toolNameFor(c))!.tool.description;
  assert.match(desc("clip_create"), /beats/i);
  assert.match(desc("mixer_set"), /volume_db/);
  assert.match(desc("track_delete"), /destructive|confirm/i);
  assert.match(desc("track_create"), /Lite/);
  assert.match(desc("browser_load"), /verified/);
  assert.match(desc("song_info"), /pending_sweeps/);
});

test("tools/list serves the surface in one page by default and in stable pages when the page size is small", async () => {
  const registry = registryFor();
  const { client } = startServer({}, registry);
  await client.initialize();
  const first = (await client.request(2, "tools/list")).result as Json;
  assert.equal(first.tools.length, registry.size);
  assert.equal(first.nextCursor, undefined);
  assert.ok(first.tools.length <= 200);

  const paged = startServer({ pageSize: 30 }, registryFor());
  await paged.client.initialize();
  const names: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const reply = (await paged.client.request(10 + pages, "tools/list", cursor === undefined ? undefined : { cursor })).result as Json;
    names.push(...reply.tools.map((t: { name: string }) => t.name));
    cursor = reply.nextCursor;
    pages += 1;
  } while (cursor !== undefined && pages < 10);
  assert.equal(pages, Math.ceil(registry.size / 30));
  assert.deepEqual(names, first.tools.map((t: { name: string }) => t.name));
  assert.equal(new Set(names).size, names.length);
});

test("destructive disabled hides every always-destructive tool, create_audio_clip is listed without sample_roots", () => {
  const confirm = registryFor();
  const disabled = registryFor({ destructive: "disabled" });
  const always = COMMAND_SPECS.filter((s) => s.destructive === "always").map((s) => toolNameFor(s.command));
  assert.equal(always.length, 11);
  for (const name of always) {
    assert.ok(confirm.get(name), `${name} listed in confirm mode`);
    assert.equal(disabled.get(name), undefined, `${name} hidden in disabled mode`);
  }
  const hiddenAliases = ALIAS_SPECS.filter((a) => COMMAND_SPECS.find((s) => s.command === a.command)?.destructive === "always").map((a) => a.name);
  assert.deepEqual(hiddenAliases, ["clear_notes_from_clip"]);
  for (const name of hiddenAliases) assert.equal(disabled.get(name), undefined, `${name} hidden with its broad tool`);
  assert.equal(disabled.size, confirm.size - 11 - hiddenAliases.length);
  assert.ok(confirm.get("create_audio_clip"), "audio import needs no configuration");
  const withRoots = registryFor({ sampleRoots: ["/tmp/x"], allowAudioImport: true });
  assert.ok(withRoots.get("create_audio_clip"));
  assert.equal(withRoots.size, confirm.size);
  // Conditional tools stay listed in disabled mode; their dangerous variants are refused at call time.
  assert.ok(disabled.get("duplicate_clip") && disabled.get("set_mixer") && disabled.get("batch"));
});

test("tools/list stays a reasonable size", async () => {
  const registry = registryFor({ sampleRoots: ["/tmp/x"], allowAudioImport: true });
  const bytes = Buffer.byteLength(JSON.stringify(registry.list()));
  assert.ok(bytes < 600_000, `tools/list is ${bytes} bytes`);
});
