import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { readToken, checkSocketFile, defaultRuntimeDir, RuntimeFileError } from "../src/live/runtime-files.js";

const TOKEN = "ab".repeat(32);

function makeDir(mode = 0o700): string {
  const dir = fs.mkdtempSync("/tmp/bm-");
  fs.chmodSync(dir, mode);
  return dir;
}
function cleanup(dir: string): void {
  fs.chmodSync(dir, 0o700);
  fs.rmSync(dir, { recursive: true, force: true });
}
function expectReason(fn: () => unknown, reason: string): RuntimeFileError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof RuntimeFileError, `expected RuntimeFileError, got ${String(error)}`);
    assert.equal(error.reason, reason, error.message);
    return error;
  }
  throw new assert.AssertionError({ message: `expected failure with reason ${reason}` });
}

test("defaultRuntimeDir is under ~/Library/Application Support/BatutaMCP", () => {
  assert.equal(defaultRuntimeDir("/Users/x"), "/Users/x/Library/Application Support/BatutaMCP");
});

test("readToken accepts a 0600 owner-owned 64-hex file in a 0700 dir", () => {
  const dir = makeDir();
  try {
    fs.writeFileSync(path.join(dir, "token"), TOKEN, { mode: 0o600 });
    assert.equal(readToken(dir), TOKEN);
  } finally { cleanup(dir); }
});

test("readToken refuses a loose runtime dir, a symlinked dir and a missing dir", () => {
  const loose = makeDir(0o755);
  try {
    fs.writeFileSync(path.join(loose, "token"), TOKEN, { mode: 0o600 });
    expectReason(() => readToken(loose), "dir_permissions");
  } finally { cleanup(loose); }

  const real = makeDir();
  const link = `${real}-link`;
  try {
    fs.writeFileSync(path.join(real, "token"), TOKEN, { mode: 0o600 });
    fs.symlinkSync(real, link);
    expectReason(() => readToken(link), "dir_not_directory");
  } finally { fs.rmSync(link, { force: true }); cleanup(real); }

  expectReason(() => readToken("/tmp/bm-does-not-exist-0"), "dir_missing");
});

test("readToken refuses a directory owned by someone else", () => {
  const dir = makeDir();
  try {
    fs.writeFileSync(path.join(dir, "token"), TOKEN, { mode: 0o600 });
    expectReason(() => readToken(dir, { expectedUid: (process.getuid?.() ?? 0) + 1 }), "dir_owner");
  } finally { cleanup(dir); }
});

test("readToken refuses a token that others can read, another owner, or a symlink", () => {
  const dir = makeDir();
  try {
    const file = path.join(dir, "token");
    fs.writeFileSync(file, TOKEN, { mode: 0o600 });
    fs.chmodSync(file, 0o644);
    expectReason(() => readToken(dir), "token_permissions");
    fs.chmodSync(file, 0o640);
    expectReason(() => readToken(dir), "token_permissions");
    fs.chmodSync(file, 0o600);
    expectReason(() => readToken(dir, { expectedUid: (process.getuid?.() ?? 0) + 1, expectedDirUid: process.getuid?.() ?? 0 }), "token_owner");
    fs.rmSync(file);
    const target = path.join(dir, "elsewhere");
    fs.writeFileSync(target, TOKEN, { mode: 0o600 });
    fs.symlinkSync(target, file);
    expectReason(() => readToken(dir), "token_unreadable");
  } finally { cleanup(dir); }
});

test("readToken refuses missing tokens, wrong sizes and non-hex content without echoing the content", () => {
  const dir = makeDir();
  try {
    const file = path.join(dir, "token");
    expectReason(() => readToken(dir), "token_missing");
    const secretish = "SECRETSECRET";
    for (const [content, reason] of [
      [TOKEN.slice(0, 63), "token_size"],
      [`${TOKEN}0`, "token_size"],
      [`${TOKEN}\n`, "token_size"],
      [`${secretish}${"x".repeat(52)}`, "token_format"],
      [TOKEN.toUpperCase(), "token_format"],
    ] as const) {
      fs.writeFileSync(file, content, { mode: 0o600 });
      const error = expectReason(() => readToken(dir), reason);
      assert.ok(!error.message.includes(secretish) && !error.message.includes(TOKEN), "message must not contain token content");
      assert.ok(error.message.includes(file), "message names the path");
    }
    fs.rmSync(file);
    fs.mkdirSync(file);
    expectReason(() => readToken(dir), "token_not_regular");
  } finally { cleanup(dir); }
});

test("checkSocketFile requires an owned socket and a short path", async () => {
  const dir = makeDir();
  const sock = path.join(dir, "live.sock");
  try {
    expectReason(() => checkSocketFile(sock), "socket_missing");
    fs.writeFileSync(sock, "x");
    expectReason(() => checkSocketFile(sock), "socket_not_socket");
    fs.rmSync(sock);
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(sock, resolve));
    assert.doesNotThrow(() => checkSocketFile(sock));
    expectReason(() => checkSocketFile(sock, { expectedUid: (process.getuid?.() ?? 0) + 1 }), "socket_owner");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expectReason(() => checkSocketFile(`/tmp/${"a".repeat(120)}/live.sock`), "socket_path_too_long");
  } finally { cleanup(dir); }
});

test("any group or other access to the runtime dir is refused, as is an owner without rwx", () => {
  for (const mode of [0o750, 0o770, 0o710, 0o701, 0o705, 0o755, 0o777]) {
    const dir = makeDir(mode);
    try {
      fs.writeFileSync(path.join(dir, "token"), TOKEN, { mode: 0o600 });
      expectReason(() => readToken(dir), "dir_permissions");
    } finally { cleanup(dir); }
  }
  for (const mode of [0o500, 0o600, 0o300]) {
    const dir = makeDir(mode);
    try {
      expectReason(() => readToken(dir), "dir_permissions");
    } finally { cleanup(dir); }
  }
});

test("a token file swapped for another file between open and recheck is detected", () => {
  const dir = makeDir();
  try {
    const file = path.join(dir, "token");
    fs.writeFileSync(file, TOKEN, { mode: 0o600 });
    const error = expectReason(() => readToken(dir, {
      afterOpen: () => {
        // Same name, same content, different inode: what an attacker replacing the file would do.
        fs.rmSync(file);
        fs.writeFileSync(file, TOKEN, { mode: 0o600 });
      },
    }), "token_replaced");
    assert.match(error.message, /replaced|changed/);
    // Deleted between open and recheck.
    fs.writeFileSync(file, TOKEN, { mode: 0o600 });
    expectReason(() => readToken(dir, { afterOpen: () => fs.rmSync(file) }), "token_replaced");
    // Untouched: fine.
    fs.writeFileSync(file, TOKEN, { mode: 0o600 });
    assert.equal(readToken(dir, { afterOpen: () => undefined }), TOKEN);
  } finally { cleanup(dir); }
});
