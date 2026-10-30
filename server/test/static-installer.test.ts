import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { API } from "typescript/unstable/sync";
import { SyntaxKind } from "typescript/unstable/ast";
import type { Node } from "typescript/unstable/ast";

/**
 * Authoritative static check of installer/install.mjs on the TypeScript compiler's AST (the installer
 * test keeps a lexer-based tripwire; this is the check that cannot be fooled by quoting tricks).
 * Same infrastructure as helpers/ast-scan.ts: the unstable TypeScript API, test-time only.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type N = any;

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const INSTALLER = path.join(ROOT, "installer", "install.mjs");
const EVASIONS = path.join(ROOT, "installer", "test", "evasions.json");

const ALLOWED_FS = new Set([
  "lstatSync", "fstatSync", "readdirSync", "readFileSync", "mkdirSync", "openSync", "writeSync", "fchmodSync", "fsyncSync", "closeSync", "renameSync",
  // Link mode (T9c): only these three, for the development symlink and its checks.
  "symlinkSync", "readlinkSync", "realpathSync",
]);
const ALLOWED_MODULES = new Set(["node:fs", "node:os", "node:path", "node:crypto", "node:url"]);
const ALLOWED_PROCESS = new Set(["argv", "stdout", "stderr", "getuid", "exitCode", "execPath"]);
const ALLOWED_OBJECT = new Set(["keys", "entries", "fromEntries"]);
const OPEN_FLAGS = new Set(["wx", "r"]);
/** Identifiers and substrings of string literals that lead to the Function constructor or the prototype chain. */
const BANNED_NAMES = ["constructor", "__proto__", "prototype", "AsyncFunction", "GeneratorFunction"];
const BANNED_IDENTIFIERS = new Set([
  "eval", "Function", "require", "getBuiltinModule", "createRequire", "globalThis", "global", "Reflect", "fetch", "XMLHttpRequest",
  "WebSocket", "WebAssembly", "Proxy", "Worker", "SharedArrayBuffer", "Atomics", "module", "exports", "setTimeout", "setInterval",
  "setImmediate", "queueMicrotask", "child_process",
  "getPrototypeOf", "setPrototypeOf", "getOwnPropertyDescriptor", "getOwnPropertyDescriptors", "defineProperty", "defineProperties",
  "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__",
]);
const STRING_KINDS = new Set<number>([SyntaxKind.StringLiteral, SyntaxKind.NoSubstitutionTemplateLiteral, SyntaxKind.TemplateHead, SyntaxKind.TemplateMiddle, SyntaxKind.TemplateTail]);

function unwrap(node: N): N {
  let n = node;
  while (n && (n.kind === SyntaxKind.ParenthesizedExpression || n.kind === SyntaxKind.NonNullExpression || n.kind === SyntaxKind.AsExpression)) n = n.expression;
  return n;
}
const list = (xs: N): N[] => (xs ? Array.from(xs as Iterable<N>) : []);
const isNumeric = (node: N): boolean => unwrap(node)?.kind === SyntaxKind.NumericLiteral;

