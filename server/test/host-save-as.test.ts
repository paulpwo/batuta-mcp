import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { HostService, classifyFailure } from "../src/host/host.js";
import { HOST_TOOLS } from "../src/tools/host.js";
import { MENU_SCRIPT, RUNNING_SCRIPT, SAVE_AS_SCRIPT } from "../src/host/scripts.js";
import { FakeRunner } from "./helpers/fake-host.js";
import { makeApp } from "./helpers/fake-apps.js";

// T9n (F-T9-23): Save As must reach the requested folder (Go to folder sheet, set by AX) and verify Where: and the name before Save.

const UID = process.getuid?.() ?? 0;
const flat = (text: string): string => text.replace(/\s+/g, " ");
const between = (text: string, from: string, to: string): string => {
  const start = text.indexOf(from);
  assert.ok(start >= 0, `missing: ${from}`);
  const end = text.indexOf(to, start + from.length);
  assert.ok(end > start, `missing: ${to}`);
  return text.slice(start, end + to.length);
};
const count = (text: string, needle: string): number => text.split(needle).length - 1;

test("Save As script: the only key events are Cmd-Shift-G and Return, each inside one guarded handler, and no other script has any", () => {
  assert.equal(count(SAVE_AS_SCRIPT, "keystroke"), 1);
  assert.equal(count(SAVE_AS_SCRIPT, "key code"), 1);
  assert.ok(SAVE_AS_SCRIPT.includes('keystroke "g" using {command down, shift down}'));
  assert.ok(SAVE_AS_SCRIPT.includes("key code 36"));
  for (const other of [MENU_SCRIPT, RUNNING_SCRIPT]) assert.ok(!other.includes("keystroke") && !other.includes("key code"));
  const handler = flat(between(SAVE_AS_SCRIPT, "on pressKey", "end pressKey"));
  assert.ok(handler.includes('keystroke "g"') && handler.includes("key code 36"), "both key events live in pressKey only");
  const guardLive = handler.indexOf("my liveIsFrontmost(liveProc)");
  const guardPanel = handler.indexOf("my findDialog(liveProc)");
  assert.ok(guardLive >= 0 && guardPanel >= 0);
  assert.ok(guardLive < handler.indexOf("keystroke") && guardLive < handler.indexOf("key code"), "Live is frontmost before any key event");
  assert.ok(guardPanel < handler.indexOf("keystroke") && guardPanel < handler.indexOf("key code"), "the panel is open before any key event");
  assert.ok(handler.includes("live_not_frontmost") && handler.includes("number 1015"));
  assert.ok(between(SAVE_AS_SCRIPT, "on liveIsFrontmost", "end liveIsFrontmost").includes("frontmost is true"));
});

test("Save As script: goes to the folder, verifies Where: and the name, and only then clicks Save; failures cancel the panel", () => {
  const prep = flat(between(SAVE_AS_SCRIPT, "on prepareDialog", "end prepareDialog"));
  const iGo = prep.indexOf('my pressKey(liveProc, "goto")');
  const iFolder = prep.indexOf("set value of goField to folderPath");
  const iReturn = prep.indexOf('my pressKey(liveProc, "return")');
  const iWhere = prep.indexOf("my whereText(dialogElement)");
  const iName = prep.indexOf("set value of nameField to baseName");
  const iNameCheck = prep.indexOf("nameNow is not baseName");
  assert.ok(iGo >= 0 && iFolder > iGo && iReturn > iFolder && iWhere > iReturn && iName > iWhere && iNameCheck > iName, "order: go to, folder value, return, Where, name, name check");
  assert.ok(prep.includes("folderName"), "Where: is compared with the folder base name");
  assert.ok(prep.includes("path_not_applied where=[") && prep.includes("] name=[") && prep.includes("number 1012"), "failure says what was seen");
  const run = flat(between(SAVE_AS_SCRIPT, "on run argv", "end run"));
  assert.ok(run.indexOf("my prepareDialog(") >= 0 && run.indexOf("my prepareDialog(") < run.indexOf("click confirmButton"));
  assert.ok(run.includes("my abortPanel(liveProc)") && run.indexOf("on error") < run.indexOf("my abortPanel(liveProc)") && run.indexOf("my abortPanel(liveProc)") < run.indexOf("click confirmButton"), "a failed preparation cancels the panel before Save can be pressed");
  assert.ok(run.includes("set folderPath to") && run.includes("set baseName to last text item of targetPath"));
  assert.ok(between(SAVE_AS_SCRIPT, "on abortPanel", "end abortPanel").includes("my cancelDialog(liveProc, holder)") && between(SAVE_AS_SCRIPT, "on cancelDialog", "end cancelDialog").includes('{"Cancel", "Cancelar"}'));
  // Where: is the pop up button; the lookup is by name in English and Spanish with the first pop up as the last resort
  assert.ok(between(SAVE_AS_SCRIPT, "on collectPopUps", "end collectPopUps").includes("pop up buttons of holder"));
  assert.ok(/"Where"/.test(SAVE_AS_SCRIPT) && /"Donde"/.test(SAVE_AS_SCRIPT));
});

