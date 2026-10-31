import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JsonParseError, parseStrictJson } from "../util/strictjson.js";
import { defaultRuntimeDir } from "../live/runtime-files.js";

/**
 * Server configuration (docs/01-protocol.md Appendix B): an optional JSON file plus environment
 * overrides. Unknown keys are rejected, and the file is subject to the same strict ownership and
 * permission checks as the token (regular file, owner = current user, no group/other access).
 */

export type EditionSetting = "auto" | "lite" | "standard" | "suite";
export type DestructiveMode = "confirm" | "disabled";
/** When the user is asked (docs/01-protocol.md section 9.1a): only for what Live's undo cannot reverse and gain trips, or for every destructive class. */
export type ConfirmMode = "irreversible" | "destructive";

/** Which Live application host automation targets (docs/04-host-automation.md section 3). */
export type LiveAppSetting = "auto" | "suite" | "standard" | "lite" | "intro" | "trial" | "beta";

/** Host automation (docs/04-host-automation.md section 2). */
export interface HostConfig {
  enabled: boolean;
  liveApp: LiveAppSetting;
  /** Directories where sets may be opened or written; empty means ~/Music/Ableton and ~/Documents/PRODUCTION. */
  setRoots: string[];
}

export interface ServerConfig {
  edition: EditionSetting;
  destructive: DestructiveMode;
  confirm: ConfirmMode;
  gainGuard: { maxJumpDb: number; maxMasterDb: number };
  browser: { allowPlugins: boolean; allowUserPresets: boolean; allowMaxForLive: boolean; allowExternalDevices: boolean };
  sampleRoots: string[];
  /** `audio_clip_create` needs no configuration: always true (`allow_audio_import` in hello); `sample_roots` only narrows it. */
  allowAudioImport: boolean;
  ears: { enabled: boolean; maxBytes: number; maxBeats: number; roots: string[]; setRoots: string[] };
  host: HostConfig;
  /** Session ownership of Live's single client slot. */
  live: { idleReleaseS: number };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_ROOTS = 16;
const MAX_ROOT_CHARS = 1024;
const GIB = 1024 ** 3;
const EDITIONS: readonly EditionSetting[] = ["auto", "lite", "standard", "suite"];
const DESTRUCTIVE: readonly DestructiveMode[] = ["confirm", "disabled"];
const CONFIRM: readonly ConfirmMode[] = ["irreversible", "destructive"];
const LIVE_APPS: readonly LiveAppSetting[] = ["auto", "suite", "standard", "lite", "intro", "trial", "beta"];

export function defaultConfig(): ServerConfig {
  return {
    edition: "auto",
    destructive: "confirm",
    confirm: "irreversible",
    gainGuard: { maxJumpDb: 6.0, maxMasterDb: 0.0 },
    browser: { allowPlugins: true, allowUserPresets: true, allowMaxForLive: true, allowExternalDevices: true },
    sampleRoots: [],
    allowAudioImport: true,
    ears: { enabled: true, maxBytes: 256 * 1024 * 1024, maxBeats: 64, roots: [], setRoots: [] },
    host: { enabled: true, liveApp: "auto", setRoots: [] },
    live: { idleReleaseS: 120 },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknown(section: Record<string, unknown>, allowed: readonly string[], prefix: string): void {
  for (const key of Object.keys(section)) {
    if (!allowed.includes(key)) throw new ConfigError(`unknown key "${prefix}${key}"`);
  }
}

function section(value: unknown, name: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new ConfigError(`${name} must be an object`);
  return value;
}

function oneOf<T extends string>(value: unknown, name: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ConfigError(`${name} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function bool(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new ConfigError(`${name} must be true or false`);
  return value;
}

function numberInRange(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be a number between ${min} and ${max}`);
  }
  return value;
}

function integerInRange(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function roots(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_ROOTS) throw new ConfigError(`${name} must be an array of at most ${MAX_ROOTS} absolute paths`);
  return value.map((entry, index) => {
    const label = `${name}[${index}]`;
    if (typeof entry !== "string" || entry.length === 0 || entry.length > MAX_ROOT_CHARS) throw new ConfigError(`${label} must be a non-empty path string`);
    if (/[\u0000-\u001f\u007f-\u009f]/.test(entry)) throw new ConfigError(`${label} must not contain control characters`);
    if (!path.isAbsolute(entry)) throw new ConfigError(`${label} must be an absolute path`);
    if (entry.split("/").includes("..")) throw new ConfigError(`${label} must not contain .. segments`);
    const normalized = path.normalize(entry).replace(/\/+$/, "") || "/";
    if (normalized === "/") throw new ConfigError(`${label} must not be the filesystem root`);
    return normalized;
  });
}

/** Validate a parsed config document and fill defaults. */
export function parseConfig(raw: unknown): ServerConfig {
  if (!isPlainObject(raw)) throw new ConfigError("config must be a JSON object");
  rejectUnknown(raw, ["edition", "destructive", "confirm", "gain_guard", "browser", "sample_roots", "ears", "host", "live"], "");
  const config = defaultConfig();
  if (raw["edition"] !== undefined) config.edition = oneOf(raw["edition"], "edition", EDITIONS);
  if (raw["destructive"] !== undefined) config.destructive = oneOf(raw["destructive"], "destructive", DESTRUCTIVE);
  if (raw["confirm"] !== undefined) config.confirm = oneOf(raw["confirm"], "confirm", CONFIRM);
  if (raw["gain_guard"] !== undefined) {
    const guard = section(raw["gain_guard"], "gain_guard");
    rejectUnknown(guard, ["max_jump_db", "max_master_db"], "gain_guard.");
    if (guard["max_jump_db"] !== undefined) config.gainGuard.maxJumpDb = numberInRange(guard["max_jump_db"], "gain_guard.max_jump_db", 0, 60);
    if (guard["max_master_db"] !== undefined) config.gainGuard.maxMasterDb = numberInRange(guard["max_master_db"], "gain_guard.max_master_db", -70, 6);
  }
  if (raw["browser"] !== undefined) {
    const browser = section(raw["browser"], "browser");
    rejectUnknown(browser, ["allow_plugins", "allow_user_presets", "allow_max_for_live", "allow_external_devices"], "browser.");
    if (browser["allow_plugins"] !== undefined) config.browser.allowPlugins = bool(browser["allow_plugins"], "browser.allow_plugins");
    if (browser["allow_user_presets"] !== undefined) config.browser.allowUserPresets = bool(browser["allow_user_presets"], "browser.allow_user_presets");
    if (browser["allow_max_for_live"] !== undefined) config.browser.allowMaxForLive = bool(browser["allow_max_for_live"], "browser.allow_max_for_live");
    if (browser["allow_external_devices"] !== undefined) config.browser.allowExternalDevices = bool(browser["allow_external_devices"], "browser.allow_external_devices");
  }
  if (raw["sample_roots"] !== undefined) config.sampleRoots = roots(raw["sample_roots"], "sample_roots");
  if (raw["ears"] !== undefined) {
    const ears = section(raw["ears"], "ears");
    rejectUnknown(ears, ["enabled", "max_bytes", "max_beats", "roots", "set_roots"], "ears.");
    if (ears["enabled"] !== undefined) config.ears.enabled = bool(ears["enabled"], "ears.enabled");
    if (ears["max_bytes"] !== undefined) config.ears.maxBytes = integerInRange(ears["max_bytes"], "ears.max_bytes", 1, GIB);
    if (ears["max_beats"] !== undefined) config.ears.maxBeats = integerInRange(ears["max_beats"], "ears.max_beats", 1, 64);
    if (ears["roots"] !== undefined) config.ears.roots = roots(ears["roots"], "ears.roots");
    if (ears["set_roots"] !== undefined) config.ears.setRoots = roots(ears["set_roots"], "ears.set_roots");
  }
  if (raw["host"] !== undefined) {
    const host = section(raw["host"], "host");
    rejectUnknown(host, ["enabled", "live_app", "set_roots"], "host.");
    if (host["enabled"] !== undefined) config.host.enabled = bool(host["enabled"], "host.enabled");
    if (host["live_app"] !== undefined) config.host.liveApp = oneOf(host["live_app"], "host.live_app", LIVE_APPS);
    if (host["set_roots"] !== undefined) config.host.setRoots = roots(host["set_roots"], "host.set_roots");
  }
  if (raw["live"] !== undefined) {
    const live = section(raw["live"], "live");
    rejectUnknown(live, ["idle_release_s"], "live.");
    if (live["idle_release_s"] !== undefined) config.live.idleReleaseS = integerInRange(live["idle_release_s"], "live.idle_release_s", 0, 86_400);
  }
  return config;
}

export interface LoadConfigOptions {
  /** Explicit config file path (takes precedence over BATUTA_CONFIG and the default location). */
  configPath?: string;
  env: Partial<Record<string, string>>;
  /** Home directory used for the default path. Defaults to `os.homedir()`. */
  home?: string;
  expectedUid?: number;
}

export interface LoadedConfig {
  config: ServerConfig;
  /** The file the settings came from, or "defaults" when no file exists. */
  source: string;
  /** The path that was looked at. */
  path: string;
}

function readConfigFile(file: string, expectedUid: number, mustExist: boolean): unknown | undefined {
  let info: fs.Stats;
  try {
    info = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (mustExist) throw new ConfigError(`config file ${file} does not exist`);
      return undefined;
    }
    throw new ConfigError(`cannot stat config file ${file}: ${(error as NodeJS.ErrnoException).code ?? "error"}`);
  }
  if (info.isSymbolicLink()) throw new ConfigError(`config file ${file} must be a regular file, not a symlink`);
  if (!info.isFile()) throw new ConfigError(`config file ${file} must be a regular file`);
  if (info.uid !== expectedUid) throw new ConfigError(`config file ${file} is not owned by the current user`);
  if ((info.mode & 0o077) !== 0) throw new ConfigError(`config file ${file} must be mode 0600 (no access for group or others)`);
  const parent = fs.statSync(path.dirname(file));
  if ((parent.mode & 0o022) !== 0) throw new ConfigError(`the directory of config file ${file} must not be writable by group or others`);
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    throw new ConfigError(`cannot open config file ${file}: ${(error as NodeJS.ErrnoException).code ?? "error"}`);
  }
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== info.dev || opened.ino !== info.ino || !opened.isFile()) throw new ConfigError(`config file ${file} changed while being read`);
    if (opened.size > MAX_CONFIG_BYTES) throw new ConfigError(`config file ${file} is too large (limit ${MAX_CONFIG_BYTES} bytes)`);
    const data = Buffer.alloc(opened.size);
    fs.readSync(fd, data, 0, data.length, 0);
    try {
      return parseStrictJson(data);
    } catch (error) {
      throw new ConfigError(`config file ${file} is not valid JSON: ${(error as JsonParseError).message}`);
    }
  } finally {
    fs.closeSync(fd);
  }
}

