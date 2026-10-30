import fs from "node:fs";
import path from "node:path";
import { ToolError } from "../mcp/index.js";
import { isUnsafeCode } from "../tools/util.js";

/**
 * Path rules for `open_set` and `save_set_as` (docs/04-host-automation.md section 5). The set file
 * itself is never opened: only stat calls are made. Every failure names its rule in `details.reason`.
 */

const MAX_BYTES = 1024;
/** C0 and C1 controls, line/paragraph separators and bidi overrides/isolates/marks. NUL is reported on its own. */
export const isControlCode = isUnsafeCode;

function hasControl(text: string): boolean {
  for (const char of text) if (isControlCode(char.codePointAt(0) ?? 0)) return true;
  return false;
}

export interface SetPathContext {
  /** Optional narrowing: when non-empty the set must live under one of these (absolute); empty means no folder restriction. */
  roots: readonly string[];
  /** The user the parent directory must belong to. */
  uid: number;
}

export interface CheckedSetPath {
  path: string;
  /** realpath of the parent directory plus the file name: what Live is given. */
  real: string;
  /** realpath of the parent directory. */
  parent: string;
  /** The file exists (and is a regular file). In a planned save (HostService.checkPath) also true when the project-folder candidate exists. */
  exists: boolean;
  /** Save only: the second place Live may write, `<folder>/<name> Project/<name>.als` (T9n). */
  project?: ProjectCandidate;
  /** Save only: the file the panel is driven to. The project file when only `<name> Project/<name>.als` exists (T9o), else the given path. */
  target?: SaveTarget;
}

export interface SaveTarget {
  /** Given spelling. */
  path: string;
  /** realpath of the parent directory plus the file name (and the project folder when `project`). */
  real: string;
  /** The panel goes into `<name> Project` itself, where Live shows its replace sheet. */
  project: boolean;
}

export interface ProjectCandidate {
  /** Given spelling (parent as the model wrote it). */
  path: string;
  /** realpath of the parent directory plus the project folder and file name. */
  real: string;
  /** realpath of the parent directory plus the project folder name. */
  folder: string;
  /** That file exists now (a regular file in a real folder). */
  exists: boolean;
}

/** The project-folder name Live derives from a set file name: `a.als` -> `a Project`. */
export function projectFolderName(baseName: string): string {
  return `${path.basename(baseName, path.extname(baseName))} Project`;
}

function invalid(reason: string, message: string): ToolError {
  return new ToolError("invalid_args", message, { reason });
}

function inside(child: string, root: string): boolean {
  return child === root || child.startsWith(root.endsWith("/") ? root : `${root}/`);
}

function realpathOrUndefined(target: string): string | undefined {
  try {
    return fs.realpathSync(target);
  } catch {
    return undefined;
  }
}

/** Last `keep` characters of a long path behind "...", so a summary always ends with the file name. */
export function shortenPath(value: string, keep: number): string {
  const chars = [...value];
  return chars.length <= keep ? value : `...${chars.slice(chars.length - keep).join("")}`;
}

