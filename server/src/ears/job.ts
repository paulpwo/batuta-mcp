import { LiveError } from "../live/index.js";
import type { Edition } from "../live/index.js";
import { McpCancelledError, ToolError } from "../mcp/index.js";
import { limitsFor } from "../tools/edition.js";
import { asToolError } from "../tools/errors.js";
import { Resolver } from "../tools/resolve.js";
import { asArray, asNumber, asObject, asString, notFound, safeText } from "../tools/util.js";
import type { Json } from "../tools/util.js";
import type { AnalysisReport, Analyzer } from "./analysis.js";
import { liveRecordingRoots, openAudioFile } from "./files.js";
import type { EarsFile } from "./files.js";

/**
 * The ears flow (docs/01-protocol.md section 10.2): record a track or the master inside Live on a temporary
 * audio track, read the file Live wrote, analyze it, and always take the temporary track away again.
 * Everything goes through `EarsHost`, the narrow channel to the Remote Script (a fixed set of commands).
 */

export const EARS_TRACK_NAME = "batuta-ears";
const MANUAL = "In Live, delete the track named batuta-ears (right-click it, Delete). The other steps of the recording are in the undo history.";

export interface EarsHost {
  /** Connect and check the script's catalog; throws a ToolError (version_mismatch, not connected). */
  prepare(signal: AbortSignal): Promise<void>;
  /** One command. Throws the raw LiveError so the job can tell a lost connection from a refusal. */
  call(cmd: string, args: Json, signal: AbortSignal | undefined, timeoutMs?: number, externalInputAck?: readonly string[]): Promise<Json>;
  /** The ears cleanup exemption (docs/01-protocol.md 9.3 item 4): delete the temporary track, nothing else. */
  deleteEarsTrack(index: number, signal: AbortSignal): Promise<unknown>;
  /** Wait for a (re)connection. */
  ready(timeoutMs: number): Promise<void>;
  /** The effective edition for the server's own limits check. */
  edition(): Edition;
  /** Keep Live's slot for the length of a job; returns the function that ends the hold. */
  hold?(): () => void;
}

export interface EarsClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface EarsTiming {
  pollMs: number;
  finalizeMs: number;
  finalizeMaxMs: number;
  retryMs: number;
  retryMaxMs: number;
  deleteRetryMs: number;
  reconnectMs: number;
  jobDeadlineMs: number;
}

export const DEFAULT_TIMING: EarsTiming = { pollMs: 250, finalizeMs: 200, finalizeMaxMs: 5000, retryMs: 250, retryMaxMs: 5000, deleteRetryMs: 500, reconnectMs: 30_000, jobDeadlineMs: 600_000 };

export const REAL_CLOCK: EarsClock = {
  now: () => performance.now(),
  sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
};

export interface EarsRequest {
  /** A track selector (index reference or name), resolved against a fresh listing. */
  source: Json;
  beats?: number;
  bars?: number;
}

export interface EarsJobOptions {
  host: EarsHost;
  clock?: EarsClock;
  timing?: Partial<EarsTiming>;
  config: { enabled: boolean; maxBytes: number; maxBeats: number; roots: string[]; setRoots: string[] };
  files: { home: string; uid?: number };
  analyzer: Analyzer;
  /**
   * Asked once when a track with a live external input exists. true = the owner accepted that the recording may
   * capture it (every command of this job is then sent with the acknowledgement); false = declined (the job stops
   * with {@link EarsDeclined}). Absent: the job refuses as before.
   */
  confirmExternal?: (tracks: string[]) => Promise<boolean>;
}

/** The owner declined the external-input question: nothing was recorded or changed. */
export class EarsDeclined extends Error {
  constructor() {
    super("The owner declined to record the external input.");
    this.name = "EarsDeclined";
  }
}

export interface EarsOutcome {
  report: AnalysisReport;
  source: { kind: string; index: number | null; name: string };
  beats: number;
  file: { path: string; size: number };
  warnings: string[];
  cleanup: "ok" | "failed";
  manual?: string;
  elapsed_ms: number;
}

