import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { LAST_APP_FILE, readLastApp, writeLastApp } from "../src/host/last-app.js";

/** The remembered edition (docs/04-host-automation.md section 3.1): a small file in the runtime directory, never followed through a link. */

const UID = process.getuid?.() ?? 0;

function runtime(): { dir: string; file: string; cleanup(): void } {
  const base = fs.realpathSync(fs.mkdtempSync("/tmp/bm-last-"));
  const dir = path.join(base, "BatutaMCP");
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  return { dir, file: path.join(dir, LAST_APP_FILE), cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test("what was written is read back; the file is private and no temporary file is left", () => {
  const r = runtime();
  try {
    assert.equal(readLastApp(r.dir), undefined);
    assert.equal(writeLastApp(r.dir, "lite"), true);
    assert.equal(readLastApp(r.dir), "lite");
    assert.equal(fs.statSync(r.file).mode & 0o777, 0o600);
    assert.equal(writeLastApp(r.dir, "suite"), true);
    assert.equal(readLastApp(r.dir), "suite");
    assert.deepEqual(fs.readdirSync(r.dir), [LAST_APP_FILE]);
  } finally {
    r.cleanup();
  }
});

test("a missing runtime directory is never created: reading gives undefined and writing fails quietly", () => {
  const r = runtime();
  try {
    const missing = path.join(r.dir, "nope");
    assert.equal(writeLastApp(missing, "lite"), false);
    assert.equal(fs.existsSync(missing), false);
    assert.equal(readLastApp(missing), undefined);
  } finally {
    r.cleanup();
  }
});

test("a runtime directory that is open to others, owned by someone else or a symlink is not used", () => {
  const r = runtime();
  try {
    assert.equal(writeLastApp(r.dir, "lite"), true);
    fs.chmodSync(r.dir, 0o755);
    assert.equal(readLastApp(r.dir), undefined);
    assert.equal(writeLastApp(r.dir, "suite"), false);
    fs.chmodSync(r.dir, 0o700);
    assert.equal(readLastApp(r.dir, { expectedUid: UID + 1 }), undefined);
    assert.equal(writeLastApp(r.dir, "suite", { expectedUid: UID + 1 }), false);
    const alias = path.join(path.dirname(r.dir), "alias");
    fs.symlinkSync(r.dir, alias);
    assert.equal(readLastApp(alias), undefined);
    assert.equal(writeLastApp(alias, "suite"), false);
    assert.equal(readLastApp(r.dir), "lite");
  } finally {
    r.cleanup();
  }
});

test("a symlink at the file name is never followed: reading ignores it, writing replaces the link and leaves its target alone", () => {
  const r = runtime();
  try {
    const target = path.join(path.dirname(r.dir), "target.json");
    fs.writeFileSync(target, JSON.stringify({ variant: "lite" }), { mode: 0o600 });
    fs.symlinkSync(target, r.file);
    assert.equal(readLastApp(r.dir), undefined);
    assert.equal(writeLastApp(r.dir, "suite"), true);
    assert.equal(fs.readFileSync(target, "utf8"), JSON.stringify({ variant: "lite" }), "the target of the link was not touched");
    assert.equal(fs.lstatSync(r.file).isSymbolicLink(), false);
    assert.equal(readLastApp(r.dir), "suite");
  } finally {
    r.cleanup();
  }
});

test("damaged, oversized, group-readable or wrongly typed content means unknown", () => {
  const r = runtime();
  try {
    const put = (text: string, mode = 0o600): void => { fs.rmSync(r.file, { force: true }); fs.writeFileSync(r.file, text, { mode }); fs.chmodSync(r.file, mode); };
    for (const text of ["", "lite", "{", "[]", "null", "{\"variant\":1}", "{\"variant\":\"pro\"}", "{\"variant\":\"LITE\"}", `{"variant":"lite","pad":"${"x".repeat(300)}"}`]) {
      put(text);
      assert.equal(readLastApp(r.dir), undefined, text.slice(0, 40));
    }
    put("{\"variant\":\"lite\"}", 0o644);
    assert.equal(readLastApp(r.dir), undefined, "readable by others");
    put("{\"variant\":\"lite\"}");
    assert.equal(readLastApp(r.dir, { expectedUid: UID + 1, expectedDirUid: UID }), undefined, "owned by someone else");
    assert.equal(readLastApp(r.dir), "lite");
    fs.rmSync(r.file);
    fs.mkdirSync(r.file);
    assert.equal(readLastApp(r.dir), undefined, "a directory at the name");
    assert.equal(writeLastApp(r.dir, "lite"), false, "a directory at the name is not replaced");
    assert.deepEqual(fs.readdirSync(r.dir), [LAST_APP_FILE], "and its failed temporary file is removed");
  } finally {
    r.cleanup();
  }
});
