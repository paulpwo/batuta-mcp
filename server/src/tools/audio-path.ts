import fs from "node:fs";
import path from "node:path";
import { ToolError } from "../mcp/index.js";

/**
 * Validation of the file behind `audio_clip_create` (docs/01-protocol.md sections 7.6 and 10.5). Live
 * opens the file, not this server, so the server proves the path first and sends only its OWN
 * validated realpath: inside a configured sample root when any are set (none means anywhere), an allowed extension, a regular file owned by
 * the user with a single hard link, opened without blocking (a FIFO named x.wav is refused), reached
 * through directories that only the user can write, the same file (device and inode, same realpath)
 * before and after reading, within the size cap, with a header that parses (WAV and AIFF).
 */

export const MAX_IMPORT_BYTES = 1024 ** 3;
const MAX_PATH_BYTES = 1024;
const ALLOWED_EXTENSIONS = new Set([".wav", ".aif", ".aiff", ".flac", ".mp3"]);
const MAX_CHUNKS = 128;
const MAX_SAMPLE_RATE = 1_000_000;

export interface SampleFile {
  realPath: string;
  extension: string;
  size: number;
  /** Duration from the WAV/AIFF header; null for formats without a header parser (flac, mp3). */
  durationSeconds: number | null;
}

export interface SampleOptions {
  /** Optional narrowing: when non-empty the file must live under one of them; empty means no root restriction. */
  roots: string[];
  uid?: number;
  /** Expected owner of the file itself (defaults to `uid`); a seam for tests that cannot create files of another user. */
  fileUid?: number;
  /** Expected owner of the directories between the root and the file (defaults to `uid`); a test seam like `fileUid`. */
  dirUid?: number;
  maxBytes?: number;
  /** Test seams for races between the checks. */
  hooks?: { beforeOpen?: () => void; afterOpen?: () => void; afterParse?: () => void };
}

function refuse(reason: string, message: string): ToolError {
  // The messages never repeat the path: it is model-supplied text.
  return new ToolError("invalid_args", message, { reason });
}

function errno(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? "";
}

/** A root must be a real directory (not a symlink) owned by the user without group or other write access. */
function checkRoot(root: string, uid: number): string {
  let info: fs.Stats;
  try {
    info = fs.lstatSync(root);
  } catch {
    throw refuse("sample_root_unsafe", "A configured sample folder does not exist or cannot be read; fix sample_roots in the server configuration.");
  }
  if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o022) !== 0) {
    throw refuse("sample_root_unsafe", "A configured sample folder must be a real directory owned by you without group or other write access; fix it or sample_roots.");
  }
  try {
    return fs.realpathSync(root);
  } catch {
    throw refuse("sample_root_unsafe", "A configured sample folder cannot be resolved.");
  }
}

function readAt(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  const got = fs.readSync(fd, buffer, 0, length, position);
  return buffer.subarray(0, got);
}

const BAD_HEADER = (): ToolError => refuse("bad_header", "The audio file has a damaged or unsupported WAV/AIFF header.");

function parseWav(fd: number, size: number): number {
  const head = readAt(fd, 0, 12);
  if (head.length < 12 || head.toString("latin1", 0, 4) !== "RIFF" || head.toString("latin1", 8, 12) !== "WAVE") throw BAD_HEADER();
  let rate = 0;
  let block = 0;
  let position = 12;
  for (let chunk = 0; chunk < MAX_CHUNKS && position + 8 <= size; chunk += 1) {
    const header = readAt(fd, position, 8);
    if (header.length < 8) break;
    const id = header.toString("latin1", 0, 4);
    const length = header.readUInt32LE(4);
    if (id === "fmt ") {
      const fmt = readAt(fd, position + 8, 16);
      if (length < 16 || fmt.length < 16) throw BAD_HEADER();
      rate = fmt.readUInt32LE(4);
      block = fmt.readUInt16LE(12);
    } else if (id === "data") {
      if (rate <= 0 || rate > MAX_SAMPLE_RATE || block <= 0) throw BAD_HEADER();
      const available = Math.max(0, size - (position + 8));
      return Math.floor(Math.min(length, available) / block) / rate;
    }
    position += 8 + length + (length & 1);
  }
  throw BAD_HEADER();
}

function parseAiff(fd: number, size: number): number {
  const head = readAt(fd, 0, 12);
  const kind = head.toString("latin1", 8, 12);
  if (head.length < 12 || head.toString("latin1", 0, 4) !== "FORM" || (kind !== "AIFF" && kind !== "AIFC")) throw BAD_HEADER();
  let position = 12;
  for (let chunk = 0; chunk < MAX_CHUNKS && position + 8 <= size; chunk += 1) {
    const header = readAt(fd, position, 8);
    if (header.length < 8) break;
    const length = header.readUInt32BE(4);
    if (header.toString("latin1", 0, 4) === "COMM") {
      const comm = readAt(fd, position + 8, 18);
      if (length < 18 || comm.length < 18) throw BAD_HEADER();
      const frames = comm.readUInt32BE(2);
      const exponent = comm.readUInt16BE(8) & 0x7fff;
      const rate = Number(comm.readBigUInt64BE(10)) * 2 ** (exponent - 16383 - 63);
      if (!Number.isFinite(rate) || rate <= 0 || rate > MAX_SAMPLE_RATE) throw BAD_HEADER();
      return frames / rate;
    }
    position += 8 + length + (length & 1);
  }
  throw BAD_HEADER();
}

