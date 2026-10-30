import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { scanEntries } from "./helpers/ast-scan.js";
import type { Violation } from "./helpers/ast-scan.js";

/**
 * The one exception to "no worker threads" (docs/01-protocol.md 10.6): ears/analysis.ts may start exactly one
 * kind of Worker, from a fixed compiled file next to the server code, and the worker entry may use parentPort.
 * These tests show the exception is narrow, and that the loudness code that ships inside the server stays pure.
 */

const SERVER = path.resolve(import.meta.dirname, "..", "..");
const REPO = path.resolve(SERVER, "..");
const OWNER = "ears/analysis.ts";
const ENTRY = "../loudness/src/worker.ts";
const WORKER_RULE = "Worker construction other than new Worker(new URL(\"../loudness/worker.js\", import.meta.url), { resourceLimits, env: {}, name })";
const IMPORT_RULE = "worker_threads import other than Worker (and types) in the analysis module, or parentPort in the worker entry";
const OUTSIDE = "node module used outside its owner";
const HEAD = 'import { Worker } from "node:worker_threads";\nimport type { ResourceLimits } from "node:worker_threads";\n';
const CANON = 'new Worker(new URL("../loudness/worker.js", import.meta.url), { resourceLimits: limits, env: {}, name: "batuta-analysis" })';

function scan(relative: string, text: string, pure = false): Violation[] {
  return scanEntries([{ relative, text }], pure ? { pure: true } : undefined);
}
const rules = (violations: Violation[]): string[] => violations.map((v) => v.rule);

test("the canonical forms are accepted, in the analysis module and in the worker entry", () => {
  assert.deepEqual(scan(OWNER, `${HEAD}export function make(limits: ResourceLimits) { return ${CANON}; }`), []);
  assert.deepEqual(scan(OWNER, `${HEAD}export const make = (limits: ResourceLimits) => new Worker(new URL("../loudness/worker.js", import.meta.url), { resourceLimits: limits });`), []);
  assert.deepEqual(scan(OWNER, 'import type { Worker, ResourceLimits } from "node:worker_threads";\nexport type F = (l: ResourceLimits) => Worker;'), []);
  assert.deepEqual(scan(ENTRY, 'import { parentPort } from "node:worker_threads";\nparentPort?.on("message", () => {});'), []);
});

test("every other file is refused the module", () => {
  for (const file of ["live/client.ts", "tools/ears.ts", "ears/job.ts", "ears/files.ts", "host/runner.ts", "bin.ts", "ears/analysis.js.ts", "../loudness/src/analyze.ts"]) {
    assert.ok(rules(scan(file, 'import { Worker } from "node:worker_threads";')).includes(OUTSIDE), file);
    assert.ok(rules(scan(file, 'import { parentPort } from "node:worker_threads";')).includes(OUTSIDE), file);
    assert.ok(rules(scan(file, 'import * as wt from "node:worker_threads";')).includes(OUTSIDE), file);
  }
  assert.ok(rules(scan("tools/ears.ts", `${HEAD}${CANON};`)).includes(OUTSIDE));
});

test("module spellings other than the one named import are refused even in the owner", () => {
  const cases = [
    'import * as wt from "node:worker_threads";',
    'import wt from "node:worker_threads";',
    'import { Worker as W } from "node:worker_threads";',
    'import { Worker, isMainThread } from "node:worker_threads";',
    'import { Worker, workerData } from "node:worker_threads";',
    'import { Worker, SHARE_ENV } from "node:worker_threads";',
    'import { parentPort } from "node:worker_threads";',
    'import { MessageChannel } from "node:worker_threads";',
    'export { Worker } from "node:worker_threads";',
    'export * from "node:worker_threads";',
    'import "node:worker_threads";',
  ];
  for (const code of cases) assert.ok(rules(scan(OWNER, code)).includes(IMPORT_RULE), code);
});

