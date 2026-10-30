import fs from "node:fs";
import path from "node:path";
import { API } from "typescript/unstable/sync";
import { SyntaxKind } from "typescript/unstable/ast";
import type { Node, SourceFile } from "typescript/unstable/ast";

/**
 * AST-based policy scanner for server/src (test-time only; the compiler API never ships).
 *
 * It parses with the TypeScript compiler's own parser, so comments, string contents and odd
 * formatting cannot hide code from it, and it applies a deny-by-default policy to the few
 * capabilities that matter: dynamic code, network, process spawning, filesystem writes, and the
 * process-wide streams and environment. Anything that smells like an evasion (computed access to
 * a sensitive object, aliasing a module namespace, string-built names) is refused outright.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type N = any;

export interface Violation {
  file: string;
  rule: string;
  text: string;
}

export interface SourceEntry {
  /** Path relative to src, e.g. "live/client.ts". It decides which module-specific allowances apply. */
  relative: string;
  text: string;
}

const ALLOWED_NODE_MODULES = new Set([
  "node:net", "node:crypto", "node:fs", "node:path", "node:os", "node:stream", "node:events", "node:buffer", "node:util", "node:timers",
  "node:child_process", "node:worker_threads",
]);
/** Modules that may be imported only by the named file. */
const MODULE_OWNERS: Record<string, string[]> = {
  "node:net": ["live/client.ts"], "node:child_process": ["host/runner.ts"],
  "node:worker_threads": ["ears/analysis.ts", "../loudness/src/worker.ts"],
};
/**
 * The one worker-thread exception (docs/01-protocol.md 10.6). `ears/analysis.ts` may import `Worker` (a plain named
 * import; types are free) and construct it in exactly one shape: `new Worker(new URL("../loudness/worker.js",
 * import.meta.url), { resourceLimits, env: {}, name: "..." })`. The worker entry (loudness/src/worker.ts, scanned
 * as `../loudness/src/worker.ts`) may import `parentPort` and nothing else from the module. The name `Worker` cannot
 * be aliased, stored, passed around or called without `new`.
 */
const WORKER_THREADS = "node:worker_threads";
const WORKER_OWNER = "ears/analysis.ts";
const WORKER_ENTRY = "../loudness/src/worker.ts";
const WORKER_FILE_URL = "../loudness/worker.js";
const WORKER_OPTION_KEYS = new Set(["resourceLimits", "env", "name"]);
const WORKER_IMPORT_RULE = "worker_threads import other than Worker (and types) in the analysis module, or parentPort in the worker entry";
const WORKER_RULE = "Worker construction other than new Worker(new URL(\"../loudness/worker.js\", import.meta.url), { resourceLimits, env: {}, name })";
/**
 * The one process-spawning exception (docs/04-host-automation.md section 1): `execFile`, as a plain named import,
 * in the host runner only. Inside that file the exec family, any `shell` name and any call other than
 * execFile(binary, argv, { literal options }, callback) are refused.
 */
const CHILD_PROCESS = "node:child_process";
const CHILD_PROCESS_OWNER = "host/runner.ts";
/**
 * Who may use the runner module as a value (docs/04-host-automation.md section 1), and which names each may import.
 * Type-only imports are unrestricted. `createExecRunner` may only be called, with no arguments.
 */
const RUNNER_MODULE = "host/runner";
const RUNNER_IMPORTERS: Record<string, string[]> = { "host/host.ts": ["OPEN_BINARY", "OSASCRIPT_BINARY"], "tools/index.ts": ["createExecRunner"] };
const EXEC_FAMILY = new Set(["exec", "execSync", "execFileSync", "spawn", "spawnSync", "fork"]);
/** Modules whose value imports must go through a namespace/default binding so the scanner can see every call. */
const NAMESPACE_ONLY_MODULES = new Set(["node:fs", "node:net"]);

/** `fs.<name>(...)` calls that only read. Everything else on `fs` is refused. */
const FS_READ_CALLS = new Set(["openSync", "closeSync", "fstatSync", "lstatSync", "statSync", "readSync", "realpathSync"]);
const FS_READ_FLAGS = new Set(["O_RDONLY", "O_NOFOLLOW", "O_CLOEXEC", "O_DIRECTORY", "O_NONBLOCK"]);
/**
 * The one filesystem-write exception (docs/04-host-automation.md section 3.1): `host/last-app.ts` remembers which
 * edition of Live connected last, in a tiny file in the runtime directory. It may create a new file exclusively
 * without following links (`O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW`), write to the descriptor, rename it over
 * the final name and unlink its own temporary file. No other module may use any of these.
 */
const LAST_APP_OWNER = "host/last-app.ts";
const FS_LAST_APP_CALLS = new Set(["writeSync", "renameSync", "unlinkSync"]);
const FS_LAST_APP_FLAGS = new Set(["O_WRONLY", "O_CREAT", "O_EXCL"]);

