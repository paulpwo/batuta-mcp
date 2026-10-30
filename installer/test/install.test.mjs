import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import * as inst from '../install.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INSTALL_JS = path.join(HERE, '..', 'install.mjs');
const REAL_SRC = path.join(HERE, '..', '..', 'remote_script', 'BatutaMCP');
const REAL_SRC_REAL = fs.realpathSync(REAL_SRC);

let tmpRoots = [];
let home;
let src;

function mk() {
  const d = fs.mkdtempSync('/tmp/bm-');
  tmpRoots.push(d);
  return d;
}
function target(h = home) {
  return path.join(h, 'Music', 'Ableton', 'User Library', 'Remote Scripts', 'BatutaMCP');
}
function scripts(h = home) {
  return path.dirname(target(h));
}
function prevRoot(h = home) {
  return path.join(h, 'Music', 'Ableton', 'User Library', 'BatutaMCP-previous');
}
function sha(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
/** Snapshot a tree: relative path -> {mode, mtimeMs, hash|link}. */
function snapshot(root) {
  const out = {};
  const walk = (p) => {
    const st = fs.lstatSync(p);
    const rel = path.relative(root, p) || '.';
    if (st.isSymbolicLink()) out[rel] = { link: fs.readlinkSync(p) };
    else if (st.isDirectory()) {
      out[rel] = { mode: st.mode, mtimeMs: st.mtimeMs };
      for (const n of fs.readdirSync(p).sort()) walk(path.join(p, n));
    } else out[rel] = { mode: st.mode, mtimeMs: st.mtimeMs, hash: sha(fs.readFileSync(p)) };
  };
  walk(root);
  return out;
}
function makeSource(dir) {
  fs.mkdirSync(path.join(dir, '__pycache__'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(dir, '__init__.py'), 'X = 1\n');
  fs.writeFileSync(path.join(dir, 'core.py'), 'def f():\n    return 1\n');
  fs.writeFileSync(path.join(dir, 'limits.py'), 'SCRIPT_VERSION = "9.8.7"\n');
  fs.writeFileSync(path.join(dir, '__pycache__', 'core.cpython-311.pyc'), Buffer.from([1, 2, 3]));
  fs.writeFileSync(path.join(dir, 'tests', 'test_core.py'), 'pass\n');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not python\n');
  fs.writeFileSync(path.join(dir, '.hidden.py'), 'hidden = 1\n');
}
const opts = (extra = {}) => ({ home, srcDir: src, ...extra });

beforeEach(() => {
  home = mk();
  src = mk();
  makeSource(src);
});
afterEach(() => {
  for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true });
  tmpRoots = [];
});

test('fresh install copies only top-level .py files with the right modes', () => {
  const r = inst.install(opts());
  assert.equal(r.action, 'installed');
  const names = fs.readdirSync(target()).sort();
  assert.deepEqual(names, ['BATUTA_MANIFEST.json', '__init__.py', 'core.py', 'limits.py'].sort());
  for (const n of ['__init__.py', 'core.py', 'limits.py', 'BATUTA_MANIFEST.json']) {
    assert.equal(fs.statSync(path.join(target(), n)).mode & 0o777, 0o644, n);
  }
  assert.equal(fs.statSync(target()).mode & 0o777, 0o755);
  assert.equal(fs.readFileSync(path.join(target(), 'core.py'), 'utf8'), 'def f():\n    return 1\n');
});

test('manifest records schema, version, hashes and install time', () => {
  inst.install(opts());
  const m = JSON.parse(fs.readFileSync(path.join(target(), 'BATUTA_MANIFEST.json'), 'utf8'));
  assert.equal(m.schema, 'batutamcp.manifest/1');
  assert.equal(m.version, '9.8.7');
  assert.deepEqual(Object.keys(m.files).sort(), ['__init__.py', 'core.py', 'limits.py']);
  assert.equal(m.files['core.py'], sha('def f():\n    return 1\n'));
  assert.match(m.installed_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/);
});

test('re-install of identical content is a no-op without a previous dir', () => {
  inst.install(opts());
  const before = snapshot(scripts());
  const r = inst.install(opts());
  assert.equal(r.action, 'unchanged');
  assert.deepEqual(snapshot(scripts()), before);
  assert.deepEqual(fs.readdirSync(scripts()), ['BatutaMCP']);
});

test('upgrade moves the old version to User Library/BatutaMCP-previous, never inside Remote Scripts', () => {
  inst.install(opts());
  fs.mkdirSync(path.join(target(), '__pycache__'));
  fs.writeFileSync(path.join(target(), '__pycache__', 'x.pyc'), 'pyc');
  fs.writeFileSync(path.join(src, 'core.py'), 'def f():\n    return 2\n');
  const r = inst.install(opts());
  assert.equal(r.action, 'upgraded');
  assert.match(path.basename(r.previous), /^BatutaMCP-\d{8}T\d{6}Z/);
  assert.equal(path.dirname(r.previous), prevRoot());
  assert.equal(fs.statSync(prevRoot()).mode & 0o777, 0o755);
  assert.equal(fs.readFileSync(path.join(r.previous, 'core.py'), 'utf8'), 'def f():\n    return 1\n');
  assert.equal(fs.readFileSync(path.join(target(), 'core.py'), 'utf8'), 'def f():\n    return 2\n');
  assert.ok(fs.existsSync(path.join(r.previous, '__pycache__', 'x.pyc')));
  assert.ok(!fs.existsSync(path.join(target(), '__pycache__')));
  // Remote Scripts holds only the live package; no staging or previous dir there or in the archive root
  assert.deepEqual(fs.readdirSync(scripts()), ['BatutaMCP']);
  assert.deepEqual(fs.readdirSync(prevRoot()), [path.basename(r.previous)]);
});

