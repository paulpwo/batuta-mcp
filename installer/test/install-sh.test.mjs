import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { INSTALL_SH, mkTmp, cleanup, put, makeFixtureRoot, pack } from './helpers.mjs';

afterEach(cleanup);

/** Pack a fixture release for `version` and return {base: file:// URL, out: dir}. */
function release(version) {
  const out = mkTmp();
  const r = pack(makeFixtureRoot(version), out);
  assert.equal(r.status, 0, r.stderr);
  return { out, base: 'file://' + out };
}

/** A sandbox: temp HOME, PATH with a fake `claude` (or none) and a symlinked node. */
function sandbox({ claude = true, claudeExit = 0 } = {}) {
  const root = mkTmp();
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  const nodeBin = path.join(root, 'nodebin');
  const log = path.join(root, 'claude.log');
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  fs.mkdirSync(nodeBin);
  fs.symlinkSync(process.execPath, path.join(nodeBin, 'node'));
  if (claude) {
    put(bin, 'claude', `#!/bin/sh\n{ printf 'ARGS'; for a in "$@"; do printf ' [%s]' "$a"; done; printf '\\n'; } >> '${log}'\nif [ "$2" = remove ]; then exit ${claudeExit}; fi\nexit 0\n`, 0o755);
  }
  const PATH = [bin, nodeBin, '/usr/bin', '/bin'].join(':');
  const nodeAbs = spawnSync('node', ['-p', 'process.execPath'], { env: { PATH }, encoding: 'utf8' }).stdout.trim();
  return { root, home, bin, nodeBin, log, PATH, nodeAbs, tmp: path.join(root, 'tmp'), apps: path.join(root, 'apps') };
}

function run(sb, base, args = [], extraEnv = {}) {
  fs.mkdirSync(sb.tmp, { recursive: true });
  fs.mkdirSync(sb.apps, { recursive: true });
  return spawnSync('bash', [INSTALL_SH, ...args], {
    encoding: 'utf8',
    env: { PATH: sb.PATH, HOME: sb.home, TMPDIR: sb.tmp, BATUTA_APPLICATIONS_DIR: sb.apps, BATUTA_DOWNLOAD_BASE: base, ...extraEnv },
  });
}

