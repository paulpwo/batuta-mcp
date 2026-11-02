import fs from "node:fs";

const PACKAGE_JSON_MAX_BYTES = 64 * 1024;

/**
 * The version in server/package.json, the one place a version is set. The build runs from dist/src and a
 * release archive ships server/package.json beside server/dist, so the path holds in both. Read-only, without
 * following a link at the file itself.
 */
function readPackageVersion(): string {
  const fd = fs.openSync(new URL("../../package.json", import.meta.url), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const data = Buffer.alloc(PACKAGE_JSON_MAX_BYTES);
    const read = fs.readSync(fd, data, 0, data.length, 0);
    const version: unknown = (JSON.parse(data.subarray(0, read).toString("utf8")) as { version?: unknown }).version;
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error("server/package.json has no X.Y.Z version");
    return version;
  } finally {
    fs.closeSync(fd);
  }
}

/** Server version (from server/package.json). */
export const VERSION = readPackageVersion();

/** The oldest Remote Script version this server accepts. */
export const MIN_SCRIPT_VERSION = "0.1.0";
