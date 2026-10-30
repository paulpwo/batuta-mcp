/**
 * Small JSON-Schema-subset validator.
 *
 * One schema language serves two purposes: the same plain-JSON object is published as a tool's
 * `inputSchema` in `tools/list` and is compiled here to validate the arguments of `tools/call`.
 *
 * Supported keywords (anything else is rejected when the schema is compiled, so a typo in a tool
 * definition fails at startup instead of silently disabling a check):
 *   type (string | integer | number | boolean | array | object), enum, const,
 *   minimum, maximum, minLength, maxLength, pattern, properties, required,
 *   additionalProperties (only `false`), items, minItems, maxItems, oneOf,
 *   plus the annotations title, description, default, examples.
 */

export type SchemaType = "string" | "integer" | "number" | "boolean" | "array" | "object";

export interface Schema {
  type?: SchemaType;
  title?: string;
  description?: string;
  default?: unknown;
  examples?: unknown[];
  enum?: unknown[];
  const?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: false;
  items?: Schema;
  minItems?: number;
  maxItems?: number;
  oneOf?: Schema[];
}

/** A tool definition error: thrown while compiling a schema, never while validating a value. */
export class SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaError";
  }
}

export interface Issue {
  /** JSON Pointer to the offending value ("" is the root). */
  path: string;
  keyword: string;
  message: string;
  expected?: unknown;
  actual?: unknown;
  /** For `oneOf`: the issues of every alternative, in order. */
  branches?: Issue[][];
}

export interface CompiledSchema {
  /** Deep-frozen copy of the source schema, safe to publish as `inputSchema`. */
  readonly schema: Schema;
  readonly root: Node;
}

/** Longest schema nesting accepted; bounds recursion at both compile and validate time. */
const MAX_SCHEMA_DEPTH = 16;
/** Patterns are only allowed on strings with an explicit, small cap (bounds regex work). */
const MAX_PATTERN_STRING_LENGTH = 1024;
const MAX_ISSUES_SHOWN = 20;
const MAX_ECHO_CHARS = 64;
/** The walk stops collecting here, so a hostile 200 000-item array costs a bounded amount of work. */
const MAX_ISSUES_COLLECTED = 100;

const ANNOTATIONS = new Set(["title", "description", "default", "examples"]);
const KEYWORDS = new Set([
  ...ANNOTATIONS, "type", "enum", "const", "minimum", "maximum", "minLength", "maxLength",
  "pattern", "properties", "required", "additionalProperties", "items", "minItems", "maxItems", "oneOf",
]);
const TYPES = new Set(["string", "integer", "number", "boolean", "array", "object"]);

interface Node {
  type?: SchemaType;
  enumValues?: unknown[];
  hasConst: boolean;
  constValue?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: RegExp;
  properties?: Map<string, Node>;
  required?: string[];
  items?: Node;
  minItems?: number;
  maxItems?: number;
  oneOf?: Node[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function finiteNumber(where: string, keyword: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new SchemaError(`${where}: ${keyword} must be a finite number`);
  return value;
}

function nonNegativeInteger(where: string, keyword: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new SchemaError(`${where}: ${keyword} must be a non-negative integer`);
  }
  return value;
}

/**
 * Reject shapes that make a regex slow or that defeat the anchors: more than one unbounded
 * quantifier (`^\\d*\\d*\\d*$` backtracks polynomially) and top-level alternation (`^a|b$` anchors
 * only one side of each branch).
 */
function lintPattern(where: string, source: string): void {
  let depth = 0;
  let inClass = false;
  let unbounded = 0;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source.charAt(i);
    if (ch === "\\") {
      i += 1;
    } else if (inClass) {
      if (ch === "]") inClass = false;
    } else if (ch === "[") {
      inClass = true;
    } else if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
    } else if (ch === "|" && depth === 0) {
      throw new SchemaError(`${where}: pattern may not use top-level alternation (it breaks the ^ and $ anchors)`);
    } else if (ch === "*" || ch === "+" || (ch === "{" && /^\{\d+,\}/.test(source.slice(i)))) {
      unbounded += 1;
    }
  }
  if (unbounded > 1) throw new SchemaError(`${where}: pattern may contain at most one unbounded quantifier (*, + or {n,})`);
}

function checkPattern(where: string, source: string, maxLength: number | undefined): RegExp {
  if (!source.startsWith("^") || !source.endsWith("$") || source.endsWith("\\$")) {
    throw new SchemaError(`${where}: pattern must be anchored with ^ and $`);
  }
  // Quantified groups and backreferences are how catastrophic backtracking is built; the schemas
  // of this project never need them.
  if (/\)[*+?{]/.test(source) || /\\[1-9]|\\k</.test(source)) {
    throw new SchemaError(`${where}: pattern may not quantify groups or use backreferences`);
  }
  lintPattern(where, source);
  if (maxLength === undefined || maxLength > MAX_PATTERN_STRING_LENGTH) {
    throw new SchemaError(`${where}: pattern requires maxLength <= ${MAX_PATTERN_STRING_LENGTH}`);
  }
  try {
    return new RegExp(source, "u");
  } catch {
    throw new SchemaError(`${where}: pattern is not a valid regular expression`);
  }
}

