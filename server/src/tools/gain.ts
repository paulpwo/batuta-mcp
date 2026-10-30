import { asArray, asNumber, asObject, asString, canonicalJson, isObject, quoted } from "./util.js";
import type { Json } from "./util.js";
import type { ReadFn } from "./resolve.js";

/**
 * Gain guard (docs/01-protocol.md section 9.4): a loud mistake is the one irreversible harm to a
 * person, so large increases are not applied silently. It covers `mixer_set` volume, `chain_set`
 * volume and `param_set` on mixer volume or on dB parameters named like a gain. A trip makes the
 * call destructive (confirmation, or a refusal when destructive is disabled). Decreases never trip.
 * Also covered: the master's cue volume, and the master ceiling for gain parameters of devices on
 * the master chain. Inside a batch a target may rise at most `max_jump_db` in total, measured from
 * the lowest level it has during the call, and no gain-checked op may follow an op that can shift
 * indices (the listing it would be checked against is stale).
 * Not covered, by design: clip envelopes, loaded presets and parameters whose name or display does
 * not match.
 */

export interface GainLimits { maxJumpDb: number; maxMasterDb: number }

const DB_TEXT = /^([+-]?\d+(?:[.,]\d+)?)\s*dB$/i;
const NEG_INF_TEXT = /^-\s*inf(?:inity)?\s*(?:dB)?$/i;
const GAIN_NAME = /gain|volume|level|output|makeup/i;
/** A rack macro is guarded by its default name whatever it controls: when its display is in dB it is a gain in practice. */
const MACRO_NAME = /^Macro \d{1,2}$/;
const DB_SUFFIX = /dB\s*$/i;
/** Float noise (-12.3 to -5.8 is 6.500000000000001) must not trip a limit that is met exactly. */
const EPSILON = 1e-9;

/** dB value of a Live display string; -Infinity for "-inf dB"; undefined when it cannot be read. */
export function parseDb(display: unknown): number | undefined {
  if (typeof display !== "string") return undefined;
  const shown = display.replace(/−/g, "-").trim();
  if (NEG_INF_TEXT.test(shown)) return Number.NEGATIVE_INFINITY;
  const found = DB_TEXT.exec(shown);
  if (found?.[1] === undefined) return undefined;
  const value = Number(found[1].replace(",", "."));
  return Number.isFinite(value) ? value : undefined;
}

function fmt(db: number): string {
  return Number.isFinite(db) ? `${db.toFixed(1)} dB` : "-inf dB";
}

function refKey(prefix: string, ref: Json): string {
  return `${prefix}:${canonicalJson({ ...ref, expect_name: undefined })}`;
}

/** A device reference whose track is the master: its dB gain parameters are held to the master ceiling. */
function onMaster(device: Json): boolean {
  return asObject(device["track"])["kind"] === "master";
}

export class GainGuard {
  /** Lowest dB each target has had so far in this call (its level before the call, lowered by earlier ops), so a batch cannot raise it in steps. */
  private readonly lowest = new Map<string, number>();

  constructor(private readonly limits: GainLimits, private readonly read: ReadFn) {}

  /** Why the call trips the guard; an empty list means it does not. */
  async check(command: string, wire: Json, shifter?: string): Promise<string[]> {
    if (shifter !== undefined && this.isChecked(command, wire)) {
      return [`${command}: an earlier op in this batch (${shifter}) can shift indices, so this change cannot be checked against the current listing`];
    }
    switch (command) {
      case "mixer_set": return this.mixerSet(wire);
      case "chain_set": return this.chainSet(wire);
      case "param_set": return this.paramSet(wire);
      default: return [];
    }
  }

  /** Whether the call is one the guard would look at (after a shifting op it can no longer look). */
  private isChecked(command: string, wire: Json): boolean {
    switch (command) {
      case "mixer_set": return wire["volume"] !== undefined || wire["volume_db"] !== undefined || (wire["cue_volume"] !== undefined && asObject(wire["track"])["kind"] === "master");
      case "chain_set": return wire["volume"] !== undefined || wire["volume_db"] !== undefined;
      case "param_set": return true;
      default: return false;
    }
  }

  /** Increase rule shared by every path. `master` also enforces the ceiling. */
  private verdict(key: string, current: number | undefined, target: number | undefined, master: boolean, what: string): string[] {
    const from = this.lowest.get(key) ?? current;
    if (from !== undefined && target !== undefined) this.lowest.set(key, Math.min(from, target));
    if (from === undefined || target === undefined) return [`${what}: the current or the new level in dB cannot be read, so the change cannot be checked`];
    if (target <= from) return [];
    const reasons: string[] = [];
    const jump = target - from;
    if (jump > this.limits.maxJumpDb + EPSILON) {
      reasons.push(`${what}: raises the level from ${fmt(from)} to ${fmt(target)} (${Number.isFinite(jump) ? `+${jump.toFixed(1)} dB` : "unbounded"}, limit ${this.limits.maxJumpDb.toFixed(1)} dB)`);
    }
    if (master && target > this.limits.maxMasterDb + EPSILON) {
      reasons.push(`${what}: sets the master level to ${fmt(target)}, above the ceiling of ${this.limits.maxMasterDb.toFixed(1)} dB`);
    }
    return reasons;
  }

