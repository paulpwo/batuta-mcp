import { Worker } from "node:worker_threads";
import type { ResourceLimits } from "node:worker_threads";
import { McpCancelledError, ToolError } from "../mcp/index.js";

/**
 * Decoding and analysis of a recorded file (docs/01-protocol.md 10.6) run in a worker thread, so a long
 * file never blocks the MCP loop. The worker is started from ONE fixed compiled file that ships in the
 * package (`dist/src/loudness/worker.js`): no eval, no data: URL, no path from outside. It gets a time
 * limit, a heap cap, and its answer is checked field by field before anything is used. The AST scan allows
 * `node:worker_threads` in this file only (test/static-ears.test.ts).
 */

export interface SpectrumBand { center_hz: number; level_db: number | null }

/** The report of section 10.6 as the worker produces it. */
export interface AnalysisReport {
  duration_s: number;
  sample_rate: number;
  channels: number;
  bit_depth: number;
  mono: boolean;
  integrated_lufs: number | null;
  short_term_max_lufs: number | null;
  momentary_max_lufs: number | null;
  lra_lu: number | null;
  true_peak_dbtp: number | null;
  true_peak_dbtp_per_channel: Array<number | null>;
  sample_peak_dbfs: number | null;
  rms_dbfs: number | null;
  crest_db: number | null;
  spectrum: SpectrumBand[];
  correlation: number | null;
  warnings: string[];
}

export const BAND_CENTERS: readonly number[] = Object.freeze([31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]);

/** The part of the runner the ears job uses (tests substitute a stub). */
export interface Analyzer {
  /** Takes the bytes over: a buffer that is a whole ArrayBuffer is transferred to the worker (and detached here). */
  analyze(bytes: Uint8Array, signal?: AbortSignal): Promise<AnalysisReport>;
}

export type WorkerFactory = (limits: ResourceLimits) => Worker;

export interface AnalysisOptions {
  /** Wall-clock limit for one analysis (default 120 s; a 5 minute stereo file takes about 25 s). */
  timeoutMs?: number;
  resourceLimits?: ResourceLimits;
  maxBytes?: number;
  maxDurationS?: number;
  /** Test seam: how a worker is created. The default starts the shipped worker file. */
  createWorker?: WorkerFactory;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_FILE_BYTES = 1024 * 1024 * 1024;
const MAX_DURATION_S = 300;
/** Typed arrays live outside the JS heap, so the decoded size is also bounded before the worker starts (files.ts). */
const DEFAULT_LIMITS: ResourceLimits = { maxOldGenerationSizeMb: 1024, maxYoungGenerationSizeMb: 64, stackSizeMb: 4, codeRangeSizeMb: 16 };

const productionWorker: WorkerFactory = (resourceLimits) => new Worker(new URL("../loudness/worker.js", import.meta.url), { resourceLimits, env: {}, name: "batuta-analysis" });

function bad(detail: string): ToolError {
  return new ToolError("internal_error", "The analysis worker answered with an unexpected message.", { stage: "analysis", reason: "bad_worker_message", detail });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length && keys.every((key, i) => key === wanted.at(i));
}

function level(value: unknown, what: string, min = -1000, max = 1000): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw bad(what);
  return value;
}

function whole(value: unknown, what: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw bad(what);
  return value;
}

const REPORT_KEYS = ["bit_depth", "channels", "correlation", "crest_db", "duration_s", "integrated_lufs", "lra_lu", "mono", "momentary_max_lufs", "rms_dbfs", "sample_peak_dbfs", "sample_rate", "short_term_max_lufs", "spectrum", "true_peak_dbtp", "true_peak_dbtp_per_channel", "warnings"];
const WARNING = /^[a-z0-9_]{1,48}$/;

function readReport(raw: unknown): AnalysisReport {
  if (!isRecord(raw) || !sameKeys(raw, REPORT_KEYS)) throw bad("report keys");
  const channels = whole(raw["channels"], "channels", 1, 2);
  const duration = level(raw["duration_s"], "duration_s", 0, 100_000);
  if (duration === null || typeof raw["mono"] !== "boolean") throw bad("duration or mono");
  const perChannel = raw["true_peak_dbtp_per_channel"];
  if (!Array.isArray(perChannel) || perChannel.length !== channels) throw bad("true_peak_dbtp_per_channel");
  const spectrum = raw["spectrum"];
  if (!Array.isArray(spectrum) || spectrum.length !== BAND_CENTERS.length) throw bad("spectrum");
  const warnings = raw["warnings"];
  if (!Array.isArray(warnings) || warnings.length > 16 || !warnings.every((w) => typeof w === "string" && WARNING.test(w))) throw bad("warnings");
  return {
    duration_s: duration,
    sample_rate: whole(raw["sample_rate"], "sample_rate", 1, 10_000_000),
    channels,
    bit_depth: whole(raw["bit_depth"], "bit_depth", 1, 64),
    mono: raw["mono"],
    integrated_lufs: level(raw["integrated_lufs"], "integrated_lufs"),
    short_term_max_lufs: level(raw["short_term_max_lufs"], "short_term_max_lufs"),
    momentary_max_lufs: level(raw["momentary_max_lufs"], "momentary_max_lufs"),
    lra_lu: level(raw["lra_lu"], "lra_lu", 0, 1000),
    true_peak_dbtp: level(raw["true_peak_dbtp"], "true_peak_dbtp"),
    true_peak_dbtp_per_channel: perChannel.map((v) => level(v, "true_peak_dbtp_per_channel")),
    sample_peak_dbfs: level(raw["sample_peak_dbfs"], "sample_peak_dbfs"),
    rms_dbfs: level(raw["rms_dbfs"], "rms_dbfs"),
    crest_db: level(raw["crest_db"], "crest_db", 0, 2000),
    spectrum: spectrum.map((band, i) => {
      if (!isRecord(band) || !sameKeys(band, ["center_hz", "level_db"]) || band["center_hz"] !== BAND_CENTERS.at(i)) throw bad("spectrum band");
      return { center_hz: BAND_CENTERS.at(i) as number, level_db: level(band["level_db"], "spectrum level") };
    }),
    correlation: level(raw["correlation"], "correlation", -1.001, 1.001),
    warnings: warnings as string[],
  };
}

