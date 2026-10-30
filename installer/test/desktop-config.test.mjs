import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { REPO, mkTmp, cleanup, put } from './helpers.mjs';

afterEach(cleanup);

const HELPER = path.join(REPO, 'installer', 'desktop-config.mjs');
const NODE = '/opt/x/bin/node';
const BIN = '/home/u/.batuta-mcp/server/dist/src/bin.js';
const ENTRY = { command: NODE, args: ['--disallow-code-generation-from-strings', BIN] };

function merge(cfg, extra = []) {
  return spawnSync(process.execPath, [HELPER, 'merge', '--config', cfg, '--node', NODE, '--bin', BIN, ...extra], { encoding: 'utf8' });
}
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const backups = (cfg) => fs.readdirSync(path.dirname(cfg)).filter((n) => n.startsWith(path.basename(cfg) + '.bak-'));

test('merges into an existing config, keeping every other key and server', () => {
  const dir = mkTmp();
  const cfg = path.join(dir, 'claude_desktop_config.json');
  const original = { theme: 'dark', mcpServers: { other: { command: 'x', args: ['1'] } } };
  put(dir, 'claude_desktop_config.json', JSON.stringify(original, null, 2), 0o600);
  const r = merge(cfg);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(read(cfg), { theme: 'dark', mcpServers: { other: original.mcpServers.other, batutaMCP: ENTRY } });
  assert.equal(fs.statSync(cfg).mode & 0o777, 0o600, 'mode kept');
  const b = backups(cfg);
  assert.equal(b.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, b[0]), 'utf8')), original, 'backup is the original');
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes('.tmp')), []);
});

test('creates the file and its folder when missing', () => {
  const dir = mkTmp();
  const cfg = path.join(dir, 'Claude', 'claude_desktop_config.json');
  const r = merge(cfg);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(read(cfg), { mcpServers: { batutaMCP: ENTRY } });
  assert.deepEqual(fs.readdirSync(path.dirname(cfg)), ['claude_desktop_config.json'], 'no backup when nothing existed');
});

test('adds mcpServers when the config has none', () => {
  const dir = mkTmp();
  const cfg = path.join(dir, 'c.json');
  fs.writeFileSync(cfg, '{"a":1}');
  assert.equal(merge(cfg).status, 0);
  assert.deepEqual(read(cfg), { a: 1, mcpServers: { batutaMCP: ENTRY } });
});

test('replaces an existing batutaMCP entry and leaves the others alone', () => {
  const dir = mkTmp();
  const cfg = path.join(dir, 'c.json');
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { batutaMCP: { command: 'old' }, keep: { command: 'k' } } }));
  const r = merge(cfg);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /replac/i);
  assert.deepEqual(read(cfg), { mcpServers: { batutaMCP: ENTRY, keep: { command: 'k' } } });
});

test('invalid JSON or a non-object mcpServers is refused and the file is untouched', () => {
  for (const text of ['{ not json', '[]', '{"mcpServers": []}', '{"mcpServers": "x"}', '']) {
    const dir = mkTmp();
    const cfg = path.join(dir, 'c.json');
    fs.writeFileSync(cfg, text);
    const r = merge(cfg);
    assert.equal(r.status, 3, JSON.stringify(text));
    assert.equal(fs.readFileSync(cfg, 'utf8'), text);
    assert.deepEqual(fs.readdirSync(dir), ['c.json']);
  }
});

test('a symlinked config file is refused and not followed', () => {
  const dir = mkTmp();
  const elsewhere = mkTmp();
  put(elsewhere, 'real.json', '{"mcpServers":{}}');
  const cfg = path.join(dir, 'c.json');
  fs.symlinkSync(path.join(elsewhere, 'real.json'), cfg);
  const r = merge(cfg);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /symlink/i);
  assert.equal(fs.readFileSync(path.join(elsewhere, 'real.json'), 'utf8'), '{"mcpServers":{}}');
  assert.deepEqual(fs.readdirSync(elsewhere), ['real.json']);
});

test('--dry-run reports the change and writes nothing', () => {
  const dir = mkTmp();
  const cfg = path.join(dir, 'Claude', 'c.json');
  const missing = merge(cfg, ['--dry-run']);
  assert.equal(missing.status, 0, missing.stderr);
  assert.match(missing.stdout, /would/i);
  assert.ok(!fs.existsSync(path.dirname(cfg)));
  fs.mkdirSync(path.dirname(cfg));
  fs.writeFileSync(cfg, '{"mcpServers":{}}');
  const r = merge(cfg, ['--dry-run']);
  assert.equal(r.status, 0);
  assert.equal(fs.readFileSync(cfg, 'utf8'), '{"mcpServers":{}}');
  assert.deepEqual(fs.readdirSync(path.dirname(cfg)), ['c.json']);
});

test('arguments are validated', () => {
  const dir = mkTmp();
  assert.notEqual(spawnSync(process.execPath, [HELPER, 'merge', '--config', 'rel.json', '--node', NODE, '--bin', BIN]).status, 0);
  assert.notEqual(spawnSync(process.execPath, [HELPER, 'nope']).status, 0);
  assert.deepEqual(fs.readdirSync(dir), []);
});