function compileNode(raw: unknown, where: string, depth: number): Node {
  if (depth > MAX_SCHEMA_DEPTH) throw new SchemaError(`${where}: schema nested deeper than ${MAX_SCHEMA_DEPTH}`);
  if (!isPlainObject(raw)) throw new SchemaError(`${where}: schema must be an object`);
  for (const key of Object.keys(raw)) {
    if (!KEYWORDS.has(key)) throw new SchemaError(`${where}: unsupported keyword "${key}"`);
  }
  const node: Node = { hasConst: false };
  if (raw["type"] !== undefined) {
    if (typeof raw["type"] !== "string" || !TYPES.has(raw["type"])) throw new SchemaError(`${where}: unsupported type`);
    node.type = raw["type"] as SchemaType;
  }
  if (raw["enum"] !== undefined) {
    if (!Array.isArray(raw["enum"]) || raw["enum"].length === 0) throw new SchemaError(`${where}: enum must be a non-empty array`);
    node.enumValues = raw["enum"] as unknown[];
  }
  if ("const" in raw) {
    node.hasConst = true;
    node.constValue = raw["const"];
  }
  if (raw["minimum"] !== undefined) node.minimum = finiteNumber(where, "minimum", raw["minimum"]);
  if (raw["maximum"] !== undefined) node.maximum = finiteNumber(where, "maximum", raw["maximum"]);
  if (raw["minLength"] !== undefined) node.minLength = nonNegativeInteger(where, "minLength", raw["minLength"]);
  if (raw["maxLength"] !== undefined) node.maxLength = nonNegativeInteger(where, "maxLength", raw["maxLength"]);
  if (raw["minItems"] !== undefined) node.minItems = nonNegativeInteger(where, "minItems", raw["minItems"]);
  if (raw["maxItems"] !== undefined) node.maxItems = nonNegativeInteger(where, "maxItems", raw["maxItems"]);
  if (raw["pattern"] !== undefined) {
    if (typeof raw["pattern"] !== "string") throw new SchemaError(`${where}: pattern must be a string`);
    node.pattern = checkPattern(where, raw["pattern"], node.maxLength);
  }
  if (node.type === "object") {
    if (raw["additionalProperties"] !== false) {
      throw new SchemaError(`${where}: object schemas must declare additionalProperties: false`);
    }
    const props = raw["properties"] ?? {};
    if (!isPlainObject(props)) throw new SchemaError(`${where}: properties must be an object`);
    node.properties = new Map();
    for (const [name, child] of Object.entries(props)) {
      node.properties.set(name, compileNode(child, `${where}/${name}`, depth + 1));
    }
    if (raw["required"] !== undefined) {
      if (!Array.isArray(raw["required"]) || !raw["required"].every((r) => typeof r === "string")) {
        throw new SchemaError(`${where}: required must be an array of strings`);
      }
      for (const name of raw["required"] as string[]) {
        if (!node.properties.has(name)) throw new SchemaError(`${where}: required property "${name}" is not declared`);
      }
      node.required = raw["required"] as string[];
    }
  } else if (raw["properties"] !== undefined || raw["required"] !== undefined || raw["additionalProperties"] !== undefined) {
    throw new SchemaError(`${where}: properties/required/additionalProperties need type "object"`);
  }
  if (node.type === "array") {
    if (raw["items"] === undefined) throw new SchemaError(`${where}: array schemas must declare items`);
    node.items = compileNode(raw["items"], `${where}/items`, depth + 1);
  } else if (raw["items"] !== undefined) {
    throw new SchemaError(`${where}: items needs type "array"`);
  }
  if (raw["oneOf"] !== undefined) {
    if (!Array.isArray(raw["oneOf"]) || raw["oneOf"].length < 2) throw new SchemaError(`${where}: oneOf needs at least two alternatives`);
    node.oneOf = raw["oneOf"].map((branch, i) => compileNode(branch, `${where}/oneOf/${i}`, depth + 1));
  }
  return node;
}

/** Compile a schema; throws {@link SchemaError} for anything outside the supported subset. */
export function compileSchema(schema: Schema): CompiledSchema {
  const root = compileNode(schema, "#", 0);
  return { schema: deepFreeze(deepClone(schema)), root };
}

function codePointLength(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i += 1;
    }
    count += 1;
  }
  return count;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isFinite(value) ? (Number.isInteger(value) ? "integer" : "number") : "non-finite number";
  return typeof value;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.entries(a as object);
  const kb = Object.entries(b as object);
  if (ka.length !== kb.length) return false;
  const other = new Map(Object.entries(b as object));
  return ka.every(([k, v]) => other.has(k) && deepEqual(v, other.get(k)));
}

function escapeSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

function typeMatches(type: SchemaType, value: unknown): boolean {
  switch (type) {
    case "string": return typeof value === "string";
    case "boolean": return typeof value === "boolean";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return typeof value === "number" && Number.isSafeInteger(value);
    case "array": return Array.isArray(value);
    case "object": return isPlainObject(value);
  }
}