/** Errors that mean "the connection is not there right now" for a read that can simply be asked again. */
const RETRYABLE = new Set<string>(["connection_lost", "not_connected", "busy", "rate_limited", "timeout"]);
const isOutageError = (error: unknown): error is LiveError => error instanceof LiveError && RETRYABLE.has(error.code);
const TRACK_ID = /^(?:t\d{1,4}|r\d{1,4}|m)$/;
const NON_TRACK_INPUTS = new Set(["Ext. In", "Resampling", "No Input"]);
const DEFINITE_HEADER_REASONS = new Set(["bad_format", "too_long", "decoded_too_large", "file_too_large", "file_changed"]);

class Job {
  private readonly clock: EarsClock;
  private readonly timing: EarsTiming;
  private readonly started: number;
  private readonly warnings: string[] = [];
  /** The first command that can create the track has been sent: cleanup has something to look for. */
  private touched = false;
  private earsIndex: number | undefined = undefined;
  private expectedIndex: number | undefined = undefined;
  private fired = false;
  private stopped = false;
  private startedTransport = false;
  private restored = false;
  private wasPlaying = false;
  /** The owner accepted the live external inputs of these track ids for this job: its commands carry the acknowledgement. */
  private acknowledged: readonly string[] | undefined = undefined;
  private songTime = 0;
  private selectedBefore: Json | undefined = undefined;
  private armedBefore: Array<{ index: number; name: string }> = [];
  private outageMs = 0;
  private outageStart: number | undefined = undefined;

  constructor(private readonly request: EarsRequest, private readonly o: EarsJobOptions, private readonly signal: AbortSignal) {
    this.clock = o.clock ?? REAL_CLOCK;
    this.timing = { ...DEFAULT_TIMING, ...(o.timing ?? {}) };
    this.started = this.clock.now();
  }

  private get earsRef(): Json {
    return { kind: "track", index: this.earsIndex, expect_name: EARS_TRACK_NAME };
  }

  // ------------------------------------------------------------------ plumbing

  private checkSignal(): void {
    if (this.signal.aborted) throw new McpCancelledError("The ears job was cancelled.");
  }

  private checkDeadline(): void {
    if (this.clock.now() - this.started > this.timing.jobDeadlineMs) {
      throw new ToolError("timeout", "The ears job did not finish within its 600 second limit.", { stage: "job", reason: this.outageStart === undefined ? "deadline" : "connection_lost" });
    }
  }

  /** One command, errors turned into tool errors. */
  private async call(cmd: string, args: Json, mutating: boolean, timeoutMs?: number): Promise<Json> {
    this.checkSignal();
    try {
      return asObject(await this.o.host.call(cmd, args, this.signal, timeoutMs, this.acknowledged));
    } catch (error) {
      if (this.signal.aborted) throw new McpCancelledError("The ears job was cancelled.");
      throw asToolError(error, mutating);
    }
  }

  private read(cmd: string, args: Json): Promise<Json> {
    return this.call(cmd, args, false);
  }

  /** A read that is asked again after the connection dropped, until the job deadline; the time without a connection is counted. */
  private async retryRead(cmd: string, args: Json): Promise<Json> {
    let attempt = 0;
    for (;;) {
      this.checkSignal();
      this.checkDeadline();
      try {
        const result = asObject(await this.o.host.call(cmd, args, this.signal, undefined, this.acknowledged));
        if (this.outageStart !== undefined) {
          this.outageMs += this.clock.now() - this.outageStart;
          this.outageStart = undefined;
        }
        return result;
      } catch (error) {
        if (this.signal.aborted) throw new McpCancelledError("The ears job was cancelled.");
        if (!isOutageError(error)) throw asToolError(error, false);
        this.outageStart ??= this.clock.now();
        const wait = Math.min(this.timing.retryMaxMs, this.timing.retryMs * 2 ** Math.min(attempt, 10));
        attempt += 1;
        await this.clock.sleep(wait);
        try {
          await this.o.host.ready(Math.min(this.timing.retryMaxMs, 5000));
        } catch {
          // still down: the next attempt reports it
        }
      }
    }
  }

  private outageSoFar(): number {
    return this.outageMs + (this.outageStart === undefined ? 0 : this.clock.now() - this.outageStart);
  }

