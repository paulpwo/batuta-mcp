import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { scanEntries } from "./helpers/ast-scan.js";

/**
 * The one exception to "no process spawning": node:child_process, and only `execFile`, only in
 * server/src/host/runner.ts, only with a literal options object that has no `shell`. Everything
 * else about the exception is checked here as narrowly as the exception itself.
 */

const OWNER = "host/runner.ts";
const IMPORT = 'import { execFile } from "node:child_process";\n';
const GOOD_CALL = 'const child = execFile(binary, [...args], { timeout: 1, maxBuffer: 2, env, encoding: "utf8", windowsHide: true }, (error, stdout, stderr) => { void error; void stdout; void stderr; });\nchild.stdin?.end();';

const rules = (relative: string, code: string): string[] => scanEntries([{ relative, text: code }]).map((v) => v.rule);

test("the owner file may import execFile and call it with a plain options object", () => {
  assert.deepEqual(rules(OWNER, `${IMPORT}declare const binary: string; declare const args: string[]; declare const env: Record<string, string>;\n${GOOD_CALL}`), []);
  assert.deepEqual(rules(OWNER, 'import type { ExecFileException } from "node:child_process";'), []);
});

test("any other file importing node:child_process fails, in every spelling", () => {
  const others = ["host/host.ts", "host/paths.ts", "host/scripts.ts", "tools/host.ts", "tools/exec.ts", "live/client.ts", "bin.ts", "runner.ts", "other/host/runner.ts", "host/runner.tsx", "host/Runner.ts", "host/runner.ts.bak"];
  for (const relative of others) {
    assert.ok(rules(relative, IMPORT).includes("node module used outside its owner"), relative);
    assert.ok(rules(relative, 'import type { ExecFileException } from "node:child_process";').includes("node module used outside its owner"), `${relative} (type import)`);
    assert.ok(rules(relative, 'import cp from "node:child_process";').includes("node module used outside its owner"), `${relative} (default)`);
    assert.ok(rules(relative, 'export { execFile } from "node:child_process";').includes("node module used outside its owner"), `${relative} (re-export)`);
    assert.ok(rules(relative, 'const m = await import("node:child_process");').includes("dynamic import"), `${relative} (dynamic)`);
  }
  assert.ok(rules("tools/x.ts", 'import { exec } from "child_process";').includes("non-node import"));
});

test("inside the owner file only a plain `execFile` value import is accepted", () => {
  const bad: Array<[string, string]> = [
    ['import { exec } from "node:child_process";', "child_process import other than a plain execFile"],
    ['import { spawn } from "node:child_process";', "child_process import other than a plain execFile"],
    ['import { execSync } from "node:child_process";', "child_process import other than a plain execFile"],
    ['import { execFileSync } from "node:child_process";', "child_process import other than a plain execFile"],
    ['import { spawnSync } from "node:child_process";', "child_process import other than a plain execFile"],
    ['import { fork } from "node:child_process";', "child_process import other than a plain execFile"],
    ['import { execFile, spawn } from "node:child_process";', "child_process import other than a plain execFile"],
    ['import { execFile as run } from "node:child_process";', "child_process import other than a plain execFile"],
    ['import * as cp from "node:child_process";', "child_process import other than a plain execFile"],
    ['import cp from "node:child_process";', "child_process import other than a plain execFile"],
    ['import cp, { execFile } from "node:child_process";', "child_process import other than a plain execFile"],
    ['import "node:child_process";', "child_process import other than a plain execFile"],
    ['import { execFile } from "node:child_process";\nimport { spawn } from "node:child_process";', "child_process import other than a plain execFile"],
    ['export { execFile } from "node:child_process";', "re-export of child_process"],
    ['export * from "node:child_process";', "re-export of child_process"],
  ];
  for (const [code, rule] of bad) assert.ok(rules(OWNER, code).includes(rule), `${code} should violate "${rule}" (got ${rules(OWNER, code).join(", ") || "nothing"})`);
});