const BANNED_IDENTIFIERS = new Set([
  "eval", "Function", "fetch", "WebSocket", "XMLHttpRequest", "EventSource", "globalThis", "global", "require",
  "Reflect", "WebAssembly", "console", "importScripts",
]);
/** Names that lead to the Function constructor; banned as identifiers, property names, destructuring keys and inside any string. */
const BANNED_MEMBERS = ["constructor", "__proto__", "prototype"];
/** Reflection that can reach constructors or rewrite objects behind the scanner's back. */
const BANNED_REFLECTION = new Set([
  "getPrototypeOf", "setPrototypeOf", "getOwnPropertyDescriptor", "getOwnPropertyDescriptors", "defineProperty", "defineProperties",
  "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__",
]);
const STRING_LITERAL_KINDS = new Set<number>([
  SyntaxKind.StringLiteral, SyntaxKind.NoSubstitutionTemplateLiteral, SyntaxKind.TemplateHead, SyntaxKind.TemplateMiddle, SyntaxKind.TemplateTail,
]);
const COMPUTED_FORBIDDEN_BASES = new Set(["process", "globalThis", "global", "Reflect", "Object"]);
const STRING_BUILDERS = new Set(["fromCharCode", "fromCodePoint", "atob", "join", "concat", "repeat", "replace", "toString", "slice", "substring"]);
const TIMER_FUNCTIONS = new Set(["setTimeout", "setInterval", "setImmediate", "queueMicrotask"]);

/** `process.<name>` members, by the one file that may use them. `getuid` is allowed everywhere. */
const PROCESS_MEMBERS: Record<string, string[]> = {
  "env.ts": ["env"],
  "mcp/stdio.ts": ["stdout", "stdin"],
  "log.ts": ["stderr"],
  "bin.ts": ["exit", "exitCode", "once"],
};
const PROCESS_MEMBERS_EVERYWHERE = new Set(["getuid"]);

/** Identifier positions that are names, not references. */
const NAME_POSITION_PARENTS = new Set<number>([
  SyntaxKind.PropertyAccessExpression, SyntaxKind.PropertyAssignment, SyntaxKind.PropertySignature,
  SyntaxKind.MethodDeclaration, SyntaxKind.MethodSignature, SyntaxKind.PropertyDeclaration, SyntaxKind.EnumMember,
  SyntaxKind.QualifiedName,
]);

function unwrap(node: N): N {
  let current = node;
  while (
    current &&
    (current.kind === SyntaxKind.ParenthesizedExpression || current.kind === SyntaxKind.NonNullExpression ||
      current.kind === SyntaxKind.AsExpression || current.kind === SyntaxKind.SatisfiesExpression ||
      current.kind === SyntaxKind.TypeAssertionExpression)
  ) {
    current = current.expression;
  }
  return current;
}

function isIdentifier(node: N, name?: string): boolean {
  return node?.kind === SyntaxKind.Identifier && (name === undefined || node.text === name);
}

function isStringish(node: N): boolean {
  const n = unwrap(node);
  return n?.kind === SyntaxKind.StringLiteral || n?.kind === SyntaxKind.NoSubstitutionTemplateLiteral || n?.kind === SyntaxKind.TemplateExpression;
}

function elementsOf(array: N): N[] {
  return array ? Array.from(array as Iterable<N>) : [];
}

class FileScan {
  readonly violations: Violation[] = [];
  private readonly namespaces = new Map<string, string>(); // local name -> module ("node:fs" | "node:net")

  private readonly importCounts = new Map<string, number>(); // restricted module -> import declarations seen

  private current: N;

  /** `import { HostService } from ".../host/host.js"`, unaliased, as a value. */
  private hostServiceImported = false;

  constructor(private readonly relative: string, private readonly sourceText: string, private readonly pure = false) {}

  private add(rule: string, text: string): void {
    const pos: number = this.current?.pos ?? 0;
    const line = this.sourceText.slice(0, pos).split("\n").length;
    this.violations.push({ file: this.relative, rule, text: `${text} (line ${line})` });
  }

  run(source: SourceFile): void {
    this.collectBindings(source as N);
    this.visit(source as N);
  }

  /** First pass: the local names that stand for the fs and net module objects. */
  private collectBindings(root: N): void {
    for (const statement of elementsOf(root.statements)) {
      if (statement.kind !== SyntaxKind.ImportDeclaration) continue;
      const specifier = statement.moduleSpecifier;
      const clause = statement.importClause;
      if (specifier?.kind !== SyntaxKind.StringLiteral || !clause || clause.isTypeOnly) continue;
      const module = specifier.text as string;
      if (this.targetOf(module) === "host/host" && !clause.isTypeOnly && clause.namedBindings?.kind === SyntaxKind.NamedImports &&
        elementsOf(clause.namedBindings.elements).some((element: N) => !element.isTypeOnly && !element.propertyName && element.name.text === "HostService")) this.hostServiceImported = true;
      if (!NAMESPACE_ONLY_MODULES.has(module)) continue;
      if (clause.name) this.namespaces.set(clause.name.text, module);
      if (clause.namedBindings?.kind === SyntaxKind.NamespaceImport) this.namespaces.set(clause.namedBindings.name.text, module);
    }
  }

