import fs from "node:fs";
import path from "node:path";
import { LiveError } from "../../src/live/index.js";
import type { Edition } from "../../src/live/index.js";
import { asToolError } from "../../src/tools/errors.js";
import type { EarsClock, EarsHost } from "../../src/ears/job.js";
import type { Reply } from "./fake-script.js";
import type { Json } from "./mcp-client.js";

/**
 * A small stateful model of the parts of a Live set that the ears flow (docs/01-protocol.md section 10)
 * touches, with the script's recording-safety rules (section 5.6) in the places the flow depends on.
 * `handle` is the whole script surface; `WorldHost` plugs it into the job directly (no sockets) and
 * `answers()` plugs it into the socket rig of the tool-level tests.
 */

export interface WTrack {
  name: string;
  audio: boolean;
  arm: boolean;
  mute: boolean;
  solo: boolean;
  monitoring: number;
  devices: number;
  inputType: string;
  inputChannel: string;
  outputType: string;
}

export interface Failure {
  cmd: string;
  match?: (args: Json) => boolean;
  /** How many matching calls fail (default 1). */
  times?: number;
  error?: { code: string; message?: string; details?: Json };
  /** Drop the connection instead of answering (the outcome is unknown to the caller). */
  drop?: boolean;
  /** The command had already taken effect when it failed (with `drop` or with an error). */
  applied?: boolean;
  /** With `error`: the caller cannot tell whether it ran. */
  outcomeUnknown?: boolean;
}

const COMMANDS = ["song_info", "track_list", "track_create", "routing_get", "routing_set", "batch", "track_set", "transport", "slot_fire", "slot_status", "clip_get", "slot_stop", "song_set_time", "track_select", "track_delete", "device_list"] as const;

export function track(name: string, audio = false): WTrack {
  return { name, audio, arm: false, mute: false, solo: false, monitoring: 1, devices: 0, inputType: audio ? "Ext. In" : "", inputChannel: "1", outputType: "Master" };
}

export class EarsWorld {
  tracks: WTrack[] = [track("Drums"), track("Bass"), track("Vox", true)];
  returns: WTrack[] = [track("A-Reverb")];
  tempo = 120;
  signature: [number, number] = [4, 4];
  isPlaying = false;
  time = 12.5;
  recordMode = false;
  sessionRecord = false;
  selected: Json = { kind: "track", index: 1 };
  edition: Edition = "suite";
  /** Lite-style script-side track limit (undefined: none). */
  trackLimit: number | undefined = undefined;
  exclusiveArm = false;
  externalLive = false;
  /** Tracks (by index) that hold an External device: the script lists them in song_info.external_live_tracks. */
  externalDevices: number[] = [];
  /** Channels offered by a track-type input. */
  channels = ["Pre FX", "Post FX", "Post Mixer"];
  /** `slot_status` polls that report recording before the clip exists. */
  recordPolls = 2;
  /** Where the recording lands and what it holds; the file is written when the recording completes. */
  filePath = "";
  recording: Buffer | (() => Buffer) = Buffer.alloc(0);
  failures: Failure[] = [];
  calls: Array<{ cmd: string; args: Json }> = [];
  /** Called after every handled command (to simulate the user doing something). */
  afterCall: ((cmd: string, args: Json) => void) | undefined = undefined;
  down = false;
  /** Show returns in routing lists as "A-Name", "B-Name" (the form Live lists them in [A]). */
  returnPrefix = false;

  private earsIndex: number | undefined = undefined;
  private rec: { beats: number; polls: number } | undefined = undefined;
  private clip = false;
  private lastBeats = 0;

  names(cmd?: string): string[] {
    return this.calls.filter((c) => cmd === undefined || c.cmd === cmd).map((c) => c.cmd);
  }
  mutations(): Array<{ cmd: string; args: Json }> {
    const reads = new Set(["song_info", "track_list", "routing_get", "slot_status", "clip_get", "device_list"]);
    return this.calls.filter((c) => !reads.has(c.cmd));
  }
  earsTrackIndex(): number | undefined { return this.earsIndex; }
  hasEarsTrack(): boolean { return this.tracks.some((t) => t.name === "batuta-ears"); }

  private info(kind: "track" | "return" | "master", index: number | null, t: WTrack): Json {
    return {
      kind, index, name: t.name, color: 0, mute: kind === "master" ? null : t.mute, solo: kind === "master" ? null : t.solo, arm: kind === "track" ? t.arm : null,
      can_be_armed: kind === "track", has_midi_input: kind === "track" && !t.audio, has_audio_input: kind === "track" && t.audio, is_foldable: false,
      fold_state: null, group_track_index: null, monitoring_state: kind === "track" ? t.monitoring : null, device_count: t.devices,
    };
  }

