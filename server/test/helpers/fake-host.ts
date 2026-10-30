import fs from "node:fs";
import path from "node:path";
import { SAVE_AS_SCRIPT } from "../../src/host/scripts.js";
import type { HostRunOptions, HostRunResult, HostRunner } from "../../src/host/runner.js";

/** One call the host module made to the injected runner. */
export interface HostCall {
  binary: string;
  args: string[];
  options: HostRunOptions;
}

type Reply = Partial<HostRunResult>;

/**
 * An in-memory runner: records every call (binary, argv, options) and answers from a function.
 * No process is ever started. By default the running check reports `running` and everything else succeeds with `ok`.
 */
export class FakeRunner {
  readonly calls: HostCall[] = [];
  /** Absolute app paths the running check reports as running. */
  running: string[] = [];
  /** Overrides the default answer; return undefined to fall back to it. */
  answer: (call: HostCall) => Reply | undefined = () => undefined;
  /** Simulate Live writing the file when the Save As script succeeds (so the server can verify it landed). */
  landSaveAs = true;
  /** Where the simulated Live writes: the given path, or `<folder>/<name> Project/<name>.als` (what Live 12.4.7 Lite does outside a Live project). */
  landLayout: "direct" | "project" = "direct";

  readonly run: HostRunner = (binary, args, options) => {
    const call: HostCall = { binary, args: [...args], options: { ...options, env: { ...options.env } } };
    this.calls.push(call);
    const custom = this.answer(call);
    const isRunningCheck = binary === "/usr/bin/osascript" && call.args[1] !== undefined && call.args[1].includes("is running");
    const base: HostRunResult = { code: 0, stdout: isRunningCheck ? this.running.join("\n") : "ok", stderr: "", timedOut: false, truncated: false };
    const result = { ...base, ...(custom ?? {}) };
    if (this.landSaveAs && binary === "/usr/bin/osascript" && call.args[1] === SAVE_AS_SCRIPT && result.code === 0 && call.args[2] !== undefined) {
      if (this.landLayout === "direct") fs.writeFileSync(call.args[2], "saved by the fake Live");
      else {
        const stem = path.basename(call.args[2], path.extname(call.args[2]));
        const folder = path.join(path.dirname(call.args[2]), `${stem} Project`);
        fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(path.join(folder, path.basename(call.args[2])), "saved by the fake Live");
      }
    }
    return Promise.resolve(result);
  };

  /** The calls that are not the running check. */
  actions(): HostCall[] {
    return this.calls.filter((call) => !(call.binary === "/usr/bin/osascript" && (call.args[1] ?? "").includes("is running")));
  }
}
