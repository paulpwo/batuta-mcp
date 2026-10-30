import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { HostService, classifyFailure } from "../src/host/host.js";
import type { HostConfig } from "../src/host/host.js";
import { ToolError } from "../src/mcp/index.js";
import { MENU_SCRIPT, RUNNING_SCRIPT, SAVE_AS_SCRIPT, SCRIPTS, buildOsascriptArgs } from "../src/host/scripts.js";
import { FakeRunner } from "./helpers/fake-host.js";
import { makeApp } from "./helpers/fake-apps.js";
import type { HostCall } from "./helpers/fake-host.js";

/** The host module against a fake runner and a fake /Applications: exact argv, constant scripts, app choice, error mapping. */

const UID = process.getuid?.() ?? 0;

interface World { base: string; apps: string; root: string; set: string; app(variant: string): string; cleanup(): void }

function world(variants: string[] = ["Lite", "Suite"]): World {
  const base = fs.realpathSync(fs.mkdtempSync("/tmp/bm-host-"));
  const apps = path.join(base, "Applications");
  const root = path.join(base, "Music", "Ableton");
  fs.mkdirSync(apps);
  fs.mkdirSync(root, { recursive: true });
  for (const v of variants) makeApp(apps, `Ableton Live 12 ${v}.app`);
  const set = path.join(root, "my song's; $(x) `y` \"z\".als");
  fs.writeFileSync(set, "x");
  return { base, apps, root, set, app: (v) => path.join(apps, `Ableton Live 12 ${v}.app`), cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

function service(w: World, runner: FakeRunner, config: Partial<HostConfig> = {}, extra: { platform?: string } = {}): HostService {
  return new HostService({ runner: runner.run, config: { enabled: true, liveApp: "auto", setRoots: [w.root], ...config }, applicationsDir: w.apps, home: w.base, uid: UID, ...extra });
}

async function failure(promise: Promise<unknown>): Promise<ToolError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ToolError, `expected a ToolError, got ${String(error)}`);
    return error;
  }
  throw new assert.AssertionError({ message: "expected the call to reject" });
}

const FORBIDDEN_IN_SCRIPT = ["${", "`", "child_process", "do shell script", "run script", "keystroke", "key code", "Terminal", "sudo"];
/** T9n: Save As is the one script allowed two guarded key events (Go to folder and Return); test/host-save-as.test.ts pins where they may appear. */
const KEY_EVENTS = ["keystroke", "key code"];

test("the AppleScript sources are constants: no interpolation, no shell, no keystrokes, and they read only argv", () => {
  assert.deepEqual([...SCRIPTS], [RUNNING_SCRIPT, MENU_SCRIPT, SAVE_AS_SCRIPT]);
  for (const script of SCRIPTS) {
    for (const bad of FORBIDDEN_IN_SCRIPT) assert.ok(script === SAVE_AS_SCRIPT && KEY_EVENTS.includes(bad) ? true : !script.includes(bad), `script contains ${bad}`);
    assert.match(script, /on run argv/);
    assert.ok(/^[\x20-\x7e\n]*$/.test(script), "ASCII only: no encoding surprises through -e");
    assert.ok(Object.isFrozen(SCRIPTS));
  }
  assert.ok(MENU_SCRIPT.includes("com.ableton.live") && SAVE_AS_SCRIPT.includes("com.ableton.live"));
  assert.ok(RUNNING_SCRIPT.includes("is running") && !RUNNING_SCRIPT.includes("System Events") && !RUNNING_SCRIPT.includes("launch"));
});

test("an osascript argv is -e, the constant script, then the variables; a variable that looks like an option is refused", () => {
  assert.deepEqual(buildOsascriptArgs(MENU_SCRIPT, ["new"]), ["-e", MENU_SCRIPT, "new"]);
  assert.deepEqual(buildOsascriptArgs(RUNNING_SCRIPT, []), ["-e", RUNNING_SCRIPT]);
  for (const bad of ["-e", "--", "-l", "-s", ""]) assert.throws(() => buildOsascriptArgs(MENU_SCRIPT, [bad]), /argument/);
  assert.throws(() => buildOsascriptArgs(MENU_SCRIPT, ["a\u0000b"]), /argument/);
});

test("launch_live: asks which app is running, then open -a with the chosen bundle; every call has limits and a minimal environment", async () => {
  const w = world();
  try {
    const runner = new FakeRunner();
    const host = service(w, runner);
    const out = await host.launch(undefined);
    assert.deepEqual(out, { action: "launched", app: { name: "Ableton Live 12 Suite", variant: "suite", path: w.app("Suite") }, was_running: false, chosen_by: "default" });
    assert.equal(runner.calls.length, 2);
    assert.deepEqual(runner.calls[0]?.args, ["-e", RUNNING_SCRIPT, w.app("Suite"), w.app("Lite")]);
    assert.equal(runner.calls[0]?.binary, "/usr/bin/osascript");
    assert.deepEqual(runner.calls[1], { binary: "/usr/bin/open", args: ["-a", w.app("Suite")], options: runner.calls[1]!.options });
    for (const call of runner.calls) {
      assert.ok(call.options.timeoutMs > 0 && call.options.timeoutMs <= 60_000);
      assert.equal(call.options.maxBytes, 64 * 1024);
      assert.deepEqual(Object.keys(call.options.env).sort(), ["HOME", "LANG", "PATH"]);
      assert.equal(call.options.env["PATH"], "/usr/bin:/bin");
      assert.equal(call.options.env["HOME"], w.base);
    }
  } finally {
    w.cleanup();
  }
});

