import { ToolError } from "../mcp/index.js";
import { LiveError } from "../live/index.js";

/**
 * Map a Remote Script client error to the tool error the model sees. After a timeout or a lost
 * connection the outcome of a mutating command is unknown (docs/01-protocol.md section 5.4): the
 * message says so and tells the model to re-read state instead of retrying.
 */
export function liveToToolError(error: LiveError, mutating: boolean): ToolError {
  const details: Record<string, unknown> = { ...(error.details ?? {}) };
  let message = error.message;
  if (error.retryable) details["retryable"] = true;
  if (error.outcomeUnknown && mutating) {
    details["outcome_unknown"] = true;
    details["next"] = "Re-read the current state with the matching read tool before any retry; never repeat the call blindly.";
    message = `${/[.!?]$/.test(message) ? message : `${message}.`} The command may or may not have been applied: re-read the current state before retrying.`;
  }
  return new ToolError(error.code, message, Object.keys(details).length > 0 ? details : undefined);
}

/** Anything thrown while talking to Live becomes a ToolError; unexpected errors are left to the server's internal_error path. */
export function asToolError(error: unknown, mutating: boolean): unknown {
  return error instanceof LiveError ? liveToToolError(error, mutating) : error;
}
