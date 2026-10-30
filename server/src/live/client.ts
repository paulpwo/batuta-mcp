import net from "node:net";
import path from "node:path";
import { createLogger } from "../log.js";
import type { Logger } from "../log.js";
import { LiveError } from "./errors.js";
import { FrameDecoder, FrameError, MAX_FRAME_BYTES, encodeFrame, encodeRequestFrame, parseFrameBody } from "./framing.js";
import { RuntimeFileError, checkSocketFile, readToken, socketSignature } from "./runtime-files.js";

/**
 * Client for the Remote Script's AF_UNIX socket (docs/01-protocol.md sections 2.3, 3, 4, 5.4).
 *
 * It owns the connection life cycle (token read, hello/welcome, keepalive, reconnect with backoff),
 * request ids, the in-flight cap, per-call deadlines and the mapping of wire errors to {@link LiveError}.
 * It never logs the token and re-reads it before every connection attempt.
 */

export type Edition = "lite" | "standard" | "suite" | "unknown";

export interface Welcome {
  protocol: number;
  liveVersion: string;
  scriptVersion: string;
  edition: Edition;
  editionSource: "detected" | "hint" | "none";
  maxFrame: number;
  limits: { maxInflight: number; ratePerS: number; burst: number };
}

/** `idle`: never connected (on demand); `released`: the slot was given back after inactivity or a lost connection. */
export type ClientState = "idle" | "released" | "connecting" | "ready" | "backoff" | "closed";

export interface LiveClientOptions {
  runtimeDir: string;
  /** Sent in `hello`; they come from the server config (browser.allow_*; allow_audio_import is always true). */
  flags: { allowPlugins: boolean; allowUserPresets: boolean; allowAudioImport: boolean; allowMaxForLive: boolean; allowExternalDevices: boolean };
  /** e.g. "batuta-mcp/0.1.0" (at most 64 characters). */
  clientName: string;
  editionHint?: "lite" | "standard" | "suite";
  logger?: Logger;
  expectedUid?: number;
  /** The Remote Script must be at least this version (semver); otherwise `script_too_old`. */
  minScriptVersion?: string;
  /** Reconnect delays (ms) by attempt number; the last one is the cap. Default 0.5, 1, 2, 4, 8, 15 s. */
  delaysMs?: number[];
  /** Fraction of random jitter applied to each delay (0.2 means +/- 20 %). */
  jitter?: number;
  random?: () => number;
  /**
   * While a backoff delay is longer than this, the client looks at the socket this often (one lstat) and
   * reconnects at once when Live created or re-created it, so a Live restart is noticed within about this
   * time instead of after the rest of the delay. Default 1 s.
   */
  socketPollMs?: number;
  /**
   * Session ownership: connect only when a call (or `ready`) needs Live instead of at `start()`, never reconnect or
   * watch the socket while nothing is waiting, and refuse with `busy` / `held_by_other_session` when another
   * client holds Live's single slot. The refused client tries again on its next call only.
   */
  onDemand?: boolean;
  /** With `onDemand`: give the slot back after this long without calls, in-flight work or holds. 0 or unset: never. */
  idleReleaseMs?: number;
  /** Retry delay for failures that retrying fast cannot fix (auth, protocol, version). Default 30 s. */
  slowRetryMs?: number;
  /** Time allowed from connect to welcome. Default 5 s. */
  helloTimeoutMs?: number;
  /** How long `call` waits for a connection before failing with `not_connected`. Default 2 s. */
  connectWaitMs?: number;
  /** Send a ping after this much outbound silence. Default 30 s. */
  pingIntervalMs?: number;
  /** Drop the connection when no frame arrives this long after a ping. Default 10 s. */
  pongTimeoutMs?: number;
  /** Time a partially received frame may take to complete. Default 5 s. */
  bodyTimeoutMs?: number;
  /** Local deadline slack added to a call's `timeout_ms` before giving up on the answer. Default 500 ms. */
  timeoutGraceMs?: number;
  /** How long a timed-out request may stay unanswered before the connection is recycled. Default 30 s. */
  abandonedSlotMs?: number;
}

export interface CallOptions {
  /** Deadline in ms (sent as `timeout_ms`, clamped to 100..30000). Defaults per command. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * When the connection drops while this call is still queued (never sent), send it after the
   * reconnect instead of failing it. Default false: the call then fails with `not_connected`,
   * `sent:false`, and the caller decides. Only meaningful for safe-to-repeat commands (read-only
   * ones); a call that was already sent is never replayed, whatever this says.
   */
  requeueOnReconnect?: boolean;
  /**
   * Sent as `external_input_ack: {tracks}` on the request frame: the owner confirmed that a recording may capture
   * the live external input of exactly these track ids (the ids the script's refusal named). The script accepts it
   * only while every external-live track is in the list. Set only by the server's own confirmation flow, never from
   * tool arguments.
   */
  externalInputAck?: readonly string[];
}

export interface LiveStatus {
  state: ClientState;
  protocol: number | null;
  liveVersion: string | null;
  scriptVersion: string | null;
  edition: Edition | null;
  editionSource: string | null;
  lastError: { code: string; message: string } | null;
  inflight: number;
  queued: number;
  reconnectAttempts: number;
}

