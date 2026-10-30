import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { checkDirectory } from "../live/runtime-files.js";
import type { RuntimeFileOptions } from "../live/runtime-files.js";
import { VARIANTS } from "./apps.js";
import type { Variant } from "./apps.js";

/**
 * Which edition of Live connected last (docs/04-host-automation.md section 3.1). A tiny file in the runtime
 * directory, `last-edition.json` (`{"variant":"lite"}`, mode 0600), so that `host.live_app: auto` can start the edition the
 * owner really works in. It is a hint only: every problem with it (missing directory, wrong owner or mode, a
 * symlink, a damaged or oversized file, a failed write) means "unknown" and nothing is thrown. The runtime
 * directory is the Remote Script's; the server never creates it, and it must pass the same checks the token
 * does (a real directory of the user, mode 0700). Nothing here follows a symlink.
 */

export const LAST_APP_FILE = "last-edition.json";
const MAX_BYTES = 256;

/** The edition last remembered in `runtimeDir`, or undefined. */
export function readLastApp(runtimeDir: string, options?: RuntimeFileOptions): Variant | undefined {
  let fd: number | undefined;
  try {
    checkDirectory(runtimeDir, options);
    fd = fs.openSync(path.join(runtimeDir, LAST_APP_FILE), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const info = fs.fstatSync(fd);
    const uid = options?.expectedUid ?? process.getuid?.() ?? -1;
    if (!info.isFile() || info.uid !== uid || (info.mode & 0o077) !== 0 || info.size > MAX_BYTES) return undefined;
    const data = Buffer.alloc(info.size);
    const read = fs.readSync(fd, data, 0, data.length, 0);
    const parsed: unknown = JSON.parse(data.subarray(0, read).toString("utf8"));
    const variant = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>)["variant"] : undefined;
    return VARIANTS.find((known) => known === variant);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // nothing left to do with a descriptor that will not close
      }
    }
  }
}

/**
 * Remember `variant`. A new file is created exclusively (never through a link) and renamed over the old one, so a
 * symlink or a directory at the final name is replaced or refused, never followed. Returns whether it was written.
 */
export function writeLastApp(runtimeDir: string, variant: Variant, options?: RuntimeFileOptions): boolean {
  const temporary = path.join(runtimeDir, `${LAST_APP_FILE}.tmp.${randomBytes(8).toString("hex")}`);
  let created = false;
  try {
    checkDirectory(runtimeDir, options);
    const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    created = true;
    try {
      fs.writeSync(fd, `${JSON.stringify({ variant })}\n`);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, path.join(runtimeDir, LAST_APP_FILE));
    return true;
  } catch {
    if (created) {
      try {
        fs.unlinkSync(temporary);
      } catch {
        // the temporary file stays; it holds one word
      }
    }
    return false;
  }
}
