import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fft, samplePeak, rmsOfChannels, correlation, bandSpectrum, linearToDb, OCTAVE_CENTERS } from '../src/stats.ts';
import { sine, scale, noise } from './helpers.ts';

function near(a: number | null, b: number, tol: number, what: string) {
  assert.ok(a !== null && Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (tol ${tol})`);
}

test('fft: impulse is flat, sine lands in its bin, matches naive DFT', () => {
  const n = 64;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  re[0] = 1;
  fft(re, im);
  for (let k = 0; k < n; k++) near(re[k], 1, 1e-12, 'flat');
  const x = noise(n, 5);
  const r2 = Float64Array.from(x);
  const i2 = new Float64Array(n);
  fft(r2, i2);
  for (const k of [0, 1, 7, 31, 32, 50]) {
    let sr = 0;
    let si = 0;
    for (let t = 0; t < n; t++) {
      sr += x[t] * Math.cos((2 * Math.PI * k * t) / n);
      si -= x[t] * Math.sin((2 * Math.PI * k * t) / n);
    }
    near(r2[k], sr, 1e-9, `re[${k}]`);
    near(i2[k], si, 1e-9, `im[${k}]`);
  }
});

test('sample peak, RMS and dB conversion', () => {
  const s = sine(1000, 0, 1, 48000, 0.3);
  near(samplePeak(s), 1, 0.01, 'peak');
  near(linearToDb(rmsOfChannels([s])), -3.0103, 0.01, 'rms');
  assert.equal(linearToDb(0), -Infinity);
  assert.equal(rmsOfChannels([]), 0);
  // all samples of all channels
  near(rmsOfChannels([new Float64Array([1, 1]), new Float64Array([0, 0])]), Math.SQRT1_2, 1e-12, 'rms 2ch');
});

test('correlation: identical, inverted, independent, degenerate', () => {
  const a = noise(20000, 1);
  const b = noise(20000, 2);
  near(correlation(a, a), 1, 1e-12, 'same');
  near(correlation(a, a.map((v) => -v)), -1, 1e-12, 'inverted');
  assert.ok(Math.abs(correlation(a, b)!) < 0.05);
  assert.equal(correlation(new Float64Array(10), a.subarray(0, 10)), null);
  assert.equal(correlation(new Float64Array(0), new Float64Array(0)), null);
});

test('spectrum: full-scale sine reads 0 dB in its octave band only', () => {
  const fs = 48000;
  const s = sine(1000, 0, 2, fs);
  const bands = bandSpectrum([s], fs);
  assert.equal(bands.length, 10);
  assert.deepEqual(bands.map((b) => b.centerHz), [...OCTAVE_CENTERS]);
  const b1k = bands.find((b) => b.centerHz === 1000)!;
  near(b1k.levelDb, 0, 0.1, '1k band');
  for (const b of bands) if (b.centerHz !== 1000) assert.ok(b.levelDb === null || b.levelDb < -60, `band ${b.centerHz}: ${b.levelDb}`);
});

test('spectrum: -20 dBFS sine reads -20 dB; channels are power-averaged', () => {
  const fs = 48000;
  near(bandSpectrum([sine(4000, -20, 2, fs)], fs).find((b) => b.centerHz === 4000)!.levelDb, -20, 0.1, '-20');
  const l = sine(1000, 0, 2, fs);
  const r = scale(sine(1000, 0, 2, fs, 1.0), -6.0206);
  const st = bandSpectrum([l, r], fs).find((b) => b.centerHz === 1000)!;
  near(st.levelDb, 10 * Math.log10((1 + 0.25) / 2), 0.1, 'stereo mean power');
  // different tones in each channel (packing must not cross-talk)
  const st2 = bandSpectrum([sine(250, 0, 2, fs), sine(4000, 0, 2, fs)], fs);
  near(st2.find((b) => b.centerHz === 250)!.levelDb, -3.0103, 0.1, 'L only');
  near(st2.find((b) => b.centerHz === 4000)!.levelDb, -3.0103, 0.1, 'R only');
});

test('spectrum: bands above Nyquist are null; short and silent input handled', () => {
  const low = bandSpectrum([sine(1000, 0, 1, 16000)], 16000);
  assert.equal(low.find((b) => b.centerHz === 16000)!.levelDb, null);
  assert.notEqual(low.find((b) => b.centerHz === 1000)!.levelDb, null);
  const short = bandSpectrum([sine(1000, 0, 0.05, 48000)], 48000); // < 8192 samples: zero-padded single frame
  assert.notEqual(short.find((b) => b.centerHz === 1000)!.levelDb, null);
  const silent = bandSpectrum([new Float64Array(20000)], 48000);
  assert.ok(silent.every((b) => b.levelDb === null));
});
