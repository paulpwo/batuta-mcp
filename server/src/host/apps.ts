import fs from "node:fs";
import path from "node:path";

/**
 * Where Ableton Live 12 is installed (docs/04-host-automation.md section 3): the fixed names
 * `Ableton Live 12 <Variant>.app` directly under the applications directory, each one a real
 * directory whose Contents/Info.plist (XML, read-only, size-capped) names the bundle identifier
 * `com.ableton.live`. The module has no directory listing, so the pattern `Ableton Live 12 *.app` is
 * resolved against this fixed list. A binary plist cannot be read without a program, so it is refused.
 */

/** In the order `auto` prefers them. */
export const VARIANTS = ["suite", "standard", "lite", "intro", "trial", "beta"] as const;
export type Variant = (typeof VARIANTS)[number];

export interface LiveApp {
  variant: Variant;
  /** The bundle name without `.app`, e.g. "Ableton Live 12 Suite". */
  name: string;
  /** Absolute path of the bundle. */
  path: string;
}

export interface AppScan {
  apps: LiveApp[];
  /** Bundle names that exist under the expected name but whose Info.plist could not be verified as Live. */
  unverified: string[];
}

const MAX_PLIST_BYTES = 256 * 1024;
const BUNDLE_ID = /<key>CFBundleIdentifier<\/key>\s*<string>com\.ableton\.live<\/string>/;

/** True when the bundle's Info.plist is a plain XML plist that gives CFBundleIdentifier = com.ableton.live. */
function isLiveBundle(bundle: string, uid: number): boolean {
  try {
    const contents = fs.lstatSync(path.join(bundle, "Contents"));
    if (!contents.isDirectory() || contents.isSymbolicLink()) return false;
    const fd = fs.openSync(path.join(bundle, "Contents", "Info.plist"), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const info = fs.fstatSync(fd);
      if (!info.isFile() || info.size > MAX_PLIST_BYTES || (info.uid !== 0 && info.uid !== uid)) return false;
      const data = Buffer.alloc(info.size);
      fs.readSync(fd, data, 0, data.length, 0);
      const text = data.toString("utf8");
      return text.trimStart().startsWith("<?xml") && BUNDLE_ID.test(text);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

export function scanInstalledApps(applicationsDir: string, uid: number): AppScan {
  const scan: AppScan = { apps: [], unverified: [] };
  for (const variant of VARIANTS) {
    const name = `Ableton Live 12 ${variant.charAt(0).toUpperCase()}${variant.slice(1)}`;
    const bundle = path.join(applicationsDir, `${name}.app`);
    try {
      const info = fs.lstatSync(bundle);
      if (!info.isDirectory() || info.isSymbolicLink() || (info.uid !== 0 && info.uid !== uid)) continue;
    } catch {
      continue;
    }
    if (isLiveBundle(bundle, uid)) scan.apps.push({ variant, name, path: bundle });
    else scan.unverified.push(name);
  }
  return scan;
}

/** The verified installed apps, in `VARIANTS` order. */
export function findInstalledApps(applicationsDir: string, uid: number): LiveApp[] {
  return scanInstalledApps(applicationsDir, uid).apps;
}
