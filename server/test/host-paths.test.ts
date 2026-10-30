import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ToolError } from "../src/mcp/index.js";
import { checkSetPath, shortenPath } from "../src/host/paths.js";
import { VARIANTS, findInstalledApps } from "../src/host/apps.js";
import { safeText } from "../src/tools/util.js";
import { makeApp, plistFor } from "./helpers/fake-apps.js";

/** Path rules for open_set / save_set_as (docs/04-host-automation.md section 5) and the app lookup (section 3), on real temporary directories. */

const UID = process.getuid?.() ?? 0;

interface Env { base: string; root: string; root2: string; outside: string; set: string; cleanup(): void }

function env(): Env {
  const base = fs.realpathSync(fs.mkdtempSync("/tmp/bm-host-"));
  const root = path.join(base, "Music", "Ableton");
  const root2 = path.join(base, "Docs", "PRODUCTION");
  const outside = path.join(base, "elsewhere");
  for (const dir of [root, root2, outside, path.join(root, "sub")]) fs.mkdirSync(dir, { recursive: true });
  const set = path.join(root, "song.als");
  fs.writeFileSync(set, "not a real set");
  return { base, root, root2, outside, set, cleanup: () => { fs.chmodSync(set, 0o600); fs.rmSync(base, { recursive: true, force: true }); } };
}

function failure(fn: () => unknown): ToolError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ToolError, `expected a ToolError, got ${String(error)}`);
    return error;
  }
  throw new assert.AssertionError({ message: "expected the call to throw" });
}

const reasonOf = (error: ToolError): unknown => error.details?.["reason"];

test("a good path passes in both modes and is returned unchanged, with the facts the caller needs", () => {
  const e = env();
  try {
    const roots = [e.root, e.root2];
    const open = checkSetPath(e.set, "open", { roots, uid: UID });
    assert.deepEqual(open, { path: e.set, real: e.set, parent: e.root, exists: true });
    const fresh = path.join(e.root, "sub", "new.als");
    assert.deepEqual(checkSetPath(fresh, "save", { roots, uid: UID }), { path: fresh, real: fresh, parent: path.join(e.root, "sub"), exists: false });
    assert.equal(checkSetPath(e.set, "save", { roots, uid: UID }).exists, true);
    assert.equal(checkSetPath(path.join(e.root2, "UPPER.ALS"), "save", { roots, uid: UID }).exists, false, "extension is case-insensitive");
  } finally {
    e.cleanup();
  }
});

test("the file itself is never read: an unreadable set still validates", () => {
  const e = env();
  try {
    fs.chmodSync(e.set, 0);
    assert.equal(checkSetPath(e.set, "open", { roots: [e.root], uid: UID }).exists, true);
  } finally {
    e.cleanup();
  }
});

