import type { ServerConfig } from "../config/index.js";
import { VARIANTS } from "../host/apps.js";
import type { Variant } from "../host/apps.js";
import type { HostService } from "../host/host.js";
import { shortenPath } from "../host/paths.js";
import { ToolError } from "../mcp/index.js";
import type { ToolAnnotations, ToolRegistry, ToolResult } from "../mcp/index.js";
import type { ActionLog } from "./action-log.js";
import type { Executor } from "./exec.js";
import type { OpPlan } from "./plan.js";
import type { CommandSpec } from "./types.js";
import { safeText } from "./util.js";
import type { Json } from "./util.js";

/**
 * The six host automation tools (docs/04-host-automation.md section 4). They are server-only: no
 * Remote Script command, and they work whether or not Live is connected. Confirmation follows the
 * policy of docs/01-protocol.md section 9.1a through the normal executor path.
 */

export const HOST_TOOL_NAMES = ["launch_live", "open_set", "new_set", "save_set", "save_set_as", "export_audio"] as const;

interface HostToolInfo {
  name: (typeof HOST_TOOL_NAMES)[number];
  title: string;
  description: string;
  properties: Record<string, Json>;
  required: string[];
  annotations: ToolAnnotations;
}

const PATH_SCHEMA: Json = { type: "string", minLength: 1, maxLength: 1024, description: "Absolute path of a Live set (.als), normalized (no . or .. segments, no doubled slash). Any folder is accepted unless host.set_roots narrows it; the set file itself is never a symlink." };

