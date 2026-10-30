import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/** BatutaMCP is built from scratch: no file in the repository refers to another MCP project by name (the odd/ work log is not part of the repository). */

// Built from pieces so that this file does not contain the words it looks for.
const FORBIDDEN = [["ableton", "mcp"], ["ableton", "-", "mcp"], ["ableton", "_", "mcp"], ["aha", "ujasid"], ["ableton", "12"], ["ver", "ove"]].map((parts) => parts.join(""));
const REPO = path.resolve(import.meta.dirname, "..", "..", "..");
const SKIPPED_DIRECTORIES = new Set(["odd", "node_modules", "dist", ".pnpm", ".pnpm-store", ".git"]);
const BINARY = /\.(png|jpe?g|gif|webp|ico|wav|aiff?|mp3|zip|gz|tgz|woff2?|ttf|pyc|als|adg)$/i;
const MAX_BYTES = 4 * 1024 * 1024;

/** Every file of the repository except the skipped directories, found without following symlinks. */
export function repoFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) return [];
    if (entry.isDirectory()) return SKIPPED_DIRECTORIES.has(entry.name) || entry.name.startsWith(".pnpm-store") ? [] : repoFiles(full);
    return entry.isFile() && !BINARY.test(entry.name) && fs.statSync(full).size <= MAX_BYTES ? [full] : [];
  });
}

/** The forbidden words found in the text (lower-cased comparison). */
export function hitsIn(text: string): string[] {
  const lower = text.toLowerCase();
  return FORBIDDEN.filter((word) => lower.includes(word)).map((word) => `${word.slice(0, 3)}...`);
}

test("no file in the repository refers to another MCP project (odd/, node_modules, dist and pnpm stores are skipped)", () => {
  const targets = repoFiles(REPO);
  const relative = targets.map((file) => path.relative(REPO, file));
  assert.ok(targets.length > 100, `only ${targets.length} files scanned`);
  for (const expected of ["README.md", path.join("docs", "01-protocol.md"), path.join("docs", "03-tool-names.md"), path.join("remote_script", "BatutaMCP", "__init__.py"), path.join("tests", "remote_script", "test_dispatch.py"), path.join("installer", "test", "evasions.json"), path.join("loudness", "src", "analyze.ts"), path.join("server", "src", "tools", "names.ts"), path.join("server", "pnpm-workspace.yaml")]) {
    assert.ok(relative.includes(expected), `${expected} is scanned`);
  }
  assert.equal(relative.some((file) => file.split(path.sep).some((part) => SKIPPED_DIRECTORIES.has(part))), false, "skipped directories are not scanned");
  const hits: string[] = [];
  for (const file of targets) {
    for (const hit of hitsIn(fs.readFileSync(file, "utf8"))) hits.push(`${path.relative(REPO, file)}: ${hit}`);
  }
  assert.deepEqual(hits, []);
});

test("the scan sees a forbidden word in any text file outside the skipped directories", () => {
  const scratch = fs.mkdtempSync(path.join(fs.realpathSync(import.meta.dirname), "names-"));
  try {
    for (const dir of ["installer", "odd", "node_modules", "server/dist", "docs/.pnpm-store-x"]) fs.mkdirSync(path.join(scratch, dir), { recursive: true });
    const word = FORBIDDEN[0] ?? "";
    for (const file of ["installer/a.py", "odd/log.md", "node_modules/b.js", "server/dist/c.js", "docs/.pnpm-store-x/d.md", "e.yaml"]) fs.writeFileSync(path.join(scratch, file), `x ${word.toUpperCase()}\n`);
    const found = repoFiles(scratch).map((file) => path.relative(scratch, file)).sort();
    assert.deepEqual(found, ["e.yaml", path.join("installer", "a.py")]);
    assert.deepEqual(hitsIn(`x ${word.toUpperCase()}`), [`${word.slice(0, 3)}...`]);
    assert.deepEqual(hitsIn("nothing here"), []);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
