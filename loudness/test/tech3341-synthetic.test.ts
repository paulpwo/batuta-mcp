// EBU Tech 3341 (2023) Table 1 and Tech 3342 (2023) Table 1, synthesized from the published
// signal definitions (the downloadable EBU WAV set is not required for these cases).
// Sources: https://tech.ebu.ch/docs/tech/tech3341.pdf  https://tech.ebu.ch/docs/tech/tech3342.pdf
// Not synthesized here (need the EBU files): authentic programmes (3341 #7/#8, 3342 #5/#6),
// the 5.0-channel case #6 (engine supports 1-2 channels) and true-peak cases #20-#23.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { computeLoudness } from '../src/loudness.ts';
import { truePeakDb } from '../src/truepeak.ts';
import { sine, concat, fade } from './helpers.ts';
import { check, printTable } from './conformance.ts';

const FS = 48000;
const S = 'T3341';
const silence = (sec: number) => new Float64Array(Math.round(sec * FS));
const tone = (db: number, sec: number) => sine(1000, db, sec, FS);
const stereo = (x: Float64Array): Float64Array[] => [x, x];

after(printTable);

test('3341 #1/#2: stereo 1 kHz, M, S, I', () => {
  for (const [id, db] of [['1', -23], ['2', -33]] as const) {
    const r = computeLoudness(stereo(tone(db, 20)), FS);
    assert.ok(check(S, `#${id} M`, db, r.momentaryMaxLufs, 0.1, 0.1, 'LUFS'));
    assert.ok(check(S, `#${id} S`, db, r.shortTermMaxLufs, 0.1, 0.1, 'LUFS'));
    assert.ok(check(S, `#${id} I`, db, r.integratedLufs, 0.1, 0.1, 'LUFS'));
  }
});

test('3341 #3, #4, #5: gating sequences give I = -23', () => {
  const cases: Array<[string, Float64Array]> = [
    ['#3', concat(tone(-36, 10), tone(-23, 60), tone(-36, 10))],
    ['#4', concat(tone(-72, 10), tone(-36, 10), tone(-23, 60), tone(-36, 10), tone(-72, 10))],
    ['#5', concat(tone(-26, 20), tone(-20, 20.1), tone(-26, 20))],
  ];
  for (const [id, x] of cases) {
    const r = computeLoudness(stereo(x), FS);
    assert.ok(check(S, `${id} I`, -23, r.integratedLufs, 0.1, 0.1, 'LUFS'));
  }
});

test('3341 #9 / #12: alternating levels give constant S / M = -23', () => {
  const nine = concat(...Array.from({ length: 5 }, () => concat(tone(-20, 1.34), tone(-30, 1.66))));
  assert.ok(check(S, '#9 S', -23, computeLoudness(stereo(nine), FS).shortTermMaxLufs, 0.1, 0.1, 'LUFS'));
  const twelve = concat(...Array.from({ length: 25 }, () => concat(tone(-20, 0.18), tone(-30, 0.22))));
  assert.ok(check(S, '#12 M', -23, computeLoudness(stereo(twelve), FS).momentaryMaxLufs, 0.1, 0.1, 'LUFS'));
});

test('3341 #10 and #11: short-term maximum for 20 offsets', () => {
  for (let i = 0; i < 20; i++) {
    const x = concat(silence(i * 0.15), tone(-23, 3), silence(1));
    const r = computeLoudness(stereo(x), FS);
    assert.ok(check(S, `#10 i=${i} maxS`, -23, r.shortTermMaxLufs, 0.1, 0.1, 'LUFS'));
    const y = concat(silence(i * 0.15), tone(-38 + i, 3), silence(3 - i * 0.15));
    const q = computeLoudness(stereo(y), FS);
    assert.ok(check(S, `#11 i=${i} maxS`, -38 + i, q.shortTermMaxLufs, 0.1, 0.1, 'LUFS'));
  }
});

test('3341 #13 and #14: momentary maximum for 20 offsets (10 ms max-hop)', () => {
  for (let i = 0; i < 20; i++) {
    const x = concat(silence(i * 0.02), tone(-23, 0.4), silence(1));
    const r = computeLoudness(stereo(x), FS, { maxHopMs: 10 });
    assert.ok(check(S, `#13 i=${i} maxM`, -23, r.momentaryMaxLufs, 0.1, 0.1, 'LUFS'));
    const y = concat(silence(i * 0.02), tone(-38 + i, 0.4), silence(0.4 - i * 0.02));
    const q = computeLoudness(stereo(y), FS, { maxHopMs: 10 });
    assert.ok(check(S, `#14 i=${i} maxM`, -38 + i, q.momentaryMaxLufs, 0.1, 0.1, 'LUFS'));
  }
});

test('3341 #15-#19: true peak (+0.2/-0.4 dBTP)', () => {
  const cases: Array<[string, number, number, number, number]> = [
    ['#15', FS / 4, 0.5, 0, -6.0],
    ['#16', FS / 4, 0.5, Math.PI / 4, -6.0],
    ['#17', FS / 6, 0.5, Math.PI / 3, -6.0],
    ['#18', FS / 8, 0.5, (67.5 * Math.PI) / 180, -6.0],
    ['#19', FS / 4, 1.41, Math.PI / 4, 3.0],
  ];
  for (const [id, f, amp, phase, expected] of cases) {
    const x = fade(sine(f, 20 * Math.log10(amp), 1, FS, phase), 480); // 10 ms fades
    const tp = truePeakDb(x, FS);
    assert.ok(check(S, `${id} TP`, expected, tp, 0.4, 0.2, 'dBTP'));
  }
});

test('3342 #1-#4: loudness range of stepped tones (+-1 LU)', () => {
  const lra = (levels: number[]) =>
    computeLoudness(stereo(concat(...levels.map((l) => tone(l, 20)))), FS).lraLu;
  assert.ok(check('T3342', '#1 -20/-30', 10, lra([-20, -30]), 1, 1, 'LU'));
  assert.ok(check('T3342', '#2 -20/-15', 5, lra([-20, -15]), 1, 1, 'LU'));
  assert.ok(check('T3342', '#3 -40/-20', 20, lra([-40, -20]), 1, 1, 'LU'));
  assert.ok(check('T3342', '#4 five tones', 15, lra([-50, -35, -20, -35, -50]), 1, 1, 'LU'));
});
