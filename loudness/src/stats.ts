// Level statistics and the octave-band spectrum (docs/01-protocol.md 10.6).

import type { Samples } from './kweight.ts';

export const OCTAVE_CENTERS = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;

export const FFT_SIZE = 8192;
const HOP = FFT_SIZE / 2;

export function linearToDb(v: number): number {
  return v > 0 ? 20 * Math.log10(v) : -Infinity;
}

export function samplePeak(x: Samples): number {
  let peak = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    if (a > peak) peak = a;
  }
  return peak;
}

/** Unweighted RMS over all samples of all channels (0 for empty input). */
export function rmsOfChannels(channels: Samples[]): number {
  let sum = 0;
  let count = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
    count += ch.length;
  }
  return count > 0 ? Math.sqrt(sum / count) : 0;
}

/** Pearson correlation of two equal-length signals; null when undefined (empty or zero variance). */
export function correlation(a: Samples, b: Samples): number | null {
  const n = Math.min(a.length, b.length);
  if (n === 0) return null;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let saa = 0;
  let sbb = 0;
  let sab = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    saa += da * da;
    sbb += db * db;
    sab += da * db;
  }
  if (saa <= 1e-24 || sbb <= 1e-24) return null;
  return Math.max(-1, Math.min(1, sab / Math.sqrt(saa * sbb)));
}

// ---- FFT (iterative radix-2, in place) -------------------------------------

const TWIDDLES = new Map<number, { cos: Float64Array; sin: Float64Array; rev: Uint32Array }>();

function plan(n: number) {
  let p = TWIDDLES.get(n);
  if (!p) {
    const cos = new Float64Array(n / 2);
    const sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      cos[i] = Math.cos((2 * Math.PI * i) / n);
      sin[i] = -Math.sin((2 * Math.PI * i) / n);
    }
    const rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
      rev[i] = r;
    }
    p = { cos, sin, rev };
    TWIDDLES.set(n, p);
  }
  return p;
}

/** Forward complex FFT, in place. Length must be a power of two. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n < 2 || (n & (n - 1)) !== 0 || im.length !== n) throw new RangeError('fft length must be a power of two');
  const { cos, sin, rev } = plan(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step];
        const wi = sin[k * step];
        const a = start + k;
        const b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
}

// ---- Octave band spectrum ---------------------------------------------------

export interface BandLevel {
  centerHz: number;
  /** dB relative to a full-scale sine (mean square 0.5); null if above Nyquist or no energy. */
  levelDb: number | null;
}

/**
 * Octave-band levels. FFT 8192, periodic Hann, 50 % overlap, one-sided power
 * S_k = |X_k|^2 / (N * sum(w^2)) (x2 for 0<k<N/2) averaged over frames and
 * channels. Level = 10*log10(sum of S_k in [fc/sqrt2, fc*sqrt2) / 0.5).
 *
 * Choices where the spec is silent: only complete frames are used, except a
 * file shorter than one frame, which is analysed as one zero-padded frame; a
 * band is null when its lower edge is at or above Nyquist (a band straddling
 * Nyquist is computed from the bins that exist); a band with zero energy is null.
 * Stereo input is analysed two channels per complex FFT (L real, R imaginary).
 */
export function bandSpectrum(channels: Samples[], sampleRate: number): BandLevel[] {
  const n = FFT_SIZE;
  const window = new Float64Array(n);
  let windowEnergy = 0;
  for (let i = 0; i < n; i++) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    windowEnergy += window[i] * window[i];
  }
  const frames = channels.length > 0 ? channels[0].length : 0;
  const frameCount = frames < n ? (frames > 0 ? 1 : 0) : Math.floor((frames - n) / HOP) + 1;
  const bins = n / 2 + 1;
  const power = new Float64Array(bins);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const stereo = channels.length === 2;
  // Mono (or >2 channels, processed one by one): each channel gets its own pass.
  const passes: Samples[][] = stereo ? [channels] : channels.map((c) => [c]);
  for (const pass of passes) {
    const a = pass[0];
    const b = pass.length === 2 ? pass[1] : null;
    for (let f = 0; f < frameCount; f++) {
      const off = f * HOP;
      for (let i = 0; i < n; i++) {
        const idx = off + i;
        re[i] = idx < a.length ? a[idx] * window[i] : 0;
        im[i] = b && idx < b.length ? b[idx] * window[i] : 0;
      }
      fft(re, im);
      for (let k = 0; k < bins; k++) {
        const k2 = (n - k) % n;
        const p = b
          ? (re[k] * re[k] + im[k] * im[k] + re[k2] * re[k2] + im[k2] * im[k2]) / 2 // |XL|^2 + |XR|^2
          : re[k] * re[k] + im[k] * im[k];
        power[k] += p;
      }
    }
  }
  const divisor = frameCount * Math.max(1, channels.length) * n * windowEnergy;
  const nyquist = sampleRate / 2;
  const binHz = sampleRate / n;
  const out: BandLevel[] = [];
  for (const fc of OCTAVE_CENTERS) {
    const lo = fc / Math.SQRT2;
    const hi = fc * Math.SQRT2;
    if (lo >= nyquist || frameCount === 0) {
      out.push({ centerHz: fc, levelDb: null });
      continue;
    }
    let sum = 0;
    for (let k = 0; k < bins; k++) {
      const f = k * binHz;
      if (f >= lo && f < hi) sum += (k === 0 || k === n / 2 ? 1 : 2) * (power[k] / divisor);
    }
    out.push({ centerHz: fc, levelDb: sum > 0 ? 10 * Math.log10(sum / 0.5) : null });
  }
  return out;
}
