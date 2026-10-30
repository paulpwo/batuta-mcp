import type { Readable, Writable } from "node:stream";
import { createLogger } from "../log.js";
import type { Logger } from "../log.js";
import { formatIssues, validate } from "../validate/index.js";
import type { Issue } from "../validate/index.js";
import { JsonParseError, parseStrictJson } from "../util/strictjson.js";
import {
  ElicitationUnavailableError, McpCancelledError, McpClosedError, McpRpcError, McpTimeoutError, ToolError,
} from "./errors.js";
import { LineSplitter } from "./lines.js";
import type { ElicitFormRequest, ElicitResult, ToolContext, ToolRegistry, ToolResult } from "./registry.js";
import { checkElicitSchema } from "./elicit-schema.js";
import { TOOL_UI_META, UI_RESOURCES, findUiResource, listedResource, resourceContents } from "./resources.js";

/**
 * Minimal MCP server over newline-delimited JSON-RPC 2.0 (stdio transport), with no dependencies.
 *
 * Implements the handshake-based protocol revisions 2025-11-25 and 2025-06-18: initialize,
 * notifications/initialized, ping, tools/list, tools/call, notifications/cancelled, the
 * server-to-client elicitation/create request (form mode) and the MCP Apps `ui://` resources
 * (resources/list, resources/read, resources/templates/list; see resources.ts).
 */

/** Newest first; the first entry is offered when the client asks for a version we do not speak. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ["2025-11-25", "2025-06-18"];

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const RESOURCE_NOT_FOUND = -32002;
const INTERNAL_ERROR = -32603;

export interface McpServerOptions {
  input: Readable;
  output: Writable;
  registry: ToolRegistry;
  serverInfo: { name: string; version: string; title?: string };
  instructions?: string;
  logger?: Logger;
  /** Longest accepted input line in bytes. Default 1 MiB. */
  maxLineBytes?: number;
  /** Largest tool result in serialized bytes. Default 4 MiB. */
  maxOutputBytes?: number;
  /** Tools per `tools/list` page. Default 200: the whole BatutaMCP surface fits in one page. */
  pageSize?: number;
  /** Simultaneous `tools/call` handlers. Default 16 (the Remote Script's in-flight cap). */
  maxConcurrentCalls?: number;
  /** Default deadline for an elicitation answer. Default 120 s. */
  elicitationTimeoutMs?: number;
  /** How long shutdown waits for handlers that ignore their abort signal. Default 2 s. */
  shutdownGraceMs?: number;
}

type RequestId = string | number;