  private moduleOf(node: N): string | undefined {
    const n = unwrap(node);
    return isIdentifier(n) ? this.namespaces.get(n.text) : undefined;
  }

  private visit(node: N): void {
    this.current = node;
    switch (node.kind) {
      case SyntaxKind.ImportDeclaration: this.importDeclaration(node); break;
      case SyntaxKind.ExportDeclaration:
        if (node.moduleSpecifier) {
          const specifier = this.checkSpecifier(node.moduleSpecifier, true);
          if (specifier !== undefined) this.checkRunnerImport(node, specifier);
          if (specifier === CHILD_PROCESS && this.isOwnerOfChildProcess()) this.add("re-export of child_process", specifier);
          if (specifier === WORKER_THREADS && !node.isTypeOnly) this.add(WORKER_IMPORT_RULE, "export from worker_threads");
        }
        break;
      case SyntaxKind.ImportEqualsDeclaration: this.add("import = require", "import x = require()"); break;
      case SyntaxKind.CallExpression: this.callExpression(node); break;
      case SyntaxKind.NewExpression: this.newExpression(node); break;
      case SyntaxKind.PropertyAccessExpression: this.propertyAccess(node); break;
      case SyntaxKind.BindingElement: this.bindingElement(node); break;
      case SyntaxKind.PropertyAssignment: case SyntaxKind.ShorthandPropertyAssignment: this.assignmentPatternMember(node); break;
      case SyntaxKind.ElementAccessExpression: this.elementAccess(node); break;
      case SyntaxKind.Identifier: this.identifier(node); break;
      default:
        if (STRING_LITERAL_KINDS.has(node.kind)) this.stringLiteral(node);
        break;
    }
    node.forEachChild((child: Node) => { this.visit(child); });
  }

  // ------------------------------------------------------------ imports

  private checkSpecifier(specifierNode: N, isExport = false): string | undefined {
    if (specifierNode.kind !== SyntaxKind.StringLiteral) {
      this.add("non-literal module specifier", "import/export from a computed specifier");
      return undefined;
    }
    const specifier: string = specifierNode.text;
    if (specifier.startsWith("./") || specifier.startsWith("../")) return specifier;
    if (this.pure) {
      // Pure code (the loudness engine that ships inside the server) imports its own files only; the worker entry also gets parentPort.
      if (!(specifier === WORKER_THREADS && this.relative === WORKER_ENTRY)) this.add("node module or package not allowed in the pure loudness code", specifier);
    } else if (!specifier.startsWith("node:")) {
      this.add("non-node import", specifier);
    } else if (!ALLOWED_NODE_MODULES.has(specifier)) {
      this.add("node module not on the allowlist", specifier);
    } else if (MODULE_OWNERS[specifier] && !MODULE_OWNERS[specifier]!.includes(this.relative)) {
      this.add("node module used outside its owner", specifier);
    } else if (isExport && NAMESPACE_ONLY_MODULES.has(specifier)) {
      this.add("re-export of fs/net", specifier);
    }
    return specifier;
  }

  /** `createExecRunner()` is allowed in exactly one place: the `??` operand of `runner:` in the first object of `new HostService({...})`. */
  private callIsInWiringPosition(call: N): boolean {
    const up = (node: N): N => { let n = node.parent; while (n?.kind === SyntaxKind.ParenthesizedExpression) n = n.parent; return n; };
    const binary = up(call);
    if (binary?.kind !== SyntaxKind.BinaryExpression || binary.operatorToken.kind !== SyntaxKind.QuestionQuestionToken || unwrap(binary.right) !== call) return false;
    const property = up(binary);
    if (property?.kind !== SyntaxKind.PropertyAssignment || !isIdentifier(property.name, "runner")) return false;
    const literal = property.parent;
    const creation = literal?.kind === SyntaxKind.ObjectLiteralExpression ? literal.parent : undefined;
    return this.hostServiceImported && creation?.kind === SyntaxKind.NewExpression && isIdentifier(creation.expression, "HostService") && unwrap(elementsOf(creation.arguments)[0]) === literal;
  }

