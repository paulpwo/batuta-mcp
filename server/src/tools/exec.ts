import { LiveError } from "../live/index.js";
import { ElicitationUnavailableError, McpCancelledError, McpTimeoutError, ToolError } from "../mcp/index.js";
import { ConfirmationStore } from "./confirm.js";
import type { CatalogGate } from "./gate.js";
import type { ActionLog } from "./action-log.js";
import { specFor, toolNameFor } from "./catalog.js";
import { summarize } from "./summary.js";
import { externalRefusal, externalSummary } from "./external-ack.js";
import type { Logger } from "../log.js";
import type { ServerConfig } from "../config/index.js";
import type { ToolContext, ToolResult } from "../mcp/index.js";
import { asToolError } from "./errors.js";
import type { LiveApi } from "./live-api.js";
import { Planner } from "./plan.js";
import type { OpPlan } from "./plan.js";
import type { ReadFn } from "./resolve.js";
import { shapeResult } from "./result.js";
import type { CommandSpec } from "./types.js";
import { asObject, canonicalJson } from "./util.js";
import type { Json } from "./util.js";

export interface ExecutorDeps {
  live: LiveApi;
  config: ServerConfig;
  logger: Logger;
  /** Validate the arguments of a batch op against the tool schema of its command. */
  validateOp: (spec: CommandSpec, args: unknown, op: number) => void;
  /** Monotonic milliseconds (for the confirmation lifetime). */
  clock: () => number;
  gate: CatalogGate;
  /** Where executed destructive actions are noted for batuta_status. */
  actions: ActionLog;
}

/**
 * The commands the ears flow may send on its own channel (docs/01-protocol.md 7.12). `track_delete` is not
 * here: the only way to delete is {@link Executor.deleteEarsTrack}. The channel exists because the flow sets
 * the reserved `ears_internal` flag, which no tool schema offers.
 */
/** How often one call may put the external-input question: the first refusal, and once more when the set grew after the answer. */
const MAX_EXTERNAL_ASKS = 2;
const EARS_COMMANDS: ReadonlySet<string> = new Set(["song_info", "track_list", "track_create", "routing_get", "routing_set", "batch", "track_set", "transport", "slot_fire", "slot_status", "clip_get", "slot_stop", "song_set_time", "track_select"]);
const EARS_CREATE_ARGS = canonicalJson({ type: "audio", name: "batuta-ears", index: -1, ears_internal: true });

const CONFIRM_SCHEMA = {
  type: "object" as const,
  title: "Confirm",
  properties: { confirm: { type: "boolean" as const, title: "Run this action", description: "Choose true to run the action exactly as described." } },
  required: ["confirm"],
};

function cancelled(): ToolResult {
  return { content: [{ type: "text", text: "Cancelled: the action was not confirmed and nothing was changed." }], structuredContent: { cancelled: true } };
}

/**
 * Runs one tool call: connect and check the catalog, plan (resolve selectors, edition and gain
 * guards, destructive classification), confirm when destructive, send, shape the result.
 */
export class Executor {
  readonly confirmations: ConfirmationStore;

  constructor(protected readonly deps: ExecutorDeps) {
    this.confirmations = new ConfirmationStore(deps.clock);
  }

  /** Read-only calls used for listings and guards: safe to replay after a reconnect. */
  protected reader(signal: AbortSignal): ReadFn {
    return async (cmd, args) => {
      try {
        return asObject(await this.deps.live.call(cmd, args, { signal, requeueOnReconnect: true }));
      } catch (error) {
        throw asToolError(error, false);
      }
    };
  }

  /** Connect and make sure the connected script's catalog has been compared with this server's table. */
  protected async connect(): Promise<void> {
    await this.deps.gate.ensure();
  }

  /** Send one command. Only read-only commands may be replayed after a reconnect. */
  protected async send(spec: CommandSpec, cmd: string, args: Json, signal: AbortSignal, externalInputAck?: readonly string[]): Promise<unknown> {
    try {
      return await this.deps.live.call(cmd, args, { signal, requeueOnReconnect: !spec.mutating, ...(externalInputAck === undefined ? {} : { externalInputAck }) });
    } catch (error) {
      if (error instanceof LiveError) throw asToolError(error, spec.mutating);
      throw error;
    }
  }

