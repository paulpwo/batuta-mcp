// Worker entry for the analysis (docs/01-protocol.md 10.6). It runs inside a node:worker_threads Worker that the
// server starts from this compiled file; it is the only module here that touches node:worker_threads, and it only
// uses parentPort. It does one thing: bytes in, report (or typed error) out. Every incoming message is validated.

import { parentPort } from 'node:worker_threads';
import { analyzeAudio } from './analyze.ts';

const MAX_BYTES_CEILING = 1024 * 1024 * 1024;
const MAX_DURATION_CEILING_S = 300;

interface Reply {
  type: 'result' | 'error';
  id: number | null;
  [key: string]: unknown;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate one request; returns the reply to send when it is not usable. */
function handle(message: unknown): Reply {
  if (!isPlainRecord(message)) return { type: 'error', id: null, code: 'bad_message', message: 'request must be an object' };
  const keys = Object.keys(message).sort().join(',');
  const idValue = message.id;
  const id = typeof idValue === 'number' && Number.isSafeInteger(idValue) && idValue >= 0 ? idValue : null;
  if (keys !== 'bytes,id,maxBytes,maxDurationS,type' || message.type !== 'analyze' || id === null) {
    return { type: 'error', id, code: 'bad_message', message: 'request must be {type:"analyze", id, bytes, maxBytes, maxDurationS}' };
  }
  const { bytes, maxBytes, maxDurationS } = message;
  if (!(bytes instanceof ArrayBuffer)) return { type: 'error', id, code: 'bad_message', message: 'bytes must be an ArrayBuffer' };
  if (typeof maxBytes !== 'number' || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES_CEILING) {
    return { type: 'error', id, code: 'bad_message', message: 'maxBytes out of range' };
  }
  if (typeof maxDurationS !== 'number' || !Number.isFinite(maxDurationS) || maxDurationS <= 0 || maxDurationS > MAX_DURATION_CEILING_S) {
    return { type: 'error', id, code: 'bad_message', message: 'maxDurationS out of range' };
  }
  const result = analyzeAudio(new Uint8Array(bytes), { maxBytes, maxDurationS });
  if (result.ok) return { type: 'result', id, report: result.report };
  return { type: 'error', id, code: result.error.code, message: result.error.message };
}

if (parentPort === null) throw new Error('worker.ts must run inside a worker thread');
const port = parentPort;
port.on('message', (message: unknown) => {
  port.postMessage(handle(message));
});
