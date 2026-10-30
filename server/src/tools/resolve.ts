import { ToolError } from "../mcp/index.js";
import type { CommandSpec, RefKind } from "./types.js";
import { asArray, asNumber, asObject, asString, clone, field, invalidArgs, isObject, notFound, quoted, safeText } from "./util.js";
import type { Json } from "./util.js";

/**
 * Name resolution (docs/01-protocol.md sections 6.1 and 7.16). The model may give a name wherever the
 * wire needs a reference; the server looks the name up in a FRESH listing (exact case-sensitive match
 * first, then exact case-insensitive), refuses ambiguity with candidates, and sends only references
 * that carry `expect_name`. The Remote Script never sees a name selector.
 */

export type ReadFn = (cmd: string, args: Json) => Promise<Json>;

export interface Resolved {
  args: Json;
  /** Human-readable descriptions of what the call targets, built from structured fields only. */
  targets: string[];
}

const MAX_CANDIDATES = 10;
const MAX_PAGES = 20;

interface Named { index: number; name: string; kind?: string }

function isNameSelector(value: unknown): boolean {
  return isObject(value) && typeof value["name"] === "string";
}

/** Exact case-sensitive matches, else exact case-insensitive ones. */
export function matchNames<T extends { name: string }>(items: T[], name: string): T[] {
  const exact = items.filter((item) => item.name === name);
  if (exact.length > 0) return exact;
  const lower = name.toLowerCase();
  return items.filter((item) => item.name.toLowerCase() === lower);
}

export function pickOne(items: Named[], name: string, what: string): Named {
  const found = matchNames(items, name);
  if (found.length === 1) return found[0] as Named;
  if (found.length === 0) {
    throw notFound(`No ${what} named ${quoted(name)} was found. List the ${what}s and use an index or an exact name.`, { what, name: safeText(name) });
  }
  throw invalidArgs(`More than one ${what} is named ${quoted(name)}; use an index reference instead.`, {
    reason: "ambiguous_name", what,
    candidates: found.slice(0, MAX_CANDIDATES).map((item) => (item.kind === undefined ? { index: item.index, name: safeText(item.name) } : { kind: item.kind, index: item.index, name: safeText(item.name) })),
  });
}

/**
 * Label for a track reference: `track 2 "Bass"`, `return 0`, `master`. The name is only shown when it
 * came from a listing of Live (never from a model-supplied expect_name), so labels in confirmation
 * texts cannot carry model text.
 */
export function trackLabel(ref: Json, listedName?: string): string {
  const kind = asString(ref["kind"]) ?? "track";
  const base = kind === "master" ? "master" : `${kind} ${String(ref["index"])}`;
  return listedName === undefined ? base : `${base} ${quoted(listedName)}`;
}

export interface NamedRef { ref: Json; name?: string }

export class Resolver {
  private readonly memo = new Map<string, Promise<Json>>();
  /** While true (a mutating op that no earlier op of the call could have shifted), index refs are pinned with the listed name. */
  private pin = false;
  /** Device labels written without a name, so a confirmation can fill it in (see `nameDevices`). */
  private unnamed: Array<{ label: string[]; position: number; head: string; tail: string; device: Json }> = [];

  constructor(private readonly read: ReadFn) {}

  /** One fresh read per distinct request within a tool call. */
  private cached(cmd: string, args: Json): Promise<Json> {
    const key = `${cmd}:${JSON.stringify(args)}`;
    let hit = this.memo.get(key);
    if (hit === undefined) {
      hit = this.read(cmd, args);
      this.memo.set(key, hit);
    }
    return hit;
  }