const DECIMAL = /^-?\d+(\.\d+)?$/;

function envNumber(text: string | undefined, name: string, min: number, max: number): number | undefined {
  if (text === undefined) return undefined;
  if (!DECIMAL.test(text)) throw new ConfigError(`${name} must be a decimal number`);
  return numberInRange(Number(text), name, min, max);
}

function applyEnv(config: ServerConfig, env: Partial<Record<string, string>>): void {
  if (env["BATUTA_EDITION"] !== undefined) config.edition = oneOf(env["BATUTA_EDITION"], "BATUTA_EDITION", EDITIONS);
  if (env["BATUTA_DESTRUCTIVE"] !== undefined) config.destructive = oneOf(env["BATUTA_DESTRUCTIVE"], "BATUTA_DESTRUCTIVE", DESTRUCTIVE);
  if (env["BATUTA_CONFIRM"] !== undefined) config.confirm = oneOf(env["BATUTA_CONFIRM"], "BATUTA_CONFIRM", CONFIRM);
  const jump = envNumber(env["BATUTA_MAX_JUMP_DB"], "BATUTA_MAX_JUMP_DB", 0, 60);
  if (jump !== undefined) config.gainGuard.maxJumpDb = jump;
  const master = envNumber(env["BATUTA_MAX_MASTER_DB"], "BATUTA_MAX_MASTER_DB", -70, 6);
  if (master !== undefined) config.gainGuard.maxMasterDb = master;
}

export function loadConfig(options: LoadConfigOptions): LoadedConfig {
  const env = options.env;
  let file = options.configPath ?? env["BATUTA_CONFIG"];
  const explicit = file !== undefined;
  if (file !== undefined && !path.isAbsolute(file)) throw new ConfigError("the config path must be absolute");
  file ??= path.join(defaultRuntimeDir(options.home ?? env["HOME"] ?? os.homedir()), "server.json");
  const uid = options.expectedUid ?? process.getuid?.() ?? -1;
  const raw = readConfigFile(file, uid, explicit);
  const config = raw === undefined ? defaultConfig() : parseConfig(raw);
  applyEnv(config, env);
  return { config, source: raw === undefined ? "defaults" : file, path: file };
}
