import { ToolError } from "../mcp/index.js";
import type { Edition } from "../live/index.js";
import type { EditionSetting } from "../config/index.js";
import { asNumber, asObject, asString } from "./util.js";
import type { Json } from "./util.js";
import type { ReadFn } from "./resolve.js";

/**
 * Edition prechecks (docs/01-protocol.md section 8), the server's layer. The script checks too when
 * it knows the edition; the server checks whenever ITS effective edition is known, so the model gets
 * a typed `edition_limit` before anything is sent.
 */

export interface Counts { tracks: number; scenes: number; returns: number }
export type Resource = keyof Counts;

const LITE: Counts = { tracks: 8, scenes: 16, returns: 2 };
const FULL: Counts = { tracks: Number.POSITIVE_INFINITY, scenes: Number.POSITIVE_INFINITY, returns: 12 };

function pick(counts: Partial<Counts>, resource: Resource): number {
  return resource === "tracks" ? (counts.tracks ?? 0) : resource === "scenes" ? (counts.scenes ?? 0) : (counts.returns ?? 0);
}

/** Config wins over detection; the welcome already prefers detection over the hint. */
export function effectiveEdition(setting: EditionSetting, welcome: Edition | undefined): Edition {
  if (setting !== "auto") return setting;
  return welcome ?? "unknown";
}

export function limitsFor(edition: Edition): Counts | undefined {
  return edition === "lite" ? LITE : edition === "standard" || edition === "suite" ? FULL : undefined;
}

/** How a command changes the counts. `descendants` is the number of tracks a duplicated group track also copies. */
export function deltaFor(command: string, wire: Json, descendants: number): Partial<Counts> {
  switch (command) {
    case "track_create": return wire["type"] === "return" ? { returns: 1 } : { tracks: 1 };
    case "track_duplicate": return { tracks: 1 + descendants };
    case "track_delete": return asObject(wire["track"])["kind"] === "return" ? { returns: -1 } : { tracks: -1 };
    case "scene_create": case "scene_duplicate": case "scene_capture": return { scenes: 1 };
    case "scene_delete": return { scenes: -1 };
    // duplicate_clip_slot may append a scene (A33): assume the worst case.
    case "clip_duplicate": return wire["to"] === undefined ? { scenes: 1 } : {};
    default: return {};
  }
}

const RESOURCES: Resource[] = ["tracks", "scenes", "returns"];

export class EditionGuard {
  private counts: Counts | undefined;

  constructor(
    private readonly edition: Edition,
    private readonly read: ReadFn,
    private readonly groupDescendants: (trackIndex: number) => Promise<number>,
  ) {}

  private async current(): Promise<Counts> {
    if (this.counts === undefined) {
      const info = await this.read("song_info", {});
      this.counts = { tracks: asNumber(info["track_count"]) ?? 0, scenes: asNumber(info["scene_count"]) ?? 0, returns: asNumber(info["return_count"]) ?? 0 };
    }
    return this.counts;
  }

  /** Check one op against the projected counts (earlier ops of a batch included) and apply it. */
  async check(command: string, wire: Json, op?: number): Promise<void> {
    const limits = limitsFor(this.edition);
    if (limits === undefined) return;
    let descendants = 0;
    if (command === "track_duplicate") {
      const track = asObject(wire["track"]);
      descendants = await this.groupDescendants(asNumber(track["index"]) ?? -1);
    }
    const delta = deltaFor(command, wire, descendants);
    if (!RESOURCES.some((resource) => pick(delta, resource) !== 0)) return;
    const counts = await this.current();
    for (const resource of RESOURCES) {
      const change = pick(delta, resource);
      const have = pick(counts, resource);
      const limit = pick(limits, resource);
      if (change > 0 && have + change > limit) {
        const details: Json = { resource, limit, current: have, edition: this.edition };
        if (change > 1) details["projected"] = have + change;
        if (op !== undefined) details["op"] = op;
        throw new ToolError("edition_limit", `Live ${asString(this.edition)} allows at most ${String(limit)} ${resource}; there are already ${have}.`, details);
      }
    }
    this.counts = {
      tracks: Math.max(0, counts.tracks + (delta.tracks ?? 0)),
      scenes: Math.max(0, counts.scenes + (delta.scenes ?? 0)),
      returns: Math.max(0, counts.returns + (delta.returns ?? 0)),
    };
  }
}
