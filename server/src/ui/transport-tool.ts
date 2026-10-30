import { ToolError } from "../mcp/index.js";
import type { ToolRegistry } from "../mcp/index.js";

/**
 * `show_transport_panel`: opens the MCP App transport panel (`ui://batuta/transport-panel-v3.html`) in hosts
 * that render MCP Apps. The `_meta` link to the panel is added to the tool listing by the MCP server (mcp/resources.ts).
 * The call itself is `get_transport`, so every other host still gets the complete text answer.
 */

export const TRANSPORT_PANEL_TOOL = "show_transport_panel";

export function registerTransportPanelTool(registry: ToolRegistry): void {
  const transport = registry.get("get_transport");
  if (transport === undefined) throw new ToolError("internal_error", "show_transport_panel needs get_transport to be registered first");
  registry.register({
    name: TRANSPORT_PANEL_TOOL,
    title: "Show the transport panel",
    description: "Show the Ableton transport panel (back to start, back a bar, a play/stop toggle, forward a bar, and the song position) in hosts that render MCP Apps, such as Claude Desktop. Returns the same transport report as get_transport, so hosts without MCP Apps get it as text. Read-only: the panel's buttons call control_transport and set_song_position.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: (args, context) => transport.tool.handler(args, context),
  });
}