test("inside the owner file the call itself is constrained: no shell, no spread, fixed first argument, direct call only", () => {
  const call = (options: string, first = "binary"): string => `${IMPORT}declare const binary: string;\nexecFile(${first}, [], ${options}, () => undefined);`;
  const bad: Array<[string, string]> = [
    [call("{ shell: true }"), "shell option in the child_process module"],
    [call("{ shell: false }"), "shell option in the child_process module"],
    [call("{ shell: \"/bin/sh\" }"), "shell option in the child_process module"],
    [call("{ timeout: 1, shell }"), "shell option in the child_process module"],
    [call("{ [\"shell\"]: true }"), "shell option in the child_process module"],
    [call("{ ...extra }"), "execFile call other than execFile(binary, argv, { literal options }, callback)"],
    [call("options"), "execFile call other than execFile(binary, argv, { literal options }, callback)"],
    [call("{ timeout: 1 }", '"/bin/sh"'), "execFile call other than execFile(binary, argv, { literal options }, callback)"],
    [call("{ timeout: 1 }", "other"), "execFile call other than execFile(binary, argv, { literal options }, callback)"],
    [`${IMPORT}const run = execFile;\nrun("x", [], {}, () => undefined);`, "execFile used without being called directly"],
    [`${IMPORT}declare const binary: string;\nexecFile.call(null, binary, [], {}, () => undefined);`, "execFile used without being called directly"],
    [`${IMPORT}export { execFile };`, "execFile used without being called directly"],
    [`${IMPORT}declare const binary: string;\nexecFile(binary, [], { timeout: 1 });`, "execFile call other than execFile(binary, argv, { literal options }, callback)"],
    [call("other(options)"), "execFile call other than execFile(binary, argv, { literal options }, callback)"],
    [call("execOptionsFor()"), "execFile call other than execFile(binary, argv, { literal options }, callback)"],
    [call("execOptionsFor(a, b)"), "execFile call other than execFile(binary, argv, { literal options }, callback)"],
    [call("execOptionsFor(...a)"), "execFile call other than execFile(binary, argv, { literal options }, callback)"],
    [call("x.execOptionsFor(options)"), "execFile call other than execFile(binary, argv, { literal options }, callback)"],
  ];
  for (const [code, rule] of bad) assert.ok(rules(OWNER, code).includes(rule), `${code.replace(/\n/g, " ")} should violate "${rule}" (got ${rules(OWNER, code).join(", ") || "nothing"})`);
});

test("execFile may take its options from execOptionsFor(options), the one place that builds them", () => {
  const body = (options: string): string => `${IMPORT}declare const binary: string; declare const options: unknown;\nexecFile(binary, [], ${options}, () => undefined);`;
  assert.deepEqual(rules(OWNER, body("execOptionsFor(options)")), []);
  assert.deepEqual(rules(OWNER, body("{ timeout: 1 }")), []);
});