export type WorkerReply = { kind: "result"; report: AnalysisReport } | { kind: "error"; code: string; message: string };

/** Check one message from the worker against the schema; throws an internal_error ToolError for anything else. */
export function validateWorkerReply(message: unknown, id: number): WorkerReply {
  if (!isRecord(message)) throw bad("not an object");
  if (message["type"] === "result") {
    if (!sameKeys(message, ["id", "report", "type"]) || message["id"] !== id) throw bad("result envelope");
    return { kind: "result", report: readReport(message["report"]) };
  }
  if (message["type"] === "error") {
    if (!sameKeys(message, ["code", "id", "message", "type"]) || message["id"] !== id) throw bad("error envelope");
    const { code, message: text } = message;
    if (typeof code !== "string" || !/^[a-z_]{1,40}$/.test(code) || typeof text !== "string" || text.length > 300) throw bad("error fields");
    return { kind: "error", code, message: text };
  }
  throw bad("unknown type");
}

function audioError(reply: { code: string; message: string }): ToolError {
  if (reply.code === "bad_message") return bad("the worker refused the request");
  return new ToolError("invalid_args", `The audio file cannot be analyzed: ${reply.message}`, { reason: "bad_audio", audio_code: reply.code });
}

export class AnalysisRunner implements Analyzer {
  private counter = 0;
  private readonly timeoutMs: number;
  private readonly limits: ResourceLimits;
  private readonly maxBytes: number;
  private readonly maxDurationS: number;
  private readonly createWorker: WorkerFactory;

  constructor(options: AnalysisOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.limits = { ...DEFAULT_LIMITS, ...(options.resourceLimits ?? {}) };
    this.maxBytes = options.maxBytes ?? MAX_FILE_BYTES;
    this.maxDurationS = options.maxDurationS ?? MAX_DURATION_S;
    this.createWorker = options.createWorker ?? productionWorker;
  }

  analyze(bytes: Uint8Array, signal?: AbortSignal): Promise<AnalysisReport> {
    if (signal?.aborted === true) return Promise.reject(new McpCancelledError("analysis cancelled"));
    this.counter += 1;
    const id = this.counter;
    // A buffer that is a whole ArrayBuffer (what EarsFile.readAll returns) is handed over without a copy and is empty afterwards;
    // a view onto a larger buffer is copied and stays usable.
    const whole = bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
    let copy: ArrayBuffer;
    if (whole) copy = bytes.buffer as ArrayBuffer;
    else {
      copy = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(copy).set(bytes);
    }
    let worker: Worker;
    try {
      worker = this.createWorker(this.limits);
    } catch {
      return Promise.reject(new ToolError("internal_error", "The analysis worker could not be started.", { stage: "analysis", reason: "worker_start" }));
    }
    return new Promise<AnalysisReport>((resolve, reject) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined = undefined;
      const onAbort = (): void => { finish(() => { reject(new McpCancelledError("analysis cancelled")); }); };
      const finish = (settle: () => void): void => {
        if (done) return;
        done = true;
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        worker.terminate().catch(() => undefined);
        settle();
      };
      worker.on("message", (message: unknown) => {
        try {
          const reply = validateWorkerReply(message, id);
          finish(() => { if (reply.kind === "result") resolve(reply.report); else reject(audioError(reply)); });
        } catch (error) {
          finish(() => { reject(error); });
        }
      });
      worker.on("error", (error: Error & { code?: string }) => {
        finish(() => {
          if (error.code === "ERR_WORKER_OUT_OF_MEMORY") reject(new ToolError("too_large", "The analysis needed more memory than allowed; the file is too large to analyze.", { reason: "analysis_memory" }));
          else reject(new ToolError("internal_error", "The analysis worker failed.", { stage: "analysis", reason: "worker_error", error: error.name }));
        });
      });
      worker.on("exit", () => {
        finish(() => { reject(new ToolError("internal_error", "The analysis worker stopped without an answer.", { stage: "analysis", reason: "worker_exit" })); });
      });
      timer = setTimeout(() => {
        finish(() => { reject(new ToolError("timeout", "The analysis took too long and was stopped.", { stage: "analysis" })); });
      }, this.timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      worker.postMessage({ type: "analyze", id, bytes: copy, maxBytes: this.maxBytes, maxDurationS: this.maxDurationS }, [copy]);
    });
  }
}
