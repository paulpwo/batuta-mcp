import fs from "node:fs";
import path from "node:path";
import { ToolError } from "../mcp/index.js";
import { isUnsafeCode } from "../tools/util.js";

/**
 * Validation of an audio file before anything is read (docs/01-protocol.md 10.5), for the file Live
 * recorded (`clip.file_path`) and for the files `analyze_audio` is asked about. The checks:
 * a plain absolute path (no NUL, controls, invisible or direction characters, at most 1024 bytes), a WAV or
 * AIFF extension, inside an allowed folder both as written and after realpath (Live's recording folder, a
 * configured folder, or a Samples/Recorded folder under the home or under a configured set root; with
 * `anyFolder` there is no folder restriction), not a
 * symlink, a regular file that is ours with exactly one hard link, within the size cap, the same file
 * (device and inode) every time we look, and a header that parses. Reading uses the one descriptor
 * opened here. Messages never repeat the path: it is not our text.
 */

const MAX_PATH_BYTES = 1024;
const ALLOWED_EXTENSIONS = new Set([".wav", ".aif", ".aiff"]);
const MAX_CHUNKS = 128;
const MIN_RATE = 8000;
const MAX_RATE = 384000;
const MAX_DURATION_S = 300;
/** Decoded audio is held as 64-bit floats per channel; refuse what could not be decoded within this. */
export const MAX_DECODED_BYTES = 384 * 1024 * 1024;
const HEADER_FLOOR = 44;

export interface AudioLayout {
  format: "wav" | "aiff";
  channels: number;
  sampleRate: number;
  bits: number;
  float: boolean;
  frames: number;
  durationS: number;
  /** First byte after the audio data the header declares. */
  endOffset: number;
  decodedBytes: number;
}

export interface AudioFileOptions {
  home: string;
  /** Folders where any matching file is accepted (Live's recording folder, `ears.roots`, sample roots). */
  roots: string[];
  /** Folders under which a `Samples/Recorded` folder is accepted (`ears.set_roots`); the home always is. */
  setRoots: string[];
  maxBytes: number;
  uid?: number;
  /**
   * No folder restriction: any absolute path may be opened (`analyze_audio` and `compare_audio` when no
   * `sample_roots` or `ears.roots` are configured). Every other check below still applies.
   */
  anyFolder?: boolean;
  /** Do not parse the header at open: the file may still be written (the ears job waits for it). */
  deferHeader?: boolean;
  /** Test seam for races between the checks. */
  hooks?: { afterOpen?: () => void };
}

/** Live's default folder for recordings of sets that were never saved [A]. */
export function liveRecordingRoots(home: string): string[] {
  return [path.join(home, "Library", "Application Support", "Ableton", "Live Recordings")];
}

function refuse(reason: string, message: string, code: "invalid_args" | "too_large" = "invalid_args"): ToolError {
  return new ToolError(code, message, { reason });
}

const errno = (error: unknown): string => (error as NodeJS.ErrnoException).code ?? "";
const nfc = (text: string): string => text.normalize("NFC");

function inside(file: string, root: string): boolean {
  return nfc(file).startsWith(`${nfc(root)}/`);
}

function realOrSelf(dir: string): string | undefined {
  try {
    return fs.realpathSync(dir);
  } catch {
    return undefined;
  }
}

/** Is this (real, absolute) file in one of the allowed places? */
function allowed(file: string, realRoots: string[], realSetRoots: string[], home: string): boolean {
  if (realRoots.some((root) => inside(file, root))) return true;
  const folder = path.dirname(file);
  if (path.basename(folder) !== "Recorded" || path.basename(path.dirname(folder)) !== "Samples") return false;
  return [home, ...realSetRoots].some((root) => inside(folder, root));
}

// ------------------------------------------------------------------ header parsing

function readAt(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  const got = fs.readSync(fd, buffer, 0, length, position);
  return buffer.subarray(0, got);
}

const BAD_HEADER = (): ToolError => refuse("bad_header", "The audio file has a damaged or unsupported WAV/AIFF header.");
const BAD_FORMAT = (message: string): ToolError => refuse("bad_format", message);