test("rejection table: every rule has its own reason and nothing else is accepted", () => {
  const e = env();
  try {
    const ctx = { roots: [e.root, e.root2], uid: UID };
    const long = path.join(e.root, `${"é".repeat(600)}.als`);
    assert.ok(long.length < 1024 && Buffer.byteLength(long) > 1024, "multi-byte path is too long in bytes, not in characters");
    const cases: Array<[unknown, string]> = [
      [undefined, "not_a_string"], [null, "not_a_string"], [42, "not_a_string"], [{}, "not_a_string"], [["/a.als"], "not_a_string"],
      ["", "empty"],
      [`${e.root}/a\u0000.als`, "nul_byte"], [`${e.root}/a\n.als`, "control_character"], [`${e.root}/a\t.als`, "control_character"], [`${e.root}/a\u007f.als`, "control_character"],
      [`${e.root}/a‮.als`, "control_character"], [`${e.root}/a⁦.als`, "control_character"], [`${e.root}/a\u0085.als`, "control_character"],
      [`${e.root}/a\u200b.als`, "control_character"], [`${e.root}/a\u200c.als`, "control_character"], [`${e.root}/a\u200d.als`, "control_character"], [`${e.root}/a\u200e.als`, "control_character"], [`${e.root}/a\u200f.als`, "control_character"],
      [`${e.root}/a\u2060.als`, "control_character"], [`${e.root}/a\u2062.als`, "control_character"], [`${e.root}/a\u2064.als`, "control_character"], [`${e.root}/a\u2028.als`, "control_character"], [`${e.root}/a\u2029.als`, "control_character"],
      [`${e.root}/a\ufeff.als`, "control_character"], [`${e.root}/a\u00ad.als`, "control_character"], [`${e.root}/a\u202a.als`, "control_character"], [`${e.root}/a\u2069.als`, "control_character"],
      [`${e.root}/a\u034f.als`, "control_character"], [`${e.root}/a\u115f.als`, "control_character"], [`${e.root}/a\u1160.als`, "control_character"], [`${e.root}/a\u17b4.als`, "control_character"], [`${e.root}/a\u17b5.als`, "control_character"],
      [`${e.root}/a\u180b.als`, "control_character"], [`${e.root}/a\u180f.als`, "control_character"], [`${e.root}/a\u2800.als`, "control_character"], [`${e.root}/a\u3164.als`, "control_character"], [`${e.root}/a\ufe00.als`, "control_character"],
      [`${e.root}/a\ufe0f.als`, "control_character"], [`${e.root}/a\uffa0.als`, "control_character"], [`${e.root}/a\ufff9.als`, "control_character"], [`${e.root}/a\ufffb.als`, "control_character"], [`${e.root}/a\u{1d173}.als`, "control_character"],
      [`${e.root}/a\u{1d17a}.als`, "control_character"], [`${e.root}/a\u{e0100}.als`, "control_character"], [`${e.root}/a\u{e01ef}.als`, "control_character"],
      [`${e.root}/a\u{e0001}.als`, "control_character"], [`${e.root}/a\u{e0020}.als`, "control_character"], [`${e.root}/a\u{e007f}.als`, "control_character"],
      [long, "too_long"],
      ["song.als", "not_absolute"], ["./song.als", "not_absolute"], ["~/Music/Ableton/song.als", "not_absolute"], ["../song.als", "not_absolute"],
      [`${e.root}/../elsewhere/x.als`, "not_normalized"], [`${e.root}/sub/../song.als`, "not_normalized"], [`${e.root}/./song.als`, "not_normalized"],
      [`${e.root}//song.als`, "not_normalized"], [`${e.root}/song.als/`, "not_normalized"], [`${e.root}/..`, "not_normalized"],
      [`${e.root}/café.als`, "not_nfc"],
      [`${e.root}/song.alsx`, "wrong_extension"], [`${e.root}/song.als.txt`, "wrong_extension"], [`${e.root}/song`, "wrong_extension"], [`${e.root}/.als`, "wrong_extension"],
      [`${e.root}/song.adg`, "wrong_extension"], [`${e.root}/song.amxd`, "wrong_extension"], [`${e.root}/song.als `, "wrong_extension"],
      [`${e.outside}/x.als`, "outside_roots"], ["/etc/x.als", "outside_roots"], ["/x.als", "outside_roots"], [`${e.root}-evil/x.als`, "outside_roots"], [`${e.root}x/x.als`, "outside_roots"],
      [`${path.dirname(e.root)}/x.als`, "outside_roots"],
    ];
    for (const [input, reason] of cases) {
      const error = failure(() => checkSetPath(input, "save", ctx));
      assert.equal(error.code, "invalid_args", JSON.stringify(input));
      assert.equal(reasonOf(error), reason, JSON.stringify(input));
    }
  } finally {
    e.cleanup();
  }
});

test("a missing parent is not_found, a parent that is a file is not a directory", () => {
  const e = env();
  try {
    const ctx = { roots: [e.root], uid: UID };
    const missing = failure(() => checkSetPath(path.join(e.root, "nope", "x.als"), "save", ctx));
    assert.equal(missing.code, "not_found");
    assert.equal(missing.details?.["what"], "parent_directory");
    const notDir = failure(() => checkSetPath(path.join(e.set, "x.als"), "save", ctx));
    assert.equal(reasonOf(notDir), "not_a_directory");
  } finally {
    e.cleanup();
  }
});

