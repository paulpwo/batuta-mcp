import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolError } from "../mcp/index.js";
import type { HostConfig } from "../config/index.js";
import { findInstalledApps, scanInstalledApps } from "./apps.js";
import type { LiveApp, Variant } from "./apps.js";
import { defaultRuntimeDir } from "../live/runtime-files.js";
import { readLastApp, writeLastApp } from "./last-app.js";
import { checkProjectCandidate, checkSetPath, isControlCode } from "./paths.js";
import type { CheckedSetPath } from "./paths.js";
import { OPEN_BINARY, OSASCRIPT_BINARY } from "./runner.js";
import type { HostRunOptions, HostRunResult, HostRunner } from "./runner.js";
import { MENU_SCRIPT, RUNNING_SCRIPT, SAVE_AS_SCRIPT, buildOsascriptArgs } from "./scripts.js";

export type { HostConfig } from "../config/index.js";

/**
 * Host automation (docs/04-host-automation.md): launch Live, open a set, and drive its File menu.
 * Everything that leaves the process goes through the injected {@link HostRunner}.
 */

const PROBE_TIMEOUT_MS = 5_000;
/** The edition probe runs while the client waits for its hello, so it must be short. */
const EDITION_PROBE_TIMEOUT_MS = 2_000;
const OPEN_TIMEOUT_MS = 10_000;
const UI_TIMEOUT_MS = 20_000;
const SAVE_AS_TIMEOUT_MS = 40_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_DETAIL_CHARS = 200;
const MAX_CLOCK_SLACK_MS = 5_000;
/** Live suffixes a clashing project folder with -1, -2, ...; this many are looked for after a failed save. */
const MAX_STRAY_SUFFIX = 20;

export interface HostOptions {
  runner: HostRunner;
  config: HostConfig;
  /** Where the Live bundles are looked for. Default `/Applications`. */
  applicationsDir?: string;
  /** Default `os.homedir()`. */
  home?: string;
  /** Where the last edition is remembered (the Remote Script's runtime directory). Default `<home>/Library/Application Support/BatutaMCP`. */
  runtimeDir?: string;
  /** Default the current user. */
  uid?: number;
  /** Default `os.platform()`; only "darwin" enables the module. */
  platform?: string;
  /** Milliseconds since the epoch; default `Date.now`. */
  now?: () => number;
}

export interface AppInfo {
  name: string;
  variant: Variant;
  path: string;
}

/** Why this edition was chosen: the running one, the tool's `app`, `host.live_app`, the edition of the last connection, or the first installed in the fixed order. */
export type ChosenBy = "running" | "requested" | "config" | "last_used" | "default";
export type LaunchResult = { action: "launched" | "activated"; app: AppInfo; was_running: boolean; chosen_by: ChosenBy };
export type OpenSetResult = { action: "open_requested"; app: AppInfo; path: string; was_running: boolean; chosen_by: ChosenBy; note: string };

export type MenuAction = "new" | "save" | "export";
export type FailureKind = "probe" | "open" | "ui";
export type Accessibility = "unknown" | "granted" | "denied";

interface SaveCandidate {
  /** Spelling shown to the model. */
  path: string;
  real: string;
  /** Expected realpath of the folder that holds the file. */
  folder: string;
  project: boolean;
  before: { ino: number; mtimeMs: number } | undefined;
}

function snapshot(real: string): { ino: number; mtimeMs: number } | undefined {
  try {
    const info = fs.lstatSync(real);
    return { ino: info.ino, mtimeMs: info.mtimeMs };
  } catch {
    return undefined;
  }
}

const appInfo = (app: LiveApp): AppInfo => ({ name: app.name, variant: app.variant, path: app.path });

function permissionError(kind: "accessibility" | "automation"): ToolError {
  const instructions = kind === "accessibility"
    ? "System Settings > Privacy & Security > Accessibility: enable the app that runs your MCP client (for example Terminal, iTerm or Claude), then try again."
    : "System Settings > Privacy & Security > Automation: allow the app that runs your MCP client to control System Events, then try again.";
  return new ToolError("permission_required", `macOS has not allowed this action (${kind} permission is missing). ${instructions}`, { permission: kind, instructions });
}