  /** `.runner` / `["runner"]`: only host/host.ts reads it freely; tools/index.ts may read the injected one as the left side of `?? createExecRunner()`. */
  private checkRunnerAccess(node: N): void {
    if (this.relative === "host/host.ts") return;
    const parent = node.parent;
    const leftOfNullish = this.relative === "tools/index.ts" && parent?.kind === SyntaxKind.BinaryExpression &&
      parent.operatorToken.kind === SyntaxKind.QuestionQuestionToken && unwrap(parent.left) === node &&
      unwrap(parent.right)?.kind === SyntaxKind.CallExpression && isIdentifier(unwrap(unwrap(parent.right).expression), "createExecRunner");
    if (!leftOfNullish) this.add("runner member access outside its wiring point", "runner");
  }

  /** `({ runner: r } = h)`, `({ runner } = h)`, `for ({ runner } of xs)`: an object literal that is the target of an assignment. */
  private assignmentPatternMember(node: N): void {
    if (this.relative === "host/host.ts") return;
    const name = node.name;
    if (!(name && ((name.kind === SyntaxKind.Identifier && name.text === "runner") || (name.kind === SyntaxKind.StringLiteral && name.text === "runner")))) return;
    const literal = node.parent;
    const holder = literal?.parent;
    const target = (holder?.kind === SyntaxKind.BinaryExpression && holder.operatorToken.kind === SyntaxKind.EqualsToken && unwrap(holder.left) === literal) ||
      ((holder?.kind === SyntaxKind.ForOfStatement || holder?.kind === SyntaxKind.ForInStatement) && holder.initializer === literal);
    if (target) this.add("runner member access outside its wiring point", "runner");
  }

  /** In host/host.ts the private runner may only be assigned `options.runner` in the constructor and called. */
  private checkPrivateRunner(node: N): void {
    const parent = node.parent;
    if (parent?.kind === SyntaxKind.CallExpression && unwrap(parent.expression) === node) return;
    if (parent?.kind === SyntaxKind.BinaryExpression && parent.operatorToken.kind === SyntaxKind.EqualsToken && unwrap(parent.left) === node &&
      parent.parent?.kind === SyntaxKind.ExpressionStatement) {
      const right = unwrap(parent.right);
      let up = parent.parent;
      while (up && up.kind !== SyntaxKind.Constructor && up.kind !== SyntaxKind.ClassDeclaration && up.kind !== SyntaxKind.MethodDeclaration) up = up.parent;
      if (right?.kind === SyntaxKind.PropertyAccessExpression && isIdentifier(right.expression, "options") && isIdentifier(right.name, "runner") && up?.kind === SyntaxKind.Constructor) return;
    }
    this.add("#runner used other than `this.#runner = options.runner` in the constructor or as a callee", "#runner");
  }

  /** HostService may be imported unaliased from host/host.js and used; declaring or importing the name any other way is refused. */
  private checkHostServiceName(node: N): void {
    const parent = node.parent;
    const message = "HostService declared or imported other than as the unaliased import from host/host.js";
    if (parent?.kind === SyntaxKind.ImportSpecifier) {
      if (parent.propertyName === node) return; // `{ HostService as Other }`: the exported name, nothing is declared
      const declaration = parent.parent?.parent?.parent;
      const fromHost = declaration?.moduleSpecifier?.kind === SyntaxKind.StringLiteral && this.targetOf(declaration.moduleSpecifier.text) === "host/host";
      if (parent.propertyName || !fromHost) this.add(message, "HostService");
      return;
    }
    const declares = new Set<number>([
      SyntaxKind.ClassDeclaration, SyntaxKind.ClassExpression, SyntaxKind.FunctionDeclaration, SyntaxKind.FunctionExpression, SyntaxKind.VariableDeclaration,
      SyntaxKind.Parameter, SyntaxKind.BindingElement, SyntaxKind.InterfaceDeclaration, SyntaxKind.TypeAliasDeclaration, SyntaxKind.EnumDeclaration,
      SyntaxKind.ModuleDeclaration, SyntaxKind.ImportClause, SyntaxKind.NamespaceImport, SyntaxKind.ImportEqualsDeclaration,
    ]);
    if (parent && declares.has(parent.kind) && parent.name === node) this.add(message, "HostService");
  }

  private bindingElement(node: N): void {
    if (this.relative === "host/host.ts") return;
    const named = (n: N): boolean => n && ((n.kind === SyntaxKind.Identifier && n.text === "runner") || (n.kind === SyntaxKind.StringLiteral && n.text === "runner"));
    if (named(node.name) || named(node.propertyName)) this.add("runner member access outside its wiring point", "runner");
  }

  private isOwnerOfChildProcess(): boolean {
    return this.relative === CHILD_PROCESS_OWNER;
  }