function tree(root) {
  const out = [];
  const walk = (p) => {
    const st = fs.lstatSync(p);
    const rel = path.relative(root, p) || '.';
    if (st.isSymbolicLink()) out.push(rel + ' -> ' + fs.readlinkSync(p));
    else if (st.isDirectory()) { out.push(rel + '/'); for (const n of fs.readdirSync(p).sort()) walk(path.join(p, n)); }
    else out.push(rel + ' ' + crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'));
  };
  walk(root);
  return out;
}
const version = (d) => fs.readFileSync(path.join(d, 'VERSION'), 'utf8').trim();
const dir = (sb) => path.join(sb.home, '.batuta-mcp');
const scriptDir = (sb) => path.join(sb.home, 'Music', 'Ableton', 'User Library', 'Remote Scripts', 'BatutaMCP');

test('bash -n accepts install.sh', () => {
  const r = spawnSync('bash', ['-n', INSTALL_SH], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('fresh install: files in ~/.batuta-mcp, Remote Script installed, claude re-registered with the absolute node and the flag', () => {
  const sb = sandbox();
  const { base } = release('1.2.3');
  const r = run(sb, base);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(version(dir(sb)), '1.2.3');
  assert.ok(fs.statSync(path.join(dir(sb), 'server', 'dist', 'src', 'bin.js')).isFile());
  assert.ok(!fs.existsSync(dir(sb) + '.previous'));
  assert.ok(fs.statSync(path.join(scriptDir(sb), '__init__.py')).isFile(), 'Remote Script installed');
  const lines = fs.readFileSync(sb.log, 'utf8').trim().split('\n');
  assert.deepEqual(lines, [
    'ARGS [mcp] [remove] [batutaMCP] [--scope] [user]',
    `ARGS [mcp] [add] [--scope] [user] [batutaMCP] [--] [${sb.nodeAbs}] [--disallow-code-generation-from-strings] [${dir(sb)}/server/dist/src/bin.js]`,
  ]);
  assert.match(r.stdout, /Control Surface/);
  assert.match(r.stdout, /batuta_status/);
  assert.match(r.stdout, /clients\/claude-code/);
  assert.equal(fs.readdirSync(sb.home).filter((n) => n.includes('staging')).length, 0, 'no staging leftovers');
  assert.equal(fs.readdirSync(sb.tmp).length, 0, 'temp download dir cleaned');
});

test('claude remove failing (not registered yet) is ignored', () => {
  const sb = sandbox({ claudeExit: 1 });
  const r = run(sb, release('1.2.3').base);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.readFileSync(sb.log, 'utf8').trim().split('\n').length, 2);
});

test('claude absent: prints the registration command and the Claude Desktop hint', () => {
  const sb = sandbox({ claude: false });
  const r = run(sb, release('1.2.3').base);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(!fs.existsSync(sb.log));
  assert.ok(r.stdout.includes(`claude mcp add --scope user batutaMCP -- '${sb.nodeAbs}' --disallow-code-generation-from-strings '${dir(sb)}/server/dist/src/bin.js'`), r.stdout);
  assert.doesNotMatch(r.stdout, /claude_desktop_config/, 'Desktop is absent, so no Desktop output');
});

test('upgrade: same command swaps in the new version and keeps the old one as .previous (replacing an older previous)', () => {
  const sb = sandbox();
  assert.equal(run(sb, release('1.2.3').base).status, 0);
  const second = run(sb, release('1.2.4').base);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.equal(version(dir(sb)), '1.2.4');
  assert.equal(version(dir(sb) + '.previous'), '1.2.3');
  assert.match(second.stdout, /1\.2\.3/);
  const third = run(sb, release('1.2.5').base);
  assert.equal(third.status, 0, third.stdout + third.stderr);
  assert.equal(version(dir(sb)), '1.2.5');
  assert.equal(version(dir(sb) + '.previous'), '1.2.4', 'older previous replaced');
});

test('bad sha256: refuses and changes nothing', () => {
  const sb = sandbox();
  const { out, base } = release('1.2.3');
  fs.writeFileSync(path.join(out, 'batuta-mcp.tar.gz.sha256'), '0'.repeat(64) + '  batuta-mcp.tar.gz\n');
  const before = tree(sb.home);
  const r = run(sb, base);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /sha-?256|checksum/i);
  assert.deepEqual(tree(sb.home), before);
  assert.ok(!fs.existsSync(sb.log));
});

test('bad sha256 on an existing install leaves it untouched', () => {
  const sb = sandbox();
  assert.equal(run(sb, release('1.2.3').base).status, 0);
  const { out, base } = release('1.2.4');
  fs.writeFileSync(path.join(out, 'batuta-mcp.tar.gz.sha256'), 'f'.repeat(64) + '  batuta-mcp.tar.gz\n');
  const before = tree(sb.home);
  assert.notEqual(run(sb, base).status, 0);
  assert.deepEqual(tree(sb.home), before);
});

test('an archive entry with .. is refused even with a matching checksum', () => {
  const sb = sandbox();
  const out = mkTmp();
  const work = mkTmp();
  put(work, 'inner/VERSION', '9.9.9\n');
  put(work, 'evil.txt', 'x\n');
  const t = spawnSync('tar', ['-czPf', path.join(out, 'batuta-mcp.tar.gz'), 'VERSION', '../evil.txt'], { cwd: path.join(work, 'inner') });
  assert.equal(t.status, 0, String(t.stderr));
  const h = crypto.createHash('sha256').update(fs.readFileSync(path.join(out, 'batuta-mcp.tar.gz'))).digest('hex');
  fs.writeFileSync(path.join(out, 'batuta-mcp.tar.gz.sha256'), `${h}  batuta-mcp.tar.gz\n`);
  const before = tree(sb.home);
  const r = run(sb, 'file://' + out);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unsafe|refus/i);
  assert.deepEqual(tree(sb.home), before);
});

test('an archive with an absolute path or a symlink entry is refused', () => {
  for (const kind of ['absolute', 'symlink']) {
    const sb = sandbox();
    const out = mkTmp();
    const work = mkTmp();
    put(work, 'VERSION', '9.9.9\n');
    let args;
    if (kind === 'absolute') {
      put(work, 'abs.txt', 'x\n');
      args = ['-czPf', path.join(out, 'batuta-mcp.tar.gz'), 'VERSION', path.join(work, 'abs.txt')];
    } else {
      fs.symlinkSync('/etc', path.join(work, 'lnk'));
      args = ['-czf', path.join(out, 'batuta-mcp.tar.gz'), 'VERSION', 'lnk'];
    }
    assert.equal(spawnSync('tar', args, { cwd: work }).status, 0);
    const h = crypto.createHash('sha256').update(fs.readFileSync(path.join(out, 'batuta-mcp.tar.gz'))).digest('hex');
    fs.writeFileSync(path.join(out, 'batuta-mcp.tar.gz.sha256'), `${h}  batuta-mcp.tar.gz\n`);
    const before = tree(sb.home);
    const r = run(sb, 'file://' + out);
    assert.notEqual(r.status, 0, kind);
    assert.deepEqual(tree(sb.home), before, kind);
  }
});

test('a symlinked target or previous dir is refused and nothing is followed', () => {
  for (const which of ['dir', 'previous']) {
    const sb = sandbox();
    const elsewhere = mkTmp();
    put(elsewhere, 'keep.txt', 'keep\n');
    fs.symlinkSync(elsewhere, which === 'dir' ? dir(sb) : dir(sb) + '.previous');
    const snapElsewhere = tree(elsewhere);
    const r = run(sb, release('1.2.3').base);
    assert.notEqual(r.status, 0, which);
    assert.match(r.stderr, /symlink/i, which);
    assert.deepEqual(tree(elsewhere), snapElsewhere, which);
    assert.ok(!fs.existsSync(sb.log), which);
  }
});

test('an existing target that is not a BatutaMCP install (no VERSION) is refused untouched', () => {
  const sb = sandbox();
  put(dir(sb), 'mine.txt', 'precious\n');
  const before = tree(sb.home);
  const r = run(sb, release('1.2.3').base);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not a BatutaMCP install|VERSION/);
  assert.deepEqual(tree(sb.home), before);
});