function under(file: string, roots: string[]): boolean {
  if (roots.length === 0) return true;
  return roots.some((root) => file.startsWith(`${root}/`));
}

/** Every directory from the root (exclusive, it was checked on its own) down to the file's folder: owned by the user, no group or other write. */
function checkDirectories(file: string, roots: string[], uid: number): void {
  if (roots.length === 0) return; // the walk starts at a root; without roots the file's own checks (owner, hard links, identity) stand alone
  const root = roots.find((candidate) => file.startsWith(`${candidate}/`));
  if (root === undefined) throw refuse("outside_sample_roots", "The audio file is not inside a configured sample folder (sample_roots).");
  let dir = path.dirname(file);
  while (dir !== root && dir.startsWith(`${root}/`)) {
    let info: fs.Stats;
    try {
      info = fs.lstatSync(dir);
    } catch {
      throw refuse("file_changed", "The audio file changed while it was being checked.");
    }
    if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o022) !== 0) {
      throw refuse("directory_unsafe", "A folder on the way to the audio file is writable by others or not yours; fix its owner or permissions.");
    }
    dir = path.dirname(dir);
  }
}

export function validateSampleFile(filePath: string, options: SampleOptions): SampleFile {
  const uid = options.uid ?? process.getuid?.() ?? -1;
  const maxBytes = options.maxBytes ?? MAX_IMPORT_BYTES;
  if (typeof filePath !== "string" || filePath.includes("\u0000") || Buffer.byteLength(filePath, "utf8") > MAX_PATH_BYTES) {
    throw refuse("bad_path", "file_path must be a plain path of at most 1024 bytes.");
  }
  if (!path.isAbsolute(filePath)) throw refuse("not_absolute", "file_path must be an absolute path.");
  const roots = options.roots.map((root) => checkRoot(root, uid));

  let real: string;
  try {
    real = fs.realpathSync(filePath);
  } catch (error) {
    if (errno(error) === "ENOENT" || errno(error) === "ENOTDIR") throw refuse("file_not_found", "The audio file does not exist.");
    throw refuse("bad_path", "The audio file path cannot be resolved.");
  }
  if (!under(real, roots)) {
    throw refuse("outside_sample_roots", "The audio file is not inside a configured sample folder (sample_roots).");
  }
  const extension = path.extname(real).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) throw refuse("bad_extension", "Only .wav, .aif, .aiff, .flac and .mp3 files can be imported.");

  // Look before opening: opening a FIFO for reading would wait for a writer. The O_NONBLOCK open below covers a swap after this look.
  let named: fs.Stats;
  try {
    named = fs.lstatSync(real);
  } catch {
    throw refuse("file_not_found", "The audio file does not exist.");
  }
  if (!named.isFile()) throw refuse("not_regular_file", "The audio path is not a regular file.");

  let fd: number;
  options.hooks?.beforeOpen?.();
  try {
    fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (error) {
    throw refuse(errno(error) === "ENOENT" ? "file_not_found" : "not_regular_file", "The audio file cannot be opened.");
  }
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) throw refuse("not_regular_file", "The audio path is not a regular file.");
    if (opened.uid !== (options.fileUid ?? uid)) throw refuse("not_owned", "The audio file is not owned by you.");
    if (opened.nlink !== 1) throw refuse("hard_linked", "The audio file has more than one hard link, so it may also live somewhere else.");
    if (opened.size === 0) throw refuse("empty_file", "The audio file is empty.");
    if (opened.size > maxBytes) throw refuse("file_too_large", "The audio file is larger than the import limit.");
    options.hooks?.afterOpen?.();
    /** The path must still lead to this very file, through the same directories, all of them safe. */
    const verify = (): void => {
      let again: string;
      try {
        again = fs.realpathSync(real);
      } catch {
        throw refuse("file_changed", "The audio file changed while it was being checked.");
      }
      if (again !== real || !under(again, roots)) throw refuse("file_changed", "The audio file changed while it was being checked.");
      checkDirectories(real, roots, options.dirUid ?? uid);
      const now = fs.lstatSync(real);
      if (!now.isFile() || now.dev !== opened.dev || now.ino !== opened.ino) throw refuse("file_changed", "The audio file changed while it was being checked.");
    };
    verify();
    let durationSeconds: number | null = null;
    if (extension === ".wav") durationSeconds = parseWav(fd, opened.size);
    else if (extension === ".aif" || extension === ".aiff") durationSeconds = parseAiff(fd, opened.size);
    options.hooks?.afterParse?.();
    verify();
    return { realPath: real, extension, size: opened.size, durationSeconds };
  } finally {
    fs.closeSync(fd);
  }
}
