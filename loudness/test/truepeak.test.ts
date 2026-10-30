import { test } from 'node:test';
import assert from 'node:assert/strict';
import { truePeak, truePeakDb, oversamplingFactor } from '../src/truepeak.ts';
import { sine, fade } from './helpers.ts';

test('oversampling factor by sample rate', () => {
  assert.equal(oversamplingFactor(44100), 4);
  assert.equal(oversamplingFactor(48000), 4);
  assert.equal(oversamplingFactor(88200), 4);
  assert.equal(oversamplingFactor(96000), 2);
  assert.equal(oversamplingFactor(176400), 2);
  assert.equal(oversamplingFactor(192000), 1);
});

test('fs/4 sine at 45 degrees: samples reach 0.707, true peak is 1.0 (0 dBTP)', () => {
  const fs = 48000;
  const x = fade(sine(fs / 4, 0, 1, fs, Math.PI / 4), 4800);
  let samplePeak = 0;
  for (const v of x) samplePeak = Math.max(samplePeak, Math.abs(v));
  assert.ok(Math.abs(samplePeak - Math.SQRT1_2) < 1e-9);
  const tp = truePeak(x, fs);
  assert.ok(tp > samplePeak + 0.25, `true peak ${tp}`);
  assert.ok(Math.abs(20 * Math.log10(tp)) < 0.1, `dBTP ${20 * Math.log10(tp)}`);
});

test('true peak never below sample peak and is 1x at 192 kHz', () => {
  const x = sine(997, -6, 0.5, 192000);
  let sp = 0;
  for (const v of x) sp = Math.max(sp, Math.abs(v));
  assert.equal(truePeak(x, 192000), sp);
  const y = sine(5000, -3, 0.5, 48000, 0.3);
  let sp2 = 0;
  for (const v of y) sp2 = Math.max(sp2, Math.abs(v));
  assert.ok(truePeak(y, 48000) >= sp2);
});

test('2x oversampling at 96 kHz finds the inter-sample peak of a 24 kHz-ish tone', () => {
  const fs = 96000;
  const x = fade(sine(fs / 4, 0, 1, fs, Math.PI / 4), 9600); // 24 kHz, samples 0.707
  const tp = truePeak(x, fs);
  // 2x grid of a 24 kHz tone has 8 points per cycle: the inherent miss is at most 0.7 dB
  const db = 20 * Math.log10(tp);
  assert.ok(db > -0.7 && db < 0.05, `dBTP ${db}`);
  assert.ok(tp > Math.SQRT1_2 + 0.1);
});

test('dBTP conversion, silence and empty input', () => {
  assert.equal(truePeakDb(new Float64Array(100), 48000), -Infinity);
  assert.equal(truePeakDb(new Float64Array(0), 48000), -Infinity);
  const full = fade(sine(1000, 0, 0.2, 48000, Math.PI / 2), 2400);
  assert.ok(Math.abs(truePeakDb(full, 48000)) < 0.05);
});

test('accuracy across the band: within 0.35 dB (inherent 4x grid-miss bound) at worst phase', () => {
  const fs = 48000;
  for (const f of [100, 1000, 8000, 12000, 16000, 20000]) {
    for (const ph of [0, 0.4, Math.PI / 4, 1.2]) {
      const x = fade(sine(f, 0, 0.5, fs, ph), 4800);
      const db = truePeakDb(x, fs);
      assert.ok(db <= 0.05 && db > -0.35, `f=${f} ph=${ph} -> ${db}`);
    }
  }
});
