import { PassThrough } from "node:stream";
import { McpServer, ToolRegistry } from "../../src/mcp/index.js";
import type { McpServerOptions } from "../../src/mcp/index.js";
import { createLogger } from "../../src/log.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Json = any;

/** In-memory MCP client used by the tests: speaks newline-delimited JSON-RPC to a server under test. */
export class FakeClient {
  readonly toServer = new PassThrough();
  readonly fromServer = new PassThrough();
  readonly inbox: Json[] = [];
  readonly rawLines: string[] = [];
  private waiters: Array<{ predicate: (m: Json) => boolean; resolve: (m: Json) => void }> = [];
  private buffer = "";

  constructor() {
    this.fromServer.setEncoding("utf8");
    this.fromServer.on("data", (chunk: string) => {
      this.buffer += chunk;
      let index = this.buffer.indexOf("\n");
      while (index >= 0) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        this.rawLines.push(line);
        const message = JSON.parse(line) as Json; // throws (test failure) if the server ever writes non-JSON
        const waiter = this.waiters.findIndex((w) => w.predicate(message));
        if (waiter >= 0) this.waiters.splice(waiter, 1)[0]!.resolve(message);
        else this.inbox.push(message);
        index = this.buffer.indexOf("\n");
      }
    });
  }

  send(message: Json): void {
    this.toServer.write(`${JSON.stringify(message)}\n`);
  }

  sendRaw(data: string | Buffer): void {
    this.toServer.write(data);
  }

  end(): void {
    this.toServer.end();
  }

  /** Next message matching the predicate (default: any), waiting up to `timeoutMs`. */
  next(predicate: (m: Json) => boolean = () => true, timeoutMs = 1500): Promise<Json> {
    const index = this.inbox.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.inbox.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve: (m: Json) => { clearTimeout(timer); resolve(m); } };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error("timed out waiting for a server message"));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  nextResponse(id: number | string | null, timeoutMs?: number): Promise<Json> {
    return this.next((m) => m.id === id && ("result" in m || "error" in m), timeoutMs);
  }

  async request(id: number | string, method: string, params?: Json): Promise<Json> {
    this.send(params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params });
    return this.nextResponse(id);
  }

  notify(method: string, params?: Json): void {
    this.send(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params });
  }

  async initialize(capabilities: Json = {}, protocolVersion = "2025-11-25"): Promise<Json> {
    const response = await this.request(1, "initialize", {
      protocolVersion,
      capabilities,
      clientInfo: { name: "fake-client", version: "0.0.0" },
    });
    this.notify("notifications/initialized");
    return response;
  }

  async expectSilence(ms = 60): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
    if (this.inbox.length > 0) throw new Error(`unexpected server message: ${JSON.stringify(this.inbox[0])}`);
  }
}

export interface Harness {
  client: FakeClient;
  server: McpServer;
  registry: ToolRegistry;
  done: Promise<void>;
  logs: string[];
}

export function startServer(options: Partial<McpServerOptions> = {}, registry = new ToolRegistry()): Harness {
  const client = new FakeClient();
  const logs: string[] = [];
  const server = new McpServer({
    input: client.toServer,
    output: client.fromServer,
    registry,
    serverInfo: { name: "batuta-mcp-test", version: "9.9.9" },
    logger: createLogger({ sink: (line) => logs.push(line) }),
    ...options,
  });
  const done = server.run();
  return { client, server, registry, done, logs };
}