test("symlinks cannot lead out of the roots, and the final component is never a symlink", () => {
  const e = env();
  try {
    const ctx = { roots: [e.root], uid: UID };
    fs.symlinkSync(e.outside, path.join(e.root, "escape"));
    fs.symlinkSync(path.join(e.root, "sub"), path.join(e.root, "inside"));
    assert.equal(reasonOf(failure(() => checkSetPath(path.join(e.root, "escape", "x.als"), "save", ctx))), "outside_roots");
    assert.equal(reasonOf(failure(() => checkSetPath(path.join(e.root, "escape", "x.als"), "open", ctx))), "outside_roots");
    // a link that stays inside the roots is fine to open (Live gets the real path), but a set is never written through a symlinked folder
    fs.writeFileSync(path.join(e.root, "sub", "y.als"), "x");
    const viaLink = checkSetPath(path.join(e.root, "inside", "y.als"), "open", ctx);
    assert.equal(viaLink.parent, path.join(e.root, "sub"));
    assert.equal(viaLink.real, path.join(e.root, "sub", "y.als"));
    assert.equal(viaLink.path, path.join(e.root, "inside", "y.als"));
    assert.equal(reasonOf(failure(() => checkSetPath(path.join(e.root, "inside", "x.als"), "save", ctx))), "symlinked_parent");
    // a link in the middle of the chain that points out, two levels deep
    fs.mkdirSync(path.join(e.outside, "deep"));
    fs.symlinkSync(path.join(e.outside, "deep"), path.join(e.root, "sub", "deeper"));
    assert.equal(reasonOf(failure(() => checkSetPath(path.join(e.root, "sub", "deeper", "x.als"), "save", ctx))), "outside_roots");
    // the set itself as a symlink, to a file inside or outside
    fs.writeFileSync(path.join(e.outside, "real.als"), "x");
    fs.symlinkSync(path.join(e.outside, "real.als"), path.join(e.root, "link.als"));
    fs.symlinkSync(e.set, path.join(e.root, "inner.als"));
    for (const name of ["link.als", "inner.als"]) {
      for (const mode of ["open", "save"] as const) assert.equal(reasonOf(failure(() => checkSetPath(path.join(e.root, name), mode, ctx))), "symlink_target", `${name} ${mode}`);
    }
    // a dangling link
    fs.symlinkSync(path.join(e.root, "gone.als"), path.join(e.root, "dangling.als"));
    assert.equal(reasonOf(failure(() => checkSetPath(path.join(e.root, "dangling.als"), "save", ctx))), "symlink_target");
  } finally {
    e.cleanup();
  }
});

test("a root that is itself spelled through a symlink works, and a root outside the real path does not", () => {
  const e = env();
  try {
    const alias = path.join(e.base, "alias");
    fs.symlinkSync(e.root, alias);
    const viaAlias = checkSetPath(path.join(alias, "song.als"), "open", { roots: [alias], uid: UID });
    assert.equal(viaAlias.parent, e.root);
    assert.equal(checkSetPath(e.set, "open", { roots: [alias], uid: UID }).exists, true, "the real spelling of an aliased root is accepted");
    // a configured root that does not exist accepts nothing
    assert.equal(reasonOf(failure(() => checkSetPath(e.set, "open", { roots: [path.join(e.base, "missing")], uid: UID }))), "outside_roots");
  } finally {
    e.cleanup();
  }
});

test("replacing a file that has other hard links is refused; opening one is fine", () => {
  const e = env();
  try {
    const ctx = { roots: [e.root], uid: UID };
    fs.linkSync(e.set, path.join(e.root, "hard.als"));
    for (const name of ["song.als", "hard.als"]) assert.equal(reasonOf(failure(() => checkSetPath(path.join(e.root, name), "save", ctx))), "hardlinked_file", name);
    assert.equal(checkSetPath(path.join(e.root, "hard.als"), "open", ctx).exists, true);
    fs.rmSync(path.join(e.root, "hard.als"));
    assert.equal(checkSetPath(e.set, "save", ctx).exists, true, "a single link is fine again");
  } finally {
    e.cleanup();
  }
});

test("summaries drop invisible and direction characters (safeText)", () => {
  const nasty = "a\u200bb\u200dc\u2060d\ufeffe\u00adf\u202eg\u2066h\u2028i\u{e0041}j\u0007k\u0085l";
  assert.equal(safeText(nasty, 100), "a b c d e f g h i j k l");
  assert.equal(safeText("a\u034fb\u115fc\u1160d\u17b4e\u17b5f\u180bg\u2800h\u3164i\ufe0fj\uffa0k\ufff9l\u{1d173}m\u{e0100}n"), "a b c d e f g h i j k l m n");
  assert.equal(safeText("plain \u00e9 text"), "plain \u00e9 text");
});

test("open mode needs an existing regular file; save mode refuses an existing non-file", () => {
  const e = env();
  try {
    const ctx = { roots: [e.root], uid: UID };
    const missing = failure(() => checkSetPath(path.join(e.root, "missing.als"), "open", ctx));
    assert.equal(missing.code, "not_found");
    assert.equal(missing.details?.["what"], "set_file");
    fs.mkdirSync(path.join(e.root, "folder.als"));
    assert.equal(reasonOf(failure(() => checkSetPath(path.join(e.root, "folder.als"), "open", ctx))), "not_a_file");
    assert.equal(reasonOf(failure(() => checkSetPath(path.join(e.root, "folder.als"), "save", ctx))), "not_a_file");
  } finally {
    e.cleanup();
  }
});