function checkFormat(channels: number, rate: number, bits: number, float: boolean): void {
  if (channels < 1 || channels > 2) throw BAD_FORMAT("Only mono and stereo files can be analyzed.");
  if (!Number.isInteger(rate) || rate < MIN_RATE || rate > MAX_RATE) throw BAD_FORMAT("The sample rate must be between 8000 and 384000 Hz.");
  if (float ? bits !== 32 && bits !== 64 : bits !== 16 && bits !== 24 && bits !== 32) throw BAD_FORMAT("The bit depth must be 16, 24 or 32 (integer) or 32 or 64 (float).");
}

function finish(format: "wav" | "aiff", channels: number, rate: number, bits: number, float: boolean, frames: number, endOffset: number): AudioLayout {
  checkFormat(channels, rate, bits, float);
  if (frames <= 0) throw BAD_HEADER();
  const durationS = frames / rate;
  if (durationS > MAX_DURATION_S) throw refuse("too_long", "The recording is longer than 300 seconds.");
  const decodedBytes = frames * channels * 8;
  if (decodedBytes > MAX_DECODED_BYTES) throw refuse("decoded_too_large", "The recording is too large to analyze in memory.", "too_large");
  return { format, channels, sampleRate: rate, bits, float, frames, durationS, endOffset, decodedBytes };
}

const GUID_TAIL = [0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];

function parseWav(fd: number, size: number): AudioLayout {
  const head = readAt(fd, 0, 12);
  if (head.length < 12 || head.toString("latin1", 0, 4) !== "RIFF" || head.toString("latin1", 8, 12) !== "WAVE") throw BAD_HEADER();
  let fmt: { code: number; channels: number; rate: number; block: number; bits: number } | undefined;
  let position = 12;
  for (let chunk = 0; chunk < MAX_CHUNKS && position + 8 <= size; chunk += 1) {
    const header = readAt(fd, position, 8);
    if (header.length < 8) break;
    const id = header.toString("latin1", 0, 4);
    const length = header.readUInt32LE(4);
    if (id === "fmt ") {
      if (length < 16) throw BAD_HEADER();
      const body = readAt(fd, position + 8, Math.min(length, 40));
      if (body.length < 16) throw BAD_HEADER();
      let code = body.readUInt16LE(0);
      if (code === 0xfffe) {
        if (body.length < 40) throw BAD_HEADER();
        code = body.readUInt16LE(24);
        for (const [i, expected] of GUID_TAIL.entries()) if (body.readUInt8(26 + i) !== expected) throw BAD_FORMAT("Only plain PCM or float WAV files can be analyzed.");
      }
      fmt = { code, channels: body.readUInt16LE(2), rate: body.readUInt32LE(4), block: body.readUInt16LE(12), bits: body.readUInt16LE(14) };
    } else if (id === "data") {
      if (fmt === undefined) throw BAD_HEADER();
      if (fmt.code !== 1 && fmt.code !== 3) throw BAD_FORMAT("Only plain PCM or float WAV files can be analyzed.");
      checkFormat(fmt.channels, fmt.rate, fmt.bits, fmt.code === 3);
      if (fmt.block !== fmt.channels * (fmt.bits / 8)) throw BAD_HEADER();
      const dataStart = position + 8;
      return finish("wav", fmt.channels, fmt.rate, fmt.bits, fmt.code === 3, Math.floor(length / fmt.block), dataStart + Math.floor(length / fmt.block) * fmt.block);
    }
    position += 8 + length + (length & 1);
  }
  throw BAD_HEADER();
}

function extended(buffer: Buffer): number {
  const exponent = buffer.readUInt16BE(0) & 0x7fff;
  const mantissa = Number(buffer.readBigUInt64BE(2));
  if (exponent === 0 || exponent === 0x7fff) return Number.NaN;
  return mantissa * 2 ** (exponent - 16383 - 63);
}