/** The last stderr line with control characters removed, cut to 200 characters. */
function detailOf(stderr: string): string {
  const lines = stderr.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  const last = [...(lines.at(-1) ?? "")].map((char) => (isControlCode(char.codePointAt(0) ?? 0) ? " " : char)).join("");
  const chars = [...last];
  return chars.length > MAX_DETAIL_CHARS ? `${chars.slice(0, MAX_DETAIL_CHARS).join("")}...` : last;
}

const MAX_LISTED_TITLES = 30;
const MAX_TITLE_CHARS = 80;

/** The `|`-separated titles of one `name=[...]` list in a script error: control-stripped, cut and bounded. */
function titleList(stderr: string, name: string): string[] {
  const match = new RegExp(`${name}=\\[([^\\]]*)\\]`).exec(stderr);
  if (match === null) return [];
  return (match[1] ?? "").split("|")
    .map((title) => [...title].map((char) => (isControlCode(char.codePointAt(0) ?? 0) ? " " : char)).join("").trim())
    .filter((title) => title.length > 0)
    .slice(0, MAX_LISTED_TITLES)
    .map((title) => [...title].slice(0, MAX_TITLE_CHARS).join(""));
}

/** Map a failed run (non-zero exit, timeout, limit, no process) to the tool error the model sees. */
export function classifyFailure(result: HostRunResult, kind: FailureKind): ToolError {
  if (result.failure !== undefined) return new ToolError("host_failed", "The system program could not be started.", { reason: "spawn_failed" });
  if (result.timedOut) return new ToolError("timeout", "The macOS call took too long and was stopped; Live may be showing a dialog. Check Live and retry.", { stage: "host" });
  if (result.truncated) return new ToolError("host_failed", "The macOS call produced more output than allowed and was stopped.", { reason: "output_too_large" });
  const text = result.stderr;
  // By error number only: the wording is localized, the numbers are not. -25211 and -1719: assistive access missing; -1743: Automation not allowed.
  const numbers = [...text.matchAll(/\((-\d+)\)/g)].map((match) => match[1]);
  if (numbers.includes("-25211") || numbers.includes("-1719")) return permissionError("accessibility");
  if (numbers.includes("-1743")) return permissionError("automation");
  const detail = detailOf(text);
  if (text.includes("live_not_running")) return new ToolError("not_supported", "Ableton Live is not running. Call launch_live first.", { reason: "live_not_running" });
  if (text.includes("multiple_live_processes")) return new ToolError("not_supported", "More than one Ableton Live is running; quit one of them.", { reason: "multiple_live_running" });
  if (text.includes("menu_item_disabled")) return new ToolError("not_supported", "Live's menu item is disabled right now (for example Save with nothing to save, or a dialog is open).", { reason: "menu_item_disabled" });
  if (text.includes("menu_item_not_found") || text.includes("menu_not_found")) {
    const lookedFor = titleList(text, "looked_for");
    const found = titleList(text, text.includes("menu_not_found") ? "menu_bar" : "found");
    const what = text.includes("menu_not_found") ? "menu bar items" : "File menu items";
    const seen = lookedFor.length > 0 || found.length > 0 ? ` Looked for: ${lookedFor.join(" | ") || "(menu)"}. ${what} found: ${found.join(" | ") || "(none)"}.` : "";
    return new ToolError("host_failed", `Live's File menu does not have the expected item. English and Spanish titles are known (matched ignoring case, spaces and a trailing ellipsis); this Live version may name them differently.${seen}`, { reason: "menu_item_not_found", detail, looked_for: lookedFor, found });
  }
  if (text.includes("live_not_frontmost")) return new ToolError("host_failed", "Live was not the frontmost app when a key press was needed, so no key was sent; the Save dialog was cancelled and nothing was saved. Bring Live to the front and retry.", { reason: "live_not_frontmost", detail });
  if (text.includes("dialog_not_found") || text.includes("dialog_field_not_found") || text.includes("dialog_button_not_found") || text.includes("goto_sheet_not_found")) {
    return new ToolError("host_failed", "Live's Save dialog did not look as expected; nothing was saved. Check Live.", { reason: "ui_element_not_found", detail });
  }
  if (text.includes("path_not_applied")) {
    const where = titleList(text, "where")[0];
    const name = titleList(text, "name")[0];
    const seen = where !== undefined || name !== undefined ? ` The dialog showed folder "${where ?? "?"}" and name "${name ?? "?"}".` : "";
    return new ToolError("host_failed", `Live's Save dialog did not reach the requested folder and file name; the dialog was cancelled and nothing was saved.${seen} Check Live.`, { reason: "path_not_applied", detail, ...(where === undefined ? {} : { where }), ...(name === undefined ? {} : { name }) });
  }
  if (text.includes("replace_mismatch")) return new ToolError("host_failed", "Live's replace question did not name the expected file; it was cancelled and nothing was replaced. Check Live.", { reason: "replace_unverified", detail });
  if (text.includes("target_exists")) return new ToolError("host_failed", "The file already exists and replacing it was not confirmed; Live's dialog was cancelled. Ask again with the file in place.", { reason: "target_exists" });
  if (text.includes("save_timeout")) return new ToolError("timeout", "Live's Save dialog did not close in time; check Live.", { stage: "host" });
  return new ToolError("host_failed", kind === "open" ? "macOS could not open the application or the set." : "The macOS script failed.", { reason: kind === "open" ? "open_failed" : "script_error", detail });
}