test("the worker entry may import parentPort and nothing else from worker_threads", () => {
  const cases = [
    'import { Worker } from "node:worker_threads";',
    'import { parentPort, workerData } from "node:worker_threads";',
    'import { parentPort, Worker } from "node:worker_threads";',
    'import { parentPort as p } from "node:worker_threads";',
    'import * as wt from "node:worker_threads";',
    'import wt from "node:worker_threads";',
    'import { isMainThread } from "node:worker_threads";',
    'import { parentPort } from "node:child_process";',
    'import { parentPort } from "node:fs";',
  ];
  for (const code of cases) assert.notDeepEqual(scan(ENTRY, code, true), [], code);
});

test("a Worker needs the fixed file URL: literal path, import.meta.url, literal options with three allowed keys", () => {
  const bad = [
    `new Worker("console.log(1)", { eval: true })`,
    `new Worker(new URL("../loudness/worker.js", import.meta.url), { eval: true, resourceLimits: limits })`,
    `new Worker(new URL("../loudness/worker.js", import.meta.url), { ["eval"]: true })`,
    `new Worker(new URL("../loudness/worker.js", import.meta.url), { "eval": false })`,
    `new Worker(new URL(somewhere, import.meta.url), {})`,
    `new Worker(new URL("../loudness/" + name, import.meta.url), {})`,
    'new Worker(new URL(`../loudness/${name}.js`, import.meta.url), {})',
    `new Worker(new URL("../loudness/other.js", import.meta.url), {})`,
    `new Worker(new URL("../../etc/evil.js", import.meta.url), {})`,
    `new Worker(new URL("file:///tmp/evil.js"), {})`,
    `new Worker(new URL("../loudness/worker.js", "file:///tmp/"), {})`,
    `new Worker(new URL("data:text/javascript,1", import.meta.url), {})`,
    `new Worker(url, {})`,
    `new Worker()`,
    `new Worker(new URL("../loudness/worker.js", import.meta.url))`,
    `new Worker(new URL("../loudness/worker.js", import.meta.url), options)`,
    `new Worker(new URL("../loudness/worker.js", import.meta.url), { ...options })`,
    `new Worker(new URL("../loudness/worker.js", import.meta.url), { execArgv: ["--allow-natives-syntax"] })`,
    `new Worker(new URL("../loudness/worker.js", import.meta.url), { workerData: secret })`,
    `new Worker(new URL("../loudness/worker.js", import.meta.url), { argv: [] })`,
    `new Worker(new URL("../loudness/worker.js", import.meta.url), { env: process.env })`,
    `new Worker(new URL("../loudness/worker.js", import.meta.url), { env: { A: "1" } })`,
    `new Worker(new URL("../loudness/worker.js", import.meta.url), { resourceLimits: limits }, extra)`,
    `Worker(new URL("../loudness/worker.js", import.meta.url), {})`,
  ];
  for (const code of bad) assert.ok(rules(scan(OWNER, `${HEAD}${code};`)).includes(WORKER_RULE), code);
});

test("the Worker name cannot be aliased, stored, passed around or called without new", () => {
  const bad = [
    "const W = Worker;",
    "const { Worker: W2 } = { Worker };",
    "export const make = Worker;",
    "export { Worker };",
    "register(Worker);",
    "const list = [Worker];",
    "Worker.prototype;",
    "Reflect.construct(Worker, []);",
    "new Worker.constructor();",
    "const w = new Worker(new URL('../loudness/worker.js', import.meta.url), {}); const x = Worker;",
  ];
  for (const code of bad) assert.ok(rules(scan(OWNER, `${HEAD}${code}`)).includes(WORKER_RULE), code);
  // using the instance is fine: only constructing it is restricted
  assert.deepEqual(scan(OWNER, `${HEAD}export function f(limits: ResourceLimits) { const w = ${CANON}; w.postMessage(1); w.on("message", () => {}); return w.terminate(); }`), []);
});

test("eval inside the worker entry, dynamic imports and non-literal specifiers are refused there too", () => {
  for (const code of ['eval("1");', 'import("node:fs");', 'const f = new Function("return 1");', 'import x from "left-pad";', 'import fs from "node:fs";', 'fetch("http://x");', "process.exit(1);", "globalThis.x = 1;", 'import { y } from `./${name}.ts`;']) {
    assert.notDeepEqual(scan(ENTRY, `import { parentPort } from "node:worker_threads";\n${code}`, true), [], code);
  }
});

