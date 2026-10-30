import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ALLOWED_ENV_VARS } from "../src/env.js";
import { scanEntries } from "./helpers/ast-scan.js";
import type { Violation } from "./helpers/ast-scan.js";

/**
 * Static checks over server/src that back the "zero dependencies, no network, no processes,
 * stdout belongs to MCP" rules (docs/01-protocol.md section 1 and the feature document).
 * The policy lives in helpers/ast-scan.ts and runs on the TypeScript compiler's AST.
 */

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const SRC = path.join(ROOT, "src");

function listFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full) : entry.name.endsWith(".ts") ? [full] : [];
  });
}

function scan(relative: string, text: string): Violation[] {
  return scanEntries([{ relative, text }]);
}

/** Remove comments so words in documentation do not count. Only used by the two grep-style checks below. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

const NET_RULE = "net connection other than createConnection({ path: this.sockPath })";
const DUPLICATE_IMPORT = "more than one import or binding of a restricted module";
const COMPUTED = "computed member access with a non-literal key";

const BAD: Array<{ code: string; rule: string; file?: string }> = [
  // realpathSync is read-only and allowed, but only as a direct call.
  { code: 'import fs from "node:fs";\nconst f = fs.realpathSync;', rule: "fs function used without being called directly" },
  { code: 'import fs from "node:fs";\nfs.realpathSync.native("x");', rule: "fs function used without being called directly" },
  { code: 'import fs from "node:fs";\nfs.readdirSync("x");', rule: "fs API outside the read-only allowlist" },
  // Plain violations.
  { code: 'import x from "left-pad";', rule: "non-node import" },
  { code: 'import { request } from "node:http";', rule: "node module not on the allowlist" },
  { code: 'import net from "node:net";', rule: "node module used outside its owner" },
  { code: 'import { spawn } from "node:child_process";', rule: "node module used outside its owner" },
  { code: 'export * from "zod";', rule: "non-node import" },
  { code: 'const m = await import("node:fs");', rule: "dynamic import" },
  { code: 'const cp = require("fs");', rule: "banned global" },
  { code: 'import cp = require("fs");', rule: "import = require" },
  { code: "eval('1');", rule: "banned global" },
  { code: "const f = new Function('return 1');", rule: "banned global" },
  { code: "await fetch('http://x');", rule: "banned global" },
  { code: "const w = new WebSocket('x');", rule: "banned global" },
  { code: "console.log('x');", rule: "banned global" },
  { code: "setTimeout('doEvil()', 1);", rule: "string passed to a timer" },
  { code: "process.exit(1);", rule: "process member not allowed in this module" },
  { code: "process.stdout.write('x');", rule: "process member not allowed in this module" },
  { code: "process.stderr.write('x');", rule: "process member not allowed in this module" },
  { code: "const t = process.env.HOME;", rule: "process member not allowed in this module" },
  // Opus's evasions.
  { code: "globalThis['fe' + 'tch']('http://x');", rule: "banned global" },
  { code: "globalThis['fe' + 'tch']('http://x');", rule: "member name built from strings" },
  { code: "process['binding']('fs');", rule: "computed member access on a sensitive object" },
  { code: "({}).constructor.constructor('return 1')();", rule: "constructor/prototype access" },
  { code: 'process.getBuiltinModule("node:" + "http");', rule: "process member not allowed in this module" },
  { code: 'import fs from "node:fs";\nfs.promises.writeFile("x", "y");', rule: "fs API outside the read-only allowlist" },
  { code: 'import fs from "node:fs";\nfs["writeFileSync"]("x", "y");', rule: "computed member access on a sensitive object" },
  { code: 'import { writeFileSync } from "node:fs";\nwriteFileSync("x", "y");', rule: "named value import from fs/net" },
  { code: 'import fs from "node:fs";\nconst { writeFileSync } = fs;', rule: "bare reference to a sensitive object" },
  { code: 'import fs from "node:fs";\nfs.openSync("x", "w");', rule: "fs.openSync with flags that are not provably read-only" },
  { code: 'import fs from "node:fs";\nfs.openSync("x", fs.constants.O_WRONLY | fs.constants.O_CREAT);', rule: "fs.openSync with flags that are not provably read-only" },
  { code: 'import fs from "node:fs";\nconst flags = 1;\nfs.openSync("x", flags);', rule: "fs.openSync with flags that are not provably read-only" },
  { code: 'import fs from "node:fs";\nconst w = fs.constants.O_WRONLY;', rule: "fs.constants flag that allows writing" },
  { code: 'import fs from "node:fs";\nconst w = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_APPEND;', rule: "fs.constants flag that allows writing" },
  { code: 'import fs from "node:fs";\nconst f = fs;\nf.writeFileSync("x", "y");', rule: "bare reference to a sensitive object" },
  { code: 'import fs from "node:fs";\nconst open = fs.openSync;\nopen("x", 1);', rule: "fs function used without being called directly" },
  { code: 'import fs from "node:fs";\nfs.createWriteStream("x");', rule: "fs API outside the read-only allowlist" },
  { code: 'import fs from "node:fs";\nfs.rmSync("x");', rule: "fs API outside the read-only allowlist" },
  // The last-app exception belongs to host/last-app.ts only, and only to these calls and flags.
  { code: 'import fs from "node:fs";\nfs.writeSync(1, "x");', rule: "fs API outside the read-only allowlist" },
  { code: 'import fs from "node:fs";\nfs.renameSync("a", "b");', rule: "fs API outside the read-only allowlist" },
  { code: 'import fs from "node:fs";\nfs.unlinkSync("a");', rule: "fs API outside the read-only allowlist" },
  { code: 'import fs from "node:fs";\nfs.openSync("x", fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL);', rule: "fs.openSync with flags that are not provably read-only", file: "host/host.ts" },
  { code: 'import fs from "node:fs";\nfs.openSync("x", fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL);', rule: "fs.constants flag that allows writing", file: "ears/files.ts" },
  { code: 'import fs from "node:fs";\nfs.rmSync("x");', rule: "fs API outside the read-only allowlist", file: "host/last-app.ts" },
  { code: 'import fs from "node:fs";\nfs.writeFileSync("x", "y");', rule: "fs API outside the read-only allowlist", file: "host/last-app.ts" },
  { code: 'import fs from "node:fs";\nfs.openSync("x", fs.constants.O_RDWR);', rule: "fs.constants flag that allows writing", file: "host/last-app.ts" },
  { code: 'import fs from "node:fs";\nfs.openSync("x", fs.constants.O_APPEND);', rule: "fs.constants flag that allows writing", file: "host/last-app.ts" },
  { code: 'import fs from "node:fs";\nconst w = fs.writeSync;', rule: "fs function used without being called directly", file: "host/last-app.ts" },
  { code: 'import * as fs from "node:fs";\nfs.writeFileSync("x", "y");', rule: "fs API outside the read-only allowlist" },
  { code: 'import fs from "node:fs";\nexport { fs };', rule: "bare reference to a sensitive object" },
  { code: 'import net from "node:net";\nnew net.Socket().connect(443, "host");', rule: "net API outside createConnection", file: "live/client.ts" },
  { code: 'import net from "node:net";\nnet.connect(80, "host");', rule: "net API outside createConnection", file: "live/client.ts" },
  { code: 'import net from "node:net";\nnet.createConnection({ host: "h", port: 1 });', rule: NET_RULE, file: "live/client.ts" },
  { code: 'import net from "node:net";\nnet.createConnection(443, "h");', rule: NET_RULE, file: "live/client.ts" },
  { code: 'import net from "node:net";\nnet.createConnection({ path: p, port: 1 });', rule: NET_RULE, file: "live/client.ts" },
  { code: 'import net from "node:net";\nconst c = net.createConnection;\nc(443, "h");', rule: "net.createConnection used without being called directly", file: "live/client.ts" },
  { code: 'import net from "node:net";\nnet.createServer();', rule: "net API outside createConnection", file: "live/client.ts" },
  // Duplicate imports of a restricted module: only one import declaration, one default name.
  { code: 'import fs from "node:fs";\nimport fsx from "node:fs";\nfsx.writeFileSync("x", "y");', rule: DUPLICATE_IMPORT },
  { code: 'import fs from "node:fs";\nimport fsx from "node:fs";\nfs.rmSync("x");', rule: DUPLICATE_IMPORT },
  { code: 'import fsx from "node:fs";\nimport fs from "node:fs";\nfs.rmSync("x");', rule: DUPLICATE_IMPORT },
  { code: 'import fs from "node:fs";\nimport * as ns from "node:fs";\nns.rmSync("x");', rule: DUPLICATE_IMPORT },
  { code: 'import fs, * as ns from "node:fs";\nns.rmSync("x");', rule: DUPLICATE_IMPORT },
  { code: 'import net from "node:net";\nimport n2 from "node:net";\nn2.connect(1, "h");', rule: DUPLICATE_IMPORT, file: "live/client.ts" },
  // Round 2 evasions: reaching Function through destructuring, descriptors and computed keys.
  { code: "const { constructor: F } = (() => 0);", rule: "constructor/prototype access" },
  { code: "const { ['constructor']: F } = (() => 0);", rule: "constructor/prototype access" },
  { code: "const { __proto__: P } = {};", rule: "constructor/prototype access" },
  { code: "const { prototype: P } = class {};", rule: "constructor/prototype access" },
  { code: 'Object.getOwnPropertyDescriptor(Object.getPrototypeOf(() => 0), "constructor").value;', rule: "prototype or descriptor API" },
  { code: "Object.getOwnPropertyDescriptors(() => 0);", rule: "prototype or descriptor API" },
  { code: "Object.getPrototypeOf(() => 0);", rule: "prototype or descriptor API" },
  { code: "Object.setPrototypeOf({}, null);", rule: "prototype or descriptor API" },
  { code: "Object.defineProperty({}, 'x', { value: 1 });", rule: "prototype or descriptor API" },
  { code: "Object.defineProperties({}, {});", rule: "prototype or descriptor API" },
  { code: "const { getPrototypeOf } = Object;", rule: "prototype or descriptor API" },
  { code: "({}).__defineGetter__('x', () => 1);", rule: "prototype or descriptor API" },
  { code: 'const k = "constructor"; (fn as any)[k];', rule: COMPUTED },
  { code: 'const k = "constructor"; (fn as any)[k];', rule: "constructor/prototype access" },
  { code: "const s = 'proto' + 'type'; (fn as any)[s];", rule: COMPUTED },
  { code: "const a = [1]; let i = 0; a[i];", rule: COMPUTED },
  { code: "const a = [1]; a[Math.min(0, 1)];", rule: COMPUTED },
  { code: "const a = [1]; a[a.length - 1];", rule: COMPUTED },
  { code: "const o: Record<string, number> = {}; for (const k of Object.keys(o)) o[k];", rule: COMPUTED },
  { code: "const s = 'a prototype string';", rule: "constructor/prototype access" },
  { code: 'import net from "node:net";\nnet.createConnection({ path: "/var/run/docker.sock" });', rule: NET_RULE, file: "live/client.ts" },
  { code: 'import net from "node:net";\nnet.createConnection({ path: p });', rule: NET_RULE, file: "live/client.ts" },
  { code: 'import net from "node:net";\nnet.createConnection({ path });', rule: NET_RULE, file: "live/client.ts" },
  { code: 'import net from "node:net";\nnet.createConnection({ path: this.other });', rule: NET_RULE, file: "live/client.ts" },
  { code: 'import net from "node:net";\nnet.createConnection({ path: `${x}/s` });', rule: NET_RULE, file: "live/client.ts" },
  { code: "process['stdout'].write('x');", rule: "computed member access on a sensitive object" },
  { code: "process['env']['HOME'];", rule: "computed member access on a sensitive object" },
  { code: 'const a = "/*"; fetch("http://x"); const b = "*/";', rule: "banned global" },
  { code: "const p = process; p.exit(1);", rule: "bare reference to a sensitive object" },
  { code: "Reflect.get(process, 'binding');", rule: "banned global" },
  { code: "const o = {}; o[`const${'ructor'}`];", rule: "member name built from strings" },
  { code: "const o = {}; o['constructor'];", rule: "constructor/prototype access" },
  { code: "const o = {}; o[String.fromCharCode(99)];", rule: "member name built from strings" },
];