  async run(spec: CommandSpec, args: Json, context: ToolContext): Promise<ToolResult> {
    await this.connect();
    const planner = new Planner({ config: this.deps.config, welcomeEdition: this.deps.live.welcome?.edition, read: this.reader(context.signal), validateOp: this.deps.validateOp, classOf: (s) => this.deps.gate.classOf(s), assertUsable: (s) => { this.deps.gate.assertUsable(s); } });
    const plan: OpPlan = spec.command === "batch" ? await planner.planBatch(spec, args) : await planner.planOp(spec, args);
    if ((plan.destructive || plan.irreversible) && this.mustAsk(plan)) {
      const outcome = await this.confirm(plan, context);
      if (outcome !== undefined) return outcome;
    }
    return this.execute(plan, context);
  }

  /**
   * Confirmation policy (docs/01-protocol.md section 9.1a). `destructive` asks for every destructive
   * class; the default `irreversible` asks only for what Live's undo cannot reverse (host actions,
   * added with them) and for gain guard trips. The rest runs and says how to take it back.
   */
  private mustAsk(plan: OpPlan): boolean {
    return this.deps.config.confirm === "destructive" || plan.gain.length > 0 || plan.irreversible;
  }

  /** A host automation plan (docs/04-host-automation.md): same confirmation policy, but no Remote Script connection is needed. */
  async runHost(plan: OpPlan, context: ToolContext): Promise<ToolResult> {
    if ((plan.destructive || plan.irreversible) && this.mustAsk(plan)) {
      const outcome = await this.confirm(plan, context);
      if (outcome !== undefined) return outcome;
    }
    return this.execute(plan, context);
  }

  /**
   * Send the plan. A recording with a live external input is refused by the script as acknowledgeable: ask the
   * owner (same elicitation and timeout as the other confirmations) and send it again with the acknowledgement,
   * which names exactly the track ids the question showed. If the set grew meanwhile the script refuses again and
   * the owner is asked once more with the new list; a third refusal is an error. A client that cannot ask means
   * refuse: nothing is stored, so no later `batuta_confirm` can release it. A batch is refused as a whole before
   * any op runs, so asking and re-sending is safe.
   */
  private async execute(plan: OpPlan, context: ToolContext): Promise<ToolResult> {
    if (plan.host !== undefined) return plan.host();
    let result: unknown;
    let acknowledged: readonly string[] | undefined;
    for (let asked = 0; ; asked += 1) {
      try {
        result = await this.send(plan.spec, plan.spec.command, plan.wire, context.signal, acknowledged);
        break;
      } catch (error) {
        const refusal = asked >= MAX_EXTERNAL_ASKS ? undefined : externalRefusal(error);
        if (refusal === undefined) throw error;
        const answer = await this.elicitConfirm(externalSummary(refusal.names, plan.spec.summary, refusal.ids.length), context);
        if (answer === undefined) {
          throw new ToolError("not_supported", "This recording may capture a live external input, so it needs your confirmation and this client cannot ask. Nothing was changed; confirm it in Live yourself or use a client that supports confirmation questions.", { reason: "external_input_live", tracks: refusal.names.slice(0, 8) });
        }
        if (answer === false) return cancelled();
        acknowledged = refusal.ids;
      }
    }
    if (plan.destructive || plan.irreversible) {
      const parts = plan.children === undefined ? [plan] : plan.children.filter((child) => child.destructive);
      this.deps.actions.record({ tool: toolNameFor(plan.spec.command), targets: parts.flatMap((part) => part.targets), undoable: plan.destructive });
    }
    return shapeResult(plan.spec, result, plan.warnings, plan.destructive);
  }

  /**
   * Ask one yes/no question through the client. true = accepted, false = declined or cancelled, undefined = the client
   * cannot ask (the caller falls back to `batuta_confirm`). No answer in time is a `confirmation_failed` error.
   */
  private async elicitConfirm(summary: string, context: ToolContext): Promise<boolean | undefined> {
    if (!context.canElicit) return undefined;
    try {
      const answer = await context.elicitForm({ message: summary, requestedSchema: CONFIRM_SCHEMA });
      return answer.action === "accept" && answer.content["confirm"] === true;
    } catch (error) {
      if (error instanceof McpCancelledError) throw error;
      if (error instanceof McpTimeoutError) {
        const seconds = Math.max(1, Math.ceil((error.timeoutMs ?? 0) / 1000));
        this.deps.logger.warn(`confirmation timed out after ${seconds} s`);
        throw new ToolError("confirmation_failed", `Nobody answered the confirmation within ${seconds} second${seconds === 1 ? "" : "s"}, so nothing was changed. Ask again if you still want it.`, { reason: "timeout", timeout_seconds: seconds });
      }
      if (!(error instanceof ElicitationUnavailableError)) {
        this.deps.logger.warn(`confirmation could not be obtained: ${(error as Error).message}`);
        throw new ToolError("confirmation_failed", "The confirmation could not be obtained from the client, so nothing was changed. Try again.", { reason: (error as Error).name });
      }
      return undefined;
    }
  }

