/** Synthetic audio for the ears tests: sine channels and minimal WAV / AIFF writers (no dependencies). */

export function sineChannel(freq: number, db: number, seconds: number, rate: number): Float64Array {
  const n = Math.round(seconds * rate);
  const out = new Float64Array(n);
  const amp = 10 ** (db / 20);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

function ascii(buf: Buffer, pos: number, text: string): void {
  buf.write(text, pos, "latin1");
}

/** PCM WAV (16/24/32 bit) or float32 WAV. */
export function wavBytes(channels: Float64Array[], rate: number, bits: 16 | 24 | 32 = 16, float = false): Buffer {
  const frames = channels[0]!.length;
  const bytes = bits / 8;
  const block = bytes * channels.length;
  const dataSize = frames * block;
  const buf = Buffer.alloc(44 + dataSize);
  ascii(buf, 0, "RIFF");
  buf.writeUInt32LE(36 + dataSize, 4);
  ascii(buf, 8, "WAVE");
  ascii(buf, 12, "fmt ");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(float ? 3 : 1, 20);
  buf.writeUInt16LE(channels.length, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * block, 28);
  buf.writeUInt16LE(block, 32);
  buf.writeUInt16LE(bits, 34);
  ascii(buf, 36, "data");
  buf.writeUInt32LE(dataSize, 40);
  let pos = 44;
  for (let i = 0; i < frames; i++) {
    for (const channel of channels) {
      const v = channel[i] ?? 0;
      if (float) buf.writeFloatLE(v, pos);
      else if (bits === 16) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32768))), pos);
      else if (bits === 24) buf.writeIntLE(Math.max(-8388608, Math.min(8388607, Math.round(v * 8388608))), pos, 3);
      else buf.writeInt32LE(Math.max(-2147483648, Math.min(2147483647, Math.round(v * 2147483648))), pos);
      pos += bytes;
    }
  }
  return buf;
}

/** 16-bit big-endian AIFF. */
export function aiffBytes(channels: Float64Array[], rate: number): Buffer {
  const frames = channels[0]!.length;
  const dataSize = frames * channels.length * 2;
  const buf = Buffer.alloc(12 + 26 + 16 + dataSize);
  ascii(buf, 0, "FORM");
  buf.writeUInt32BE(buf.length - 8, 4);
  ascii(buf, 8, "AIFF");
  ascii(buf, 12, "COMM");
  buf.writeUInt32BE(18, 16);
  buf.writeInt16BE(channels.length, 20);
  buf.writeUInt32BE(frames, 22);
  buf.writeInt16BE(16, 26);
  // 80-bit extended sample rate for an integer rate
  let exp = 0;
  let m = rate;
  while (m >= 2) { m /= 2; exp += 1; }
  buf.writeUInt16BE(exp + 16383, 28);
  buf.writeBigUInt64BE(BigInt(Math.round(m * 2 ** 63)), 30);
  ascii(buf, 38, "SSND");
  buf.writeUInt32BE(8 + dataSize, 42);
  let pos = 54;
  for (let i = 0; i < frames; i++) {
    for (const channel of channels) {
      buf.writeInt16BE(Math.max(-32768, Math.min(32767, Math.round((channel[i] ?? 0) * 32768))), pos);
      pos += 2;
    }
  }
  return buf;
}

/** A stereo sine WAV, the default recording of the tests. */
export function stereoSineWav(db = -20, seconds = 4, rate = 48000, bits: 16 | 24 | 32 = 24): Buffer {
  const left = sineChannel(1000, db, seconds, rate);
  return wavBytes([left, Float64Array.from(left)], rate, bits);
}
