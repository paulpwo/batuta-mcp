#!/usr/bin/env node
// Turns on Claude Code's fullscreen renderer in its user settings (Node built-ins only).
//
//   node claude-code-settings.mjs tui --settings <abs settings.json> [--dry-run]
//
// The transport bar's buttons take clicks and focus only under the fullscreen renderer
// ("tui": "fullscreen", the same as /tui fullscreen); on the default renderer the bar shows
// but nothing presses. Installing BatutaMCP means wanting the bar, so this always sets
// "tui" to "fullscreen", whatever it was, and leaves every other key alone. A missing file
// is created. The file is refused (exit 3,
// untouched) when it is a symlink, not valid JSON or not an object. An existing file is
// backed up next to itself first; the write is temp file + rename and keeps the mode.
import fs from 'node:fs';
import path from 'node:path';

const REFUSED = 3;
const WANTED = 'fullscreen';

function usage(msg) {
  process.stderr.write(`claude-code-settings: ${msg}\nUsage: node claude-code-settings.mjs tui --settings <abs settings.json> [--dry-run]\n`);
  process.exit(2);
}
function refuse(msg) {
  process.stderr.write(`claude-code-settings: ${msg}\n`);
  process.exit(REFUSED);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd !== 'tui') usage(`unknown command: ${cmd ?? '(none)'}`);
const opt = { dryRun: false };
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === '--dry-run') opt.dryRun = true;
  else if (rest[i] === '--settings' && rest[i + 1] !== undefined) opt.settings = rest[++i];
  else usage(`bad argument: ${rest[i]}`);
}
if (!opt.settings || !path.isAbsolute(opt.settings)) usage('--settings must be an absolute path');

const file = opt.settings;
const st = fs.lstatSync(file, { throwIfNoEntry: false });
if (st?.isSymbolicLink()) refuse(`${file} is a symlink; not touching it.`);
if (st && !st.isFile()) refuse(`${file} is not a regular file; not touching it.`);

let settings = {};
if (st) {
  try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { refuse(`${file} is not valid JSON; not touching it.`); }
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) refuse(`${file} is not a JSON object; not touching it.`);
}

if (settings.tui === WANTED) {
  process.stdout.write(`Claude Code already uses the fullscreen renderer (${file}).\n`);
  process.exit(0);
}

if (opt.dryRun) {
  process.stdout.write(`Would ${st ? 'set "tui": "fullscreen" in' : 'create'} ${file}\n`);
  process.exit(0);
}

settings.tui = WANTED;
fs.mkdirSync(path.dirname(file), { recursive: true });
let mode = 0o644;
if (st) {
  mode = st.mode & 0o777;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  let backup = `${file}.bak-${stamp}`;
  for (let n = 1; fs.existsSync(backup); n++) backup = `${file}.bak-${stamp}-${n}`;
  fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(backup, mode);
  process.stdout.write(`Backup: ${backup}\n`);
}
const tmp = `${file}.tmp-${process.pid}`;
try {
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', { flag: 'wx', mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
} catch (e) {
  fs.rmSync(tmp, { force: true });
  throw e;
}
process.stdout.write(`Set Claude Code to the fullscreen renderer ("tui": "fullscreen" in ${file}); the transport bar's buttons need it. /tui default switches back.\n`);
