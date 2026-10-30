#!/usr/bin/env node
// Registers BatutaMCP in Claude Desktop's config (Node built-ins only).
//
//   node desktop-config.mjs merge --config <file> --node <abs node> --bin <abs bin.js> [--dry-run]
//
// Sets mcpServers.batutaMCP and leaves every other key and server alone. A missing
// file is created. The file is refused (exit 3, untouched) when it is a symlink, not
// valid JSON, not an object, or has an mcpServers value that is not an object. An
// existing file is backed up next to itself first; the write is temp file + rename
// and keeps the original mode.
import fs from 'node:fs';
import path from 'node:path';

const REFUSED = 3;

function usage(msg) {
  process.stderr.write(`desktop-config: ${msg}\nUsage: node desktop-config.mjs merge --config <file> --node <abs node> --bin <abs bin.js> [--dry-run]\n`);
  process.exit(2);
}
function refuse(msg) {
  process.stderr.write(`desktop-config: ${msg}\n`);
  process.exit(REFUSED);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd !== 'merge') usage(`unknown command: ${cmd ?? '(none)'}`);
const opt = { dryRun: false };
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === '--dry-run') opt.dryRun = true;
  else if (['--config', '--node', '--bin'].includes(rest[i]) && rest[i + 1] !== undefined) opt[rest[i].slice(2)] = rest[++i];
  else usage(`bad argument: ${rest[i]}`);
}
for (const k of ['config', 'node', 'bin']) {
  if (!opt[k] || !path.isAbsolute(opt[k])) usage(`--${k} must be an absolute path`);
}

const cfg = opt.config;
const entry = { command: opt.node, args: ['--disallow-code-generation-from-strings', opt.bin] };
const st = fs.lstatSync(cfg, { throwIfNoEntry: false });
if (st?.isSymbolicLink()) refuse(`${cfg} is a symlink; not touching it.`);
if (st && !st.isFile()) refuse(`${cfg} is not a regular file; not touching it.`);

let config = {};
let action = 'create';
if (st) {
  try { config = JSON.parse(fs.readFileSync(cfg, 'utf8')); } catch { refuse(`${cfg} is not valid JSON; not touching it.`); }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) refuse(`${cfg} is not a JSON object; not touching it.`);
  const servers = config.mcpServers;
  if (servers !== undefined && (servers === null || typeof servers !== 'object' || Array.isArray(servers))) {
    refuse(`"mcpServers" in ${cfg} is not an object; not touching it.`);
  }
  action = servers && Object.hasOwn(servers, 'batutaMCP') ? 'replace' : 'add';
}
config.mcpServers = { ...(config.mcpServers ?? {}), batutaMCP: entry };

if (opt.dryRun) {
  process.stdout.write(`Would ${action === 'create' ? 'create' : action === 'replace' ? 'replace the batutaMCP entry in' : 'add the batutaMCP entry to'} ${cfg}\n`);
  process.exit(0);
}

fs.mkdirSync(path.dirname(cfg), { recursive: true });
let mode = 0o644;
if (st) {
  mode = st.mode & 0o777;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  let backup = `${cfg}.bak-${stamp}`;
  for (let n = 1; fs.existsSync(backup); n++) backup = `${cfg}.bak-${stamp}-${n}`;
  fs.copyFileSync(cfg, backup, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(backup, mode);
  process.stdout.write(`Backup: ${backup}\n`);
}
const tmp = `${cfg}.tmp-${process.pid}`;
try {
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, cfg);
} catch (e) {
  fs.rmSync(tmp, { force: true });
  throw e;
}
process.stdout.write(`${action === 'create' ? 'Created' : action === 'replace' ? 'Replaced the batutaMCP entry in' : 'Added the batutaMCP entry to'} ${cfg}\n`);