export class HostService {
  readonly #runner: HostRunner;
  private readonly config: HostConfig;
  private readonly applicationsDir: string;
  private readonly home: string;
  private readonly runtimeDir: string;
  private readonly uid: number;
  readonly enabled: boolean;
  /** Host calls run one at a time: the UI is one shared resource. */
  private tail: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  /** Last known running apps (names), null before any check. */
  private lastRunning: string[] | null = null;
  private accessibility: Accessibility = "unknown";

  constructor(options: HostOptions) {
    this.#runner = options.runner;
    this.config = options.config;
    this.applicationsDir = options.applicationsDir ?? "/Applications";
    this.home = options.home ?? os.homedir();
    this.runtimeDir = options.runtimeDir ?? defaultRuntimeDir(this.home);
    this.uid = options.uid ?? process.getuid?.() ?? -1;
    this.now = options.now ?? (() => Date.now());
    this.enabled = options.config.enabled && (options.platform ?? os.platform()) === "darwin";
  }

  apps(): LiveApp[] {
    return findInstalledApps(this.applicationsDir, this.uid);
  }

  roots(): string[] {
    return [...this.config.setRoots];
  }

  checkPath(raw: unknown, mode: "open" | "save"): CheckedSetPath {
    const checked = checkSetPath(raw, mode, { roots: this.roots(), uid: this.uid });
    if (mode === "open") return checked;
    // Live may write <folder>/<name> Project/<name>.als instead of the given path: either one existing means "replace".
    const project = checkProjectCandidate(checked);
    // Live never replaces inside an existing project: it suffixes the folder (`<name>-1 Project`). So when only the project file exists, the panel goes into that folder and Live shows its replace sheet (T9o).
    const target = !checked.exists && project.exists ? { path: project.path, real: project.real, project: true } : { path: checked.path, real: checked.real, project: false };
    return { ...checked, exists: checked.exists || project.exists, project, target };
  }

  /** The edition of the last Remote Script connection (a hint stored in the runtime directory), if it is known and still installed. */
  lastUsed(installed: readonly LiveApp[] = this.apps()): LiveApp | undefined {
    const variant = readLastApp(this.runtimeDir, { expectedUid: this.uid });
    return variant === undefined ? undefined : installed.find((app) => app.variant === variant);
  }

  /** Remember the edition a Remote Script connection reported, so `auto` starts it next time. Never throws; anything but lite, standard or suite is ignored. */
  rememberEdition(edition: string | null | undefined): void {
    if (!this.enabled || (edition !== "lite" && edition !== "standard" && edition !== "suite")) return;
    if (readLastApp(this.runtimeDir, { expectedUid: this.uid }) === edition) return;
    writeLastApp(this.runtimeDir, edition, { expectedUid: this.uid });
  }

  /** Cached facts only: nothing here starts a process. */
  status(): Record<string, unknown> {
    if (!this.enabled) return { enabled: false };
    const apps = this.apps();
    const wanted = this.config.liveApp === "auto" ? undefined : this.config.liveApp;
    const running = this.lastRunning === null ? undefined : apps.find((app) => this.lastRunning?.includes(app.name));
    const selected = running ?? (wanted === undefined ? (this.lastUsed(apps) ?? apps[0]) : apps.find((app) => app.variant === wanted));
    return {
      enabled: true,
      live_app: this.config.liveApp,
      apps: apps.map((app) => ({ variant: app.variant, name: app.name, path: app.path })),
      selected: selected?.name ?? null,
      last_used: this.lastUsed(apps)?.variant ?? null,
      running: this.lastRunning,
      accessibility: this.accessibility,
      set_roots_count: this.roots().length,
    };
  }