test('--dry-run writes nothing and says what it would do', () => {
  const sb = sandbox();
  const before = tree(sb.home);
  // A base that does not exist proves nothing is downloaded either.
  const r = run(sb, 'file:///nonexistent-batuta', ['--dry-run']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /dry run/i);
  assert.match(r.stdout, /nonexistent-batuta\/batuta-mcp\.tar\.gz/);
  assert.deepEqual(tree(sb.home), before);
  assert.deepEqual(fs.readdirSync(sb.tmp), []);
  assert.ok(!fs.existsSync(sb.log));
});

test('--version vX.Y.Z downloads the versioned asset names; a malformed version is refused', () => {
  const sb = sandbox();
  const { out, base } = release('1.2.3');
  fs.rmSync(path.join(out, 'batuta-mcp.tar.gz'));
  fs.rmSync(path.join(out, 'batuta-mcp.tar.gz.sha256'));
  const r = run(sb, base, ['--version', 'v1.2.3']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(version(dir(sb)), '1.2.3');
  const bad = run(sandbox(), base, ['--version', '1.2.3; rm -rf /']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /--version/);
});

test('--dry-run with --version prints the release/download URL', () => {
  const sb = sandbox();
  const r = run(sb, '', ['--dry-run', '--version', 'v1.2.3'], { BATUTA_DOWNLOAD_BASE: '' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /github\.com\/paulpwo\/batuta-mcp\/releases\/download\/v1\.2\.3\/batuta-mcp-v1\.2\.3\.tar\.gz/);
  const latest = run(sb, '', ['--dry-run'], { BATUTA_DOWNLOAD_BASE: '' });
  assert.match(latest.stdout, /github\.com\/paulpwo\/batuta-mcp\/releases\/latest\/download\/batuta-mcp\.tar\.gz/);
});

test('the Remote Script installer refusing (symlinked Music) fails the run and shows its message', () => {
  const sb = sandbox();
  const elsewhere = mkTmp();
  fs.symlinkSync(elsewhere, path.join(sb.home, 'Music'));
  const r = run(sb, release('1.2.3').base);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /symlink/i);
  assert.ok(!fs.existsSync(sb.log), 'claude is not registered after a failed Remote Script install');
});

test('Node older than 22.14 is refused with install help', () => {
  const sb = sandbox();
  fs.rmSync(path.join(sb.nodeBin, 'node'));
  put(sb.nodeBin, 'node', '#!/bin/sh\nexit 1\n', 0o755);
  const r = run(sb, release('1.2.3').base);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /22\.14/);
  const none = sandbox();
  fs.rmSync(path.join(none.nodeBin, 'node'));
  const r2 = run(none, release('1.2.3').base);
  assert.notEqual(r2.status, 0);
  assert.match(r2.stderr, /Node/);
});