  /** In the owner file: `import { execFile } from "node:child_process"` (optionally `import type`), nothing else. */
  private checkChildProcessImport(node: N): void {
    const clause = node.importClause;
    if (!clause || clause.isTypeOnly) return;
    const bindings = clause.namedBindings;
    const elements = bindings?.kind === SyntaxKind.NamedImports ? elementsOf(bindings.elements) : [];
    const plain = !clause.name && elements.length === 1 && !elements[0].propertyName && elements[0].name.text === "execFile" && !elements[0].isTypeOnly;
    const typesOnly = !clause.name && bindings?.kind === SyntaxKind.NamedImports && elements.every((element: N) => element.isTypeOnly);
    if (!plain && !typesOnly) this.add("child_process import other than a plain execFile", `${CHILD_PROCESS}: ${clause.name ? "default " : ""}${elements.map((e: N) => e.name.text).join(", ")}`);
  }

  /** The module a relative specifier points at, without extension, relative to src (e.g. "host/runner"). */
  private targetOf(specifier: string): string | undefined {
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) return undefined;
    return path.posix.normalize(path.posix.join(path.posix.dirname(this.relative), specifier)).replace(/\.(js|ts)$/, "");
  }

  /** A value import (or re-export) of the runner module: only the two wiring files, only the permitted names, no aliases. */
  private checkRunnerImport(node: N, specifier: string): void {
    if (this.targetOf(specifier) !== RUNNER_MODULE || this.relative === `${RUNNER_MODULE}.ts`) return;
    if (node.kind === SyntaxKind.ExportDeclaration) {
      if (!node.isTypeOnly) this.add("host runner imported outside its wiring points", `export from ${specifier}`);
      return;
    }
    const clause = node.importClause;
    if (clause?.isTypeOnly) return;
    const bindings = clause?.namedBindings;
    const elements = bindings?.kind === SyntaxKind.NamedImports ? elementsOf(bindings.elements) : [];
    const valueElements = elements.filter((element: N) => !element.isTypeOnly);
    const hasValue = !clause || clause.name !== undefined || bindings?.kind === SyntaxKind.NamespaceImport || valueElements.length > 0;
    if (!hasValue) return;
    const permitted = RUNNER_IMPORTERS[this.relative];
    if (permitted === undefined) {
      this.add("host runner imported outside its wiring points", specifier);
      return;
    }
    const plain = clause && !clause.name && bindings?.kind === SyntaxKind.NamedImports && valueElements.every((element: N) => !element.propertyName && permitted.includes(element.name.text));
    if (!plain) this.add("host runner import other than the permitted names", `${specifier}: ${permitted.join(", ")} only, unaliased`);
  }

  private importDeclaration(node: N): void {
    const specifier = this.checkSpecifier(node.moduleSpecifier);
    if (specifier !== undefined) this.checkRunnerImport(node, specifier);
    if (specifier === CHILD_PROCESS && this.isOwnerOfChildProcess()) {
      if (!node.importClause) this.add("child_process import other than a plain execFile", `import "${CHILD_PROCESS}"`);
      else this.checkChildProcessImport(node);
    }
    if (specifier === WORKER_THREADS) this.checkWorkerImport(node);
    const clause = node.importClause;
    if (!specifier || !clause || clause.isTypeOnly || !NAMESPACE_ONLY_MODULES.has(specifier)) return;
    // One import declaration per restricted module, with one binding, so every alias is the one the scanner tracks.
    const seen = (this.importCounts.get(specifier) ?? 0) + 1;
    this.importCounts.set(specifier, seen);
    if (seen > 1 || (clause.name && clause.namedBindings)) this.add("more than one import or binding of a restricted module", specifier);
    if (clause.namedBindings?.kind === SyntaxKind.NamedImports) {
      for (const element of elementsOf(clause.namedBindings.elements)) {
        if (!element.isTypeOnly) this.add("named value import from fs/net", `${specifier}: ${element.name.text}`);
      }
    }
  }

  // ------------------------------------------------------------ worker threads

  /** `import { Worker } from "node:worker_threads"` in the analysis module, `import { parentPort }` in the worker entry; types are free. */
  private checkWorkerImport(node: N): void {
    const clause = node.importClause;
    if (clause?.isTypeOnly) return;
    const wanted = this.relative === WORKER_ENTRY ? "parentPort" : "Worker";
    const bindings = clause?.namedBindings;
    const elements = bindings?.kind === SyntaxKind.NamedImports ? elementsOf(bindings.elements) : [];
    const plain = clause && !clause.name && bindings?.kind === SyntaxKind.NamedImports &&
      elements.filter((element: N) => !element.isTypeOnly).every((element: N) => !element.propertyName && element.name.text === wanted);
    if (!plain) this.add(WORKER_IMPORT_RULE, `${WORKER_THREADS}: ${wanted} only, unaliased`);
  }

  private newExpression(node: N): void {
    const callee = unwrap(node.expression);
    if (!isIdentifier(callee, "Worker") || !this.workerChecked()) return;
    if (this.pure || !this.isCanonicalWorker(node)) this.add(WORKER_RULE, "new Worker");
  }

  private workerChecked(): boolean {
    return this.pure || this.relative === WORKER_OWNER;
  }

  /** new Worker(new URL("<fixed file>", import.meta.url), { resourceLimits[: id], env: {}, name: "literal" }) */
  private isCanonicalWorker(node: N): boolean {
    const args = elementsOf(node.arguments);
    if (args.length !== 2) return false;
    const url = unwrap(args[0]);
    const urlArgs = url?.kind === SyntaxKind.NewExpression ? elementsOf(url.arguments) : [];
    const first = urlArgs.length === 2 ? urlArgs[0] : undefined;
    const base = urlArgs.length === 2 ? unwrap(urlArgs[1]) : undefined;
    const urlOk = url?.kind === SyntaxKind.NewExpression && isIdentifier(unwrap(url.expression), "URL") && first?.kind === SyntaxKind.StringLiteral && first.text === WORKER_FILE_URL &&
      base?.kind === SyntaxKind.PropertyAccessExpression && base.expression?.kind === SyntaxKind.MetaProperty && isIdentifier(base.name, "url");
    if (!urlOk) return false;
    const options = unwrap(args[1]);
    if (options?.kind !== SyntaxKind.ObjectLiteralExpression) return false;
    return elementsOf(options.properties).every((property: N) => {
      const name: string | undefined = property.name?.kind === SyntaxKind.Identifier ? property.name.text : undefined;
      if (name === undefined || !WORKER_OPTION_KEYS.has(name)) return false;
      if (property.kind === SyntaxKind.ShorthandPropertyAssignment) return name === "resourceLimits";
      if (property.kind !== SyntaxKind.PropertyAssignment) return false;
      const value = unwrap(property.initializer);
      if (name === "env") return value?.kind === SyntaxKind.ObjectLiteralExpression && elementsOf(value.properties).length === 0;
      if (name === "name") return value?.kind === SyntaxKind.StringLiteral;
      return isIdentifier(value);
    });
  }

  /** `Worker` as a value outside `new Worker(...)`: aliasing, storing, passing or calling it. Types and import specifiers are fine. */
  private checkWorkerName(node: N): void {
    const parent = node.parent;
    if (parent?.kind === SyntaxKind.ImportSpecifier || parent?.kind === SyntaxKind.TypeReference) return;
    if (parent?.kind === SyntaxKind.NewExpression && unwrap(parent.expression) === node) return;
    if (parent && NAME_POSITION_PARENTS.has(parent.kind) && (parent.name === node || parent.right === node)) return;
    this.add(WORKER_RULE, "Worker used other than new Worker(...)");
  }

  // ------------------------------------------------------------ calls

  private callExpression(node: N): void {
    const callee = unwrap(node.expression);
    const args = elementsOf(node.arguments);
    if (callee.kind === SyntaxKind.ImportKeyword) this.add("dynamic import", "import()");
    if (isIdentifier(callee) && TIMER_FUNCTIONS.has(callee.text) && args.length > 0 && isStringish(args[0])) {
      this.add("string passed to a timer", callee.text);
    }
    if (this.isOwnerOfChildProcess() && isIdentifier(callee, "execFile")) this.checkExecFileCall(args);
    if (callee.kind !== SyntaxKind.PropertyAccessExpression) return;
    const module = this.moduleOf(callee.expression);
    const member: string = callee.name.text;
    if (module === "node:net" && member === "createConnection") this.checkNetConnect(args);
    if (module === "node:fs" && member === "openSync") this.checkOpenFlags(args[1]);
  }

  /** execFile(binary, argv, { literal options without spread }, callback): the program is the `binary` parameter and the options cannot be swapped for a variable. */
  private checkExecFileCall(args: N[]): void {
    const options = args.length === 4 ? unwrap(args[2]) : undefined;
    const optionArgs = options?.kind === SyntaxKind.CallExpression ? elementsOf(options.arguments) : [];
    // either a literal without spread, or the one place that builds the options: execOptionsFor(options)
    const literal = (options?.kind === SyntaxKind.ObjectLiteralExpression && !elementsOf(options.properties).some((p: N) => p.kind === SyntaxKind.SpreadAssignment)) ||
      (options?.kind === SyntaxKind.CallExpression && isIdentifier(unwrap(options.expression), "execOptionsFor") && optionArgs.length === 1 && optionArgs[0].kind !== SyntaxKind.SpreadElement);
    if (!(args.length === 4 && isIdentifier(unwrap(args[0]), "binary") && literal)) {
      this.add("execFile call other than execFile(binary, argv, { literal options }, callback)", "execFile");
    }
  }

  /** The only socket this server may create: `net.createConnection({ path: this.sockPath })`. */
  private checkNetConnect(args: N[]): void {
    const options = args.length === 1 ? unwrap(args[0]) : undefined;
    const props = options?.kind === SyntaxKind.ObjectLiteralExpression ? elementsOf(options.properties) : undefined;
    const only = props?.length === 1 ? props[0] : undefined;
    const value = only?.kind === SyntaxKind.PropertyAssignment ? unwrap(only.initializer) : undefined;
    const ok = isIdentifier(only?.name, "path") && value?.kind === SyntaxKind.PropertyAccessExpression &&
      value.expression.kind === SyntaxKind.ThisKeyword && isIdentifier(value.name, "sockPath");
    if (!ok) this.add("net connection other than createConnection({ path: this.sockPath })", "net.createConnection");
  }

  /** `fs.openSync` may only open read-only: no flags argument, "r", 0, or O_RDONLY-style constants. */
  private checkOpenFlags(flags: N | undefined): void {
    if (flags === undefined) return;
    const allowed = (node: N): boolean => {
      const n = unwrap(node);
      if (n.kind === SyntaxKind.StringLiteral) return n.text === "r";
      if (n.kind === SyntaxKind.NumericLiteral) return n.text === "0";
      if (n.kind === SyntaxKind.BinaryExpression) return n.operatorToken.kind === SyntaxKind.BarToken && allowed(n.left) && allowed(n.right);
      if (n.kind === SyntaxKind.PropertyAccessExpression) {
        const base = unwrap(n.expression);
        return base.kind === SyntaxKind.PropertyAccessExpression && this.moduleOf(base.expression) === "node:fs" &&
          base.name.text === "constants" && (FS_READ_FLAGS.has(n.name.text) || this.relative === LAST_APP_OWNER && FS_LAST_APP_FLAGS.has(n.name.text));
      }
      return false;
    };
    if (!allowed(flags)) this.add("fs.openSync with flags that are not provably read-only", "fs.openSync");
  }

  // ------------------------------------------------------------ member access

  private propertyAccess(node: N): void {
    const base = unwrap(node.expression);
    const name: string = node.name.text;
    if (name === "runner") this.checkRunnerAccess(node);
    if (node.name.kind === SyntaxKind.PrivateIdentifier && name === "#runner") this.checkPrivateRunner(node);
    if (isIdentifier(base, "process")) this.processMember(name);
    const module = this.moduleOf(base);
    if (module === "node:fs") {
      if (name === "constants") return;
      if (!FS_READ_CALLS.has(name) && !(this.relative === LAST_APP_OWNER && FS_LAST_APP_CALLS.has(name))) this.add("fs API outside the read-only allowlist", `fs.${name}`);
      else if (!(node.parent.kind === SyntaxKind.CallExpression && unwrap(node.parent.expression) === node)) {
        this.add("fs function used without being called directly", `fs.${name}`);
      }
    } else if (module === "node:net") {
      if (name !== "createConnection") this.add("net API outside createConnection", `net.${name}`);
      else if (!(node.parent.kind === SyntaxKind.CallExpression && unwrap(node.parent.expression) === node)) {
        this.add("net.createConnection used without being called directly", "net.createConnection");
      }
    } else if (base.kind === SyntaxKind.PropertyAccessExpression && this.moduleOf(base.expression) === "node:fs" && base.name.text === "constants") {
      if (!FS_READ_FLAGS.has(name) && !(this.relative === LAST_APP_OWNER && FS_LAST_APP_FLAGS.has(name))) this.add("fs.constants flag that allows writing", `fs.constants.${name}`);
    }
  }

  private processMember(name: string): void {
    if (PROCESS_MEMBERS_EVERYWHERE.has(name)) return;
    if (PROCESS_MEMBERS[this.relative]?.includes(name)) return;
    this.add("process member not allowed in this module", `process.${name}`);
  }

  private elementAccess(node: N): void {
    const base = unwrap(node.expression);
    const key = unwrap(node.argumentExpression);
    if ((key.kind === SyntaxKind.StringLiteral || key.kind === SyntaxKind.NoSubstitutionTemplateLiteral) && key.text === "runner") this.checkRunnerAccess(node);
    if ((isIdentifier(base) && COMPUTED_FORBIDDEN_BASES.has(base.text)) || this.moduleOf(base) !== undefined) {
      this.add("computed member access on a sensitive object", `${isIdentifier(base) ? base.text : "?"}[...]`);
    }
    const argument = unwrap(node.argumentExpression);
    // Only literal keys: a key held in a variable could be "constructor" however it was assembled.
    // Loop over Object.entries()/for-of, or use .at(n) for arrays, instead of indexing by a variable.
    const literalKey = argument.kind === SyntaxKind.StringLiteral || argument.kind === SyntaxKind.NumericLiteral || argument.kind === SyntaxKind.NoSubstitutionTemplateLiteral;
    if (!literalKey && !this.pure) this.add("computed member access with a non-literal key", "[...]");
    const built =
      argument.kind === SyntaxKind.TemplateExpression ||
      (argument.kind === SyntaxKind.BinaryExpression && argument.operatorToken.kind === SyntaxKind.PlusToken && (isStringish(argument.left) || isStringish(argument.right))) ||
      (argument.kind === SyntaxKind.CallExpression && unwrap(argument.expression).kind === SyntaxKind.PropertyAccessExpression && STRING_BUILDERS.has(unwrap(argument.expression).name.text));
    if (built) this.add("member name built from strings", "[...]");
  }

  // ------------------------------------------------------------ identifiers

  private stringLiteral(node: N): void {
    const text: string = node.text ?? "";
    if (text === "runner" && this.relative !== "host/host.ts") this.add("runner member access outside its wiring point", '"runner"');
    if (this.isOwnerOfChildProcess() && text === "shell") this.add("shell option in the child_process module", '"shell"');
    for (const banned of BANNED_MEMBERS) {
      if (text.includes(banned)) this.add("constructor/prototype access", `string containing "${banned}"`);
    }
  }

  private identifier(node: N): void {
    const parent = node.parent;
    if (node.text === "Worker" && this.workerChecked()) this.checkWorkerName(node);
    if (node.text === "HostService" && this.relative !== "host/host.ts") this.checkHostServiceName(node);
    if (node.text === "createExecRunner" && this.relative !== CHILD_PROCESS_OWNER && parent && parent.kind !== SyntaxKind.ImportSpecifier) {
      const called = parent.kind === SyntaxKind.CallExpression && unwrap(parent.expression) === node && elementsOf(parent.arguments).length === 0;
      if (!called) this.add("createExecRunner used other than createExecRunner()", "createExecRunner");
      else if (!this.callIsInWiringPosition(parent)) this.add("createExecRunner() outside `runner: <deps>.runner ?? createExecRunner()` in new HostService({...})", "createExecRunner");
    }
    if (this.isOwnerOfChildProcess()) {
      // Checked before the name-position exemption: `{ shell: true }` and `{ shell }` are both names.
      if (node.text === "shell") this.add("shell option in the child_process module", "shell");
      if (EXEC_FAMILY.has(node.text)) this.add("child_process API other than execFile", node.text);
      if (node.text === "execFile" && parent && parent.kind !== SyntaxKind.ImportSpecifier && !(parent.kind === SyntaxKind.CallExpression && unwrap(parent.expression) === node)) {
        this.add("execFile used without being called directly", "execFile");
      }
    }
    // Checked before the name-position exemption: `{ constructor: F } = fn` and `x.getPrototypeOf` are both ways in.
    if (BANNED_MEMBERS.includes(node.text)) this.add("constructor/prototype access", node.text);
    if (BANNED_REFLECTION.has(node.text)) this.add("prototype or descriptor API", node.text);
    if (parent && NAME_POSITION_PARENTS.has(parent.kind) && (parent.name === node || parent.right === node)) return;
    if (parent && (parent.kind === SyntaxKind.ImportClause || parent.kind === SyntaxKind.NamespaceImport || parent.kind === SyntaxKind.ImportSpecifier)) return;
    const name: string = node.text;
    if (BANNED_IDENTIFIERS.has(name)) {
      this.add("banned global", name);
      return;
    }
    const sensitive = name === "process" || this.namespaces.has(name);
    if (!sensitive) return;
    const usedAsObject = parent?.kind === SyntaxKind.PropertyAccessExpression && parent.expression === node;
    const usedAsElement = parent?.kind === SyntaxKind.ElementAccessExpression && parent.expression === node; // reported by elementAccess
    const inTypePosition = parent?.kind === SyntaxKind.QualifiedName || parent?.kind === SyntaxKind.TypeQuery;
    if (!usedAsObject && !usedAsElement && !inTypePosition) this.add("bare reference to a sensitive object", name);
  }
}

/** Parse the entries with the compiler and apply the policy to each. */
export function scanEntries(entries: SourceEntry[], options: { pure?: boolean } = {}): Violation[] {
  const dir = fs.mkdtempSync("/tmp/bm-ast-");
  let api: API | undefined;
  try {
    fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({
      compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", noEmit: true, types: [], skipLibCheck: true },
      include: ["*.ts"],
    }));
    const files = entries.map((entry, index) => {
      const file = path.join(dir, `s${index}.ts`);
      fs.writeFileSync(file, entry.text);
      return file;
    });
    api = new API({ cwd: dir });
    const snapshot = api.updateSnapshot({ openProject: path.join(dir, "tsconfig.json") });
    const project = snapshot.getProjects()[0];
    if (!project) throw new Error("the TypeScript API did not open the scratch project");
    const violations: Violation[] = [];
    entries.forEach((entry, index) => {
      const source = project.program.getSourceFile(files[index] as string);
      if (!source) throw new Error(`the TypeScript API did not parse ${entry.relative}`);
      const scan = new FileScan(entry.relative, entry.text, options.pure === true);
      scan.run(source);
      violations.push(...scan.violations);
    });
    return violations;
  } finally {
    api?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
