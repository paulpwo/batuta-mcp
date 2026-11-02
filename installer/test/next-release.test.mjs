import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { REPO, mkTmp, cleanup, put } from './helpers.mjs';
import { bumpOf, bumpOfAll, nextVersion, updateChangelog } from '../next-release.mjs';

afterEach(cleanup);

const SCRIPT = path.join(REPO, 'installer', 'next-release.mjs');

test('each commit type asks for its bump', () => {
  assert.equal(bumpOf('feat: one-command install'), 'minor');
  assert.equal(bumpOf('feat(bar): hotkeys'), 'minor');
  assert.equal(bumpOf('fix: transport bar skips Batuta while Live is closed'), 'patch');
  for (const t of ['perf', 'refactor', 'chore', 'build', 'revert']) assert.equal(bumpOf(`${t}: x`), 'patch', t);
  assert.equal(bumpOf('Update things'), 'patch', 'a subject without a type still releases');
  for (const t of ['docs', 'test', 'ci', 'style']) assert.equal(bumpOf(`${t}: x`), 'none', t);
  assert.equal(bumpOf('chore: release 0.2.4'), 'none', "the bot's own commit");
  assert.equal(bumpOf('feat!: new protocol'), 'major');
  assert.equal(bumpOf('refactor(api)!: rename tools'), 'major');
  assert.equal(bumpOf('fix: x\n\nBREAKING CHANGE: the socket moved'), 'major');
});

test('the largest bump wins; quiet commits alone release nothing', () => {
  assert.equal(bumpOfAll(['docs: a', 'fix: b', 'feat: c']), 'minor');
  assert.equal(bumpOfAll(['docs: a', 'test: b', 'ci: c']), 'none');
  assert.equal(bumpOfAll([]), 'none');
});

test('versions rise as semver says', () => {
  assert.equal(nextVersion('0.2.3', 'patch'), '0.2.4');
  assert.equal(nextVersion('0.2.3', 'minor'), '0.3.0');
  assert.equal(nextVersion('0.2.3', 'major'), '1.0.0');
  assert.throws(() => nextVersion('v0.2.3', 'patch'));
});

const LOG = '# Changelog\n\nIntro.\n\n## [Unreleased]\n\n### Changed\n- Hand-written note.\n\n## [0.2.3] - 2026-11-02\n\n### Fixed\n- Old.\n';

test('an Unreleased section with text becomes the dated version, kept as written', () => {
  const r = updateChangelog(LOG, '0.2.4', '2026-11-03', ['fix: ignored here']);
  assert.equal(r.text, LOG.replace('## [Unreleased]', '## [0.2.4] - 2026-11-03'));
  assert.equal(r.notes, '### Changed\n- Hand-written note.\n');
});

test('without Unreleased text the section is written from the commit subjects', () => {
  const log = '# Changelog\n\n## [Unreleased]\n\n## [0.2.3] - 2026-11-02\n\n- Old.\n';
  const r = updateChangelog(log, '0.3.0', '2026-11-03', ['feat: hotkeys on the bar', 'fix(bar): stop works', 'docs: typo', 'refactor: one version source.']);
  assert.equal(r.notes, '### Added\n- Hotkeys on the bar.\n\n### Fixed\n- Stop works.\n\n### Changed\n- One version source.\n');
  assert.equal(r.text, '# Changelog\n\n## [0.3.0] - 2026-11-03\n\n' + r.notes + '\n## [0.2.3] - 2026-11-02\n\n- Old.\n');
});

function fixture() {
  const root = mkTmp();
  put(root, 'server/package.json', JSON.stringify({ name: 'x', version: '0.2.3', private: true }, null, 2) + '\n');
  put(root, 'CHANGELOG.md', LOG);
  return root;
}
function run(root, messages, extra = []) {
  put(root, 'commits', messages.join('\0') + '\0');
  return spawnSync(process.execPath, [SCRIPT, '--root', root, '--last', '0.2.3', '--commits', path.join(root, 'commits'),
    '--date', '2026-11-03', '--notes', path.join(root, 'notes.md'), ...extra], { encoding: 'utf8' });
}

test('CLI: writes package.json, CHANGELOG and the notes, and prints the version', () => {
  const root = fixture();
  const r = run(root, ['fix: a\n\nbody line', 'feat: b']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^release=true$/m);
  assert.match(r.stdout, /^version=0\.3\.0$/m);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'server/package.json'), 'utf8')).version, '0.3.0');
  assert.match(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), /^## \[0\.3\.0\] - 2026-11-03$/m);
  assert.equal(fs.readFileSync(path.join(root, 'notes.md'), 'utf8'), '### Changed\n- Hand-written note.\n');
});

test('CLI: nothing to release and --dry-run write nothing', () => {
  const root = fixture();
  let r = run(root, ['docs: a', 'ci: b']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'release=false\n');
  r = run(root, ['fix: a'], ['--dry-run']);
  assert.match(r.stdout, /^version=0\.2\.4$/m);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'server/package.json'), 'utf8')).version, '0.2.3');
  assert.equal(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), LOG);
  assert.ok(!fs.existsSync(path.join(root, 'notes.md')));
});
