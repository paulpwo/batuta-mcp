import { ToolError } from "../mcp/index.js";

/** Small helpers shared by the tool modules. Live-sourced and model-sourced text is sanitized before it reaches a summary. */

export type Json = Record<string, unknown>;

export function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asObject(value: unknown): Json {
  return isObject(value) ? value : {};
}

/** Own property by name without computed member access (the static checks forbid indexing by a variable). */
export function field(value: Json, name: string): unknown {
  for (const [key, member] of Object.entries(value)) if (key === name) return member;
  return undefined;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** JSON with keys sorted recursively and no whitespace (docs/01-protocol.md section 9.3). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (isObject(value)) {
    const entries = Object.entries(value)
      .filter(([, member]) => member !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Control, invisible, soft-hyphen, line-separator, direction and tag characters: text that can hide or reorder what a summary says. */
export function isUnsafeCode(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0xad || code === 0x61c || (code >= 0x200b && code <= 0x200f) ||
    code === 0x2028 || code === 0x2029 || (code >= 0x202a && code <= 0x202e) || (code >= 0x2060 && code <= 0x2069) || code === 0xfeff ||
    (code >= 0xe0000 && code <= 0xe007f) || code === 0x34f || code === 0x115f || code === 0x1160 || code === 0x17b4 || code === 0x17b5 ||
    (code >= 0x180b && code <= 0x180f) || code === 0x2800 || code === 0x3164 || (code >= 0xfe00 && code <= 0xfe0f) || code === 0xffa0 ||
    (code >= 0xfff9 && code <= 0xfffb) || (code >= 0x1d173 && code <= 0x1d17a) || (code >= 0xe0100 && code <= 0xe01ef);
}

/** Control, invisible and bidi characters replaced by a space, then cut to `max` characters (default 64, as section 9.3 asks for names). */
export function safeText(value: unknown, max = 64): string {
  const text = [...String(value ?? "")].map((char) => (isUnsafeCode(char.codePointAt(0) ?? 0) ? " " : char)).join("").trim();
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join("")}...` : text;
}

/**
 * A name in a human-readable label: sanitized, shortened and quoted as a JSON string, so a quote or
 * backslash inside the name is escaped and the name cannot close the quote and pass for summary text.
 */
export function quoted(name: unknown): string {
  return JSON.stringify(safeText(name));
}

export function invalidArgs(message: string, details: Json): ToolError {
  return new ToolError("invalid_args", message, details);
}

export function notFound(message: string, details: Json): ToolError {
  return new ToolError("not_found", message, details);
}

export function notSupported(message: string, reason: string, extra: Json = {}): ToolError {
  return new ToolError("not_supported", message, { reason, ...extra });
}
