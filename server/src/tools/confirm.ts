import { createHash, randomBytes } from "node:crypto";
import { ToolError } from "../mcp/index.js";
import type { OpPlan } from "./plan.js";
import { canonicalJson } from "./util.js";
import type { Json } from "./util.js";

/**
 * Two-step confirmation for clients that cannot ask the user (docs/01-protocol.md section 9.3).
 * State lives in memory only: at most 32 pending operations, 60 s each, single use. The stored
 * operation is the already-resolved command; `batuta_confirm` can only release it, never change it.
 */

export const CONFIRM_TTL_MS = 60_000;
const MAX_PENDING = 32;
const MAX_FAILURES = 3;
const MAX_REMEMBERED_USED = 128;

interface Entry {
  id: string;
  hash: string;
  summary: string;
  plan: OpPlan;
  expiresAt: number;
  failures: number;
}

function refuse(reason: "confirm_unknown" | "confirm_expired" | "confirm_summary_mismatch" | "confirm_used", message: string): ToolError {
  return new ToolError("invalid_args", message, { reason });
}

/** sha256 of the canonical command and resolved arguments: identifies one distinct operation. */
export function operationHash(plan: OpPlan): string {
  return createHash("sha256").update(canonicalJson({ cmd: plan.spec.command, args: plan.wire })).digest("hex");
}

export class ConfirmationStore {
  private readonly pending = new Map<string, Entry>();
  private readonly byHash = new Map<string, string>();
  private readonly used = new Set<string>();

  /** `clock` is monotonic milliseconds. */
  constructor(private readonly clock: () => number, private readonly makeId: () => string = () => randomBytes(16).toString("base64url")) {}

  private drop(entry: Entry): void {
    this.pending.delete(entry.id);
    if (this.byHash.get(entry.hash) === entry.id) this.byHash.delete(entry.hash);
  }

  private purgeExpired(): void {
    const now = this.clock();
    for (const entry of [...this.pending.values()]) if (now > entry.expiresAt) this.drop(entry);
  }

  /** Store an operation. An identical pending operation is replaced, so one operation has one pending id. */
  put(plan: OpPlan, summary: string): { confirmId: string; expiresIn: number } {
    this.purgeExpired();
    const hash = operationHash(plan);
    const earlier = this.byHash.get(hash);
    const old = earlier === undefined ? undefined : this.pending.get(earlier);
    if (old !== undefined) this.drop(old);
    while (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.values().next().value;
      if (oldest === undefined) break;
      this.drop(oldest);
    }
    const entry: Entry = { id: this.makeId(), hash, summary, plan, expiresAt: this.clock() + CONFIRM_TTL_MS, failures: 0 };
    this.pending.set(entry.id, entry);
    this.byHash.set(hash, entry.id);
    return { confirmId: entry.id, expiresIn: CONFIRM_TTL_MS / 1000 };
  }

  /** The stored operation without releasing it (the caller decides how to prepare before `take`). */
  peek(confirmId: string): OpPlan | undefined {
    return this.pending.get(confirmId)?.plan;
  }

  /** Release the stored operation: the summary must match exactly, the entry must be alive, and it works once. */
  take(confirmId: string, summary: string): OpPlan {
    const entry = this.pending.get(confirmId);
    if (entry === undefined) {
      throw this.used.has(confirmId)
        ? refuse("confirm_used", "This confirmation was already used. Start the action again if you still want it.")
        : refuse("confirm_unknown", "No pending action has this confirm_id. Start the action again.");
    }
    if (this.clock() > entry.expiresAt) {
      this.drop(entry);
      throw refuse("confirm_expired", "This confirmation expired after 60 seconds. Start the action again.");
    }
    if (summary !== entry.summary) {
      entry.failures += 1;
      if (entry.failures >= MAX_FAILURES) this.drop(entry);
      throw refuse("confirm_summary_mismatch", "The summary does not match the pending action. Pass the summary text exactly as it was returned.");
    }
    this.drop(entry);
    this.used.add(entry.id);
    if (this.used.size > MAX_REMEMBERED_USED) {
      const first = this.used.values().next().value;
      if (first !== undefined) this.used.delete(first);
    }
    return entry.plan;
  }

  /** Test and diagnostics view of what is pending (never exposed through a tool). */
  snapshot(): Array<{ id: string; hash: string; summary: string; cmd: string; wire: Json }> {
    return [...this.pending.values()].map((entry) => ({ id: entry.id, hash: entry.hash, summary: entry.summary, cmd: entry.plan.spec.command, wire: entry.plan.wire }));
  }
}
