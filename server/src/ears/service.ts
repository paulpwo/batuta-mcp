import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { ServerConfig } from "../config/index.js";
import { McpCancelledError, ToolError } from "../mcp/index.js";
import type { ToolResult } from "../mcp/index.js";
import { asNumber, asObject, asString, field, invalidArgs, notFound } from "../tools/util.js";
import type { Json } from "../tools/util.js";
import { AnalysisRunner } from "./analysis.js";
import type { AnalysisReport, Analyzer } from "./analysis.js";
import { liveRecordingRoots, openAudioFile } from "./files.js";
import { EarsDeclined, runEarsJob } from "./job.js";
import type { EarsClock, EarsHost, EarsRequest, EarsTiming } from "./job.js";

/**
 * The ears features as the tools use them: one job (or analysis) at a time, the last results kept in
 * memory for `compare_audio`, and a small summary for `batuta_status`. Nothing here writes anywhere.
 */

export interface EarsServiceDeps {
  host: EarsHost;
  config: ServerConfig;
  home?: string;
  uid?: number;
  clock?: EarsClock;
  timing?: Partial<EarsTiming>;
  analyzer?: Analyzer;
}

const RESULT_ID = /^ears-[0-9a-f]{8}$/;
const KEEP_RESULTS = 8;
const METRICS = ["integrated_lufs", "short_term_max_lufs", "momentary_max_lufs", "lra_lu", "true_peak_dbtp", "sample_peak_dbfs", "rms_dbfs", "crest_db", "correlation"] as const;

function plain(text: string, structured: Json): ToolResult {
  const json = JSON.stringify(structured);
  return { content: [{ type: "text", text: json.length <= 6000 ? `${text}\n${json}` : `${text}\nThe full result is in structuredContent.` }], structuredContent: structured };
}

const fmt = (value: number | null, unit: string): string => (value === null ? "n/a" : `${value.toFixed(1)} ${unit}`);

function summary(report: AnalysisReport): string {
  return `integrated ${fmt(report.integrated_lufs, "LUFS")}, short-term max ${fmt(report.short_term_max_lufs, "LUFS")}, momentary max ${fmt(report.momentary_max_lufs, "LUFS")}, LRA ${fmt(report.lra_lu, "LU")}, true peak ${fmt(report.true_peak_dbtp, "dBTP")}, sample peak ${fmt(report.sample_peak_dbfs, "dBFS")}, crest ${fmt(report.crest_db, "dB")}`;
}

function delta(a: number | null, b: number | null, digits: number): number | null {
  if (a === null || b === null) return null;
  const scale = 10 ** digits;
  const value = Math.round((b - a) * scale) / scale;
  return value === 0 ? 0 : value;
}

interface LastJob { ok: boolean; finished_at: string; source_kind: string; beats: number | null; [key: string]: unknown }

export class EarsService {
  private busy = false;
  private releaseHold: (() => void) | undefined;
  private readonly results = new Map<string, AnalysisReport>();
  private last: LastJob | null = null;
  private readonly analyzer: Analyzer;
  private readonly home: string;

  constructor(private readonly deps: EarsServiceDeps) {
    this.analyzer = deps.analyzer ?? new AnalysisRunner({ maxBytes: deps.config.ears.maxBytes });
    this.home = deps.home ?? os.homedir();
  }

  get enabled(): boolean {
    return this.deps.config.ears.enabled;
  }

  status(): { enabled: boolean; busy: boolean; last_job: LastJob | null } {
    return { enabled: this.enabled, busy: this.busy, last_job: this.last };
  }

  private acquire(): void {
    if (this.busy) throw new ToolError("busy", "Another ears job is running (one at a time). Wait for it to finish.", { reason: "job_running" });
    this.busy = true;
    this.releaseHold = this.deps.host.hold?.();
  }

  private finishJob(): void {
    this.busy = false;
    this.releaseHold?.();
    this.releaseHold = undefined;
  }

  private remember(report: AnalysisReport): string {
    const id = `ears-${randomBytes(4).toString("hex")}`;
    this.results.set(id, report);
    while (this.results.size > KEEP_RESULTS) {
      const oldest = this.results.keys().next();
      if (oldest.done === true) break;
      this.results.delete(oldest.value);
    }
    return id;
  }

  // ------------------------------------------------------------------ record and analyze

