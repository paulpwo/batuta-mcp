import { ALIAS_SPECS } from "../../src/tools/aliases.js";
import { COMMAND_SPECS, toolNameFor } from "../../src/tools/catalog.js";
import { COMPOSITE_INFO } from "../../src/tools/composites.js";
import { EARS_TOOLS } from "../../src/tools/ears.js";
import { HOST_TOOLS } from "../../src/tools/host.js";

/**
 * The naming table of docs/03-tool-names.md, generated from the code: the broad tools, their compat
 * argument names, the narrow aliases and the composites. A test compares the document with this text,
 * so the document cannot drift from the server. To refresh the document, print `namingTable()`.
 */

export const SERVER_TOOLS = ["batuta_confirm", "batuta_status", "show_transport_panel"] as const;

const code = (text: string): string => `\`${text}\``;
const list = (names: string[]): string => (names.length === 0 ? "-" : names.map(code).join(", "));

export function namingTable(): string {
  const lines: string[] = [];
  lines.push("### Broad tools (one per Remote Script command)", "", "| Tool | Command | Also accepts (compatibility argument names) |", "|---|---|---|");
  for (const spec of COMMAND_SPECS) lines.push(`| ${code(toolNameFor(spec.command))} | ${code(spec.command)} | ${list(Object.keys(spec.compat?.properties ?? {}))} |`);
  lines.push("", "### Narrow aliases (same executor path and guards as the broad tool)", "", "| Tool | Origin | Runs | Arguments |", "|---|---|---|---|");
  for (const alias of ALIAS_SPECS) {
    const target = COMMAND_SPECS.find((spec) => spec.command === alias.command);
    lines.push(`| ${code(alias.name)} | ${alias.source} | ${code(target === undefined ? alias.command : toolNameFor(target.command))} | ${list(Object.keys(alias.properties))} |`);
  }
  lines.push("", "### Composites (server side, built on the broad tools)", "", "| Tool | Origin | Uses |", "|---|---|---|");
  for (const info of COMPOSITE_INFO) lines.push(`| ${code(info.name)} | ${info.source} | ${info.uses.map(code).join(", ")} |`);
  lines.push("", "### Host tools (server only, no Remote Script command; docs/04-host-automation.md)", "", "| Tool | Arguments | Changes or discards work (destructiveHint) |", "|---|---|---|");
  for (const tool of HOST_TOOLS) lines.push(`| ${code(tool.name)} | ${list(Object.keys(tool.properties))} | ${tool.annotations.destructiveHint === true ? "yes (asks only when it cannot be undone, or in confirm \"destructive\")" : "no"} |`);
  lines.push("", "### Ears tools (server only, no Remote Script command of their own; docs/01-protocol.md section 10)", "", "| Tool | Arguments | Changes the set (readOnlyHint false) |", "|---|---|---|");
  for (const tool of EARS_TOOLS) lines.push(`| ${code(tool.name)} | ${list(Object.keys(tool.properties))} | ${tool.annotations.readOnlyHint === true ? "no" : "yes (its own temporary track, removed again; never asks)"} |`);
  lines.push("", "### Server tools", "", "| Tool | Purpose |", "|---|---|", "| `batuta_confirm` | second step of a confirmation |", "| `batuta_status` | connection, versions, effective safety configuration |", "| `show_transport_panel` | transport state; renders the transport panel in hosts that show MCP Apps |");
  return lines.join("\n");
}