const DEFAULT_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 15_000];
const PROTOCOL_VERSION = 1;
/** Longest wait for the edition provider before the hello goes out without a hint. */
const EDITION_PROBE_MS = 2000;
const MAX_INFLIGHT_CAP = 16;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 30_000;
const MAX_REJECT_RETRIES = 3;
/** Calls allowed to wait for an in-flight slot before new ones are refused. */
const MAX_QUEUED = 256;
const EDITIONS = new Set(["lite", "standard", "suite", "unknown"]);
const EDITION_SOURCES = new Set(["detected", "hint", "none"]);
/** Largest request id the protocol allows; used to size the pre-flight length check conservatively. */
const MAX_ID = 2 ** 53 - 1;

/** Reconnect delay for attempt `n` (0-based): the table entry, capped at its last value, with jitter. */
export function backoffDelayMs(attempt: number, options: { delaysMs: number[]; jitter: number; random: () => number }): number {
  const table = options.delaysMs;
  const base = table.at(Math.min(attempt, table.length - 1)) ?? 15_000;
  return Math.round(base * (1 + options.jitter * (2 * options.random() - 1)));
}

/** Server-side deadlines of section 5.4: browser_search 15 s, batch 10 s, everything else 5 s. */
export function defaultTimeoutMs(cmd: string): number {
  if (cmd === "browser_search") return 15_000;
  if (cmd === "batch") return 10_000;
  return 5_000;
}

