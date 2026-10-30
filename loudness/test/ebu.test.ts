// Runs the EBU Loudness Test Set v05 WAV files through the engine and compares against the
// expected values of Tech 3341 (2023) Table 1 and Tech 3342 (2023) Table 1. Skips cleanly when
// the files are absent. Files are only read through our own parser (never executed).
// Directory: $BATUTA_EBU_DIR (default: see ebu-fixtures.json). Files are matched by name tokens
// "seq-3341-<case>" / "seq-3342-<case>"; the shared programmes are e.g. "seq-3341-7_seq-3342-5".

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseAudio } from '../src/audiofile.ts';
import { computeLoudness } from '../src/loudness.ts';
import { truePeakDb } from '../src/truepeak.ts';
import { check, printTable, rows } from './conformance.ts';

const DIR =
  process.env.BATUTA_EBU_DIR ??
  '/private/tmp/claude-501/-Users-developer-Documents/81e374a6-8b53-4009-8d37-63536d6ebd93/scratchpad/ebu-v5';

function listWavs(): string[] {
  try {
    if (!statSync(DIR).isDirectory()) return [];
    return readdirSync(DIR).filter((f) => f.toLowerCase().endsWith('.wav')).sort();
  } catch {
    return [];
  }
}

const files = listWavs();
const SKIP = files.length === 0 ? `EBU test set not found in ${DIR} (set BATUTA_EBU_DIR); skipping conformance` : false;

after(() => {
  if (rows.length > 0) printTable();
});

function load(name: string) {
  const r = parseAudio(new Uint8Array(readFileSync(join(DIR, name))), { maxChannels: 8 });
  return r;
}

function ids(name: string): { t3341: number | null; t3342: number | null; sub: number | null } {
  const a = /seq-3341-(?:2011-)?(\d+)/.exec(name);
  const b = /seq-3342-(\d+)/.exec(name);
  const sub = /seq-3341-(?:2011-)?\d+-(\d+)-/.exec(name);
  return { t3341: a ? Number(a[1]) : null, t3342: b ? Number(b[1]) : null, sub: sub ? Number(sub[1]) : null };
}

test('EBU v05 set: Tech 3341 / 3342 cases', { skip: SKIP }, () => {
  let checked = 0;
  for (const name of files) {
    const { t3341, t3342 } = ids(name);
    if (t3341 === null && t3342 === null) continue;
    const parsed = load(name);
    if (!parsed.ok) {
      // 5.0 / 5.1 surround variants are outside the supported 1-2 channel scope.
      assert.equal(parsed.error.code, 'unsupported_channels', `${name}: ${parsed.error.message}`);
      rows.push({ suite: 'T3341', testCase: `${name}`, expected: 'n/a', measured: 'multichannel unsupported', tolerance: '-', pass: true });
      continue;
    }
    const a = parsed.audio;
    const label = (c: string) => `${c} (${name})`;
    if (t3341 !== null) {
      const c = t3341;
      const fine = c === 13 || c === 14 ? { maxHopMs: 10 } : {};
      if (c >= 1 && c <= 8) {
        const r = computeLoudness(a.channels, a.sampleRate, fine);
        const exp = c === 2 ? -33 : -23;
        assert.ok(check('T3341', label(`#${c} I`), exp, r.integratedLufs, 0.1, 0.1, 'LUFS'), name);
        if (c <= 2) {
          assert.ok(check('T3341', label(`#${c} M`), exp, r.momentaryMaxLufs, 0.1, 0.1, 'LUFS'), name);
          assert.ok(check('T3341', label(`#${c} S`), exp, r.shortTermMaxLufs, 0.1, 0.1, 'LUFS'), name);
        }
        checked++;
      } else if (c === 9 || c === 10) {
        const r = computeLoudness(a.channels, a.sampleRate);
        assert.ok(check('T3341', label(`#${c} maxS`), -23, r.shortTermMaxLufs, 0.1, 0.1, 'LUFS'), name);
        checked++;
      } else if (c === 12 || c === 13) {
        const r = computeLoudness(a.channels, a.sampleRate, fine);
        assert.ok(check('T3341', label(`#${c} maxM`), -23, r.momentaryMaxLufs, 0.1, 0.1, 'LUFS'), name);
        checked++;
      } else if (c === 11 || c === 14) {
        // 20 concatenated segments of 6 s (#11) / 0.8 s (#14); expected max = -38 + i
        const segSeconds = c === 11 ? 6 : 0.8;
        const seg = Math.round(segSeconds * a.sampleRate);
        for (let i = 0; i < 20; i++) {
          const part = a.channels.map((ch) => ch.subarray(i * seg, (i + 1) * seg));
          const r = computeLoudness(part, a.sampleRate, fine);
          const m = c === 11 ? r.shortTermMaxLufs : r.momentaryMaxLufs;
          assert.ok(check('T3341', label(`#${c} i=${i}`), -38 + i, m, 0.1, 0.1, 'LUFS'), name);
        }
        checked++;
      } else if (c >= 15 && c <= 23) {
        const exp = c <= 18 ? -6.0 : c === 19 ? 3.0 : 0.0;
        const tp = Math.max(...a.channels.map((ch) => truePeakDb(ch, a.sampleRate)));
        assert.ok(check('T3341', label(`#${c} TP`), exp, tp, 0.4, 0.2, 'dBTP'), name);
        checked++;
      }
    }
    if (t3342 !== null) {
      const exp: Record<number, number> = { 1: 10, 2: 5, 3: 20, 4: 15, 5: 5, 6: 15 };
      if (exp[t3342] !== undefined) {
        const r = computeLoudness(a.channels, a.sampleRate);
        assert.ok(check('T3342', label(`#${t3342} LRA`), exp[t3342], r.lraLu, 1, 1, 'LU'), name);
        checked++;
      }
    }
  }
  assert.ok(checked > 0, 'no EBU case files recognised in ' + DIR);
});
