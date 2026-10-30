import type { ToolResult } from "../mcp/index.js";
import type { CommandSpec } from "./types.js";
import { asArray, asNumber, isObject } from "./util.js";
import type { Json } from "./util.js";

/**
 * Results (docs/01-protocol.md section 7.16): `structuredContent` is the script result plus server
 * warnings; `content` is a short text summary. Small results also carry their compact JSON in the
 * text, because some clients show the model only `content`.
 */
export const TEXT_INCLUDES_JSON = true;
const MAX_JSON_IN_TEXT = 6000;

function summaryLine(spec: CommandSpec, result: Json): string {
  const items = result["items"];
  if (Array.isArray(items)) {
    const total = asNumber(result["total"]);
    const next = asNumber(result["next_offset"]);
    return `${spec.summary}: ${items.length} item(s)${total === undefined ? "" : ` of ${total}`}${next === undefined ? "" : `; more available, continue with offset ${next}`}.`;
  }
  return spec.mutating ? `${spec.summary}: done.` : `${spec.summary}: ok.`;
}

/** Browser and sweep facts the model must not miss (section 7.10, A23). */
export function warningsFor(spec: CommandSpec, result: Json): string[] {
  const warnings: string[] = [];
  if (spec.command === "browser_load") {
    if (result["verified"] === false) {
      warnings.push("verified is false: Live loaded the item asynchronously, so the safety check of the loaded device tree is still pending (sweep_pending). Wait a few seconds, then check pending_sweeps/recent_sweeps in get_session_info and the track with get_track_info before trusting the load.");
    }
    const sweep = result["previous_sweep"];
    if (asArray(result["new_tracks"]).length > 0 || (isObject(sweep) && asArray(sweep["new_tracks"]).length > 0)) {
      warnings.push("Live created a new track during this load (see new_tracks / landed_on): the item landed there, not on the requested track. The new track was left as is (it may be armed); delete or disarm it if it is unwanted.");
    }
    if (isObject(sweep)) {
      warnings.push("previous_sweep reports the outcome of an earlier load's safety sweep; read it before continuing.");
    }
  }
  if (spec.command === "song_info" && (asNumber(result["pending_sweeps"]) ?? 0) > 0) {
    warnings.push(`${String(result["pending_sweeps"])} safety sweep(s) from earlier browser_load calls are still pending.`);
  }
  if (spec.command === "batch" && result["partial"] === true) {
    warnings.push("The batch stopped before the end after changing something (partial:true); re-read the state before retrying.");
  }
  return warnings;
}

/** How to take back a destructive call that ran without a prompt (every script mutation is one Live undo step). */
export function revertHint(spec: CommandSpec): string {
  return spec.command === "undo" ? "Redo in Live (Cmd-Shift-Z), or the redo tool" : "Cmd-Z in Live, or the undo tool";
}

export function shapeResult(spec: CommandSpec, raw: unknown, extraWarnings: string[] = [], undoable = false): ToolResult {
  const structured: Json = isObject(raw) ? { ...raw } : { result: raw };
  const warnings = [...asArray(structured["warnings"]).map(String), ...extraWarnings, ...warningsFor(spec, structured)];
  if (warnings.length > 0) structured["warnings"] = warnings;
  if (undoable) {
    structured["undoable"] = true;
    structured["revert"] = revertHint(spec);
  }
  const lines = [summaryLine(spec, structured)];
  if (undoable) lines.push(`Undoable: ${revertHint(spec)}.`);
  if (warnings.length > 0) lines.push(...warnings.map((w) => `Warning: ${w}`));
  if (TEXT_INCLUDES_JSON) {
    const json = JSON.stringify(structured);
    if (json.length <= MAX_JSON_IN_TEXT) lines.push(json);
    else lines.push("The full result is in structuredContent.");
  }
  return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: structured };
}
