// The analysis worker entry (src/worker.ts): started as a real worker thread, messages in, report out.
// Run with `node --test loudness/test/` (Node type stripping loads the .ts files directly).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { analyzeAudio } from '../src/analyze.ts';
import { buildWav, sine } from './helpers.ts';

const WORKER_URL = new URL('../src/worker.ts', import.meta.url);

/** Send each message to a fresh worker and collect the first reply per message. */
async function ask(message: unknown, transfer: ArrayBuffer[] = []): Promise<any> {
  const worker = new Worker(WORKER_URL);
  try {
    return await new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
      worker.postMessage(message, transfer);
    });
  } finally {
    await worker.terminate();
  }
}

function stereoSine(db: number, seconds = 5): Uint8Array {
  const channel = sine(1000, db, seconds, 48000);
  return buildWav([channel, Float64Array.from(channel)], 48000, { bits: 24 });
}

test('a request gets exactly the report that analyzeAudio produces directly', async () => {
  const wav = stereoSine(-20);
  const direct = analyzeAudio(wav);
  assert.equal(direct.ok, true);
  const buffer = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer;
  const reply = await ask({ type: 'analyze', id: 7, bytes: buffer, maxBytes: 1 << 28, maxDurationS: 300 }, [buffer]);
  assert.equal(reply.type, 'result');
  assert.equal(reply.id, 7);
  assert.deepEqual(reply.report, direct.ok ? direct.report : null);
  // 1 kHz stereo sine at -20 dBFS peak: -23.01 (mean square) + 3.01 (two channels) = -20.0 LUFS (K-weighting is +0.69 dB at 1 kHz, offset -0.691)
  assert.ok(Math.abs(reply.report.integrated_lufs - -20.0) < 0.1, String(reply.report.integrated_lufs));
});

test('an unparsable file comes back as a typed error with the same id', async () => {
  const junk = new Uint8Array(200).fill(7).buffer as ArrayBuffer;
  const reply = await ask({ type: 'analyze', id: 3, bytes: junk, maxBytes: 1 << 20, maxDurationS: 300 }, [junk]);
  assert.equal(reply.type, 'error');
  assert.equal(reply.id, 3);
  assert.equal(reply.code, 'unknown_container');
});

test('the byte and duration caps travel with the request', async () => {
  const wav = stereoSine(-20, 5);
  const copy = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer;
  const small = await ask({ type: 'analyze', id: 1, bytes: copy, maxBytes: 1000, maxDurationS: 300 }, [copy]);
  assert.deepEqual([small.type, small.code], ['error', 'too_large']);
  const copy2 = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer;
  const short = await ask({ type: 'analyze', id: 2, bytes: copy2, maxBytes: 1 << 28, maxDurationS: 2 }, [copy2]);
  assert.deepEqual([short.type, short.code], ['error', 'too_long']);
});

test('malformed requests are refused without running anything', async () => {
  const good = (): ArrayBuffer => new ArrayBuffer(64);
  const cases: Array<[string, unknown]> = [
    ['not an object', 'hello'],
    ['null', null],
    ['an array', [1, 2]],
    ['no type', { id: 1, bytes: good(), maxBytes: 100, maxDurationS: 10 }],
    ['wrong type', { type: 'eval', id: 1, bytes: good(), maxBytes: 100, maxDurationS: 10 }],
    ['no id', { type: 'analyze', bytes: good(), maxBytes: 100, maxDurationS: 10 }],
    ['float id', { type: 'analyze', id: 1.5, bytes: good(), maxBytes: 100, maxDurationS: 10 }],
    ['negative id', { type: 'analyze', id: -1, bytes: good(), maxBytes: 100, maxDurationS: 10 }],
    ['bytes is a string', { type: 'analyze', id: 1, bytes: 'abc', maxBytes: 100, maxDurationS: 10 }],
    ['bytes is a typed array', { type: 'analyze', id: 1, bytes: new Uint8Array(4), maxBytes: 100, maxDurationS: 10 }],
    ['maxBytes zero', { type: 'analyze', id: 1, bytes: good(), maxBytes: 0, maxDurationS: 10 }],
    ['maxBytes above the ceiling', { type: 'analyze', id: 1, bytes: good(), maxBytes: 2 ** 40, maxDurationS: 10 }],
    ['maxDurationS above the ceiling', { type: 'analyze', id: 1, bytes: good(), maxBytes: 100, maxDurationS: 3600 }],
    ['maxDurationS NaN', { type: 'analyze', id: 1, bytes: good(), maxBytes: 100, maxDurationS: Number.NaN }],
    ['an extra key', { type: 'analyze', id: 1, bytes: good(), maxBytes: 100, maxDurationS: 10, path: '/etc/passwd' }],
  ];
  for (const [label, message] of cases) {
    const reply = await ask(message);
    assert.equal(reply.type, 'error', label);
    assert.equal(reply.code, 'bad_message', label);
  }
});
