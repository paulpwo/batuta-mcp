import { LiveError } from "../live/index.js";
import type { Welcome } from "../live/index.js";
import type { Logger } from "../log.js";
import { ToolError } from "../mcp/index.js";
import { VERSION } from "../version.js";
import { asToolError } from "./errors.js";
import type { LiveApi } from "./live-api.js";
import type { Classification, CommandSpec } from "./types.js";
import { asArray, asString, isObject } from "./util.js";

/**
 * Startup catalog check (docs/01-protocol.md sections 9.1 and 11). After every (re)connect, before
 * the first command, the server reads the script's `catalog` and compares it with its own table:
 *  - a command the script lacks, or whose mutating flag differs: that tool fails with a version error;
 *  - a stricter destructive class in the script wins over the server's (never the other way round);
 *  - a command only the script has is not exposed until it has been reviewed.
 */

export interface CatalogProblem { command: string; problem: string }

export interface GateStatus {
  state: "pending" | "ok" | "mismatch";
  problems: CatalogProblem[];
  unreviewed: string[];
  script_version: string | null;
}

interface Checked {
  welcome: Welcome;
  problems: Map<string, string>;
  /** When set, every tool fails with this reason (no usable catalog). */
  blanket: string | undefined;
  stricter: Map<string, Classification>;
  unreviewed: string[];
  scriptVersion: string | null;
}

function rank(value: Classification): number {
  return value === "never" ? 0 : value === "conditional" ? 1 : 2;
}

function isClassification(value: unknown): value is Classification {
  return value === "never" || value === "conditional" || value === "always";
}

function versionError(detail: string, extra: Record<string, unknown>, scriptVersion: string | null): ToolError {
  return new ToolError("version_mismatch", `The Remote Script does not match this server (${detail}). Reinstall BatutaMCP so the server and the Remote Script come from the same release.`, {
    ...extra, server_version: VERSION, script_version: scriptVersion,
  });
}

export class CatalogGate {
  private checked: Checked | undefined;
  private running: Promise<void> | undefined;

  constructor(private readonly live: LiveApi, private readonly specs: readonly CommandSpec[], private readonly logger: Logger) {}

  /** Connect (waiting briefly) and make sure the catalog of THIS connection has been checked. */
  async ensure(): Promise<void> {
    let welcome: Welcome;
    try {
      welcome = await this.live.ready();
    } catch (error) {
      throw asToolError(error, false);
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (this.checked?.welcome === welcome) return;
      if (this.running === undefined) {
        this.running = this.check(welcome).finally(() => { this.running = undefined; });
      }
      await this.running;
    }
  }

  private async check(welcome: Welcome): Promise<void> {
    let raw: unknown;
    try {
      raw = await this.live.call("catalog", {}, { requeueOnReconnect: true });
    } catch (error) {
      if (error instanceof LiveError && error.code === "unknown_command") {
        this.record(welcome, null, "the Remote Script has no catalog command", []);
        return;
      }
      throw asToolError(error, false);
    }
    const commands = isObject(raw) ? asArray(raw["commands"]) : [];
    const scriptVersion = isObject(raw) ? (asString(raw["script_version"]) ?? null) : null;
    if (!isObject(raw) || !Array.isArray(raw["commands"]) || commands.length === 0) {
      this.record(welcome, scriptVersion, "the Remote Script returned an unreadable command catalog", []);
      return;
    }
    this.record(welcome, scriptVersion, undefined, commands);
  }

  private record(welcome: Welcome, scriptVersion: string | null, blanket: string | undefined, commands: unknown[]): void {
    const problems = new Map<string, string>();
    const stricter = new Map<string, Classification>();
    const known = new Set<string>();
    const theirs = new Map<string, { mutating: unknown; destructive: unknown }>();
    for (const entry of commands) {
      if (!isObject(entry) || typeof entry["name"] !== "string") continue;
      known.add(entry["name"]);
      theirs.set(entry["name"], { mutating: entry["mutating"], destructive: entry["destructive"] });
    }
    for (const spec of this.specs) {
      const found = theirs.get(spec.command);
      if (found === undefined) { problems.set(spec.command, "the Remote Script does not provide this command"); continue; }
      if (found.mutating !== spec.mutating) {
        problems.set(spec.command, `mutating flag differs (server ${String(spec.mutating)}, Remote Script ${String(found.mutating)})`);
        continue;
      }
      if (!isClassification(found.destructive)) { problems.set(spec.command, "the Remote Script reports an unknown destructive class"); continue; }
      if (rank(found.destructive) > rank(spec.destructive)) stricter.set(spec.command, found.destructive);
    }
    const mine = new Set(this.specs.map((spec) => spec.command));
    const unreviewed = [...known].filter((name) => name !== "catalog" && !mine.has(name)).sort();
    if (problems.size > 0 || blanket !== undefined || unreviewed.length > 0) {
      this.logger.warn(`catalog check: ${blanket ?? `${problems.size} tool(s) disabled`}${unreviewed.length > 0 ? `; unreviewed script commands: ${unreviewed.join(", ")}` : ""}`);
    }
    this.checked = { welcome, problems, blanket, stricter, unreviewed, scriptVersion };
  }

  /** The stricter of the server's and the script's classification. */
  classOf(spec: CommandSpec): Classification {
    return this.checked?.stricter.get(spec.command) ?? spec.destructive;
  }

  /** Throws a version error when this command cannot be trusted with the connected script. */
  assertUsable(spec: CommandSpec): void {
    const checked = this.checked;
    if (checked === undefined) return;
    if (checked.blanket !== undefined) throw versionError(checked.blanket, { reason: "no_catalog", command: spec.command }, checked.scriptVersion);
    const problem = checked.problems.get(spec.command);
    if (problem !== undefined) throw versionError(`${spec.command}: ${problem}`, { reason: "command_mismatch", command: spec.command, problem }, checked.scriptVersion);
  }

  status(): GateStatus {
    const checked = this.checked;
    if (checked === undefined) return { state: "pending", problems: [], unreviewed: [], script_version: null };
    const problems = [...checked.problems].map(([command, problem]) => ({ command, problem }));
    if (checked.blanket !== undefined) problems.unshift({ command: "*", problem: checked.blanket });
    return { state: problems.length > 0 ? "mismatch" : "ok", problems, unreviewed: checked.unreviewed, script_version: checked.scriptVersion };
  }
}
