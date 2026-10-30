import { test } from "node:test";
import assert from "node:assert/strict";
import { ALLOWED_BINARIES, OPEN_BINARY, OSASCRIPT_BINARY, contractAllows, createExecRunner, execOptionsFor } from "../src/host/runner.js";
import { createUncheckedRunner } from "./helpers/unchecked-runner.js";
import { MENU_SCRIPT, RUNNING_SCRIPT, SAVE_AS_SCRIPT } from "../src/host/scripts.js";
import type { HostRunOptions } from "../src/host/runner.js";

/** The real runner. It is exercised with harmless system binaries only; osascript and open are never started by a test. */

const OPTIONS: HostRunOptions = { timeoutMs: 5000, maxBytes: 64 * 1024, env: { PATH: "/usr/bin:/bin" } };

test("the allowlist is exactly open and osascript, as absolute paths", () => {
  assert.equal(OPEN_BINARY, "/usr/bin/open");
  assert.equal(OSASCRIPT_BINARY, "/usr/bin/osascript");
  assert.deepEqual([...ALLOWED_BINARIES], ["/usr/bin/open", "/usr/bin/osascript"]);
});

test("any other binary is refused before a process exists", async () => {
  const run = createExecRunner();
  for (const binary of ["/bin/sh", "/usr/bin/true", "open", "osascript", "/usr/bin/../bin/open", "/usr/bin/open ", ""]) {
    const result = await run(binary, ["-c", "echo hi"], OPTIONS);
    assert.equal(result.failure, "binary_not_allowed", binary);
    assert.equal(result.code, null);
    assert.equal(result.stdout, "");
  }
});

test("arguments are passed as an argv array, never through a shell", async () => {
  const run = createUncheckedRunner(["/bin/echo"]);
  const result = await run("/bin/echo", ["; echo injected", "$(whoami)", "`id`", "a b"], OPTIONS);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "; echo injected $(whoami) `id` a b\n");
});

test("the child gets exactly the given environment and nothing from this process", async () => {
  process.env["BM_HOST_SECRET"] = "leak";
  try {
    const run = createUncheckedRunner(["/usr/bin/env"]);
    const result = await run("/usr/bin/env", [], { ...OPTIONS, env: { PATH: "/usr/bin:/bin", ONLY: "1" } });
    assert.equal(result.code, 0);
    assert.ok(!result.stdout.includes("BM_HOST_SECRET") && !result.stdout.includes("leak"));
    assert.ok(result.stdout.includes("ONLY=1") && result.stdout.includes("PATH=/usr/bin:/bin"));
  } finally {
    delete process.env["BM_HOST_SECRET"];
  }
});

test("a call that outlives its timeout is killed and reported", async () => {
  const run = createUncheckedRunner(["/bin/sleep"]);
  const started = Date.now();
  const result = await run("/bin/sleep", ["5"], { ...OPTIONS, timeoutMs: 150 });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 3000);
});

test("output above the size limit kills the process and is flagged", async () => {
  const run = createUncheckedRunner(["/usr/bin/yes"]);
  const result = await run("/usr/bin/yes", [], { ...OPTIONS, maxBytes: 1024 });
  assert.equal(result.truncated, true);
  assert.ok(result.stdout.length <= 1024 + 64 * 1024);
});

test("a non-zero exit code and stderr are returned as data", async () => {
  const run = createUncheckedRunner(["/bin/ls"]);
  const result = await run("/bin/ls", ["/definitely/not/here"], OPTIONS);
  assert.notEqual(result.code, 0);
  assert.notEqual(result.code, null);
  assert.ok(result.stderr.length > 0);
});

test("a missing allowed binary is a spawn failure, not a crash", async () => {
  const run = createUncheckedRunner(["/nonexistent/tool"]);
  const result = await run("/nonexistent/tool", [], OPTIONS);
  assert.equal(result.failure, "spawn_failed");
  assert.equal(result.code, null);
});