const GOOD: Array<{ code: string; file?: string }> = [
  { code: 'import fs from "node:fs";\nconst fd = fs.openSync("x", fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);' },
  { code: 'import fs from "node:fs";\nconst fd = fs.openSync("t", fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);\nfs.writeSync(fd, "x"); fs.closeSync(fd); fs.renameSync("t", "f"); fs.unlinkSync("t");', file: "host/last-app.ts" },
  { code: 'import net from "node:net";\nclass C { sockPath = "x"; go() { return net.createConnection({ path: this.sockPath }); } }', file: "live/client.ts" },
  { code: 'import net from "node:net";\nlet s: net.Socket | null = null;\nclass C { sockPath = "x"; go() { s = net.createConnection({ path: this.sockPath }); } }', file: "live/client.ts" },
  { code: 'import fs from "node:fs";\nimport { a } from "./a.js";\nconst fd = fs.openSync("x", fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);\nfs.fstatSync(fd); fs.lstatSync("x"); fs.closeSync(fd); fs.readSync(fd, b, 0, 1, 0); fs.openSync("y"); fs.realpathSync("x");' },
  { code: 'import fs from "node:fs";\nlet s: fs.Stats;\nimport type { Stats } from "node:fs";' },
  { code: "// fetch( eval( console.log process.env globalThis\n/* require(x) */ const a = 1;" },
  { code: 'const s = "fetch( eval( process.env globalThis"; const t = `console.log`;' },
  { code: "const id = process.getuid?.() ?? -1;" },
  { code: "const v = process.env[\"HOME\"];", file: "env.ts" },
  { code: "process.stdout.write('x');", file: "mcp/stdio.ts" },
  { code: "process.stderr.write('x');", file: "log.ts" },
  { code: "process.exitCode = 2; process.once('SIGINT', f); process.exit(0);", file: "bin.ts" },
  { code: "const o: Record<string, number> = {}; o['x']; o[\"y\"]; const t = [1]; t[0]; t.at(Math.min(0, 1)); for (const [k, v] of Object.entries(o)) { void k; void v; }" },
  { code: "class A { constructor(readonly x: number) {} }" },
  { code: "const x = { fetchCount: 1, global: 2 }; x.fetchCount; interface I { eval: number; }" },
];

