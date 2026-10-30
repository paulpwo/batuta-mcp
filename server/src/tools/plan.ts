import type { ServerConfig } from "../config/index.js";
import { commandForTool, specFor, isBatchable } from "./catalog.js";
import type { Edition } from "../live/index.js";
import { EditionGuard, effectiveEdition } from "./edition.js";
import { GainGuard } from "./gain.js";
import { ToolError } from "../mcp/index.js";
import type { ToolResult } from "../mcp/index.js";
import { Resolver } from "./resolve.js";
import type { ReadFn } from "./resolve.js";
import type { Classification, CommandSpec } from "./types.js";
import { validateSampleFile } from "./audio-path.js";
import { applyCompat } from "./compat.js";
import { trackLabel } from "./resolve.js";
import { asArray, asNumber, asObject, asString, invalidArgs, notFound, quoted, safeText } from "./util.js";
import type { Json } from "./util.js";

/** Reserved for the temporary track of the ears flow (docs/01-protocol.md section 5.6). */
export const RESERVED_TRACK_NAME = "batuta-ears";

/** Commands after which the indices of tracks, scenes or devices read earlier may no longer be valid. */
export const SHIFTING: ReadonlySet<string> = new Set([
  "track_create", "track_duplicate", "track_delete", "device_insert", "device_delete", "browser_load",
  "scene_create", "scene_duplicate", "scene_delete",
  // Not in the spec's list but they move scene or chain positions the same way.
  "scene_capture", "rack_insert_chain",
]);

/** The outcome of planning one command: wire arguments with every selector resolved and every guard applied. */
export interface OpPlan {
  spec: CommandSpec;
  /** Wire arguments (references only). */
  wire: Json;
  /** What the call targets, for summaries. */
  targets: string[];
  /** Why the call is destructive (empty when it is not). */
  reasons: string[];
  /** The gain guard reasons among `reasons` (they always ask, whatever the confirm policy). */
  gain: string[];
  /** Asks in the default confirm mode although Live could take it back: a model undo/redo (spec 9.1a). */
  irreversible: boolean;
  destructive: boolean;
  warnings: string[];
  /** For a batch: the plan of each op, in order. */
  children?: OpPlan[];
  /** A host automation action (docs/04-host-automation.md): it runs this instead of sending a command to the Remote Script. */
  host?: () => Promise<ToolResult>;
  /** The confirmation text of a host action, already built from static text and a validated path. */
  summaryText?: string;
}

export interface PlannerEnv {
  config: ServerConfig;
  /** Edition the welcome reported, if connected. */
  welcomeEdition: Edition | undefined;
  read: ReadFn;
  /** The stricter of the server's and the script's destructive class. */
  classOf: (spec: CommandSpec) => Classification;
  /** Throws a version error when the connected script cannot be trusted with this command. */
  assertUsable: (spec: CommandSpec) => void;
  /** Validate an op's arguments against the tool schema of its command; throws invalid_args. */
  validateOp: (spec: CommandSpec, args: unknown, op: number) => void;
}

/**
 * Plans the commands of one tool call. One planner serves a whole batch, so resolver listings are
 * shared and edition and gain checks see the effects of earlier ops.
 */
export class Planner {
  readonly resolver: Resolver;
  private readonly edition: EditionGuard;
  private readonly gain: GainGuard;
  /** The first command of this call that can shift indices; later refs cannot be pinned from the earlier listing. */
  private shifter: string | undefined;

  constructor(private readonly env: PlannerEnv) {
    this.resolver = new Resolver(env.read);
    this.gain = new GainGuard(env.config.gainGuard, env.read);
    this.edition = new EditionGuard(effectiveEdition(env.config.edition, env.welcomeEdition), env.read, (index) => this.resolver.groupDescendants(index));
  }