  // ------------------------------------------------------------------ tools

  /** Run `work` after every earlier host call has finished (success or failure). */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * The edition of the one running Live 12 app (lite, standard or suite), for the Remote Script's edition hint.
   * Same running check as the UI actions, with a short timeout. Never throws: any failure, or no single
   * supported app running, gives undefined. It refreshes the running state that status() reports.
   */
  async probeEdition(): Promise<"lite" | "standard" | "suite" | undefined> {
    if (!this.enabled) return undefined;
    return this.serial(async () => {
      try {
        const installed = this.apps();
        if (installed.length === 0) return undefined;
        const running = await this.probe(installed, EDITION_PROBE_TIMEOUT_MS);
        const variant = running.length === 1 ? running[0]?.variant : undefined;
        return variant === "lite" || variant === "standard" || variant === "suite" ? variant : undefined;
      } catch {
        return undefined;
      }
    });
  }

  launch(requested: Variant | undefined): Promise<LaunchResult> {
    return this.serial(() => this.doLaunch(requested));
  }

  openSet(raw: unknown): Promise<OpenSetResult> {
    return this.serial(() => this.doOpenSet(raw));
  }

  menu(action: MenuAction): Promise<Record<string, unknown>> {
    return this.serial(() => this.doMenu(action));
  }

  /** `expectExists` is what the plan (and the confirmation, if any) was based on; a different state now is refused. */
  saveSetAs(raw: unknown, expectExists: boolean): Promise<Record<string, unknown>> {
    return this.serial(() => this.doSaveSetAs(raw, expectExists));
  }

  private async doLaunch(requested: Variant | undefined): Promise<LaunchResult> {
    const target = await this.resolve(requested);
    await this.open([target.app.path]);
    return { action: target.wasRunning ? "activated" : "launched", app: appInfo(target.app), was_running: target.wasRunning, chosen_by: target.chosenBy };
  }

  private async doOpenSet(raw: unknown): Promise<OpenSetResult> {
    const checked = this.checkPath(raw, "open");
    const target = await this.resolve(undefined);
    await this.open([target.app.path, checked.real]);
    return {
      action: "open_requested", app: appInfo(target.app), path: checked.path, was_running: target.wasRunning, chosen_by: target.chosenBy,
      note: "If the current set has unsaved changes, Live asks about them in its own dialog; answer it in Live.",
    };
  }

  private async doMenu(action: MenuAction): Promise<Record<string, unknown>> {
    const app = await this.runningApp();
    const out = await this.script(MENU_SCRIPT, [action], UI_TIMEOUT_MS);
    const base = { app: appInfo(app) };
    if (action === "new") return { action: "new_set_requested", ...base, note: "If the current set has unsaved changes, Live asks about them in its own dialog; answer it in Live." };
    if (action === "export") return { action: "export_dialog_requested", ...base, note: "Live's Export Audio/Video dialog is open; complete the export in Live." };
    const dialog = out.trim() === "dialog_open";
    return {
      action: "save_requested", ...base, result: dialog ? "save_dialog_open" : "saved",
      note: dialog ? "The set has never been saved, so Live opened its Save dialog. Finish it in Live, or call save_set_as with a path." : "Live saved the set.",
    };
  }