test("app choice: the running app wins, then Suite > Standard > Lite; an explicit app or setting never starts a second Live", async () => {
  const w = world(["Lite", "Standard", "Suite"]);
  try {
    const pick = async (running: string[], config: Partial<HostConfig>, app?: Parameters<HostService["launch"]>[0]) => {
      const runner = new FakeRunner();
      runner.running = running;
      return { runner, result: await service(w, runner, config).launch(app) };
    };
    assert.equal((await pick([], {})).result.app.variant, "suite");
    const lite = await pick([w.app("Lite")], {});
    assert.equal(lite.result.app.variant, "lite");
    assert.equal(lite.result.action, "activated");
    assert.equal(lite.result.was_running, true);
    assert.deepEqual(lite.runner.actions()[0]?.args, ["-a", w.app("Lite")], "activating is open -a on the same bundle");
    assert.equal((await pick([], { liveApp: "standard" })).result.app.variant, "standard");
    assert.equal((await pick([], {}, "lite")).result.app.variant, "lite");
    assert.equal((await pick([w.app("Suite")], { liveApp: "suite" }, "suite")).result.action, "activated");
    // a different variant than the running one
    for (const [config, app] of [[{ liveApp: "lite" }, undefined], [{}, "lite"]] as const) {
      const runner = new FakeRunner();
      runner.running = [w.app("Suite")];
      const error = await failure(service(w, runner, config).launch(app));
      assert.equal(error.code, "not_supported");
      assert.equal(error.details?.["reason"], "different_live_running");
      assert.equal(runner.actions().length, 0, "nothing was opened");
    }
    // two running
    const runner = new FakeRunner();
    runner.running = [w.app("Suite"), w.app("Lite")];
    const two = await failure(service(w, runner).launch(undefined));
    assert.equal(two.details?.["reason"], "multiple_live_running");
    assert.equal(runner.actions().length, 0);
  } finally {
    w.cleanup();
  }
});

test("a bundle that is not Live (wrong identifier, binary plist) is not found, and the error says it was unverified", async () => {
  const w = world([]);
  try {
    makeApp(w.apps, "Ableton Live 12 Suite.app", "com.example.other");
    const error = await failure(service(w, new FakeRunner()).launch(undefined));
    assert.equal(error.code, "not_found");
    assert.equal(error.details?.["what"], "live_app");
    assert.equal(error.details?.["reason"], "unverified_bundle");
    assert.deepEqual(error.details?.["bundles"], ["Ableton Live 12 Suite"]);
    assert.match(error.message, /Info\.plist/);
    const none = world([]);
    try {
      assert.equal((await failure(service(none, new FakeRunner()).launch(undefined))).details?.["reason"], undefined);
    } finally {
      none.cleanup();
    }
  } finally {
    w.cleanup();
  }
});

test("app choice among the rarer variants and when nothing is installed", async () => {
  const w = world(["Beta", "Intro"]);
  try {
    const runner = new FakeRunner();
    assert.equal((await service(w, runner).launch(undefined)).app.variant, "intro");
    const missing = await failure(service(w, new FakeRunner()).launch("suite"));
    assert.equal(missing.code, "not_found");
    assert.equal(missing.details?.["what"], "live_app");
    const none = world([]);
    try {
      const error = await failure(service(none, new FakeRunner()).launch(undefined));
      assert.equal(error.code, "not_found");
      assert.equal(error.details?.["what"], "live_app");
    } finally {
      none.cleanup();
    }
  } finally {
    w.cleanup();
  }
});

test("open_set: the set path is one argv element after the app; it never appears in a script", async () => {
  const w = world();
  try {
    const runner = new FakeRunner();
    runner.running = [w.app("Lite")];
    const host = service(w, runner);
    const out = await host.openSet(w.set);
    assert.deepEqual(out.app, { name: "Ableton Live 12 Lite", variant: "lite", path: w.app("Lite") });
    assert.equal(out.path, w.set);
    assert.equal(out.action, "open_requested");
    assert.match(String(out.note), /unsaved changes/);
    const open = runner.actions();
    assert.equal(open.length, 1);
    assert.deepEqual(open[0]?.args, ["-a", w.app("Lite"), w.set]);
    for (const call of runner.calls) {
      if (call.binary === "/usr/bin/osascript") assert.ok(!(call.args[1] ?? "").includes(w.set));
    }
    // a bad path never reaches the runner
    const bad = new FakeRunner();
    const error = await failure(service(w, bad).openSet(`${w.root}/../x.als`));
    assert.equal(error.details?.["reason"], "not_normalized");
    assert.equal(bad.calls.length, 0);
  } finally {
    w.cleanup();
  }
});