test("the scanner flags every forbidden pattern, including known evasions (it is not vacuous)", () => {
  const entries = BAD.map((b) => ({ relative: b.file ?? "some/file.ts", text: b.code }));
  const all: Violation[][] = entries.map((entry) => scanEntries([entry]));
  BAD.forEach((bad, i) => {
    const rules = all[i]!.map((v) => v.rule);
    assert.ok(rules.includes(bad.rule), `${bad.code.replace(/\n/g, " ")} should violate "${bad.rule}" (got ${rules.join(", ") || "nothing"})`);
  });
});

test("the scanner stays quiet on the allowed forms", () => {
  GOOD.forEach((good) => {
    const violations = scan(good.file ?? "some/file.ts", good.code);
    assert.deepEqual(violations, [], good.code.replace(/\n/g, " "));
  });
});

test("server/src has no forbidden imports, process spawning, eval, network, env, stdout use or filesystem writes", () => {
  const files = listFiles(SRC);
  assert.ok(files.length >= 20, `expected to scan the whole source tree, found ${files.length} files`);
  const entries = files.map((file) => ({ relative: path.relative(SRC, file), text: fs.readFileSync(file, "utf8") }));
  assert.deepEqual(scanEntries(entries), []);
});

test("process.env is read in exactly one module, through an explicit allowlist", () => {
  assert.deepEqual([...ALLOWED_ENV_VARS].sort(), [
    "BATUTA_CONFIG", "BATUTA_CONFIRM", "BATUTA_DESTRUCTIVE", "BATUTA_EDITION", "BATUTA_LOG_LEVEL", "BATUTA_MAX_JUMP_DB", "BATUTA_MAX_MASTER_DB", "HOME",
  ]);
  const readers = listFiles(SRC).filter((f) => /process\.env/.test(stripComments(fs.readFileSync(f, "utf8"))));
  assert.deepEqual(readers.map((f) => path.relative(SRC, f)), ["env.ts"]);
});