/** Parse `text` (as a module) with the TypeScript parser and return the policy violations. */
function scanInstaller(text: string): string[] {
  const dir = fs.mkdtempSync("/tmp/bm-ast-");
  let api: API | undefined;
  try {
    fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({
      compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", noEmit: true, types: [], skipLibCheck: true },
      include: ["*.ts"],
    }));
    const file = path.join(dir, "s0.ts");
    fs.writeFileSync(file, text);
    api = new API({ cwd: dir });
    const project = api.updateSnapshot({ openProject: path.join(dir, "tsconfig.json") }).getProjects()[0];
    const source = project?.program.getSourceFile(file);
    if (!source) throw new Error("the TypeScript API did not parse the source");
    const out: string[] = [];
    let fsLocal: string | undefined;
    let renames = 0;
    const add = (node: N, rule: string): void => {
      const line = text.slice(0, node.pos ?? 0).split("\n").length;
      out.push(`${rule} (line ${line})`);
    };
    // Exactly one import declaration per module; for node:fs exactly one, with a single default name.
    const importCounts = new Map<string, number>();
    for (const st of list((source as N).statements)) {
      if (st.kind !== SyntaxKind.ImportDeclaration || st.moduleSpecifier?.kind !== SyntaxKind.StringLiteral) continue;
      const module: string = st.moduleSpecifier.text;
      const seen = (importCounts.get(module) ?? 0) + 1;
      importCounts.set(module, seen);
      if (seen > 1) add(st, `more than one import of ${module}`);
      if (module === "node:fs" && seen === 1 && st.importClause?.name && !st.importClause.namedBindings) fsLocal = st.importClause.name.text;
    }
    const visit = (node: N): void => {
      switch (node.kind) {
        case SyntaxKind.ImportDeclaration:
        case SyntaxKind.ExportDeclaration: {
          const spec = node.moduleSpecifier;
          if (node.kind === SyntaxKind.ExportDeclaration && spec) add(node, "export from");
          if (spec && (spec.kind !== SyntaxKind.StringLiteral || !ALLOWED_MODULES.has(spec.text))) add(node, "import of a module outside the allowlist");
          if (spec?.text === "node:fs" && !(node.importClause?.name && !node.importClause.namedBindings)) add(node, "fs must be imported as a default binding only");
          break;
        }
        case SyntaxKind.ImportEqualsDeclaration: add(node, "import = require"); break;
        case SyntaxKind.ElementAccessExpression:
          if (!isNumeric(node.argumentExpression)) add(node, "element access with a non-numeric key");
          break;
        case SyntaxKind.ComputedPropertyName:
          if (!isNumeric(node.expression)) add(node, "computed property name with a non-numeric key");
          break;
        case SyntaxKind.TemplateExpression:
        case SyntaxKind.NoSubstitutionTemplateLiteral:
        case SyntaxKind.TaggedTemplateExpression:
          add(node, "template literal");
          break;
        case SyntaxKind.WithStatement: add(node, "with statement"); break;
        case SyntaxKind.CallExpression: {
          const callee = unwrap(node.expression);
          if (callee.kind === SyntaxKind.ImportKeyword) add(node, "dynamic import()");
          if (callee.kind === SyntaxKind.PropertyAccessExpression && unwrap(callee.expression)?.text === fsLocal && fsLocal !== undefined) {
            const args = list(node.arguments);
            if (callee.name.text === "openSync") {
              const flag = args.at(1) && unwrap(args.at(1));
              if (!flag || flag.kind !== SyntaxKind.StringLiteral || !OPEN_FLAGS.has(flag.text)) add(node, "openSync flags must be the literal 'wx' or 'r'");
            }
            if (callee.name.text === "renameSync") {
              renames++;
              // Each rename site is reviewed to have an absent destination and says so in its call.
              if (!text.slice(node.pos, node.end).includes("/* dest-absent */")) add(node, "renameSync without the /* dest-absent */ marker");
            }
          }
          break;
        }
        case SyntaxKind.MetaProperty: {
          const p = node.parent;
          if (!(p?.kind === SyntaxKind.PropertyAccessExpression && p.name.text === "url")) add(node, "import.meta other than url");
          break;
        }
        case SyntaxKind.Identifier: identifier(node); break;
        default:
          if (STRING_KINDS.has(node.kind)) {
            for (const banned of BANNED_NAMES) if ((node.text as string).includes(banned)) add(node, `string containing ${banned}`);
            if (/child_process|node:(net|http|https|dgram|tls|dns|vm|module|worker_threads)/.test(node.text as string)) add(node, "string naming a banned module");
          }
      }
      if (node.questionDotToken || node.kind === SyntaxKind.QuestionDotToken) add(node, "optional chaining");
      node.forEachChild((child: Node) => { visit(child); });
    };
    const identifier = (node: N): void => {
      const name: string = node.text;
      const parent = node.parent;
      if (BANNED_NAMES.includes(name)) add(node, `banned name ${name}`);
      if (BANNED_IDENTIFIERS.has(name)) add(node, `banned identifier ${name}`);
      const isImportBinding = parent && (parent.kind === SyntaxKind.ImportClause || parent.kind === SyntaxKind.NamespaceImport || parent.kind === SyntaxKind.ImportSpecifier);
      const isMemberName = parent?.kind === SyntaxKind.PropertyAccessExpression && parent.name === node;
      if (fsLocal !== undefined && name === fsLocal && !isImportBinding && !isMemberName) {
        const callee = parent?.kind === SyntaxKind.PropertyAccessExpression && parent.expression === node ? parent : undefined;
        const called = callee?.parent?.kind === SyntaxKind.CallExpression && unwrap(callee.parent.expression) === callee;
        if (!callee || !called || !ALLOWED_FS.has(callee.name.text)) add(node, `fs used other than as a direct call of an allowlisted member`);
      }
      if (name === "process" && !isMemberName) {
        const ok = parent?.kind === SyntaxKind.PropertyAccessExpression && parent.expression === node && ALLOWED_PROCESS.has(parent.name.text);
        if (!ok) add(node, "process used other than via an allowlisted member");
      }
      if (name === "Object" && !isMemberName) {
        const ok = parent?.kind === SyntaxKind.PropertyAccessExpression && parent.expression === node && ALLOWED_OBJECT.has(parent.name.text);
        if (!ok) add(node, "Object used other than keys/entries/fromEntries");
      }
    };
    visit(source as N);
    if (/\bfs\b/.test(text) && fsLocal === undefined && /node:fs/.test(text)) add(source as N, "fs imported in a form the policy does not accept");
    if (renames > 4) add(source as N, "more renameSync calls than the four reviewed sites");
    return out;
  } finally {
    api?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("the evasion corpus is flagged by the AST policy", () => {
  const corpus = JSON.parse(fs.readFileSync(EVASIONS, "utf8")) as { lexerOnly: string[]; snippets: Record<string, string> };
  const unflagged = Object.entries(corpus.snippets)
    .filter(([name]) => !corpus.lexerOnly.includes(name))
    .filter(([, code]) => scanInstaller(code).length === 0)
    .map(([name]) => name);
  assert.deepEqual(unflagged, []);
});

test("link mode adds only symlinkSync/readlinkSync/realpathSync: aliasing or sub-members of them, and other link calls, are still flagged", () => {
  const pre = "import fs from 'node:fs';\n";
  const bad = [
    "const s = fs.symlinkSync; s(a, b);",
    "fs.realpathSync.native(p);",
    "fs.linkSync(a, b);",
    "fs.lchmodSync(p, 0o777);",
    "fs.symlink(a, b, () => {});",
    "fs['symlink' + 'Sync'](a, b);",
  ];
  for (const code of bad) assert.ok(scanInstaller(pre + code).length > 0, code);
  assert.deepEqual(scanInstaller(pre + "fs.symlinkSync(a, b); fs.readlinkSync(b); fs.realpathSync(b);"), []);
});

test("the real installer uses exactly four renameSync sites and the openSync write path", () => {
  const text = fs.readFileSync(INSTALLER, "utf8");
  assert.equal((text.match(/fs\.renameSync\(/g) ?? []).length, 4);
  assert.ok(text.includes("fs.openSync(fp, 'wx', 0o644)"));
});

test("installer/install.mjs satisfies the AST policy", () => {
  assert.deepEqual(scanInstaller(fs.readFileSync(INSTALLER, "utf8")), []);
});

