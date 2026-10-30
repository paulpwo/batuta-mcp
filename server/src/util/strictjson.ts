/**
 * Strict JSON parsing for untrusted input (MCP client lines, Remote Script frames, the config file).
 *
 * JSON.parse alone accepts `1e999` (which becomes Infinity), arbitrarily deep nesting and duplicate
 * object keys (last one wins, which hides a conflicting setting). This wrapper rejects all three,
 * rejects invalid UTF-8, and rejects a leading byte-order mark.
 */

export class JsonParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonParseError";
  }
}

export const DEFAULT_MAX_JSON_DEPTH = 32;

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

interface Container {
  isObject: boolean;
  keys: Set<string>;
  expectKey: boolean;
}

/**
 * One linear scan that (a) counts nesting outside strings, so deep input never reaches the recursive
 * parser, and (b) detects duplicate keys per object.
 */
function scan(text: string, maxDepth: number): void {
  const stack: Container[] = [];
  let i = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === 0x22) {
      // String literal: find the closing quote.
      const start = i;
      i += 1;
      let hasEscape = false;
      while (i < text.length) {
        const c = text.charCodeAt(i);
        if (c === 0x5c) {
          hasEscape = true;
          i += 2;
          continue;
        }
        if (c === 0x22) break;
        i += 1;
      }
      const top = stack.at(-1);
      if (top && top.isObject && top.expectKey) {
        const literal = text.slice(start, i + 1);
        let key = literal.slice(1, -1);
        if (hasEscape) {
          try {
            key = JSON.parse(literal) as string;
          } catch {
            throw new JsonParseError("input is not valid JSON");
          }
        }
        if (top.keys.has(key)) throw new JsonParseError("duplicate object key");
        top.keys.add(key);
        top.expectKey = false;
      }
      i += 1;
      continue;
    }
    if (code === 0x7b || code === 0x5b) {
      stack.push({ isObject: code === 0x7b, keys: new Set(), expectKey: code === 0x7b });
      if (stack.length > maxDepth) throw new JsonParseError(`JSON nesting deeper than ${maxDepth}`);
    } else if (code === 0x7d || code === 0x5d) {
      stack.pop();
    } else if (code === 0x2c) {
      const top = stack.at(-1);
      if (top && top.isObject) top.expectKey = true;
    }
    i += 1;
  }
}

function checkNumbers(root: unknown): void {
  const todo: unknown[] = [root];
  while (todo.length > 0) {
    const node = todo.pop();
    if (typeof node === "number") {
      if (!Number.isFinite(node)) throw new JsonParseError("non-finite number");
    } else if (Array.isArray(node)) {
      for (const child of node) todo.push(child);
    } else if (typeof node === "object" && node !== null) {
      for (const child of Object.values(node)) todo.push(child);
    }
  }
}

export function parseStrictJson(input: Buffer | Uint8Array | string, maxDepth = DEFAULT_MAX_JSON_DEPTH): unknown {
  let text: string;
  if (typeof input === "string") {
    text = input;
  } else {
    try {
      text = decoder.decode(input);
    } catch {
      throw new JsonParseError("input is not valid UTF-8");
    }
  }
  scan(text, maxDepth);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new JsonParseError("input is not valid JSON");
  }
  checkNumbers(value);
  return value;
}
