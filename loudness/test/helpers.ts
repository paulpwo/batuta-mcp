// Test helpers: synthetic signals and WAV/AIFF file builders. No dependencies.

export function sine(freq: number, amplitudeDb: number, seconds: number, fs: number, phase = 0): Float64Array {
  const n = Math.round(seconds * fs);
  const out = new Float64Array(n);
  const amp = Math.pow(10, amplitudeDb / 20);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / fs + phase);
  return out;
}

export function concat(...parts: Float64Array[]): Float64Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Float64Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function scale(x: Float64Array, gainDb: number): Float64Array {
  const g = Math.pow(10, gainDb / 20);
  return x.map((v) => v * g);
}

/** Deterministic xorshift noise in [-1, 1). */
export function noise(n: number, seed = 12345): Float64Array {
  let s = seed >>> 0 || 1;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    out[i] = (s / 0xffffffff) * 2 - 1;
  }
  return out;
}

export interface WavOptions {
  bits: 16 | 24 | 32 | 64;
  float?: boolean;
  extensible?: boolean;
  /** Add an odd-sized junk chunk (with pad byte) before data. */
  oddChunk?: boolean;
}

function quantize(v: number, bits: number): number {
  const max = Math.pow(2, bits - 1);
  return Math.max(-max, Math.min(max - 1, Math.round(v * max)));
}

function writeSample(dv: DataView, pos: number, v: number, bits: number, float: boolean, little: boolean): void {
  if (float) {
    if (bits === 32) dv.setFloat32(pos, v, little);
    else dv.setFloat64(pos, v, little);
    return;
  }
  const q = quantize(v, bits);
  if (bits === 16) dv.setInt16(pos, q, little);
  else if (bits === 24) {
    const u = q < 0 ? q + 0x1000000 : q;
    if (little) {
      dv.setUint8(pos, u & 255);
      dv.setUint8(pos + 1, (u >> 8) & 255);
      dv.setUint8(pos + 2, (u >> 16) & 255);
    } else {
      dv.setUint8(pos, (u >> 16) & 255);
      dv.setUint8(pos + 1, (u >> 8) & 255);
      dv.setUint8(pos + 2, u & 255);
    }
  } else dv.setInt32(pos, q, little);
}

function ascii(u8: Uint8Array, pos: number, s: string): void {
  for (let i = 0; i < s.length; i++) u8[pos + i] = s.charCodeAt(i);
}

export function buildWav(channels: Float64Array[], fs: number, opt: WavOptions): Uint8Array {
  const float = opt.float ?? false;
  const nch = channels.length;
  const frames = channels[0].length;
  const bytes = opt.bits / 8;
  const dataSize = frames * nch * bytes;
  const fmtSize = opt.extensible ? 40 : 16;
  const junk = opt.oddChunk ? 8 + 3 + 1 : 0;
  const total = 12 + (8 + fmtSize) + junk + 8 + dataSize + (dataSize % 2);
  const u8 = new Uint8Array(total);
  const dv = new DataView(u8.buffer);
  ascii(u8, 0, 'RIFF');
  dv.setUint32(4, total - 8, true);
  ascii(u8, 8, 'WAVE');
  let p = 12;
  ascii(u8, p, 'fmt ');
  dv.setUint32(p + 4, fmtSize, true);
  dv.setUint16(p + 8, opt.extensible ? 0xfffe : float ? 3 : 1, true);
  dv.setUint16(p + 10, nch, true);
  dv.setUint32(p + 12, fs, true);
  dv.setUint32(p + 16, fs * nch * bytes, true);
  dv.setUint16(p + 20, nch * bytes, true);
  dv.setUint16(p + 22, opt.bits, true);
  if (opt.extensible) {
    dv.setUint16(p + 24, 22, true);
    dv.setUint16(p + 26, opt.bits, true);
    dv.setUint32(p + 28, nch === 1 ? 4 : 3, true);
    dv.setUint16(p + 32, float ? 3 : 1, true);
    const tail = [0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];
    for (let i = 0; i < tail.length; i++) u8[p + 34 + i] = tail[i];
  }
  p += 8 + fmtSize;
  if (opt.oddChunk) {
    ascii(u8, p, 'junk');
    dv.setUint32(p + 4, 3, true);
    p += 12;
  }
  ascii(u8, p, 'data');
  dv.setUint32(p + 4, dataSize, true);
  p += 8;
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < nch; c++) {
      writeSample(dv, p, channels[c][i], opt.bits, float, true);
      p += bytes;
    }
  return u8;
}

export interface AiffOptions {
  bits: 16 | 24 | 32 | 64;
  /** 'AIFF' plain, or an AIFC compression type: NONE, sowt, fl32, fl64. */
  kind: 'AIFF' | 'NONE' | 'sowt' | 'fl32' | 'fl64';
}

function writeExtended(u8: Uint8Array, pos: number, rate: number): void {
  // 80-bit IEEE extended for a positive integer rate: explicit leading 1 bit.
  let exp = 0;
  let m = rate;
  while (m >= 2) {
    m /= 2;
    exp++;
  }
  const biased = exp + 16383;
  u8[pos] = (biased >> 8) & 0x7f;
  u8[pos + 1] = biased & 0xff;
  let frac = m - 1;
  for (let i = 0; i < 8; i++) {
    let byte = i === 0 ? 0x80 : 0;
    for (let b = i === 0 ? 6 : 7; b >= 0; b--) {
      frac *= 2;
      if (frac >= 1) {
        byte |= 1 << b;
        frac -= 1;
      }
    }
    u8[pos + 2 + i] = byte;
  }
}

export function buildAiff(channels: Float64Array[], fs: number, opt: AiffOptions): Uint8Array {
  const nch = channels.length;
  const frames = channels[0].length;
  const bytes = opt.bits / 8;
  const isC = opt.kind !== 'AIFF';
  const float = opt.kind === 'fl32' || opt.kind === 'fl64';
  const little = opt.kind === 'sowt';
  const commSize = isC ? 18 + 4 + 2 : 18; // + compression type + empty pstring (len 0 + pad)
  const dataSize = frames * nch * bytes;
  const ssndSize = 8 + dataSize;
  const total = 12 + (8 + commSize) + 8 + ssndSize + (ssndSize % 2);
  const u8 = new Uint8Array(total);
  const dv = new DataView(u8.buffer);
  ascii(u8, 0, 'FORM');
  dv.setUint32(4, total - 8, false);
  ascii(u8, 8, isC ? 'AIFC' : 'AIFF');
  let p = 12;
  ascii(u8, p, 'COMM');
  dv.setUint32(p + 4, commSize, false);
  dv.setInt16(p + 8, nch, false);
  dv.setUint32(p + 10, frames, false);
  dv.setInt16(p + 14, opt.bits, false);
  writeExtended(u8, p + 16, fs);
  if (isC) ascii(u8, p + 26, opt.kind);
  p += 8 + commSize;
  ascii(u8, p, 'SSND');
  dv.setUint32(p + 4, ssndSize, false);
  p += 16;
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < nch; c++) {
      writeSample(dv, p, channels[c][i], opt.bits, float, little);
      p += bytes;
    }
  return u8;
}

/** Raised-cosine fade in/out over `n` samples (avoids onset transients that ring the interpolator). */
export function fade(x: Float64Array, n: number): Float64Array {
  const out = Float64Array.from(x);
  for (let i = 0; i < n && i < out.length; i++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / n);
    out[i] *= g;
    out[out.length - 1 - i] *= g;
  }
  return out;
}