  private async allPages(cmd: string, args: Json, name: string): Promise<Json[]> {
    const out: Json[] = [];
    let offset = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await this.cached(cmd, { ...args, offset });
      out.push(...asArray(field(result, name)).filter(isObject));
      const next = asNumber(result["next_offset"]);
      if (next === undefined || next <= offset) return out;
      offset = next;
    }
    throw new ToolError("too_large", `The ${cmd} listing has too many pages to search by name; use an index reference.`, { cmd });
  }

  // ------------------------------------------------------------------ tracks

  private async trackItems(): Promise<Named[]> {
    const items = await this.allPages("track_list", { include_returns: true, include_master: true, limit: 500 }, "items");
    return items.map((item) => ({ kind: asString(item["kind"]) ?? "track", index: asNumber(item["index"]) ?? 0, name: asString(item["name"]) ?? "" }));
  }

  async resolveTrack(value: unknown, trackOnly: boolean): Promise<Json> {
    return (await this.resolveTrackNamed(value, trackOnly)).ref;
  }

  async resolveTrackNamed(value: unknown, trackOnly: boolean): Promise<NamedRef> {
    const sel = asObject(value);
    if (!isNameSelector(sel)) return this.pinIndexRef(clone(sel));
    const wanted = asString(sel["kind"]);
    const items = (await this.trackItems()).filter((item) => (trackOnly ? item.kind === "track" : wanted === undefined || item.kind === wanted));
    const found = pickOne(items, asString(sel["name"]) ?? "", "track");
    if (found.kind === "master") return { ref: { kind: "master", expect_name: found.name }, name: found.name };
    return { ref: { kind: found.kind, index: found.index, expect_name: found.name }, name: found.name };
  }

  /**
   * Every index ref the server resolves for a mutating op carries `expect_name` from a fresh listing,
   * so a shifted index fails at the script instead of hitting another track (docs/01-protocol.md
   * section 9.4). A name the model gave must agree with Live's.
   */
  private async pinIndexRef(ref: Json): Promise<NamedRef> {
    if (!this.pin || ref["kind"] === "master" || typeof ref["index"] !== "number") return { ref };
    const actual = await this.trackName(ref);
    if (actual === undefined) return { ref };
    const given = ref["expect_name"];
    if (typeof given === "string" && given !== actual) {
      throw notFound(`The track is named ${quoted(actual)}, not ${quoted(given)}; nothing was changed.`, { reason: "name_mismatch", what: "track", expected: safeText(given), actual: safeText(actual) });
    }
    ref["expect_name"] = actual;
    return { ref, name: actual };
  }

  /** Tracks a duplicated group track also copies: its children, their children, and so on (A33). */
  async groupDescendants(trackIndex: number): Promise<number> {
    const items = await this.allPages("track_list", { include_returns: false, include_master: false, limit: 500 }, "items");
    const parents = new Map(items.map((item) => [asNumber(item["index"]) ?? -1, asNumber(item["group_track_index"])]));
    const inside = new Set<number>([trackIndex]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const [index, parent] of parents) {
        if (!inside.has(index) && parent !== undefined && inside.has(parent)) { inside.add(index); grew = true; }
      }
    }
    return inside.size - 1;
  }

  // ------------------------------------------------------------------ scenes

  async resolveScene(value: unknown): Promise<{ index: number; name?: string }> {
    if (typeof value === "number") return { index: value };
    const sel = asObject(value);
    const items = (await this.allPages("scene_list", { limit: 500 }, "items")).map((item) => ({ index: asNumber(item["index"]) ?? 0, name: asString(item["name"]) ?? "" }));
    const found = pickOne(items, asString(sel["name"]) ?? "", "scene");
    return { index: found.index, name: found.name };
  }

  /** Current name of a scene by index (used to guard deletes), or undefined when it cannot be determined. */
  async sceneName(index: number): Promise<string | undefined> {
    const items = await this.allPages("scene_list", { limit: 500 }, "items");
    return asString(items.find((item) => item["index"] === index)?.["name"]);
  }

  /** The listed cue point at an index: its name and time, or undefined when the listing has nothing there (or nothing at all). */
  async cueAt(index: number): Promise<{ name: string; time: number | undefined } | undefined | null> {
    const items = await this.allPages("cue_list", { limit: 500 }, "items");
    if (items.length === 0) return undefined;
    const found = items.find((item) => item["index"] === index);
    return found === undefined ? null : { name: asString(found["name"]) ?? "", time: asNumber(found["time"]) };
  }

  async trackName(ref: Json): Promise<string | undefined> {
    if (ref["kind"] === "master") return undefined;
    const items = await this.trackItems();
    return items.find((item) => item.kind === ref["kind"] && item.index === ref["index"])?.name;
  }

  // ------------------------------------------------------------------ devices

  private async deviceItems(container: Json): Promise<Named[]> {
    const items = await this.allPages("device_list", { container, limit: 500 }, "items");
    return items.map((item, position) => ({ index: position, name: asString(item["name"]) ?? "" }));
  }

  private async chainItems(deviceRef: Json, name: "chains" | "return_chains"): Promise<Named[]> {
    const rack = await this.cached("rack_get", { device: deviceRef });
    return asArray(field(rack, name)).filter(isObject).map((chain) => ({ index: asNumber(chain["index"]) ?? 0, name: asString(chain["name"]) ?? "" }));
  }

  /** Resolve the hops of a device or container path to indices. */
  private async resolvePath(trackRef: Json, hops: unknown[], what: string): Promise<{ path: unknown[]; name?: string }> {
    const out: unknown[] = [];
    let lastName: string | undefined;
    for (const [position, hop] of hops.entries()) {
      lastName = undefined;
      if (typeof hop === "number") { out.push(hop); continue; }
      const h = asObject(hop);
      if (isNameSelector(h) && Object.keys(h).length === 1) {
        if (position !== 0) throw invalidArgs("A device name can only be used as the first hop of a path; use {chain, device} steps inside racks.", { reason: "name_hop_position", what });
        const found = pickOne(await this.deviceItems({ track: trackRef, path: [] }), asString(h["name"]) ?? "", "device");
        out.push(found.index);
        lastName = found.name;
        continue;
      }
      const chainKey = h["chain"] !== undefined ? "chain" : h["return_chain"] !== undefined ? "return_chain" : "drum_pad";
      const chainSel = h["chain"] ?? h["return_chain"];
      let chainIndex: number;
      if (typeof chainSel === "number") chainIndex = chainSel;
      else if (chainKey === "drum_pad") throw invalidArgs("Chains of a drum pad can only be addressed by index.", { reason: "unsupported_selector", what });
      else chainIndex = pickOne(await this.chainItems({ track: trackRef, path: out }, chainKey === "chain" ? "chains" : "return_chains"), asString(asObject(chainSel)["name"]) ?? "", "chain").index;
      const step: Json = chainKey === "drum_pad" ? { drum_pad: h["drum_pad"], chain: chainIndex } : { [chainKey]: chainIndex };
      if (h["device"] !== undefined) {
        let deviceIndex: number;
        if (typeof h["device"] === "number") deviceIndex = h["device"];
        else {
          const found = pickOne(await this.deviceItems({ track: trackRef, path: [...out, step] }), asString(asObject(h["device"])["name"]) ?? "", "device");
          deviceIndex = found.index;
          lastName = found.name;
        }
        out.push({ ...step, device: deviceIndex });
      } else {
        out.push(step);
      }
    }
    return lastName === undefined ? { path: out } : { path: out, name: lastName };
  }

  async resolveDevice(value: unknown, label: string[], what = "device"): Promise<Json> {
    const sel = asObject(value);
    const { ref: track, name: trackName } = await this.resolveTrackNamed(sel["track"], false);
    const { path, name } = await this.resolvePath(track, asArray(sel["path"]), what);
    const head = `${what} ${path.length === 1 && typeof path[0] === "number" ? `#${path[0]}` : "in a rack"}`;
    const tail = ` on ${trackLabel(track, trackName)}`;
    if (name === undefined && path.length > 0) this.unnamed.push({ label, position: label.length, head, tail, device: { track, path } });
    label.push(`${head}${name === undefined ? "" : ` ${quoted(name)}`}${tail}`);
    return { track, path };
  }

  /** Put the listed device name into the labels of this call that have none. It is cosmetic: a failed read leaves the label as it was. */
  async nameDevices(): Promise<void> {
    const pending = this.unnamed;
    this.unnamed = [];
    for (const entry of pending) {
      const name = await this.deviceName(entry.device).catch(() => undefined);
      if (name !== undefined && name.length > 0) entry.label.splice(entry.position, 1, `${entry.head} ${quoted(name)}${entry.tail}`);
    }
  }

  async resolveContainer(value: unknown, label: string[]): Promise<Json> {
    const sel = asObject(value);
    const { ref: track, name: trackName } = await this.resolveTrackNamed(sel["track"], false);
    const { path } = await this.resolvePath(track, asArray(sel["path"]), "container");
    label.push(`device chain (${path.length === 0 ? "track chain" : "rack chain"}) on ${trackLabel(track, trackName)}`);
    return { track, path };
  }

  /** Name of the device a resolved path points at, from its parent chain (for confirmation texts and guards). */
  async deviceName(deviceRef: Json): Promise<string | undefined> {
    const track = asObject(deviceRef["track"]);
    const path = asArray(deviceRef["path"]);
    const last = path.at(-1);
    if (last === undefined) return undefined;
    let container: Json;
    let index: number;
    if (typeof last === "number") { container = { track, path: path.slice(0, -1) }; index = last; }
    else {
      const step = asObject(last);
      const { device, ...rest } = step;
      container = { track, path: [...path.slice(0, -1), rest] };
      index = asNumber(device) ?? -1;
    }
    const items = await this.deviceItems(container);
    return items.find((item) => item.index === index)?.name;
  }

  // ------------------------------------------------------------------ parameters

  async resolveParam(value: unknown, label: string[]): Promise<Json> {
    const sel = asObject(value);
    if (sel["mixer"] !== undefined) {
      const { ref: track, name } = await this.resolveTrackNamed(sel["track"], false);
      label.push(`${String(sel["mixer"])} of ${trackLabel(track, name)}`);
      return { ...sel, track };
    }
    const device = await this.resolveDevice(sel["device"], label);
    if (typeof sel["index"] === "number") return { device, index: sel["index"] };
    const found = pickOne(await this.paramItems(device), asString(sel["name"]) ?? "", "parameter");
    return { device, index: found.index };
  }

  async paramItems(deviceRef: Json): Promise<Named[]> {
    const items = await this.allPages("device_get", { device: deviceRef, limit: 128 }, "parameters");
    return items.map((item) => ({ index: asNumber(item["index"]) ?? 0, name: asString(item["name"]) ?? "" }));
  }

  // ------------------------------------------------------------------ clips

  async resolveClip(value: unknown, label: string[]): Promise<Json> {
    const sel = clone(asObject(value));
    const { ref: track, name } = await this.resolveTrackNamed(sel["track"], true);
    sel["track"] = track;
    label.push(sel["kind"] === "arrangement" ? `arrangement clip #${String(sel["index"])} on ${trackLabel(track, name)}` : `clip in slot ${String(sel["slot"])} of ${trackLabel(track, name)}`);
    return sel;
  }

  async resolveSlotRef(value: unknown, label: string[]): Promise<Json> {
    const sel = asObject(value);
    const { ref: track, name } = await this.resolveTrackNamed(sel["track"], true);
    label.push(`slot ${String(sel["slot"])} of ${trackLabel(track, name)}`);
    return { ...sel, track };
  }

  // ------------------------------------------------------------------ whole argument objects

  /** Replace every selector in `args` according to the spec's `refs`. Other arguments are copied. */
  async resolveArgs(spec: CommandSpec, args: Json, pin = false): Promise<Resolved> {
    this.pin = pin;
    this.unnamed = [];
    try {
      return await this.resolveAll(spec, args);
    } finally {
      this.pin = false;
    }
  }

  private async resolveAll(spec: CommandSpec, args: Json): Promise<Resolved> {
    const out = new Map<string, unknown>(Object.entries(clone(args)));
    const targets: string[] = [];
    const refs = Object.entries(spec.refs ?? {});
    // `device` must be resolved before `items`, which names parameters of that device.
    refs.sort(([, a], [, b]) => Number(a === "paramItems") - Number(b === "paramItems"));
    for (const [key, kind] of refs) {
      const value = out.get(key);
      if (value === undefined) continue;
      out.set(key, await this.resolveKind(kind, value, out, targets));
    }
    return { args: Object.fromEntries(out), targets };
  }

  private async resolveKind(kind: RefKind, value: unknown, out: Map<string, unknown>, targets: string[]): Promise<unknown> {
    switch (kind) {
      case "track":
      case "trackOnly": {
        const { ref, name } = await this.resolveTrackNamed(value, kind === "trackOnly");
        targets.push(trackLabel(ref, name));
        return ref;
      }
      case "trackList":
      case "trackOnlyList": {
        const named: NamedRef[] = [];
        for (const item of asArray(value)) named.push(await this.resolveTrackNamed(item, kind === "trackOnlyList"));
        targets.push(named.length === 1 ? trackLabel((named[0] as NamedRef).ref, (named[0] as NamedRef).name) : `${named.length} tracks`);
        return named.map((entry) => entry.ref);
      }
      case "scene": {
        const scene = await this.resolveScene(value);
        targets.push(`scene ${scene.index}${scene.name === undefined ? "" : ` ${quoted(scene.name)}`}`);
        return scene.index;
      }
      case "device": return this.resolveDevice(value, targets);
      case "container": return this.resolveContainer(value, targets);
      case "param": return this.resolveParam(value, targets);
      case "clip": return this.resolveClip(value, targets);
      case "slotref": return this.resolveSlotRef(value, targets);
      case "paramItems": {
        const device = asObject(out.get("device"));
        const names = asArray(value).some((item) => isNameSelector(item)) ? await this.paramItems(device) : [];
        return asArray(value).map((item) => {
          const entry = asObject(item);
          if (typeof entry["name"] !== "string") return entry;
          return { index: pickOne(names, entry["name"], "parameter").index, value: entry["value"] };
        });
      }
    }
  }
}
