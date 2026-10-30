import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { classifyFailure } from "../src/host/host.js";
import { MENU_SCRIPT, SAVE_AS_SCRIPT } from "../src/host/scripts.js";

// T9m (F-T9-22): host automation must work with Live and macOS in English and Spanish (docs/04-host-automation.md section 6).

const between = (text: string, from: string, to: string): string => {
  const start = text.indexOf(from);
  assert.ok(start >= 0, `missing: ${from}`);
  const end = text.indexOf(to, start + from.length);
  assert.ok(end > start, `missing: ${to}`);
  return text.slice(start, end + to.length);
};

const HANDLERS = between(MENU_SCRIPT, "on replaceText", "end titlesFor");

/** Runs the pure title handlers (no System Events, no Live) through osascript and returns the matcher's answers. */
function matches(action: string, titles: string[]): boolean[] {
  const checks = titles.map((title) => `  set end of out to (my titleMatches("${title}", my titlesFor("${action}"))) as text`);
  const script = `${HANDLERS}\non run\n  set out to {}\n${checks.join("\n")}\n  set AppleScript's text item delimiters to ","\n  return out as text\nend run`;
  const result = spawnSync("/usr/bin/osascript", ["-e", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split(",").map((word) => word === "true");
}

const darwin = process.platform === "darwin";

test("menu titles: the real Spanish Live 12.4.7 Lite titles and the English ones match, with or without an ellipsis", { skip: !darwin }, () => {
  const e = "…";
  assert.deepEqual(matches("new", ["Nuevo Set Live", "New Live Set", "nuevo set live"]), [true, true, true]);
  assert.deepEqual(matches("save", ["Guardar Set Live", "Save Live Set", "GUARDAR  SET LIVE"]), [true, true, true]);
  assert.deepEqual(matches("saveas", ["Guardar Set Live como...", `Guardar Set Live como${e}`, "Guardar Set Live como", "Save Live Set As...", `Save Live Set As${e}`]), [true, true, true, true, true]);
  assert.deepEqual(matches("export", ["Exportar Audio...", `Exportar Audio${e}`, "Export Audio/Video...", `Export Audio/Video${e}`, "Export Audio...", "Exportar audio/video...", "Exportar audio/vídeo..."]), [true, true, true, true, true, true, true]);
});

test("menu titles: a different item is never matched by accident (exact normalised equality, not a prefix)", { skip: !darwin }, () => {
  assert.deepEqual(matches("save", ["Guardar Set Live como...", "Guardar una copia...", "Save Live Set As...", "Guardar el Live Set como plantilla...", "Recopilar todo y guardar", ""]), [false, false, false, false, false, false]);
  assert.deepEqual(matches("saveas", ["Guardar Set Live", "Guardar una copia...", "Save Live Set"]), [false, false, false]);
  assert.deepEqual(matches("export", ["Exportar MIDI Clip...", "Export MIDI Clip...", "Exportar Audio MIDI"]), [false, false, false]);
  assert.deepEqual(matches("new", ["Abrir Set Live...", "Abrir Set reciente", "Nuevo"]), [false, false, false]);
});

test("the scripts use the tolerant matcher over the File menu items and name the titles in their error", () => {
  const flat = MENU_SCRIPT.replace(/\s+/g, " ");
  assert.ok(flat.includes("my titleMatches(itemName, itemTitles)"));
  const matcher = between(MENU_SCRIPT, "on titleMatches", "end titleMatches").replace(/\s+/g, " ");
  assert.ok(matcher.includes("candidateKey is my normTitle(wantedTitle as text)"));
  assert.ok(!/starts with|begins with|contains/.test(matcher), "no prefix or substring matching");
  for (const title of ["Nuevo Set Live", "Guardar Set Live", "Guardar Set Live como", "Exportar Audio", "Export Audio/Video", "Export Audio", "New Live Set", "Save Live Set", "Save Live Set As"]) assert.ok(MENU_SCRIPT.includes(`"${title}"`), title);
  assert.ok(flat.includes('error "menu_item_not_found looked_for=[" & my joinTitles(itemTitles) & "] found=[" & my joinTitles(foundNames) & "]" number 1005'));
});

test("Save As script: the panel is found as a sheet or a dialog window, and its controls are looked up inside split groups, by role first and by English or Spanish name second", () => {
  const flat = SAVE_AS_SCRIPT.replace(/\s+/g, " ");
  assert.ok(flat.includes('(subrole of candidate) is "AXDialog"'));
  assert.ok(between(SAVE_AS_SCRIPT, "on findButton", "end findButton").includes("splitter groups of holder"));
  assert.ok(between(SAVE_AS_SCRIPT, "on collectTextFields", "end collectTextFields").includes("splitter groups of holder"));
  assert.ok(flat.includes('my attributeButton(dialogElement, "AXDefaultButton")') && flat.includes('my findButton(dialogElement, {"Save", "Guardar"}, 3)'));
  assert.ok(flat.includes('my attributeButton(dialogElement, "AXCancelButton")') && flat.includes('my findButton(dialogElement, {"Cancel", "Cancelar"}, 3)'));
  assert.ok(flat.includes('{"Save As", "Guardar como"}'));
  assert.ok(!/button "Cancel" of dialogElement|button "Save" of dialogElement|text field 1 of dialogElement/.test(flat), "no direct-child lookup of the panel controls");
  // the dialog is gone when no sheet/dialog window is left (a window index would keep matching Live's main window)
  assert.ok(between(SAVE_AS_SCRIPT, "on dialogGone", "end dialogGone").includes("my findDialog(liveProc)"));
});

test("a menu item that is not found reports the titles looked for and the File menu items found, bounded and control-stripped", () => {
  const found = Array.from({ length: 40 }, (_, i) => `Item ${i}${"x".repeat(100)}`).join("|");
  const error = classifyFailure({ code: 1, stdout: "", stderr: `execution error: menu_item_not_found looked_for=[Save Live Set|Guardar Set Live] found=[Nuevo Set Live|Guardar una copia\u0007|${found}] (1005)\n`, timedOut: false, truncated: false }, "ui");
  assert.equal(error.code, "host_failed");
  assert.equal(error.details?.["reason"], "menu_item_not_found");
  assert.deepEqual(error.details?.["looked_for"], ["Save Live Set", "Guardar Set Live"]);
  const items = error.details?.["found"] as string[];
  assert.deepEqual(items.slice(0, 2), ["Nuevo Set Live", "Guardar una copia"]);
  assert.ok(items.length <= 30 && items.every((item) => item.length <= 80));
  assert.match(error.message, /Save Live Set/);
  assert.match(error.message, /Nuevo Set Live/);
  const bare = classifyFailure({ code: 1, stdout: "", stderr: "execution error: menu_item_not_found (1005)", timedOut: false, truncated: false }, "ui");
  assert.equal(bare.details?.["reason"], "menu_item_not_found");
  assert.deepEqual(bare.details?.["found"], []);
});