  /** Ask the user (elicitation) or store the operation for `batuta_confirm`. Returns a result to stop with, or undefined to go ahead. */
  private async confirm(plan: OpPlan, context: ToolContext): Promise<ToolResult | undefined> {
    const summary = summarize(plan);
    const answer = await this.elicitConfirm(summary, context);
    if (answer === true) return undefined;
    if (answer === false) return cancelled();
    return this.storeConfirmation(plan, summary);
  }

  private storeConfirmation(plan: OpPlan, summary: string): ToolResult {
    const { confirmId, expiresIn } = this.confirmations.put(plan, summary);
    return {
      content: [{ type: "text", text: `Confirmation required: ${summary}\nTo run it, call batuta_confirm with confirm_id "${confirmId}" and this exact summary (valid ${expiresIn} seconds).` }],
      structuredContent: { confirmation_required: true, confirm_id: confirmId, summary, expires_in: expiresIn, next: "call batuta_confirm" },
    };
  }

  /** `batuta_confirm`: release a stored operation and run it. */
  async runConfirmed(args: Json, context: ToolContext): Promise<ToolResult> {
    const confirmId = String(args["confirm_id"] ?? "");
    if (this.confirmations.peek(confirmId)?.host === undefined) await this.connect();
    const plan = this.confirmations.take(confirmId, String(args["summary"] ?? ""));
    if (plan.host === undefined) this.deps.gate.assertUsable(plan.spec);
    return this.execute(plan, context);
  }

  /** The ears flow's connect step: connect and check that the script has every command the flow uses. */
  async earsPrepare(): Promise<void> {
    await this.connect();
    for (const command of [...EARS_COMMANDS, "track_delete"]) {
      const spec = specFor(command);
      if (spec === undefined) throw new ToolError("internal_error", `unknown command ${command}`);
      this.deps.gate.assertUsable(spec);
    }
  }

  /**
   * Ask whether a recording may capture the live external inputs of `tracks` (the ears flow, which has no plan of its
   * own). true = accepted; false = declined, or the client cannot ask (the flow then refuses as before).
   */
  async askExternalInput(tracks: string[], what: string, context: ToolContext, total = tracks.length): Promise<boolean> {
    return (await this.elicitConfirm(externalSummary(tracks, what, total), context)) === true;
  }

  /**
   * One command of the ears flow, raw errors included (the flow tells a lost connection from a refusal).
   * Only the fixed command set above; the track it creates is always the reserved one; reads may be replayed
   * after a reconnect, writes never.
   */
  async earsCall(cmd: string, args: Json, signal: AbortSignal | undefined, timeoutMs?: number, externalInputAck?: readonly string[]): Promise<Json> {
    const spec = EARS_COMMANDS.has(cmd) ? specFor(cmd) : undefined;
    if (spec === undefined) throw new ToolError("internal_error", "The ears flow tried a command outside its allowlist.", { command: cmd });
    if (cmd === "track_create" && canonicalJson(args) !== EARS_CREATE_ARGS) throw new ToolError("internal_error", "The ears flow may only create the reserved ears track.");
    if (cmd === "batch" && !Array.isArray(args["ops"])) throw new ToolError("internal_error", "Malformed ears batch.");
    if (cmd === "batch" && (args["ops"] as unknown[]).some((op) => asObject(op)["cmd"] !== "track_set")) throw new ToolError("internal_error", "The ears flow batch may only set track properties.");
    return asObject(await this.deps.live.call(cmd, args, { ...(signal === undefined ? {} : { signal }), requeueOnReconnect: !spec.mutating, ...(timeoutMs === undefined ? {} : { timeoutMs }), ...(externalInputAck === undefined ? {} : { externalInputAck }) }));
  }

  /**
   * The ears cleanup exemption (docs/01-protocol.md section 9.3 item 4): deletes the temporary
   * `batuta-ears` track the ears job created, without confirmation, whatever the destructive mode.
   * It is not reachable from any tool schema and is fixed to that one command and name.
   */
  async deleteEarsTrack(index: number, signal: AbortSignal): Promise<unknown> {
    const args: Json = { track: { kind: "track", index, expect_name: "batuta-ears" }, expect_name: "batuta-ears" };
    try {
      return await this.deps.live.call("track_delete", args, { signal, requeueOnReconnect: false });
    } catch (error) {
      throw asToolError(error, true);
    }
  }
}