  private trackAt(ref: Json): WTrack {
    if (ref["kind"] === "master") return track("Master");
    const list = ref["kind"] === "return" ? this.returns : this.tracks;
    const t = typeof ref["index"] === "number" ? list[ref["index"]] : undefined;
    if (t === undefined) throw new LiveError("not_found", "no such track", { details: { what: "track", index: ref["index"] } });
    if (typeof ref["expect_name"] === "string" && ref["expect_name"] !== t.name) {
      throw new LiveError("not_found", "track name mismatch", { details: { reason: "name_mismatch", expected: ref["expect_name"], actual: t.name } });
    }
    return t;
  }

  private isEars(t: WTrack): boolean {
    return this.earsIndex !== undefined && this.tracks[this.earsIndex] === t;
  }

  private displayNames(): string[] {
    return [...this.tracks.map((x) => x.name), ...this.returns.map((x, i) => (this.returnPrefix ? `${String.fromCharCode(65 + i)}-${x.name}` : x.name))];
  }

  private safeInput(t: WTrack): boolean {
    const names = this.displayNames();
    return t.inputType === "Resampling" || t.inputType === "No Input" || names.includes(t.inputType);
  }

  private availableTypes(t: WTrack): string[] {
    const own = this.tracks.includes(t) ? this.tracks.indexOf(t) : -1;
    return ["No Input", "Ext. In", "Resampling", ...this.displayNames().filter((_, i) => i !== own)];
  }

  private blocked(code: string, message: string, reason: string): LiveError {
    return new LiveError(code as never, message, { details: { reason } });
  }

  private setProps(ref: Json, args: Json): Json {
    const t = this.trackAt(ref);
    if (args["arm"] === true) {
      if (t.audio && !this.isEars(t)) throw this.blocked("not_supported", "audio tracks cannot be armed", "audio_arm_blocked");
      if (t.audio && !this.safeInput(t)) throw this.blocked("not_supported", "unsafe input", "audio_arm_blocked");
      if (t.audio && this.externalLive) throw this.blocked("not_supported", "an external input is live", "external_input_live");
      if (this.exclusiveArm) for (const other of this.tracks) other.arm = false;
      t.arm = true;
    } else if (args["arm"] === false) t.arm = false;
    if (typeof args["mute"] === "boolean") t.mute = args["mute"];
    if (typeof args["solo"] === "boolean") t.solo = args["solo"];
    if (typeof args["monitoring_state"] === "number") t.monitoring = args["monitoring_state"];
    if (typeof args["name"] === "string") t.name = args["name"];
    const index = ref["kind"] === "return" ? this.returns.indexOf(t) : this.tracks.indexOf(t);
    return { track: this.info(ref["kind"] === "return" ? "return" : "track", index, t) };
  }

  handle(cmd: string, args: Json): Json {
    this.calls.push({ cmd, args: JSON.parse(JSON.stringify(args)) as Json });
    const failure = this.failures.find((f) => f.cmd === cmd && (f.times ?? 1) > 0 && (f.match?.(args) ?? true));
    if (failure !== undefined) {
      failure.times = (failure.times ?? 1) - 1;
      if (failure.applied === true) this.apply(cmd, args);
      if (failure.drop === true) {
        throw new LiveError("connection_lost", "The connection to Live was lost", { outcomeUnknown: true });
      }
      throw new LiveError((failure.error?.code ?? "lom_error") as never, failure.error?.message ?? "injected failure", { ...(failure.error?.details === undefined ? {} : { details: failure.error.details }), ...(failure.outcomeUnknown === true ? { outcomeUnknown: true } : {}) });
    }
    const result = this.apply(cmd, args);
    this.afterCall?.(cmd, args);
    return result;
  }

