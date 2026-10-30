import type { CatalogGate } from "./gate.js";
import type { ActionLog } from "./action-log.js";
import type { LiveApi } from "./live-api.js";
import type { ServerConfig } from "../config/index.js";
import type { ToolRegistry, ToolResult } from "../mcp/index.js";
import type { HostService } from "../host/host.js";
import type { EarsService } from "../ears/service.js";
import { VERSION } from "../version.js";

export interface StatusDependencies {
  live: Pick<LiveApi, "status">;
  config: ServerConfig;
  /** When given, the status also reports the catalog check of the current connection. */
  gate?: CatalogGate;
  /** When given, the status lists the last destructive actions that ran (memory only). */
  actions?: ActionLog;
  /** When given, the status also reports the cached host automation facts (never starts a process). */
  host?: HostService;
  /** When given, the status also reports the ears feature: enabled, busy and a summary of the last job (no paths). */
  ears?: EarsService;
}

/**
 * `batuta_status`: connection state, protocol, script version, edition and an effective config
 * summary (docs/01-protocol.md section 7.16). It reads the client's cached state and never sends a
 * command to the Remote Script. Paths from the config are summarized as counts only.
 */
export function registerStatusTool(registry: ToolRegistry, { live, config, gate, actions, host, ears }: StatusDependencies): void {
  const description = "Report whether BatutaMCP is connected to Ableton Live, the Live edition, versions and the active safety configuration. Does not change anything.";
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const handler = async (): Promise<ToolResult> => {
      const s = live.status();
      const structuredContent = {
        server: { name: "batuta-mcp", version: VERSION },
        protocol: 1,
        connection: {
          state: s.state,
          protocol: s.protocol,
          live_version: s.liveVersion,
          script_version: s.scriptVersion,
          edition: s.edition,
          edition_source: s.editionSource,
          last_error: s.lastError,
          inflight: s.inflight,
          queued: s.queued,
          reconnect_attempts: s.reconnectAttempts,
        },
        ...(gate === undefined ? {} : { catalog: gate.status() }),
        ...(actions === undefined ? {} : { recent_actions: actions.recent() }),
        ...(host === undefined ? {} : { host: host.status() }),
        ...(ears === undefined ? {} : { ears: ears.status() }),
        config: {
          edition: config.edition,
          destructive: config.destructive,
          confirm: config.confirm,
          gain_guard: { max_jump_db: config.gainGuard.maxJumpDb, max_master_db: config.gainGuard.maxMasterDb },
          browser: { allow_plugins: config.browser.allowPlugins, allow_user_presets: config.browser.allowUserPresets, allow_max_for_live: config.browser.allowMaxForLive, allow_external_devices: config.browser.allowExternalDevices },
          sample_roots_count: config.sampleRoots.length,
          ears_enabled: config.ears.enabled,
          live: { idle_release_s: config.live.idleReleaseS },
        },
      };
      const text = s.state === "ready"
        ? `Connected to Live ${s.liveVersion} (${s.edition}); Remote Script ${s.scriptVersion}; destructive actions: ${config.destructive}.`
        : s.state === "idle" || s.state === "released"
          ? `Not connected to Live (${s.state}): BatutaMCP connects on the next tool call that needs Live${s.lastError ? `. Last problem: ${s.lastError.message}` : ""}.`
          : `Not connected to Live (${s.state})${s.lastError ? `: ${s.lastError.message}` : ""}.`;
      return { content: [{ type: "text", text }], structuredContent };
  };
  registry.register({ name: "batuta_status", title: "BatutaMCP status", description, inputSchema: { type: "object", additionalProperties: false }, annotations, handler });
  // Compatibility name for the same report.
  registry.register({ name: "health", title: "BatutaMCP health", description: `${description} Same as batuta_status.`, inputSchema: { type: "object", additionalProperties: false }, annotations, handler });
  // Compatibility name: the connected Remote Script and Live, from the cached state only.
  registry.register({
    name: "get_remote_script_info", title: "Remote Script info",
    description: "Report the connected Remote Script: connection state, script_version, protocol, Live version and edition (cached state; sends nothing).",
    inputSchema: { type: "object", additionalProperties: false }, annotations,
    handler: async () => {
      const s = live.status();
      const structuredContent = { server: { name: "batuta-mcp", version: VERSION }, connected: s.state === "ready", state: s.state, protocol: s.protocol, script_version: s.scriptVersion, live_version: s.liveVersion, edition: s.edition, edition_source: s.editionSource };
      return { content: [{ type: "text", text: s.state === "ready" ? `Remote Script ${String(s.scriptVersion)} on Live ${String(s.liveVersion)} (${String(s.edition)}).` : `Not connected to Live (${s.state}).` }], structuredContent };
    },
  });
}