export const HOST_TOOLS: readonly HostToolInfo[] = [
  {
    name: "launch_live", title: "Launch Live",
    description: "Start Ableton Live 12 (or bring it to the front when it is already running) with `open -a`. Without `app` it uses the running Live, else host.live_app, else the edition that connected last (remembered), else Suite, Standard, Lite; the result says which in `chosen_by` (running, requested, config, last_used or default). A second Live is never started. Does not need the Remote Script connection. Not destructive.",
    properties: { app: { type: "string", enum: [...VARIANTS], description: "Which installed edition to start. Refused when a different edition is already running." } },
    required: [], annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "open_set", title: "Open a Live set",
    description: "Open an existing .als set in Live (`open -a`). If the current set has unsaved changes, Live shows its own 'save changes?' dialog, so BatutaMCP does not ask again (only with confirm \"destructive\"); tell the user to answer it in Live. The file is never read or written by BatutaMCP.",
    properties: { path: PATH_SCHEMA }, required: ["path"], annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "new_set", title: "New Live set",
    description: "File > New Live Set in the running Live (menu click through macOS UI scripting; needs Accessibility permission). If the current set has unsaved changes, Live asks about them in its own dialog; tell the user to answer it in Live.",
    properties: {}, required: [], annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "save_set", title: "Save the Live set",
    description: "File > Save Live Set in the running Live (menu click; needs Accessibility permission). A set that was never saved makes Live open its own Save dialog: the result says save_dialog_open, and the user must finish it in Live or you call save_set_as.",
    properties: {}, required: [], annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "save_set_as", title: "Save the Live set as",
    description: "Save the current set under a new .als path by driving Live's Save As dialog (needs Accessibility permission). If the target file already exists it would be replaced for good, so the user is asked first (and with destructive \"disabled\" it is refused). A new file name needs no question. The dialog is first sent to the folder of `path` (nothing is saved unless the folder and the name are verified), then the name is set. Outside a Live project Live writes `<folder>/<name> Project/<name>.als` (a Live Project folder it creates), not `path` itself; the result `path` is the file actually written, and `requested_path` the one asked for. Live must stay in front for the few seconds this takes.",
    properties: { path: PATH_SCHEMA }, required: ["path"], annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "export_audio", title: "Open the export dialog",
    description: "Open Live's Export Audio/Video dialog (menu click; needs Accessibility permission) and stop. The user completes the export in Live; BatutaMCP never starts it. Not destructive.",
    properties: {}, required: [], annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

function spec(command: string, summary: string, destructive: boolean): CommandSpec {
  return { command, summary, description: summary, mutating: true, destructive: destructive ? "conditional" : "never", conditions: [], properties: {} };
}

function resultOf(line: string, structured: Json): ToolResult {
  return { content: [{ type: "text", text: `${line}\n${JSON.stringify(structured)}` }], structuredContent: structured };
}

export interface HostToolDeps {
  registry: ToolRegistry;
  executor: Executor;
  host: HostService;
  config: ServerConfig;
  actions: ActionLog;
}

export function registerHostTools({ registry, executor, host, config, actions }: HostToolDeps): void {
  /** The closure that runs the action; every host call that reached execution is noted in the action log (tool and path, never contents). */
  const logged = (tool: string, targets: string[], run: () => Promise<Json>, line: (out: Json) => string) => async (): Promise<ToolResult> => {
    let outcome = "ok";
    try {
      const out = await run();
      return resultOf(line(out), out);
    } catch (error) {
      outcome = error instanceof ToolError ? error.code : "internal_error";
      throw error;
    } finally {
      actions.record({ tool, targets, undoable: false, outcome });
    }
  };
  const plan = (command: string, summary: string, wire: Json, options: { destructive: boolean; irreversible: boolean; targets: string[]; summaryText?: string; host: () => Promise<ToolResult> }): OpPlan => ({
    spec: spec(command, summary, options.destructive), wire, targets: options.targets, reasons: [], gain: [], irreversible: options.irreversible,
    destructive: options.destructive, warnings: [],
    ...(options.summaryText === undefined ? {} : { summaryText: options.summaryText }), host: options.host,
  });
  const shown = (path: string): string => JSON.stringify(safeText(shortenPath(path, 300), 310));
  const targetOf = (path: string): string => safeText(shortenPath(path, 150), 160);
  const appName = (out: Json): string => String((out["app"] as Json | undefined)?.["name"] ?? "Live");

  type Context = Parameters<Executor["runHost"]>[1];
  type Handler = (args: Json, context: Context) => Promise<ToolResult>;
  const table: Record<(typeof HOST_TOOL_NAMES)[number], Handler> = {
    launch_live: (args, context) => {
      const requested = args["app"] as Variant | undefined;
      return executor.runHost(plan("host_launch_live", "Launch Live", requested === undefined ? {} : { app: requested }, {
        destructive: false, irreversible: false, targets: [],
        host: logged("launch_live", [], () => host.launch(requested), (out) => `${out["action"] === "activated" ? "Brought to the front" : "Launched"} ${appName(out)}.`),
      }), context);
    },
    open_set: (args, context) => {
      const checked = host.checkPath(args["path"], "open");
      return executor.runHost(plan("host_open_set", "Open Live set", { path: checked.path }, {
        destructive: true, irreversible: false, targets: [targetOf(checked.path)],
        summaryText: `Open the Live set ${shown(checked.path)}: Live leaves the current set (it asks first if there are unsaved changes).`,
        host: logged("open_set", [targetOf(checked.path)], () => host.openSet(checked.path), (out) => `Asked ${appName(out)} to open the set. ${String(out["note"])}`),
      }), context);
    },
    new_set: (_args, context) => executor.runHost(plan("host_new_set", "New Live set", {}, {
      destructive: true, irreversible: false, targets: [],
      summaryText: "Start a new Live set: the current set is closed (Live asks first if there are unsaved changes).",
      host: logged("new_set", [], () => host.menu("new"), (out) => `Asked ${appName(out)} for a new set. ${String(out["note"])}`),
    }), context),
    save_set: (_args, context) => executor.runHost(plan("host_save_set", "Save Live set", {}, {
      destructive: false, irreversible: false, targets: [],
      host: logged("save_set", [], () => host.menu("save"), (out) => `${String(out["note"])}`),
    }), context),
    save_set_as: (args, context) => {
      const checked = host.checkPath(args["path"], "save");
      if (checked.exists && config.destructive === "disabled") {
        throw new ToolError("not_supported", "Replacing an existing set is refused because destructive actions are disabled in the configuration. Choose a file name that does not exist yet.", { reason: "disabled_by_config" });
      }
      // The file that would really be replaced: `<name> Project/<name>.als` when that is the one that exists.
      const replaced = checked.target?.path ?? checked.path;
      return executor.runHost(plan("host_save_set_as", "Save Live set as", { path: checked.path, replace: checked.exists }, {
        destructive: checked.exists, irreversible: checked.exists, targets: [targetOf(replaced)],
        ...(checked.exists ? { summaryText: `Save the Live set as ${shown(replaced)}: this REPLACES the existing file and cannot be undone.` } : {}),
        host: logged("save_set_as", [targetOf(checked.path)], () => host.saveSetAs(checked.path, checked.exists), (out) => `Saved the set as ${out["requested_path"] === undefined ? "the given path" : targetOf(String(out["path"]))}${out["replaced"] === true ? " (replaced the existing file)" : ""}.`),
      }), context);
    },
    export_audio: (_args, context) => executor.runHost(plan("host_export_audio", "Open export dialog", {}, {
      destructive: false, irreversible: false, targets: [],
      host: logged("export_audio", [], () => host.menu("export"), (out) => `${String(out["note"])}`),
    }), context),
  };

  const handlers = new Map<string, Handler>(Object.entries(table));
  for (const info of HOST_TOOLS) {
    const handler = handlers.get(info.name);
    if (handler === undefined) continue;
    registry.register({
      name: info.name, title: info.title, description: info.description,
      inputSchema: { type: "object", properties: info.properties, ...(info.required.length === 0 ? {} : { required: info.required }), additionalProperties: false },
      annotations: info.annotations,
      handler: (args, context) => handler(args, context),
    });
  }
}