function walk(node: Node, value: unknown, path: string, issues: Issue[]): void {
  if (issues.length >= MAX_ISSUES_COLLECTED) return;
  if (node.type !== undefined && !typeMatches(node.type, value)) {
    issues.push({ path, keyword: "type", message: `must be ${node.type} (got ${describe(value)})`, expected: node.type, actual: describe(value) });
    return;
  }
  if (node.hasConst && !deepEqual(node.constValue, value)) {
    issues.push({ path, keyword: "const", message: `must equal ${echo(node.constValue)} (got ${echo(value)})`, expected: node.constValue, actual: value });
  }
  if (node.enumValues && !node.enumValues.some((candidate) => deepEqual(candidate, value))) {
    issues.push({ path, keyword: "enum", message: `must be one of ${node.enumValues.map(echo).join(", ")} (got ${echo(value)})`, expected: node.enumValues, actual: value });
  }
  if (typeof value === "number") {
    if (node.minimum !== undefined && value < node.minimum) {
      issues.push({ path, keyword: "minimum", message: `must be >= ${node.minimum} (got ${value})`, expected: node.minimum, actual: value });
    }
    if (node.maximum !== undefined && value > node.maximum) {
      issues.push({ path, keyword: "maximum", message: `must be <= ${node.maximum} (got ${value})`, expected: node.maximum, actual: value });
    }
  }
  if (typeof value === "string") {
    const length = codePointLength(value);
    if (node.minLength !== undefined && length < node.minLength) {
      issues.push({ path, keyword: "minLength", message: `must have at least ${node.minLength} characters (got ${length})`, expected: node.minLength, actual: length });
    }
    if (node.maxLength !== undefined && length > node.maxLength) {
      issues.push({ path, keyword: "maxLength", message: `must have at most ${node.maxLength} characters (got ${length})`, expected: node.maxLength, actual: length });
    } else if (node.pattern && !node.pattern.test(value)) {
      issues.push({ path, keyword: "pattern", message: `does not match the required format (got ${echo(value)})`, actual: value });
    }
  }
  if (Array.isArray(value)) {
    if (node.minItems !== undefined && value.length < node.minItems) {
      issues.push({ path, keyword: "minItems", message: `must have at least ${node.minItems} items (got ${value.length})`, expected: node.minItems, actual: value.length });
    }
    if (node.maxItems !== undefined && value.length > node.maxItems) {
      issues.push({ path, keyword: "maxItems", message: `must have at most ${node.maxItems} items (got ${value.length})`, expected: node.maxItems, actual: value.length });
    } else if (node.items) {
      for (const [index, item] of value.entries()) {
        if (issues.length >= MAX_ISSUES_COLLECTED) break;
        walk(node.items as Node, item, `${path}/${index}`, issues);
      }
    }
  }
  if (node.properties && isPlainObject(value)) {
    const entries = Object.entries(value);
    for (const name of node.required ?? []) {
      if (!Object.hasOwn(value, name)) {
        issues.push({ path: `${path}/${escapeSegment(name)}`, keyword: "required", message: "required property is missing" });
      }
    }
    for (const [key, member] of entries) {
      if (issues.length >= MAX_ISSUES_COLLECTED) break;
      const child = node.properties.get(key);
      if (child === undefined) {
        issues.push({ path: `${path}/${escapeSegment(key)}`, keyword: "additionalProperties", message: "unknown property" });
      } else {
        walk(child, member, `${path}/${escapeSegment(key)}`, issues);
      }
    }
  }
  if (node.oneOf) {
    const branches: Issue[][] = [];
    let matched = 0;
    for (const branch of node.oneOf) {
      const branchIssues: Issue[] = [];
      walk(branch, value, path, branchIssues);
      if (branchIssues.length === 0) matched += 1;
      branches.push(branchIssues);
    }
    if (matched !== 1) {
      const detail = matched === 0
        ? `; alternatives: ${branches.map((b, i) => `[${i + 1}] ${b[0]?.message ?? "ok"}`).join("; ")}`
        : "";
      issues.push({ path, keyword: "oneOf", message: `must match exactly one alternative (matched ${matched})${detail}`, actual: matched, branches });
    }
  }
}

function echo(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = "<unprintable>";
  }
  return text.length > MAX_ECHO_CHARS ? `${text.slice(0, MAX_ECHO_CHARS)}...` : text;
}

/** Validate a value against a compiled schema; returns every issue found (empty means valid). */
export function validate(compiled: CompiledSchema, value: unknown): Issue[] {
  const issues: Issue[] = [];
  walk(compiled.root, value, "", issues);
  return issues;
}

/** Render issues as short lines for the model: `- /path: message`, at most 20 lines. */
export function formatIssues(issues: Issue[]): string {
  const lines = issues.slice(0, MAX_ISSUES_SHOWN).map((issue) => `- ${issue.path === "" ? "(root)" : issue.path}: ${issue.message}`);
  if (issues.length > MAX_ISSUES_SHOWN) lines.push(`... and ${issues.length - MAX_ISSUES_SHOWN} more issue(s)`);
  return lines.join("\n");
}
