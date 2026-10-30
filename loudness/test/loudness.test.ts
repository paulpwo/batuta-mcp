import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLoudness } from '../src/loudness.ts';
import { sine, concat, scale } from './helpers.ts';

const FS = 48000;

function near(a: number | null, b: number, tol: number, what: string) {
  assert.ok(a !== null && Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (tol ${tol})`);
}

test('997 Hz sine at -23 dBFS peak, identical in both channels, reads -23.0 LUFS', () => {
  // Per channel: mean square A^2/2, K gain +0.691 dB at 997 Hz; two channels sum (+3.01 dB);
  // the -0.691 offset cancels the K gain, so LUFS = 20*log10(A) for a stereo-identical sine.
  const s = sine(997, -23, 20, FS);
  const r = computeLoudness([s, s], FS);
  near(r.integratedLufs, -23.0, 0.1, 'integrated');
  near(r.momentaryMaxLufs, -23.0, 0.1, 'momentary');
  near(r.shortTermMaxLufs, -23.0, 0.1, 'short-term');
  near(r.lraLu, 0, 0.1, 'lra');
});

test('the same sine at -20 dBFS reads -20.0 LUFS (and works at 44.1/88.2/96/192 kHz)', () => {
  for (const fs of [44100, 48000, 88200, 96000, 192000]) {
    const s = sine(997, -20, 5, fs);
    near(computeLoudness([s, s], fs).integratedLufs, -20.0, 0.1, `fs ${fs}`);
  }
});

test('mono uses weight 1.0 with no dual-mono compensation', () => {
  const s = sine(997, -20, 10, FS);
  // one channel at -20 dBFS peak: 3.01 dB lower than the stereo-identical case
  near(computeLoudness([s], FS).integratedLufs, -23.0, 0.1, 'mono');
});

test('silence: everything undefined (null)', () => {
  const z = new Float64Array(FS * 5);
  const r = computeLoudness([z, z], FS);
  assert.equal(r.integratedLufs, null);
  assert.equal(r.momentaryMaxLufs, null);
  assert.equal(r.shortTermMaxLufs, null);
  assert.equal(r.lraLu, null);
});

test('too short: integrated needs 400 ms, short-term 3 s, LRA 3 s', () => {
  const s = sine(997, -20, 0.3, FS);
  assert.equal(computeLoudness([s, s], FS).integratedLufs, null);
  const s2 = sine(997, -20, 1, FS);
  const r = computeLoudness([s2, s2], FS);
  near(r.integratedLufs, -20, 0.1, 'integrated 1s');
  assert.equal(r.shortTermMaxLufs, null);
  assert.equal(r.lraLu, null);
});

test('absolute gate drops blocks below -70 LUFS', () => {
  const loud = sine(997, -20, 10, FS);
  const quiet = scale(sine(997, -20, 30, FS), -55); // -75 LUFS
  const r = computeLoudness([concat(loud, quiet), concat(loud, quiet)], FS);
  near(r.integratedLufs, -20, 0.1, 'abs gate');
});

test('relative gate drops blocks more than 10 LU below the gated mean', () => {
  // 20 s at -20, 20 s at -33 (13 LU lower): the -33 section is excluded by the relative gate
  const a = sine(997, -20, 20, FS);
  const b = scale(a, -13);
  const r = computeLoudness([concat(a, b), concat(a, b)], FS);
  near(r.integratedLufs, -20, 0.1, 'relative gate');
  // Without gating the mean would be about -23: confirm the gate had effect
  assert.ok(r.integratedLufs! > -21);
});

test('LRA of a two-level stepped signal equals the step', () => {
  // 30 s at -30 then 30 s at -20 LUFS (10 LU step, both above the -20 LU relative gate)
  const a = sine(997, -30, 30, FS); // -30 LUFS
  const b = sine(997, -20, 30, FS); // -20 LUFS
  const r = computeLoudness([concat(a, b), concat(a, b)], FS);
  near(r.lraLu, 10, 0.5, 'lra');
});

test('LRA relative gate excludes content > 20 LU below', () => {
  const a = sine(997, -20, 30, FS);
  const b = scale(a, -30);
  const r = computeLoudness([concat(a, b), concat(a, b)], FS);
  near(r.lraLu, 0, 0.2, 'lra gated');
});

test('momentary max catches a short burst that integrated averages out', () => {
  const quiet = sine(997, -40, 10, FS);
  const burst = sine(997, -14, 0.5, FS);
  const r = computeLoudness([concat(quiet, burst, quiet), concat(quiet, burst, quiet)], FS);
  near(r.momentaryMaxLufs, -14, 0.2, 'burst');
});

test('input arrays are not modified and Float32Array works', () => {
  const s = Float32Array.from(sine(997, -20, 2, FS));
  const copy = Float32Array.from(s);
  computeLoudness([s, s], FS);
  assert.deepEqual(s, copy);
});
