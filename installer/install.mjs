#!/usr/bin/env node
// BatutaMCP installer. Zero dependencies, Node built-ins only, no network, no child processes.
//
// Commands: install | link | verify | status | uninstall-instructions
// Options:  --dry-run (install and link only), --home <dir> (default: the user's home; used by tests)
//
// Safety contract:
//   * Writes only under <home>/Music/Ableton/User Library/: Remote Scripts/BatutaMCP (the package)
//     and BatutaMCP-previous/ (staging and archived old versions, outside Remote Scripts).
//   * Never removes anything. An upgrade renames the old directory into BatutaMCP-previous/.
//   * `link` (development) makes Remote Scripts/BatutaMCP a symlink to this checkout's package source;
//     an own copy install, or the link itself on a later `install`, is renamed into BatutaMCP-previous/.
//     Only that final entry may be our own link; every parent component must still be a real directory.
//   * The new version is staged in BatutaMCP-previous/.staging-<random> and goes live by one rename.
//   * Refuses symlinked or foreign-owned path components, foreign targets and user-modified installs.
//   * Never touches sibling Remote Scripts.
//
// Code constraints, enforced by a static test (installer/test/install.test.mjs): only a fixed set of
// fs members, file content written only through openSync(path, 'wx') plus fd writes, no computed
// member access, no dynamic code, no process or network modules.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const DEFAULT_SRC = path.join(REPO_ROOT, 'remote_script', 'BatutaMCP');

export const MANIFEST_NAME = 'BATUTA_MANIFEST.json';
export const MANIFEST_SCHEMA = 'batutamcp.manifest/1';
const SCRIPT_NAME = 'BatutaMCP';
const PREVIOUS_DIR = 'BatutaMCP-previous';
const PATH_PARTS = ['Music', 'Ableton', 'User Library', 'Remote Scripts', SCRIPT_NAME];
const WORD_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_';

function onlyChars(str, allowed) {
  for (const ch of str) if (!allowed.includes(ch)) return false;
  return true;
}
/** A top-level Python module file name: word characters plus ".py". */
function isSafeFile(n) {
  return typeof n === 'string' && n.length > 3 && n.endsWith('.py') && onlyChars(n.slice(0, -3), WORD_CHARS);
}
/** Versions: 1 to 32 characters of letters, digits and . + - */
function isSafeVersion(v) {
  return typeof v === 'string' && v.length >= 1 && v.length <= 32 && onlyChars(v, ('' + (WORD_CHARS.slice(0, 62)) + '.+-'));
}
function isSha256Hex(h) {
  return typeof h === 'string' && h.length === 64 && onlyChars(h, '0123456789abcdef');
}
const MANIFEST_MAX_BYTES = 64 * 1024;

export class InstallerError extends Error {
  name = 'InstallerError';
  code = 'error';
}

