import { arr, bool, obj } from "./schemas.js";
import type { Schema } from "../validate/index.js";
import type { CommandSpec } from "./types.js";

/** Wire commands that cannot run inside a batch (docs/01-protocol.md section 7.1). */
export const BATCH_FORBIDDEN = new Set(["batch", "catalog", "undo", "redo", "browser_search"]);

/**
 * `batch`: the op list is validated per op against the tool schema of the op's command, so the
 * published schema stays small. `args` carries the same arguments (including name selectors) as
 * the matching tool.
 */
export function batchSpec(batchable: string[]): CommandSpec {
  const op: Schema = obj({
    cmd: { type: "string", enum: batchable, description: "Tool name of the op, e.g. \"set_track_properties\"." },
    args: { description: "Arguments exactly as the tool named in cmd takes them (selectors and expect_name guards included)." },
  }, ["cmd", "args"]);
  return {
    command: "batch", summary: "Run a batch", mutating: true, destructive: "conditional", conditions: ["ops"],
    description: `Run 1..32 commands as one undo step: {ops:[{cmd, args}], stop_on_error (default true)}. cmd is a command name such as "track_set" and args are that tool's arguments. batch, undo, redo and browser_search cannot be used inside. Name selectors are resolved once, before the batch runs, against the state at that time; when earlier ops change indices, use index references with expect_name. Each op is checked for edition limits and gain limits in order; the batch is destructive when any op is, but it asks the user to confirm only when a gain limit trips (or in the strict confirm mode); otherwise it runs and is undoable as one step. The result lists each op's ok/result/error, executed and partial.`,
    properties: { ops: arr(op, 1, 32), stop_on_error: bool() }, required: ["ops"],
  };
}