test("the parent must be owned by the current user", () => {
  const e = env();
  try {
    const error = failure(() => checkSetPath(e.set, "open", { roots: [e.root], uid: UID + 1 }));
    assert.equal(reasonOf(error), "not_owned");
  } finally {
    e.cleanup();
  }
});

test("shortenPath keeps the file name", () => {
  assert.equal(shortenPath("/a/b/c.als", 300), "/a/b/c.als");
  const long = `/${"d".repeat(700)}/song.als`;
  const short = shortenPath(long, 300);
  assert.ok(short.length <= 303 && short.startsWith("...") && short.endsWith("/song.als"));
});

// ------------------------------------------------------------------ no roots configured (F-T9-25)

test("with no roots a set anywhere is accepted in both modes, with the same facts as inside a root", () => {
  const e = env();
  try {
    const ctx = { roots: [], uid: UID };
    const open = checkSetPath(e.set, "open", ctx);
    assert.deepEqual(open, { path: e.set, real: e.set, parent: e.root, exists: true });
    const fresh = path.join(e.outside, "ABLETON", "new.als");
    fs.mkdirSync(path.dirname(fresh));
    assert.deepEqual(checkSetPath(fresh, "save", ctx), { path: fresh, real: fresh, parent: path.dirname(fresh), exists: false });
    // a configured root still narrows exactly as before
    assert.equal(reasonOf(failure(() => checkSetPath(fresh, "save", { roots: [e.root], uid: UID }))), "outside_roots");
  } finally {
    e.cleanup();
  }
});

test("with no roots every other rule still applies: shape, extension, parent, owner, symlinks, hard links, regular file", () => {
  const e = env();
  try {
    const ctx = { roots: [], uid: UID };
    const cases: Array<[unknown, "open" | "save", string]> = [
      ["song.als", "save", "not_absolute"], [`${e.root}/../elsewhere/x.als`, "save", "not_normalized"], [`${e.root}//song.als`, "open", "not_normalized"],
      [`${e.root}/song.txt`, "save", "wrong_extension"], [`${e.root}/a\n.als`, "save", "control_character"],
    ];
    for (const [input, mode, reason] of cases) assert.equal(reasonOf(failure(() => checkSetPath(input, mode, ctx))), reason, JSON.stringify(input));
    assert.equal(failure(() => checkSetPath(path.join(e.outside, "nope", "x.als"), "save", ctx)).code, "not_found");
    assert.equal(reasonOf(failure(() => checkSetPath(e.set, "open", { roots: [], uid: UID + 1 }))), "not_owned");
    // a symlinked set file is refused wherever it is
    fs.symlinkSync(e.set, path.join(e.outside, "link.als"));
    for (const mode of ["open", "save"] as const) assert.equal(reasonOf(failure(() => checkSetPath(path.join(e.outside, "link.als"), mode, ctx))), "symlink_target", mode);
    // a directory named x.als is not a regular file
    fs.mkdirSync(path.join(e.outside, "dir.als"));
    assert.equal(reasonOf(failure(() => checkSetPath(path.join(e.outside, "dir.als"), "save", ctx))), "not_a_file");
    // a symlink anywhere in the real parent chain: a save is refused (realpath(parent) must equal parent), an open uses the real path
    fs.symlinkSync(e.root, path.join(e.outside, "viaLink"));
    assert.equal(reasonOf(failure(() => checkSetPath(path.join(e.outside, "viaLink", "x.als"), "save", ctx))), "symlinked_parent");
    const viaLink = checkSetPath(path.join(e.outside, "viaLink", "song.als"), "open", ctx);
    assert.equal(viaLink.real, e.set, "Live is given the real path, not the spelling through the link");
    // hard-linked files cannot be replaced
    fs.linkSync(e.set, path.join(e.outside, "hard.als"));
    assert.equal(reasonOf(failure(() => checkSetPath(path.join(e.outside, "hard.als"), "save", ctx))), "hardlinked_file");
  } finally {
    e.cleanup();
  }
});

// ------------------------------------------------------------------ apps