function parseAiff(fd: number, size: number): AudioLayout {
  const head = readAt(fd, 0, 12);
  const kind = head.toString("latin1", 8, 12);
  if (head.length < 12 || head.toString("latin1", 0, 4) !== "FORM" || (kind !== "AIFF" && kind !== "AIFC")) throw BAD_HEADER();
  let comm: { channels: number; frames: number; bits: number; rate: number; float: boolean } | undefined;
  let position = 12;
  for (let chunk = 0; chunk < MAX_CHUNKS && position + 8 <= size; chunk += 1) {
    const header = readAt(fd, position, 8);
    if (header.length < 8) break;
    const id = header.toString("latin1", 0, 4);
    const length = header.readUInt32BE(4);
    if (id === "COMM") {
      const body = readAt(fd, position + 8, Math.min(length, 26));
      if (length < (kind === "AIFC" ? 22 : 18) || body.length < (kind === "AIFC" ? 22 : 18)) throw BAD_HEADER();
      const rate = extended(body.subarray(8, 18));
      if (!Number.isFinite(rate) || Math.abs(rate - Math.round(rate)) > 1e-6) throw BAD_FORMAT("The sample rate must be between 8000 and 384000 Hz.");
      let float = false;
      if (kind === "AIFC") {
        const compression = body.toString("latin1", 18, 22);
        if (compression === "fl32" || compression === "FL32" || compression === "fl64" || compression === "FL64") float = true;
        else if (compression !== "NONE" && compression !== "twos" && compression !== "sowt") throw BAD_FORMAT("Only uncompressed AIFF files can be analyzed.");
      }
      comm = { channels: body.readInt16BE(0), frames: body.readUInt32BE(2), bits: body.readInt16BE(6), rate: Math.round(rate), float };
    } else if (id === "SSND") {
      if (comm === undefined || length < 8) throw BAD_HEADER();
      checkFormat(comm.channels, comm.rate, comm.bits, comm.float);
      const offset = readAt(fd, position + 8, 4).readUInt32BE(0);
      const dataStart = position + 16 + offset;
      return finish("aiff", comm.channels, comm.rate, comm.bits, comm.float, comm.frames, dataStart + comm.frames * comm.channels * (comm.bits / 8));
    }
    position += 8 + length + (length & 1);
  }
  throw BAD_HEADER();
}

// ------------------------------------------------------------------ the open file

export class EarsFile {
  layout: AudioLayout | undefined = undefined;
  private closed = false;

  constructor(
    readonly realPath: string,
    private readonly fd: number,
    private readonly dev: number,
    private readonly ino: number,
    private readonly maxBytes: number,
    private readonly extension: string,
  ) {}

  /** Current size of the open file; the path must still lead to this very file. */
  sizeNow(): number {
    const info = fs.fstatSync(this.fd);
    let named: fs.Stats;
    try {
      named = fs.lstatSync(this.realPath);
    } catch {
      throw refuse("file_changed", "The audio file changed while it was being checked.");
    }
    if (!named.isFile() || named.dev !== this.dev || named.ino !== this.ino || info.ino !== this.ino) throw refuse("file_changed", "The audio file changed while it was being checked.");
    if (info.size > this.maxBytes) throw refuse("file_too_large", "The audio file is larger than the allowed size.");
    return info.size;
  }

  /** Parse the header from the descriptor (again). Throws the typed refusal when it is not (yet) a valid header. */
  refreshLayout(): AudioLayout {
    const size = this.sizeNow();
    if (size <= HEADER_FLOOR) throw refuse("too_small", "The audio file is too small to hold audio.");
    this.layout = this.extension === ".wav" ? parseWav(this.fd, size) : parseAiff(this.fd, size);
    return this.layout;
  }

  /** The file is at least as long as its header says. */
  isComplete(): boolean {
    if (this.layout === undefined) {
      try {
        this.refreshLayout();
      } catch (error) {
        if (error instanceof ToolError && ["bad_header", "too_small"].includes(String(error.details?.["reason"]))) return false;
        throw error;
      }
    }
    return this.layout !== undefined && this.sizeNow() >= this.layout.endOffset;
  }

  /** All the bytes, read through the descriptor, after the same-file and completeness checks (again after reading). */
  readAll(): Buffer {
    if (!this.isComplete() || this.layout === undefined) throw refuse("truncated", "The audio file is shorter than its header says.");
    const size = this.sizeNow();
    const buffer = Buffer.alloc(size);
    let done = 0;
    while (done < size) {
      const got = fs.readSync(this.fd, buffer, done, size - done, done);
      if (got <= 0) throw refuse("file_changed", "The audio file changed while it was being read.");
      done += got;
    }
    if (this.sizeNow() !== size) throw refuse("file_changed", "The audio file changed while it was being read.");
    return buffer;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      fs.closeSync(this.fd);
    } catch {
      // nothing left to do with a descriptor that will not close
    }
  }
}