  private apply(cmd: string, args: Json): Json {
    switch (cmd) {
      case "song_info":
        return {
          tempo: this.tempo, signature: this.signature, is_playing: this.isPlaying, current_song_time: this.time, record_mode: this.recordMode, session_record: this.sessionRecord,
          track_count: this.tracks.length, return_count: this.returns.length, scene_count: 3, selected_track: this.selected, pending_sweeps: 0, recent_sweeps: [],
          external_live_tracks: this.tracks.flatMap((t, i) => (this.externalDevices.includes(i) || (t.audio && !this.isEars(t) && !this.safeInput(t) && (t.arm || t.monitoring === 0)) ? [{ id: `t${i}`, name: t.name }] : [])),
        };
      case "track_list": {
        const items: Json[] = this.tracks.map((t, i) => this.info("track", i, t));
        if (args["include_returns"] !== false) this.returns.forEach((t, i) => items.push(this.info("return", i, t)));
        if (args["include_master"] !== false) items.push(this.info("master", null, track("Master")));
        return { items, total: items.length, next_offset: null };
      }
      case "track_create": {
        if (args["type"] !== "audio" || args["name"] !== "batuta-ears" || args["ears_internal"] !== true) throw new LiveError("invalid_args", "the test world only creates the ears track");
        if (this.earsIndex !== undefined) throw new LiveError("invalid_args", "an ears track already exists", { details: { reason: "ears_exists" } });
        if (this.trackLimit !== undefined && this.tracks.length >= this.trackLimit) throw new LiveError("edition_limit", "limit", { details: { resource: "tracks", limit: this.trackLimit, current: this.tracks.length, edition: "lite" } });
        const t = track("batuta-ears", true);
        t.inputType = "No Input";
        this.tracks.push(t);
        this.earsIndex = this.tracks.length - 1;
        this.selected = { kind: "track", index: this.earsIndex };
        return { track: this.info("track", this.earsIndex, t) };
      }
      case "routing_get": {
        const t = this.trackAt(args["track"] as Json);
        const returnNames = this.returns.map((x) => x.name);
        return {
          input: { type: t.inputType, channel: t.inputChannel, available_types: this.availableTypes(t), available_channels: this.safeInput(t) && t.inputType !== "Resampling" && t.inputType !== "No Input" ? this.channels : [] },
          output: { type: t.outputType, channel: "", available_types: ["Master", "No Output", ...returnNames], available_channels: [] },
        };
      }
      case "routing_set": {
        const t = this.trackAt(args["track"] as Json);
        if (typeof args["input_type"] === "string") {
          if (!this.availableTypes(t).includes(args["input_type"])) throw new LiveError("not_found", "no such routing option", { details: { available: this.availableTypes(t) } });
          t.inputType = args["input_type"];
          t.inputChannel = "";
        }
        if (typeof args["input_channel"] === "string") {
          const channels = this.safeInput(t) && t.inputType !== "Resampling" && t.inputType !== "No Input" ? this.channels : [];
          if (!channels.includes(args["input_channel"])) throw new LiveError("not_found", "no such routing channel", { details: { available: channels } });
          t.inputChannel = args["input_channel"];
        }
        if (typeof args["output_type"] === "string") {
          if (!["Master", "No Output", ...this.returns.map((x) => x.name)].includes(args["output_type"])) throw new LiveError("not_found", "no such output", { details: {} });
          t.outputType = args["output_type"];
        }
        return { routing: {} };
      }
      case "track_set": return this.setProps(args["track"] as Json, args);
      case "batch": {
        const ops = args["ops"] as Array<{ cmd: string; args: Json }>;
        const results: Json[] = [];
        let partial = false;
        for (const op of ops) {
          try {
            results.push({ ok: true, result: this.apply(op.cmd, op.args) });
            partial = true;
          } catch (error) {
            if (!(error instanceof LiveError)) throw error;
            results.push({ ok: false, error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) } });
            if (args["stop_on_error"] !== false) break;
          }
        }
        return { results, executed: results.length, partial: partial && results.some((r) => r["ok"] === false) };
      }
      case "transport":
        this.isPlaying = args["action"] !== "stop";
        return { is_playing: this.isPlaying, current_song_time: this.time };
      case "slot_fire": {
        const t = this.trackAt(args["track"] as Json);
        if (!this.isEars(t)) throw new LiveError("invalid_args", "the test world only records on the ears track");
        if (this.externalLive) throw this.blocked("not_supported", "an external input is live; recording is refused", "external_input_live");
        if (typeof args["record_length"] !== "number" || args["launch_quantization"] !== 0 || args["slot"] !== 0) throw new LiveError("invalid_args", "unexpected slot_fire arguments");
        this.rec = { beats: args["record_length"], polls: this.recordPolls + 1 };
        this.lastBeats = args["record_length"];
        return {};
      }
      case "slot_status": {
        const t = this.trackAt(args["track"] as Json);
        const base = { track: { kind: "track", index: this.tracks.indexOf(t) }, slot: 0 };
        if (this.rec !== undefined) {
          this.rec.polls -= 1;
          if (this.rec.polls > 0) return { ...base, has_clip: false, is_playing: false, is_recording: this.rec.polls < this.recordPolls, is_triggered: this.rec.polls >= this.recordPolls, clip: null };
          this.finishRecording();
        }
        return { ...base, has_clip: this.clip, is_playing: false, is_recording: false, is_triggered: false, clip: this.clip ? { name: "", length: this.lastBeats } : null };
      }
      case "clip_get": {
        if (!this.clip) throw new LiveError("not_found", "no clip in the slot", { details: { what: "clip" } });
        return { clip: { kind: "session", file_path: this.filePath, length: this.lastBeats, sample_rate: 48000, is_audio: true } };
      }
      case "slot_stop": this.rec = undefined; return {};
      case "song_set_time": this.time = args["time"] as number; return { current_song_time: this.time };
      case "track_select": {
        const ref = args["track"] as Json;
        this.trackAt(ref);
        this.selected = ref["kind"] === "master" ? { kind: "master" } : { kind: ref["kind"], index: ref["index"] };
        return { selected_track: this.selected };
      }
      case "track_delete": {
        const ref = args["track"] as Json;
        const t = this.trackAt(ref);
        const index = this.tracks.indexOf(t);
        this.tracks.splice(index, 1);
        if (this.earsIndex === index) { this.earsIndex = undefined; this.clip = false; this.rec = undefined; }
        else if (this.earsIndex !== undefined && this.earsIndex > index) this.earsIndex -= 1;
        if (this.selected["kind"] === "track" && typeof this.selected["index"] === "number" && this.selected["index"] >= index) this.selected = { kind: "track", index: Math.max(0, (this.selected["index"] as number) - 1) };
        return { deleted: { kind: "track", index, name: t.name } };
      }
      case "device_list": return { items: [], total: 0, next_offset: null };
      default: throw new LiveError("unknown_command", `no fake answer for ${cmd}`);
    }
  }

  private finishRecording(): void {
    this.rec = undefined;
    this.clip = true;
    if (this.isPlaying) this.time += this.lastBeats;
    if (this.filePath !== "") {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, typeof this.recording === "function" ? this.recording() : this.recording);
    }
  }

  /** Answers for the socket rig (`startRig({ answers })`). */
  answers(): Record<string, (args: Json, request: Json, reply: Reply) => unknown> {
    const out: Record<string, (args: Json, request: Json, reply: Reply) => unknown> = {};
    for (const cmd of COMMANDS) {
      out[cmd] = (args, _request, reply) => {
        try {
          return this.handle(cmd, args);
        } catch (error) {
          if (!(error instanceof LiveError)) throw error;
          if (error.code === "connection_lost") { reply.conn.destroy(); return undefined; }
          reply.fail(error.code, error.message, error.details);
          return undefined;
        }
      };
    }
    return out;
  }
}

