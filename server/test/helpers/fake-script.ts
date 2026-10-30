import fs from "node:fs";
import net from "node:net";
import path from "node:path";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

const HEADER = 4;

/** Independent framing for the fake peer, so the tests do not share code with the client under test. */
export function frame(obj: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.alloc(HEADER);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

export interface Reply {
  conn: net.Socket;
  ok(result: unknown): void;
  fail(code: string, message: string, details?: unknown): void;
  send(obj: unknown): void;
  raw(data: Buffer): void;
}

export interface FakeScriptOptions {
  token?: string;
  welcome?: Record<string, unknown>;
  /** Called for each request frame; default answers ok with an echo. */
  onRequest?: (request: Json, reply: Reply) => void;
  /** Called for each hello frame; return true when the hello was fully handled. */
  onHello?: (hello: Json, reply: Reply) => boolean;
  /** Called for each new connection before any data is read; return true to take it over. */
  onConnection?: (conn: net.Socket) => boolean;
}

export const GOOD_TOKEN = "0123456789abcdef".repeat(4);

/**
 * In-process stand-in for the Remote Script: an AF_UNIX server in a short, private temp dir that
 * speaks the length-prefixed protocol of docs/01-protocol.md section 3.
 */
export class FakeScript {
  readonly dir: string;
  readonly sockPath: string;
  readonly tokenPath: string;
  token: string;
  readonly hellos: Json[] = [];
  readonly requests: Json[] = [];
  readonly connections = new Set<net.Socket>();
  connectionCount = 0;
  pings = 0;
  ignorePings = false;
  options: FakeScriptOptions;
  private readonly server: net.Server;

  private constructor(dir: string, options: FakeScriptOptions) {
    this.dir = dir;
    this.sockPath = path.join(dir, "live.sock");
    this.tokenPath = path.join(dir, "token");
    this.token = options.token ?? GOOD_TOKEN;
    this.options = options;
    this.server = net.createServer((conn) => this.accept(conn));
  }

  static async create(options: FakeScriptOptions = {}, writeToken = true): Promise<FakeScript> {
    const dir = fs.mkdtempSync("/tmp/bm-"); // mkdtemp creates it 0700, owned by us
    const script = new FakeScript(dir, options);
    if (writeToken) fs.writeFileSync(script.tokenPath, script.token, { mode: 0o600 });
    await new Promise<void>((resolve, reject) => {
      script.server.once("error", reject);
      script.server.listen(script.sockPath, () => { fs.chmodSync(script.sockPath, 0o600); resolve(); });
    });
    return script;
  }

  welcome(): Json {
    return {
      type: "welcome", protocol: 1, live_version: "12.4.7", script_version: "0.1.0", edition: "lite",
      edition_source: "detected", max_frame: 1_048_576, limits: { max_inflight: 16, rate_per_s: 50, burst: 100 },
      ...(this.options.welcome ?? {}),
    };
  }

  /** Drop every client connection (simulates Live closing the socket). */
  dropAll(): void {
    for (const conn of this.connections) conn.destroy();
  }

  async stopListening(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Bind the socket again after {@link stopListening} (simulates Live starting again). */
  async startListening(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.sockPath, () => { fs.chmodSync(this.sockPath, 0o600); resolve(); });
    });
  }

  async close(): Promise<void> {
    this.dropAll();
    await this.stopListening().catch(() => undefined);
    fs.rmSync(this.dir, { recursive: true, force: true });
  }

  private makeReply(conn: net.Socket, id?: unknown): Reply {
    return {
      conn,
      ok: (result) => conn.write(frame({ id, ok: true, result })),
      fail: (code, message, details) => conn.write(frame({ id, ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } })),
      send: (obj) => conn.write(frame(obj)),
      raw: (data) => conn.write(data),
    };
  }

  private accept(conn: net.Socket): void {
    this.connections.add(conn);
    this.connectionCount += 1;
    conn.on("close", () => this.connections.delete(conn));
    conn.on("error", () => undefined);
    if (this.options.onConnection?.(conn)) return;
    let buffer = Buffer.alloc(0);
    let authed = false;
    conn.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= HEADER) {
        const length = buffer.readUInt32BE(0);
        if (buffer.length < HEADER + length) return;
        const body = buffer.subarray(HEADER, HEADER + length);
        buffer = buffer.subarray(HEADER + length);
        const message = JSON.parse(body.toString("utf8")) as Json;
        const reply = this.makeReply(conn, message.id);
        if (!authed) {
          this.hellos.push(message);
          if (this.options.onHello?.(message, reply)) { authed = true; continue; }
          if (message.token !== this.token) {
            reply.send({ type: "error", error: { code: "auth_failed", message: "authentication failed" } });
            conn.end();
            return;
          }
          authed = true;
          reply.send(this.welcome());
          continue;
        }
        if (message.type === "ping") { this.pings += 1; if (!this.ignorePings) reply.send({ type: "pong" }); continue; }
        this.requests.push(message);
        if (this.options.onRequest) this.options.onRequest(message, reply);
        else reply.ok({ echo: message.cmd, args: message.args });
      }
    });
  }
}

export async function waitFor(predicate: () => boolean, timeoutMs = 1500, stepMs = 5): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