test("exactly one place writes to the MCP output stream", () => {
  const writers = listFiles(SRC).flatMap((file) => {
    const count = (stripComments(fs.readFileSync(file, "utf8")).match(/\boutput\.write\s*\(/g) ?? []).length;
    return count > 0 ? [`${path.relative(SRC, file)}:${count}`] : [];
  });
  assert.deepEqual(writers, ["mcp/server.ts:1"]);
});

test("package.json has no runtime dependencies and exact-pinned dev dependencies", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
  for (const key of ["dependencies", "optionalDependencies", "peerDependencies", "bundledDependencies", "bundleDependencies"]) {
    const value = pkg[key];
    assert.ok(value === undefined || Object.keys(value).length === 0, `${key} must be absent or empty`);
  }
  assert.deepEqual(Object.keys(pkg["devDependencies"] ?? {}).sort(), ["@types/node", "typescript"]);
  for (const [name, version] of Object.entries(pkg["devDependencies"] ?? {})) {
    assert.match(version, /^\d+\.\d+\.\d+$/, `${name} must be pinned to an exact version`);
  }
  assert.equal(pkg["scripts"] && Object.keys(pkg["scripts"]).some((s) => /^(pre|post)?install$/.test(s)), false, "no install scripts");
});

test("every package in the lockfile is a dev dependency (nothing ships at runtime)", () => {
  assert.equal(fs.existsSync(path.join(ROOT, "package-lock.json")), false, "the npm lockfile is gone");
  // pnpm 12 writes two YAML documents: the first pins pnpm itself (packageManagerDependencies),
  // the last is the project. Both must be registry-pinned and script-free.
  const docs = fs.readFileSync(path.join(ROOT, "pnpm-lock.yaml"), "utf8").split(/^---$/m).map((d) => d.split("\n"));
  const section = (lines: string[], name: string): string[] => {
    const start = lines.indexOf(`${name}:`);
    assert.notEqual(start, -1, `lockfile has a ${name} section`);
    const out: string[] = [];
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (line !== "" && !line.startsWith(" ")) break;
      out.push(line);
    }
    return out;
  };
  const project = docs[docs.length - 1] ?? [];
  // The project may only declare devDependencies (no runtime or optional ones).
  const importerKeys = section(project, "importers").filter((l) => /^ {4}\S/.test(l)).map((l) => l.trim());
  assert.deepEqual(importerKeys, ["devDependencies:"], "only devDependencies at the project level");
  const names = section(project, "packages").filter((l) => /^ {2}\S/.test(l)).map((l) => l.trim().replace(/:$/, "").replace(/^'|'$/g, ""));
  assert.ok(names.some((n) => n.startsWith("typescript@")) && names.some((n) => n.startsWith("@types/node@")));
  for (const lines of docs) {
    if (!lines.includes("packages:")) continue;
    const packages = section(lines, "packages");
    const pkgNames = packages.filter((l) => /^ {2}\S/.test(l));
    const resolutions = packages.filter((l) => l.includes("resolution:"));
    assert.ok(pkgNames.length >= 1);
    assert.equal(resolutions.length, pkgNames.length, "every package has a resolution");
    for (const l of resolutions) {
      assert.match(l, /integrity: sha(256|384|512)-/, "every package is integrity-pinned");
      assert.ok(!/tarball:|git|repo:/.test(l) || /https:\/\/registry\.npmjs\.org\//.test(l), "resolved from the npm registry");
    }
    assert.deepEqual(packages.filter((l) => /requiresBuild|hasInstallScript/.test(l)), [], "no package runs install scripts");
    assert.deepEqual(section(lines, "snapshots").filter((l) => /requiresBuild|hasInstallScript/.test(l)), []);
  }
});