test("menu actions: only an action id travels; Live must be running; save reports Live's own dialog", async () => {
  const w = world();
  try {
    for (const [action, expected] of [["new", "new_set_requested"], ["export", "export_dialog_requested"]] as const) {
      const runner = new FakeRunner();
      runner.running = [w.app("Suite")];
      const out = await service(w, runner).menu(action);
      assert.equal(out.action, expected);
      assert.deepEqual(out.app, { name: "Ableton Live 12 Suite", variant: "suite", path: w.app("Suite") });
      assert.deepEqual(runner.actions().map((c) => [c.binary, c.args]), [["/usr/bin/osascript", ["-e", MENU_SCRIPT, action]]]);
    }
    const runner = new FakeRunner();
    runner.running = [w.app("Suite")];
    assert.equal((await service(w, runner).menu("save")).result, "saved");
    runner.answer = (call) => (call.args[1] === MENU_SCRIPT ? { stdout: "dialog_open\n" } : undefined);
    const dialog = await service(w, runner).menu("save");
    assert.equal(dialog.result, "save_dialog_open");
    assert.match(String(dialog.note), /Save dialog/);
    // not running: no UI script is started
    const closed = new FakeRunner();
    const error = await failure(service(w, closed).menu("new"));
    assert.equal(error.code, "not_supported");
    assert.equal(error.details?.["reason"], "live_not_running");
    assert.match(error.message, /launch_live/);
    assert.equal(closed.actions().length, 0);
  } finally {
    w.cleanup();
  }
});

test("save_set_as: path and the replace flag are the only variables; the flag is 1 only for a confirmed existing target", async () => {
  const w = world();
  try {
    const fresh = path.join(w.root, "fresh.als");
    for (const [target, exists] of [[w.set, true], [fresh, false]] as const) {
      const runner = new FakeRunner();
      runner.running = [w.app("Suite")];
      const out = await service(w, runner).saveSetAs(target, exists);
      assert.deepEqual(out, { action: "save_as_requested", app: { name: "Ableton Live 12 Suite", variant: "suite", path: w.app("Suite") }, path: target, replaced: exists, result: "saved" });
      assert.deepEqual(runner.actions().map((c) => c.args), [["-e", SAVE_AS_SCRIPT, target, exists ? "1" : "0"]]);
      assert.ok(!SAVE_AS_SCRIPT.includes(target));
    }
    // the file appeared or vanished after planning
    for (const [target, expectExists] of [[w.set, false], [path.join(w.root, "ghost.als"), true]] as const) {
      const runner = new FakeRunner();
      runner.running = [w.app("Suite")];
      const error = await failure(service(w, runner).saveSetAs(target, expectExists));
      assert.equal(error.code, "invalid_args");
      assert.equal(error.details?.["reason"], "target_changed");
      assert.equal(runner.actions().length, 0);
    }
  } finally {
    w.cleanup();
  }
});

test("failure mapping: timeouts, limits, exit codes, permissions and UI errors become the documented codes", async () => {
  const w = world();
  try {
    const run = async (reply: Partial<Parameters<typeof classifyFailure>[0]>, call: () => (host: HostService) => Promise<unknown>): Promise<ToolError> => {
      const runner = new FakeRunner();
      runner.running = [w.app("Suite")];
      runner.answer = (c: HostCall) => (c.args[1] === MENU_SCRIPT || c.binary === "/usr/bin/open" ? reply : undefined);
      return failure(call()(service(w, runner)));
    };
    const menu = () => (h: HostService) => h.menu("new");
    const table: Array<[Partial<Parameters<typeof classifyFailure>[0]>, string, string | undefined]> = [
      [{ timedOut: true, code: null }, "timeout", undefined],
      [{ truncated: true, code: null }, "host_failed", "output_too_large"],
      [{ failure: "spawn_failed", code: null }, "host_failed", "spawn_failed"],
      [{ failure: "binary_not_allowed", code: null }, "host_failed", "spawn_failed"],
      [{ code: 1, stderr: "execution error: menu_item_not_found (1005)" }, "host_failed", "menu_item_not_found"],
      [{ code: 1, stderr: "execution error: menu_not_found (1004)" }, "host_failed", "menu_item_not_found"],
      [{ code: 1, stderr: "execution error: dialog_not_found (1007)" }, "host_failed", "ui_element_not_found"],
      [{ code: 1, stderr: "execution error: dialog_field_not_found (1008)" }, "host_failed", "ui_element_not_found"],
      [{ code: 1, stderr: "execution error: dialog_button_not_found (1009)" }, "host_failed", "ui_element_not_found"],
      [{ code: 1, stderr: "execution error: target_exists (1010)" }, "host_failed", "target_exists"],
      [{ code: 1, stderr: "execution error: path_not_applied (1012)" }, "host_failed", "path_not_applied"],
      [{ code: 1, stderr: "execution error: replace_mismatch (1013)" }, "host_failed", "replace_unverified"],
      [{ code: 1, stderr: "execution error: save_timeout (1011)" }, "timeout", undefined],
      [{ code: 1, stderr: "execution error: menu_item_disabled (1006)" }, "not_supported", "menu_item_disabled"],
      [{ code: 1, stderr: "execution error: live_not_running (1002)" }, "not_supported", "live_not_running"],
      [{ code: 1, stderr: "execution error: multiple_live_processes (1003)" }, "not_supported", "multiple_live_running"],
      [{ code: 1, stderr: "execution error: something odd (-1728)" }, "host_failed", "script_error"],
      [{ code: 1, stderr: "" }, "host_failed", "script_error"],
    ];
    for (const [reply, code, reason] of table) {
      const error = await run(reply, menu);
      assert.equal(error.code, code, JSON.stringify(reply));
      if (reason !== undefined) assert.equal(error.details?.["reason"], reason, JSON.stringify(reply));
      if (code === "timeout") assert.equal(error.details?.["stage"], "host");
    }
    const open = await run({ code: 1, stderr: "Unable to find application named 'x'" }, () => (h) => h.launch(undefined));
    assert.equal(open.code, "host_failed");
    assert.equal(open.details?.["reason"], "open_failed");
    // stderr is shown cut and control-stripped
    const noisy = await run({ code: 1, stderr: `boom\u0007${"x".repeat(900)}` }, menu);
    const detail = String(noisy.details?.["detail"]);
    assert.ok(detail.length <= 203 && !detail.includes("\u0007"));
    assert.equal(detail, `boom ${"x".repeat(195)}...`);
    const mixed = await run({ code: 1, stderr: "first line\nsome\u001b[31m red\u202e text\u200b here\u0000 end\n\n" }, menu);
    assert.equal(mixed.details?.["detail"], "some [31m red  text  here  end");
  } finally {
    w.cleanup();
  }
});