  /**
   * Deletes show Live's CURRENT name of what they remove, and guard it: the model's expect_name must
   * match, otherwise nobody is asked about something that cannot work. The confirmation text then
   * carries the real name, not model text.
   */
  private async guardDelete(spec: CommandSpec, resolved: { args: Json; targets: string[] }): Promise<void> {
    const args = resolved.args;
    let actual: string | undefined;
    let what = "";
    let label = "";
    switch (spec.command) {
      case "track_delete": {
        const ref = asObject(args["track"]);
        what = "track";
        actual = await this.resolver.trackName(ref);
        label = trackLabel(ref, actual);
        if (actual !== undefined) ref["expect_name"] = this.agree(ref["expect_name"], actual, what);
        break;
      }
      case "scene_delete": {
        what = "scene";
        actual = await this.resolver.sceneName(args["scene"] as number);
        label = `scene ${String(args["scene"])}${actual === undefined ? "" : ` ${quoted(actual)}`}`;
        break;
      }
      case "clip_delete": {
        what = "clip";
        const info = await this.env.read("clip_get", { clip: args["clip"] });
        actual = asString(asObject(info["clip"])["name"]);
        label = resolved.targets[0] ?? "clip";
        if (actual !== undefined) label = `${label} ${quoted(actual)}`;
        break;
      }
      case "cue_delete": {
        const cue = await this.resolver.cueAt(args["index"] as number);
        if (cue === null) throw notFound("No cue point exists at that index.", { what: "cue point", index: args["index"] });
        resolved.targets.splice(0, resolved.targets.length, `cue point #${String(args["index"])}${cue === undefined ? "" : ` ${quoted(cue.name)}${cue.time === undefined ? "" : ` at beat ${cue.time}`}`}`);
        return;
      }
      case "device_delete": {
        what = "device";
        actual = await this.resolver.deviceName(asObject(args["device"]));
        label = resolved.targets[0] ?? "device";
        if (actual !== undefined) label = `${label} ${quoted(actual)}`;
        break;
      }
      default: return;
    }
    if (actual === undefined) {
      if (spec.command === "track_delete" || spec.command === "scene_delete") throw notFound(`No ${what} exists at that position.`, { what });
      return;
    }
    args["expect_name"] = this.agree(args["expect_name"], actual, what);
    resolved.targets.splice(0, resolved.targets.length, label);
  }

  private agree(guard: unknown, actual: string, what: string): string {
    if (typeof guard === "string" && guard !== actual) {
      throw notFound(`The ${what} is named ${quoted(actual)}, not ${quoted(guard)}; nothing was changed.`, { reason: "name_mismatch", what, expected: safeText(guard), actual: safeText(actual) });
    }
    return actual;
  }

  /** Rules the schema language cannot express; the script enforces them too, this saves a round trip and protects the reserved name. */
  private checkRules(spec: CommandSpec, args: Json, op: number | undefined): void {
    const where: Json = op === undefined ? {} : { op };
    const present = new Set(Object.entries(args).filter(([, value]) => value !== undefined).map(([key]) => key));
    for (const [first, second] of spec.exclusive ?? []) {
      if (present.has(first) && present.has(second)) {
        throw invalidArgs(`${first} and ${second} cannot be given together.`, { reason: "mutually_exclusive", fields: [first, second], ...where });
      }
    }
    if (spec.atLeastOne === true && Object.keys(args).length === 0) {
      throw invalidArgs(`${spec.command} needs at least one field to change.`, { reason: "at_least_one", ...where });
    }
    const name = args["name"];
    if ((spec.command === "track_create" || spec.command === "track_set") && typeof name === "string" && name.trim().toLowerCase() === RESERVED_TRACK_NAME) {
      throw invalidArgs(`The track name ${RESERVED_TRACK_NAME} is reserved for the temporary ears track.`, { reason: "reserved_name", ...where });
    }
  }

  /**
   * audio_clip_create: prove the file, then send the script only the validated realpath. The
   * arrangement form also needs the clip length in beats, which only the server can derive (header
   * duration at the current tempo); formats without a header need allow_overwrite (A37).
   */
  private async prepareAudio(wire: Json, op: number | undefined): Promise<void> {
    const where: Json = op === undefined ? {} : { op };
    const session = wire["slot"] !== undefined;
    const arrangement = wire["position"] !== undefined;
    if (session === arrangement) throw invalidArgs("Give either slot (session form) or position (arrangement form).", { reason: "form", ...where });
    if (session && wire["allow_overwrite"] !== undefined) throw invalidArgs("allow_overwrite belongs to the arrangement form.", { reason: "form", ...where });
    let file;
    try {
      file = validateSampleFile(String(wire["file_path"]), { roots: this.env.config.sampleRoots });
    } catch (error) {
      if (error instanceof ToolError && op !== undefined) throw new ToolError(error.code, error.message, { ...error.details, op });
      throw error;
    }
    wire["file_path"] = file.realPath;
    if (!arrangement) return;
    if (file.durationSeconds === null) {
      if (wire["allow_overwrite"] !== true) {
        throw invalidArgs("The length of this format cannot be read, so overlaps with existing arrangement clips cannot be checked; pass allow_overwrite:true (destructive) or use a WAV/AIFF file.", { reason: "length_unknown", ...where });
      }
      return;
    }
    const tempo = asNumber((await this.env.read("song_info", {}))["tempo"]);
    if (tempo === undefined || tempo <= 0) throw invalidArgs("The song tempo could not be read, so the clip length in beats is unknown.", { reason: "tempo_unknown", ...where });
    const beats = (file.durationSeconds * tempo) / 60;
    if (!(beats > 0) || beats > 1_000_000) throw invalidArgs("The audio file length in beats is out of range.", { reason: "bad_header", ...where });
    wire["expected_length_beats"] = beats;
  }

