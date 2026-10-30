// Strict WAV (RIFF/WAVE, incl. WAVE_FORMAT_EXTENSIBLE) and AIFF/AIFF-C parsers.
//
// Contract: parseAudio never throws. Every malformed input yields
// { ok: false, error: { code, message } }. Chunk walking is a bounded loop
// (no recursion); every size is checked against the remaining buffer before
// it is used; unknown codecs are rejected.

export type AudioErrorCode =
  | 'not_bytes'
  | 'too_large'
  | 'too_short'
  | 'unknown_container'
  | 'truncated'
  | 'malformed'
  | 'unsupported_codec'
  | 'unsupported_bit_depth'
  | 'unsupported_channels'
  | 'unsupported_sample_rate'
  | 'too_long'
  | 'non_finite_samples';

export interface AudioError {
  code: AudioErrorCode;
  message: string;
}

export interface AudioData {
  format: 'wav' | 'aiff';
  sampleRate: number;
  bitDepth: number;
  floatingPoint: boolean;
  frames: number;
  /** One Float64Array per channel, samples normalized to [-1, 1) for integer PCM. */
  channels: Float64Array[];
}

export type ParseResult = { ok: true; audio: AudioData } | { ok: false; error: AudioError };

export interface ParseOptions {
  /** Maximum accepted buffer size in bytes (default 1 GiB). */
  maxBytes?: number;
  /** Maximum accepted duration in seconds (default 300, docs/01-protocol.md 10.5 item 5). */
  maxDurationS?: number;
  /** Maximum accepted number of sample frames (default 384000 * 300). */
  maxFrames?: number;
  /** Maximum accepted channel count (default 2). */
  maxChannels?: number;
  minSampleRate?: number;
  maxSampleRate?: number;
}

const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;
const DEFAULT_MAX_DURATION_S = 300;
const DEFAULT_MAX_FRAMES = 384000 * 300;

function fail(code: AudioErrorCode, message: string): ParseResult {
  return { ok: false, error: { code, message } };
}

function tag(u8: Uint8Array, pos: number): string {
  return String.fromCharCode(u8[pos], u8[pos + 1], u8[pos + 2], u8[pos + 3]);
}

interface Layout {
  channels: number;
  sampleRate: number;
  bits: number;
  float: boolean;
  littleEndian: boolean;
  frames: number | null; // AIFF declares it; WAV derives it
}

export function parseAudio(input: Uint8Array, options: ParseOptions = {}): ParseResult {
  try {
    if (!(input instanceof Uint8Array)) return fail('not_bytes', 'input must be a Uint8Array');
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    if (input.length > maxBytes) return fail('too_large', `size ${input.length} exceeds cap ${maxBytes}`);
    if (input.length < 12) return fail('too_short', 'shorter than a container header');
    const head = tag(input, 0);
    const form = tag(input, 8);
    if (head === 'RIFF' && form === 'WAVE') return parseWav(input, options);
    if (head === 'FORM' && (form === 'AIFF' || form === 'AIFC')) return parseAiff(input, options, form === 'AIFC');
    return fail('unknown_container', 'not RIFF/WAVE or FORM/AIFF');
  } catch (e) {
    // Defensive: should be unreachable, but the contract is "never throw".
    return fail('malformed', `unexpected parser failure: ${(e as Error).message}`);
  }
}

function checkLayout(l: Layout, options: ParseOptions): ParseResult | null {
  const maxCh = options.maxChannels ?? 2;
  if (l.channels < 1 || l.channels > maxCh) return fail('unsupported_channels', `${l.channels} channels not supported`);
  const minRate = options.minSampleRate ?? 8000;
  const maxRate = options.maxSampleRate ?? 384000;
  if (!Number.isFinite(l.sampleRate) || l.sampleRate < minRate || l.sampleRate > maxRate)
    return fail('unsupported_sample_rate', `sample rate ${l.sampleRate} outside ${minRate}..${maxRate}`);
  if (l.float ? l.bits !== 32 && l.bits !== 64 : l.bits !== 16 && l.bits !== 24 && l.bits !== 32)
    return fail('unsupported_bit_depth', `${l.bits}-bit ${l.float ? 'float' : 'PCM'} not supported`);
  return null;
}