test("macOS permission errors become permission_required with instructions, and the status remembers them", async () => {
  const w = world();
  try {
    const stderrs: Array<[string, string]> = [
      ["execution error: System Events got an error: osascript is not allowed assistive access. (-25211)", "accessibility"],
      ["execution error: osascript no tiene permitido el acceso de accesibilidad. (-25211)", "accessibility"],
      ["execution error: System Events got an error: osascript is not allowed assistive access. (-1719)", "accessibility"],
      ["Error de ejecuci\u00f3n: acceso denegado (-1719)", "accessibility"],
      ["Error: no autorizado para enviar eventos de Apple a System Events. (-1743)", "automation"],
      ["Application isn’t running. (-25211)", "accessibility"],
      ["execution error: Not authorized to send Apple events to System Events. (-1743)", "automation"],
    ];
    for (const [stderr, permission] of stderrs) {
      const runner = new FakeRunner();
      runner.running = [w.app("Suite")];
      runner.answer = (c) => (c.args[1] === MENU_SCRIPT ? { code: 1, stderr } : undefined);
      const host = service(w, runner);
      assert.equal(host.status()["accessibility"], "unknown");
      const error = await failure(host.menu("export"));
      assert.equal(error.code, "permission_required", stderr);
      assert.equal(error.details?.["permission"], permission);
      assert.match(String(error.details?.["instructions"]), /System Settings > Privacy & Security > (Accessibility|Automation)/);
      assert.match(error.message, /System Settings > Privacy & Security/);
      assert.equal(host.status()["accessibility"], permission === "accessibility" ? "denied" : "unknown");
    }
    // English wording without one of the three error numbers is not a permission diagnosis: detection is by number, never by text
    const runner = new FakeRunner();
    runner.running = [w.app("Suite")];
    runner.answer = (c) => (c.args[1] === MENU_SCRIPT ? { code: 1, stderr: "execution error: osascript is not allowed assistive access. Not authorized to send Apple events (-1728)" } : undefined);
    assert.equal((await failure(service(w, runner).menu("new"))).code, "host_failed");
    // success after denial is recorded as granted
    const ok = new FakeRunner();
    ok.running = [w.app("Suite")];
    const host = service(w, ok);
    await host.menu("new");
    assert.equal(host.status()["accessibility"], "granted");
  } finally {
    w.cleanup();
  }
});

test("classifyFailure on its own: the permission patterns are exact", () => {
  const base = { code: 1, stdout: "", stderr: "", timedOut: false, truncated: false } as const;
  const kind = (stderr: string) => classifyFailure({ ...base, stderr }, "ui").code;
  assert.equal(kind("is not allowed assistive access"), "host_failed");
  assert.equal(kind("not authorized to send Apple events"), "host_failed");
  assert.equal(kind("x (-25211)"), "permission_required");
  assert.equal(kind("(-1743)"), "permission_required");
  assert.equal(kind("Invalid index. (-1719)"), "permission_required");
  assert.equal(kind("not allowed (-1719)"), "permission_required");
  assert.equal(kind("see /tmp/x-25211/y and 1719"), "host_failed");
  assert.equal(kind("code (-17190)"), "host_failed");
  assert.equal(kind("code (-1728)"), "host_failed");
});

