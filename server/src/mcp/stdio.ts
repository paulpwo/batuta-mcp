import type { Readable, Writable } from "node:stream";

/**
 * The only place that touches the process's standard streams. stdout carries MCP JSON-RPC and
 * nothing else; diagnostics go through the logger to stderr.
 */
export function stdioStreams(): { input: Readable; output: Writable } {
  return { input: process.stdin, output: process.stdout };
}