test("the runner of a HostService is an ES private field, and the real runner calls execFile with execOptionsFor(options)", () => {
  const src = path.resolve(import.meta.dirname, "..", "..", "src");
  const host = fs.readFileSync(path.join(src, "host", "host.ts"), "utf8");
  assert.match(host, /readonly #runner\b/);
  assert.ok(!/private\s+(?:readonly\s+)?runner\b/.test(host), "no TypeScript private runner");
  const runner = fs.readFileSync(path.join(src, "host", "runner.ts"), "utf8");
  assert.match(runner, /execFile\(binary, \[\.\.\.args\], execOptionsFor\(options\), /);
});

test("the shell and exec-family identifiers are refused in the owner file even without an import", () => {
  for (const code of ["exec('ls');", "spawn('ls');", "execSync('ls');", "const x = { shell: true };", "spawnSync('ls');", "fork('x');"]) {
    assert.ok(rules(OWNER, code).length > 0, code);
  }
  // elsewhere these are ordinary identifiers: the owner-only rules do not leak into other files
  assert.deepEqual(rules("tools/other.ts", "const shell = 1; const exec = 2; void shell; void exec;"), []);
});

test("the real runner file passes the scanner and is the only file mentioning child_process", () => {
  const src = path.resolve(import.meta.dirname, "..", "..", "src");
  const text = fs.readFileSync(path.join(src, "host", "runner.ts"), "utf8");
  assert.deepEqual(scanEntries([{ relative: OWNER, text }]), []);
  assert.ok(scanEntries([{ relative: "host/runner.ts.copy", text }]).map((v) => v.rule).includes("node module used outside its owner"));
  assert.match(text, /import \{ execFile \} from "node:child_process";/);
  assert.equal((text.match(/\bexecFile\(/g) ?? []).length, 1, "exactly one call site");
});

// ------------------------------------------------------------------ who may use the runner

const WIRING = "host runner imported outside its wiring points";
const NAMES = "host runner import other than the permitted names";
const CALL = "createExecRunner used other than createExecRunner()";
const POSITION = "createExecRunner() outside `runner: <deps>.runner ?? createExecRunner()` in new HostService({...})";
const ACCESS = "runner member access outside its wiring point";
const PRIVATE = "#runner used other than `this.#runner = options.runner` in the constructor or as a callee";
const SERVICE = "HostService declared or imported other than as the unaliased import from host/host.js";
const IMP = 'import { HostService } from "../host/host.js";\nimport { createExecRunner } from "../host/runner.js";\n';

test("type-only imports of the runner are fine anywhere; the real wiring points pass", () => {
  for (const [relative, code] of [
    ["tools/exec.ts", 'import type { HostRunner } from "../host/runner.js";'],
    ["tools/host.ts", 'import type { HostRunResult, HostRunOptions } from "../host/runner.js";'],
    ["host/host.ts", 'import type { HostRunner } from "./runner.js";'],
    ["tools/index.ts", 'import { HostService } from "../host/host.js";\nimport type { HostRunner } from "../host/runner.js";\nimport { createExecRunner } from "../host/runner.js";\ndeclare const deps: { host?: { runner?: HostRunner } };\nnew HostService({ ...deps, runner: deps.host?.runner ?? createExecRunner(), config });'],
    ["tools/index.ts", 'import { HostService } from "../host/host.js";\nimport { createExecRunner } from "../host/runner.js";\nnew HostService({ runner: (deps.host?.runner ?? createExecRunner()) });'],
    ["host/host.ts", 'class A { readonly #runner: unknown; constructor(options: { runner: unknown }) { this.#runner = options.runner; } }'],
    ["host/host.ts", 'import { OPEN_BINARY, OSASCRIPT_BINARY } from "./runner.js";\nvoid OPEN_BINARY; void OSASCRIPT_BINARY;'],
  ] as const) assert.deepEqual(rules(relative, code), [], `${relative}: ${code}`);
});

test("a value import of the runner anywhere else fails, whatever the spelling", () => {
  const spellings = (from: string): string[] => [
    `import { createExecRunner } from "${from}";`, `import { createExecRunner as run } from "${from}";`, `import * as r from "${from}";`, `import r from "${from}";`,
    `import "${from}";`, `export { createExecRunner } from "${from}";`, `export * from "${from}";`, `import { type HostRunner, createExecRunner } from "${from}";`,
    `import { OPEN_BINARY } from "${from}";`, `import { contractAllows } from "${from}";`, `import { createUncheckedRunner } from "${from}";`,
  ];
  const places: Array<[string, string]> = [
    ["tools/host.ts", "../host/runner.js"], ["tools/exec.ts", "../host/runner.js"], ["tools/status.ts", "../host/./runner.js"], ["mcp/server.ts", "../host/../host/runner.js"],
    ["bin.ts", "./host/runner.js"], ["live/client.ts", "../host/runner.js"], ["host/paths.ts", "./runner.js"], ["host/scripts.ts", "./runner.js"], ["host/apps.ts", "./runner.js"], ["config/index.ts", "../host/runner.js"],
  ];
  for (const [relative, from] of places) {
    for (const code of spellings(from)) assert.ok(rules(relative, code).includes(WIRING), `${relative}: ${code} (got ${rules(relative, code).join(", ") || "nothing"})`);
  }
  assert.ok(rules("tools/host.ts", 'const m = await import("../host/runner.js");').includes("dynamic import"));
});

test("at the wiring points only the permitted names come in, unaliased, and createExecRunner is only ever called with no arguments", () => {
  const bad: Array<[string, string, string]> = [
    ["tools/index.ts", 'import { createExecRunner as run } from "../host/runner.js";', NAMES],
    ["tools/index.ts", 'import * as r from "../host/runner.js";', NAMES],
    ["tools/index.ts", 'import r from "../host/runner.js";', NAMES],
    ["tools/index.ts", 'import { createUncheckedRunner } from "../host/runner.js";', NAMES],
    ["tools/index.ts", 'import { contractAllows } from "../host/runner.js";', NAMES],
    ["tools/index.ts", 'import { OPEN_BINARY } from "../host/runner.js";', NAMES],
    ["tools/index.ts", 'import { createExecRunner } from "../host/runner.js";\nimport { OSASCRIPT_BINARY } from "../host/runner.js";', NAMES],
    ["host/host.ts", 'import { createExecRunner } from "./runner.js";', NAMES],
    ["host/host.ts", 'import { OPEN_BINARY as o } from "./runner.js";', NAMES],
    ["host/host.ts", 'import { createUncheckedRunner } from "./runner.js";', NAMES],
    ["tools/index.ts", 'import { createExecRunner } from "../host/runner.js";\ncreateExecRunner(["/bin/sh"]);', CALL],
    ["tools/index.ts", 'import { createExecRunner } from "../host/runner.js";\ncreateExecRunner ( ["/bin/sh"] );', CALL],
    ["tools/index.ts", 'import { createExecRunner } from "../host/runner.js";\nconst f = createExecRunner;\nf();', CALL],
    ["tools/index.ts", 'import { createExecRunner } from "../host/runner.js";\ncreateExecRunner.call(null);', CALL],
    ["tools/index.ts", 'import { createExecRunner } from "../host/runner.js";\nexport { createExecRunner };', CALL],
    ["tools/index.ts", 'import { createExecRunner } from "../host/runner.js";\ncreateExecRunner(...[]);', CALL],
    // where the one call may be
    ["tools/index.ts", 'import { createExecRunner } from "../host/runner.js";\nconst r = createExecRunner();', POSITION],
    ["tools/index.ts", 'import { createExecRunner } from "../host/runner.js";\nexport const shared = createExecRunner();', POSITION],
    ["tools/index.ts", 'import { createExecRunner } from "../host/runner.js";\nregisterStatusTool(registry, { runner: createExecRunner() });', POSITION],
    ["tools/index.ts", 'import { createExecRunner } from "../host/runner.js";\nnew HostService({ runner: createExecRunner() });', POSITION],
    ["tools/index.ts", 'import { createExecRunner } from "../host/runner.js";\nnew HostService({ runner: createExecRunner() ?? deps.host?.runner });', POSITION],
    ["tools/index.ts", 'import { createExecRunner } from "../host/runner.js";\nnew Other({ runner: deps.host?.runner ?? createExecRunner() });', POSITION],
    ["tools/index.ts", 'import { createExecRunner } from "../host/runner.js";\nnew HostService({ other: deps.host?.runner ?? createExecRunner() });', POSITION],
    ["tools/index.ts", 'import { createExecRunner } from "../host/runner.js";\nnew HostService({ runner: x || createExecRunner() });', POSITION],
    ["tools/index.ts", 'import { createExecRunner } from "../host/runner.js";\nfoo(new HostService({ runner: createExecRunner() ?? y }), createExecRunner());', POSITION],
    // reaching the runner of a service or of the deps from anywhere else
    ["tools/status.ts", 'host?.["runner"]("osascript", [], o);', ACCESS],
    ["tools/status.ts", '(h as unknown as { runner: () => void }).runner();', ACCESS],
    ["tools/status.ts", 'const { runner } = h;', ACCESS],
    ["tools/status.ts", 'const { runner: r } = h;', ACCESS],
    ["tools/status.ts", 'const f = (o: { runner: () => void }) => o.runner;', ACCESS],
    ["tools/status.ts", 'x?.runner?.("a");', ACCESS],
    ["tools/exec.ts", 'this.deps.runner;', ACCESS],
    ["host/paths.ts", 'o["runner"];', ACCESS],
    ["tools/host.ts", "o[`runner`];", ACCESS],
    ["tools/index.ts", 'const x = deps.host?.runner;', ACCESS],
    ["tools/index.ts", 'const x = deps.host?.["runner"];', ACCESS],
    ["tools/index.ts", 'foo(deps.host?.runner, createExecRunner());', ACCESS],
    ["tools/index.ts", `${IMP}new HostService({ runner: deps.host?.runner ?? other });`, ACCESS],
    ["tools/index.ts", `${IMP}new HostService({ runner: deps.host?.runner ?? (() => leak)() });`, ACCESS],
    // destructuring and string keys, however they are spelled
    ["tools/status.ts", '({ runner: r } = h);', ACCESS],
    ["tools/status.ts", '({ runner } = h);', ACCESS],
    ["tools/status.ts", '({ ["runner"]: r } = h);', ACCESS],
    ["tools/status.ts", 'const { ["runner"]: r } = h;', ACCESS],
    ["tools/status.ts", 'const { "runner": r } = h;', ACCESS],
    ["tools/status.ts", 'for ({ runner: r } of list) {}', ACCESS],
    ["tools/status.ts", 'field(h, "runner");', ACCESS],
    ["tools/status.ts", 'Object.entries(h).find(([k]) => k === "runner");', ACCESS],
    ["tools/util.ts", "pick(h, `runner`);", ACCESS],
    // HostService must be the real, unaliased import
    ["tools/index.ts", 'import { Leaker as HostService } from "../host/host.js";\nimport { createExecRunner } from "../host/runner.js";\nnew HostService({ runner: deps.host?.runner ?? createExecRunner() });', SERVICE],
    ["tools/index.ts", 'import { HostService as Real } from "../host/host.js";\nimport { createExecRunner } from "../host/runner.js";\nnew Real({ runner: deps.host?.runner ?? createExecRunner() });', POSITION],
    ["tools/index.ts", 'import { HostService } from "./other.js";\nimport { createExecRunner } from "../host/runner.js";\nnew HostService({ runner: deps.host?.runner ?? createExecRunner() });', SERVICE],
    ["tools/index.ts", 'import HostService from "../host/host.js";\nimport { createExecRunner } from "../host/runner.js";\nnew HostService({ runner: deps.host?.runner ?? createExecRunner() });', SERVICE],
    ["tools/index.ts", 'import * as HostService from "../host/host.js";\nimport { createExecRunner } from "../host/runner.js";\nnew HostService({ runner: deps.host?.runner ?? createExecRunner() });', SERVICE],
    ["tools/index.ts", `${IMP}class HostService extends Leaker {}\nnew HostService({ runner: deps.host?.runner ?? createExecRunner() });`, SERVICE],
    ["tools/index.ts", 'import { createExecRunner } from "../host/runner.js";\nclass HostService extends Leaker {}\nnew HostService({ runner: deps.host?.runner ?? createExecRunner() });', SERVICE],
    ["tools/index.ts", 'import { createExecRunner } from "../host/runner.js";\nfunction HostService() {}\nnew HostService({ runner: deps.host?.runner ?? createExecRunner() });', SERVICE],
    ["tools/index.ts", 'import { createExecRunner } from "../host/runner.js";\nconst HostService = Leaker;\nnew HostService({ runner: deps.host?.runner ?? createExecRunner() });', SERVICE],
    ["tools/index.ts", 'import { createExecRunner } from "../host/runner.js";\nnew HostService({ runner: deps.host?.runner ?? createExecRunner() });', POSITION],
    ["tools/status.ts", 'class HostService {}', SERVICE],
    ["tools/exec.ts", 'import { HostService } from "./other.js";', SERVICE],
  ];
  for (const [relative, code, rule] of bad) assert.ok(rules(relative, code).includes(rule), `${relative}: ${code.replace(/\n/g, " ")} should violate "${rule}" (got ${rules(relative, code).join(", ") || "nothing"})`);
});

test("inside host/host.ts the #runner field is only assigned from options.runner in the constructor and only ever called", () => {
  const cls = (body: string): string => `class A { readonly #runner: R; constructor(options: { runner: R }) { ${body} } m() { ${"$M"} } }`;
  const make = (ctor: string, method: string): string => cls(ctor).replace("$M", method);
  const ok = make("this.#runner = options.runner;", "return this.#runner('a', [], o);");
  assert.deepEqual(rules("host/host.ts", ok), []);
  const bad: Array<[string, string]> = [
    [make("this.#runner = options.runner;", "return this.#runner;"), "return the field"],
    [make("this.#runner = options.runner;", "const f = this.#runner; return f;"), "alias the field"],
    [make("this.#runner = options.runner;", "return leak(this.#runner);"), "pass the field"],
    [make("this.#runner = options.runner;", "return this.#runner.call(null, 'a', [], o);"), "call through call"],
    [make("this.#runner = options.runner;", "return this.#runner.bind(null);"), "bind it"],
    [make("this.#runner = options.runner;", "const { x } = { x: this.#runner }; return x;"), "put it in an object"],
    [make("this.#runner = options.runner;", "this.#runner = options.runner;"), "assign outside the constructor"],
    [make("this.#runner = other;", ""), "assign something else"],
    [make("this.#runner = options.runner ?? other;", ""), "assign something else, composed"],
    [make("this.#runner = wrap(options.runner);", ""), "assign something else, wrapped"],
    [make("this.#runner = options.other;", ""), "assign another option"],
    [make("this.#runner = options.runner; leak(this.#runner);", ""), "pass it in the constructor"],
    [make("this.#runner = options.runner;", "return [this.#runner];"), "array"],
    [make("this.#runner = options.runner;", "return { r: this.#runner };"), "object"],
    [make("this.#runner = options.runner;", "return () => this.#runner;"), "arrow returning it"],
  ];
  for (const [code, label] of bad) assert.ok(rules("host/host.ts", code).includes(PRIVATE), `${label}: ${code} (got ${rules("host/host.ts", code).join(", ") || "nothing"})`);
});

test("the real source tree: only host/host.ts and tools/index.ts import the runner as a value", () => {
  const src = path.resolve(import.meta.dirname, "..", "..", "src");
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []));
  const importers = walk(src).filter((file) => /^\s*import\s+(?!type\b)[^;]*from\s+"[^"]*runner\.js"/m.test(fs.readFileSync(file, "utf8"))).map((file) => path.relative(src, file)).sort();
  assert.deepEqual(importers, ["host/host.ts", "tools/index.ts"]);
});

test("src has one runner factory and nothing that bypasses the contract: no 'Unchecked' anywhere under server/src", () => {
  const src = path.resolve(import.meta.dirname, "..", "..", "src");
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []));
  const files = walk(src);
  assert.deepEqual(files.filter((file) => /unchecked/i.test(fs.readFileSync(file, "utf8")) || /unchecked/i.test(file)), []);
  const factories = files.flatMap((file) => [...fs.readFileSync(file, "utf8").matchAll(/export\s+(?:async\s+)?function\s+(create\w*Runner\w*)/g)].map((m) => `${path.relative(src, file)}:${m[1]}`));
  assert.deepEqual(factories, ["host/runner.ts:createExecRunner"]);
  assert.equal(RUNNER_JS_HAS_NO_UNCHECKED(), true);
});

function RUNNER_JS_HAS_NO_UNCHECKED(): boolean {
  const built = path.resolve(import.meta.dirname, "..", "src", "host", "runner.js");
  return !fs.existsSync(built) || !/unchecked/i.test(fs.readFileSync(built, "utf8"));
}