test("the pure profile (loudness code) allows indexing and numeric code but no node modules, no process, no dynamic code", () => {
  assert.deepEqual(scan("../loudness/src/stats.ts", 'import type { Samples } from "./kweight.ts";\nexport function f(a: Float64Array, i: number) { let s = 0; for (let k = 0; k < a.length; k++) s += a[k] * a[i]; return Math.sqrt(s); }', true), []);
  for (const code of ['import fs from "node:fs";', 'import { createHash } from "node:crypto";', 'import x from "left-pad";', "process.env.HOME;", "eval('1');", 'await import("./x.ts");', 'new Worker(new URL("../loudness/worker.js", import.meta.url), {});', "globalThis.x;", "const g = Function;"]) {
    assert.notDeepEqual(scan("../loudness/src/stats.ts", code, true), [], code);
  }
});

test("the loudness sources that ship inside the server pass the pure profile; the worker entry is the only file with worker_threads", () => {
  const dir = path.join(REPO, "loudness", "src");
  const files = fs.readdirSync(dir).filter((name) => name.endsWith(".ts")).sort();
  assert.ok(files.includes("worker.ts") && files.includes("analyze.ts"));
  const entries = files.map((name) => ({ relative: `../loudness/src/${name}`, text: fs.readFileSync(path.join(dir, name), "utf8") }));
  assert.deepEqual(scanEntries(entries, { pure: true }), []);
  const users = entries.filter((e) => e.text.includes("worker_threads")).map((e) => e.relative);
  assert.deepEqual(users, [ENTRY]);
});

test("the server source has exactly one Worker construction, and it is in the analysis module", () => {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) {
        const text = fs.readFileSync(full, "utf8");
        const count = (text.match(/new Worker\(/g) ?? []).length;
        if (count > 0) found.push(`${path.relative(path.join(SERVER, "src"), full)}:${count}`);
        if (text.includes("worker_threads") && path.relative(path.join(SERVER, "src"), full) !== OWNER) assert.fail(`${full} mentions worker_threads`);
      }
    }
  };
  walk(path.join(SERVER, "src"));
  assert.deepEqual(found, [`${OWNER}:1`]);
});

test("the build compiles the loudness engine into the package, and the worker URL points at a file that exists", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(SERVER, "package.json"), "utf8")) as { scripts: Record<string, string>; files: string[]; dependencies?: unknown };
  assert.match(pkg.scripts["build"] ?? "", /tsc -p tsconfig\.json && tsc -p \.\.\/loudness\/tsconfig\.json/);
  assert.deepEqual(pkg.files, ["dist/src"]);
  assert.equal(pkg.dependencies, undefined);
  const out = path.join(SERVER, "dist", "src");
  for (const name of ["analyze", "audiofile", "kweight", "loudness", "stats", "truepeak", "worker"]) assert.ok(fs.existsSync(path.join(out, "loudness", `${name}.js`)), name);
  const compiled = fs.readFileSync(path.join(out, "ears", "analysis.js"), "utf8");
  const match = /new URL\("([^"]+)", import\.meta\.url\)/.exec(compiled);
  assert.ok(match, "the compiled module builds the URL from a literal");
  assert.ok(fs.existsSync(path.resolve(out, "ears", match[1] as string)), "and the file is there");
  // the compiled loudness code only imports its own files, except the worker entry
  for (const name of fs.readdirSync(path.join(out, "loudness"))) {
    if (!name.endsWith(".js")) continue;
    const text = fs.readFileSync(path.join(out, "loudness", name), "utf8");
    const specifiers = [...text.matchAll(/^import .* from ['"]([^'"]+)['"]/gm)].map((m) => m[1] as string);
    for (const specifier of specifiers) assert.ok(specifier.startsWith("./") || (name === "worker.js" && specifier === "node:worker_threads"), `${name}: ${specifier}`);
  }
  const tsconfig = JSON.parse(fs.readFileSync(path.join(REPO, "loudness", "tsconfig.json"), "utf8")) as { compilerOptions: Record<string, unknown> };
  assert.equal(tsconfig.compilerOptions["outDir"], "../server/dist/src/loudness");
});
