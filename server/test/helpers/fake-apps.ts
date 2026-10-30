import fs from "node:fs";
import path from "node:path";

/** The Info.plist of a Live bundle as macOS ships it (XML, tab-indented), with the given bundle identifier. */
export function plistFor(identifier: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n\t<key>CFBundleName</key>\n\t<string>Live</string>\n\t<key>CFBundleIdentifier</key>\n\t<string>${identifier}</string>\n</dict>\n</plist>\n`;
}

/** A fake application bundle: the directory and its Contents/Info.plist. */
export function makeApp(applicationsDir: string, bundleName: string, identifier = "com.ableton.live"): string {
  const bundle = path.join(applicationsDir, bundleName);
  fs.mkdirSync(path.join(bundle, "Contents"), { recursive: true });
  fs.writeFileSync(path.join(bundle, "Contents", "Info.plist"), plistFor(identifier));
  return bundle;
}