interface Pending {
  resolve(result: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  cleanup(): void;
}

interface InflightCall {
  controller: AbortController;
  cancelled: boolean;
  promise: Promise<void>;
}

interface Session {
  protocolVersion: string;
  clientInfo: { name: string; version: string };
  formElicitation: boolean;
  /** `notifications/initialized` has arrived: the client is ready for server-initiated requests. */
  ready: boolean;
}

const SESSION_METHODS: ReadonlySet<string> = new Set(["tools/list", "tools/call", "resources/list", "resources/templates/list", "resources/read"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is RequestId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function idKey(id: RequestId): string {
  return `${typeof id}:${id}`;
}

function encodeCursor(offset: number): string {
  return Buffer.from(`o:${offset}`).toString("base64url");
}

function decodeCursor(cursor: string): number | undefined {
  if (cursor.length === 0 || cursor.length > 32) return undefined;
  const text = Buffer.from(cursor, "base64url").toString("utf8");
  const match = /^o:(0|[1-9]\d{0,8})$/.exec(text);
  if (!match || encodeCursor(Number(match[1])) !== cursor) return undefined;
  return Number(match[1]);
}

function truncate(text: string, max = 64): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

const MAX_DETAILS_CHARS = 500;
const MAX_SCALAR_CHARS = 120;

function detailsLine(details: Record<string, unknown> | undefined): string | undefined {
  if (details === undefined || Object.keys(details).length === 0) return undefined;
  let line = JSON.stringify({ details });
  if (line.length > MAX_DETAILS_CHARS) {
    const small = Object.fromEntries(Object.entries(details).filter(([, value]) => (typeof value === "string" ? value.length <= MAX_SCALAR_CHARS : typeof value === "number" || typeof value === "boolean" || value === null)));
    if (Object.keys(small).length === 0) return undefined;
    line = JSON.stringify({ details: small });
    if (line.length > MAX_DETAILS_CHARS) line = `${line.slice(0, MAX_DETAILS_CHARS - 3)}...`;
  }
  return line;
}

export class McpServer {
  private readonly logger: Logger;
  private readonly maxOutputBytes: number;
  private readonly pageSize: number;
  private readonly maxConcurrentCalls: number;
  private readonly elicitationTimeoutMs: number;
  private readonly shutdownGraceMs: number;
  private readonly inflight = new Map<string, InflightCall>();
  private readonly pending = new Map<number, Pending>();
  private nextServerRequestId = 1;
  private session: Session | undefined;
  private closing = false;
  private resolveFinished!: () => void;
  private readonly finished = new Promise<void>((resolve) => { this.resolveFinished = resolve; });
  private started = false;

  constructor(private readonly options: McpServerOptions) {
    this.logger = options.logger ?? createLogger();
    this.maxOutputBytes = options.maxOutputBytes ?? 4 * 1024 * 1024;
    this.pageSize = options.pageSize ?? 200;
    this.maxConcurrentCalls = options.maxConcurrentCalls ?? 16;
    this.elicitationTimeoutMs = options.elicitationTimeoutMs ?? 120_000;
    this.shutdownGraceMs = options.shutdownGraceMs ?? 2000;
  }

  /** Start reading. Resolves after the input closed (or {@link stop}) and shutdown completed. */
  run(): Promise<void> {
    if (this.started) return this.finished;
    this.started = true;
    const { input, output } = this.options;
    const splitter = new LineSplitter(
      this.options.maxLineBytes ?? 1024 * 1024,
      (line) => this.handleLine(line),
      () => {
        this.logger.warn("input line exceeded the size cap and was discarded");
        this.sendError(null, INVALID_REQUEST, "Request too large");
      },
    );
    input.on("data", (chunk: Buffer | string) => {
      if (this.closing) return;
      splitter.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    input.on("end", () => void this.shutdown("input ended"));
    input.on("close", () => void this.shutdown("input closed"));
    input.on("error", (error) => void this.shutdown(`input error: ${error.message}`));
    output.on("error", (error) => void this.shutdown(`output error: ${error.message}`));
    return this.finished;
  }

  /** Programmatic shutdown, equivalent to the client closing stdin. */
  stop(): Promise<void> {
    return this.shutdown("stop requested");
  }

  // ---------------------------------------------------------------- inbound

  private handleLine(line: Buffer): void {
    let message: unknown;
    try {
      message = parseStrictJson(line);
    } catch (error) {
      this.logger.warn(`unparseable input line: ${(error as JsonParseError).message}`);
      this.sendError(null, PARSE_ERROR, "Parse error");
      return;
    }
    try {
      this.handleMessage(message);
    } catch (error) {
      this.logger.error(`unexpected failure handling a message: ${(error as Error).stack ?? String(error)}`);
      this.sendError(null, INTERNAL_ERROR, "Internal error");
    }
  }

  private handleMessage(message: unknown): void {
    if (!isPlainObject(message)) {
      this.sendError(null, INVALID_REQUEST, Array.isArray(message) ? "Batch requests are not supported" : "Invalid request");
      return;
    }
    const echoId: RequestId | null = isRequestId(message["id"]) ? message["id"] : null;
    if (message["jsonrpc"] !== "2.0") {
      this.sendError(echoId, INVALID_REQUEST, "Invalid request: jsonrpc must be \"2.0\"");
      return;
    }
    if ("method" in message) {
      const method = message["method"];
      if (typeof method !== "string") {
        this.sendError(echoId, INVALID_REQUEST, "Invalid request: method must be a string");
        return;
      }
      if ("id" in message) {
        if (!isRequestId(message["id"])) {
          this.sendError(null, INVALID_REQUEST, "Invalid request: id must be a string or number");
          return;
        }
        this.handleRequest(message["id"], method, message["params"]);
      } else {
        this.handleNotification(method, message["params"]);
      }
      return;
    }
    if ("result" in message || "error" in message) {
      this.handleResponse(message);
      return;
    }
    this.sendError(echoId, INVALID_REQUEST, "Invalid request");
  }

  private handleRequest(id: RequestId, method: string, params: unknown): void {
    if (method === "ping") {
      this.sendResult(id, {});
      return;
    }
    if (method === "initialize") {
      this.handleInitialize(id, params);
      return;
    }
    if (!SESSION_METHODS.has(method)) {
      // Includes the `server/discover` probe of newer clients: not recognized, so they fall back to initialize.
      this.sendError(id, METHOD_NOT_FOUND, `Method not found: ${truncate(method)}`);
      return;
    }
    if (!this.session) {
      this.sendError(id, INVALID_REQUEST, "Server not initialized");
      return;
    }
    switch (method) {
      case "tools/list":
        this.handleToolsList(id, params);
        return;
      case "tools/call":
        this.handleToolsCall(id, params);
        return;
      case "resources/list":
        this.sendResult(id, { resources: UI_RESOURCES.map(listedResource) });
        return;
      case "resources/templates/list":
        this.sendResult(id, { resourceTemplates: [] });
        return;
      case "resources/read":
        this.handleResourcesRead(id, params);
        return;
      default:
        this.sendError(id, METHOD_NOT_FOUND, `Method not found: ${truncate(method)}`);
    }
  }

  private handleInitialize(id: RequestId, params: unknown): void {
    if (this.session) {
      this.sendError(id, INVALID_REQUEST, "Already initialized");
      return;
    }
    const info = isPlainObject(params) ? params["clientInfo"] : undefined;
    if (
      !isPlainObject(params) ||
      typeof params["protocolVersion"] !== "string" ||
      !isPlainObject(params["capabilities"]) ||
      !isPlainObject(info) ||
      typeof info["name"] !== "string" ||
      typeof info["version"] !== "string"
    ) {
      this.sendError(id, INVALID_PARAMS, "Invalid initialize params: protocolVersion, capabilities and clientInfo {name, version} are required");
      return;
    }
    const requested = params["protocolVersion"];
    const negotiated = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : (SUPPORTED_PROTOCOL_VERSIONS[0] as string);
    const elicitation = params["capabilities"]["elicitation"];
    const formElicitation = isPlainObject(elicitation) && (Object.keys(elicitation).length === 0 || isPlainObject(elicitation["form"]));
    this.session = {
      protocolVersion: negotiated,
      clientInfo: { name: truncate(info["name"], 128), version: truncate(info["version"], 128) },
      formElicitation,
      ready: false,
    };
    this.logger.info(`initialized by ${this.session.clientInfo.name} ${this.session.clientInfo.version}, protocol ${negotiated}, elicitation ${formElicitation ? "yes" : "no"}`);
    const result: Record<string, unknown> = {
      protocolVersion: negotiated,
      capabilities: { tools: { listChanged: false }, resources: {} },
      serverInfo: this.options.serverInfo,
    };
    if (this.options.instructions !== undefined) result["instructions"] = this.options.instructions;
    this.sendResult(id, result);
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === "notifications/initialized") {
      if (this.session) this.session.ready = true;
      return;
    }
    if (method === "notifications/cancelled") {
      if (!this.session || !isPlainObject(params) || !isRequestId(params["requestId"])) return;
      const call = this.inflight.get(idKey(params["requestId"]));
      if (call && !call.cancelled) {
        call.cancelled = true;
        call.controller.abort(new McpCancelledError());
      }
      return;
    }
    this.logger.debug(`ignored notification ${truncate(method)}`);
  }

  private handleResponse(message: Record<string, unknown>): void {
    const id = message["id"];
    const entry = typeof id === "number" ? this.pending.get(id) : undefined;
    if (!entry || typeof id !== "number") {
      this.logger.debug("ignored a response with an unknown id");
      return;
    }
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.cleanup();
    if ("error" in message) {
      const error = message["error"];
      if (isPlainObject(error) && typeof error["code"] === "number" && typeof error["message"] === "string") {
        entry.reject(new McpRpcError(error["code"], truncate(error["message"], 300), error["data"]));
      } else {
        entry.reject(new McpRpcError(INTERNAL_ERROR, "malformed error response from client"));
      }
      return;
    }
    entry.resolve(message["result"]);
  }

  // ---------------------------------------------------------------- tools

  private handleToolsList(id: RequestId, params: unknown): void {
    let offset = 0;
    if (params !== undefined && params !== null) {
      if (!isPlainObject(params)) {
        this.sendError(id, INVALID_PARAMS, "Invalid params");
        return;
      }
      if ("cursor" in params && params["cursor"] !== undefined) {
        const decoded = typeof params["cursor"] === "string" ? decodeCursor(params["cursor"]) : undefined;
        const total = this.options.registry.size;
        if (decoded === undefined || decoded >= total) {
          this.sendError(id, INVALID_PARAMS, "Invalid cursor");
          return;
        }
        offset = decoded;
      }
    }
    const all = this.options.registry.list().map((tool) => {
      const meta = TOOL_UI_META.get(tool.name);
      return meta === undefined ? tool : { ...tool, _meta: meta };
    });
    const page = all.slice(offset, offset + this.pageSize);
    const result: Record<string, unknown> = { tools: page };
    if (offset + this.pageSize < all.length) result["nextCursor"] = encodeCursor(offset + this.pageSize);
    this.sendResult(id, result);
  }

  private handleResourcesRead(id: RequestId, params: unknown): void {
    if (!isPlainObject(params) || typeof params["uri"] !== "string") {
      this.sendError(id, INVALID_PARAMS, "Invalid params: uri is required");
      return;
    }
    const resource = findUiResource(params["uri"]);
    if (!resource) {
      this.sendError(id, RESOURCE_NOT_FOUND, `Resource not found: ${truncate(params["uri"])}`);
      return;
    }
    this.sendResult(id, { contents: [resourceContents(resource)] });
  }

  private handleToolsCall(id: RequestId, params: unknown): void {
    if (this.inflight.has(idKey(id))) {
      this.sendError(id, INVALID_REQUEST, "Duplicate request id: a request with this id is still in flight");
      return;
    }
    if (!isPlainObject(params) || typeof params["name"] !== "string") {
      this.sendError(id, INVALID_PARAMS, "Invalid params: name is required");
      return;
    }
    const rawArgs = params["arguments"];
    if (rawArgs !== undefined && !isPlainObject(rawArgs)) {
      this.sendError(id, INVALID_PARAMS, "Invalid params: arguments must be an object");
      return;
    }
    const registered = this.options.registry.get(params["name"]);
    if (!registered) {
      this.sendError(id, INVALID_PARAMS, `Unknown tool: ${truncate(params["name"])}`);
      return;
    }
    const args = rawArgs ?? {};
    const issues = validate(registered.compiled, args);
    if (issues.length > 0) {
      this.sendResult(id, this.invalidArgsResult(registered.tool.name, issues));
      return;
    }
    if (this.inflight.size >= this.maxConcurrentCalls) {
      this.sendResult(id, this.errorResult("busy", `Too many tool calls in flight (limit ${this.maxConcurrentCalls}); retry shortly`));
      return;
    }
    const controller = new AbortController();
    const call: InflightCall = { controller, cancelled: false, promise: Promise.resolve() };
    const key = idKey(id);
    this.inflight.set(key, call);
    call.promise = this.runTool(registered.tool.name, registered.tool.handler.bind(registered.tool), args, call)
      .then((result) => {
        // Free the id before answering, so a client may reuse it as soon as it sees the response.
        this.inflight.delete(key);
        if (!call.cancelled && !this.closing) this.sendToolResult(id, result);
      })
      .finally(() => { this.inflight.delete(key); });
  }

  private async runTool(
    name: string,
    handler: (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>,
    args: Record<string, unknown>,
    call: InflightCall,
  ): Promise<Record<string, unknown>> {
    const context = this.makeContext(call.controller.signal);
    try {
      const raw = await handler(args, context);
      return this.normalizeResult(name, raw);
    } catch (error) {
      if (error instanceof ToolError) return this.errorResult(error.code, error.message, error.details);
      if (call.cancelled || this.closing) return this.errorResult("cancelled", "cancelled");
      this.logger.error(`tool ${name} failed: ${(error as Error).stack ?? String(error)}`);
      return this.errorResult("internal_error", "Internal error while running the tool");
    }
  }

  private makeContext(signal: AbortSignal): ToolContext {
    const server = this;
    return {
      signal,
      get canElicit() { return server.canElicit(); },
      get clientInfo() { return server.session?.clientInfo; },
      log: this.logger,
      elicitForm: (request) => this.elicitForm(request, signal),
    };
  }

  private normalizeResult(name: string, raw: unknown): Record<string, unknown> {
    if (!isPlainObject(raw)) {
      this.logger.error(`tool ${name} returned a malformed result`);
      return this.errorResult("internal_error", "Internal error while running the tool");
    }
    const { content, structuredContent } = raw;
    const contentOk = content === undefined || (Array.isArray(content) && content.every(isPlainObject));
    const structuredOk = structuredContent === undefined || isPlainObject(structuredContent);
    if (!contentOk || !structuredOk || (content === undefined && structuredContent === undefined)) {
      this.logger.error(`tool ${name} returned a malformed result`);
      return this.errorResult("internal_error", "Internal error while running the tool");
    }
    const result: Record<string, unknown> = {
      content: content ?? [{ type: "text", text: JSON.stringify(structuredContent) }],
    };
    if (structuredContent !== undefined) result["structuredContent"] = structuredContent;
    result["isError"] = raw["isError"] === true;
    return result;
  }

  /**
   * `code: message`, then (when there are details and the code is not `invalid_args`, whose message already
   * lists its issues) one compact JSON line, so clients that show only the text still see resource, limit,
   * reason and the like. Over the bound only the short scalar entries are kept, then the line is cut.
   */
  private errorResult(code: string, message: string, details?: Record<string, unknown>): Record<string, unknown> {
    const structured: Record<string, unknown> = { code, message };
    if (details !== undefined) structured["details"] = details;
    const line = code === "invalid_args" ? undefined : detailsLine(details);
    return {
      content: [{ type: "text", text: line === undefined ? `${code}: ${message}` : `${code}: ${message}\n${line}` }],
      structuredContent: structured,
      isError: true,
    };
  }

  private invalidArgsResult(tool: string, issues: Issue[]): Record<string, unknown> {
    const summary = issues.slice(0, 20).map(({ path, keyword, message }) => ({ path, keyword, message }));
    const result = this.errorResult("invalid_args", `Invalid arguments for ${tool}:\n${formatIssues(issues)}`, { issues: summary });
    return result;
  }

  private sendToolResult(id: RequestId, result: Record<string, unknown>): void {
    const serialized = JSON.stringify({ jsonrpc: "2.0", id, result });
    if (Buffer.byteLength(serialized) > this.maxOutputBytes) {
      this.sendResult(id, this.errorResult("too_large", `Tool result exceeds the ${this.maxOutputBytes} byte output limit; narrow the request or paginate`));
      return;
    }
    this.writeLine(serialized);
  }

  // ---------------------------------------------------------------- server-to-client requests

  private canElicit(): boolean {
    return !this.closing && this.session !== undefined && this.session.ready && this.session.formElicitation;
  }

  private async elicitForm(request: ElicitFormRequest, signal: AbortSignal): Promise<ElicitResult> {
    if (!this.canElicit()) throw new ElicitationUnavailableError("the client does not support form elicitation (or has not finished initializing)");
    if (typeof request.message !== "string" || request.message.length === 0) throw new Error("elicitation message is required");
    // `published` is what the client sees (no additionalProperties); `compiled` also rejects unknown answer fields.
    const { published, compiled } = checkElicitSchema(request.requestedSchema);
    const raw = await this.sendRequest(
      "elicitation/create",
      { message: request.message, requestedSchema: published },
      request.timeoutMs ?? this.elicitationTimeoutMs,
      signal,
    );
    if (!isPlainObject(raw) || (raw["action"] !== "accept" && raw["action"] !== "decline" && raw["action"] !== "cancel")) {
      throw new McpRpcError(INVALID_PARAMS, "invalid elicitation response: unknown action");
    }
    if (raw["action"] !== "accept") return { action: raw["action"] };
    const content = raw["content"];
    if (!isPlainObject(content)) throw new McpRpcError(INVALID_PARAMS, "invalid elicitation response: accept without content");
    const issues = validate(compiled, content);
    if (issues.length > 0) throw new McpRpcError(INVALID_PARAMS, `invalid elicitation response: ${formatIssues(issues)}`);
    return { action: "accept", content };
  }

  private sendRequest(method: string, params: unknown, timeoutMs: number, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) return Promise.reject(new McpCancelledError());
    const id = this.nextServerRequestId;
    this.nextServerRequestId += 1;
    return new Promise((resolve, reject) => {
      const cancelAtClient = (reason: string): void => {
        this.writeLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason } }));
      };
      const onAbort = (): void => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        if (!this.closing) cancelAtClient("cancelled");
        reject(new McpCancelledError());
      };
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        signal.removeEventListener("abort", onAbort);
        cancelAtClient("timeout");
        reject(new McpTimeoutError(`no answer to ${method} within ${timeoutMs} ms`, timeoutMs));
      }, timeoutMs);
      timer.unref(); // the open input stream keeps the process alive; a pending question must not
      signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve, reject, timer,
        cleanup: () => signal.removeEventListener("abort", onAbort),
      });
      this.writeLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  // ---------------------------------------------------------------- outbound

  private sendResult(id: RequestId, result: unknown): void {
    this.writeLine(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  private sendError(id: RequestId | null, code: number, message: string): void {
    this.writeLine(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
  }

  /** The single point where bytes leave for the client. `line` is JSON.stringify output, which never contains a raw newline. */
  private writeLine(line: string): void {
    if (this.closing) return;
    try {
      this.options.output.write(`${line}\n`);
    } catch (error) {
      this.logger.error(`write failed: ${(error as Error).message}`);
    }
  }

  // ---------------------------------------------------------------- shutdown

  private async shutdown(reason: string): Promise<void> {
    if (this.closing) return this.finished;
    this.closing = true;
    this.logger.info(`shutting down: ${reason}`);
    for (const [id, entry] of [...this.pending]) {
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.cleanup();
      entry.reject(new McpClosedError());
    }
    for (const call of this.inflight.values()) {
      call.cancelled = true;
      call.controller.abort(new McpClosedError());
    }
    const settled = Promise.allSettled([...this.inflight.values()].map((c) => c.promise));
    let graceTimer: NodeJS.Timeout | undefined;
    const grace = new Promise<void>((resolve) => { graceTimer = setTimeout(resolve, this.shutdownGraceMs); });
    await Promise.race([settled, grace]);
    clearTimeout(graceTimer);
    this.resolveFinished();
    return this.finished;
  }
}
