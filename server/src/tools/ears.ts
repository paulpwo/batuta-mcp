import type { ServerConfig } from "../config/index.js";
import { EarsService } from "../ears/service.js";
import type { EarsServiceDeps } from "../ears/service.js";
import type { EarsHost } from "../ears/job.js";
import type { ToolAnnotations, ToolContext, ToolRegistry, ToolResult } from "../mcp/index.js";
import { ToolError } from "../mcp/index.js";
import type { Schema } from "../validate/index.js";
import { effectiveEdition } from "./edition.js";
import type { Executor } from "./exec.js";
import type { LiveApi } from "./live-api.js";
import { TRACK_SEL, bool, int, obj, str } from "./schemas.js";
import { asNumber, asObject } from "./util.js";
import type { Json } from "./util.js";

/**
 * The ears tools (docs/01-protocol.md section 10): measure a track or the master by recording it inside
 * Live, analyze a file, compare two measurements. None of them asks for confirmation: the recording uses a
 * temporary track of its own that is removed again, and the rest only reads. `destructive: "disabled"`
 * does not hide them for the same reason (section 9.3 item 4).
 */

type Annotations = ToolAnnotations & { readOnlyHint: boolean };
const MEASURES: Annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const READS: Annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const BEATS = int(1, 64, "Beats to record (1..64, default 16) at the current tempo; the recording takes that long in real time.");
const BARS = int(1, 16, "Bars to record instead of beats, using the song's time signature (at most 64 beats).");
const SPECTRUM = bool("Include the ten octave bands of the spectrum in the report (default true).");
const SOURCE = { ...TRACK_SEL, description: 'What to measure: {"kind":"track"|"return","index":n}, {"kind":"master"} or {"name":"..."}. The signal is taken after the fader (Post Mixer), so mute and volume count.' } as Schema;

export interface EarsToolInfo {
  name: string;
  title: string;
  description: string;
  properties: Record<string, Schema>;
  required: string[];
  annotations: Annotations;
}

const WHAT = "Report (docs/01-protocol.md 10.6): integrated, short-term max and momentary max LUFS, LRA, true peak, sample peak, RMS, crest, ten octave-band levels (0 dB = a full-scale sine) and the L/R correlation, plus warnings.";

/** The ears tools, in registration order (docs/03-tool-names.md is generated from this). */
export const EARS_TOOLS: readonly EarsToolInfo[] = [
  {
    name: "batuta_ears", title: "Measure a track or the master",
    description: `Measure loudness and spectrum by recording the source inside Live for the given number of beats. It creates a temporary audio track named batuta-ears fed from the source (after the fader), records, reads the file Live wrote, analyzes it and removes the temporary track again. Real time: the song plays while it records. It never records a microphone or an audio interface: it refuses while any track with an external input is armed or monitored. One measurement at a time. It does not ask for confirmation; the set is marked modified and Live's undo history gets several entries, so do not press Undo blindly afterwards. The recorded file stays in Live's folder. Lite needs a free track slot. ${WHAT}`,
    properties: { source: SOURCE, beats: BEATS, bars: BARS, spectrum: SPECTRUM }, required: ["source"], annotations: MEASURES,
  },
  {
    name: "record_and_analyze", title: "Record and analyze",
    description: "Same as batuta_ears. Give track_index (a regular track) or a source selector (track, return, master or a name), and beats or bars.",
    properties: { track_index: int(0, undefined, "Regular track index (0-based)."), source: SOURCE, beats: BEATS, bars: BARS, spectrum: SPECTRUM }, required: [], annotations: MEASURES,
  },
  {
    name: "analyze_audio", title: "Analyze an audio file",
    description: `Analyze an existing WAV or AIFF file (mono or stereo, up to 300 s) without recording anything. Read-only: nothing is written. Any absolute path is accepted unless sample_roots or ears.roots are configured, which then limit it (Live's recording folders and Samples/Recorded folders stay allowed); symlinks, hard links, odd characters, other file types and files over the size limit are refused. ${WHAT}`,
    properties: { path: str(1024, 1, "Absolute path of the .wav, .aif or .aiff file.") }, required: ["path"], annotations: READS,
  },
  {
    name: "compare_audio", title: "Compare two measurements",
    description: "Compare two audio sources metric by metric (deltas are b minus a). Each of a and b is an absolute file path (same rules as analyze_audio) or the result_id of an earlier batuta_ears, record_and_analyze or analyze_audio result of this session.",
    properties: { a: str(1024, 1, "File path or result_id."), b: str(1024, 1, "File path or result_id.") }, required: ["a", "b"], annotations: READS,
  },
];