  private async tracks(): Promise<Json[]> {
    const items: Json[] = [];
    let offset = 0;
    for (let page = 0; page < 10; page += 1) {
      const result = await this.read("track_list", { include_returns: true, include_master: true, limit: 500, offset });
      items.push(...asArray(result["items"]).map(asObject));
      const next = asNumber(result["next_offset"]);
      if (next === undefined || next <= offset) return items;
      offset = next;
    }
    throw new ToolError("too_large", "The set has too many tracks to list.", { reason: "track_pages" });
  }

  // ------------------------------------------------------------------ the steps

  async steps(): Promise<Omit<EarsOutcome, "cleanup" | "elapsed_ms" | "manual">> {
    const { host, config } = this.o;
    this.checkSignal();
    if (!config.enabled) throw new ToolError("not_supported", "Ears are disabled in the server configuration (ears.enabled).", { reason: "disabled_by_config" });
    await host.prepare(this.signal);

    // Step 0 and 1: preconditions and the state to put back.
    const song = await this.read("song_info", {});
    if (song["record_mode"] === true || song["session_record"] === true) {
      throw new ToolError("not_supported", "Live is in record mode (Arrangement Record or Session Record). Turn it off before measuring.", { reason: "record_mode_on" });
    }
    const list = await this.tracks();
    if (list.some((item) => asString(item["name"]) === EARS_TRACK_NAME)) {
      throw new ToolError("invalid_args", "A track named batuta-ears already exists, probably left over from an earlier run. Delete it in Live and try again.", { reason: "stale_ears_track" });
    }
    await this.gate(list, song);
    const sourceItem = await this.pickSource(list);
    const beats = this.beatsFor(song);
    this.wasPlaying = song["is_playing"] === true;
    this.songTime = asNumber(song["current_song_time"]) ?? 0;
    const selected = asObject(song["selected_track"]);
    this.selectedBefore = typeof selected["kind"] === "string" ? selected : undefined;
    this.armedBefore = list.filter((item) => item["kind"] === "track" && item["arm"] === true).map((item) => ({ index: asNumber(item["index"]) ?? -1, name: asString(item["name"]) ?? "" }));
    const sourceName = asString(sourceItem["name"]) ?? "";
    if (sourceItem["mute"] === true) this.warnings.push("source_muted");
    if (list.some((item) => item["solo"] === true) && sourceItem["solo"] !== true) this.warnings.push("solo_active");

    // Step 2: a free track slot.
    const trackCount = asNumber(song["track_count"]) ?? 0;
    const limits = limitsFor(host.edition());
    if (limits !== undefined && trackCount + 1 > limits.tracks) {
      throw new ToolError("edition_limit", `Live ${host.edition()} allows at most ${limits.tracks} tracks and the ears recording needs a free one.`, { resource: "tracks", limit: limits.tracks, current: trackCount, edition: host.edition() });
    }
    this.expectedIndex = trackCount;

    // Step 3: the temporary track.
    this.touched = true;
    try {
      const created = await this.call("track_create", { type: "audio", name: EARS_TRACK_NAME, index: -1, ears_internal: true }, true);
      this.earsIndex = asNumber(asObject(created["track"])["index"]);
      if (this.earsIndex === undefined) throw new ToolError("internal_error", "Live did not say which track it created.", { stage: "create" });
    } catch (error) {
      if (error instanceof ToolError && ["edition_limit", "invalid_args", "not_supported", "out_of_range"].includes(error.code) && error.details?.["outcome_unknown"] !== true) this.touched = false;
      throw error;
    }

    // Step 4: route the input.
    await this.route(sourceItem, sourceName);

    // Step 5: silence and arm in one batch.
    try {
      await this.call("routing_set", { track: this.earsRef, output_type: "No Output" }, true);
    } catch (error) {
      if (!(error instanceof ToolError) || error.code !== "not_found") throw error;
    }
    const armed = await this.call("batch", {
      ops: [
        { cmd: "track_set", args: { track: this.earsRef, mute: true, monitoring_state: 2 } },
        { cmd: "track_set", args: { track: this.earsRef, arm: true } },
      ],
      stop_on_error: true,
    }, true);
    for (const result of asArray(armed["results"]).map(asObject)) {
      if (result["ok"] !== true) {
        const failure = asObject(result["error"]);
        throw new ToolError(asString(failure["code"]) ?? "lom_error", asString(failure["message"]) ?? "Live refused to arm the temporary track.", asObject(failure["details"]));
      }
    }
    if (asArray(armed["results"]).length < 2) throw new ToolError("internal_error", "The arm step did not run completely.", { stage: "arm" });

    // Step 6 and 7: play and record.
    if (!this.wasPlaying) {
      this.startedTransport = true;
      await this.call("transport", { action: "start" }, true);
    }
    this.fired = true;
    await this.call("slot_fire", { track: this.earsRef, slot: 0, record_length: beats, launch_quantization: 0 }, true);

    // Step 8: wait for the recording.
    await this.waitForRecording(beats, asNumber(song["tempo"]) ?? 120);

    // Step 9: the file.
    const clip = asObject((await this.retryRead("clip_get", { clip: { kind: "session", track: this.earsRef, slot: 0 } }))["clip"]);
    const filePath = asString(clip["file_path"]);
    if (filePath === undefined) throw new ToolError("not_found", "Live did not report a file for the recorded clip.", { reason: "no_file_path" });
    const file = openAudioFile(filePath, {
      home: this.o.files.home,
      roots: [...liveRecordingRoots(this.o.files.home), ...config.roots],
      setRoots: config.setRoots,
      maxBytes: config.maxBytes,
      ...(this.o.files.uid === undefined ? {} : { uid: this.o.files.uid }),
      deferHeader: true,
    });
    try {
      await this.finalize(file);

      // Step 10: stop and put things back.
      this.stopped = true;
      try {
        await this.call("slot_stop", { track: this.earsRef, slot: 0 }, true);
      } catch (error) {
        if (error instanceof McpCancelledError) throw error;
        this.warnings.push("slot_stop_failed");
      }
      await this.restoreState();

      // Step 11: analyze.
      const bytes = file.readAll();
      const info = { path: file.realPath, size: bytes.length }; // before the analysis: it takes the buffer over
      const report = await this.o.analyzer.analyze(bytes, this.signal);
      return { report, source: { kind: asString(sourceItem["kind"]) ?? "track", index: asNumber(sourceItem["index"]) ?? null, name: safeText(sourceName, 128) }, beats, file: info, warnings: [...this.warnings] };
    } finally {
      file.close();
    }
  }

