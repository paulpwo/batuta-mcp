// Mutation-killing tests for gate thresholds, block overlap, LRA percentiles and the true-peak filter,
// plus parser limits. References quoted from an independent ffmpeg ebur128 run where noted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLoudness } from '../src/loudness.ts';
import { truePeakDb } from '../src/truepeak.ts';
import { parseAudio } from '../src/audiofile.ts';
import { buildWav, buildAiff, sine, concat, fade } from './helpers.ts';

const FS = 48000;
const st = (x: Float64Array): Float64Array[] => [x, x];
const silence = (s: number) => new Float64Array(Math.round(s * FS));
function near(a: number | null, b: number, tol: number, what: string) {
  assert.ok(a !== null && Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (tol ${tol})`);
}

test('absolute gate is -70 LUFS: a -65 LUFS tone is kept, a -75 LUFS tone is gated out', () => {
  near(computeLoudness(st(sine(997, -65, 10, FS)), FS).integratedLufs, -65, 0.1, '-65');
  assert.equal(computeLoudness(st(sine(997, -75, 10, FS)), FS).integratedLufs, null);
});

test('relative gate is -10 LU: content 9.5 LU below the main level is kept', () => {
  // 36 s at -20 and 4 s at -29.5: gated mean ~ -20.4, so thresholds are -30.4 (-10 LU) vs -28.4 (-8 LU).
  const x = concat(sine(997, -20, 36, FS), sine(997, -29.5, 4, FS));
  const expected = -20 + 10 * Math.log10(0.9 + 0.1 * Math.pow(10, -0.95));
  near(computeLoudness(st(x), FS).integratedLufs, expected, 0.1, 'kept');
});

test('relative gate threshold derives from the abs-gated mean, not from silent blocks', () => {
  // 60 s silence, 10 s at -20, 3 s at -35. Correct: threshold ~ -30 drops the -35 section -> I = -20.
  // Mutant (mean over all blocks incl. silence) lowers the threshold to ~ -38 and keeps it.
  const x = concat(silence(60), sine(997, -20, 10, FS), sine(997, -35, 3, FS));
  near(computeLoudness(st(x), FS).integratedLufs, -20, 0.2, 'silence + tone + quiet');
});

test('gating blocks overlap 75 %: 200 ms bursts every 2 s at -10 dBFS read -14.0 LUFS (ffmpeg -13.99)', () => {
  const cell = concat(sine(997, -10, 0.2, FS), silence(1.8));
  const x = concat(...Array.from({ length: 15 }, () => cell));
  near(computeLoudness(st(x), FS).integratedLufs, -13.99, 0.1, 'bursts');
});

test('LRA of a -50 -> -10 dB level ramp over 40 s is 24.8 LU (ffmpeg 24.90; P95-P10, interpolated)', () => {
  const n = 40 * FS;
  const ramp = new Float64Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const db = -50 + (40 * i) / n;
    ramp[i] = Math.pow(10, db / 20) * Math.sin(phase);
    phase += (2 * Math.PI * 997) / FS;
  }
  near(computeLoudness([ramp], FS).lraLu, 24.8, 0.3, 'ramp LRA');
});

test('true-peak filter is accurate near the top of the band (20 kHz at 48 kHz within 0.15 dB)', () => {
  // Peak placed exactly on the 4x grid (a quarter, half or three quarters of a sample after a sample).
  const f = 20000;
  for (const offset of [0.25, 0.5, 0.75]) {
    const phase = Math.PI / 2 - ((2 * Math.PI * f) / FS) * offset;
    const x = fade(sine(f, 0, 1, FS, phase), 4800);
    const db = truePeakDb(x, FS);
    assert.ok(db > -0.15 && db < 0.05, `offset ${offset}: ${db} dBTP`);
  }
});

test('maxDurationS (default 300 s) refuses long files before decoding', () => {
  const rate = 8000;
  const long = buildWav([new Float64Array(rate * 301)], rate, { bits: 16 });
  const r = parseAudio(long);
  assert.ok(!r.ok && r.error.code === 'too_long');
  assert.ok(parseAudio(buildWav([new Float64Array(rate * 300)], rate, { bits: 16 })).ok);
  assert.ok(parseAudio(long, { maxDurationS: 400 }).ok);
  const short = parseAudio(buildWav([new Float64Array(rate * 11)], rate, { bits: 16 }), { maxDurationS: 10 });
  assert.ok(!short.ok && short.error.code === 'too_long');
});

test('parser: non-finite float samples are rejected', () => {
  const wav = buildWav([sine(440, -6, 0.01, FS)], FS, { bits: 32, float: true });
  new DataView(wav.buffer).setFloat32(44 + 40, NaN, true);
  const r = parseAudio(wav);
  assert.ok(!r.ok && r.error.code === 'non_finite_samples');
  new DataView(wav.buffer).setFloat32(44 + 40, Infinity, true);
  assert.ok(!parseAudio(wav).ok);
});

test('parser: AIFF COMM frames larger than SSND data is a typed failure (24-bit)', () => {
  const aiff = buildAiff([sine(440, -6, 0.05, FS)], FS, { kind: 'AIFF', bits: 24 });
  const dv = new DataView(aiff.buffer);
  dv.setUint32(22, dv.getUint32(22, false) + 1, false);
  const r = parseAudio(aiff);
  assert.ok(!r.ok && r.error.code === 'truncated');
});

test('parser: WAV blockAlign mismatch and partial trailing frame are rejected', () => {
  const wav = buildWav([sine(440, -6, 0.05, FS), sine(660, -6, 0.05, FS)], FS, { bits: 16 });
  const bad = wav.slice();
  new DataView(bad.buffer).setUint16(32, 6, true); // blockAlign should be 4
  const a = parseAudio(bad);
  assert.ok(!a.ok && a.error.code === 'malformed');
  const odd = wav.slice();
  const dv = new DataView(odd.buffer);
  dv.setUint32(40, dv.getUint32(40, true) - 1, true); // data no longer a whole number of frames
  const b = parseAudio(odd);
  assert.ok(!b.ok && b.error.code === 'malformed');
});

test('LRA percentiles are linearly interpolated (6 short-term windows, analytic expectation)', () => {
  // 3.0 s at -40 then 0.5 s at -20: window k (start 0.1k s) holds a loud fraction k/30.
  const x = concat(sine(997, -40, 3, FS), sine(997, -20, 0.5, FS));
  const eq = Math.pow(10, -4);
  const el = Math.pow(10, -2);
  const levels = [0, 1, 2, 3, 4, 5].map((k) => -0.691 + 0.691 + 10 * Math.log10(eq + (k / 30) * (el - eq)));
  const pct = (p: number) => {
    const pos = (levels.length - 1) * p;
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, levels.length - 1);
    return levels[lo] + (levels[hi] - levels[lo]) * (pos - lo);
  };
  near(computeLoudness(st(x), FS).lraLu, pct(0.95) - pct(0.1), 0.05, 'interpolated LRA');
});