  async planOp(spec: CommandSpec, given: Json, op?: number): Promise<OpPlan> {
    this.env.assertUsable(spec);
    // Compatibility argument names become the broad arguments first, so every rule below sees one shape.
    const args = applyCompat(spec, given, op);
    this.checkRules(spec, args, op);
    const cls = this.env.classOf(spec);
    if (cls === "always" && this.env.config.destructive === "disabled") {
      throw new ToolError("not_supported", `${spec.summary} is refused: destructive actions are disabled in the server configuration.`, { reason: "disabled_by_config", ...(op === undefined ? {} : { op }) });
    }
    const resolved = await this.resolver.resolveArgs(spec, args, spec.mutating && this.shifter === undefined);
    if (cls === "always") await this.guardDelete(spec, resolved);
    if (spec.command === "audio_clip_create") await this.prepareAudio(resolved.args, op);
    await this.edition.check(spec.command, resolved.args, op);
    const trips = await this.gain.check(spec.command, resolved.args, this.shifter);
    if (this.shifter === undefined && SHIFTING.has(spec.command)) this.shifter = spec.command;
    const reasons = [...trips];
    const condition = spec.condition?.(resolved.args);
    if (condition !== null && condition !== undefined) reasons.push(condition);
    let destructive = cls === "always" || (cls === "conditional" && reasons.length > 0);
    if (cls !== "never" && spec.destructive === "never") {
      // The script is stricter than the server's table and the server cannot evaluate its condition: assume it applies.
      destructive = true;
      reasons.push("the Remote Script classifies this command as destructive");
    }
    if (destructive && this.env.config.destructive === "disabled") {
      const gain = trips.length > 0;
      const details: Json = { reason: gain ? "gain_limit" : "disabled_by_config" };
      if (gain) details["trips"] = trips;
      if (op !== undefined) details["op"] = op;
      throw new ToolError("not_supported", gain
        ? `Refused by the gain limit: ${trips.join("; ")}. Destructive actions are disabled in the server configuration, so there is no confirmation path.`
        : `${spec.summary} is refused: destructive actions are disabled in the server configuration.`, details);
    }
    if (destructive && cls !== "always") await this.resolver.nameDevices(); // the confirmation names the device (deletes name it themselves)
    const irreversible = spec.command === "undo" || spec.command === "redo";
    if (irreversible) reasons.push("Live's undo stack also holds your own manual edits, and any later change drops the redo stack, so this can erase your work for good");
    return { spec, wire: resolved.args, targets: resolved.targets, reasons, gain: trips, irreversible, destructive, warnings: [] };
  }

  /** Plan `batch`: every op is validated, resolved and guarded in order, against the state the earlier ops leave. */
  async planBatch(spec: CommandSpec, args: Json): Promise<OpPlan> {
    // Static checks of every op first (as the spec says), so nothing is read from Live for a batch that cannot run.
    const ops: Array<{ opSpec: CommandSpec; args: Json }> = [];
    for (const [op, raw] of asArray(args["ops"]).entries()) {
      const entry = asObject(raw);
      const toolName = asString(entry["cmd"]) ?? "";
      const command = commandForTool(toolName) ?? "";
      const opSpec = isBatchable(command) ? specFor(command) : undefined;
      if (opSpec === undefined) throw invalidArgs(`Op ${op}: "${toolName.slice(0, 40)}" cannot run inside a batch.`, { reason: "batch_command", op });
      this.env.validateOp(opSpec, entry["args"], op);
      ops.push({ opSpec, args: asObject(entry["args"]) });
    }
    const children: OpPlan[] = [];
    for (const [op, { opSpec, args: opArgs }] of ops.entries()) children.push(await this.planOp(opSpec, opArgs, op));
    const wire: Json = { ops: children.map((child) => ({ cmd: child.spec.command, args: child.wire })) };
    if (args["stop_on_error"] !== undefined) wire["stop_on_error"] = args["stop_on_error"];
    return {
      spec, wire, children,
      targets: children.flatMap((child) => child.targets),
      reasons: children.flatMap((child, op) => child.reasons.map((reason) => `op ${op} (${child.spec.command}): ${reason}`)),
      gain: children.flatMap((child, op) => child.gain.map((reason) => `op ${op} (${child.spec.command}): ${reason}`)),
      irreversible: false,
      destructive: children.some((child) => child.destructive),
      warnings: children.flatMap((child) => child.warnings),
    };
  }
}