test("status is cached state plus the app listing: it never runs a process", async () => {
  const w = world();
  try {
    const runner = new FakeRunner();
    const host = service(w, runner);
    const before = host.status();
    assert.deepEqual(before, {
      enabled: true, live_app: "auto", apps: [{ variant: "suite", name: "Ableton Live 12 Suite", path: w.app("Suite") }, { variant: "lite", name: "Ableton Live 12 Lite", path: w.app("Lite") }],
      selected: "Ableton Live 12 Suite", last_used: null, running: null, accessibility: "unknown", set_roots_count: 1,
    });
    assert.equal(runner.calls.length, 0);
    runner.running = [w.app("Lite")];
    await host.launch(undefined);
    assert.deepEqual(host.status()["running"], ["Ableton Live 12 Lite"]);
    assert.equal(host.status()["selected"], "Ableton Live 12 Lite");
  } finally {
    w.cleanup();
  }
});

test("disabled by configuration or by platform: no tools, no processes", async () => {
  const w = world();
  try {
    assert.equal(service(w, new FakeRunner(), { enabled: false }).enabled, false);
    assert.equal(service(w, new FakeRunner(), {}, { platform: "linux" }).enabled, false);
    assert.equal(service(w, new FakeRunner(), {}, { platform: "darwin" }).enabled, true);
    const runner = new FakeRunner();
    const off = service(w, runner, { enabled: false });
    assert.deepEqual(off.status(), { enabled: false });
    const error = await failure(off.launch(undefined));
    assert.equal(error.code, "not_supported");
    assert.equal(error.details?.["reason"], "host_disabled");
    assert.equal(runner.calls.length, 0);
  } finally {
    w.cleanup();
  }
});

test("empty set_roots means no folder restriction: a set outside the old default folders is accepted, a configured root narrows", () => {
  const w = world();
  try {
    const runner = new FakeRunner();
    const host = new HostService({ runner: runner.run, config: { enabled: true, liveApp: "auto", setRoots: [] }, applicationsDir: w.apps, home: w.base, uid: UID });
    assert.deepEqual(host.roots(), []);
    assert.equal(host.checkPath(w.set, "open").exists, true);
    const desktop = path.join(w.base, "Desktop", "ABLETON");
    fs.mkdirSync(desktop, { recursive: true });
    const salsa = path.join(desktop, "salsa.als");
    fs.writeFileSync(salsa, "x");
    assert.equal(host.checkPath(salsa, "open").exists, true);
    assert.equal(host.checkPath(path.join(desktop, "new.als"), "save").exists, false);
    assert.equal(host.status()["set_roots_count"], 0);
    const narrowed = new HostService({ runner: runner.run, config: { enabled: true, liveApp: "auto", setRoots: [w.root] }, applicationsDir: w.apps, home: w.base, uid: UID });
    assert.throws(() => narrowed.checkPath(salsa, "open"), (error: unknown) => (error as { details?: { reason?: string } }).details?.reason === "outside_roots");
  } finally {
    w.cleanup();
  }
});

// ------------------------------------------------------------------ review round: replace branch, landing check, real path, lock

const between = (text: string, from: string, to: string): string => {
  const start = text.indexOf(from);
  assert.ok(start >= 0, `missing: ${from}`);
  const end = text.indexOf(to, start + from.length);
  assert.ok(end > start, `missing: ${to}`);
  return text.slice(start, end);
};