test('staging happens outside Remote Scripts: a failed write leaves nothing loadable there', () => {
  inst.install(opts());
  const before = snapshot(scripts());
  fs.writeFileSync(path.join(src, 'core.py'), 'v2\n');
  // make staging fail: a plain file where the staging root should be
  fs.rmSync(prevRoot(), { recursive: true });
  fs.writeFileSync(prevRoot(), 'blocker');
  assert.throws(() => inst.install(opts()), (e) => e.code === 'unsafe_path');
  assert.deepEqual(snapshot(scripts()), before);
  fs.rmSync(prevRoot());
  // fresh home: during a normal install nothing but BatutaMCP appears in Remote Scripts
  const h2 = mk();
  inst.install({ home: h2, srcDir: src });
  assert.deepEqual(fs.readdirSync(scripts(h2)), ['BatutaMCP']);
  assert.deepEqual(fs.readdirSync(prevRoot(h2)), []);
});

test('two upgrades in the same second never collide', () => {
  inst.install(opts());
  fs.writeFileSync(path.join(src, 'core.py'), 'v2\n');
  const a = inst.install(opts());
  fs.writeFileSync(path.join(src, 'core.py'), 'v3\n');
  const b = inst.install(opts());
  assert.notEqual(a.previous, b.previous);
  assert.ok(fs.existsSync(a.previous) && fs.existsSync(b.previous));
});

test('refuses when BatutaMCP-previous is a symlink or foreign-owned', () => {
  fs.mkdirSync(scripts(), { recursive: true });
  const real = mk();
  fs.symlinkSync(real, prevRoot());
  assert.throws(() => inst.install(opts()), (e) => e.code === 'unsafe_path');
  assert.deepEqual(fs.readdirSync(real), []);
  fs.rmSync(prevRoot());
  fs.mkdirSync(prevRoot());
  assert.throws(() => inst.install(opts({ uid: process.getuid() + 1 })), (e) => e.code === 'unsafe_path');
  assert.deepEqual(fs.readdirSync(prevRoot()), []);
});

test('refuses a foreign target and leaves it untouched', () => {
  fs.mkdirSync(target(), { recursive: true });
  fs.writeFileSync(path.join(target(), '__init__.py'), 'foreign\n');
  const before = snapshot(scripts());
  assert.throws(() => inst.install(opts()), (e) => e.code === 'foreign_target' && /BatutaMCP/.test(e.message));
  assert.deepEqual(snapshot(scripts()), before);
});

test('refuses a manifest with a foreign schema', () => {
  fs.mkdirSync(target(), { recursive: true });
  fs.writeFileSync(path.join(target(), 'BATUTA_MANIFEST.json'), JSON.stringify({ schema: 'other/1', files: {} }));
  const before = snapshot(scripts());
  assert.throws(() => inst.install(opts()), (e) => e.code === 'foreign_target');
  assert.deepEqual(snapshot(scripts()), before);
});

test('refuses a corrupt manifest', () => {
  fs.mkdirSync(target(), { recursive: true });
  fs.writeFileSync(path.join(target(), 'BATUTA_MANIFEST.json'), '{not json');
  assert.throws(() => inst.install(opts()), (e) => e.code === 'foreign_target');
});

test('refuses a user-modified install (changed file) and keeps it', () => {
  inst.install(opts());
  fs.appendFileSync(path.join(target(), 'core.py'), '# my edit\n');
  fs.writeFileSync(path.join(src, 'core.py'), 'new upstream\n');
  const before = snapshot(scripts());
  assert.throws(() => inst.install(opts()), (e) => e.code === 'modified_target');
  assert.deepEqual(snapshot(scripts()), before);
});

test('refuses a user-modified install (extra or missing file)', () => {
  inst.install(opts());
  fs.writeFileSync(path.join(target(), 'mine.py'), 'x = 1\n');
  assert.throws(() => inst.install(opts()), (e) => e.code === 'modified_target');
  fs.rmSync(path.join(target(), 'mine.py'));
  fs.rmSync(path.join(target(), 'core.py'));
  assert.throws(() => inst.install(opts()), (e) => e.code === 'modified_target');
});

test('refuses when a path component is a symlink', () => {
  for (const comp of ['Music', 'Music/Ableton/User Library', 'Music/Ableton/User Library/Remote Scripts']) {
    const h = mk();
    const real = mk();
    const full = path.join(h, comp);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.symlinkSync(real, full);
    assert.throws(() => inst.install({ home: h, srcDir: src }), (e) => e.code === 'unsafe_path', comp);
    assert.deepEqual(fs.readdirSync(real), [], comp);
  }
});

test('refuses when the target itself is a symlink', () => {
  const real = mk();
  fs.mkdirSync(scripts(), { recursive: true });
  fs.symlinkSync(real, target());
  assert.throws(() => inst.install(opts()), (e) => e.code === 'unsafe_path');
  assert.deepEqual(fs.readdirSync(real), []);
});

test('refuses when a component is not owned by the user', () => {
  fs.mkdirSync(scripts(), { recursive: true });
  const other = process.getuid() + 1;
  assert.throws(() => inst.install(opts({ uid: other })), (e) => e.code === 'unsafe_path' && /owner/i.test(e.message));
  assert.deepEqual(fs.readdirSync(scripts()), []);
});

test('refuses a nonexistent or relative home', () => {
  assert.throws(() => inst.install({ home: path.join(home, 'nope'), srcDir: src }), (e) => e.code === 'bad_home');
  assert.throws(() => inst.install({ home: 'relative/dir', srcDir: src }), (e) => e.code === 'bad_home');
});

test('refuses a source package without __init__.py', () => {
  fs.rmSync(path.join(src, '__init__.py'));
  assert.throws(() => inst.install(opts()), (e) => e.code === 'bad_source');
});