  // ---------------------------------------------------------------- mixer volume

  private async mixerVolume(track: Json, target: { db: number } | { raw: number }): Promise<string[]> {
    const mixer = await this.read("mixer_get", { track });
    const current = parseDb(asObject(mixer["volume"])["display"]);
    let db: number | undefined;
    if ("db" in target) db = target.db;
    else {
      const probe = await this.read("param_get", { param: { mixer: "volume", track }, at_value: target.raw });
      db = parseDb(probe["display_at_value"]);
    }
    return this.verdict(refKey("mixer", track), current, db, track["kind"] === "master", "volume");
  }

  private async mixerSet(wire: Json): Promise<string[]> {
    const volumeDb = asNumber(wire["volume_db"]);
    const volume = asNumber(wire["volume"]);
    const track = asObject(wire["track"]);
    const reasons: string[] = [];
    // Both volume and volume_db: the script refuses that, nothing to check.
    if ((volumeDb === undefined) !== (volume === undefined)) {
      reasons.push(...await this.mixerVolume(track, volumeDb !== undefined ? { db: volumeDb } : { raw: volume as number }));
    }
    const cue = asNumber(wire["cue_volume"]);
    if (cue !== undefined && track["kind"] === "master") reasons.push(...await this.cueVolume(track, cue));
    return reasons;
  }

  /**
   * The master's cue (preview) volume sits on the same scale as its volume, so the raw value is turned into dB
   * with the master volume's own conversion; the master ceiling applies to it.
   */
  private async cueVolume(track: Json, raw: number): Promise<string[]> {
    const mixer = await this.read("mixer_get", { track });
    const current = parseDb(asObject(mixer["cue_volume"])["display"]);
    const probe = await this.read("param_get", { param: { mixer: "volume", track }, at_value: raw });
    return this.verdict(refKey("cue", track), current, parseDb(probe["display_at_value"]), true, "cue volume");
  }

  // ---------------------------------------------------------------- rack chains

  private async chainSet(wire: Json): Promise<string[]> {
    const device = asObject(wire["device"]);
    const chain = asObject(wire["chain"]);
    const volumeDb = asNumber(wire["volume_db"]);
    if (wire["volume"] !== undefined && volumeDb === undefined) {
      this.lowest.delete(refKey("chain", { device, chain }));
      return ["volume: a raw chain volume cannot be converted to dB, so it cannot be checked against the gain limit (use volume_db)"];
    }
    if (volumeDb === undefined) return [];
    const rack = await this.read("rack_get", { device });
    const list = asArray(chain["kind"] === "return_chain" ? rack["return_chains"] : rack["chains"]).filter(isObject);
    const info = list.find((entry) => entry["index"] === chain["index"]);
    const current = parseDb(asObject(info?.["volume"])["display"]);
    return this.verdict(refKey("chain", { device, chain }), current, volumeDb, onMaster(device), "chain volume");
  }

  // ---------------------------------------------------------------- parameters

  private async paramSet(wire: Json): Promise<string[]> {
    if (wire["param"] !== undefined) {
      const param = asObject(wire["param"]);
      const value = asNumber(wire["value"]);
      if (value === undefined) return [];
      if (param["mixer"] !== undefined) {
        return param["mixer"] === "volume" ? this.mixerVolume(asObject(param["track"]), { raw: value }) : [];
      }
      return this.deviceParam(asObject(param["device"]), asNumber(param["index"]) ?? -1, value, undefined);
    }
    const device = asObject(wire["device"]);
    const reasons: string[] = [];
    const known = new Map<number, Json>();
    const first = await this.read("device_get", { device, limit: 128 });
    for (const entry of asArray(first["parameters"]).filter(isObject)) known.set(asNumber(entry["index"]) ?? -1, entry);
    for (const item of asArray(wire["items"]).filter(isObject)) {
      const index = asNumber(item["index"]);
      const value = asNumber(item["value"]);
      if (index === undefined || value === undefined) continue;
      reasons.push(...(await this.deviceParam(device, index, value, known.get(index))));
    }
    return reasons;
  }

  /** A device parameter is guarded when its name looks like a gain (or is a default Macro n) and its display is in dB. */
  private async deviceParam(device: Json, index: number, value: number, info: Json | undefined): Promise<string[]> {
    let name = asString(info?.["name"]);
    let display = asString(info?.["display"]);
    if (info === undefined) {
      const probe = await this.read("param_get", { param: { device, index } });
      name = asString(probe["name"]);
      display = asString(probe["display"]);
    }
    if (name === undefined || display === undefined || !(GAIN_NAME.test(name) || MACRO_NAME.test(name)) || !DB_SUFFIX.test(display)) return [];
    const probe = await this.read("param_get", { param: { device, index }, at_value: value });
    return this.verdict(refKey("param", { device, index }), parseDb(display), parseDb(probe["display_at_value"]), onMaster(device), `parameter ${quoted(name)}`);
  }
}