  private async doSaveSetAs(raw: unknown, expectExists: boolean): Promise<Record<string, unknown>> {
    const checked = this.checkPath(raw, "save");
    if (checked.exists !== expectExists) {
      throw new ToolError("invalid_args", "The file changed between planning and running (it now " + (checked.exists ? "exists" : "does not exist") + "). Ask again.", { reason: "target_changed" });
    }
    const app = await this.runningApp();
    const candidates: SaveCandidate[] = [];
    const driveReal = checked.target?.real ?? checked.real;
    const intoProject = checked.target?.project === true && checked.project !== undefined;
    if (checked.project !== undefined) candidates.push({ path: checked.project.path, real: checked.project.real, folder: checked.project.folder, project: true, before: snapshot(checked.project.real) });
    // Replacing inside the project folder: only that exact file counts (the direct path is not a place Live writes then).
    if (!intoProject) candidates.push({ path: checked.path, real: checked.real, folder: checked.parent, project: false, before: snapshot(checked.real) });
    const strayBefore = this.strayFolders(checked.parent, checked.real);
    const startedAt = this.now();
    await this.script(SAVE_AS_SCRIPT, [driveReal, expectExists ? "1" : "0"], SAVE_AS_TIMEOUT_MS);
    const landed = this.verifyLanded(candidates, startedAt, () => this.strayError(checked.parent, checked.real, strayBefore));
    return {
      action: "save_as_requested", app: appInfo(app), path: landed.path, replaced: expectExists, result: "saved",
      ...(landed.project ? { requested_path: checked.path, note: `Live saved the set inside its own project folder "${path.basename(landed.folder)}".` } : {}),
    };
  }

  // ------------------------------------------------------------------ internals

  /**
   * Live said ok; believe it only when a file is there. Live writes either the given path or
   * `<folder>/<name> Project/<name>.als`; the first candidate that is a regular file (not a symlink) in the expected real
   * folder (so inside the validated parent), modified since the call began but not in the future (5 s of clock slack),
   * and, when it existed before, changed (new inode or new modification time), is the saved file.
   */
  private verifyLanded(candidates: readonly SaveCandidate[], startedAt: number, strayError: () => ToolError | undefined): SaveCandidate {
    for (const candidate of candidates) {
      try {
        const info = fs.lstatSync(candidate.real);
        const folderInfo = fs.lstatSync(candidate.folder);
        const landed = info.isFile() && !folderInfo.isSymbolicLink() && info.mtimeMs >= startedAt && info.mtimeMs <= this.now() + MAX_CLOCK_SLACK_MS && fs.realpathSync(path.dirname(candidate.real)) === candidate.folder &&
          (candidate.before === undefined || info.ino !== candidate.before.ino || info.mtimeMs !== candidate.before.mtimeMs);
        if (landed) return candidate;
      } catch {
        // not this one
      }
    }
    const stray = strayError();
    if (stray !== undefined) throw stray;
    throw new ToolError("host_failed", "Live reported success but the saved file was not found where expected (neither the given path nor its '<name> Project' folder); check Live before assuming the set was saved.", { reason: "save_unverified" });
  }

  /** Names of the `<name>-N Project` folders (N 1..MAX_STRAY_SUFFIX) next to the set: what Live creates instead of replacing. Probed by name; no directory listing. */
  private strayFolders(parent: string, real: string): Set<string> {
    const stem = path.basename(real, path.extname(real));
    const found = new Set<string>();
    for (let n = 1; n <= MAX_STRAY_SUFFIX; n++) {
      const entry = `${stem}-${n} Project`;
      try {
        fs.lstatSync(path.join(parent, entry));
        found.add(entry);
      } catch {
        // not there
      }
    }
    return found;
  }

  /** A `<name>-N Project` folder holding the set that was not there before the call: Live saved a copy instead of the file asked for. */
  private strayError(parent: string, real: string, before: ReadonlySet<string>): ToolError | undefined {
    const name = path.basename(real);
    for (const entry of [...this.strayFolders(parent, real)].sort()) {
      if (before.has(entry)) continue;
      const stray = path.join(parent, entry, name);
      try {
        if (!fs.lstatSync(stray).isFile()) continue;
      } catch {
        continue;
      }
      return new ToolError("host_failed", `Live saved the set as a new copy at "${stray}" instead of replacing the expected file; the expected file was not replaced. Nothing was lost. Check Live, and remove the stray folder "${entry}" if you do not want it.`, { reason: "stray_project_folder", stray_path: stray });
    }
    return undefined;
  }

  private options(timeoutMs: number): HostRunOptions {
    return { timeoutMs, maxBytes: MAX_OUTPUT_BYTES, env: { PATH: "/usr/bin:/bin", HOME: this.home, LANG: "en_US.UTF-8" } };
  }