test('unknown options are refused', () => {
  const r = run(sandbox(), 'file:///x', ['--nope']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Unknown option/);
});

// --- Claude Desktop ---------------------------------------------------------
const desktopCfg = (sb) => path.join(sb.home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
const entryFor = (sb) => ({ command: sb.nodeAbs, args: ['--disallow-code-generation-from-strings', `${dir(sb)}/server/dist/src/bin.js`] });

test('Claude Desktop present (app bundle): the config is created with the batutaMCP entry', () => {
  const sb = sandbox();
  fs.mkdirSync(path.join(sb.apps, 'Claude.app'), { recursive: true });
  const r = run(sb, release('1.2.3').base);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(desktopCfg(sb), 'utf8')), { mcpServers: { batutaMCP: entryFor(sb) } });
  assert.match(r.stdout, /quit and reopen Claude Desktop/i);
});

test('Claude Desktop found through ~/Applications, or only its config file, merges and keeps other servers', () => {
  for (const how of ['home-apps', 'config-only']) {
    const sb = sandbox();
    if (how === 'home-apps') fs.mkdirSync(path.join(sb.home, 'Applications', 'Claude.app'), { recursive: true });
    put(path.dirname(desktopCfg(sb)), 'claude_desktop_config.json', JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    const r = run(sb, release('1.2.3').base);
    assert.equal(r.status, 0, how + r.stdout + r.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(desktopCfg(sb), 'utf8')), { mcpServers: { other: { command: 'x' }, batutaMCP: entryFor(sb) } }, how);
  }
});

test('an upgrade replaces the batutaMCP entry of Claude Desktop', () => {
  const sb = sandbox();
  fs.mkdirSync(path.join(sb.apps, 'Claude.app'), { recursive: true });
  assert.equal(run(sb, release('1.2.3').base).status, 0);
  assert.equal(run(sb, release('1.2.4').base).status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(desktopCfg(sb), 'utf8')), { mcpServers: { batutaMCP: entryFor(sb) } });
});

test('Claude Desktop absent: skipped with one info line, nothing written', () => {
  const sb = sandbox();
  const r = run(sb, release('1.2.3').base);
  assert.equal(r.status, 0);
  assert.ok(!fs.existsSync(path.join(sb.home, 'Library', 'Application Support', 'Claude')));
  assert.equal(r.stdout.split('\n').filter((l) => /Claude Desktop/.test(l)).length, 1, r.stdout);
});

test('an unreadable Claude Desktop config is left alone and the JSON block is printed instead', () => {
  const sb = sandbox();
  put(path.dirname(desktopCfg(sb)), 'claude_desktop_config.json', '{ broken');
  const r = run(sb, release('1.2.3').base);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.readFileSync(desktopCfg(sb), 'utf8'), '{ broken');
  assert.match(r.stdout, /"batutaMCP"/);
  assert.match(r.stdout, /--disallow-code-generation-from-strings/);
  assert.doesNotMatch(r.stdout, /quit and reopen Claude Desktop/i);
});

test('--dry-run mentions the Claude Desktop change and writes nothing', () => {
  const sb = sandbox();
  fs.mkdirSync(path.join(sb.apps, 'Claude.app'), { recursive: true });
  const before = tree(sb.home);
  const r = run(sb, 'file:///nonexistent-batuta', ['--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Claude Desktop/);
  assert.match(r.stdout, /claude_desktop_config\.json/);
  assert.deepEqual(tree(sb.home), before);
});
