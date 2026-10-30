import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kWeightCoefficients, kWeight } from '../src/kweight.ts';
import { sine } from './helpers.ts';

function near(a: number, b: number, tol: number, what: string) {
  assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);
}

test('48 kHz coefficients match the BS.1770 published table', () => {
  const { shelf, highpass } = kWeightCoefficients(48000);
  near(shelf.b0, 1.53512485958697, 1e-9, 'b0');
  near(shelf.b1, -2.69169618940638, 1e-9, 'b1');
  near(shelf.b2, 1.19839281085285, 1e-9, 'b2');
  near(shelf.a1, -1.69065929318241, 1e-9, 'a1');
  near(shelf.a2, 0.73248077421585, 1e-9, 'a2');
  near(highpass.a1, -1.99004745483398, 1e-9, 'hp a1');
  near(highpass.a2, 0.99007225036621, 1e-9, 'hp a2');
  assert.deepEqual([highpass.b0, highpass.b1, highpass.b2], [1, -2, 1]);
});

function rms(x: Float64Array): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / x.length);
}

test('K-weighting gain at 997 Hz is about +0.69 dB at every supported rate', () => {
  for (const fs of [44100, 48000, 88200, 96000, 192000]) {
    const x = sine(997, -20, 3, fs);
    const y = kWeight(x, fs);
    const gainDb = 20 * Math.log10(rms(y.subarray(fs)) / rms(x.subarray(fs)));
    near(gainDb, 0.691, 0.04, `gain @${fs}`);
  }
});

test('high-pass removes DC and shelf boosts highs by about 4 dB', () => {
  const fs = 48000;
  const dc = new Float64Array(fs * 2).fill(0.5);
  const y = kWeight(dc, fs);
  assert.ok(Math.abs(y[y.length - 1]) < 1e-3);
  const hi = sine(10000, -20, 2, fs);
  const g = 20 * Math.log10(rms(kWeight(hi, fs).subarray(fs / 2)) / rms(hi.subarray(fs / 2)));
  near(g, 4.0, 0.7, 'HF shelf');
});

test('filter does not mutate the input and accepts Float32Array', () => {
  const x = Float32Array.from([0.1, 0.2, -0.3, 0.4]);
  const copy = Float32Array.from(x);
  const y = kWeight(x, 48000);
  assert.deepEqual(x, copy);
  assert.equal(y.length, 4);
});
