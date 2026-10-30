import { JsonParseError, parseStrictJson } from "../util/strictjson.js";

/** Length-prefixed JSON framing of the Remote Script socket (docs/01-protocol.md section 3.1). */

export const MAX_FRAME_BYTES = 1_048_576;
const HEADER_BYTES = 4;
const MAX_FRAME_JSON_DEPTH = 32;

/** Caps the Remote Script enforces on every inbound frame (jsonframes.py, Appendix A). */
const SCRIPT_MAX_STRING_BYTES = 4096;
const SCRIPT_MAX_ARRAY_ITEMS = 10_000;
const SCRIPT_MAX_OBJECT_KEYS = 256;
const SCRIPT_MAX_SAFE_INTEGER = 2 ** 53;

export class FrameError extends Error {
  constructor(readonly code: "too_large" | "bad_request", message: string) {
    super(message);
    this.name = "FrameError";
  }
}

/** Serialize one object into a frame. Rejects non-finite numbers and bodies over `maxBytes`. */
export function encodeFrame(obj: unknown, maxBytes = MAX_FRAME_BYTES): Buffer {
  let text: string | undefined;
  try {
    text = JSON.stringify(obj, (_key, value: unknown) => {
      if (typeof value === "number" && !Number.isFinite(value)) throw new RangeError("non-finite number");
      return value;
    });
  } catch (error) {
    throw new FrameError("bad_request", `value cannot be sent as JSON: ${(error as Error).message}`);
  }
  if (text === undefined) throw new FrameError("bad_request", "value cannot be sent as JSON");
  const body = Buffer.from(text, "utf8");
  if (body.length > maxBytes) throw new FrameError("too_large", `frame body is ${body.length} bytes; the limit is ${maxBytes}`);
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

function shapeError(message: string): FrameError {
  return new FrameError("bad_request", message);
}

/**
 * Check a value against exactly the caps the Remote Script applies to inbound frames: depth 32
 * (the top-level object counts), arrays 10 000 items, objects 256 keys, strings and keys 4096 UTF-8
 * bytes, and no integer beyond +/- 2^53. The script answers a violation with an id-less
 * `bad_request`, which cannot be matched to a call, so the client refuses such frames before sending.
 *
 * Integer-valued numbers count as integers even when they are floats in JavaScript: `1e20` is
 * written as `100000000000000000000`, which the script's JSON parser reads as an integer.
 */
export function assertScriptShape(root: unknown): void {
  const todo: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  while (todo.length > 0) {
    const { value, depth } = todo.pop() as { value: unknown; depth: number };
    if (typeof value === "string") {
      if (Buffer.byteLength(value) > SCRIPT_MAX_STRING_BYTES) throw shapeError(`a string is longer than ${SCRIPT_MAX_STRING_BYTES} bytes`);
    } else if (typeof value === "number") {
      if (Number.isInteger(value) && Math.abs(value) > SCRIPT_MAX_SAFE_INTEGER) throw shapeError("an integer is beyond +/- 2^53");
    } else if (Array.isArray(value)) {
      if (depth + 1 > MAX_FRAME_JSON_DEPTH) throw shapeError(`nesting is deeper than ${MAX_FRAME_JSON_DEPTH}`);
      if (value.length > SCRIPT_MAX_ARRAY_ITEMS) throw shapeError(`an array has more than ${SCRIPT_MAX_ARRAY_ITEMS} items`);
      for (const item of value) todo.push({ value: item, depth: depth + 1 });
    } else if (typeof value === "object" && value !== null) {
      if (depth + 1 > MAX_FRAME_JSON_DEPTH) throw shapeError(`nesting is deeper than ${MAX_FRAME_JSON_DEPTH}`);
      const entries = Object.entries(value);
      if (entries.length > SCRIPT_MAX_OBJECT_KEYS) throw shapeError(`an object has more than ${SCRIPT_MAX_OBJECT_KEYS} keys`);
      for (const [key, child] of entries) {
        if (Buffer.byteLength(key) > SCRIPT_MAX_STRING_BYTES) throw shapeError(`an object key is longer than ${SCRIPT_MAX_STRING_BYTES} bytes`);
        todo.push({ value: child, depth: depth + 1 });
      }
    }
  }
}

/** Encode a request frame: the size cap first, then the script's shape caps. */
export function encodeRequestFrame(obj: unknown, maxBytes = MAX_FRAME_BYTES): Buffer {
  const frame = encodeFrame(obj, maxBytes);
  assertScriptShape(obj);
  return frame;
}

/** Incremental decoder: feed raw socket bytes, receive complete frame bodies. */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  private need: number | null = null;

  constructor(private readonly maxBytes = MAX_FRAME_BYTES) {}

  /** True while a frame is half received (used for the body timeout). */
  get hasPartial(): boolean {
    return this.buffer.length > 0 || this.need !== null;
  }

  /** Throws {@link FrameError} from the header alone; an oversized body is never buffered. */
  feed(chunk: Buffer): Buffer[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const bodies: Buffer[] = [];
    for (;;) {
      if (this.need === null) {
        if (this.buffer.length < HEADER_BYTES) break;
        const length = this.buffer.readUInt32BE(0);
        if (length === 0) throw new FrameError("bad_request", "empty frame");
        if (length > this.maxBytes) throw new FrameError("too_large", `frame of ${length} bytes exceeds ${this.maxBytes}`);
        this.buffer = this.buffer.subarray(HEADER_BYTES);
        this.need = length;
      }
      if (this.buffer.length < this.need) break;
      bodies.push(Buffer.from(this.buffer.subarray(0, this.need)));
      this.buffer = this.buffer.subarray(this.need);
      this.need = null;
    }
    return bodies;
  }
}

/** Parse a frame body; the top-level value must be a JSON object. */
export function parseFrameBody(body: Buffer): Record<string, unknown> {
  let value: unknown;
  try {
    value = parseStrictJson(body, MAX_FRAME_JSON_DEPTH);
  } catch (error) {
    throw new FrameError("bad_request", (error as JsonParseError).message);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FrameError("bad_request", "frame is not a JSON object");
  }
  return value as Record<string, unknown>;
}