export function checkSetPath(raw: unknown, mode: "open" | "save", context: SetPathContext): CheckedSetPath {
  if (typeof raw !== "string") throw invalid("not_a_string", "path must be a string.");
  if (raw.length === 0) throw invalid("empty", "path must not be empty.");
  if (raw.includes("\u0000")) throw invalid("nul_byte", "path must not contain a NUL byte.");
  if (hasControl(raw)) throw invalid("control_character", "path must not contain control or direction-override characters.");
  if (Buffer.byteLength(raw, "utf8") > MAX_BYTES) throw invalid("too_long", `path must be at most ${MAX_BYTES} bytes.`);
  if (!path.isAbsolute(raw)) throw invalid("not_absolute", "path must be absolute (it starts with /).");
  if (path.normalize(raw) !== raw || raw.endsWith("/")) throw invalid("not_normalized", "path must be normalized: no . or .. segments, no doubled or trailing slash.");
  if (raw.normalize("NFC") !== raw) throw invalid("not_nfc", "path must be in Unicode normalization form NFC.");
  if (path.extname(path.basename(raw)).toLowerCase() !== ".als") throw invalid("wrong_extension", "path must end in .als.");

  const parent = path.dirname(raw);
  const roots = context.roots.map((root) => ({ lexical: root, real: realpathOrUndefined(root) }));
  if (roots.length > 0 && !roots.some((root) => inside(parent, root.lexical) || (root.real !== undefined && inside(parent, root.real)))) {
    throw invalid("outside_roots", "The set must be inside one of the configured host.set_roots.");
  }
  let realParent: string;
  try {
    realParent = fs.realpathSync(parent);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new ToolError("not_found", "The folder that should hold the set does not exist.", { what: "parent_directory" });
    if (code === "ENOTDIR" || code === "ELOOP") throw invalid("not_a_directory", "The parent of the set is not a directory.");
    throw new ToolError("host_failed", "The folder of the set could not be inspected.", { reason: "stat_failed", errno: code ?? "unknown" });
  }
  if (roots.length > 0 && !roots.some((root) => root.real !== undefined && inside(realParent, root.real))) {
    throw invalid("outside_roots", "The folder resolves (through a symlink) outside the configured host.set_roots.");
  }
  const parentInfo = fs.statSync(realParent);
  if (!parentInfo.isDirectory()) throw invalid("not_a_directory", "The parent of the set is not a directory.");
  // With no roots there is no folder to walk down from; what stays is this: a save is never written through a symlinked
  // folder (realpath(parent) must equal parent), and an open hands Live the real path (realParent + file name), never the spelling.
  if (mode === "save" && realParent !== parent) throw invalid("symlinked_parent", "A set is never written through a symlinked folder; give the real folder path.");
  if (parentInfo.uid !== context.uid) throw invalid("not_owned", "The folder of the set is not owned by the current user.");

  let exists = false;
  try {
    const info = fs.lstatSync(raw);
    if (info.isSymbolicLink()) throw invalid("symlink_target", "The set path is a symlink; give the real file.");
    if (!info.isFile()) throw invalid("not_a_file", "The set path exists but is not a regular file.");
    if (mode === "save" && info.nlink > 1) throw invalid("hardlinked_file", "The existing file has other hard links, so replacing it would change those too; choose another name.");
    exists = true;
  } catch (error) {
    if (error instanceof ToolError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ToolError("host_failed", "The set file could not be inspected.", { reason: "stat_failed", errno: (error as NodeJS.ErrnoException).code ?? "unknown" });
  }
  if (mode === "open" && !exists) throw new ToolError("not_found", "The set file does not exist.", { what: "set_file" });
  return { path: raw, real: path.join(realParent, path.basename(raw)), parent: realParent, exists };
}

/**
 * Live 12 writes `<folder>/<name> Project/<name>.als` when the chosen folder is not inside a Live project
 * (and probably `<folder>/<name>.als` inside one), so a save has two candidate files (T9n). This looks at the
 * project candidate: a symlinked project folder or file, a non-regular file or a hard-linked file is refused
 * like the direct target is; absent is fine.
 */
export function checkProjectCandidate(checked: CheckedSetPath): ProjectCandidate {
  const name = path.basename(checked.real);
  const folderName = projectFolderName(name);
  const folder = path.join(checked.parent, folderName);
  const real = path.join(folder, name);
  const candidate: ProjectCandidate = { path: path.join(path.dirname(checked.path), folderName, name), real, folder, exists: false };
  let folderInfo: fs.Stats;
  try {
    folderInfo = fs.lstatSync(folder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return candidate;
    throw new ToolError("host_failed", "The project folder of the set could not be inspected.", { reason: "stat_failed", errno: (error as NodeJS.ErrnoException).code ?? "unknown" });
  }
  if (folderInfo.isSymbolicLink()) throw invalid("symlink_target", `The folder "${folderName}" next to the set is a symlink; Live may write the set inside it. Remove it or choose another name.`);
  if (!folderInfo.isDirectory()) return candidate;
  try {
    const info = fs.lstatSync(real);
    if (info.isSymbolicLink()) throw invalid("symlink_target", "The set path inside its project folder is a symlink; give another name.");
    if (!info.isFile()) throw invalid("not_a_file", "The set path inside its project folder exists but is not a regular file.");
    if (info.nlink > 1) throw invalid("hardlinked_file", "The existing file has other hard links, so replacing it would change those too; choose another name.");
    candidate.exists = true;
  } catch (error) {
    if (error instanceof ToolError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ToolError("host_failed", "The set file could not be inspected.", { reason: "stat_failed", errno: (error as NodeJS.ErrnoException).code ?? "unknown" });
  }
  return candidate;
}
