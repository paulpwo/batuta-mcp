import { ToolError } from "../mcp/index.js";
import type { OpPlan } from "./plan.js";
import { field } from "./util.js";

/**
 * Human-readable summary of a destructive call (docs/01-protocol.md section 9.3). It is built only
 * from the static command label, the targets (names come from listings of Live, escaped, cut at 64
 * characters and stripped of control characters) and numeric/boolean arguments: never from raw model
 * text. What matters for the decision is never cut: destructive children and gain trips come first
 * with their reasons, and when they alone do not fit in 500 characters the call is refused.
 */

const MAX_SUMMARY = 500;
/** A single call keeps at least this much room for its targets next to its reasons. */
const MIN_TARGETS = 20;

const size = (text: string): number => [...text].length;

function cut(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, Math.max(0, max - 3)).join("")}...`;
}

function tooLarge(): ToolError {
  return new ToolError("too_large", `This action is too large to describe in one confirmation (what it destroys or changes dangerously needs more than ${MAX_SUMMARY} characters). Split it into smaller calls.`, { reason: "summary_too_large", limit: MAX_SUMMARY });
}

function scalars(plan: OpPlan): string {
  const skip = new Set(Object.keys(plan.spec.refs ?? {}));
  const parts: string[] = [];
  for (const [key, value] of Object.entries(plan.wire)) {
    if (skip.has(key)) continue;
    if (typeof value === "number" && Number.isFinite(value)) parts.push(`${key}=${value}`);
    else if (typeof value === "boolean") parts.push(`${key}=${value}`);
    if (parts.length >= 8) break;
  }
  if (plan.spec.command === "notes_remove") {
    const ids = plan.wire["note_ids"];
    if (Array.isArray(ids)) parts.push(`${ids.length} note id${ids.length === 1 ? "" : "s"}`);
    else if (!["from_pitch", "pitch_span", "from_time", "time_span"].some((key) => field(plan.wire, key) !== undefined)) parts.push("all notes");
  }
  return parts.join(", ");
}

/** The call without its reasons: label, targets, numbers. */
function body(plan: OpPlan): string {
  const details = [...plan.targets, scalars(plan)].filter((part) => part.length > 0);
  return details.length === 0 ? plan.spec.summary : `${plan.spec.summary}: ${details.join(", ")}`;
}

const reasonsOf = (plan: OpPlan): string => (plan.reasons.length === 0 ? "" : ` (${plan.reasons.join("; ")})`);

/** One whole call; the label is cut only to leave the reasons intact. */
function single(plan: OpPlan): string {
  const reasons = reasonsOf(plan);
  const text = body(plan);
  if (size(text) + size(reasons) <= MAX_SUMMARY) return text + reasons;
  const head = plan.spec.summary;
  if (size(head) + size(reasons) + MIN_TARGETS > MAX_SUMMARY) throw tooLarge();
  return cut(text, MAX_SUMMARY - size(reasons)) + reasons;
}

/** A child of a batch: numbered, with why it is listed when it has no reason of its own. */
function child(plan: OpPlan, op: number, critical: boolean): string {
  const reasons = reasonsOf(plan);
  return `op ${op}: ${body(plan)}${reasons}${critical && reasons === "" ? " (destructive)" : ""}`;
}

function batch(children: OpPlan[]): string {
  const header = `Run a batch: ${children.length} operation(s)`;
  const critical = children.flatMap((entry, op) => (entry.destructive ? [child(entry, op, true)] : []));
  const others = children.flatMap((entry, op) => (entry.destructive ? [] : [child(entry, op, false)]));
  const first = critical.length === 0 ? header : `${header}. Destructive or over the gain limit: ${critical.join(" | ")}`;
  if (size(first) > MAX_SUMMARY) throw tooLarge();
  if (others.length === 0) return first;
  let kept = 0;
  const assemble = (count: number): string => {
    const left = others.length - count;
    const listed = others.slice(0, count);
    if (left > 0) listed.push(count === 0 ? `${left} more operation(s)` : `and ${left} more`);
    return `${first}. Also: ${listed.join(" | ")}`;
  };
  while (kept < others.length && size(assemble(kept + 1)) <= MAX_SUMMARY) kept += 1;
  const text = assemble(kept);
  return size(text) <= MAX_SUMMARY ? text : first;
}

export function summarize(plan: OpPlan): string {
  if (plan.summaryText !== undefined) return plan.summaryText;
  return plan.children === undefined ? single(plan) : batch(plan.children);
}