test('dry-run on a fresh home writes nothing', () => {
  const before = snapshot(home);
  const r = inst.install(opts({ dryRun: true }));
  assert.equal(r.action, 'would-install');
  assert.ok(!fs.existsSync(path.join(home, 'Music')));
  assert.deepEqual(snapshot(home), before);
});

test('dry-run on an upgrade writes nothing and still refuses foreign targets', () => {
  inst.install(opts());
  fs.writeFileSync(path.join(src, 'core.py'), 'v2\n');
  const before = snapshot(home);
  const r = inst.install(opts({ dryRun: true }));
  assert.equal(r.action, 'would-upgrade');
  assert.deepEqual(snapshot(home), before);
  fs.appendFileSync(path.join(target(), 'core.py'), 'edit\n');
  assert.throws(() => inst.install(opts({ dryRun: true })), (e) => e.code === 'modified_target');
});

test('verify passes on a clean install and compares against the source', () => {
  inst.install(opts());
  const v = inst.verify(opts());
  assert.equal(v.ok, true);
  assert.deepEqual(v.problems, []);
});

test('verify detects tampering, missing files, extra files and source drift', () => {
  inst.install(opts());
  fs.appendFileSync(path.join(target(), 'core.py'), 'evil\n');
  let v = inst.verify(opts());
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => /core\.py/.test(p) && /manifest/i.test(p)));

  fs.rmSync(path.join(target(), 'limits.py'));
  fs.writeFileSync(path.join(target(), 'extra.py'), 'x\n');
  v = inst.verify(opts());
  assert.ok(v.problems.some((p) => /limits\.py/.test(p) && /missing/i.test(p)));
  assert.ok(v.problems.some((p) => /extra\.py/.test(p)));

  const h2 = mk();
  inst.install({ home: h2, srcDir: src });
  fs.writeFileSync(path.join(src, '__init__.py'), 'X = 2\n');
  v = inst.verify({ home: h2, srcDir: src });
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => /__init__\.py/.test(p) && /package/i.test(p)));
});

test('verify reports not installed', () => {
  const v = inst.verify(opts());
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => /not installed/i.test(p)));
});

test('verify never modifies anything', () => {
  inst.install(opts());
  fs.appendFileSync(path.join(target(), 'core.py'), 'evil\n');
  const before = snapshot(home);
  inst.verify(opts());
  assert.deepEqual(snapshot(home), before);
});

