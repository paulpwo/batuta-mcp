import type { ServerConfig } from "../config/index.js";
import type { Logger } from "../log.js";
import { ToolError, ToolRegistry } from "../mcp/index.js";
import { formatIssues, validate } from "../validate/index.js";
import { COMMAND_SPECS, annotationsFor, toolNameFor } from "./catalog.js";
import { publishedShape } from "./compat.js";
import type { ConfirmationStore } from "./confirm.js";
import { Executor } from "./exec.js";
import { ActionLog } from "./action-log.js";
import { CatalogGate } from "./gate.js";
import type { CommandSpec } from "./types.js";
import type { LiveApi } from "./live-api.js";
import { registerStatusTool } from "./status.js";
import { ALIAS_SPECS } from "./aliases.js";
import { registerComposites } from "./composites.js";
import { registerTransportPanelTool } from "../ui/transport-tool.js";
import { specFor } from "./catalog.js";
import { asObject } from "./util.js";
import { HostService } from "../host/host.js";
import { createExecRunner } from "../host/runner.js";
import type { HostRunner } from "../host/runner.js";
import { registerHostTools } from "./host.js";
import { createEarsService, registerEarsTools } from "./ears.js";
import type { EarsDeps } from "./ears.js";
import type { EarsService } from "../ears/service.js";

export type { EarsDeps } from "./ears.js";

/** Host automation wiring (docs/04-host-automation.md). Tests inject a fake runner and a fake /Applications. */
export interface HostDeps {
  runner?: HostRunner;
  applicationsDir?: string;
  home?: string;
  /** Where the last edition is remembered; default the runtime directory under the home. */
  runtimeDir?: string;
  uid?: number;
  platform?: string;
}

export interface BatutaDeps {
  /** The real client also takes an edition hint provider (asked on connect; see LiveClient.setEditionHintProvider) and a listener for every successful connection. */
  live: LiveApi & {
    setEditionHintProvider?: (provider: () => Promise<"lite" | "standard" | "suite" | undefined>) => void;
    setConnectedListener?: (listener: (welcome: { edition: string }) => void) => void;
  };
  config: ServerConfig;
  logger: Logger;
  /** Monotonic milliseconds; tests replace it. */
  clock?: () => number;
  host?: HostDeps;
  /** Ears wiring (docs/01-protocol.md section 10); tests inject the home folder, a virtual clock and a stub analyzer. */
  ears?: EarsDeps;
}

export interface BatutaTools {
  executor: Executor;
  ears: EarsService;
  gate: CatalogGate;
  confirmations: ConfirmationStore;
}

/** Check the arguments an alias mapped onto a broad tool against that tool's own schema, before anything is sent. */
export function validateMapped(registry: ToolRegistry, target: CommandSpec, mapped: Record<string, unknown>): void {
  const registered = registry.get(toolNameFor(target.command));
  const issues = registered === undefined ? [] : validate(registered.compiled, mapped);
  if (issues.length > 0) throw new ToolError("invalid_args", `Invalid arguments:\n${formatIssues(issues)}`, { reason: "schema", issues: issues.slice(0, 20).map(({ path, keyword, message }) => ({ path, keyword, message })) });
}

/**
 * Register the whole MCP tool surface (docs/01-protocol.md section 7.16): one tool per command,
 * `batuta_confirm`, `batuta_status` and the ears tools (`batuta_ears`, `record_and_analyze`, `analyze_audio`, `compare_audio`).
 */
export function registerBatutaTools(registry: ToolRegistry, deps: BatutaDeps): BatutaTools {
  const validateOp = (opSpec: CommandSpec, args: unknown, op: number): void => {
    const registered = registry.get(toolNameFor(opSpec.command));
    if (registered === undefined) {
      throw new ToolError("not_supported", `Op ${op}: ${opSpec.command} is not available with the current server configuration.`, { reason: "disabled_by_config", op });
    }
    const issues = validate(registered.compiled, args);
    if (issues.length > 0) {
      throw new ToolError("invalid_args", `Invalid arguments for op ${op} (${opSpec.command}):\n${formatIssues(issues)}`, { reason: "schema", op, issues: issues.slice(0, 20).map(({ path, keyword, message }) => ({ path, keyword, message })) });
    }
  };
  const gate = new CatalogGate(deps.live, COMMAND_SPECS, deps.logger);
  const actions = new ActionLog();
  const executor = new Executor({ live: deps.live, config: deps.config, logger: deps.logger, gate, actions, validateOp, clock: deps.clock ?? (() => performance.now()) });
  for (const spec of COMMAND_SPECS) {
    if (spec.destructive === "always" && deps.config.destructive === "disabled") continue;
    if (spec.command === "audio_clip_create" && !deps.config.allowAudioImport) continue;
    const shape = publishedShape(spec);
    registry.register({
      name: toolNameFor(spec.command),
      title: spec.summary,
      description: spec.description,
      inputSchema: { type: "object", properties: shape.properties, ...(shape.required.length === 0 ? {} : { required: shape.required }), additionalProperties: false },
      annotations: annotationsFor(spec),
      handler: (args, context) => executor.run(spec, args, context),
    });
  }
  // Narrow compatibility names: each rewrites its arguments and runs the broad tool's executor path.
  for (const alias of ALIAS_SPECS) {
    const target = specFor(alias.command);
    if (target === undefined || registry.get(toolNameFor(target.command)) === undefined) continue;
    registry.register({
      name: alias.name,
      title: alias.title,
      description: alias.description,
      inputSchema: { type: "object", properties: alias.properties, ...(alias.required === undefined || alias.required.length === 0 ? {} : { required: alias.required }), additionalProperties: false },
      annotations: annotationsFor(target),
      handler: (args, context) => {
        const mapped = asObject(alias.map(args));
        validateMapped(registry, target, mapped);
        return executor.run(target, mapped, context);
      },
    });
  }
  registry.register({
    name: "batuta_confirm",
    title: "Confirm a pending action",
    description: "Second step of a destructive action when the client cannot ask the user directly: after a destructive tool answered confirmation_required, call this with its confirm_id and the exact summary text. It runs the stored action once; ids expire after 60 seconds. Never call it unless the user wants that action.",
    inputSchema: { type: "object", properties: { confirm_id: { type: "string", maxLength: 64 }, summary: { type: "string", maxLength: 600 } }, required: ["confirm_id", "summary"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    handler: (args, context) => executor.runConfirmed(args, context),
  });
  const hostDeps = deps.host ?? {};
  const host = new HostService({ ...hostDeps, runner: hostDeps.runner ?? createExecRunner(), config: deps.config.host });
  // With edition "auto" the running Live bundle is the edition hint (docs/01-protocol.md section 8); an explicit edition needs no probe.
  if (deps.config.edition === "auto" && host.enabled) deps.live.setEditionHintProvider?.(() => host.probeEdition());
  // The edition of every successful connection is remembered, so launch_live/open_set start it next time (host.live_app: auto).
  if (host.enabled) deps.live.setConnectedListener?.((welcome) => host.rememberEdition(welcome.edition));
  if (host.enabled) registerHostTools({ registry, executor, host, config: deps.config, actions });
  const ears = createEarsService(executor, deps.live, deps.config, deps.ears);
  if (deps.config.ears.enabled) registerEarsTools(registry, ears, executor);
  registerStatusTool(registry, { live: deps.live, config: deps.config, gate, actions, host, ears });
  registerComposites({ registry, executor });
  registerTransportPanelTool(registry);
  return { executor, ears, gate, confirmations: executor.confirmations };
}
