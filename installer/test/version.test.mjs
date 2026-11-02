import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { REPO } from './helpers.mjs';
import { readSource } from '../install.mjs';

const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const pkgVersion = () => JSON.parse(read('server/package.json')).version;

test('server/package.json is the only place a version is written', () => {
  assert.match(pkgVersion(), /^\d+\.\d+\.\d+$/);
  // The server reads package.json; the Remote Script keeps the placeholder in the checkout.
  assert.doesNotMatch(read('server/src/version.ts'), /export const VERSION = "/);
  assert.match(read('remote_script/BatutaMCP/limits.py'), /^STAMPED_VERSION = None$/m);
});

test('the installer writes the package version into the limits.py it installs', () => {
  const src = readSource(path.join(REPO, 'remote_script', 'BatutaMCP'));
  assert.equal(src.version, pkgVersion());
  const limits = src.files.get('limits.py').toString('utf8');
  assert.match(limits, new RegExp('^STAMPED_VERSION = "' + pkgVersion().replaceAll('.', '\\.') + '"$', 'm'));
  assert.doesNotMatch(limits, /^STAMPED_VERSION = None$/m);
});