  /**
   * Rule 5 of docs/01-protocol.md 5.6. The tracks to show are the script's own list of external-live tracks (song_info,
   * which also covers External devices) plus, best effort, an armed or monitored audio track whose input is not a track,
   * Resampling or No Input. The owner sees every one of them and the job's acknowledgement is bound to exactly that set;
   * the script's own gate at the arm stays the authority.
   */
  private async gate(list: Json[], song: Json): Promise<void> {
    const listed = list.filter((item) => item["kind"] !== "master");
    const display = (item: Json): string => (item["kind"] === "return" ? `${String.fromCharCode(65 + (asNumber(item["index"]) ?? 0))}-${asString(item["name"]) ?? ""}` : (asString(item["name"]) ?? ""));
    const candidates = list.filter((item) => item["kind"] === "track" && item["has_audio_input"] === true && item["has_midi_input"] !== true && (item["arm"] === true || item["monitoring_state"] === 0)).slice(0, 32);
    const found = new Map<string, string>();
    for (const entry of asArray(song["external_live_tracks"]).map(asObject)) {
      const id = asString(entry["id"]);
      if (id !== undefined && TRACK_ID.test(id)) found.set(id, safeText(entry["name"]));
    }
    for (const item of candidates) {
      const routing = await this.read("routing_get", { track: { kind: "track", index: item["index"], expect_name: item["name"] } });
      const type = asString(asObject(routing["input"])["type"]) ?? "";
      const matches = listed.filter((other) => asString(other["name"]) === type || display(other) === type).length;
      const safe = type === "Resampling" || type === "No Input" || (type !== "Ext. In" && matches === 1);
      if (!safe) found.set(`t${asNumber(item["index"]) ?? 0}`, safeText(item["name"]));
    }
    const rank = (id: string): number => (id === "m" ? 2e6 : (id.startsWith("r") ? 1e6 : 0) + Number(id.slice(1)));
    const ids = [...found.keys()].sort((x, y) => rank(x) - rank(y));
    const external = ids.map((id) => found.get(id) ?? "");
    if (ids.length > 0 && this.o.confirmExternal !== undefined) {
      if (!(await this.o.confirmExternal(external))) throw new EarsDeclined();
      this.acknowledged = ids;
      return;
    }
    if (ids.length > 0) {
      throw new ToolError("not_supported", "A track with an external audio input (a microphone or interface) or an External device is live, so BatutaMCP will not record anything. Disarm or unload it, then try again.", { reason: "external_input_live", tracks: external });
    }
  }

