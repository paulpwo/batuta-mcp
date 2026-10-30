import { TRANSPORT_PANEL_HTML, TRANSPORT_PANEL_URI } from "../ui/transport-panel.js";

/**
 * The MCP Apps (extension `io.modelcontextprotocol/ui`) side of the server: static `ui://` HTML
 * resources and the tools that point at them. Nothing here reads a file or opens a connection.
 */

export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

export interface UiResource {
  uri: string;
  name: string;
  title: string;
  description: string;
  mimeType: string;
  text: string;
}

export const UI_RESOURCES: readonly UiResource[] = Object.freeze([
  {
    uri: TRANSPORT_PANEL_URI,
    name: "transport-panel",
    title: "Ableton transport panel",
    description: "Interactive transport panel: back to start, back a bar, play, stop, forward a bar and the song position. Calls get_transport, control_transport and set_song_position through the host.",
    mimeType: MCP_APP_MIME_TYPE,
    text: TRANSPORT_PANEL_HTML,
  },
]);

/** Tools that open a UI resource: `ui.resourceUri` is the MCP Apps link, `openai/outputTemplate` the same link for ChatGPT. */
export const TOOL_UI_META: ReadonlyMap<string, Readonly<Record<string, unknown>>> = new Map([
  ["show_transport_panel", Object.freeze({ ui: Object.freeze({ resourceUri: TRANSPORT_PANEL_URI }), "openai/outputTemplate": TRANSPORT_PANEL_URI })],
]);

export function findUiResource(uri: string): UiResource | undefined {
  return UI_RESOURCES.find((resource) => resource.uri === uri);
}

/** `resources/list` entry: everything except the body. */
export function listedResource(resource: UiResource): Record<string, unknown> {
  const { text: _text, ...listed } = resource;
  return listed;
}

/** `resources/read` content. No `csp`: the spec default applies (inline script and style, no network). */
export function resourceContents(resource: UiResource): Record<string, unknown> {
  return { uri: resource.uri, mimeType: resource.mimeType, text: resource.text, _meta: { ui: { prefersBorder: true } } };
}
