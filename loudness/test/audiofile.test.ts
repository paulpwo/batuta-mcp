import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAudio } from '../src/audiofile.ts';
import { buildWav, buildAiff, sine, noise } from './helpers.ts';

function expectOk(r: ReturnType<typeof parseAudio>) {
  if (!r.ok) assert.fail(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.audio;
}

const left = sine(440, -6, 0.05, 48000);
const right = sine(660, -12, 0.05, 48000);

for (const [bits, float, tol] of [
  [16, false, 1 / 32768],
  [24, false, 1 / 8388608],
  [32, false, 1e-9],
  [32, true, 1e-7],
  [64, true, 1e-15],
] as const) {
  test(`WAV round-trip ${bits}-bit ${float ? 'float' : 'int'}`, () => {
    const a = expectOk(parseAudio(buildWav([left, right], 48000, { bits, float })));
    assert.equal(a.sampleRate, 48000);
    assert.equal(a.channels.length, 2);
    assert.equal(a.bitDepth, bits);
    assert.equal(a.frames, left.length);
    for (let i = 0; i < left.length; i++) {
      assert.ok(Math.abs(a.channels[0][i] - left[i]) <= tol, `L[${i}]`);
      assert.ok(Math.abs(a.channels[1][i] - right[i]) <= tol, `R[${i}]`);
    }
  });
}

test('WAV extensible (int and float) and odd-sized chunk padding', () => {
  const a = expectOk(parseAudio(buildWav([left], 44100, { bits: 24, extensible: true, oddChunk: true })));
  assert.equal(a.channels.length, 1);
  assert.equal(a.sampleRate, 44100);
  const b = expectOk(parseAudio(buildWav([left, right], 96000, { bits: 32, float: true, extensible: true })));
  assert.equal(b.sampleRate, 96000);
  assert.equal(b.channels.length, 2);
});

for (const [kind, bits, tol] of [
  ['AIFF', 16, 1 / 32768],
  ['AIFF', 24, 1 / 8388608],
  ['NONE', 16, 1 / 32768],
  ['sowt', 16, 1 / 32768],
  ['sowt', 24, 1 / 8388608],
  ['fl32', 32, 1e-7],
  ['fl64', 64, 1e-15],
] as const) {
  test(`AIFF round-trip ${kind} ${bits}-bit`, () => {
    for (const fs of [44100, 48000, 88200, 96000, 192000]) {
      const a = expectOk(parseAudio(buildAiff([left, right], fs, { kind, bits })));
      assert.equal(a.sampleRate, fs);
      assert.equal(a.channels.length, 2);
      assert.equal(a.format, 'aiff');
      for (let i = 0; i < left.length; i += 7) assert.ok(Math.abs(a.channels[0][i] - left[i]) <= tol);
    }
  });
}

test('rejects unknown codecs, bad channel counts, bad rates', () => {
  const wav = buildWav([left], 48000, { bits: 16 });
  const dv = new DataView(wav.buffer);
  const codec = wav.slice();
  new DataView(codec.buffer).setUint16(20, 0x55, true); // MP3-ish
  assert.equal(parseAudio(codec).ok, false);
  const zeroCh = wav.slice();
  new DataView(zeroCh.buffer).setUint16(22, 0, true);
  const r0 = parseAudio(zeroCh);
  assert.ok(!r0.ok);
  const three = buildWav([left, left, left], 48000, { bits: 16 });
  const r3 = parseAudio(three);
  assert.ok(!r3.ok && r3.error.code === 'unsupported_channels');
  const badRate = wav.slice();
  new DataView(badRate.buffer).setUint32(24, 100, true);
  assert.equal(parseAudio(badRate).ok, false);
  assert.ok(dv.byteLength > 44);
  const comp = buildAiff([left], 48000, { kind: 'NONE', bits: 16 });
  comp[12 + 8 + 18] = 'u'.charCodeAt(0); // ulaw-ish compression type
  assert.equal(parseAudio(comp).ok, false);
});

test('size cap and strict chunk sizes', () => {
  const wav = buildWav([left], 48000, { bits: 16 });
  const capped = parseAudio(wav, { maxBytes: 100 });
  assert.ok(!capped.ok && capped.error.code === 'too_large');
  const giant = wav.slice();
  // data chunk size claims 4 GiB - 1
  new DataView(giant.buffer).setUint32(40, 0xffffffff, true);
  const g = parseAudio(giant);
  assert.ok(!g.ok && g.error.code === 'truncated');
  const frames = parseAudio(wav, { maxFrames: 10 });
  assert.ok(!frames.ok && frames.error.code === 'too_long');
});

test('fuzz: truncations, bit flips, random bytes never throw', () => {
  const seeds = [
    buildWav([left, right], 48000, { bits: 24, extensible: true, oddChunk: true }),
    buildWav([left], 44100, { bits: 32, float: true }),
    buildAiff([left, right], 48000, { kind: 'sowt', bits: 16 }),
    buildAiff([left], 96000, { kind: 'fl32', bits: 32 }),
  ];
  for (const seed of seeds) {
    for (let cut = 0; cut < Math.min(seed.length, 200); cut++) {
      assert.doesNotThrow(() => parseAudio(seed.subarray(0, cut)));
    }
    const rnd = noise(4000, 99);
    for (let i = 0; i < 1500; i++) {
      const copy = seed.slice(0, 120 + (i % 60));
      const pos = Math.floor(((rnd[i] + 1) / 2) * (copy.length - 1));
      copy[pos] = Math.floor(((rnd[i + 1] + 1) / 2) * 255);
      copy[Math.floor(((rnd[i + 2] + 1) / 2) * (copy.length - 1))] ^= 0xff;
      assert.doesNotThrow(() => parseAudio(copy));
    }
  }
  const rnd = noise(5000, 7);
  for (let i = 0; i < 300; i++) {
    const b = new Uint8Array(64 + (i % 100));
    for (let j = 0; j < b.length; j++) b[j] = Math.floor(((rnd[(i * 13 + j) % 5000] + 1) / 2) * 255);
    assert.doesNotThrow(() => parseAudio(b));
  }
  assert.doesNotThrow(() => parseAudio(new Uint8Array(0)));
  assert.doesNotThrow(() => parseAudio(null as unknown as Uint8Array));
});

test('hand-crafted hostile headers return typed failures', () => {
  // RIFF with data chunk of size 0 and chunk-size overflow past buffer end
  const wav = buildWav([left], 48000, { bits: 16 });
  const ov = wav.slice();
  new DataView(ov.buffer).setUint32(16, 0xfffffff0, true); // fmt size huge
  const r = parseAudio(ov);
  assert.ok(!r.ok);
  const noData = wav.slice(0, 36);
  assert.ok(!parseAudio(noData).ok);
  const aiff = buildAiff([left], 48000, { kind: 'AIFF', bits: 16 });
  const big = aiff.slice();
  new DataView(big.buffer).setUint32(16, 0xffffffff, false); // COMM size
  assert.ok(!parseAudio(big).ok);
  const frames = aiff.slice();
  new DataView(frames.buffer).setUint32(22, 0x7fffffff, false); // numSampleFrames
  assert.ok(!parseAudio(frames).ok);
});
