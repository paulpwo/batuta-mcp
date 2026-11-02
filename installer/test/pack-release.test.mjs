import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

import { REPO, mkTmp, cleanup, makeFixtureRoot, pack, tarList } from './helpers.mjs';

afterEach(cleanup);

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

test('pack-release: the tarball holds exactly the allowlist for the fixture tree', () => {
  const root = makeFixtureRoot('1.2.3');
  const out = mkTmp();
  const r = pack(root, out);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(tarList(path.join(out, 'batuta-mcp-v1.2.3.tar.gz')), [
    'CHANGELOG.md',
    'LICENSE',
    'README.md',
    'SETUP.md',
    'VERSION',
    'clients/claude-code/.claude-plugin/marketplace.json',
    'clients/claude-code/batuta-transport/hooks/register.tsx',
    'installer/claude-code-settings.mjs',
    'installer/desktop-config.mjs',
    'installer/install.mjs',
    'remote_script/BatutaMCP/__init__.py',
    'remote_script/BatutaMCP/limits.py',
    'server/dist/src/bin.js',
    'server/dist/src/loudness/worker.js',
    'server/package.json',
  ]);
});

test('pack-release: no test, odd, node_modules, pycache or dot-store files ship', () => {
  const root = makeFixtureRoot();
  const out = mkTmp();
  assert.equal(pack(root, out).status, 0);
  for (const e of tarList(path.join(out, 'batuta-mcp-v1.2.3.tar.gz'))) {
    assert.doesNotMatch(e, /(^|\/)(test|tests|odd|node_modules|__pycache__|docs)\//, e);
    assert.doesNotMatch(e, /\.test\.|\.DS_Store|\.pyc$|\.ts$/, e);
    assert.ok(!e.startsWith('/') && !e.split('/').includes('..'), e);
  }
});

test('pack-release: writes the versioned and the stable-named assets, and the sha256 files verify', () => {
  const root = makeFixtureRoot();
  const out = mkTmp();
  assert.equal(pack(root, out).status, 0);
  assert.deepEqual(fs.readdirSync(out).sort(), [
    'batuta-mcp-v1.2.3.tar.gz',
    'batuta-mcp-v1.2.3.tar.gz.sha256',
    'batuta-mcp.tar.gz',
    'batuta-mcp.tar.gz.sha256',
    'install.sh',
  ]);
  assert.equal(fs.readFileSync(path.join(out, 'batuta-mcp.tar.gz')).compare(fs.readFileSync(path.join(out, 'batuta-mcp-v1.2.3.tar.gz'))), 0);
  for (const name of ['batuta-mcp-v1.2.3.tar.gz', 'batuta-mcp.tar.gz']) {
    // Same format as `shasum -a 256`: "<hex>  <file name>".
    assert.equal(fs.readFileSync(path.join(out, name + '.sha256'), 'utf8'), `${sha(path.join(out, name))}  ${name}\n`);
    const c = spawnSync('shasum', ['-a', '256', '-c', name + '.sha256'], { cwd: out, encoding: 'utf8' });
    assert.equal(c.status, 0, c.stderr);
  }
  assert.equal(fs.readFileSync(path.join(out, 'install.sh'), 'utf8'), fs.readFileSync(path.join(root, 'install.sh'), 'utf8'));
});

test('pack-release: VERSION holds the package version', () => {
  const root = makeFixtureRoot('4.5.6');
  const out = mkTmp();
  assert.equal(pack(root, out).status, 0);
  const x = mkTmp();
  assert.equal(spawnSync('tar', ['-xzf', path.join(out, 'batuta-mcp-v4.5.6.tar.gz'), '-C', x]).status, 0);
  assert.equal(fs.readFileSync(path.join(x, 'VERSION'), 'utf8'), '4.5.6\n');
});

test('pack-release: refuses when the server is not built, a symlink is in the allowlist, or the version is odd', () => {
  const noBuild = makeFixtureRoot();
  fs.rmSync(path.join(noBuild, 'server', 'dist'), { recursive: true });
  const out = mkTmp();
  const a = pack(noBuild, out);
  assert.notEqual(a.status, 0);
  assert.match(a.stderr, /build/i);
  assert.deepEqual(fs.readdirSync(out), []);

  const link = makeFixtureRoot();
  fs.symlinkSync('/etc/hosts', path.join(link, 'server', 'dist', 'src', 'evil.js'));
  const b = pack(link, mkTmp());
  assert.notEqual(b.status, 0);
  assert.match(b.stderr, /symlink/i);

  const odd = makeFixtureRoot('1.2.3-rc1');
  const c = pack(odd, mkTmp());
  assert.notEqual(c.status, 0);
  assert.match(c.stderr, /version/i);
});

test('pack-release: the real tree packs, and the server starts from an extracted copy and answers initialize', async (t) => {
  if (!fs.existsSync(path.join(REPO, 'server', 'dist', 'src', 'bin.js'))) return t.skip('server/dist is not built');
  const out = mkTmp();
  const r = spawnSync(process.execPath, [path.join(REPO, 'installer', 'pack-release.mjs'), '--out', out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const version = JSON.parse(fs.readFileSync(path.join(REPO, 'server', 'package.json'), 'utf8')).version;
  const tgz = path.join(out, `batuta-mcp-v${version}.tar.gz`);
  const entries = tarList(tgz);
  assert.ok(entries.includes('server/dist/src/bin.js'));
  assert.ok(entries.includes('server/dist/src/loudness/worker.js'), 'compiled loudness code ships');
  assert.ok(entries.includes('remote_script/BatutaMCP/__init__.py'));
  assert.ok(entries.includes('installer/install.mjs'));
  assert.ok(entries.some((e) => e.startsWith('clients/claude-code/')));
  assert.ok(!entries.some((e) => /(^|\/)(test|tests|odd|node_modules)\/|\.test\./.test(e)), 'no test material');

  const x = mkTmp();
  assert.equal(spawnSync('tar', ['-xzf', tgz, '-C', x]).status, 0);
  const home = mkTmp();
  const child = spawn(process.execPath, ['--disallow-code-generation-from-strings', path.join(x, 'server', 'dist', 'src', 'bin.js')], {
    env: { PATH: process.env.PATH, HOME: home }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } } }) + '\n');
  const deadline = Date.now() + 15000;
  while (!stdout.includes('\n') && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
  child.stdin.end();
  await new Promise((res) => child.on('close', res));
  const reply = JSON.parse(stdout.split('\n')[0]);
  assert.equal(reply.id, 1);
  assert.equal(reply.result.serverInfo.version, version);
});
