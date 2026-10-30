import { ToolError } from "../mcp/index.js";

/**
 * Recording with a live external input (docs/01-protocol.md section 5.6). The Remote Script refuses such a
 * command with `acknowledgeable: true` and the tracks involved. The server asks the owner once and, on accept,
 * sends the same command again with the `external_input_ack` request flag. The flag is set only here: tool
 * schemas reject it as an argument, so no client can supply it.
 */

const REASONS: ReadonlySet<string> = new Set(["external_input_live", "audio_arm_blocked", "monitor_in_blocked"]);
const MAX_SHOWN = 8;
const MAX_NAME = 64;
const MAX_IDS = 128;
const TRACK_ID = /^(?:t\d{1,4}|r\d{1,4}|m)$/;

/** The tracks an acknowledgeable refusal names: what the owner is shown, and the ids the acknowledgement is bound to. */
export interface ExternalRefusal { names: string[]; ids: string[] }

/**
 * The refusal's tracks when `error` is an acknowledgeable external-input refusal, else undefined. A refusal without
 * valid track ids cannot be bound to what the owner is shown, so it is not acknowledgeable.
 */
export function externalRefusal(error: unknown): ExternalRefusal | undefined {
  if (!(error instanceof ToolError) || error.code !== "not_supported") return undefined;
  const details = error.details ?? {};
  if (details["acknowledgeable"] !== true || typeof details["reason"] !== "string" || !REASONS.has(details["reason"])) return undefined;
  const ids = Array.isArray(details["track_ids"]) ? details["track_ids"] : [];
  if (ids.length === 0 || ids.length > MAX_IDS || !ids.every((id): id is string => typeof id === "string" && TRACK_ID.test(id)) || new Set(ids).size !== ids.length) return undefined;
  const tracks = Array.isArray(details["tracks"]) ? details["tracks"] : [];
  const names = tracks.filter((name): name is string => typeof name === "string").map((name) => clean(name));
  return { names, ids: [...ids] };
}

function clean(text: string): string {
  const flat = text.replace(/[\p{Cc}\p{Zl}\p{Zp}"]/gu, " ").replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length <= MAX_NAME ? flat : `${chars.slice(0, MAX_NAME - 3).join("")}...`;
}

/** The one question the owner is asked. `what` is the static label of the command, never model text. `total` counts tracks the script named beyond the names it sent. */
export function externalSummary(tracks: string[], what: string, total = tracks.length): string {
  const count = Math.max(total, tracks.length);
  const shown = tracks.slice(0, MAX_SHOWN).map((name) => `"${name}"`).join(", ");
  const rest = count - Math.min(tracks.length, MAX_SHOWN);
  const named = count === 0 ? "a track" : rest > 0 ? `${shown === "" ? "" : `${shown} `}and ${rest} more` : shown;
  const plural = count > 1 ? "inputs" : "input";
  return `${what}: the recording may capture whatever comes in through the external ${plural} of ${named} (for example a microphone). Continue and record it?`;
}
