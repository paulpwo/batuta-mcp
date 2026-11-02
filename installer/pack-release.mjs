#!/usr/bin/env node
// Packs the release assets (Node built-ins and the system `tar` only).
//
//   node installer/pack-release.mjs --out <dir> [--root <repo>]
//
// Writes into <dir>:
//   batuta-mcp-vX.Y.Z.tar.gz(.sha256)   the versioned archive and its checksum
//   batuta-mcp.tar.gz(.sha256)          the same bytes under a stable name, so
//                                       releases/latest/download/<name> works
//   install.sh                          copy of the repo-root installer
//
// The archive holds only what runs: the built server, the Remote Script
// sources, the installer, the Claude Code transport bar, docs and a VERSION file.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function die(msg) {
  process.stderr.write('pack-release: ' + msg + '\n');
  process.exit(1);
}

function parseArgs(argv) {
  const a = { root: path.resolve(HERE, '..'), out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root' && argv[i + 1]) a.root = path.resolve(argv[++i]);
    else if (argv[i] === '--out' && argv[i + 1]) a.out = path.resolve(argv[++i]);
    else die('Usage: node installer/pack-release.mjs --out <dir> [--root <repo>]');
  }
  if (!a.out) die('--out <dir> is required');
  return a;
}

/** Regular files under `dir` (relative paths, sorted); a symlink or special file is an error. */
function listFiles(root, dir, keep) {
  const out = [];
  const walk = (rel) => {
    for (const name of fs.readdirSync(path.join(root, rel)).sort()) {
      const r = path.posix.join(rel, name);
      const st = fs.lstatSync(path.join(root, r));
      if (st.isSymbolicLink()) die('symlink in the release tree: ' + r);
      if (st.isDirectory()) walk(r);
      else if (st.isFile()) { if (keep(r)) out.push(r); } else die('not a regular file: ' + r);
    }
  };
  walk(dir);
  return out;
}

const junk = (r) => /(^|\/)(\.DS_Store|node_modules|__pycache__)(\/|$)/.test(r) || /\.(test\.[a-z]+|pyc|map)$/.test(r);

const { root, out } = parseArgs(process.argv.slice(2));
const rd = (rel) => path.join(root, rel);

const version = JSON.parse(fs.readFileSync(rd('server/package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) die('version must be X.Y.Z, got: ' + version);
if (!fs.existsSync(rd('server/dist/src/bin.js'))) die('the server is not built (run "pnpm run build" in server/ first)');

// What ships, as a sorted list of repo-relative files.
const files = new Set(['server/package.json', 'installer/install.mjs', 'installer/desktop-config.mjs', 'installer/claude-code-settings.mjs']);
for (const f of listFiles(root, 'server/dist/src', (r) => !junk(r))) files.add(f);
for (const f of listFiles(root, 'remote_script/BatutaMCP', (r) => r.endsWith('.py') && !r.slice('remote_script/BatutaMCP/'.length).includes('/'))) files.add(f);
for (const f of listFiles(root, 'clients/claude-code', (r) => !junk(r))) files.add(f);
for (const f of ['LICENSE', 'README.md', 'SETUP.md', 'CHANGELOG.md']) files.add(f);
for (const f of files) {
  const st = fs.lstatSync(rd(f), { throwIfNoEntry: false });
  if (!st || !st.isFile()) die('missing release file: ' + f);
}

// Stage a copy (plus VERSION), then archive it with an explicit top-level list.
const stage = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'batuta-pack-'));
try {
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(stage, f)), { recursive: true });
    fs.copyFileSync(rd(f), path.join(stage, f));
    fs.chmodSync(path.join(stage, f), fs.statSync(rd(f)).mode & 0o111 ? 0o755 : 0o644);
  }
  fs.writeFileSync(path.join(stage, 'VERSION'), version + '\n');

  fs.mkdirSync(out, { recursive: true });
  const versioned = `batuta-mcp-v${version}.tar.gz`;
  const top = fs.readdirSync(stage).sort();
  const env = { ...process.env, COPYFILE_DISABLE: '1' }; // no AppleDouble "._" entries from bsdtar
  const t = spawnSync('tar', ['-czf', path.join(out, versioned), '-C', stage, ...top], { env, encoding: 'utf8' });
  if (t.status !== 0) die('tar failed: ' + t.stderr);
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}

// Stable-named copy and checksums in `shasum -a 256` format.
const archive = fs.readFileSync(path.join(out, `batuta-mcp-v${version}.tar.gz`));
const hex = crypto.createHash('sha256').update(archive).digest('hex');
fs.writeFileSync(path.join(out, 'batuta-mcp.tar.gz'), archive);
for (const name of [`batuta-mcp-v${version}.tar.gz`, 'batuta-mcp.tar.gz']) {
  fs.writeFileSync(path.join(out, name + '.sha256'), `${hex}  ${name}\n`);
}
fs.copyFileSync(rd('install.sh'), path.join(out, 'install.sh'));
process.stdout.write(`Packed v${version} (${files.size + 1} files) into ${out}\n`);