function fail(code, message) {
  const e = new InstallerError(message);
  e.code = code;
  return e;
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function lstatOrNull(p) {
  try {
    return fs.lstatSync(p);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

/** Create a new file (fails if it exists), write through the descriptor, mode 0644. */
function writeNew(fp, buf) {
  const fd = fs.openSync(fp, 'wx', 0o644);
  try {
    fs.fchmodSync(fd, 0o644);
    let off = 0;
    while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Set the mode of a directory through a descriptor (mkdir's mode is filtered by the umask). */
export const _testHooks = { afterOpenDir: null };

function setDirMode(p, mode) {
  const fd = fs.openSync(p, 'r');
  try {
    if (_testHooks.afterOpenDir) _testHooks.afterOpenDir(p);
    // The descriptor must still be the directory the path names now (no swap between open and fchmod).
    const viaFd = fs.fstatSync(fd);
    const viaPath = lstatOrNull(p);
    if (!viaFd.isDirectory() || !viaPath || viaPath.isSymbolicLink() || !viaPath.isDirectory() || viaFd.dev !== viaPath.dev || viaFd.ino !== viaPath.ino) {
      throw fail('unsafe_path', ('Refusing: ' + (p) + ' changed while its permissions were being set.'));
    }
    fs.fchmodSync(fd, mode);
  } finally {
    fs.closeSync(fd);
  }
}

function makeDir(p) {
  fs.mkdirSync(p, { mode: 0o755 });
  setDirMode(p, 0o755);
}

function resolveHome(home) {
  const h = home ?? os.homedir();
  if (typeof h !== 'string' || !path.isAbsolute(h)) {
    throw fail('bad_home', ('Home directory must be an absolute path, got: ' + (String(h))));
  }
  const st = lstatOrNull(h);
  if (!st || !st.isDirectory()) {
    throw fail('bad_home', ('Home directory does not exist: ' + (h)));
  }
  return h;
}

function paths(home) {
  const chain = [];
  let cur = home;
  for (const part of PATH_PARTS) {
    cur = path.join(cur, part);
    chain.push(cur);
  }
  // Archive and staging root: outside Remote Scripts, so Live never lists or loads anything in it.
  const prevRoot = path.join(chain.at(2), PREVIOUS_DIR);
  return { chain, scripts: chain.at(-2), target: chain.at(-1), prevRoot };
}

/** Extract X from a line like `SCRIPT_VERSION = "X"` (either quote); 'unknown' when absent or unsafe. */
function parseScriptVersion(text) {
  const at = text.indexOf('SCRIPT_VERSION');
  if (at < 0) return 'unknown';
  let rest = text.slice(at + 'SCRIPT_VERSION'.length).trimStart();
  if (!rest.startsWith('=')) return 'unknown';
  rest = rest.slice(1).trimStart();
  const q = rest.at(0);
  if (q !== '"' && q !== "'") return 'unknown';
  const end = rest.indexOf(q, 1);
  const v = end > 0 ? rest.slice(1, end) : '';
  return isSafeVersion(v) ? v : 'unknown';
}

/** Read the package's top-level .py files (regular files only). */
export function readSource(srcDir = DEFAULT_SRC) {
  let entries;
  try {
    entries = fs.readdirSync(srcDir, { withFileTypes: true });
  } catch {
    throw fail('bad_source', ('Cannot read package source: ' + (srcDir)));
  }
  const files = new Map();
  for (const ent of entries) {
    if (!ent.isFile() || !isSafeFile(ent.name)) continue;
    files.set(ent.name, fs.readFileSync(path.join(srcDir, ent.name)));
  }
  if (!files.has('__init__.py')) {
    throw fail('bad_source', ('Package source has no __init__.py: ' + (srcDir)));
  }
  const names = [...files.keys()].sort();
  const hashes = new Map(names.map((n) => [n, sha256(files.get(n))]));
  const limits = files.has('limits.py') ? files.get('limits.py').toString('utf8') : '';
  const version = parseScriptVersion(limits);
  return { files, names, hashes, version };
}

/** True when p is a symlink whose resolved target is exactly `real` (the realpath of the package source). */
function isOurLink(p, real) {
  const st = lstatOrNull(p);
  if (!st || !st.isSymbolicLink() || !real) return false;
  try {
    return fs.realpathSync(p) === real;
  } catch {
    return false; // dangling or looping link
  }
}

/** The realpath of the package source, or null when it cannot be resolved. */
function sourceReal(srcDir) {
  try {
    return fs.realpathSync(srcDir);
  } catch {
    return null;
  }
}

/** Every existing component must be a real directory owned by the user. `ownLink` {path, real} lets that one entry be our link. */
function checkChain(chain, uid, ownLink = null) {
  for (const p of chain) {
    const st = lstatOrNull(p);
    if (!st) return;
    if (ownLink && p === ownLink.path && isOurLink(p, ownLink.real)) return;
    if (st.isSymbolicLink()) {
      throw fail('unsafe_path', ('Refusing: ' + (p) + ' is a symlink.'));
    }
    if (!st.isDirectory()) {
      throw fail('unsafe_path', ('Refusing: ' + (p) + ' is not a directory.'));
    }
    if (st.uid !== uid) {
      throw fail('unsafe_path', ('Refusing: ' + (p) + ' is not owned by the current user (owner uid ' + (st.uid) + ', expected ' + (uid) + ').'));
    }
  }
}

/** Parse and validate the manifest of an existing target. Returns {manifest} or {problem}. */
function readManifest(target) {
  const mp = path.join(target, MANIFEST_NAME);
  const st = lstatOrNull(mp);
  if (!st || !st.isFile()) return { problem: ('no ' + (MANIFEST_NAME)) };
  if (st.size > MANIFEST_MAX_BYTES) return { problem: ('' + (MANIFEST_NAME) + ' is larger than ' + (MANIFEST_MAX_BYTES) + ' bytes') };
  let m;
  try {
    m = JSON.parse(fs.readFileSync(mp, 'utf8'));
  } catch {
    return { problem: ('' + (MANIFEST_NAME) + ' is not valid JSON') };
  }
  if (!m || m.schema !== MANIFEST_SCHEMA || typeof m.files !== 'object' || m.files === null || Array.isArray(m.files)) {
    return { problem: ('' + (MANIFEST_NAME) + ' has an unknown schema') };
  }
  if (!isSafeVersion(m.version)) {
    return { problem: ('' + (MANIFEST_NAME) + ' has an invalid version') };
  }
  const files = new Map(Object.entries(m.files));
  for (const [n, h] of files) {
    if (!isSafeFile(n) || !isSha256Hex(h)) {
      return { problem: ('' + (MANIFEST_NAME) + ' lists an invalid entry') };
    }
  }
  return { manifest: { version: m.version, installedAt: typeof m.installed_at === 'string' ? m.installed_at : null, files } };
}

/** Differences between an install directory and its manifest (empty when pristine). */
function manifestProblems(target, manifest) {
  const problems = [];
  for (const [n, h] of manifest.files) {
    const st = lstatOrNull(path.join(target, n));
    if (!st || !st.isFile()) problems.push(('' + (n) + ': missing'));
    else if (sha256(fs.readFileSync(path.join(target, n))) !== h) problems.push(('' + (n) + ': hash differs from manifest'));
  }
  for (const ent of fs.readdirSync(target)) {
    if (ent === MANIFEST_NAME || manifest.files.has(ent)) continue;
    const st = lstatOrNull(path.join(target, ent));
    // Live and macOS add these on their own; anything else, or a different type, is a user change.
    if (ent === '__pycache__' && st && st.isDirectory()) continue;
    if (ent === '.DS_Store' && st && st.isFile()) continue;
    problems.push(('' + (ent) + ': not listed in manifest'));
  }
  return problems;
}

function inspectTarget(target, ownReal = null) {
  const st = lstatOrNull(target);
  if (!st) return { state: 'absent' };
  if (isOurLink(target, ownReal)) return { state: 'link' };
  if (st.isSymbolicLink()) throw fail('unsafe_path', ('Refusing: ' + (target) + ' is a symlink.'));
  if (!st.isDirectory()) throw fail('foreign_target', ('Refusing: ' + (target) + ' exists and is not a directory.'));
  const { manifest, problem } = readManifest(target);
  if (!manifest) {
    throw fail('foreign_target', ('Refusing: ' + (target) + ' already exists and is not a BatutaMCP install (' + (problem) + '). Move it away yourself if you want to replace it. Nothing was changed.'));
  }
  const problems = manifestProblems(target, manifest);
  if (problems.length) {
    throw fail('modified_target', ('Refusing: the installed BatutaMCP at ' + (target) + ' was modified after install (' + (problems.join('; ')) + '). Nothing was changed. Move the folder aside yourself, then run install again.'));
  }
  return { state: 'ours', manifest };
}

function utcStamp(d = new Date()) {
  return ('' + (d.toISOString().slice(0, 19).split('-').join('').split(':').join('')) + 'Z');
}

function sameFiles(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

/** The staged directory must hold exactly the planned regular files before it goes live. */
function checkStaged(tmp, expectedNames) {
  const expected = new Set(expectedNames);
  const found = fs.readdirSync(tmp);
  for (const n of found) {
    const st = fs.lstatSync(path.join(tmp, n));
    if (!expected.has(n) || !st.isFile() || st.isSymbolicLink()) {
      throw fail('write_failed', ('Staged entry ' + (n) + ' in ' + (tmp) + ' is unexpected or not a regular file.'));
    }
  }
  if (found.length !== expected.size) {
    throw fail('write_failed', ('Staged directory ' + (tmp) + ' is incomplete.'));
  }
}

/**
 * Put the staged entry `tmp` (a directory, or the staged link) live at `target`. A current entry is first
 * renamed into prevRoot as `<prefix>-<UTC time>`; a failed swap puts it back.
 */
function goLive({ tmp, target, prevRoot, prefix, hasCurrent }) {
  let previous;
  if (hasCurrent) {
    const stamp = utcStamp();
    previous = path.join(prevRoot, ('' + (prefix) + '-' + (stamp)));
    for (let i = 2; lstatOrNull(previous); i++) previous = path.join(prevRoot, ('' + (prefix) + '-' + (stamp) + '-' + (i)));
    try {
      fs.renameSync(target, /* dest-absent */ previous);
    } catch (e) {
      throw fail('write_failed', ('Upgrade aborted: could not move the old version aside (' + (e.message) + '). The old install is still in place; the new version is staged at ' + (tmp) + '.'));
    }
    try {
      fs.renameSync(tmp, /* dest-absent */ target);
    } catch (e) {
      try {
        fs.renameSync(previous, /* dest-absent */ target);
      } catch (e2) {
        throw fail('write_failed', ('Upgrade failed (' + (e.message) + ') and putting the old version back also failed (' + (e2.message) + '). The old version is at ' + (previous) + '; the new one is staged at ' + (tmp) + '. Move ' + (previous) + ' back to ' + (target) + ' yourself.'));
      }
      throw fail('write_failed', ('Upgrade failed (' + (e.message) + '); the previous install was put back. The new version remains staged at ' + (tmp) + '.'));
    }
  } else {
    if (lstatOrNull(target)) throw fail('foreign_target', ('Refusing: ' + (target) + ' appeared during install. Nothing was changed; staged copy at ' + (tmp) + '.'));
    try {
      fs.renameSync(tmp, /* dest-absent */ target);
    } catch (e) {
      throw fail('write_failed', ('Install failed at the final rename (' + (e.message) + '). The staged copy is at ' + (tmp) + '.'));
    }
  }
  return previous;
}

/** Create missing parents (Music ... Remote Scripts) and the staging root, re-checking each one. */
function prepareParents(chain, prevRoot, uid) {
  for (const p of chain.slice(0, -1)) {
    if (!lstatOrNull(p)) makeDir(p);
  }
  checkChain(chain.slice(0, -1), uid);
  if (!lstatOrNull(prevRoot)) makeDir(prevRoot);
  checkChain([prevRoot], uid);
}

export function install({ home, srcDir = DEFAULT_SRC, dryRun = false, uid = process.getuid() } = {}) {
  const h = resolveHome(home);
  const src = readSource(srcDir);
  const real = sourceReal(srcDir);
  const { chain, target, prevRoot } = paths(h);
  checkChain(chain, uid, { path: target, real });
  checkChain([prevRoot], uid);
  const cur = inspectTarget(target, real);

  const base = { version: src.version, files: src.names, target };
  if (cur.state === 'ours' && cur.manifest.version === src.version && sameFiles(cur.manifest.files, src.hashes)) {
    return { ...base, action: 'unchanged', dryRun };
  }
  const replacing = cur.state === 'link';
  const upgrade = cur.state === 'ours';
  if (dryRun) return { ...base, action: replacing ? 'would-replace-link' : upgrade ? 'would-upgrade' : 'would-install', dryRun: true };

  let tmp;
  try {
    prepareParents(chain, prevRoot, uid);

    tmp = path.join(prevRoot, ('.staging-' + (crypto.randomBytes(6).toString('hex'))));
    makeDir(tmp);
    for (const n of src.names) writeNew(path.join(tmp, n), src.files.get(n));
    const manifest = {
      schema: MANIFEST_SCHEMA,
      name: SCRIPT_NAME,
      version: src.version,
      installed_at: new Date().toISOString(),
      files: Object.fromEntries(src.hashes),
    };
    writeNew(path.join(tmp, MANIFEST_NAME), Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
    checkStaged(tmp, [...src.names, MANIFEST_NAME]);
  } catch (e) {
    if (e instanceof InstallerError && e.code === 'unsafe_path') throw e;
    const where = tmp ? (' Partial staging may remain at ' + (tmp) + ' (outside Remote Scripts, so Live ignores it); move it to the Trash.') : '';
    throw fail('write_failed', ('Install aborted before anything went live: ' + (e.message) + '. The existing install was not touched.' + (where)));
  }

  const previous = goLive({ tmp, target, prevRoot, prefix: replacing ? (SCRIPT_NAME + '-link') : SCRIPT_NAME, hasCurrent: upgrade || replacing });
  return { ...base, action: replacing ? 'replaced-link' : upgrade ? 'upgraded' : 'installed', dryRun: false, previous };
}

/** Development mode: make Remote Scripts/BatutaMCP a symlink to the package source of this checkout. */
export function link({ home, srcDir = DEFAULT_SRC, dryRun = false, uid = process.getuid() } = {}) {
  const h = resolveHome(home);
  const src = readSource(srcDir);
  const real = sourceReal(srcDir);
  const { chain, target, prevRoot } = paths(h);
  checkChain(chain, uid, { path: target, real });
  checkChain([prevRoot], uid);
  const cur = inspectTarget(target, real);

  const base = { version: src.version, target, linkTarget: real };
  if (cur.state === 'link') return { ...base, action: 'already-linked', dryRun };
  const archive = cur.state === 'ours';
  if (dryRun) return { ...base, action: archive ? 'would-archive-and-link' : 'would-link', dryRun: true };

  let tmp;
  try {
    prepareParents(chain, prevRoot, uid);
    tmp = path.join(prevRoot, ('.staging-' + (crypto.randomBytes(6).toString('hex'))));
    fs.symlinkSync(real, tmp);
    if (fs.readlinkSync(tmp) !== real) throw fail('write_failed', ('staged link ' + (tmp) + ' does not point at ' + (real)));
  } catch (e) {
    if (e instanceof InstallerError && e.code === 'unsafe_path') throw e;
    const where = tmp ? (' A staged link may remain at ' + (tmp) + ' (outside Remote Scripts, so Live ignores it); move it to the Trash.') : '';
    throw fail('write_failed', ('Link aborted before anything went live: ' + (e.message) + '. The existing install was not touched.' + (where)));
  }

  const previous = goLive({ tmp, target, prevRoot, prefix: SCRIPT_NAME, hasCurrent: archive });
  // Whatever happened, what is live now must be the link we intended.
  const st = lstatOrNull(target);
  if (!st || !st.isSymbolicLink() || fs.readlinkSync(target) !== real || !isOurLink(target, real)) {
    throw fail('write_failed', ('Link check failed: ' + (target) + ' does not point at ' + (real) + ' after linking.' + (previous ? (' The previous install is at ' + (previous) + '.') : '')));
  }
  return { ...base, action: archive ? 'archived-and-linked' : 'linked', dryRun: false, previous };
}

export function verify({ home, srcDir = DEFAULT_SRC, uid = process.getuid() } = {}) {
  const h = resolveHome(home);
  const { chain, target } = paths(h);
  const problems = [];
  const notes = [];
  const real = sourceReal(srcDir);
  try {
    checkChain(chain, uid, { path: target, real });
  } catch (e) {
    return { ok: false, target, problems: [e.message], notes };
  }
  const st = lstatOrNull(target);
  if (!st) return { ok: false, target, problems: ['not installed'], notes };
  if (st.isSymbolicLink()) return { ok: true, linked: true, target, linkTarget: real, problems, notes };
  const { manifest, problem } = readManifest(target);
  if (!manifest) return { ok: false, target, problems: [('' + (problem) + '; not a BatutaMCP install')], notes };
  problems.push(...manifestProblems(target, manifest));
  const pc = lstatOrNull(path.join(target, '__pycache__'));
  if (pc && pc.isSymbolicLink()) problems.push('__pycache__: is a symlink');
  else if (pc && !pc.isDirectory()) problems.push('__pycache__: is not a directory');
  else if (pc) notes.push(('__pycache__: directory with ' + (fs.readdirSync(path.join(target, '__pycache__')).length) + ' entries (created by Live; informational, not verified)'));
  const src = readSource(srcDir);
  for (const n of src.names) {
    const s = lstatOrNull(path.join(target, n));
    if (!s || !s.isFile()) problems.push(('' + (n) + ': missing from install (present in package)'));
    else if (sha256(fs.readFileSync(path.join(target, n))) !== src.hashes.get(n)) problems.push(('' + (n) + ': differs from package source'));
  }
  for (const n of manifest.files.keys()) {
    if (!src.hashes.has(n)) problems.push(('' + (n) + ': installed but not in package source'));
  }
  const uniq = [...new Set(problems)];
  return { ok: uniq.length === 0, target, version: manifest.version, problems: uniq, notes };
}

export function status({ home, srcDir = DEFAULT_SRC, uid = process.getuid() } = {}) {
  const h = resolveHome(home);
  const { chain, target } = paths(h);
  const real = sourceReal(srcDir);
  checkChain(chain, uid, { path: target, real });
  const out = { target, installed: false, manifestOk: false, version: null, packageVersion: null, runtime: {} };
  try {
    out.packageVersion = readSource(srcDir).version;
  } catch { /* package may be absent when run from an odd checkout */ }
  const st = lstatOrNull(target);
  if (st && st.isSymbolicLink()) {
    out.linked = true;
    out.linkTarget = fs.readlinkSync(target);
    out.linkTargetExists = lstatOrNull(out.linkTarget) !== null;
  } else if (st && st.isDirectory()) {
    out.installed = true;
    const { manifest, problem } = readManifest(target);
    if (manifest) {
      out.version = manifest.version;
      out.installedAt = manifest.installedAt;
      const problems = manifestProblems(target, manifest);
      out.manifestOk = problems.length === 0;
      out.problems = problems;
    } else {
      out.problems = [problem];
    }
  }
  const rt = path.join(h, 'Library', 'Application Support', SCRIPT_NAME);
  const r = { dir: rt, exists: false, permsOk: false, token: false, tokenPermsOk: false, socket: false };
  const rst = lstatOrNull(rt);
  if (rst) {
    r.exists = true;
    r.permsOk = rst.isDirectory() && !rst.isSymbolicLink() && rst.uid === uid && (rst.mode & 0o077) === 0 && (rst.mode & 0o700) === 0o700;
    const tst = lstatOrNull(path.join(rt, 'token'));
    if (tst) {
      r.token = true;
      r.tokenPermsOk = tst.isFile() && tst.uid === uid && (tst.mode & 0o077) === 0 && tst.size === 64;
    }
    const sst = lstatOrNull(path.join(rt, 'live.sock'));
    r.socket = !!sst && sst.isSocket();
  }
  out.runtime = r;
  return out;
}

/** The server binary built from this checkout, if any: {path, executable}. */
function binInfo() {
  const bin = path.join(REPO_ROOT, 'server', 'dist', 'src', 'bin.js');
  const st = lstatOrNull(bin);
  if (!st || !st.isFile()) return null;
  return { path: bin, executable: (st.mode & 0o111) !== 0 };
}

/** Single-quote a path for a POSIX shell. */
function shq(s) {
  return ('\'' + (s.split(('\'')).join(('\'\\\'\''))) + '\'');
}

export function nextSteps({ bin = binInfo(), node = process.execPath, linked = false } = {}) {
  const binPath = bin ? shq(bin.path) : '<absolute path to server/dist/src/bin.js>';
  const lines = [
    '',
    'Next steps (manual; this installer changes nothing else):',
    '  1. In Live: Settings > Link, Tempo & MIDI > Control Surface: choose "BatutaMCP"',
    '     (Input: None, Output: None). Restart Live if it was already running.',
    ...(linked ? [
      '     Link mode: Live runs whatever is in the repo folder right now. After each change, quit Live (Cmd-Q) and',
      '     reopen it: reselecting BatutaMCP in Control Surface reuses the code already loaded and does not reload it.',
      '     Live writes __pycache__ into the repo folder (git-ignored).',
    ] : []),
    '     The Remote Script creates ~/Library/Application Support/BatutaMCP/ (socket + token) when it loads.',
    '  2. Register the MCP server (not run for you):' + (bin ? '' : ' (build the server first, see README)'),
    ('       claude mcp add --scope user batutaMCP -- ' + (shq(node)) + ' --disallow-code-generation-from-strings ' + binPath),
    '     This starts the server with the absolute path of the node that ran this installer, so it works',
    '     even when node is not on Claude Code\'s PATH (nvm, fnm, asdf), and it always passes',
    '     --disallow-code-generation-from-strings. Re-run the installer under another node to change it.',
  ];
  if (bin) {
    lines.push(
      '     Fallback, only if node is on the PATH of your MCP client: launch the binary itself (its shebang',
      '     passes the same flag).',
    );
    if (!bin.executable) lines.push('       chmod 755 ' + (shq(bin.path)) + '    (tsc does not set the +x bit)');
    lines.push('       claude mcp add --scope user batutaMCP -- ' + (shq(bin.path)));
  }
  // Claude Code transport bar: print only, the installer never runs `claude`.
  const market = shq(path.join(REPO_ROOT, 'clients', 'claude-code'));
  lines.push(
    '     Claude Code transport bar (optional, not run for you): a bar above the prompt with transport buttons;',
    '     it shows only while Live answers.',
    '       claude plugin marketplace add ' + market,
    '       claude plugin install batuta-transport@batuta --scope user',
  );
  // Claude Desktop: print only. The installer never reads or writes that file.
  const desktop = JSON.stringify({
    mcpServers: { batutaMCP: { command: node, args: ['--disallow-code-generation-from-strings', bin ? bin.path : '<absolute path to server/dist/src/bin.js>'] } },
  }, null, 2);
  lines.push(
    '     Claude Desktop (macOS): merge the `batutaMCP` entry below into the `mcpServers` object of',
    '     ~/Library/Application Support/Claude/claude_desktop_config.json (this installer does not touch that file),',
    '     then fully quit and reopen Claude Desktop:',
    ...desktop.split('\n').map((l) => '       ' + l),
  );
  lines.push(
    '  3. Optional, owner-specific: ~/.claude/scripts/sync-mcp-tp.sh syncs the personal Claude account\'s MCP servers to tp-claude.',
    '  4. Keep `batuta_confirm` on "ask" in your client permissions (see README, security model).',
  );
  return lines;
}

export function uninstallInstructions({ home } = {}) {
  const h = resolveHome(home);
  const { target, prevRoot } = paths(h);
  return [
    'Uninstall BatutaMCP (manual; the installer never deletes anything):',
    '  1. In Live: Settings > Link, Tempo & MIDI > Control Surface: set every slot that shows "BatutaMCP" to None.',
    '  2. Quit Live.',
    ('  3. Move this folder to the Trash (Finder: drag it, or select it and press Cmd-Backspace):'),
    ('       ' + (target)),
    ('     Also the archive of old versions, if present: ' + (prevRoot)),
    '  4. Remove the MCP registration:',
    '       claude mcp remove batutaMCP --scope user',
    '     (and run ~/.claude/scripts/sync-mcp-tp.sh if you use the tp-claude account).',
    ('  5. Optional: move ' + (path.join(h, 'Library', 'Application Support', SCRIPT_NAME)) + ' to the Trash (socket, token, server.json).'),
    '  Do not touch the other folders in Remote Scripts; they are separate.',
  ];
}

// ---------------------------------------------------------------- CLI

const USAGE = 'Usage: node install.mjs <install|link|verify|status|uninstall-instructions> [--dry-run] [--home <dir>]';

function parseArgs(argv) {
  const a = { cmd: null, dryRun: false, home: undefined };
  for (let i = 0; i < argv.length; i++) {
    const t = argv.at(i);
    if (t === '--dry-run') a.dryRun = true;
    else if (t === '--home') {
      i += 1;
      a.home = argv.at(i);
      if (!a.home) throw fail('usage', '--home needs a directory');
    } else if (t.startsWith('-')) throw fail('usage', ('Unknown option: ' + (t)));
    else if (a.cmd === null) a.cmd = t;
    else throw fail('usage', ('Unexpected argument: ' + (t)));
  }
  if (!['install', 'link', 'verify', 'status', 'uninstall-instructions'].includes(a.cmd)) {
    throw fail('usage', a.cmd ? ('Unknown command: ' + (a.cmd)) : 'Missing command');
  }
  if (a.dryRun && a.cmd !== 'install' && a.cmd !== 'link') throw fail('usage', '--dry-run applies to install and link only');
  return a;
}

function verbOf(action) {
  switch (action) {
    case 'installed': return 'Installed';
    case 'upgraded': return 'Upgraded';
    case 'replaced-link': return 'Replaced the development link with a copy install of';
    case 'unchanged': return 'Already up to date';
    case 'would-replace-link': return 'Would replace the development link with a copy install of';
    case 'would-install': return 'Would install';
    default: return 'Would upgrade';
  }
}

function linkVerbOf(action) {
  switch (action) {
    case 'linked': return 'Linked';
    case 'archived-and-linked': return 'Archived the installed copy and linked';
    case 'would-link': return 'Would link';
    default: return 'Would archive the installed copy and link';
  }
}

export function main(argv, out = (s) => process.stdout.write(s + '\n'), err = (s) => process.stderr.write(s + '\n')) {
  let a;
  try {
    a = parseArgs(argv);
  } catch (e) {
    err(e.message);
    err(USAGE);
    return 2;
  }
  try {
    if (a.cmd === 'install') {
      const r = install({ home: a.home, dryRun: a.dryRun });
      if (a.dryRun) out('Dry run: nothing was written.');
      out(('' + (verbOf(r.action)) + ' BatutaMCP ' + (r.version) + ' at ' + (r.target)));
      out(('Files (' + (r.files.length) + '): ' + (r.files.join(', '))));
      if (r.previous) {
        out(('Previous version kept at: ' + (r.previous)));
        out('  It lives outside Remote Scripts on purpose (Live would list it, and a second copy would fight for the socket). Move it to the Trash when you no longer need it.');
      }
      for (const l of nextSteps()) out(l);
      return 0;
    }
    if (a.cmd === 'link') {
      const r = link({ home: a.home, dryRun: a.dryRun });
      if (a.dryRun) out('Dry run: nothing was written.');
      if (r.action === 'already-linked') {
        out(('Already linked: ' + (r.target) + ' -> ' + (r.linkTarget)));
        return 0;
      }
      const verb = linkVerbOf(r.action);
      out(('' + (verb) + ' BatutaMCP ' + (r.version) + ': ' + (r.target) + ' -> ' + (r.linkTarget)));
      if (r.previous) {
        out(('Previous install kept at: ' + (r.previous)));
        out('  It lives outside Remote Scripts on purpose. Move it to the Trash when you no longer need it.');
      }
      out('Development mode: Live runs the repo files as they are; `verify` cannot detect changes. Use `install` for daily use.');
      for (const l of nextSteps({ linked: true })) out(l);
      return 0;
    }
    if (a.cmd === 'verify') {
      const v = verify({ home: a.home });
      if (v.linked) {
        out(('Link mode: ' + (v.target) + ' is linked to ' + (v.linkTarget) + '. Verification does not apply (the files are the repo itself).'));
        return 0;
      }
      if (v.ok) out(('OK: ' + (v.target) + ' matches its manifest and the package source (version ' + (v.version) + ').'));
      else out(('Verification FAILED for ' + (v.target) + ':'));
      for (const p of v.problems) out(('  - ' + (p)));
      for (const n of v.notes) out(('  note: ' + (n)));
      return v.ok ? 0 : 1;
    }
    if (a.cmd === 'status') {
      const s = status({ home: a.home });
      if (s.linked) {
        out(('BatutaMCP linked to ' + (s.linkTarget) + (s.linkTargetExists ? ' (target exists)' : ' (target MISSING)')));
      } else out(s.installed ? ('BatutaMCP installed at ' + (s.target)) : ('BatutaMCP is not installed (expected at ' + (s.target) + ')'));
      if (s.installed) {
        out(('  version: ' + (s.version ?? 'unknown') + (s.installedAt ? (' (installed ' + (s.installedAt) + ')') : '')));
        out(('  files match manifest: ' + (s.manifestOk ? 'yes' : ('NO (' + ((s.problems ?? []).join('; ')) + ')'))));
      }
      if (s.packageVersion) out(('  package version: ' + (s.packageVersion)));
      const r = s.runtime;
      out(('Runtime dir ' + (r.dir) + ': ' + (r.exists ? (r.permsOk ? 'present, permissions OK (0700, yours)' : 'present, PERMISSIONS NOT OK (needs 0700, owned by you)') : 'absent (created by the Remote Script when Live loads it)')));
      if (r.exists) {
        out(('  token: ' + (r.token ? (r.tokenPermsOk ? 'present, OK' : 'present, PERMISSIONS/SIZE NOT OK') : 'absent')));
        out(('  socket: ' + (r.socket ? 'present' : 'absent')));
      }
      return 0;
    }
    for (const l of uninstallInstructions({ home: a.home })) out(l);
    return 0;
  } catch (e) {
    if (e instanceof InstallerError) {
      err(e.message);
      return 1;
    }
    throw e;
  }
}

if (path.basename(process.argv.at(1) ?? '') === 'install.mjs') {
  process.exitCode = main(process.argv.slice(2));
}