  private async pickSource(list: Json[]): Promise<Json> {
    const resolver = new Resolver((cmd, args) => this.read(cmd, args));
    const ref = await resolver.resolveTrack(this.request.source, false);
    const kind = asString(ref["kind"]);
    const index = asNumber(ref["index"]);
    const found = list.find((item) => item["kind"] === kind && (kind === "master" || item["index"] === index));
    if (found === undefined) throw notFound("The source track does not exist.", { what: "track", kind: kind ?? null, index: index ?? null });
    const expected = asString(ref["expect_name"]);
    if (expected !== undefined && expected !== found["name"]) {
      throw notFound("The source track has a different name than expected; nothing was changed.", { reason: "name_mismatch", what: "track", expected: safeText(expected), actual: safeText(found["name"]) });
    }
    return found;
  }

  private beatsFor(song: Json): number {
    const { beats, bars } = this.request;
    const limit = this.o.config.maxBeats;
    let value: number;
    if (bars !== undefined) {
      if (beats !== undefined) throw new ToolError("invalid_args", "Give beats or bars, not both.", { reason: "beats_and_bars" });
      const signature = asArray(song["signature"]);
      const numerator = asNumber(signature.at(0)) ?? 4;
      const denominator = asNumber(signature.at(1)) ?? 4;
      value = bars * numerator * (4 / denominator);
    } else value = beats ?? 16;
    if (!Number.isFinite(value) || value < 1 || value > limit) {
      throw new ToolError("invalid_args", `The recording must be between 1 and ${limit} beats.`, { reason: "beats_out_of_range", beats: Number.isFinite(value) ? value : null, max_beats: limit });
    }
    return value;
  }

  private async route(source: Json, sourceName: string): Promise<void> {
    const kind = asString(source["kind"]);
    if (kind === "master") {
      const routing = asObject((await this.read("routing_get", { track: this.earsRef }))["input"]);
      if (!asArray(routing["available_types"]).includes("Resampling")) throw new ToolError("not_supported", "This Live edition offers no Resampling input, which measuring the master needs.", { reason: "resampling_unavailable" });
      await this.call("routing_set", { track: this.earsRef, input_type: "Resampling" }, true);
      return;
    }
    const available = asArray(asObject((await this.read("routing_get", { track: this.earsRef }))["input"])["available_types"]).filter((t): t is string => typeof t === "string");
    const letter = String.fromCharCode(65 + (asNumber(source["index"]) ?? 0));
    const candidates = kind === "return" ? [`${letter}-${sourceName}`, sourceName] : [sourceName];
    const type = candidates.find((candidate) => available.includes(candidate));
    // A name that is also one of Live's own non-track inputs could be the external input; localized names cannot be told apart here [A].
    if (type !== undefined && NON_TRACK_INPUTS.has(type)) {
      throw new ToolError("not_supported", "The source track is named like one of Live's own inputs (Ext. In, Resampling, No Input), so its input cannot be told apart from it. Rename the track and try again.", { reason: "unsafe_source_name" });
    }
    if (type === undefined) throw new ToolError("not_supported", "Live does not offer this track as an input of the temporary track in this edition.", { reason: "source_not_routable" });
    if (available.filter((t) => t === type).length > 1) {
      throw new ToolError("invalid_args", "More than one input has the source's name, so the right one cannot be chosen; rename one of the tracks.", { reason: "ambiguous_input" });
    }
    try {
      await this.call("routing_set", { track: this.earsRef, input_type: type, input_channel: "Post Mixer" }, true);
    } catch (error) {
      if (!(error instanceof ToolError) || error.code !== "not_found") throw error;
      try {
        await this.call("routing_set", { track: this.earsRef, input_channel: "Post FX" }, true);
      } catch (second) {
        if (second instanceof ToolError && second.code === "not_found") {
          throw new ToolError("not_supported", "Live offers neither a Post Mixer nor a Post FX tap for this source.", { reason: "no_post_mixer" });
        }
        throw second;
      }
    }
  }

