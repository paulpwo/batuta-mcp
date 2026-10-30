/** Typed errors of the Remote Script client (docs/01-protocol.md section 4 plus local conditions). */

export const WIRE_ERROR_CODES = [
  "bad_request", "unknown_command", "invalid_args", "not_found", "out_of_range", "edition_limit", "lom_error",
  "timeout", "busy", "auth_failed", "too_large", "rate_limited", "not_supported", "cleanup_failed",
] as const;

export type WireErrorCode = (typeof WIRE_ERROR_CODES)[number];

/** Conditions that only exist on the client side of the socket. */
export type LocalErrorCode =
  | "not_connected" | "connection_lost" | "closed" | "cancelled"
  | "protocol_mismatch" | "script_too_old" | "runtime_files" | "bad_response";

export type LiveErrorCode = WireErrorCode | LocalErrorCode;

const WIRE_CODES = new Set<string>(WIRE_ERROR_CODES);
const RETRYABLE = new Set<LiveErrorCode>(["busy", "rate_limited", "not_connected"]);
const MAX_MESSAGE_CHARS = 300;

export interface LiveErrorOptions {
  details?: Record<string, unknown>;
  retryable?: boolean;
  /** True when the command may or may not have run (section 5.4): re-read state before retrying. */
  outcomeUnknown?: boolean;
}

export class LiveError extends Error {
  readonly code: LiveErrorCode;
  readonly details: Record<string, unknown> | undefined;
  readonly retryable: boolean;
  readonly outcomeUnknown: boolean;

  constructor(code: LiveErrorCode, message: string, options: LiveErrorOptions = {}) {
    super(message.length > MAX_MESSAGE_CHARS ? `${message.slice(0, MAX_MESSAGE_CHARS)}...` : message);
    this.name = "LiveError";
    this.code = code;
    this.details = options.details;
    this.retryable = options.retryable ?? RETRYABLE.has(code);
    this.outcomeUnknown = options.outcomeUnknown ?? false;
  }

  /** Build an error from the `error` object of a failure response or connection-level error frame. */
  static fromWire(wire: unknown): LiveError {
    const raw = typeof wire === "object" && wire !== null ? (wire as Record<string, unknown>) : {};
    const message = typeof raw["message"] === "string" ? raw["message"] : "Remote Script reported an error";
    const details = typeof raw["details"] === "object" && raw["details"] !== null && !Array.isArray(raw["details"])
      ? (raw["details"] as Record<string, unknown>)
      : undefined;
    const code = typeof raw["code"] === "string" ? raw["code"] : "";
    if (!WIRE_CODES.has(code)) {
      return new LiveError("bad_response", `Remote Script sent an unknown error code: ${message}`, {
        details: { wire_code: code.slice(0, 64) },
      });
    }
    // A script-side timeout does not prove the command did not run (it may have been executing).
    return new LiveError(code as WireErrorCode, message, {
      ...(details === undefined ? {} : { details }),
      outcomeUnknown: code === "timeout",
    });
  }

  toJSON(): { code: string; message: string; details?: Record<string, unknown> } {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}
