import { compileSchema } from "../validate/index.js";
import type { CompiledSchema, Schema } from "../validate/index.js";
import type { Logger } from "../log.js";

/** MCP tool annotations (hints only; clients treat them as untrusted). */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface TextContent {
  type: "text";
  text: string;
}

/** What a handler returns. At least one of `content` and `structuredContent` is required. */
export interface ToolResult {
  content?: Array<Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export type ElicitResult =
  | { action: "accept"; content: Record<string, unknown> }
  | { action: "decline" | "cancel" };

/** One primitive field of a form (MCP form mode allows only these). */
export interface ElicitProperty {
  type: "string" | "number" | "integer" | "boolean";
  title?: string;
  description?: string;
  default?: unknown;
  enum?: string[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
}

/** The flat object of primitive properties that MCP form mode allows. */
export interface ElicitSchema {
  type: "object";
  title?: string;
  description?: string;
  properties: Record<string, ElicitProperty>;
  required?: string[];
}

export interface ElicitFormRequest {
  /** Human-readable explanation shown by the client. */
  message: string;
  /** Flat object of primitive properties. Published as given, without `additionalProperties`. */
  requestedSchema: ElicitSchema;
  /** Deadline for the user's answer; defaults to the server's `elicitationTimeoutMs`. */
  timeoutMs?: number;
}

/** Per-call services the server hands to a tool handler. */
export interface ToolContext {
  /** Aborted when the client cancels the call or the connection closes. */
  readonly signal: AbortSignal;
  /** True when the client declared form elicitation and the session is ready for server requests. */
  readonly canElicit: boolean;
  readonly clientInfo: { name: string; version: string } | undefined;
  readonly log: Logger;
  /** Ask the user a form question through the client. Throws {@link ElicitationUnavailableError} when `canElicit` is false. */
  elicitForm(request: ElicitFormRequest): Promise<ElicitResult>;
}

export interface Tool {
  /** 1 to 128 characters from `A-Za-z0-9_.-` (MCP tool naming). */
  name: string;
  title?: string;
  description: string;
  /** Published as `inputSchema` and used to validate `arguments`. Must be an object schema. */
  inputSchema: Schema;
  annotations?: ToolAnnotations;
  handler(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

/** The part of a tool that appears in `tools/list`. */
export interface ToolDefinition {
  name: string;
  title?: string;
  description: string;
  inputSchema: Schema;
  annotations?: ToolAnnotations;
}

export interface RegisteredTool {
  readonly tool: Tool;
  readonly compiled: CompiledSchema;
}

const NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

/** The interface T5b fills: tools are registered once at startup, in a stable order. */
export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(tool: Tool): void {
    if (!NAME_PATTERN.test(tool.name)) throw new Error(`invalid tool name "${tool.name.slice(0, 40)}"`);
    if (this.tools.has(tool.name)) throw new Error(`tool "${tool.name}" is already registered`);
    if (tool.inputSchema.type !== "object") throw new Error(`tool "${tool.name}": inputSchema must have type "object"`);
    let compiled: CompiledSchema;
    try {
      compiled = compileSchema(tool.inputSchema);
    } catch (error) {
      throw new Error(`tool "${tool.name}": ${(error as Error).message}`);
    }
    this.tools.set(tool.name, { tool, compiled });
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  get size(): number {
    return this.tools.size;
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()].map(({ tool, compiled }) => {
      const definition: ToolDefinition = { name: tool.name, description: tool.description, inputSchema: compiled.schema };
      if (tool.title !== undefined) definition.title = tool.title;
      if (tool.annotations !== undefined) definition.annotations = tool.annotations;
      return definition;
    });
  }
}
