import { execFile } from "node:child_process";
import { execOptionsFor, resultFromExec } from "../../src/host/runner.js";
import type { HostRunResult, HostRunner } from "../../src/host/runner.js";

/**
 * Test only (it lives outside src and never ships): runs harmless system binaries with the very options
 * and result mapping of the production runner, so timeouts, output limits and the environment are tested
 * without osascript or open.
 */
export function createUncheckedRunner(allowed: readonly string[]): HostRunner {
  return (binary, args, options) => {
    if (!allowed.includes(binary)) return Promise.resolve<HostRunResult>({ code: null, stdout: "", stderr: "", timedOut: false, truncated: false, failure: "binary_not_allowed" });
    return new Promise<HostRunResult>((resolve) => {
      const child = execFile(binary, [...args], execOptionsFor(options), (error, stdout, stderr) => { resolve(resultFromExec(error, stdout, stderr)); });
      child.stdin?.end();
    });
  };
}