test("Save As script: Replace/Reemplazar exist only inside the allowReplace branch behind a name check; the other branch lists exactly Cancel/Cancelar", () => {
  const count = (needle: string): number => SAVE_AS_SCRIPT.split(needle).length - 1;
  assert.equal(count('"Replace"'), 1);
  assert.equal(count('"Reemplazar"'), 1);
  const handler = between(SAVE_AS_SCRIPT, "on handleReplaceSheet", "end handleReplaceSheet").replace(/\s+/g, " ");
  const allow = between(handler, "if allowReplace then", ' else set wantedButtons to {"Cancel", "Cancelar"} end if set wantedButton to my findButton(');
  assert.ok(allow.includes('{"Replace", "Reemplazar"}'));
  const nameCheck = allow.indexOf("if nameMatches then");
  assert.ok(nameCheck >= 0 && nameCheck < allow.indexOf('{"Replace"'), "the sheet text is checked for the target base name before Replace is chosen");
  const mismatch = between(allow, " else ", " end if");
  assert.ok(mismatch.includes('{"Cancel", "Cancelar"}') && !mismatch.includes("Replace"), "a sheet that does not name the target is cancelled");
  const refuse = handler.slice(handler.lastIndexOf(" else set wantedButtons"));
  assert.ok(refuse.startsWith(' else set wantedButtons to {"Cancel", "Cancelar"} end if set wantedButton to my findButton('), "the refuse branch: exactly Cancel/Cancelar");
  // the base name: computed from the last "/" part, refused when empty, matched inside quotes (ASCII and curly), case-sensitively
  const flat = between(SAVE_AS_SCRIPT, "on run argv", "end run").replace(/\s+/g, " ");
  const delim = flat.indexOf(`set AppleScript's text item delimiters to "/"`);
  assert.ok(delim >= 0);
  assert.ok(flat.indexOf("set baseName to last text item of targetPath") > delim);
  assert.ok(flat.indexOf(`set AppleScript's text item delimiters to ""`) > flat.indexOf("set baseName to last text item of targetPath"));
  assert.ok(flat.indexOf('if baseName is "" then error') > flat.indexOf(`set AppleScript's text item delimiters to ""`) && flat.indexOf('if baseName is "" then error') < flat.indexOf("my clickFileMenuItem(liveProc, my titlesFor("));
  assert.ok(handler.includes("set quotedAscii to quote & baseName & quote"));
  assert.ok(handler.includes("set quotedCurly to (character id 8220) & baseName & (character id 8221)"));
  assert.ok(handler.includes("considering case if sheetText contains quotedAscii or sheetText contains quotedCurly then set nameMatches to true end considering"));
  assert.ok(!handler.includes("contains baseName"), "never a bare substring match: a.als must not match aa.als");
  // the name field only ever holds the base name (T9n), read back and compared before Save is clicked
  const run = between(SAVE_AS_SCRIPT, "on prepareDialog", "end prepareDialog");
  assert.ok(run.includes("set value of nameField to baseName") && !SAVE_AS_SCRIPT.includes("set value of nameField to targetPath"));
  assert.ok(run.indexOf("nameNow is not baseName") > run.indexOf("set nameNow to my textOf(nameField)") && run.indexOf("set nameNow to my textOf(nameField)") > run.indexOf("set value of nameField"), "read back after setting");
  assert.ok(run.includes("path_not_applied"));
  assert.ok(SAVE_AS_SCRIPT.includes("replace_mismatch") && SAVE_AS_SCRIPT.includes("number 1012") && SAVE_AS_SCRIPT.includes("number 1013"));
});

test("Save As: Live gets the real path of the set, and the result is only reported after the file is seen to have landed", async () => {
  const w = world();
  try {
    const link = path.join(w.base, "Music", "alias");
    fs.symlinkSync(w.root, link);
    const runner = new FakeRunner();
    runner.running = [w.app("Suite")];
    const host = new HostService({ runner: runner.run, config: { enabled: true, liveApp: "auto", setRoots: [w.root, link] }, applicationsDir: w.apps, home: w.base, uid: UID });
    await host.openSet(path.join(link, path.basename(w.set)));
    assert.deepEqual(runner.actions()[0]?.args, ["-a", w.app("Suite"), w.set], "open gets the real path");
    const symlinked = await failure(host.saveSetAs(path.join(link, "new.als"), false));
    assert.equal(symlinked.details?.["reason"], "symlinked_parent");
    assert.equal(runner.actions().length, 1);
  } finally {
    w.cleanup();
  }
});

test("Save As that returns ok but leaves no fresh regular file is host_failed save_unverified", async () => {
  const w = world();
  try {
    const old = new Date(Date.now() - 3_600_000);
    fs.utimesSync(w.set, old, old);
    const fresh = path.join(w.root, "never-written.als");
    for (const [target, exists] of [[w.set, true], [fresh, false]] as const) {
      const runner = new FakeRunner();
      runner.running = [w.app("Suite")];
      runner.landSaveAs = false;
      const error = await failure(service(w, runner).saveSetAs(target, exists));
      assert.equal(error.code, "host_failed");
      assert.equal(error.details?.["reason"], "save_unverified");
      assert.equal(runner.actions().length, 1, "the script did run");
    }
    // a symlink put in place of the file, a directory, and a moved parent are not a landed save either
    const runner = new FakeRunner();
    runner.running = [w.app("Suite")];
    runner.landSaveAs = false;
    const target = path.join(w.root, "swapped.als");
    const written = path.join(w.root, "just-written.als");
    runner.answer = (call) => {
      if (call.args[1] === SAVE_AS_SCRIPT) {
        fs.writeFileSync(written, "fresh, written just now");
        fs.symlinkSync(written, target);
      }
      return undefined;
    };
    assert.equal((await failure(service(w, runner).saveSetAs(target, false))).details?.["reason"], "save_unverified");
    // an existing file with a future modification time that Live never touched is not a landed save, nor is a file stamped far in the future
    const future = new Date(Date.now() + 3_600_000);
    fs.utimesSync(w.set, future, future);
    const untouchedFuture = new FakeRunner();
    untouchedFuture.running = [w.app("Suite")];
    untouchedFuture.landSaveAs = false;
    assert.equal((await failure(service(w, untouchedFuture).saveSetAs(w.set, true))).details?.["reason"], "save_unverified");
    const soon = new Date(Date.now() + 2_000);
    fs.utimesSync(w.set, soon, soon);
    const untouchedSoon = new FakeRunner();
    untouchedSoon.running = [w.app("Suite")];
    untouchedSoon.landSaveAs = false;
    assert.equal((await failure(service(w, untouchedSoon).saveSetAs(w.set, true))).details?.["reason"], "save_unverified", "unchanged file: no write happened");
    const stamped = new FakeRunner();
    stamped.running = [w.app("Suite")];
    stamped.landSaveAs = false;
    stamped.answer = (call) => {
      if (call.args[1] === SAVE_AS_SCRIPT) { fs.writeFileSync(w.set, "written"); fs.utimesSync(w.set, future, future); }
      return undefined;
    };
    assert.equal((await failure(service(w, stamped).saveSetAs(w.set, true))).details?.["reason"], "save_unverified", "a timestamp far in the future is not believed");
    // replaced through a new file (new inode, old-looking nothing): accepted
    const replaced = new FakeRunner();
    replaced.running = [w.app("Suite")];
    replaced.landSaveAs = false;
    replaced.answer = (call) => {
      if (call.args[1] === SAVE_AS_SCRIPT) { fs.writeFileSync(`${w.set}.tmp`, "new"); fs.renameSync(`${w.set}.tmp`, w.set); }
      return undefined;
    };
    assert.equal((await service(w, replaced).saveSetAs(w.set, true))["result"], "saved");
    // the folder was swapped for a symlink while Live was saving: the file is found, but not where it was checked
    const proj = path.join(w.root, "proj");
    fs.mkdirSync(proj);
    const inProj = path.join(proj, "x.als");
    const swap = new FakeRunner();
    swap.running = [w.app("Suite")];
    swap.landSaveAs = false;
    swap.answer = (call) => {
      if (call.args[1] === SAVE_AS_SCRIPT) {
        fs.renameSync(proj, `${proj}-moved`);
        fs.symlinkSync(`${proj}-moved`, proj);
        fs.writeFileSync(inProj, "x");
      }
      return undefined;
    };
    assert.equal((await failure(service(w, swap).saveSetAs(inProj, false))).details?.["reason"], "save_unverified");
    // fresh file: verified, and the old file with a fresh mtime too
    const good = new FakeRunner();
    good.running = [w.app("Suite")];
    assert.equal((await service(w, good).saveSetAs(w.set, true))["result"], "saved");
  } finally {
    w.cleanup();
  }
});