function parseSemver(text: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function semverLess(a: [number, number, number], b: [number, number, number]): boolean {
  for (let i = 0; i < 3; i += 1) {
    const x = a.at(i) ?? 0;
    const y = b.at(i) ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type CallPhase = "gate" | "queued" | "inflight" | "retrywait" | "done";

interface Call {
  cmd: string;
  args: Record<string, unknown>;
  timeoutMs: number;
  signal: AbortSignal | undefined;
  resolve(result: unknown): void;
  reject(error: LiveError): void;
  phase: CallPhase;
  timer: NodeJS.Timeout | undefined;
  retries: number;
  onAbort: (() => void) | undefined;
  cancelWait: (() => void) | undefined;
  requeueOnReconnect: boolean;
  externalInputAck: readonly string[] | undefined;
}

interface Inflight {
  /** Null once the caller stopped waiting (timeout, abort); the slot stays taken until the script answers. */
  call: Call | null;
  /** Recycles the connection when an abandoned request is never answered. */
  watchdog?: NodeJS.Timeout;
}

interface ReadyWaiter {
  resolve(welcome: Welcome): void;
  reject(error: LiveError): void;
  timer: NodeJS.Timeout;
}

/** Failure classes that retrying quickly cannot fix; they retry at `slowRetryMs`. */
function isSlowClass(error: LiveError): boolean {
  return error.code === "auth_failed" || error.code === "protocol_mismatch" || error.code === "script_too_old";
}

export class LiveClient {
  private readonly logger: Logger;
  private readonly sockPath: string;
  private readonly delaysMs: number[];
  private readonly jitter: number;
  private readonly random: () => number;
  private readonly slowRetryMs: number;
  private readonly socketPollMs: number;
  private readonly helloTimeoutMs: number;
  private readonly connectWaitMs: number;
  private readonly pingIntervalMs: number;
  private readonly pongTimeoutMs: number;
  private readonly bodyTimeoutMs: number;
  private readonly timeoutGraceMs: number;
  private readonly abandonedSlotMs: number;
  private readonly onDemand: boolean;
  private readonly idleReleaseMs: number;

  private stateValue: ClientState = "idle";
  private welcomeValue: Welcome | null = null;
  private lastErrorValue: LiveError | null = null;
  private socket: net.Socket | null = null;
  private epoch = 0;
  private decoder = new FrameDecoder();
  private handshaken = false;
  private blocked = false;
  private attempt = 0;
  private nextId = 1;
  private maxInflight = MAX_INFLIGHT_CAP;
  private maxFrame = MAX_FRAME_BYTES;
  private lastSocketError = "";
  private sawConnect = false;
  private bodyTimerArmed = false;
  private lastTx = 0;
  private awaitingPong = false;
  private pendingReason: LiveError | null = null;
  private everConnected = false;
  private lastActivity = Date.now();
  private holds = 0;
  private idleTimer: NodeJS.Timeout | undefined;

  private readonly inflight = new Map<number, Inflight>();
  private readonly queue: Call[] = [];
  private readonly calls = new Set<Call>();
  private readonly waiters = new Set<ReadyWaiter>();

  private reconnectTimer: NodeJS.Timeout | undefined;
  private handshakeTimer: NodeJS.Timeout | undefined;
  private pingTimer: NodeJS.Timeout | undefined;
  private pongTimer: NodeJS.Timeout | undefined;
  private bodyTimer: NodeJS.Timeout | undefined;

  private connectedListener: ((welcome: Welcome) => void) | undefined;

  /** Late-bound edition hint source, asked on each connect when no static editionHint is set. */
  private editionHintProvider: (() => Promise<"lite" | "standard" | "suite" | undefined>) | undefined;

  constructor(private readonly options: LiveClientOptions) {
    this.logger = options.logger ?? createLogger();
    this.sockPath = path.join(options.runtimeDir, "live.sock");
    this.delaysMs = options.delaysMs ?? DEFAULT_DELAYS_MS;
    this.jitter = options.jitter ?? 0.2;
    this.random = options.random ?? Math.random;
    this.slowRetryMs = options.slowRetryMs ?? 30_000;
    this.socketPollMs = Math.max(1, options.socketPollMs ?? 1000);
    this.helloTimeoutMs = options.helloTimeoutMs ?? 5000;
    this.connectWaitMs = options.connectWaitMs ?? 2000;
    this.pingIntervalMs = options.pingIntervalMs ?? 30_000;
    this.pongTimeoutMs = options.pongTimeoutMs ?? 10_000;
    this.bodyTimeoutMs = options.bodyTimeoutMs ?? 5000;
    this.timeoutGraceMs = options.timeoutGraceMs ?? 500;
    this.abandonedSlotMs = options.abandonedSlotMs ?? 30_000;
    this.onDemand = options.onDemand === true;
    this.idleReleaseMs = this.onDemand ? Math.max(0, options.idleReleaseMs ?? 0) : 0;
  }

  /**
   * Keep the connection while long work runs without calls (an ears job). Returns the function that ends the hold.
   * It never connects by itself; the work's own calls do.
   */
  hold(): () => void {
    this.holds += 1;
    this.touch();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds -= 1;
      this.touch();
      this.armIdle();
    };
  }

  /**
   * Set once the tool layer exists (the host can probe which Live runs). Asked on every connect, bounded by
   * EDITION_PROBE_MS and by the hello timeout; a static editionHint always wins over it.
   */
  setEditionHintProvider(provider: () => Promise<"lite" | "standard" | "suite" | undefined>): void {
    this.editionHintProvider = provider;
  }

  /** Called with the welcome after every successful handshake, and at once when the connection is already up. Errors in it are logged, not thrown. */
  setConnectedListener(listener: (welcome: Welcome) => void): void {
    this.connectedListener = listener;
    if (this.stateValue === "ready" && this.welcomeValue !== null) this.notifyConnected(this.welcomeValue);
  }

  private notifyConnected(welcome: Welcome): void {
    try {
      this.connectedListener?.(welcome);
    } catch (error) {
      this.logger.warn(`connected listener failed: ${(error as Error).message}`);
    }
  }

  get state(): ClientState {
    return this.stateValue;
  }

  get welcome(): Welcome | null {
    return this.welcomeValue;
  }

  get lastError(): LiveError | null {
    return this.lastErrorValue;
  }

  status(): LiveStatus {
    const w = this.welcomeValue;
    return {
      state: this.stateValue,
      protocol: w?.protocol ?? null,
      liveVersion: w?.liveVersion ?? null,
      scriptVersion: w?.scriptVersion ?? null,
      edition: w?.edition ?? null,
      editionSource: w?.editionSource ?? null,
      lastError: this.lastErrorValue ? { code: this.lastErrorValue.code, message: this.lastErrorValue.message } : null,
      inflight: this.inflight.size,
      queued: this.queue.length,
      reconnectAttempts: this.attempt,
    };
  }

  /** Begin connecting; reconnects automatically until {@link close}. Idempotent. */
  start(): void {
    if (this.stateValue !== "idle") return;
    this.connect();
  }

  /** Resolve with the welcome once connected, or reject with the latest failure when `timeoutMs` passes. */
  ready(timeoutMs = this.connectWaitMs): Promise<Welcome> {
    if (this.stateValue === "ready" && this.welcomeValue) return Promise.resolve(this.welcomeValue);
    if (this.stateValue === "closed") return Promise.reject(new LiveError("closed", "The Live client is closed"));
    this.touch();
    this.wake();
    return new Promise((resolve, reject) => {
      const waiter: ReadyWaiter = {
        resolve, reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(this.lastErrorValue ?? new LiveError("not_connected", "Not connected to Ableton Live yet"));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  /** Send one command and resolve with its `result`. Rejects with {@link LiveError}. */
  call(cmd: string, args: Record<string, unknown>, options: CallOptions = {}): Promise<unknown> {
    if (this.stateValue === "closed") return Promise.reject(new LiveError("closed", "The Live client is closed"));
    const requested = options.timeoutMs ?? defaultTimeoutMs(cmd);
    const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(requested)));
    try {
      encodeRequestFrame({ id: MAX_ID, cmd, args, timeout_ms: timeoutMs }, this.maxFrame);
    } catch (error) {
      return Promise.reject(this.frameErrorToLive(error, false));
    }
    if (options.signal?.aborted) return Promise.reject(new LiveError("cancelled", "The call was cancelled", { details: { sent: false } }));
    this.touch();
    return new Promise((resolve, reject) => {
      const call: Call = {
        cmd, args, timeoutMs, signal: options.signal, resolve, reject,
        phase: "gate", timer: undefined, retries: 0, onAbort: undefined, cancelWait: undefined,
        requeueOnReconnect: options.requeueOnReconnect === true, externalInputAck: options.externalInputAck === undefined ? undefined : [...options.externalInputAck],
      };
      this.calls.add(call);
      if (options.signal) {
        call.onAbort = () => this.abortCall(call);
        options.signal.addEventListener("abort", call.onAbort, { once: true });
      }
      this.armQueueDeadline(call);
      void this.admit(call);
    });
  }

  async close(): Promise<void> {
    if (this.stateValue === "closed") return;
    this.stateValue = "closed";
    clearTimeout(this.idleTimer);
    this.clearReconnect();
    this.dropSocket();
    const closed = new LiveError("closed", "The Live client was closed");
    for (const waiter of [...this.waiters]) {
      clearTimeout(waiter.timer);
      waiter.reject(closed);
    }
    this.waiters.clear();
    for (const call of [...this.calls]) {
      const sent = call.phase === "inflight";
      this.finish(call, new LiveError("closed", "The Live client was closed", { outcomeUnknown: sent, details: { sent } }));
    }
    this.clearInflight();
    this.queue.length = 0;
  }

  // ---------------------------------------------------------------- calls

  private async admit(call: Call): Promise<void> {
    if (this.stateValue !== "ready") {
      this.wake();
      if (this.onDemand && (this.stateValue === "idle" || this.stateValue === "released")) {
        this.finish(call, this.notConnected(this.lastErrorValue)); // the one attempt failed at once (e.g. runtime files)
        return;
      }
      const failure = await this.waitForReady(call);
      if (failure) {
        this.finish(call, failure);
        return;
      }
    }
    if (call.phase === "done") return;
    if (this.stateValue !== "ready") {
      this.finish(call, this.notConnected(this.lastErrorValue));
      return;
    }
    if (this.queue.length >= MAX_QUEUED) {
      this.finish(call, new LiveError("busy", "Too many calls are waiting to be sent to Live", {
        details: { reason: "client_queue_full", sent: false },
      }));
      return;
    }
    call.phase = "queued";
    this.queue.push(call);
    this.pump();
  }

  /** Wait up to `connectWaitMs` for the connection; resolves null when ready (or the call ended meanwhile). */
  private waitForReady(call: Call): Promise<LiveError | null> {
    return new Promise((resolve) => {
      const cleanup = (): void => {
        clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        call.cancelWait = undefined;
      };
      const waiter: ReadyWaiter = {
        resolve: () => { cleanup(); resolve(null); },
        reject: (error) => { cleanup(); resolve(error.code === "busy" ? error : this.notConnected(error)); },
        timer: setTimeout(() => { cleanup(); resolve(this.notConnected(this.lastErrorValue)); }, this.connectWaitMs),
      };
      call.cancelWait = () => { cleanup(); resolve(null); };
      this.waiters.add(waiter);
    });
  }

  private notConnected(cause: LiveError | null): LiveError {
    const reason = cause ? ` (${cause.message})` : "";
    return new LiveError("not_connected", `Not connected to Ableton Live${reason}`, {
      details: { sent: false, ...(cause ? { cause: cause.code } : {}) },
    });
  }

  private pump(): void {
    while (this.stateValue === "ready" && !this.blocked && this.inflight.size < this.maxInflight && this.queue.length > 0) {
      const call = this.queue.shift() as Call;
      if (call.phase !== "queued") continue;
      this.send(call);
    }
  }

  private send(call: Call): void {
    const socket = this.socket;
    if (!socket) return;
    const id = this.nextId;
    this.nextId = this.nextId >= MAX_ID ? 1 : this.nextId + 1;
    let data: Buffer;
    try {
      data = encodeRequestFrame({ id, cmd: call.cmd, args: call.args, timeout_ms: call.timeoutMs, ...(call.externalInputAck === undefined ? {} : { external_input_ack: { tracks: call.externalInputAck } }) }, this.maxFrame);
    } catch (error) {
      this.finish(call, this.frameErrorToLive(error, false));
      return;
    }
    clearTimeout(call.timer);
    call.phase = "inflight";
    call.timer = setTimeout(() => this.timeoutInflight(call, id), call.timeoutMs + this.timeoutGraceMs);
    this.inflight.set(id, { call });
    this.write(socket, data);
  }

  private write(socket: net.Socket, data: Buffer): void {
    this.lastTx = Date.now();
    if (!socket.write(data)) this.blocked = true;
  }

  private timeoutInflight(call: Call, id: number): void {
    const entry = this.inflight.get(id);
    if (entry) this.abandon(entry, id); // the slot stays taken, like the script's own in-flight count
    this.finish(call, new LiveError("timeout", `No answer from Live to ${call.cmd} within ${call.timeoutMs} ms; the outcome is unknown, re-read state before retrying`, {
      details: { stage: "client", sent: true, cmd: call.cmd },
      outcomeUnknown: true,
    }));
    this.pump();
  }

  /** The caller stopped waiting; keep the slot until the script answers, but not forever. */
  private abandon(entry: Inflight, id: number): void {
    entry.call = null;
    const epoch = this.epoch;
    entry.watchdog = setTimeout(() => {
      if (this.inflight.get(id) !== entry) return;
      this.logger.warn("a timed-out request was never answered; reconnecting to free its slot");
      this.abortConnection(epoch, new LiveError("connection_lost", "Live never answered a timed-out request; the connection was recycled", { outcomeUnknown: true }));
    }, this.abandonedSlotMs);
    entry.watchdog.unref();
  }

  private armQueueDeadline(call: Call): void {
    clearTimeout(call.timer);
    call.timer = setTimeout(() => {
      if (call.phase === "inflight" || call.phase === "done") return;
      this.finish(call, new LiveError("timeout", `Timed out waiting to send ${call.cmd} to Live`, {
        details: { stage: "client", sent: false, cmd: call.cmd },
      }));
    }, call.timeoutMs);
  }

  private abortCall(call: Call): void {
    if (call.phase === "done") return;
    if (call.phase === "inflight") {
      for (const [id, entry] of this.inflight) if (entry.call === call) this.abandon(entry, id);
      this.finish(call, new LiveError("cancelled", `${call.cmd} was cancelled after it was sent; the outcome is unknown`, {
        outcomeUnknown: true, details: { sent: true, cmd: call.cmd },
      }));
      return;
    }
    this.finish(call, new LiveError("cancelled", `${call.cmd} was cancelled before it was sent`, { details: { sent: false, cmd: call.cmd } }));
  }

  private finish(call: Call, outcome: LiveError | { result: unknown }): void {
    if (call.phase === "done") return;
    call.phase = "done";
    clearTimeout(call.timer);
    call.cancelWait?.();
    const queued = this.queue.indexOf(call);
    if (queued >= 0) this.queue.splice(queued, 1);
    if (call.signal && call.onAbort) call.signal.removeEventListener("abort", call.onAbort);
    this.calls.delete(call);
    this.touch();
    this.armIdle();
    if (outcome instanceof LiveError) call.reject(outcome);
    else call.resolve(outcome.result);
  }

  private frameErrorToLive(error: unknown, sent: boolean): LiveError {
    if (error instanceof FrameError) {
      return new LiveError(error.code === "too_large" ? "too_large" : "invalid_args", `Request cannot be sent: ${error.message}`, {
        details: { sent },
      });
    }
    return new LiveError("invalid_args", "Request cannot be sent", { details: { sent } });
  }

  private handleResponse(message: Record<string, unknown>): void {
    const id = message["id"];
    if (typeof id !== "number") {
      // The script could not tell which request this answers (a frame it rejected at shape-check
      // time). That request's slot would never be freed, so drop the connection: it frees every
      // slot and the reconnect starts clean.
      const code = (message["error"] as { code?: unknown } | undefined)?.code;
      this.abortConnection(this.epoch, new LiveError("connection_lost", `Remote Script rejected a frame without naming the request (${String(code).slice(0, 40)}); the connection was recycled`, {
        outcomeUnknown: true,
      }));
      return;
    }
    const entry = this.inflight.get(id);
    if (!entry) {
      this.logger.warn("Remote Script answered an unknown request id");
      return;
    }
    clearTimeout(entry.watchdog);
    this.inflight.delete(id);
    const call = entry.call;
    if (call && call.phase === "inflight") {
      if (message["ok"] === true) {
        this.finish(call, { result: message["result"] ?? null });
      } else {
        const error = LiveError.fromWire(message["error"]);
        if (this.shouldRetry(call, error)) this.scheduleRetry(call, error);
        else this.finish(call, error);
      }
    }
    this.pump();
  }

  /** `rate_limited` and `busy` are rejected before anything runs, so a retry cannot double-apply. */
  private shouldRetry(call: Call, error: LiveError): boolean {
    return (error.code === "rate_limited" || error.code === "busy") && call.retries < MAX_REJECT_RETRIES;
  }

  private scheduleRetry(call: Call, error: LiveError): void {
    call.retries += 1;
    const advised = error.details?.["retry_after_ms"];
    const delay = error.code === "rate_limited" && typeof advised === "number" && Number.isFinite(advised)
      ? Math.min(1000, Math.max(0, advised))
      : 100 * call.retries;
    clearTimeout(call.timer);
    call.phase = "retrywait";
    call.timer = setTimeout(() => {
      if (call.phase !== "retrywait") return;
      call.phase = "queued";
      this.armQueueDeadline(call);
      this.queue.unshift(call);
      this.pump();
    }, delay);
  }

  // ---------------------------------------------------------------- connection

  private connect(): void {
    if (this.stateValue === "closed") return;
    if (this.onDemand && this.stateValue === "backoff" && this.waiters.size === 0) {
      this.goIdle(); // nobody is waiting any more: no background reconnect
      return;
    }
    this.stateValue = "connecting";
    let token: string;
    try {
      const fileOptions = this.options.expectedUid === undefined ? undefined : { expectedUid: this.options.expectedUid };
      token = readToken(this.options.runtimeDir, fileOptions);
      checkSocketFile(this.sockPath, fileOptions);
    } catch (error) {
      if (error instanceof RuntimeFileError) {
        this.failAttempt(new LiveError("runtime_files", error.message, { details: { reason: error.reason }, retryable: true }));
        return;
      }
      this.failAttempt(new LiveError("runtime_files", `Cannot prepare the connection: ${(error as Error).message}`, { retryable: true }));
      return;
    }
    this.logger.addSecret(token);
    const epoch = (this.epoch += 1);
    this.decoder = new FrameDecoder(MAX_FRAME_BYTES);
    this.handshaken = false;
    this.blocked = false;
    this.lastSocketError = "";
    this.sawConnect = false;
    this.bodyTimerArmed = false;
    const socket = net.createConnection({ path: this.sockPath });
    this.socket = socket;
    this.handshakeTimer = setTimeout(() => {
      if (epoch !== this.epoch || this.handshaken) return;
      this.abortConnection(epoch, new LiveError("timeout", `Remote Script did not complete the handshake within ${this.helloTimeoutMs} ms`, { details: { stage: "hello" }, retryable: true }));
    }, this.helloTimeoutMs);
    socket.on("connect", () => {
      if (epoch !== this.epoch) return;
      this.sawConnect = true;
      const provide = this.options.editionHint === undefined && this.editionHintProvider !== undefined;
      void (async () => {
        const editionHint = this.options.editionHint ?? (provide ? await this.probeEditionHint() : undefined);
        if (epoch !== this.epoch || socket.destroyed) return;
        const hello: Record<string, unknown> = {
          type: "hello",
          protocol: PROTOCOL_VERSION,
          token,
          client: this.options.clientName.slice(0, 64),
          ...(editionHint === undefined ? {} : { edition_hint: editionHint }),
          allow_plugins: this.options.flags.allowPlugins,
          allow_user_presets: this.options.flags.allowUserPresets,
          allow_audio_import: this.options.flags.allowAudioImport,
          allow_max_for_live: this.options.flags.allowMaxForLive,
          allow_external_devices: this.options.flags.allowExternalDevices,
        };
        this.write(socket, encodeFrame(hello));
      })();
    });
    socket.on("data", (chunk: Buffer) => this.onData(epoch, chunk));
    socket.on("drain", () => {
      if (epoch !== this.epoch) return;
      this.blocked = false;
      this.pump();
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      this.lastSocketError = error.code ?? error.message;
    });
    socket.on("close", () => this.onClose(epoch));
  }

  /**
   * The provider's answer, or undefined when it fails or does not answer within the bound. The bound leaves
   * at least 1 s of the hello timeout for the welcome. Never rejects.
   */
  private async probeEditionHint(): Promise<"lite" | "standard" | "suite" | undefined> {
    const provider = this.editionHintProvider;
    if (provider === undefined) return undefined;
    const bound = Math.max(0, Math.min(EDITION_PROBE_MS, this.helloTimeoutMs - 1000));
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), bound);
    });
    try {
      return await Promise.race([Promise.resolve().then(() => provider()).catch(() => undefined), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private onData(epoch: number, chunk: Buffer): void {
    if (epoch !== this.epoch) return;
    let bodies: Buffer[];
    try {
      bodies = this.decoder.feed(chunk);
    } catch (error) {
      this.abortConnection(epoch, new LiveError("connection_lost", `Remote Script sent an invalid frame: ${(error as Error).message}`, { outcomeUnknown: true }));
      return;
    }
    this.updateBodyTimer(epoch, bodies.length > 0);
    this.awaitingPong = false;
    clearTimeout(this.pongTimer);
    for (const body of bodies) {
      if (epoch !== this.epoch) return;
      let message: Record<string, unknown>;
      try {
        message = parseFrameBody(body);
      } catch (error) {
        this.abortConnection(epoch, new LiveError("connection_lost", `Remote Script sent an unparseable frame: ${(error as Error).message}`, { outcomeUnknown: true }));
        return;
      }
      this.onMessage(epoch, message);
    }
  }

  /** The whole body of a frame must arrive within `bodyTimeoutMs` of its first byte; chunks do not extend it. */
  private updateBodyTimer(epoch: number, completedFrame: boolean): void {
    if (completedFrame || !this.decoder.hasPartial) {
      clearTimeout(this.bodyTimer);
      this.bodyTimerArmed = false;
    }
    if (!this.decoder.hasPartial || this.bodyTimerArmed) return;
    this.bodyTimerArmed = true;
    this.bodyTimer = setTimeout(() => {
      this.abortConnection(epoch, new LiveError("connection_lost", "Remote Script stopped in the middle of a frame", { outcomeUnknown: true }));
    }, this.bodyTimeoutMs);
  }

  private onMessage(epoch: number, message: Record<string, unknown>): void {
    const type = message["type"];
    if (!this.handshaken) {
      this.onHandshakeMessage(epoch, message);
      return;
    }
    if (type === "pong") return;
    if (type === "error") {
      const error = LiveError.fromWire(message["error"]);
      this.abortConnection(epoch, new LiveError("connection_lost", `Remote Script closed the connection: ${error.message}`, {
        outcomeUnknown: true, details: { cause: error.code },
      }));
      return;
    }
    if (type === undefined && typeof message["ok"] === "boolean") {
      this.handleResponse(message);
      return;
    }
    this.abortConnection(epoch, new LiveError("connection_lost", "Remote Script sent an unexpected frame", { outcomeUnknown: true }));
  }

  private onHandshakeMessage(epoch: number, message: Record<string, unknown>): void {
    if (message["type"] === "error") {
      const wire = message["error"];
      const error = LiveError.fromWire(wire);
      const text = isPlainObject(wire) && typeof wire["message"] === "string" ? wire["message"] : "";
      if (error.code === "bad_request" && /unsupported protocol/i.test(text)) {
        this.abortConnection(epoch, new LiveError("protocol_mismatch", "BatutaMCP protocol mismatch: server speaks 1, Remote Script speaks a different version. Install matching versions.", { details: error.details ?? {} }));
      } else if (error.code === "busy" && this.onDemand) {
        this.abortConnection(epoch, this.heldByOther());
      } else if (error.code === "auth_failed") {
        this.abortConnection(epoch, new LiveError("auth_failed", "The Remote Script rejected the token. Restart Live if the token file was replaced, or check the token file.", { retryable: false }));
      } else {
        this.abortConnection(epoch, error);
      }
      return;
    }
    if (message["type"] !== "welcome") {
      this.abortConnection(epoch, new LiveError("bad_response", "Remote Script answered hello with an unexpected frame"));
      return;
    }
    const outcome = this.parseWelcome(message);
    if (outcome instanceof LiveError) {
      this.abortConnection(epoch, outcome);
      return;
    }
    this.onWelcome(outcome);
  }

  private parseWelcome(message: Record<string, unknown>): Welcome | LiveError {
    const remoteProtocol = message["protocol"];
    if (remoteProtocol !== PROTOCOL_VERSION) {
      return new LiveError("protocol_mismatch", `BatutaMCP protocol mismatch: server speaks ${PROTOCOL_VERSION}, Remote Script speaks ${String(remoteProtocol).slice(0, 20)}. Install matching versions.`);
    }
    const limits = message["limits"];
    const bad = (what: string): LiveError => new LiveError("bad_response", `Remote Script sent a malformed welcome (${what})`);
    if (typeof message["live_version"] !== "string") return bad("live_version");
    const scriptVersion = message["script_version"];
    if (typeof scriptVersion !== "string" || parseSemver(scriptVersion) === undefined) return bad("script_version");
    if (typeof message["edition"] !== "string" || !EDITIONS.has(message["edition"])) return bad("edition");
    if (typeof message["edition_source"] !== "string" || !EDITION_SOURCES.has(message["edition_source"])) return bad("edition_source");
    const maxFrame = message["max_frame"];
    if (typeof maxFrame !== "number" || !Number.isInteger(maxFrame) || maxFrame < 1024 || maxFrame > MAX_FRAME_BYTES) return bad("max_frame");
    if (!isPlainObject(limits)) return bad("limits");
    const { max_inflight: maxInflight, rate_per_s: ratePerS, burst } = limits;
    if (typeof maxInflight !== "number" || !Number.isInteger(maxInflight) || maxInflight < 1 || maxInflight > 64) return bad("limits.max_inflight");
    if (typeof ratePerS !== "number" || !Number.isFinite(ratePerS) || typeof burst !== "number" || !Number.isFinite(burst)) return bad("limits");
    const minimum = this.options.minScriptVersion;
    if (minimum !== undefined) {
      const have = parseSemver(scriptVersion) as [number, number, number];
      const need = parseSemver(minimum);
      if (need && semverLess(have, need)) {
        return new LiveError("script_too_old", `Remote Script ${scriptVersion} is older than required ${minimum}: reinstall BatutaMCP from the same release`);
      }
    }
    return {
      protocol: PROTOCOL_VERSION,
      liveVersion: message["live_version"].slice(0, 64),
      scriptVersion,
      edition: message["edition"] as Edition,
      editionSource: message["edition_source"] as Welcome["editionSource"],
      maxFrame,
      limits: { maxInflight, ratePerS, burst },
    };
  }

  private onWelcome(welcome: Welcome): void {
    this.handshaken = true;
    clearTimeout(this.handshakeTimer);
    this.welcomeValue = welcome;
    this.maxFrame = welcome.maxFrame;
    this.maxInflight = Math.min(MAX_INFLIGHT_CAP, welcome.limits.maxInflight);
    this.lastErrorValue = null;
    this.attempt = 0;
    this.everConnected = true;
    this.touch();
    this.stateValue = "ready";
    this.logger.info(`connected to Live ${welcome.liveVersion} (${welcome.edition}), Remote Script ${welcome.scriptVersion}`);
    this.startKeepalive();
    this.armIdle();
    this.notifyConnected(welcome);
    for (const waiter of [...this.waiters]) {
      clearTimeout(waiter.timer);
      waiter.resolve(welcome);
    }
    this.waiters.clear();
    this.pump();
  }

  private startKeepalive(): void {
    clearInterval(this.pingTimer);
    this.lastTx = Date.now();
    const epoch = this.epoch;
    const tick = Math.max(10, Math.floor(this.pingIntervalMs / 2));
    this.pingTimer = setInterval(() => {
      const socket = this.socket;
      if (epoch !== this.epoch || !socket || this.awaitingPong) return;
      if (Date.now() - this.lastTx < this.pingIntervalMs) return;
      this.awaitingPong = true;
      this.write(socket, encodeFrame({ type: "ping" }));
      this.pongTimer = setTimeout(() => {
        this.abortConnection(epoch, new LiveError("connection_lost", "Remote Script stopped answering pings", { outcomeUnknown: true }));
      }, this.pongTimeoutMs);
      this.pongTimer.unref();
    }, tick);
    this.pingTimer.unref();
  }

  /** Tear the socket down for `reason`; the close handler then runs the common failure path. */
  private abortConnection(epoch: number, reason: LiveError): void {
    if (epoch !== this.epoch) return;
    this.pendingReason = reason;
    this.socket?.destroy();
  }

  private onClose(epoch: number): void {
    if (epoch !== this.epoch) return;
    const wasReady = this.handshaken;
    const reason = this.pendingReason;
    this.pendingReason = null;
    this.dropSocket();
    if (this.stateValue === "closed") return;
    let error: LiveError;
    if (reason) {
      error = reason;
    } else if (wasReady) {
      error = new LiveError("connection_lost", "The connection to Live was lost", { outcomeUnknown: true });
    } else if (this.sawConnect) {
      // Connected, then closed before the welcome: the script closes a second client without a
      // reply, and during an authentication lockout it closes new connections immediately.
      error = new LiveError("not_connected", "The Remote Script closed the connection during the handshake (another client is connected, or the authentication lockout is active). Close other BatutaMCP clients or wait about 30 s.", {
        retryable: true,
        details: { cause: "peer_closed", ...(this.lastSocketError ? { socket_error: this.lastSocketError } : {}) },
      });
    } else {
      error = new LiveError("not_connected", `Cannot connect to ${this.sockPath}${this.lastSocketError ? ` (${this.lastSocketError})` : ""}. Is Live running with the BatutaMCP control surface enabled?`, { retryable: true });
    }
    this.failAttempt(error);
    if (wasReady) this.failPending(error);
  }

  /** Fail what was sent (unknown outcome); what was only queued goes back to waiting for a connection. */
  private failPending(cause: LiveError): void {
    for (const entry of this.inflight.values()) {
      if (entry.call) {
        this.finish(entry.call, new LiveError("connection_lost", cause.message, {
          outcomeUnknown: true, retryable: false, details: { sent: true, cmd: entry.call.cmd },
        }));
      }
    }
    this.clearInflight();
    // Calls that were only queued were never transmitted. Those that opted in wait for the new
    // connection (within their own deadline); the rest fail, and the caller decides.
    for (const call of this.queue.splice(0)) {
      if (call.phase !== "queued") continue;
      if (call.requeueOnReconnect) {
        call.phase = "gate";
        void this.admit(call);
      } else {
        this.finish(call, new LiveError("not_connected", `Connection to Live lost before ${call.cmd} was sent`, { details: { sent: false, cmd: call.cmd } }));
      }
    }
  }

  private clearInflight(): void {
    for (const entry of this.inflight.values()) clearTimeout(entry.watchdog);
    this.inflight.clear();
  }

  private failAttempt(error: LiveError): void {
    if (this.stateValue === "closed") return;
    this.lastErrorValue = error;
    this.logger.warn(`connection attempt failed: ${error.code}: ${error.message}`);
    const held = this.onDemand && error.details?.["reason"] === "held_by_other_session";
    const slow = isSlowClass(error);
    if (slow || held) {
      for (const waiter of [...this.waiters]) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
      this.waiters.clear();
    }
    if (this.onDemand && (held || this.waiters.size === 0)) {
      this.goIdle(); // refused, or nobody is waiting: the next call tries again, nothing runs in the background
      return;
    }
    this.stateValue = "backoff";
    const delay = slow ? this.slowRetryMs : backoffDelayMs(this.attempt, { delaysMs: this.delaysMs, jitter: this.jitter, random: this.random });
    if (!slow) this.attempt += 1;
    this.clearReconnect();
    if (slow || delay <= this.socketPollMs) {
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
      this.reconnectTimer.unref();
    } else {
      this.waitForSocketChange(delay);
    }
  }

  /**
   * A long backoff delay, but cut short when the socket changes: one lstat per `socketPollMs`, no connection
   * attempt until the entry at live.sock is different from what failed (Live started or restarted and bound it
   * again). That attempt starts the backoff sequence over, so a Live still loading is retried quickly too.
   * When nothing changes, the delay runs out as before.
   */
  private waitForSocketChange(delay: number): void {
    const before = socketSignature(this.sockPath);
    const deadline = Date.now() + delay;
    const tick = (): void => {
      if (this.stateValue !== "backoff") return;
      const changed = socketSignature(this.sockPath) !== before;
      if (changed) this.attempt = 0;
      if (changed || Date.now() >= deadline) {
        this.connect();
        return;
      }
      this.reconnectTimer = setTimeout(tick, Math.min(this.socketPollMs, Math.max(1, deadline - Date.now())));
      this.reconnectTimer.unref();
    };
    this.reconnectTimer = setTimeout(tick, this.socketPollMs);
    this.reconnectTimer.unref();
  }

  /** On-demand mode only: stop all connection activity until the next call. */
  private goIdle(): void {
    this.clearReconnect();
    this.attempt = 0;
    this.stateValue = this.everConnected ? "released" : "idle";
  }

  private heldByOther(): LiveError {
    const seconds = Math.round(this.idleReleaseMs / 1000);
    const when = seconds > 0 ? `it is released after ${seconds} s without activity` : "it is released when that session ends";
    return new LiveError("busy", `Live is being controlled by another Claude session; ${when}. Try again then.`, {
      details: { reason: "held_by_other_session", sent: false },
      retryable: true,
    });
  }

  /** On-demand mode: a call or `ready` needs Live and nothing is connecting; make one attempt. */
  private wake(): void {
    if (!this.onDemand) return;
    if (this.stateValue === "idle" || this.stateValue === "released") this.connect();
  }

  private touch(): void {
    this.lastActivity = Date.now();
  }

  /** Give the slot back once nothing has used it for `idleReleaseMs`. Work in flight, queued calls and holds keep it. */
  private armIdle(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    if (this.idleReleaseMs <= 0 || this.stateValue !== "ready") return;
    const remaining = this.idleReleaseMs - (Date.now() - this.lastActivity);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.stateValue !== "ready") return;
      const busy = this.calls.size > 0 || this.inflight.size > 0 || this.holds > 0;
      if (busy || Date.now() - this.lastActivity < this.idleReleaseMs) {
        this.armIdle();
        return;
      }
      this.release();
    }, Math.max(1, remaining));
    this.idleTimer.unref();
  }

  private release(): void {
    this.logger.info(`no activity for ${Math.round(this.idleReleaseMs / 1000)} s; releasing Live`);
    this.epoch += 1; // the close event of this socket is not a failure
    this.dropSocket();
    this.clearInflight();
    this.pendingReason = null;
    this.stateValue = "released";
    this.attempt = 0;
  }

  private clearReconnect(): void {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private dropSocket(): void {
    clearTimeout(this.handshakeTimer);
    clearTimeout(this.pongTimer);
    clearTimeout(this.bodyTimer);
    this.bodyTimerArmed = false;
    clearInterval(this.pingTimer);
    this.awaitingPong = false;
    this.handshaken = false;
    this.blocked = false;
    const socket = this.socket;
    this.socket = null;
    if (socket && !socket.destroyed) socket.destroy();
  }
}
