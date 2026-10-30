import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { REPO } from './helpers.mjs';

const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

test('server/package.json, server/src/version.ts and limits.py carry the same version', () => {
  const pkg = JSON.parse(read('server/package.json')).version;
  const ts = /export const VERSION = "([^"]+)"/.exec(read('server/src/version.ts'))?.[1];
  const py = /^SCRIPT_VERSION = "([^"]+)"/m.exec(read('remote_script/BatutaMCP/limits.py'))?.[1];
  assert.match(pkg, /^\d+\.\d+\.\d+$/);
  assert.equal(ts, pkg, 'server/src/version.ts VERSION');
  assert.equal(py, pkg, 'remote_script/BatutaMCP/limits.py SCRIPT_VERSION');
});