test("prepack cleans dist and rebuilds, so a tarball never carries stale output; the package stays private", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { private?: boolean; scripts?: Record<string, string>; files?: string[] };
  assert.equal(pkg.private, true);
  const prepack = pkg.scripts?.["prepack"] ?? "";
  assert.match(prepack, /rmSync\(['"]dist['"]/, "prepack removes dist first");
  assert.match(prepack, /pnpm run build/, "and then rebuilds");
  assert.ok(prepack.indexOf("rmSync") < prepack.indexOf("pnpm run build"));
  assert.deepEqual(pkg.files, ["dist/src"], "tests are never published");
});

test("snapshotEnv returns only allowlisted variables that are set", async () => {
  const { snapshotEnv } = await import("../src/env.js");
  const saved = { ...process.env };
  try {
    process.env["BATUTA_EDITION"] = "lite";
    process.env["SOME_OTHER_SECRET"] = "x";
    delete process.env["BATUTA_CONFIG"];
    const snapshot = snapshotEnv();
    assert.equal(snapshot.BATUTA_EDITION, "lite");
    assert.equal("BATUTA_CONFIG" in snapshot, false);
    assert.equal("SOME_OTHER_SECRET" in snapshot, false);
    assert.ok(Object.keys(snapshot).every((k) => (ALLOWED_ENV_VARS as readonly string[]).includes(k)));
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