  async record(request: EarsRequest, spectrum: boolean, signal: AbortSignal, confirmExternal?: (tracks: string[]) => Promise<boolean>): Promise<ToolResult> {
    this.acquire();
    const kind = asString(request.source["kind"]) ?? (request.source["name"] === undefined ? "track" : "named");
    try {
      const { config } = this.deps;
      const outcome = await runEarsJob(request, {
        host: this.deps.host,
        config: { enabled: config.ears.enabled, maxBytes: config.ears.maxBytes, maxBeats: config.ears.maxBeats, roots: config.ears.roots, setRoots: config.ears.setRoots },
        files: { home: this.home, ...(this.deps.uid === undefined ? {} : { uid: this.deps.uid }) },
        analyzer: this.analyzer,
        ...(this.deps.clock === undefined ? {} : { clock: this.deps.clock }),
        ...(this.deps.timing === undefined ? {} : { timing: this.deps.timing }),
        ...(confirmExternal === undefined ? {} : { confirmExternal }),
      }, signal);
      const id = this.remember(outcome.report);
      const report: Json = { ...outcome.report };
      if (!spectrum) delete report["spectrum"];
      this.last = { ok: true, finished_at: new Date().toISOString(), source_kind: outcome.source.kind, beats: outcome.beats, duration_ms: outcome.elapsed_ms, cleanup: outcome.cleanup, integrated_lufs: outcome.report.integrated_lufs };
      const structured: Json = {
        result_id: id, source: outcome.source, beats: outcome.beats, report, file: { path: outcome.file.path, size: outcome.file.size }, warnings: outcome.warnings, cleanup: outcome.cleanup,
        ...(outcome.manual === undefined ? {} : { manual: outcome.manual }), elapsed_ms: outcome.elapsed_ms,
        note: "The recording stays in Live's recording folder (BatutaMCP never deletes files). The set is marked modified and Live's undo history holds the steps of this measurement, so do not press Undo blindly.",
      };
      const warn = [...outcome.warnings, ...outcome.report.warnings];
      const text = `Measured ${outcome.source.kind} "${outcome.source.name}" over ${outcome.beats} beats: ${summary(outcome.report)}.${warn.length > 0 ? ` Warnings: ${warn.join(", ")}.` : ""}${outcome.cleanup === "failed" ? ` The temporary track could not be removed: ${outcome.manual ?? ""}` : ""} Result id ${id}.`;
      return plain(text, structured);
    } catch (error) {
      if (error instanceof EarsDeclined) {
        this.last = { ok: false, finished_at: new Date().toISOString(), source_kind: kind, beats: request.beats ?? null, error_code: "cancelled" };
        return { content: [{ type: "text", text: "Cancelled: the external input was not confirmed, nothing was recorded and nothing was changed." }], structuredContent: { cancelled: true } };
      }
      const details = error instanceof ToolError ? asObject(error.details) : {};
      this.last = {
        ok: false, finished_at: new Date().toISOString(), source_kind: kind, beats: request.beats ?? null,
        error_code: error instanceof ToolError ? error.code : error instanceof McpCancelledError ? "cancelled" : "error",
        ...(asString(details["stage"]) === undefined ? {} : { stage: asString(details["stage"]) }),
        ...(asString(details["cleanup"]) === undefined ? {} : { cleanup: asString(details["cleanup"]) }),
      };
      throw error;
    } finally {
      this.finishJob();
    }
  }

  // ------------------------------------------------------------------ analyze_audio, compare_audio

  private async analyzePath(file: string, signal: AbortSignal): Promise<{ report: AnalysisReport; format: string; size: number }> {
    const { config } = this.deps;
    const opened = openAudioFile(file, {
      home: this.home,
      roots: [...liveRecordingRoots(this.home), ...config.ears.roots, ...config.sampleRoots],
      setRoots: config.ears.setRoots,
      // No folder configured means no folder restriction; configured folders narrow.
      anyFolder: config.ears.roots.length === 0 && config.sampleRoots.length === 0,
      maxBytes: config.ears.maxBytes,
      ...(this.deps.uid === undefined ? {} : { uid: this.deps.uid }),
    });
    try {
      const bytes = opened.readAll();
      const size = bytes.length; // before the analysis: it takes the buffer over
      const report = await this.analyzer.analyze(bytes, signal);
      return { report, format: opened.layout?.format ?? "wav", size };
    } finally {
      opened.close();
    }
  }

  async analyzeFile(file: string, signal: AbortSignal): Promise<ToolResult> {
    this.acquire();
    try {
      const { report, format, size } = await this.analyzePath(file, signal);
      const id = this.remember(report);
      return plain(`Analyzed the file: ${summary(report)}. Result id ${id}.`, { result_id: id, report, file: { format, size } });
    } finally {
      this.finishJob();
    }
  }

  async compare(a: string, b: string, signal: AbortSignal): Promise<ToolResult> {
    this.acquire();
    try {
      const left = await this.reference(a, signal);
      const right = await this.reference(b, signal);
      const metric = (report: AnalysisReport, name: string): number | null => asNumber(field(report as unknown as Json, name)) ?? null;
      const deltas: Json = Object.fromEntries(METRICS.map((name) => [name, delta(metric(left.report, name), metric(right.report, name), name === "correlation" ? 3 : 1)]));
      deltas["spectrum"] = left.report.spectrum.map((band, i) => ({ center_hz: band.center_hz, delta_db: delta(band.level_db, right.report.spectrum.at(i)?.level_db ?? null, 1) }));
      const side = (x: { report: AnalysisReport; from: string }): Json => ({ from: x.from, ...Object.fromEntries(Object.entries(x.report).filter(([name]) => name !== "spectrum")) });
      const structured: Json = { a: side(left), b: side(right), deltas, note: "Deltas are b minus a, in the unit of each metric (LU or dB; correlation has no unit). null means one side has no value." };
      const integrated = asNumber(deltas["integrated_lufs"]);
      return plain(`Compared b with a: integrated ${integrated === undefined ? "n/a" : `${integrated > 0 ? "+" : ""}${integrated.toFixed(1)} LU`}.`, structured);
    } finally {
      this.finishJob();
    }
  }

  private async reference(value: string, signal: AbortSignal): Promise<{ report: AnalysisReport; from: string }> {
    if (RESULT_ID.test(value)) {
      const report = this.results.get(value);
      if (report === undefined) throw notFound("No earlier result has that id (only the last few results of this session are kept).", { reason: "unknown_result" });
      return { report, from: "result" };
    }
    if (path.isAbsolute(value)) return { report: (await this.analyzePath(value, signal)).report, from: "file" };
    throw invalidArgs("Give an absolute file path or the result_id of an earlier ears result.", { reason: "bad_reference" });
  }
}