export function openAudioFile(filePath: string, options: AudioFileOptions): EarsFile {
  const uid = options.uid ?? process.getuid?.() ?? -1;
  if (typeof filePath !== "string" || filePath.length === 0 || filePath.includes("\u0000") || Buffer.byteLength(filePath, "utf8") > MAX_PATH_BYTES || [...filePath].some((char) => isUnsafeCode(char.codePointAt(0) ?? 0))) {
    throw refuse("bad_path", "file_path must be a plain path of at most 1024 bytes without control or invisible characters.");
  }
  if (!path.isAbsolute(filePath)) throw refuse("not_absolute", "The audio file path must be absolute.");
  const extension = path.extname(filePath).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) throw refuse("bad_extension", "Only .wav, .aif and .aiff files can be analyzed.");

  const home = realOrSelf(options.home) ?? options.home;
  const realRoots = options.roots.flatMap((root) => { const real = realOrSelf(root); return real === undefined ? [] : [real]; });
  const realSetRoots = options.setRoots.flatMap((root) => { const real = realOrSelf(root); return real === undefined ? [] : [real]; });
  const isAllowed = (file: string): boolean => options.anyFolder === true || allowed(file, realRoots, realSetRoots, home);

  // First as written: whether a file exists outside the folders is none of the caller's business.
  const lexical = path.normalize(filePath);
  if (!isAllowed(lexical) && !isAllowed(realParentPlus(lexical))) throw refuse("outside_roots", "The audio file is not inside an allowed folder.");

  let named: fs.Stats;
  try {
    named = fs.lstatSync(lexical);
  } catch (error) {
    throw refuse(errno(error) === "ENOENT" || errno(error) === "ENOTDIR" ? "file_not_found" : "bad_path", errno(error) === "ENOENT" || errno(error) === "ENOTDIR" ? "The audio file does not exist." : "The audio file path cannot be read.");
  }
  if (named.isSymbolicLink()) throw refuse("symlink", "The audio file is a symbolic link.");
  if (!named.isFile()) throw refuse("not_regular_file", "The audio path is not a regular file.");

  let real: string;
  try {
    real = fs.realpathSync(lexical);
  } catch {
    throw refuse("file_not_found", "The audio file does not exist.");
  }
  if (!isAllowed(real)) throw refuse("outside_roots", "The audio file is not inside an allowed folder.");
  const realExtension = path.extname(real).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(realExtension)) throw refuse("bad_extension", "Only .wav, .aif and .aiff files can be analyzed.");

  let fd: number;
  try {
    fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (error) {
    throw refuse(errno(error) === "ENOENT" ? "file_not_found" : "not_regular_file", "The audio file cannot be opened.");
  }
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) throw refuse("not_regular_file", "The audio path is not a regular file.");
    if (opened.uid !== uid) throw refuse("not_owned", "The audio file is not owned by you.");
    if (opened.nlink !== 1) throw refuse("hard_linked", "The audio file has more than one hard link, so it may also live somewhere else.");
    if (opened.size > options.maxBytes) throw refuse("file_too_large", "The audio file is larger than the allowed size.");
    if (options.deferHeader !== true && opened.size <= HEADER_FLOOR) throw refuse("too_small", "The audio file is too small to hold audio.");
    options.hooks?.afterOpen?.();
    const file = new EarsFile(real, fd, opened.dev, opened.ino, options.maxBytes, realExtension);
    // The path must still lead to this very file, through the same directories.
    let again: string;
    try {
      again = fs.realpathSync(real);
    } catch {
      throw refuse("file_changed", "The audio file changed while it was being checked.");
    }
    if (again !== real || !isAllowed(again)) throw refuse("file_changed", "The audio file changed while it was being checked.");
    file.sizeNow();
    if (options.deferHeader !== true) {
      const layout = file.refreshLayout();
      if (file.sizeNow() < layout.endOffset) throw refuse("truncated", "The audio file is shorter than its header says.");
    }
    return file;
  } catch (error) {
    try {
      fs.closeSync(fd);
    } catch {
      // already closed
    }
    throw error;
  }
}

/** The folder part resolved through symlinks, with the file name as written: where the path would really lead. */
function realParentPlus(lexical: string): string {
  const parent = realOrSelf(path.dirname(lexical));
  return parent === undefined ? lexical : path.join(parent, path.basename(lexical));
}