test("Save As script compiles", { skip: process.platform !== "darwin" }, () => {
  const result = spawnSync("/usr/bin/osacompile", ["-o", "/dev/null", "-e", SAVE_AS_SCRIPT], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("classifyFailure: a refused panel reports what was seen, and a Live that lost the front is its own reason", () => {
  const res = (stderr: string) => ({ code: 1, stdout: "", stderr, timedOut: false, truncated: false });
  const applied = classifyFailure(res("execution error: path_not_applied where=[Ableton] name=[Sin titulo] (1012)\n"), "ui");
  assert.equal(applied.details?.["reason"], "path_not_applied");
  assert.equal(applied.details?.["where"], "Ableton");
  assert.equal(applied.details?.["name"], "Sin titulo");
  assert.match(applied.message, /nothing was saved/);
  const front = classifyFailure(res("execution error: live_not_frontmost (1015)\n"), "ui");
  assert.equal(front.details?.["reason"], "live_not_frontmost");
  assert.equal(classifyFailure(res("execution error: goto_sheet_not_found (1016)\n"), "ui").details?.["reason"], "ui_element_not_found");
});

test("the tool description tells the model about the <name> Project folder", () => {
  const info = HOST_TOOLS.find((tool) => tool.name === "save_set_as");
  assert.ok(info !== undefined && /Project/.test(info.description) && info.description.length <= 1400);
});

interface World { base: string; apps: string; root: string; cleanup(): void }
function world(): World {
  const base = fs.realpathSync(fs.mkdtempSync("/tmp/bm-saveas-"));
  const apps = path.join(base, "Applications");
  const root = path.join(base, "Music", "Ableton");
  fs.mkdirSync(apps);
  fs.mkdirSync(root, { recursive: true });
  makeApp(apps, "Ableton Live 12 Suite.app");
  return { base, apps, root, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}
const service = (w: World, runner: FakeRunner): HostService => new HostService({ runner: runner.run, config: { enabled: true, liveApp: "auto", setRoots: [w.root] }, applicationsDir: w.apps, home: w.base, uid: UID });
const rig = (w: World): FakeRunner => { const runner = new FakeRunner(); runner.running = [path.join(w.apps, "Ableton Live 12 Suite.app")]; return runner; };
async function rejects(promise: Promise<unknown>): Promise<{ details?: Record<string, unknown> }> {
  try { await promise; } catch (error) { return error as { details?: Record<string, unknown> }; }
  throw new assert.AssertionError({ message: "expected rejection" });
}

test("Save As accepts Live's <name> Project/<name>.als layout and reports the path that was written", async () => {
  const w = world();
  try {
    const runner = rig(w);
    runner.landLayout = "project";
    const target = path.join(w.root, "a.als");
    const out = await service(w, runner).saveSetAs(target, false);
    const actual = path.join(w.root, "a Project", "a.als");
    assert.equal(out["path"], actual);
    assert.equal(out["requested_path"], target);
    assert.equal(out["result"], "saved");
    assert.equal(out["replaced"], false);
    assert.ok(fs.existsSync(actual) && !fs.existsSync(target));
  } finally {
    w.cleanup();
  }
});

test("Save As: a project layout whose folder or file is a symlink is not a landed save", async () => {
  const w = world();
  try {
    const outside = path.join(w.base, "elsewhere");
    fs.mkdirSync(outside);
    const runner = rig(w);
    runner.landSaveAs = false;
    runner.answer = (call) => {
      if (call.args[1] === SAVE_AS_SCRIPT) { fs.symlinkSync(outside, path.join(w.root, "b Project")); fs.writeFileSync(path.join(outside, "b.als"), "x"); }
      return undefined;
    };
    assert.equal((await rejects(service(w, runner).saveSetAs(path.join(w.root, "b.als"), false))).details?.["reason"], "save_unverified");
  } finally {
    w.cleanup();
  }
});

test("Save As overwrite check sees both candidates: an existing <name> Project/<name>.als counts as existing", async () => {
  const w = world();
  try {
    fs.mkdirSync(path.join(w.root, "c Project"));
    fs.writeFileSync(path.join(w.root, "c Project", "c.als"), "old");
    const host = service(w, rig(w));
    const checked = host.checkPath(path.join(w.root, "c.als"), "save");
    assert.equal(checked.exists, true, "the folder candidate exists");
    // and the service takes the confirmed replace of that file
    const runner = rig(w); // Live replaces the file the panel was driven to
    const out = await service(w, runner).saveSetAs(path.join(w.root, "c.als"), true);
    assert.equal(out["replaced"], true);
    assert.equal(out["path"], path.join(w.root, "c Project", "c.als"));
    assert.deepEqual(runner.actions().map((call) => call.args.slice(2)), [[path.join(w.root, "c Project", "c.als"), "1"]]);
    // an existing project folder that is a symlink is refused at planning time
    const target = fs.realpathSync(w.base);
    fs.symlinkSync(target, path.join(w.root, "d Project"));
    assert.equal((await rejects(Promise.resolve().then(() => host.checkPath(path.join(w.root, "d.als"), "save")))).details?.["reason"], "symlink_target");
  } finally {
    w.cleanup();
  }
});

// T9o (F-T9-24): Live never replaces when "<name> Project" exists (it suffixes -1), so the panel is driven into the project folder itself.

test("planning: an existing <name> Project/<name>.als makes the project file the panel target; a direct file or nothing keeps the direct target", () => {
  const w = world();
  try {
    fs.mkdirSync(path.join(w.root, "p Project"));
    fs.writeFileSync(path.join(w.root, "p Project", "p.als"), "old");
    const host = service(w, rig(w));
    const planned = host.checkPath(path.join(w.root, "p.als"), "save");
    assert.equal(planned.target?.project, true);
    assert.equal(planned.target?.real, path.join(w.root, "p Project", "p.als"));
    assert.equal(planned.target?.path, path.join(w.root, "p Project", "p.als"));
    fs.writeFileSync(path.join(w.root, "q.als"), "old");
    const direct = host.checkPath(path.join(w.root, "q.als"), "save");
    assert.equal(direct.target?.project, false);
    assert.equal(direct.target?.real, path.join(w.root, "q.als"));
    const fresh = host.checkPath(path.join(w.root, "r.als"), "save");
    assert.equal(fresh.target?.project, false);
    assert.equal(fresh.exists, false);
  } finally {
    w.cleanup();
  }
});

test("Save As over an existing <name> Project/<name>.als drives the panel into the project folder and reports the replace", async () => {
  const w = world();
  try {
    const file = path.join(w.root, "p Project", "p.als");
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, "old");
    fs.utimesSync(file, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    const runner = rig(w); // landLayout direct: the fake Live writes exactly the path it is given
    const requested = path.join(w.root, "p.als");
    const out = await service(w, runner).saveSetAs(requested, true);
    assert.deepEqual(runner.actions().map((call) => call.args.slice(2)), [[file, "1"]]);
    assert.equal(out["path"], file);
    assert.equal(out["requested_path"], requested);
    assert.equal(out["replaced"], true);
    assert.equal(out["result"], "saved");
    assert.ok(!fs.existsSync(path.join(w.root, "p-1 Project")));
  } finally {
    w.cleanup();
  }
});

test("Save As: a <name>-N Project folder that appeared during the call is reported as a stray copy, never as success", async () => {
  const w = world();
  try {
    const file = path.join(w.root, "s Project", "s.als");
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, "old");
    const runner = rig(w);
    runner.landSaveAs = false;
    const stray = path.join(w.root, "s-1 Project", "s.als");
    runner.answer = (call) => {
      if (call.args[1] === SAVE_AS_SCRIPT) { fs.mkdirSync(path.dirname(stray)); fs.writeFileSync(stray, "new"); }
      return undefined;
    };
    const error = await rejects(service(w, runner).saveSetAs(path.join(w.root, "s.als"), true));
    assert.equal(error.details?.["reason"], "stray_project_folder");
    assert.equal(error.details?.["stray_path"], stray);
    assert.match((error as { message?: string }).message ?? "", /s-1 Project/);
    assert.match((error as { message?: string }).message ?? "", /not replaced|was not replaced/);
  } finally {
    w.cleanup();
  }
});
