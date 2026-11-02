// Shared helpers for the release packaging and install.sh tests (Node built-ins only).
// Not a *.test.mjs file, so the test runner glob does not pick it up.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..', '..');
export const PACK = path.join(REPO, 'installer', 'pack-release.mjs');
export const INSTALL_SH = path.join(REPO, 'install.sh');

const roots = [];
export function mkTmp() {
  const d = fs.realpathSync(fs.mkdtempSync('/tmp/bm-rel-'));
  roots.push(d);
  return d;
}
export function cleanup() {
  for (const d of roots.splice(0)) fs.rmSync(d, { recursive: true, force: true });
}

export function put(root, rel, text = 'x\n', mode) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  if (mode) fs.chmodSync(p, mode);
}

/** A small repo-shaped tree with files that must and must not ship. */
export function makeFixtureRoot(version = '1.2.3') {
  const r = mkTmp();
  put(r, 'server/package.json', JSON.stringify({ name: 'x', version, type: 'module' }) + '\n');
  put(r, 'server/dist/src/bin.js', '#!/usr/bin/env node\nconsole.log("fixture server");\n', 0o755);
  put(r, 'server/dist/src/loudness/worker.js', 'export {};\n');
  put(r, 'server/dist/test/x.test.js', 'nope\n');
  put(r, 'server/src/bin.ts', 'nope\n');
  put(r, 'server/test/x.test.ts', 'nope\n');
  put(r, 'server/node_modules/dep/index.js', 'nope\n');
  put(r, 'remote_script/BatutaMCP/__init__.py', 'X = 1\n');
  put(r, 'remote_script/BatutaMCP/limits.py', `SCRIPT_VERSION = "${version}"\n`);
  put(r, 'remote_script/BatutaMCP/tests/test_x.py', 'nope\n');
  put(r, 'remote_script/BatutaMCP/__pycache__/a.pyc', 'nope\n');
  put(r, 'remote_script/BatutaMCP/notes.txt', 'nope\n');
  put(r, 'installer/install.mjs', fs.readFileSync(path.join(REPO, 'installer', 'install.mjs'), 'utf8'));
  put(r, 'installer/desktop-config.mjs', fs.readFileSync(path.join(REPO, 'installer', 'desktop-config.mjs'), 'utf8'));
  put(r, 'installer/claude-code-settings.mjs', fs.readFileSync(path.join(REPO, 'installer', 'claude-code-settings.mjs'), 'utf8'));
  put(r, 'installer/test/x.test.mjs', 'nope\n');
  put(r, 'installer/pack-release.mjs', 'nope\n');
  put(r, 'clients/claude-code/.claude-plugin/marketplace.json', '{}\n');
  put(r, 'clients/claude-code/batuta-transport/hooks/register.tsx', 'x\n');
  put(r, 'clients/claude-code/batuta-transport/hooks/transport.test.tsx', 'nope\n');
  put(r, 'odd/tasks/x.md', 'nope\n');
  put(r, 'tests/remote_script/test_x.py', 'nope\n');
  put(r, 'docs/a.md', 'nope\n');
  put(r, '.DS_Store', 'nope\n');
  for (const f of ['LICENSE', 'README.md', 'SETUP.md', 'CHANGELOG.md']) put(r, f, f + '\n');
  put(r, 'install.sh', fs.readFileSync(INSTALL_SH, 'utf8'), 0o755);
  return r;
}

export function pack(root, out, extra = []) {
  return spawnSync(process.execPath, [PACK, '--root', root, '--out', out, ...extra], { encoding: 'utf8' });
}

export function tarList(file) {
  const r = spawnSync('tar', ['-tzf', file], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.split('\n').filter((l) => l && !l.endsWith('/')).sort();
}
