import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { REPO, mkTmp, cleanup, put } from './helpers.mjs';

afterEach(cleanup);

const HELPER = path.join(REPO, 'installer', 'claude-code-settings.mjs');

function tui(file, extra = []) {
  return spawnSync(process.execPath, [HELPER, 'tui', '--settings', file, ...extra], { encoding: 'utf8' });
}
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const backups = (f) => fs.readdirSync(path.dirname(f)).filter((n) => n.startsWith(path.basename(f) + '.bak-'));

test('sets the fullscreen renderer over another one, keeping every other key, the mode and a backup', () => {
  const dir = mkTmp();
  const file = path.join(dir, 'settings.json');
  const original = { tui: 'default', permissions: { allow: ['Bash(ls)'] }, enabledPlugins: { 'a@b': true } };
  put(dir, 'settings.json', JSON.stringify(original, null, 2), 0o600);
  const r = tui(file);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(read(file), { ...original, tui: 'fullscreen' });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'mode kept');
  const b = backups(file);
  assert.equal(b.length, 1);
  assert.deepEqual(read(path.join(dir, b[0])), original, 'backup is the original');
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes('.tmp')), []);
});

test('adds the key when absent and creates a missing file and folder', () => {
  const dir = mkTmp();
  put(dir, 'settings.json', JSON.stringify({ model: 'x' }));
  assert.equal(tui(path.join(dir, 'settings.json')).status, 0);
  assert.deepEqual(read(path.join(dir, 'settings.json')), { model: 'x', tui: 'fullscreen' });

  const fresh = path.join(mkTmp(), '.claude', 'settings.json');
  const r = tui(fresh);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(read(fresh), { tui: 'fullscreen' });
  assert.deepEqual(backups(fresh), []);
});

test('already fullscreen: nothing is written and no backup is made', () => {
  const dir = mkTmp();
  const file = path.join(dir, 'settings.json');
  const text = JSON.stringify({ tui: 'fullscreen', model: 'x' }, null, 4);
  put(dir, 'settings.json', text);
  const r = tui(file);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /already/);
  assert.equal(fs.readFileSync(file, 'utf8'), text);
  assert.deepEqual(backups(file), []);
});

test('dry run writes nothing', () => {
  const dir = mkTmp();
  const file = path.join(dir, 'settings.json');
  put(dir, 'settings.json', JSON.stringify({ tui: 'default' }));
  const r = tui(file, ['--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Would set/);
  assert.deepEqual(read(file), { tui: 'default' });
  assert.deepEqual(backups(file), []);
});

test('refuses a symlink, invalid JSON and a non-object, leaving them untouched', () => {
  const dir = mkTmp();
  put(dir, 'real.json', '{}');
  fs.symlinkSync(path.join(dir, 'real.json'), path.join(dir, 'link.json'));
  assert.equal(tui(path.join(dir, 'link.json')).status, 3);
  assert.equal(fs.readFileSync(path.join(dir, 'real.json'), 'utf8'), '{}');
  for (const [name, text] of [['bad.json', '{ nope'], ['array.json', '[]'], ['null.json', 'null']]) {
    put(dir, name, text);
    assert.equal(tui(path.join(dir, name)).status, 3, name);
    assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), text, name);
  }
});

test('usage errors exit 2', () => {
  assert.equal(spawnSync(process.execPath, [HELPER, 'nope'], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync(process.execPath, [HELPER, 'tui', '--settings', 'relative.json'], { encoding: 'utf8' }).status, 2);
});
