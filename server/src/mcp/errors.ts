/** Errors of the MCP layer. */

/** A JSON-RPC error answer received from the client (or one to send for a request). */
export class McpRpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
    this.name = "McpRpcError";
  }
}

/** A server-to-client request got no answer within its deadline. */
export class McpTimeoutError extends Error {
  constructor(message: string, readonly timeoutMs?: number) {
    super(message);
    this.name = "McpTimeoutError";
  }
}

/** The connection closed (stdin ended) while a server-to-client request was pending. */
export class McpClosedError extends Error {
  constructor(message = "MCP connection closed") {
    super(message);
    this.name = "McpClosedError";
  }
}

/** The tool call that owned a server-to-client request was cancelled. */
export class McpCancelledError extends Error {
  constructor(message = "request cancelled") {
    super(message);
    this.name = "McpCancelledError";
  }
}

/** The client cannot be asked (no form elicitation capability, or session not ready). */
export class ElicitationUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ElicitationUnavailableError";
  }
}

/**
 * Thrown by tool handlers for expected failures. It becomes an `isError` tool result carrying
 * `{code, message, details}`, which the model can read and act on.
 */
export class ToolError extends Error {
  constructor(readonly code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "ToolError";
  }
}