test("host calls are serialized: a second call does not start a process until the first has finished", async () => {
  const w = world();
  try {
    const events: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const releases: Array<() => void> = [];
    const runner = new FakeRunner();
    const inner = runner.run;
    runner.running = [w.app("Suite")];
    const host = new HostService({
      runner: async (binary, args, options) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        events.push(`start ${binary.endsWith("open") ? "open" : String(args[2] ?? args[1]).slice(0, 3)}`);
        await new Promise<void>((resolve) => { releases.push(resolve); });
        inFlight -= 1;
        events.push("end");
        return inner(binary, args, options);
      },
      config: { enabled: true, liveApp: "auto", setRoots: [w.root] }, applicationsDir: w.apps, home: w.base, uid: UID,
    });
    const first = host.menu("new");
    const second = host.menu("export");
    const third = host.launch(undefined);
    for (let i = 0; i < 40; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const release = releases.shift();
      if (release !== undefined) release();
      if (events.filter((e) => e === "end").length >= 6) break;
    }
    await Promise.all([first, second, third]);
    assert.equal(maxInFlight, 1);
    assert.equal(runner.calls.filter((c) => c.binary === "/usr/bin/open").length, 1);
    // order: whole first call (probe + script), then the second, then the third
    assert.deepEqual(runner.actions().map((c) => (c.binary === "/usr/bin/open" ? "open" : c.args[2])), ["new", "export", "open"]);
  } finally {
    w.cleanup();
  }
});

test("a failing call does not block the ones queued behind it", async () => {
  const w = world();
  try {
    const runner = new FakeRunner();
    runner.running = [w.app("Suite")];
    let menuCalls = 0;
    runner.answer = (call) => (call.args[1] === MENU_SCRIPT && (menuCalls += 1) === 1 ? { code: 1, stderr: "menu_item_disabled" } : undefined);
    const host = service(w, runner);
    const failed = host.menu("new").then(() => "ok", (error: unknown) => (error as ToolError).code);
    const fine = host.menu("save");
    assert.equal(await failed, "not_supported");
    assert.equal((await fine)["result"], "saved");
  } finally {
    w.cleanup();
  }
});

