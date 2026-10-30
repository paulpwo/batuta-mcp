/**
 * Memory-only record of the last destructive actions that actually ran (shown by `batuta_status`).
 * Nothing is written to disk. Targets come from Live listings (escaped, cut), never from model text.
 */

export const MAX_ACTIONS = 50;

export interface ActionEntry {
  /** UTC time the action was sent, ISO 8601. */
  time: string;
  tool: string;
  targets: string[];
  /** True when Live's undo takes the action back as one step. */
  undoable: boolean;
  /** Host automation calls only: "ok", or the error code the call ended with. */
  outcome?: string;
}

export class ActionLog {
  private readonly entries: ActionEntry[] = [];

  constructor(private readonly now: () => Date = () => new Date()) {}

  record(entry: Omit<ActionEntry, "time">): void {
    this.entries.push({ time: this.now().toISOString(), ...entry });
    while (this.entries.length > MAX_ACTIONS) this.entries.shift();
  }

  /** Newest first. */
  recent(): ActionEntry[] {
    return [...this.entries].reverse();
  }
}