test('sibling Remote Scripts are untouched byte for byte, on install and upgrade', () => {
  for (const name of ['OtherScript', 'AnotherScript', 'AnotherScript_X']) {
    fs.mkdirSync(path.join(scripts(), name, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(scripts(), name, '__init__.py'), `# ${name}\n`);
    fs.writeFileSync(path.join(scripts(), name, 'sub', 'data.bin'), Buffer.from([0, 1, 2, 255]));
  }
  const sib = () => ['OtherScript', 'AnotherScript', 'AnotherScript_X'].map((n) => snapshot(path.join(scripts(), n)));
  const before = sib();
  inst.install(opts());
  fs.writeFileSync(path.join(src, 'core.py'), 'v2\n');
  inst.install(opts());
  assert.deepEqual(sib(), before);
});

test('status: not installed, then installed with version; never creates the runtime dir', () => {
  let s = inst.status(opts());
  assert.equal(s.installed, false);
  assert.equal(s.runtime.exists, false);
  inst.install(opts());
  s = inst.status(opts());
  assert.equal(s.installed, true);
  assert.equal(s.version, '9.8.7');
  assert.equal(s.manifestOk, true);
  assert.equal(fs.existsSync(path.join(home, 'Library')), false);
});

test('status checks runtime dir permissions read-only', () => {
  const rt = path.join(home, 'Library', 'Application Support', 'BatutaMCP');
  fs.mkdirSync(rt, { recursive: true });
  fs.chmodSync(rt, 0o755);
  let s = inst.status(opts());
  assert.equal(s.runtime.exists, true);
  assert.equal(s.runtime.permsOk, false);
  fs.chmodSync(rt, 0o700);
  s = inst.status(opts());
  assert.equal(s.runtime.permsOk, true);
  assert.equal(s.runtime.token, false);
  fs.writeFileSync(path.join(rt, 'token'), 'a'.repeat(64), { mode: 0o600 });
  s = inst.status(opts());
  assert.equal(s.runtime.token, true);
  assert.equal(s.runtime.tokenPermsOk, true);
});

test('real package: only .py files of remote_script/BatutaMCP are planned', () => {
  const r = inst.install({ home, dryRun: true });
  const expected = fs.readdirSync(REAL_SRC).filter((n) => n.endsWith('.py') && fs.statSync(path.join(REAL_SRC, n)).isFile()).sort();
  assert.deepEqual(r.files.slice().sort(), expected);
  assert.ok(expected.includes('__init__.py'));
  assert.match(r.version, /^\d+\.\d+\.\d+/);
});

// ---------------------------------------------------------------- link mode (development)

const realSrc = () => fs.realpathSync(src);
const linkedTo = (p) => fs.lstatSync(p).isSymbolicLink() && fs.readlinkSync(p);

test('link on an empty home creates an absolute symlink to the realpath of the package source', () => {
  const r = inst.link(opts());
  assert.equal(r.action, 'linked');
  assert.equal(linkedTo(target()), realSrc());
  assert.ok(path.isAbsolute(fs.readlinkSync(target())));
  assert.equal(fs.realpathSync(target()), realSrc());
  assert.deepEqual(fs.readdirSync(scripts()), ['BatutaMCP']);
  assert.deepEqual(fs.readdirSync(prevRoot()), []); // staging name was renamed away, nothing left behind
});

test('link archives an unmodified copy install (never deletes) and then links', () => {
  inst.install(opts());
  const before = snapshot(target());
  const r = inst.link(opts());
  assert.equal(r.action, 'archived-and-linked');
  assert.equal(path.dirname(r.previous), prevRoot());
  assert.match(path.basename(r.previous), /^BatutaMCP-\d{8}T\d{6}Z/);
  assert.deepEqual(snapshot(r.previous), before);
  assert.equal(linkedTo(target()), realSrc());
});

test('link refuses a modified install and changes nothing', () => {
  inst.install(opts());
  fs.appendFileSync(path.join(target(), 'core.py'), '# mine\n');
  const before = snapshot(home);
  assert.throws(() => inst.link(opts()), (e) => e.code === 'modified_target');
  assert.deepEqual(snapshot(home), before);
});

test('link refuses a foreign folder and a foreign symlink and changes nothing', () => {
  fs.mkdirSync(target(), { recursive: true });
  fs.writeFileSync(path.join(target(), 'x.txt'), 'mine');
  let before = snapshot(home);
  assert.throws(() => inst.link(opts()), (e) => e.code === 'foreign_target');
  assert.deepEqual(snapshot(home), before);
  fs.rmSync(target(), { recursive: true });
  const other = mk();
  fs.symlinkSync(other, target());
  before = snapshot(home);
  assert.throws(() => inst.link(opts()), (e) => e.code === 'unsafe_path');
  assert.deepEqual(snapshot(home), before);
  assert.deepEqual(fs.readdirSync(other), []);
});

test('link when already linked is a no-op', () => {
  inst.link(opts());
  const before = snapshot(home);
  const r = inst.link(opts());
  assert.equal(r.action, 'already-linked');
  assert.deepEqual(snapshot(home), before);
});

test('link --dry-run writes nothing, for empty, copy-install and linked states', () => {
  let r = inst.link(opts({ dryRun: true }));
  assert.equal(r.action, 'would-link');
  assert.deepEqual(fs.readdirSync(home), []);
  inst.install(opts());
  const before = snapshot(home);
  r = inst.link(opts({ dryRun: true }));
  assert.equal(r.action, 'would-archive-and-link');
  assert.deepEqual(snapshot(home), before);
  inst.link(opts());
  const linked = snapshot(home);
  assert.equal(inst.link(opts({ dryRun: true })).action, 'already-linked');
  assert.deepEqual(snapshot(home), linked);
});

test('install replaces our link with a copy install and archives the link as BatutaMCP-link-<time>', () => {
  inst.link(opts());
  const r = inst.install(opts());
  assert.equal(r.action, 'replaced-link');
  assert.match(path.basename(r.previous), /^BatutaMCP-link-\d{8}T\d{6}Z/);
  assert.equal(path.dirname(r.previous), prevRoot());
  assert.equal(linkedTo(r.previous), realSrc());
  assert.ok(fs.lstatSync(target()).isDirectory() && !fs.lstatSync(target()).isSymbolicLink());
  assert.equal(inst.verify(opts()).ok, true);
});

test('install --dry-run over our link writes nothing; a foreign symlink is still refused by install', () => {
  inst.link(opts());
  const before = snapshot(home);
  assert.equal(inst.install(opts({ dryRun: true })).action, 'would-replace-link');
  assert.deepEqual(snapshot(home), before);
  fs.rmSync(target());
  fs.symlinkSync(mk(), target());
  assert.throws(() => inst.install(opts()), (e) => e.code === 'unsafe_path');
});

test('status reports the link target and whether it exists; verify does not apply in link mode', () => {
  inst.link(opts());
  const s = inst.status(opts());
  assert.equal(s.linked, true);
  assert.equal(s.linkTarget, realSrc());
  assert.equal(s.linkTargetExists, true);
  const v = inst.verify(opts());
  assert.equal(v.ok, true);
  assert.equal(v.linked, true);
  fs.rmSync(target()); // the CLI below uses the real package source, so link again through it
  const run = (...a) => spawnSync(process.execPath, [INSTALL_JS, ...a, '--home', home], { encoding: 'utf8' });
  assert.equal(run('link').status, 0);
  const rs = run('status');
  assert.equal(rs.status, 0);
  assert.ok(rs.stdout.includes('linked to ' + REAL_SRC_REAL), rs.stdout);
  assert.match(rs.stdout, /target exists/);
  const rv = run('verify');
  assert.equal(rv.status, 0, rv.stdout + rv.stderr);
  assert.match(rv.stdout, /does not apply/i);
});

test('parent-component symlinks are still refused by link, and nothing is written through them', () => {
  for (const comp of ['Music', 'Music/Ableton/User Library', 'Music/Ableton/User Library/Remote Scripts']) {
    const h = mk();
    const real = mk();
    const full = path.join(h, comp);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.symlinkSync(real, full);
    assert.throws(() => inst.link({ home: h, srcDir: src }), (e) => e.code === 'unsafe_path', comp);
    assert.deepEqual(fs.readdirSync(real), [], comp);
  }
  fs.mkdirSync(scripts(), { recursive: true });
  const real = mk();
  fs.symlinkSync(real, prevRoot());
  assert.throws(() => inst.link(opts()), (e) => e.code === 'unsafe_path');
  assert.deepEqual(fs.readdirSync(real), []);
});

test('a link to the package source is only accepted as the final entry', () => {
  // Remote Scripts itself being our link is still a refusal
  const h = mk();
  fs.mkdirSync(path.join(h, 'Music', 'Ableton', 'User Library'), { recursive: true });
  fs.symlinkSync(fs.realpathSync(src), path.join(h, 'Music', 'Ableton', 'User Library', 'Remote Scripts'));
  assert.throws(() => inst.link({ home: h, srcDir: src }), (e) => e.code === 'unsafe_path');
});

test('CLI: link --dry-run prints the plan, the reload note and writes nothing; link then links', () => {
  const run = (...a) => spawnSync(process.execPath, [INSTALL_JS, ...a, '--home', home], { encoding: 'utf8' });
  let r = run('link', '--dry-run');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Dry run: nothing was written/);
  assert.match(r.stdout, /Would link BatutaMCP/);
  assert.deepEqual(fs.readdirSync(home), []);
  r = run('link');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.lstatSync(target()).isSymbolicLink());
  assert.match(r.stdout, /quit Live \(Cmd-Q\) and\s+reopen it/);
  assert.match(r.stdout, /__pycache__/);
  assert.match(r.stdout, /verify` cannot detect/);
  assert.equal(spawnSync(process.execPath, [INSTALL_JS, 'status', '--dry-run'], { encoding: 'utf8' }).status, 2);
});

// ---------------------------------------------------------------- static scan (allowlist)

const ALLOWED_FS = new Set(['lstatSync', 'readdirSync', 'readFileSync', 'mkdirSync', 'openSync', 'writeSync', 'fchmodSync', 'fsyncSync', 'closeSync', 'renameSync', 'fstatSync', 'symlinkSync', 'readlinkSync', 'realpathSync']);
const ALLOWED_IMPORTS = new Set(['node:fs', 'node:os', 'node:path', 'node:crypto', 'node:url']);
const ALLOWED_PROCESS = new Set(['argv', 'stdout', 'stderr', 'getuid', 'exitCode', 'execPath']);
const ALLOWED_OPEN_FLAGS = new Set(['wx', 'r']);
const BANNED_IDENTS = [
  'getBuiltinModule', 'createRequire', 'Reflect', 'globalThis', 'global', 'constructor', 'Function', 'AsyncFunction',
  'GeneratorFunction', 'getPrototypeOf', 'setPrototypeOf', 'getOwnPropertyDescriptor', 'getOwnPropertyDescriptors', 'defineProperty', 'defineProperties', 'eval', 'require', 'fetch', 'XMLHttpRequest', 'WebSocket', 'WebAssembly', 'Proxy',
  '__proto__', 'prototype', 'binding', 'dlopen', 'mainModule', 'module', 'exports', 'child_process', 'vm',
  'worker_threads', 'cluster', 'Worker', 'Atomics', 'SharedArrayBuffer', 'setTimeout', 'setInterval', 'setImmediate',
];
const KEYWORDS_BEFORE_BRACKET = new Set(['const', 'let', 'var', 'return', 'in', 'typeof', 'case', 'else', 'yield', 'await', 'new', 'void', 'delete', 'throw', 'default', 'export', 'import', 'instanceof']);

/** Tiny JS lexer: drops comments, replaces quoted literals by "S<n>" (templates are not lexed: backticks are rejected), keeps `/* dest-absent *\/` as @DA@. */
function lex(srcText) {
  const literals = [];
  let code = '';
  let i = 0;
  if (srcText.startsWith('#!')) i = srcText.indexOf('\n');
  const n = srcText.length;
  const lit = (text) => { literals.push(text); return `"S${literals.length - 1}"`; };
  while (i < n) {
    const c = srcText[i];
    const c2 = srcText[i + 1];
    if (c === '/' && c2 === '/') { while (i < n && srcText[i] !== '\n') i++; continue; }
    if (c === '/' && c2 === '*') {
      const end = srcText.indexOf('*/', i + 2);
      const body = srcText.slice(i, end + 2);
      if (body === '/* dest-absent */') code += ' @DA@ ';
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && srcText[j] !== c) j += srcText[j] === '\\' ? 2 : 1;
      code += lit(srcText.slice(i + 1, j));
      i = j + 1;
      continue;
    }
    code += c;
    i++;
  }
  return { code, literals };
}

/** Split a balanced argument list starting right after "(" at index `from`. */
function callArgs(code, from) {
  const args = [];
  let depth = 0;
  let cur = '';
  for (let i = from; i < code.length; i++) {
    const ch = code[i];
    if ('([{'.includes(ch)) depth++;
    if (')]}'.includes(ch)) {
      if (depth === 0) { args.push(cur.trim()); return args; }
      depth--;
    }
    if (ch === ',' && depth === 0) { args.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  return args;
}

/** Returns a list of violations (empty = clean). */
function scanSource(srcText) {
  const v = [];
  const { code, literals } = lex(srcText);

  // imports: allowlisted modules only; fs only as `import fs from 'node:fs'`
  if (/\bimport\s*\(/.test(code)) v.push('dynamic import()');
  if (/\bimport\s+"S/.test(code)) v.push('bare import');
  for (const m of code.matchAll(/\bfrom\s+"S(\d+)"/g)) {
    const spec = literals[Number(m[1])];
    if (!ALLOWED_IMPORTS.has(spec)) v.push(`import of ${spec}`);
  }
  for (const m of code.matchAll(/import\s*([^;]*?)\s*from\s+"S(\d+)"/g)) {
    if (literals[Number(m[2])] === 'node:fs' && m[1].trim() !== 'fs') v.push('fs must be imported as default `fs`');
  }
  const specs = [...code.matchAll(/\bfrom\s+"S(\d+)"/g)].map((m) => literals[Number(m[1])]);
  for (const spec of new Set(specs)) {
    if (specs.filter((x) => x === spec).length > 1) v.push(`more than one import of ${spec}`);
  }
  const noImports = code.replace(/\bimport\s+fs\s+from\s+"S\d+"\s*;?/, '');
  if (/\bimport\.meta\b(?!\.url)/.test(code)) v.push('import.meta other than url');

  // fs: every bare `fs` token must be `fs.<allowlisted member>`
  for (const m of noImports.matchAll(/\bfs\b(?!\s*\.\s*\w)/g)) v.push(`bare fs reference at ${m.index}`);
  for (const m of noImports.matchAll(/\bfs\s*\.\s*(\w+)/g)) {
    if (!ALLOWED_FS.has(m[1])) v.push(`fs.${m[1]} is not allowlisted`);
  }
  for (const m of code.matchAll(/\bprocess\b(?!\s*\.\s*\w)/g)) v.push(`bare process reference at ${m.index}`);
  for (const m of code.matchAll(/\bprocess\s*\.\s*(\w+)/g)) {
    if (!ALLOWED_PROCESS.has(m[1])) v.push(`process.${m[1]} is not allowlisted`);
  }

  // A backslash outside literals means unicode-escaped identifiers; a slash outside comments and
  // literals is a regex literal or a division, which cannot be told apart reliably, so neither is allowed.
  if (code.includes('\\')) v.push('backslash outside a literal (escaped identifier)');
  if (code.includes('`')) v.push('template literal (backtick) outside a string');
  if (code.includes('?.')) v.push('optional chaining');
  if (code.includes('/')) v.push('slash outside a literal or comment (regex literal or division)');
  for (const m of code.matchAll(/\bObject\b(?!\s*\.\s*(keys|entries|fromEntries)\b)/g)) v.push(`Object use at ${m.index} is not allowlisted`);
  // banned identifiers anywhere in code
  for (const id of BANNED_IDENTS) {
    if (new RegExp(`(^|[^\\w$])${id}($|[^\\w$])`).test(code)) v.push(`banned identifier ${id}`);
  }
  // string literals naming banned things (module specifiers are checked above)
  for (const text of literals) {
    if (/prototype|__proto__|constructor|AsyncFunction|GeneratorFunction/.test(text)) v.push(`banned literal ${text}`);
    if (/child_process|node:(net|http|https|dgram|tls|dns|vm|module|worker_threads)/.test(text)) v.push(`banned literal ${text}`);
  }

  // `[`: only numeric-literal member keys, or a provable array literal / array pattern. Anything else is
  // refused (computed member access, computed object or class keys, destructuring keys).
  for (let i = 0; i < code.length; i++) {
    if (code[i] !== '[') continue;
    const before = code.slice(0, i).trimEnd();
    const last = before.at(-1) ?? '';
    const close = code.indexOf(']', i);
    const key = close < 0 ? '?' : code.slice(i + 1, close).trim();
    if (/[\w$)\].]/.test(last)) {
      const word = /([\w$]+)$/.exec(before)?.[1];
      if (word && KEYWORDS_BEFORE_BRACKET.has(word)) continue; // `const [a, b]`, `return [..]`: pattern or literal
      if (!/^\d+$/.test(key)) v.push(`computed member access [${key}]`);
      continue;
    }
    if (last === '{') { v.push('[ directly after { (computed object, class or pattern key)'); continue; }
    // Match the bracket to see what follows it; `]:` or `](` after `,` looks like a computed key.
    let depth = 0;
    let end = -1;
    for (let k = i; k < code.length; k++) {
      if (code[k] === '[') depth++;
      if (code[k] === ']' && --depth === 0) { end = k; break; }
    }
    const after = code.slice(end + 1).trimStart().at(0) ?? '';
    if (end < 0 || (last === ',' && (after === ':' || after === '('))) v.push('[ that may be a computed key');
  }

  // openSync: second argument must be the literal 'wx' or 'r'
  for (const m of code.matchAll(/\bopenSync\s*\(/g)) {
    const flag = callArgs(code, m.index + m[0].length).at(1) ?? '';
    const lm = /^"S(\d+)"$/.exec(flag);
    if (!lm || !ALLOWED_OPEN_FLAGS.has(literals[Number(lm[1])])) v.push(`openSync flag is not a literal 'wx' or 'r': ${flag}`);
  }
  // renameSync: only at call sites marked with the destination-absent comment
  for (const m of code.matchAll(/\brenameSync\s*\(/g)) {
    if (!callArgs(code, m.index + m[0].length).join(',').includes('@DA@')) v.push('renameSync without /* dest-absent */ marker');
  }
  return v;
}

test('static scan: install.mjs passes the allowlist scan', () => {
  const text = fs.readFileSync(INSTALL_JS, 'utf8');
  assert.deepEqual(scanSource(text), []);
  const { code } = lex(text);
  assert.equal([...code.matchAll(/\brenameSync\s*\(/g)].length, 4, 'exactly four guarded renames');
  const members = new Set([...code.matchAll(/\bfs\s*\.\s*(\w+)/g)].map((m) => m[1]));
  for (const m of members) assert.ok(ALLOWED_FS.has(m), m);
  // the write path: files only through openSync wx + fd writes
  assert.ok(members.has('openSync') && members.has('writeSync') && members.has('fchmodSync'));
});

test('static scan self-test: known evasions and forbidden calls are flagged', () => {
  const { snippets: bad } = JSON.parse(fs.readFileSync(path.join(HERE, 'evasions.json'), 'utf8'));
  const pre = "import fs from 'node:fs';\n";
  const unflagged = Object.entries(bad).filter(([, snippet]) => scanSource(snippet).length === 0).map(([name]) => name);
  assert.deepEqual(unflagged, [], 'these snippets must be flagged');
  const good = pre + "const fd = fs.openSync(p, 'wx', 0o644); fs.fchmodSync(fd, 0o644); fs.writeSync(fd, b, 0, 1);\nfs.renameSync(a, /* dest-absent */ b);\nconst [x, y] = arr; const z = arr.at(-1); const q = arr[0];\nconst n = process.execPath;";
  assert.deepEqual(scanSource(good), []);
  assert.ok(scanSource("const e = process.env;").length > 0, 'only the allowlisted process members pass');
  assert.ok(scanSource("const e = process.execPathX;").length > 0);
});

test('CLI: install --dry-run prints plan and the manual next steps', () => {
  const out = execFileSync(process.execPath, [INSTALL_JS, 'install', '--dry-run', '--home', home], { encoding: 'utf8' });
  assert.match(out, /dry run/i);
  assert.match(out, /Control Surface/);
  assert.match(out, /BatutaMCP/);
  const node = "'" + process.execPath.split("'").join("'\\''") + "'";
  assert.ok(out.includes('claude mcp add --scope user batutaMCP -- ' + node + ' --disallow-code-generation-from-strings '), out);
  assert.match(out, /--disallow-code-generation-from-strings '[^']*server\/dist\/src\/bin\.js'/);
  assert.doesNotMatch(out, /sync-mcp-tp|tp-claude|owner-specific/);
  assert.deepEqual(fs.readdirSync(home), []);
});

test('uninstall instructions name no personal scripts or accounts', () => {
  const out = execFileSync(process.execPath, [INSTALL_JS, 'uninstall-instructions', '--home', home], { encoding: 'utf8' });
  assert.match(out, /claude mcp remove batutaMCP --scope user/);
  assert.doesNotMatch(out, /sync-mcp-tp|tp-claude/);
});

test('CLI: real install, verify and status via --home; refusal exits 1; usage exits 2', () => {
  const run = (...a) => spawnSync(process.execPath, [INSTALL_JS, ...a, '--home', home], { encoding: 'utf8' });
  let r = run('install');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(target(), '__init__.py')));
  r = run('verify');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  r = run('status');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /installed/i);
  fs.appendFileSync(path.join(target(), '__init__.py'), '# tamper\n');
  assert.equal(run('verify').status, 1);
  assert.equal(run('install').status, 1);
  assert.equal(spawnSync(process.execPath, [INSTALL_JS, 'bogus'], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync(process.execPath, [INSTALL_JS], { encoding: 'utf8' }).status, 2);
});

test('CLI: uninstall-instructions prints manual steps and changes nothing', () => {
  const out = execFileSync(process.execPath, [INSTALL_JS, 'uninstall-instructions', '--home', home], { encoding: 'utf8' });
  assert.match(out, /Control Surface/);
  assert.match(out, /Trash/i);
  assert.match(out, /claude mcp remove batutaMCP --scope user/);
  assert.deepEqual(fs.readdirSync(home), []);
});

// ---------------------------------------------------------------- round 2 behaviors

const NODE = "/Users/me/.nvm/versions/node/v22.14.0/bin/node";
const addLine = (text) => text.split('\n').find((l) => l.includes('claude mcp add --scope user batutaMCP -- ') && l.includes(' --disallow-code-generation-from-strings'));

test('nextSteps: registration runs the absolute node binary with the code-generation flag and the absolute bin.js (works without node on PATH)', () => {
  const text = inst.nextSteps({ bin: { path: '/opt/x/server/dist/src/bin.js', executable: true }, node: NODE }).join('\n');
  assert.equal(addLine(text).trim(), "claude mcp add --scope user batutaMCP -- '/Users/me/.nvm/versions/node/v22.14.0/bin/node' --disallow-code-generation-from-strings '/opt/x/server/dist/src/bin.js'");
  assert.ok(!/chmod/.test(text), 'an executable binary needs no chmod hint');
});

test('nextSteps: both paths are single-quoted for the shell, whatever they contain', () => {
  const text = inst.nextSteps({ bin: { path: "/tmp/with space/it's/bin.js", executable: true }, node: "/tmp/n o'de/node" }).join('\n');
  assert.equal(addLine(text).trim(), "claude mcp add --scope user batutaMCP -- '/tmp/n o'\\''de/node' --disallow-code-generation-from-strings '/tmp/with space/it'\\''s/bin.js'");
});

test('nextSteps: the chmod hint is only a fallback note, after the main registration line, for a binary that is not executable', () => {
  const text = inst.nextSteps({ bin: { path: "/tmp/with space/it's/bin.js", executable: false }, node: NODE }).join('\n');
  const mainAt = text.indexOf("batutaMCP -- '" + NODE + "' --disallow-code-generation-from-strings ");
  const chmodAt = text.indexOf("chmod 755 '/tmp/with space/it'\\''s/bin.js'");
  assert.ok(mainAt >= 0 && chmodAt > mainAt, text);
  assert.match(text, /[Ff]allback/);
  // The fallback registers the binary itself and says it needs node on the client's PATH.
  assert.ok(text.indexOf("claude mcp add --scope user batutaMCP -- '/tmp/with space/it'\\''s/bin.js'") > chmodAt);
  assert.match(text, /PATH/);
});

test('nextSteps: an executable binary still gets a fallback note (without chmod); a missing build prints a placeholder path but the same node and flag', () => {
  const ok = inst.nextSteps({ bin: { path: '/opt/x/bin.js', executable: true }, node: NODE }).join('\n');
  assert.match(ok, /[Ff]allback/);
  assert.ok(ok.includes("claude mcp add --scope user batutaMCP -- '/opt/x/bin.js'"));
  const none = inst.nextSteps({ bin: null, node: NODE }).join('\n');
  assert.ok(none.includes("claude mcp add --scope user batutaMCP -- '" + NODE + "' --disallow-code-generation-from-strings <absolute path to server/dist/src/bin.js>"), none);
  assert.ok(!/chmod/.test(none));
});

const desktopBlock = (text) => {
  const lines = text.split('\n');
  const from = lines.findIndex((l) => l.trim() === '{');
  assert.ok(from >= 0, 'a JSON block is printed');
  const to = lines.findIndex((l, i) => i > from && l.trim() === '}' && l.length === lines[from].length);
  assert.ok(to > from, 'the JSON block is closed');
  return JSON.parse(lines.slice(from, to + 1).join('\n'));
};

test('nextSteps: prints a Claude Desktop JSON block with the raw node path and flag, even for paths with a space and a double quote', () => {
  const binPath = '/tmp/with space/say "hi"/bin.js';
  const node = '/tmp/n o"de/node';
  const text = inst.nextSteps({ bin: { path: binPath, executable: true }, node }).join('\n');
  assert.ok(text.includes('~/Library/Application Support/Claude/claude_desktop_config.json'), text);
  assert.match(text, /Claude Desktop/);
  const cfg = desktopBlock(text);
  assert.deepEqual(cfg, { mcpServers: { batutaMCP: { command: node, args: ['--disallow-code-generation-from-strings', binPath] } } });
});

test('nextSteps: the Claude Desktop block uses node + flag even when the server is not built (placeholder path)', () => {
  const cfg = desktopBlock(inst.nextSteps({ bin: null, node: NODE }).join('\n'));
  assert.equal(cfg.mcpServers.batutaMCP.command, NODE);
  assert.equal(cfg.mcpServers.batutaMCP.args[0], '--disallow-code-generation-from-strings');
  assert.equal(cfg.mcpServers.batutaMCP.args.length, 2);
});

test('CLI: install prints the Claude Desktop block but never creates or touches the Claude Desktop config', () => {
  const r = spawnSync(process.execPath, [INSTALL_JS, 'install', '--home', home], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(desktopBlock(r.stdout).mcpServers.batutaMCP.command, process.execPath);
  assert.ok(!fs.existsSync(path.join(home, 'Library', 'Application Support', 'Claude')));
  assert.ok(!fs.existsSync(path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')));
});

test('nextSteps: the node path defaults to the binary running the installer (process.execPath)', () => {
  const text = inst.nextSteps({ bin: { path: '/opt/x/bin.js', executable: true } }).join('\n');
  assert.ok(text.includes("-- '" + process.execPath.split("'").join("'\\''") + "' --disallow-code-generation-from-strings"), text);
});

test('nextSteps: prints the Claude Code transport bar commands with the absolute clients/claude-code path, print only', () => {
  const repo = path.resolve(HERE, '..', '..');
  const market = path.join(repo, 'clients', 'claude-code');
  const text = inst.nextSteps({ bin: { path: '/opt/x/bin.js', executable: true }, node: NODE }).join('\n');
  const q = (s) => "'" + s.split("'").join("'\\''") + "'";
  assert.ok(text.includes('claude plugin marketplace add ' + q(market)), text);
  assert.ok(text.includes('claude plugin install batuta-transport@batuta --scope user'), text);
  assert.ok(text.indexOf('claude mcp add') < text.indexOf('claude plugin marketplace add'), text);
  assert.ok(fs.existsSync(path.join(market, '.claude-plugin', 'marketplace.json')));
  // Print only: the installer must never spawn `claude`.
  const src = fs.readFileSync(INSTALL_JS, 'utf8');
  assert.ok(!/(execFileSync|spawnSync|spawn|exec)\s*\(\s*['"`]claude/.test(src));
});

test('refuses an oversized manifest and an invalid manifest version', () => {
  inst.install(opts());
  const mp = path.join(target(), 'BATUTA_MANIFEST.json');
  const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
  fs.writeFileSync(mp, JSON.stringify({ ...m, pad: 'x'.repeat(70 * 1024) }));
  assert.throws(() => inst.install(opts()), (e) => e.code === 'foreign_target' && /larger/.test(e.message));
  fs.writeFileSync(mp, JSON.stringify({ ...m, version: '1.0/../../x' }));
  assert.throws(() => inst.install(opts()), (e) => e.code === 'foreign_target' && /version/.test(e.message));
  fs.writeFileSync(mp, JSON.stringify({ ...m, version: 'v'.repeat(33) }));
  assert.throws(() => inst.install(opts()), (e) => e.code === 'foreign_target');
});

test('a symlinked __pycache__ counts as a modification and is flagged by verify', () => {
  inst.install(opts());
  const real = mk();
  fs.symlinkSync(real, path.join(target(), '__pycache__'));
  assert.throws(() => inst.install(opts()), (e) => e.code === 'modified_target' && /__pycache__/.test(e.message));
  const v = inst.verify(opts());
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => /__pycache__/.test(p)));
});

test('verify reports __pycache__ contents as an informational note only', () => {
  inst.install(opts());
  fs.mkdirSync(path.join(target(), '__pycache__'));
  fs.writeFileSync(path.join(target(), '__pycache__', 'a.pyc'), 'x');
  fs.writeFileSync(path.join(target(), '__pycache__', 'b.pyc'), 'x');
  const v = inst.verify(opts());
  assert.equal(v.ok, true);
  assert.ok(v.notes.some((n) => /__pycache__/.test(n) && /2 entries/.test(n)));
});

test('status refuses symlinked parents (read-only check)', () => {
  const real = mk();
  fs.symlinkSync(real, path.join(home, 'Music'));
  assert.throws(() => inst.status(opts()), (e) => e.code === 'unsafe_path');
  assert.deepEqual(fs.readdirSync(real), []);
});

test('directory mode is set only on the directory that was just created (swap between open and fchmod)', (t) => {
  let swapped = false;
  inst._testHooks.afterOpenDir = (p) => {
    if (swapped) return;
    swapped = true;
    fs.renameSync(p, `${p}.moved`);
    fs.mkdirSync(p);
  };
  t.after(() => { inst._testHooks.afterOpenDir = null; });
  assert.throws(() => inst.install(opts()), (e) => e.code === 'unsafe_path' && /changed while/.test(e.message));
  assert.ok(swapped);
  assert.ok(!fs.existsSync(target()));
});

test('staging mkdir failure is wrapped with guidance and leaves Remote Scripts untouched', (t) => {
  inst.install(opts());
  fs.chmodSync(prevRoot(), 0o500);
  t.after(() => { try { fs.chmodSync(prevRoot(), 0o755); } catch { /* already cleaned */ } });
  fs.writeFileSync(path.join(src, 'core.py'), 'v2\n');
  const before = snapshot(scripts());
  assert.throws(() => inst.install(opts()), (e) => e instanceof inst.InstallerError && e.code === 'write_failed' && /not touched/.test(e.message));
  assert.deepEqual(snapshot(scripts()), before);
});