function decode(u8: Uint8Array, start: number, frames: number, l: Layout, options: ParseOptions): ParseResult {
  const maxFrames = options.maxFrames ?? DEFAULT_MAX_FRAMES;
  if (frames > maxFrames) return fail('too_long', `${frames} frames exceed cap ${maxFrames}`);
  // Checked before any allocation, from header-declared sizes only.
  const maxDurationS = options.maxDurationS ?? DEFAULT_MAX_DURATION_S;
  if (frames > l.sampleRate * maxDurationS) return fail('too_long', `duration exceeds ${maxDurationS} s`);
  const bytes = l.bits / 8;
  const frameBytes = bytes * l.channels;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const out: Float64Array[] = [];
  for (let c = 0; c < l.channels; c++) out.push(new Float64Array(frames));
  const little = l.littleEndian;
  for (let i = 0; i < frames; i++) {
    let pos = start + i * frameBytes;
    for (let c = 0; c < l.channels; c++) {
      let v: number;
      if (l.float) {
        v = l.bits === 32 ? dv.getFloat32(pos, little) : dv.getFloat64(pos, little);
        if (!Number.isFinite(v)) return fail('non_finite_samples', `NaN/Infinity at frame ${i}`);
      } else if (l.bits === 16) v = dv.getInt16(pos, little) / 32768;
      else if (l.bits === 24) {
        const b0 = u8[pos];
        const b1 = u8[pos + 1];
        const b2 = u8[pos + 2];
        const raw = little ? b0 | (b1 << 8) | (b2 << 16) : (b0 << 16) | (b1 << 8) | b2;
        v = (raw & 0x800000 ? raw - 0x1000000 : raw) / 8388608;
      } else v = dv.getInt32(pos, little) / 2147483648;
      out[c][i] = v;
      pos += bytes;
    }
  }
  return {
    ok: true,
    audio: {
      format: 'wav', // overwritten by the caller
      sampleRate: l.sampleRate,
      bitDepth: l.bits,
      floatingPoint: l.float,
      frames,
      channels: out,
    },
  };
}

// WAVE_FORMAT_EXTENSIBLE sub-format GUID tail: 00000000-0010-8000-00AA00389B71 (after the 2-byte code).
const GUID_TAIL = [0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];

function parseWav(u8: Uint8Array, options: ParseOptions): ParseResult {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let layout: Layout | null = null;
  let dataStart = -1;
  let dataSize = 0;
  let pos = 12;
  // Bounded walk: each iteration consumes at least 8 bytes.
  while (pos + 8 <= u8.length) {
    const id = tag(u8, pos);
    const size = dv.getUint32(pos + 4, true);
    const body = pos + 8;
    if (size > u8.length - body) return fail('truncated', `chunk '${id}' declares ${size} bytes, ${u8.length - body} remain`);
    if (id === 'fmt ') {
      if (layout) return fail('malformed', 'duplicate fmt chunk');
      if (size < 16) return fail('malformed', 'fmt chunk too small');
      let code = dv.getUint16(body, true);
      const channels = dv.getUint16(body + 2, true);
      const sampleRate = dv.getUint32(body + 4, true);
      const blockAlign = dv.getUint16(body + 12, true);
      const bits = dv.getUint16(body + 14, true);
      if (code === 0xfffe) {
        if (size < 40) return fail('malformed', 'extensible fmt chunk too small');
        const cbSize = dv.getUint16(body + 16, true);
        if (cbSize < 22) return fail('malformed', 'extensible extension too small');
        code = dv.getUint16(body + 24, true);
        for (let i = 0; i < GUID_TAIL.length; i++)
          if (u8[body + 26 + i] !== GUID_TAIL[i]) return fail('unsupported_codec', 'non-standard extensible sub-format GUID');
      }
      if (code !== 1 && code !== 3) return fail('unsupported_codec', `WAV format tag 0x${code.toString(16)} not supported`);
      layout = { channels, sampleRate, bits, float: code === 3, littleEndian: true, frames: null };
      const bad = checkLayout(layout, options);
      if (bad) return bad;
      if (blockAlign !== channels * (bits / 8)) return fail('malformed', 'blockAlign does not match channels * bytes');
    } else if (id === 'data') {
      if (!layout) return fail('malformed', 'data chunk before fmt chunk');
      dataStart = body;
      dataSize = size;
      break;
    }
    // Chunks are word aligned: skip the pad byte of odd-sized chunks.
    pos = body + size + (size & 1);
  }
  if (!layout) return fail('malformed', 'no fmt chunk');
  if (dataStart < 0) return fail('malformed', 'no data chunk');
  const frameBytes = (layout.bits / 8) * layout.channels;
  if (dataSize % frameBytes !== 0) return fail('malformed', 'data size is not a whole number of frames');
  const frames = dataSize / frameBytes;
  const r = decode(u8, dataStart, frames, layout, options);
  if (r.ok) r.audio.format = 'wav';
  return r;
}