  private async waitForRecording(beats: number, tempo: number): Promise<void> {
    const limitMs = Math.min(300, ((beats * 60) / tempo) * 1.5 + 5) * 1000;
    const start = this.clock.now();
    for (;;) {
      const status = await this.retryRead("slot_status", { track: this.earsRef, slot: 0 });
      if (status["has_clip"] === true && status["is_recording"] !== true && status["is_triggered"] !== true) return;
      if (this.clock.now() - start - this.outageSoFar() > limitMs) {
        throw new ToolError("timeout", "The recording did not finish in time.", { stage: "recording", limit_ms: Math.round(limitMs) });
      }
      this.checkDeadline();
      await this.clock.sleep(this.timing.pollMs);
    }
  }

  /** Two equal sizes in a row, and a size that agrees with the header (the file can still grow after is_recording turns false [A]). */
  private async finalize(file: EarsFile): Promise<void> {
    const start = this.clock.now();
    let previous = -1;
    for (;;) {
      this.checkSignal();
      const size = file.sizeNow();
      let complete = false;
      try {
        file.refreshLayout();
        complete = file.isComplete();
      } catch (error) {
        if (!(error instanceof ToolError) || DEFINITE_HEADER_REASONS.has(String(error.details?.["reason"]))) throw error;
      }
      if (complete && size === previous) return;
      previous = size;
      if (this.clock.now() - start >= this.timing.finalizeMaxMs) {
        throw new ToolError("timeout", "The recorded file did not settle (it kept changing or is shorter than its header says).", { stage: "finalize" });
      }
      await this.clock.sleep(this.timing.finalizeMs);
    }
  }

  /** Selection, re-arm and transport as the owner had them; best effort, each failure a warning. Runs once. */
  async restoreState(): Promise<void> {
    if (this.restored) return;
    this.restored = true;
    const soft = async (what: string, run: () => Promise<unknown>): Promise<void> => {
      try {
        await run();
      } catch (error) {
        if (error instanceof McpCancelledError) throw error;
        this.warnings.push(what);
      }
    };
    if (this.selectedBefore !== undefined) {
      const before = this.selectedBefore;
      await soft("selection_not_restored", async () => {
        const song = await this.restoreRead("song_info", {});
        const now = asObject(song["selected_track"]);
        if (now["kind"] !== before["kind"] || now["index"] !== before["index"]) await this.restoreCall("track_select", { track: before });
      });
    }
    if (this.armedBefore.length > 0) {
      let current: Json[] = [];
      await soft("rearm_failed", async () => { current = (await this.restoreRead("track_list", { include_returns: false, include_master: false, limit: 500 }))["items"] as Json[]; });
      for (const was of this.armedBefore) {
        const item = asArray(current).map(asObject).find((t) => t["index"] === was.index && t["kind"] === "track");
        if (item === undefined || item["arm"] === true) continue;
        try {
          await this.restoreCall("track_set", { track: { kind: "track", index: was.index, expect_name: was.name }, arm: true });
        } catch (error) {
          if (error instanceof McpCancelledError) throw error;
          this.warnings.push(`rearm_failed:${was.index}`);
        }
      }
    }
    if (this.startedTransport) {
      await soft("transport_not_restored", async () => {
        await this.restoreCall("transport", { action: "stop" });
        await this.restoreCall("song_set_time", { time: this.songTime });
      });
    }
  }

  // Restore and cleanup never stop for a cancelled job: they use their own signal.
  private cleanupSignal = new AbortController().signal;
  private async restoreCall(cmd: string, args: Json): Promise<Json> {
    try {
      return asObject(await this.o.host.call(cmd, args, this.cleanupSignal, undefined, this.acknowledged));
    } catch (error) {
      throw asToolError(error, true);
    }
  }
  private restoreRead(cmd: string, args: Json): Promise<Json> {
    return this.restoreCall(cmd, args);
  }

  // ------------------------------------------------------------------ cleanup