export interface EarsDeps {
  /** Home folder (for Live's recording folders and Samples/Recorded); tests point it at a scratch folder. */
  home?: string;
  uid?: number;
  clock?: EarsServiceDeps["clock"];
  timing?: EarsServiceDeps["timing"];
  analyzer?: EarsServiceDeps["analyzer"];
}

/** The ears flow's channel to the script: a fixed command set on the executor. */
export function earsHost(executor: Executor, live: LiveApi, config: ServerConfig): EarsHost {
  return {
    prepare: () => executor.earsPrepare(),
    call: (cmd, args, signal, timeoutMs, externalInputAck) => executor.earsCall(cmd, args, signal, timeoutMs, externalInputAck),
    deleteEarsTrack: (index, signal) => executor.deleteEarsTrack(index, signal),
    ready: async (timeoutMs) => { await live.ready(timeoutMs); },
    edition: () => effectiveEdition(config.edition, live.welcome?.edition),
    hold: () => live.hold?.() ?? (() => undefined),
  };
}

export function createEarsService(executor: Executor, live: LiveApi, config: ServerConfig, deps: EarsDeps = {}): EarsService {
  return new EarsService({
    host: earsHost(executor, live, config), config,
    ...(deps.home === undefined ? {} : { home: deps.home }), ...(deps.uid === undefined ? {} : { uid: deps.uid }),
    ...(deps.clock === undefined ? {} : { clock: deps.clock }), ...(deps.timing === undefined ? {} : { timing: deps.timing }), ...(deps.analyzer === undefined ? {} : { analyzer: deps.analyzer }),
  });
}

function schemaOf(info: EarsToolInfo): Schema {
  return obj(info.properties, info.required);
}

function measurement(args: Json): { request: { source: Json; beats?: number; bars?: number }; spectrum: boolean } {
  const beats = asNumber(args["beats"]);
  const bars = asNumber(args["bars"]);
  return { request: { source: asObject(args["source"]), ...(beats === undefined ? {} : { beats }), ...(bars === undefined ? {} : { bars }) }, spectrum: args["spectrum"] !== false };
}

/** `ask` puts the external-input question to the owner (the executor's elicitation); without it the flow refuses as before. */
export function registerEarsTools(registry: ToolRegistry, service: EarsService, executor?: Executor): void {
  const confirmFor = (context: ToolContext): ((tracks: string[]) => Promise<boolean>) | undefined =>
    executor === undefined ? undefined : (tracks) => executor.askExternalInput(tracks, "Measure by recording in Live", context);
  const handlers: Record<string, (args: Json, context: ToolContext) => Promise<ToolResult>> = {
    batuta_ears: (args, context) => {
      const { request, spectrum } = measurement(args);
      return service.record(request, spectrum, context.signal, confirmFor(context));
    },
    record_and_analyze: (args, context) => {
      const index = asNumber(args["track_index"]);
      const given = args["source"] !== undefined;
      if ((index === undefined) === !given) {
        return Promise.reject(new ToolError("invalid_args", "Give either track_index or source, not both and not neither.", { reason: "source_or_track_index" }));
      }
      const { request, spectrum } = measurement(index === undefined ? args : { ...args, source: { kind: "track", index } });
      return service.record(request, spectrum, context.signal, confirmFor(context));
    },
    analyze_audio: (args, context) => service.analyzeFile(String(args["path"]), context.signal),
    compare_audio: (args, context) => service.compare(String(args["a"]), String(args["b"]), context.signal),
  };
  for (const info of EARS_TOOLS) {
    const handler = new Map(Object.entries(handlers)).get(info.name);
    if (handler === undefined) continue;
    registry.register({ name: info.name, title: info.title, description: info.description, inputSchema: schemaOf(info), annotations: info.annotations, handler });
  }
}