test("only the fixed names under the applications directory are found, in a fixed order, as real directories whose Info.plist says com.ableton.live", () => {
  const e = env();
  try {
    const apps = path.join(e.base, "Applications");
    fs.mkdirSync(apps);
    for (const name of ["Ableton Live 12 Lite.app", "Ableton Live 12 Suite.app", "Ableton Live 12 Beta.app", "Ableton Live 12 Other.app", "Ableton Live 11 Suite.app", "Ableton Live 12 Standard.app"]) makeApp(apps, name);
    fs.mkdirSync(path.join(apps, "Ableton Live 12 Trial"));
    fs.writeFileSync(path.join(apps, "Ableton Live 12 Intro.app"), "a file, not an app");
    fs.symlinkSync(e.outside, path.join(apps, "Ableton Live 12 Trial.app"));
    const found = findInstalledApps(apps, UID);
    assert.deepEqual(found.map((a) => a.variant), ["suite", "standard", "lite", "beta"]);
    assert.deepEqual(found.map((a) => a.name), ["Ableton Live 12 Suite", "Ableton Live 12 Standard", "Ableton Live 12 Lite", "Ableton Live 12 Beta"]);
    assert.deepEqual(found.map((a) => a.path), ["Suite", "Standard", "Lite", "Beta"].map((v) => path.join(apps, `Ableton Live 12 ${v}.app`)));
    assert.deepEqual([...VARIANTS], ["suite", "standard", "lite", "intro", "trial", "beta"]);
    assert.deepEqual(findInstalledApps(path.join(e.base, "nope"), UID), []);
    assert.deepEqual(findInstalledApps(apps, UID + 12345), [], "directories owned by someone else (not root) are ignored");
  } finally {
    e.cleanup();
  }
});

test("a bundle with the right name but the wrong content is not Live: identifier, plist format, links and size are all checked", () => {
  const e = env();
  try {
    const apps = path.join(e.base, "Applications");
    fs.mkdirSync(apps);
    const bundle = (variant: string): string => path.join(apps, `Ableton Live 12 ${variant}.app`);
    const info = (variant: string): string => path.join(bundle(variant), "Contents", "Info.plist");
    makeApp(apps, "Ableton Live 12 Suite.app", "com.evil.terminal");           // wrong identifier
    makeApp(apps, "Ableton Live 12 Standard.app");                              // good
    makeApp(apps, "Ableton Live 12 Lite.app");
    fs.writeFileSync(info("Lite"), Buffer.concat([Buffer.from("bplist00"), Buffer.from(plistFor("com.ableton.live"))])); // binary header, even with the XML text inside
    fs.mkdirSync(bundle("Intro"));                                              // no Contents at all
    makeApp(apps, "Ableton Live 12 Trial.app");
    fs.rmSync(info("Trial"));
    fs.writeFileSync(path.join(e.outside, "Info.plist"), plistFor("com.ableton.live"));
    fs.symlinkSync(path.join(e.outside, "Info.plist"), info("Trial"));          // Info.plist is a symlink
    makeApp(apps, "Ableton Live 12 Beta.app");
    fs.writeFileSync(info("Beta"), `${plistFor("com.ableton.live")}${"<!-- -->".repeat(60_000)}`); // over the size cap
    const found = findInstalledApps(apps, UID);
    assert.deepEqual(found.map((a) => a.variant), ["standard"]);
    // the identifier must be the value of the CFBundleIdentifier key, not just appear somewhere
    makeApp(apps, "Ableton Live 12 Suite.app");
    fs.writeFileSync(info("Suite"), plistFor("x").replace("<key>CFBundleName</key>\n\t<string>Live</string>", "<key>Other</key>\n\t<string>com.ableton.live</string>"));
    assert.deepEqual(findInstalledApps(apps, UID).map((a) => a.variant), ["standard"]);
    fs.writeFileSync(info("Suite"), plistFor("com.ableton.live.evil"));
    assert.deepEqual(findInstalledApps(apps, UID).map((a) => a.variant), ["standard"]);
    fs.writeFileSync(info("Suite"), plistFor("com.ableton.live"));
    assert.deepEqual(findInstalledApps(apps, UID).map((a) => a.variant), ["suite", "standard"]);
    // Contents as a symlink is refused too
    fs.rmSync(path.join(bundle("Suite"), "Contents"), { recursive: true });
    fs.symlinkSync(path.join(bundle("Standard"), "Contents"), path.join(bundle("Suite"), "Contents"));
    assert.deepEqual(findInstalledApps(apps, UID).map((a) => a.variant), ["standard"]);
  } finally {
    e.cleanup();
  }
});
