import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger, parseLogLevel } from "../src/log.js";

test("logger writes through its sink and redacts registered secrets", () => {
  const lines: string[] = [];
  const log = createLogger({ sink: (l) => lines.push(l), secrets: ["abc123secret"] });
  log.info("token is abc123secret ok");
  log.addSecret("another-secret");
  log.error("bad another-secret and abc123secret");
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => !l.includes("abc123secret") && !l.includes("another-secret")));
  assert.match(lines[0]!, /<redacted>/);
  assert.match(lines[0]!, /info/);
});

test("logger honours the level threshold", () => {
  const lines: string[] = [];
  const log = createLogger({ sink: (l) => lines.push(l), level: "warn" });
  log.debug("d");
  log.info("i");
  log.warn("w");
  log.error("e");
  assert.equal(lines.length, 2);
});

test("logger strips control characters so log lines cannot be forged", () => {
  const lines: string[] = [];
  const log = createLogger({ sink: (l) => lines.push(l) });
  log.info("a\nfake line\u0000b");
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0]!, /\n.|\u0000/);
});

test("parseLogLevel accepts the four levels, defaults to info, and rejects anything else", () => {
  assert.equal(parseLogLevel(undefined), "info");
  for (const level of ["debug", "info", "warn", "error"] as const) assert.equal(parseLogLevel(level), level);
  for (const bad of ["", "loud", "INFO", "warning", "3"]) assert.throws(() => parseLogLevel(bad), /BATUTA_LOG_LEVEL/, bad);
});