  /** Which of the installed apps are running. Asks macOS; starts nothing. */
  private async probe(installed: LiveApp[], timeoutMs = PROBE_TIMEOUT_MS): Promise<LiveApp[]> {
    const result = await this.#runner(OSASCRIPT_BINARY, buildOsascriptArgs(RUNNING_SCRIPT, installed.map((app) => app.path)), this.options(timeoutMs));
    if (result.code !== 0 || result.failure !== undefined || result.timedOut || result.truncated) throw classifyFailure(result, "probe");
    const paths = new Set(result.stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0));
    const running = installed.filter((app) => paths.has(app.path));
    this.lastRunning = running.map((app) => app.name);
    return running;
  }

  private requireEnabled(): void {
    if (!this.enabled) throw new ToolError("not_supported", "Host automation is disabled (host.enabled is false, or this is not macOS).", { reason: "host_disabled" });
  }

  private noLiveApp(): ToolError {
    const unverified = scanInstalledApps(this.applicationsDir, this.uid).unverified;
    if (unverified.length > 0) {
      return new ToolError("not_found", `Found ${unverified.join(", ")} in /Applications, but its Contents/Info.plist is not a readable XML plist naming com.ableton.live, so it is not trusted.`, { what: "live_app", reason: "unverified_bundle", bundles: unverified });
    }
    return new ToolError("not_found", "No Ableton Live 12 application was found in /Applications (looked for Suite, Standard, Lite, Intro, Trial and Beta).", { what: "live_app" });
  }

  /**
   * Choose the app for launch/open: the running one, else the explicit request, else the setting, else the edition of
   * the last connection (when it is still installed), else Suite > Standard > Lite > ... Never a second instance.
   */
  private async resolve(requested: Variant | undefined): Promise<{ app: LiveApp; wasRunning: boolean; chosenBy: ChosenBy }> {
    this.requireEnabled();
    const installed = this.apps();
    if (installed.length === 0) throw this.noLiveApp();
    const running = await this.probe(installed);
    if (running.length > 1) throw new ToolError("not_supported", "More than one Ableton Live is running; quit one of them first.", { reason: "multiple_live_running" });
    const wanted: Variant | undefined = requested ?? (this.config.liveApp === "auto" ? undefined : this.config.liveApp);
    const current = running[0];
    if (current !== undefined) {
      if (wanted !== undefined && wanted !== current.variant) {
        throw new ToolError("not_supported", `${current.name} is already running; quit it before starting ${wanted}. A second Live is never started.`, { reason: "different_live_running", running: current.variant, requested: wanted });
      }
      return { app: current, wasRunning: true, chosenBy: "running" };
    }
    if (wanted !== undefined) {
      const app = installed.find((candidate) => candidate.variant === wanted);
      if (app === undefined) throw this.noLiveApp();
      return { app, wasRunning: false, chosenBy: requested === undefined ? "config" : "requested" };
    }
    const last = this.lastUsed(installed);
    if (last !== undefined) return { app: last, wasRunning: false, chosenBy: "last_used" };
    const first = installed[0];
    if (first === undefined) throw this.noLiveApp();
    return { app: first, wasRunning: false, chosenBy: "default" };
  }

  /** The running app for a UI action; Live not running is an error with the way out. */
  private async runningApp(): Promise<LiveApp> {
    this.requireEnabled();
    const installed = this.apps();
    if (installed.length === 0) throw this.noLiveApp();
    const running = await this.probe(installed);
    if (running.length > 1) throw new ToolError("not_supported", "More than one Ableton Live is running; quit one of them first.", { reason: "multiple_live_running" });
    const app = running[0];
    if (app === undefined) throw new ToolError("not_supported", "Ableton Live is not running. Call launch_live first.", { reason: "live_not_running" });
    return app;
  }

  private async open(args: string[]): Promise<void> {
    const result = await this.#runner(OPEN_BINARY, ["-a", ...args], this.options(OPEN_TIMEOUT_MS));
    if (result.code !== 0 || result.failure !== undefined || result.timedOut || result.truncated) throw classifyFailure(result, "open");
  }

  private async script(script: string, variables: string[], timeoutMs: number): Promise<string> {
    const result = await this.#runner(OSASCRIPT_BINARY, buildOsascriptArgs(script, variables), this.options(timeoutMs));
    if (result.code !== 0 || result.failure !== undefined || result.timedOut || result.truncated) {
      const error = classifyFailure(result, "ui");
      if (error.code === "permission_required" && error.details?.["permission"] === "accessibility") this.accessibility = "denied";
      throw error;
    }
    this.accessibility = "granted";
    return result.stdout;
  }
}

