import fs from "node:fs";
import path from "node:path";

/**
 * Read-only checks of the Remote Script's runtime directory, token and socket
 * (docs/01-protocol.md sections 2.1 and 2.3). The server never creates, repairs or deletes anything
 * here, and no error message ever contains token content.
 */

export type RuntimeFileReason =
  | "dir_missing" | "dir_not_directory" | "dir_owner" | "dir_permissions"
  | "token_missing" | "token_unreadable" | "token_not_regular" | "token_owner" | "token_permissions"
  | "token_size" | "token_format" | "token_replaced"
  | "socket_missing" | "socket_not_socket" | "socket_owner" | "socket_path_too_long";

export class RuntimeFileError extends Error {
  constructor(readonly reason: RuntimeFileReason, message: string) {
    super(message);
    this.name = "RuntimeFileError";
  }
}

export interface RuntimeFileOptions {
  /** Owner uid the files must have. Defaults to the current user. */
  expectedUid?: number;
  /** Owner uid required of the runtime directory; defaults to `expectedUid`. Lets tests check each rule alone. */
  expectedDirUid?: number;
  /** Test seam: runs after the open descriptor is verified and before the path is re-checked. */
  afterOpen?: () => void;
}

export const TOKEN_LENGTH = 64;
/** macOS `sun_path` is 104 bytes including the terminating NUL. */
export const SOCKET_PATH_MAX_BYTES = 103;

const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export function defaultRuntimeDir(home: string): string {
  return path.join(home, "Library", "Application Support", "BatutaMCP");
}

function currentUid(options?: RuntimeFileOptions): number {
  return options?.expectedUid ?? process.getuid?.() ?? -1;
}

export function checkDirectory(dir: string, options?: RuntimeFileOptions): void {
  let info: fs.Stats;
  try {
    info = fs.lstatSync(dir);
  } catch (error) {
    throw new RuntimeFileError("dir_missing", `cannot stat runtime dir ${dir}: ${(error as NodeJS.ErrnoException).code ?? "error"}. Is Live running with the BatutaMCP control surface enabled?`);
  }
  if (!info.isDirectory()) throw new RuntimeFileError("dir_not_directory", `runtime path ${dir} is not a real directory (symlinks are refused)`);
  if (info.uid !== (options?.expectedDirUid ?? currentUid(options))) throw new RuntimeFileError("dir_owner", `runtime dir ${dir} is not owned by the current user`);
  if ((info.mode & 0o077) !== 0) throw new RuntimeFileError("dir_permissions", `runtime dir ${dir} must not be accessible to group or others (expected mode 0700)`);
  if ((info.mode & 0o700) !== 0o700) throw new RuntimeFileError("dir_permissions", `runtime dir ${dir} must be readable, writable and searchable by its owner (mode 0700)`);
}

/**
 * Read the shared token. Checks the runtime dir, opens the token without following links, verifies
 * the open file descriptor, and confirms the path still names the same file.
 */
export function readToken(runtimeDir: string, options?: RuntimeFileOptions): string {
  checkDirectory(runtimeDir, options);
  const file = path.join(runtimeDir, "token");
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "error";
    if (code === "ENOENT") throw new RuntimeFileError("token_missing", `token file ${file} does not exist`);
    throw new RuntimeFileError("token_unreadable", `cannot open token file ${file}: ${code} (symlinks are refused)`);
  }
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile()) throw new RuntimeFileError("token_not_regular", `token file ${file} is not a regular file`);
    if (info.uid !== currentUid(options)) throw new RuntimeFileError("token_owner", `token file ${file} is not owned by the current user`);
    if ((info.mode & 0o077) !== 0) throw new RuntimeFileError("token_permissions", `token file ${file} must be mode 0600 (no access for group or others)`);
    if (info.size !== TOKEN_LENGTH) throw new RuntimeFileError("token_size", `token file ${file} must hold exactly ${TOKEN_LENGTH} bytes`);
    options?.afterOpen?.();
    let again: fs.Stats;
    try {
      again = fs.lstatSync(file);
    } catch {
      throw new RuntimeFileError("token_replaced", `token file ${file} changed while being read`);
    }
    if (again.dev !== info.dev || again.ino !== info.ino) {
      throw new RuntimeFileError("token_replaced", `token file ${file} was replaced while being read`);
    }
    const data = Buffer.alloc(TOKEN_LENGTH + 1);
    const read = fs.readSync(fd, data, 0, data.length, 0);
    const text = data.subarray(0, read).toString("latin1");
    if (read !== TOKEN_LENGTH || !TOKEN_PATTERN.test(text)) {
      throw new RuntimeFileError("token_format", `token file ${file} does not hold ${TOKEN_LENGTH} lowercase hex characters`);
    }
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

/** Verify that `sockPath` is a socket owned by the current user and short enough for AF_UNIX. */
export function checkSocketFile(sockPath: string, options?: RuntimeFileOptions): void {
  if (Buffer.byteLength(sockPath) > SOCKET_PATH_MAX_BYTES) {
    throw new RuntimeFileError("socket_path_too_long", `socket path ${sockPath} is longer than ${SOCKET_PATH_MAX_BYTES} bytes`);
  }
  let info: fs.Stats;
  try {
    info = fs.lstatSync(sockPath);
  } catch {
    throw new RuntimeFileError("socket_missing", `socket ${sockPath} does not exist. Is Live running with the BatutaMCP control surface enabled?`);
  }
  if (!info.isSocket()) throw new RuntimeFileError("socket_not_socket", `${sockPath} is not a socket`);
  if (info.uid !== currentUid(options)) throw new RuntimeFileError("socket_owner", `socket ${sockPath} is not owned by the current user`);
}

/**
 * Cheap identity of whatever sits at `sockPath` right now: "missing", or the inode and change time of the entry
 * (one lstat, nothing is opened). The client compares two readings to notice that Live created or re-created its
 * socket while it waits out a backoff delay.
 */
export function socketSignature(sockPath: string): string {
  try {
    const info = fs.lstatSync(sockPath);
    return `${info.ino}:${info.ctimeMs}`;
  } catch {
    return "missing";
  }
}
