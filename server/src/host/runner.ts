import { execFile } from "node:child_process";
import type { ExecFileException } from "node:child_process";
import { MENU_SCRIPT, RUNNING_SCRIPT, SAVE_AS_SCRIPT } from "./scripts.js";

/**
 * The only module of the server that starts a process (docs/04-host-automation.md section 1).
 * It enforces its own contract, whoever calls it: `/usr/bin/osascript` runs only `-e` followed by
 * one of the constant AppleScript sources (compared with ===) and exactly the arguments that script
 * takes (menu ids, a .als path and a 0/1 flag, Live bundle paths); `/usr/bin/open` runs only `-a`
 * followed by one of the six Live 12 bundles in /Applications and at most one .als document. Everything else is refused before a process exists.
 * Never a shell, always a timeout, an output limit and an environment the caller builds. The static
 * checks in test/helpers/ast-scan.ts allow `node:child_process` in this file alone (only `execFile`),
 * and allow value imports of this module only in host/host.ts and tools/index.ts, by name.
 */

export const OPEN_BINARY = "/usr/bin/open";
export const OSASCRIPT_BINARY = "/usr/bin/osascript";
export const ALLOWED_BINARIES: readonly string[] = Object.freeze([OPEN_BINARY, OSASCRIPT_BINARY]);

export interface HostRunOptions {
  /** The process is killed after this many milliseconds. */
  timeoutMs: number;
  /** The process is killed when stdout or stderr exceeds this many bytes. */
  maxBytes: number;
  /** The complete environment of the child. Nothing is inherited. */
  env: Record<string, string>;
}

export interface HostRunResult {
  /** Exit code; null when the process did not exit normally (killed, not started). */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** The output limit was exceeded. */
  truncated: boolean;
  /** Set when the process could not be run at all (`binary_not_allowed` also covers a contract violation). */
  failure?: "binary_not_allowed" | "spawn_failed";
}

/** (binary, argv, options) -> result. The host module only ever talks to this type; tests inject a fake. */
export type HostRunner = (binary: string, args: readonly string[], options: HostRunOptions) => Promise<HostRunResult>;

const REFUSED: HostRunResult = { code: null, stdout: "", stderr: "", timedOut: false, truncated: false, failure: "binary_not_allowed" };

/** The only applications `open` may start: the Live 12 bundles directly under /Applications. */
const LIVE_BUNDLE = /^\/Applications\/Ableton Live 12 (Suite|Standard|Lite|Intro|Trial|Beta)\.app$/;
const MENU_ACTIONS: readonly string[] = ["new", "save", "export"];

/** An absolute path to a Live set. */
function isSetPath(value: string): boolean {
  return value.startsWith("/") && !value.includes("\u0000") && value.toLowerCase().endsWith(".als") && value.length > 5;
}

/**
 * The argv shapes the host module is allowed to run, down to the values of the variables. Pure, so tests can
 * check it without a process.
 */
export function contractAllows(binary: string, args: readonly string[]): boolean {
  if (binary === OSASCRIPT_BINARY) {
    const script = args[0] === "-e" ? args[1] : undefined;
    const rest = args.slice(2);
    if (script === RUNNING_SCRIPT) return rest.every((value) => LIVE_BUNDLE.test(value));
    if (script === MENU_SCRIPT) return rest.length === 1 && MENU_ACTIONS.includes(rest[0] ?? "");
    if (script === SAVE_AS_SCRIPT) return rest.length === 2 && isSetPath(rest[0] ?? "") && (rest[1] === "0" || rest[1] === "1");
    return false;
  }
  if (binary === OPEN_BINARY) {
    if (args[0] !== "-a" || (args.length !== 2 && args.length !== 3)) return false;
    const app = args[1];
    const document = args[2];
    return app !== undefined && LIVE_BUNDLE.test(app) && (document === undefined || isSetPath(document));
  }
  return false;
}

/** The execFile options for a call: one place, so the tests check the options that really run. No `shell`, ever. */
export function execOptionsFor(options: HostRunOptions): { timeout: number; maxBuffer: number; env: Record<string, string>; encoding: "utf8"; windowsHide: true; killSignal: "SIGKILL" } {
  return { timeout: options.timeoutMs, maxBuffer: options.maxBytes, env: { ...options.env }, encoding: "utf8", windowsHide: true, killSignal: "SIGKILL" };
}

/** Turn the execFile callback arguments into a result. */
export function resultFromExec(error: ExecFileException | null, stdout: string, stderr: string): HostRunResult {
  if (error === null) return { code: 0, stdout, stderr, timedOut: false, truncated: false };
  const code: unknown = error.code;
  const truncated = code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
  const timedOut = error.killed === true && !truncated && error.signal === "SIGKILL";
  const exitCode = typeof code === "number" ? code : null;
  const failed = typeof code === "string" && !truncated;
  return { code: exitCode, stdout, stderr, timedOut, truncated, ...(failed ? { failure: "spawn_failed" as const } : {}) };
}

function run(binary: string, args: readonly string[], options: HostRunOptions): Promise<HostRunResult> {
  return new Promise<HostRunResult>((resolve) => {
    const child = execFile(binary, [...args], execOptionsFor(options), (error, stdout, stderr) => {
      resolve(resultFromExec(error, stdout, stderr));
    });
    child.stdin?.end();
  });
}

/** The production runner: the contract above, no parameters. */
export function createExecRunner(): HostRunner {
  return (binary, args, options) => (contractAllows(binary, args) ? run(binary, args, options) : Promise.resolve({ ...REFUSED }));
}