test("probeEdition: the one running Live 12 app gives the edition hint; anything else gives none, and a failed probe never throws", async () => {
  const w = world();
  try {
    const hint = async (running: string[], setup?: (runner: FakeRunner) => void): Promise<{ runner: FakeRunner; value: unknown }> => {
      const runner = new FakeRunner();
      runner.running = running;
      setup?.(runner);
      return { runner, value: await service(w, runner).probeEdition() };
    };
    const lite = await hint([w.app("Lite")]);
    assert.equal(lite.value, "lite");
    assert.deepEqual(lite.runner.calls.map((call) => call.args), [buildOsascriptArgs(RUNNING_SCRIPT, [w.app("Suite"), w.app("Lite")])], "only the running check runs");
    assert.equal(lite.runner.calls[0]?.options.timeoutMs, 2000);
    assert.equal(lite.runner.actions().length, 0);
    assert.equal((await hint([w.app("Suite")])).value, "suite");
    assert.equal((await hint([])).value, undefined, "nothing running");
    assert.equal((await hint([w.app("Suite"), w.app("Lite")])).value, undefined, "two running");
    const failed = await hint([], (runner) => { runner.answer = () => ({ code: 1, stderr: "execution error: boom (-1)" }); });
    assert.equal(failed.value, undefined, "non-zero exit");
    const timedOut = await hint([], (runner) => { runner.answer = () => ({ code: 1, timedOut: true, stderr: "" }); });
    assert.equal(timedOut.value, undefined, "timeout");
    const thrown = new HostService({ runner: () => Promise.reject(new Error("spawn exploded")), config: { enabled: true, liveApp: "auto", setRoots: [w.root] }, applicationsDir: w.apps, home: w.base, uid: UID });
    assert.equal(await thrown.probeEdition(), undefined, "runner rejects");
    const off = new FakeRunner();
    off.running = [w.app("Lite")];
    assert.equal(await service(w, off, { enabled: false }).probeEdition(), undefined, "host disabled");
    assert.equal(off.calls.length, 0, "disabled host starts no process");
  } finally {
    w.cleanup();
  }
});

test("probeEdition refreshes the running state that status reports", async () => {
  const w = world();
  try {
    const runner = new FakeRunner();
    runner.running = [w.app("Lite")];
    const host = service(w, runner);
    assert.equal(host.status()["running"], null);
    assert.equal(await host.probeEdition(), "lite");
    assert.deepEqual(host.status()["running"], ["Ableton Live 12 Lite"]);
    assert.equal(host.status()["selected"], "Ableton Live 12 Lite");
  } finally {
    w.cleanup();
  }
});

// ------------------------------------------------------------------ the edition of the last connection (F-T9-26)

function runtimeDirOf(w: World): string {
  const dir = path.join(w.base, "Library", "Application Support", "BatutaMCP");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  return dir;
}

test("auto starts the edition of the last connection, and says so; running, explicit app and host.live_app still win", async () => {
  const w = world(["Lite", "Standard", "Suite"]);
  try {
    runtimeDirOf(w);
    const runner = new FakeRunner();
    const host = service(w, runner);
    assert.equal((await host.launch(undefined)).chosen_by, "default", "nothing remembered yet");
    host.rememberEdition("lite");
    const last = await host.launch(undefined);
    assert.deepEqual([last.app.variant, last.chosen_by, last.action], ["lite", "last_used", "launched"]);
    assert.deepEqual(runner.actions().at(-1)?.args, ["-a", w.app("Lite")]);
    assert.equal(host.status()["selected"], "Ableton Live 12 Lite");
    assert.equal(host.status()["last_used"], "lite");
    // open_set with Live closed starts it too
    const opened = await host.openSet(w.set);
    assert.deepEqual([opened.app.variant, opened.chosen_by], ["lite", "last_used"]);
    assert.deepEqual(runner.actions().at(-1)?.args, ["-a", w.app("Lite"), w.set]);
    // an explicit app and the setting win over the memory
    const explicit = await host.launch("standard");
    assert.deepEqual([explicit.app.variant, explicit.chosen_by], ["standard", "requested"]);
    const configured = await service(w, runner, { liveApp: "suite" }).launch(undefined);
    assert.deepEqual([configured.app.variant, configured.chosen_by], ["suite", "config"]);
    // the running Live wins
    runner.running = [w.app("Suite")];
    const running = await host.launch(undefined);
    assert.deepEqual([running.app.variant, running.chosen_by, running.action], ["suite", "running", "activated"]);
  } finally {
    w.cleanup();
  }
});

test("a remembered edition that is no longer installed falls back to the fixed order", async () => {
  const w = world(["Lite", "Suite"]);
  try {
    runtimeDirOf(w);
    const host = service(w, new FakeRunner());
    host.rememberEdition("standard");
    const out = await host.launch(undefined);
    assert.deepEqual([out.app.variant, out.chosen_by], ["suite", "default"]);
    assert.equal(host.status()["last_used"], null);
  } finally {
    w.cleanup();
  }
});

test("rememberEdition keeps only lite, standard and suite, and does nothing when the host is disabled or the runtime directory is missing", () => {
  const w = world(["Lite", "Suite"]);
  try {
    const host = service(w, new FakeRunner());
    host.rememberEdition("lite"); // no runtime directory: nothing is created
    assert.equal(fs.existsSync(path.join(w.base, "Library")), false);
    const dir = runtimeDirOf(w);
    for (const bad of ["unknown", "intro", "", null, undefined, "LITE"]) host.rememberEdition(bad);
    assert.deepEqual(fs.readdirSync(dir), []);
    service(w, new FakeRunner(), { enabled: false }).rememberEdition("lite");
    assert.deepEqual(fs.readdirSync(dir), []);
    host.rememberEdition("lite");
    assert.deepEqual(fs.readdirSync(dir), ["last-edition.json"]);
  } finally {
    w.cleanup();
  }
});