test("the production runner enforces the contract itself: osascript runs only -e plus one of the constant scripts, open only -a plus absolute paths", async () => {
  const run = createExecRunner();
  const refused: Array<[string, string[]]> = [
    [OSASCRIPT_BINARY, ["-e", 'do shell script "id"']],
    [OSASCRIPT_BINARY, ["-e", `${MENU_SCRIPT} `]],
    [OSASCRIPT_BINARY, ["-e", `${MENU_SCRIPT}\n`]],
    [OSASCRIPT_BINARY, ["-e", MENU_SCRIPT.replace("com.ableton.live", "com.example")]],
    [OSASCRIPT_BINARY, ["-e", `${MENU_SCRIPT}\ndo shell script "id"`, "new"]],
    [OSASCRIPT_BINARY, [MENU_SCRIPT, "new"]],
    [OSASCRIPT_BINARY, ["-l", "JavaScript", "-e", MENU_SCRIPT, "new"]],
    [OSASCRIPT_BINARY, ["-e", "-e", MENU_SCRIPT]],
    [OSASCRIPT_BINARY, ["-l", MENU_SCRIPT, "new"]],
    [OSASCRIPT_BINARY, ["-s", "h", MENU_SCRIPT]],
    [OSASCRIPT_BINARY, ["-i", RUNNING_SCRIPT]],
    [OSASCRIPT_BINARY, ["x", MENU_SCRIPT, "new"]],
    [OSASCRIPT_BINARY, ["-e"]],
    [OSASCRIPT_BINARY, []],
    [OSASCRIPT_BINARY, ["-e", MENU_SCRIPT, "-s", "h"]],
    [OSASCRIPT_BINARY, ["-e", MENU_SCRIPT, ""]],
    [OSASCRIPT_BINARY, ["-e", MENU_SCRIPT, "a\u0000b"]],
    [OSASCRIPT_BINARY, ["-e", MENU_SCRIPT, "-e"]],
    [OPEN_BINARY, []],
    [OPEN_BINARY, ["-a"]],
    [OPEN_BINARY, ["/Applications/x.app"]],
    [OPEN_BINARY, ["-n", "/Applications/x.app"]],
    [OPEN_BINARY, ["-a", "Calculator"]],
    [OPEN_BINARY, ["-a", "/Applications/x.app", "relative.als"]],
    [OPEN_BINARY, ["-a", "/Applications/x.app", "-W"]],
    [OPEN_BINARY, ["-a", "/Applications/x.app", "http://example.com"]],
    [OPEN_BINARY, ["-a", "/Applications/x.app", "/a\u0000b"]],
    [OPEN_BINARY, ["-a", "/Applications/x.app", ""]],
    [OPEN_BINARY, ["-a", "-a", "/x"]],
    // open: the application must be one of the six Live bundles in /Applications, the optional document must be a .als
    [OPEN_BINARY, ["-a", "/System/Applications/Utilities/Terminal.app"]],
    [OPEN_BINARY, ["-a", "/System/Applications/Utilities/Terminal.app", "/tmp/evil.command"]],
    [OPEN_BINARY, ["-a", "/Applications/Utilities/Terminal.app", "/Users/x/a.als"]],
    [OPEN_BINARY, ["-a", "/Applications/Ableton Live 12 Suite.app", "/tmp/evil.command"]],
    [OPEN_BINARY, ["-a", "/Applications/Ableton Live 12 Suite.app", "/Users/x/a.als.command"]],
    [OPEN_BINARY, ["-a", "/Applications/Ableton Live 12 Suite.app", "/Users/x/a.alsx"]],
    [OPEN_BINARY, ["-a", "/Applications/Ableton Live 12 Suite.app", "/Users/x/a.als", "/Users/x/b.als"]],
    [OPEN_BINARY, ["-a", "/Applications/Ableton Live 12 Suite.app", "relative.als"]],
    [OPEN_BINARY, ["-a", "/Applications/Ableton Live 12 Suite.app/"]],
    [OPEN_BINARY, ["-a", "/Applications/Ableton Live 12 Suite.app/Contents/MacOS/Live"]],
    [OPEN_BINARY, ["-a", "/Applications/Ableton Live 12 Other.app"]],
    [OPEN_BINARY, ["-a", "/Applications/Ableton Live 11 Suite.app"]],
    [OPEN_BINARY, ["-a", "/Applications/ableton live 12 suite.app"]],
    [OPEN_BINARY, ["-a", "/Applications/Ableton Live 12 Suite.app\n"]],
    [OPEN_BINARY, ["-a", "/Users/x/Applications/Ableton Live 12 Suite.app"]],
    [OPEN_BINARY, ["-a", "/Applications/../tmp/Ableton Live 12 Suite.app"]],
    // osascript: menu ids, Save As arguments and the running check are pinned too
    [OSASCRIPT_BINARY, ["-e", MENU_SCRIPT, "saveas"]],
    [OSASCRIPT_BINARY, ["-e", MENU_SCRIPT, "foo"]],
    [OSASCRIPT_BINARY, ["-e", MENU_SCRIPT]],
    [OSASCRIPT_BINARY, ["-e", MENU_SCRIPT, "new", "save"]],
    [OSASCRIPT_BINARY, ["-e", MENU_SCRIPT, "/Users/x/a.als"]],
    [OSASCRIPT_BINARY, ["-e", SAVE_AS_SCRIPT, "/Users/x/a.txt", "0"]],
    [OSASCRIPT_BINARY, ["-e", SAVE_AS_SCRIPT, "/Users/x/a.als", "2"]],
    [OSASCRIPT_BINARY, ["-e", SAVE_AS_SCRIPT, "/Users/x/a.als"]],
    [OSASCRIPT_BINARY, ["-e", SAVE_AS_SCRIPT, "/Users/x/a.als", "1", "x"]],
    [OSASCRIPT_BINARY, ["-e", SAVE_AS_SCRIPT, "a.als", "1"]],
    [OSASCRIPT_BINARY, ["-e", SAVE_AS_SCRIPT, "1", "/Users/x/a.als"]],
    [OSASCRIPT_BINARY, ["-e", RUNNING_SCRIPT, "/Applications/Utilities/Terminal.app"]],
    [OSASCRIPT_BINARY, ["-e", RUNNING_SCRIPT, "/Applications/Ableton Live 12 Suite.app", "x"]],
    [OSASCRIPT_BINARY, ["-e", RUNNING_SCRIPT, "/Users/x/Ableton Live 12 Suite.app"]],
  ];
  for (const [binary, args] of refused) {
    assert.equal(contractAllows(binary, args), false, JSON.stringify([binary, args]).slice(0, 120));
    const result = await run(binary, args, OPTIONS);
    assert.equal(result.failure, "binary_not_allowed", JSON.stringify([binary, args]).slice(0, 120));
    assert.equal(result.code, null);
  }
  const allowed: Array<[string, string[]]> = [
    [OSASCRIPT_BINARY, ["-e", RUNNING_SCRIPT]],
    [OSASCRIPT_BINARY, ["-e", RUNNING_SCRIPT, "/Applications/Ableton Live 12 Suite.app", "/Applications/Ableton Live 12 Lite.app"]],
    [OSASCRIPT_BINARY, ["-e", MENU_SCRIPT, "new"]],
    [OSASCRIPT_BINARY, ["-e", SAVE_AS_SCRIPT, "/Users/x/Music/Ableton/a b.als", "1"]],
    [OPEN_BINARY, ["-a", "/Applications/Ableton Live 12 Suite.app"]],
    [OPEN_BINARY, ["-a", "/Applications/Ableton Live 12 Suite.app", "/Users/x/Music/Ableton/a.als"]],
    [OPEN_BINARY, ["-a", "/Applications/Ableton Live 12 Beta.app", "/Users/x/Music/Ableton/A B.ALS"]],
    [OSASCRIPT_BINARY, ["-e", MENU_SCRIPT, "save"]],
    [OSASCRIPT_BINARY, ["-e", MENU_SCRIPT, "export"]],
    [OSASCRIPT_BINARY, ["-e", SAVE_AS_SCRIPT, "/Users/x/Music/Ableton/a.als", "0"]],
  ];
  for (const [binary, args] of allowed) assert.equal(contractAllows(binary, args), true, JSON.stringify([binary, args]).slice(0, 120));
});

test("the execFile options are built in one place: timeout, buffer limit, a copy of the given env, utf8, never a shell", () => {
  const env = { PATH: "/usr/bin:/bin", HOME: "/h" };
  const options = execOptionsFor({ timeoutMs: 1234, maxBytes: 4321, env });
  assert.deepEqual(options, { timeout: 1234, maxBuffer: 4321, env, encoding: "utf8", windowsHide: true, killSignal: "SIGKILL" });
  assert.notEqual(options.env, env, "the child gets a copy");
  assert.equal("shell" in options, false);
});
