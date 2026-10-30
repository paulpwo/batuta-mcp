import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ALIAS_SPECS } from "../src/tools/aliases.js";
import { COMMAND_SPECS, toolNameFor } from "../src/tools/catalog.js";
import { COMPOSITE_INFO } from "../src/tools/composites.js";
import { EARS_TOOLS } from "../src/tools/ears.js";
import { HOST_TOOLS } from "../src/tools/host.js";
import { registryFor } from "./helpers/tools-harness.js";
import { SERVER_TOOLS, namingTable } from "./helpers/naming-table.js";

/** docs/03-tool-names.md stays equal to the server, and every registered tool is accounted for in exactly one family. */

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const DOC = fs.readFileSync(path.join(ROOT, "docs", "03-tool-names.md"), "utf8");
const START = "<!-- naming-table:start -->";
const END = "<!-- naming-table:end -->";

test("the naming table in docs/03-tool-names.md is exactly the generated table", () => {
  const from = DOC.indexOf(START);
  const to = DOC.indexOf(END);
  assert.ok(from >= 0 && to > from, "markers present");
  assert.equal(DOC.slice(from + START.length, to).trim(), namingTable().trim());
});

test("every registered tool belongs to exactly one family: broad, alias, composite or server", () => {
  const registry = registryFor({ sampleRoots: ["/tmp/x"], allowAudioImport: true });
  const families: Array<[string, string[]]> = [
    ["broad", COMMAND_SPECS.map((s) => toolNameFor(s.command))],
    ["alias", ALIAS_SPECS.map((a) => a.name)],
    ["composite", COMPOSITE_INFO.map((c) => c.name)],
    ["host", HOST_TOOLS.map((h) => h.name)],
    ["ears", EARS_TOOLS.map((e) => e.name)],
    ["server", [...SERVER_TOOLS]],
  ];
  const seen = new Map<string, string>();
  for (const [family, names] of families) {
    for (const name of names) {
      assert.equal(seen.get(name), undefined, `${name} is in two families`);
      seen.set(name, family);
    }
  }
  assert.deepEqual(registry.list().map((t) => t.name).sort(), [...seen.keys()].sort());
});

test("the document says what the ears tools do and which name is not provided", () => {
  for (const phrase of ["batuta_ears", "record_and_analyze", "analyze_audio", "compare_audio", "record_audio", "never asks", "destructive"]) assert.ok(DOC.includes(phrase), phrase);
  assert.equal(DOC.includes("## Not yet available"), false, "the ears names are no longer listed as missing");
});

test("the document explains the exclusions and names the tools still waiting on script commands", () => {
  for (const excluded of ["submit_intent", "rate_last_action", "reject_last_action", "prefer_candidate", "record_audition", "set_dataset_consent", "user_prompt"]) {
    assert.ok(DOC.includes(excluded), `${excluded} documented as excluded`);
  }
  assert.ok(DOC.includes("capture_session_to_arrangement"));
});