  async cleanup(): Promise<{ status: "ok" | "failed"; manual?: string }> {
    if (!this.touched) return { status: "ok" };
    try {
      // Reconnect first: the restore steps need the connection, and they run only once.
      await this.o.host.ready(this.timing.reconnectMs);
      if (this.fired && !this.stopped && this.earsIndex !== undefined) {
        try { await this.restoreCall("slot_stop", { track: this.earsRef, slot: 0 }); } catch { /* the track goes away next */ }
      }
      await this.restoreState();
      return await this.removeTrack();
    } catch {
      return { status: "failed", manual: MANUAL };
    }
  }

  /** Find the track we created (not a lookalike), delete it with the name guard, retry once. */
  private async removeTrack(): Promise<{ status: "ok" | "failed"; manual?: string }> {
    const find = async (): Promise<{ found: "none" | "mismatch" | "ours"; index?: number }> => {
      const items = (await this.restoreRead("track_list", { include_returns: false, include_master: false, limit: 500 }))["items"];
      const named = asArray(items).map(asObject).filter((item) => asString(item["name"]) === EARS_TRACK_NAME && item["kind"] === "track");
      if (named.length === 0) return { found: "none" };
      const only = named.at(0) as Json;
      const expected = this.earsIndex ?? this.expectedIndex;
      const genuine = named.length === 1 && only["index"] === expected && only["has_audio_input"] === true && only["has_midi_input"] !== true && asNumber(only["device_count"]) === 0;
      return genuine ? { found: "ours", index: expected as number } : { found: "mismatch" };
    };
    let state = await find();
    if (state.found === "none") {
      if (this.earsIndex === undefined) return { status: "ok" };
      this.warnings.push("ears_track_missing");
      return { status: "failed", manual: MANUAL };
    }
    if (state.found === "mismatch") {
      this.warnings.push("cleanup_identity_mismatch");
      return { status: "failed", manual: MANUAL };
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.o.host.deleteEarsTrack(state.index as number, this.cleanupSignal);
        return { status: "ok" };
      } catch (error) {
        if (attempt === 1 || !(error instanceof ToolError) || !["lom_error", "timeout", "connection_lost", "not_connected"].includes(error.code)) break;
        await this.clock.sleep(this.timing.deleteRetryMs);
        state = await find();
        if (state.found === "none") return { status: "ok" };
        if (state.found !== "ours") { this.warnings.push("cleanup_identity_mismatch"); break; }
      }
    }
    return { status: "failed", manual: MANUAL };
  }

  get elapsed(): number {
    return Math.round(this.clock.now() - this.started);
  }

  /** The temporary track may exist (or have existed): the cleanup had work to look for. */
  get changedTheSet(): boolean {
    return this.touched;
  }

  get collectedWarnings(): string[] {
    return this.warnings;
  }
}

/** Run one ears job. Resolves with the report, or rejects with a ToolError whose details say how the cleanup went. */
export async function runEarsJob(request: EarsRequest, options: EarsJobOptions, signal: AbortSignal): Promise<EarsOutcome> {
  const job = new Job(request, options, signal);
  let outcome: Awaited<ReturnType<Job["steps"]>> | undefined;
  let failure: unknown;
  try {
    outcome = await job.steps();
  } catch (error) {
    failure = error;
  }
  const cleanup = await job.cleanup();
  if (outcome !== undefined) {
    const warnings = job.collectedWarnings;
    return { ...outcome, warnings: [...warnings], cleanup: cleanup.status, ...(cleanup.manual === undefined ? {} : { manual: cleanup.manual }), elapsed_ms: job.elapsed };
  }
  if (cleanup.status === "failed") {
    const original = failure instanceof ToolError ? { code: failure.code, message: failure.message } : failure instanceof McpCancelledError ? { code: "cancelled", message: failure.message } : { code: "internal_error", message: String((failure as Error)?.message ?? failure).slice(0, 200) };
    throw new ToolError("cleanup_failed", "The temporary track batuta-ears could not be removed.", { manual: cleanup.manual ?? MANUAL, original, warnings: job.collectedWarnings });
  }
  if (failure instanceof McpCancelledError) throw failure;
  if (failure instanceof ToolError) {
    throw new ToolError(failure.code, failure.message, { ...(failure.details ?? {}), ...(job.changedTheSet ? { cleanup: "ok" } : {}), ...(job.collectedWarnings.length > 0 ? { warnings: job.collectedWarnings } : {}) });
  }
  throw failure;
}