/** The job's view of the script, backed directly by a world (no sockets). */
export class WorldHost implements EarsHost {
  prepared = 0;
  /** The acknowledgement flag of every call, in order. */
  acks: boolean[] = [];
  /** The ids each call was acknowledged with (undefined: not acknowledged). */
  ackIds: Array<string[] | undefined> = [];
  /** The commands, in the same order as `acks`. */
  cmds: string[] = [];
  constructor(readonly world: EarsWorld) {}
  prepare(): Promise<void> { this.prepared += 1; return Promise.resolve(); }
  async call(cmd: string, args: Json, signal: AbortSignal | undefined, _timeoutMs?: number, externalInputAck?: string[]): Promise<Json> {
    this.acks.push(externalInputAck !== undefined);
    this.ackIds.push(externalInputAck);
    this.cmds.push(cmd);
    await new Promise((resolve) => setImmediate(resolve));
    if (signal?.aborted === true) throw new LiveError("cancelled", "The call was cancelled", { details: { sent: false } });
    if (this.world.down) throw new LiveError("not_connected", "not connected", { details: { sent: false } });
    return this.world.handle(cmd, args);
  }
  async deleteEarsTrack(index: number): Promise<unknown> {
    try {
      return await this.call("track_delete", { track: { kind: "track", index, expect_name: "batuta-ears" }, expect_name: "batuta-ears" }, undefined);
    } catch (error) {
      throw asToolError(error, true);
    }
  }
  async ready(_timeoutMs?: number): Promise<void> {
    if (this.world.down) throw new LiveError("not_connected", "not connected");
  }
  edition(): Edition { return this.world.edition; }
}

export interface VClock extends EarsClock {
  onSleep: ((ms: number, count: number) => void) | undefined;
  sleeps: number;
  advance(ms: number): void;
}

/** A clock whose sleeps cost nothing: time only moves when the job sleeps. */
export function virtualClock(): VClock {
  let t = 0;
  const clock: VClock = {
    onSleep: undefined, sleeps: 0,
    now: () => t,
    advance: (ms) => { t += ms; },
    sleep: async (ms) => { t += ms; clock.sleeps += 1; clock.onSleep?.(ms, clock.sleeps); await new Promise((resolve) => setImmediate(resolve)); },
  };
  return clock;
}