/** Decode an 80-bit IEEE extended float (AIFF sample rate) to a number. */
function readExtended(dv: DataView, pos: number): number {
  const se = dv.getUint16(pos, false);
  const exp = se & 0x7fff;
  const negative = (se & 0x8000) !== 0;
  const hi = dv.getUint32(pos + 2, false);
  const lo = dv.getUint32(pos + 6, false);
  if (negative || exp === 0x7fff || exp === 0) return NaN;
  const mantissa = hi * 4294967296 + lo; // up to 2^64, precision loss only below integer rates
  return mantissa * Math.pow(2, exp - 16383 - 63);
}

function parseAiff(u8: Uint8Array, options: ParseOptions, isAifc: boolean): ParseResult {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let layout: Layout | null = null;
  let dataStart = -1;
  let dataBytes = 0;
  let pos = 12;
  while (pos + 8 <= u8.length) {
    const id = tag(u8, pos);
    const size = dv.getUint32(pos + 4, false);
    const body = pos + 8;
    if (size > u8.length - body) return fail('truncated', `chunk '${id}' declares ${size} bytes, ${u8.length - body} remain`);
    if (id === 'COMM') {
      if (layout) return fail('malformed', 'duplicate COMM chunk');
      if (size < (isAifc ? 22 : 18)) return fail('malformed', 'COMM chunk too small');
      const channels = dv.getInt16(body, false);
      const frames = dv.getUint32(body + 2, false);
      const bits = dv.getInt16(body + 6, false);
      const rate = readExtended(dv, body + 8);
      const rounded = Math.round(rate);
      if (!Number.isFinite(rate) || Math.abs(rate - rounded) > 1e-6) return fail('unsupported_sample_rate', 'non-integer or invalid sample rate');
      let float = false;
      let little = false;
      if (isAifc) {
        const comp = tag(u8, body + 18);
        if (comp === 'NONE' || comp === 'twos') float = false;
        else if (comp === 'sowt') little = true;
        else if (comp === 'fl32' || comp === 'FL32' || comp === 'fl64' || comp === 'FL64') {
          float = true;
          if (comp.toLowerCase() === 'fl32' && bits !== 32) return fail('malformed', 'fl32 requires sample size 32');
          if (comp.toLowerCase() === 'fl64' && bits !== 64) return fail('malformed', 'fl64 requires sample size 64');
        } else return fail('unsupported_codec', `AIFF-C compression '${comp}' not supported`);
      }
      layout = { channels, sampleRate: rounded, bits, float, littleEndian: little, frames };
      const bad = checkLayout(layout, options);
      if (bad) return bad;
    } else if (id === 'SSND') {
      if (!layout) return fail('malformed', 'SSND chunk before COMM chunk');
      if (size < 8) return fail('malformed', 'SSND chunk too small');
      const offset = dv.getUint32(body, false);
      if (offset > size - 8) return fail('malformed', 'SSND offset beyond chunk');
      dataStart = body + 8 + offset;
      dataBytes = size - 8 - offset;
      break;
    }
    pos = body + size + (size & 1);
  }
  if (!layout || layout.frames === null) return fail('malformed', 'no COMM chunk');
  if (dataStart < 0) return fail('malformed', 'no SSND chunk');
  const frameBytes = (layout.bits / 8) * layout.channels;
  if (layout.frames > Math.floor(dataBytes / frameBytes)) return fail('truncated', 'SSND holds fewer frames than COMM declares');
  const r = decode(u8, dataStart, layout.frames, layout, options);
  if (r.ok) r.audio.format = 'aiff';
  return r;
}
