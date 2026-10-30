import type { ToolAnnotations } from "../mcp/index.js";
import { CLIP_SPECS } from "./specs-clips.js";
import { DEVICE_SPECS } from "./specs-devices.js";
import { SESSION_SPECS } from "./specs-session.js";
import { BATCH_FORBIDDEN, batchSpec } from "./specs-batch.js";
import { withCompat } from "./compat.js";
import { PUBLIC_NAMES } from "./names.js";
import type { CommandSpec } from "./types.js";

/**
 * The server's own command table (docs/01-protocol.md section 9.1): 82 commands, one broad MCP tool each (public names in names.ts).
 * `catalog` is internal (the startup check) and has no tool. The table is static; nothing read
 * from Live ever becomes part of a tool name, description or schema.
 */

const NAME_OF = new Map(Object.entries(PUBLIC_NAMES));

const BASE_SPECS: CommandSpec[] = withCompat([...SESSION_SPECS, ...CLIP_SPECS, ...DEVICE_SPECS]);
const BATCHABLE = BASE_SPECS.filter((s) => !BATCH_FORBIDDEN.has(s.command)).map((s) => toolNameFor(s.command)).sort();

export const COMMAND_SPECS: readonly CommandSpec[] = Object.freeze([...BASE_SPECS, batchSpec(BATCHABLE)]);

const BY_COMMAND = new Map(COMMAND_SPECS.map((spec) => [spec.command, spec]));

export function specFor(command: string): CommandSpec | undefined {
  return BY_COMMAND.get(command);
}

/** The public MCP tool name of a command (names.ts). */
export function toolNameFor(command: string): string {
  const name = NAME_OF.get(command);
  if (name === undefined) throw new Error(`no public tool name for command ${command}`);
  return name;
}

const BY_TOOL = new Map(Object.entries(PUBLIC_NAMES).map(([command, name]) => [name, command]));

/** The wire command behind a public tool name, or undefined. */
export function commandForTool(name: string): string | undefined {
  return BY_TOOL.get(name);
}

/** Commands allowed inside `batch`. */
export function isBatchable(command: string): boolean {
  return BY_COMMAND.has(command) && !BATCH_FORBIDDEN.has(command);
}

/**
 * Annotations (section 7.16): readOnlyHint when the command does not mutate; destructiveHint when
 * a mutating command is `always` or `conditional`; idempotentHint for reads and pure setters;
 * openWorldHint false (Live is the only thing it talks to).
 */
export function annotationsFor(spec: CommandSpec): ToolAnnotations {
  return {
    readOnlyHint: !spec.mutating,
    destructiveHint: spec.mutating && spec.destructive !== "never",
    idempotentHint: !spec.mutating || spec.idempotent === true,
    openWorldHint: false,
  };
}
